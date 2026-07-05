/**
 * SQLite ledger for signals, paper/live trades, and settlements.
 *
 * Tables:
 *   signals          — every signal observed (incl. sub-threshold + filtered)
 *   trades           — every trade we'd take or did take (paper + live)
 *   settlements      — when an oracle settles, the price + outcome per strike
 *   svi_snapshots    — periodic SVI surface snapshots for the dashboard
 *   poly_snapshots   — periodic Polymarket order-book snapshots
 *   nav_snapshots    — periodic NAV/PnL snapshots
 *
 * Numeric fields stored as REAL; we never need more precision than f64.
 */

import Database, { Database as DB } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  OracleSnapshot,
  PolymarketSnapshot,
  SignalAction,
  SignalRecord,
  TradeRecord,
} from 'svx-shared/types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  oracle_id TEXT NOT NULL,
  underlying TEXT NOT NULL,
  expiry_ms INTEGER NOT NULL,
  strike REAL NOT NULL,
  predict_direction TEXT NOT NULL,
  predict_prob REAL NOT NULL,
  predict_iv REAL NOT NULL,
  poly_prob REAL NOT NULL,
  poly_iv REAL,
  spread REAL NOT NULL,
  iv_spread REAL,
  action TEXT NOT NULL,
  filter_reason TEXT,
  notional REAL,
  cost_usdc REAL
);
CREATE INDEX IF NOT EXISTS ix_signals_ts ON signals(ts_ms);
CREATE INDEX IF NOT EXISTS ix_signals_action ON signals(action);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  mode TEXT NOT NULL,
  oracle_id TEXT NOT NULL,
  underlying TEXT NOT NULL,
  expiry_ms INTEGER NOT NULL,
  strike REAL NOT NULL,
  direction TEXT NOT NULL,
  quantity_dusdc REAL NOT NULL,
  cost_price REAL NOT NULL,
  cost_usdc REAL NOT NULL,
  tx_digest TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  payout_usdc REAL,
  pnl_usdc REAL,
  redeem_tx_digest TEXT,
  -- Polymarket execution leg (additive 2026-05-10) --
  poly_network TEXT,
  poly_token_id TEXT,
  poly_condition_id TEXT,
  poly_side TEXT,
  poly_outcome TEXT,
  poly_order_id TEXT,
  poly_filled_shares REAL,
  poly_fill_price REAL,
  poly_cost_usdc REAL,
  poly_tx_hash TEXT,
  poly_status TEXT,
  -- Polymarket settlement (additive 2026-05-11) --
  poly_settled INTEGER NOT NULL DEFAULT 0,
  poly_settled_at_ms INTEGER,
  poly_settlement_outcome TEXT,
  poly_payout_usdc REAL,
  poly_pnl_usdc REAL,
  poly_redeem_tx_hash TEXT,
  poly_redeem_status TEXT,
  -- Hyperliquid delta-hedge leg (additive 2026-05-11) --
  hl_asset TEXT,
  hl_order_id TEXT,
  hl_size REAL,
  hl_side TEXT,
  hl_open_price REAL,
  hl_close_price REAL,
  hl_status TEXT,
  hl_pnl_usdc REAL,
  hl_funding_paid_usdc REAL,
  -- HL taker fees on open + close. Stored separately so the audit trail keeps
  -- gross PnL (hl_pnl_usdc) intact; realizedHlPnlSince subtracts this at query
  -- time. Added 2026-06-14.
  hl_fees_usdc REAL,
  hl_closed_at_ms INTEGER,
  -- Strategy tag (additive 2026-05-15). 'poly_arb' for the original
  -- cross-venue strategy, 'vol_arb' for the standalone HL vol strategy.
  strategy TEXT NOT NULL DEFAULT 'poly_arb'
);
CREATE INDEX IF NOT EXISTS ix_trades_ts ON trades(ts_ms);
CREATE INDEX IF NOT EXISTS ix_trades_oracle ON trades(oracle_id);
CREATE INDEX IF NOT EXISTS ix_trades_settled ON trades(settled);

-- migration for older databases: add redeem_tx_digest if missing
-- (sqlite has no IF NOT EXISTS for ADD COLUMN; rely on the schema CREATE
-- above for new DBs, run a one-shot ALTER for existing)

CREATE TABLE IF NOT EXISTS settlements (
  oracle_id TEXT PRIMARY KEY,
  underlying TEXT NOT NULL,
  expiry_ms INTEGER NOT NULL,
  settlement_price REAL NOT NULL,
  ts_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS svi_snapshots (
  oracle_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  spot REAL NOT NULL,
  forward REAL NOT NULL,
  a REAL NOT NULL,
  b REAL NOT NULL,
  rho REAL NOT NULL,
  m REAL NOT NULL,
  sigma REAL NOT NULL,
  PRIMARY KEY (oracle_id, ts_ms)
);
CREATE INDEX IF NOT EXISTS ix_svi_oracle_ts ON svi_snapshots(oracle_id, ts_ms);

CREATE TABLE IF NOT EXISTS poly_snapshots (
  condition_id TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  strike REAL NOT NULL,
  expiry_ms INTEGER NOT NULL,
  yes_bid REAL NOT NULL,
  yes_ask REAL NOT NULL,
  yes_bid_size REAL NOT NULL,
  yes_ask_size REAL NOT NULL,
  no_bid REAL NOT NULL,
  no_ask REAL NOT NULL,
  volume_24h_usd REAL NOT NULL,
  PRIMARY KEY (condition_id, ts_ms)
);

CREATE TABLE IF NOT EXISTS nav_snapshots (
  ts_ms INTEGER PRIMARY KEY,
  nav_usdc REAL NOT NULL,
  realized_pnl_usdc REAL NOT NULL,
  unrealized_pnl_usdc REAL NOT NULL,
  open_positions INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pause_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL,
  reason TEXT,
  ts_ms INTEGER NOT NULL,
  /* Watermark used by consecutiveLosses — only count losses whose ts_ms is
     greater than this. resume() bumps it to NOW so the breaker gets a clean
     slate; without this the breaker re-trips off the same prior streak. */
  circuit_breaker_reset_at_ms INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO pause_state(id, paused, ts_ms) VALUES (1, 0, 0);

/* One-row-per-key operational state that must survive restarts: one-shot
   migration markers, the wallet-reconciliation baseline, etc. */
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Poly-leg rows that represent money actually spent, whatever the parse said.
 * 'filled' is the happy path; 'partial' spent less than requested but spent;
 * 'submitted' means the SDK accepted the order but the response shape hid the
 * fill details — the July incident class. All three MUST be visible to every
 * lifecycle query (position caps, settlement poll, stop-loss walker, stale
 * backstop) or a funded position becomes invisible to risk controls.
 */
const OPEN_POLY_STATUSES = `('filled', 'partial', 'submitted')`;

export class LedgerStore {
  private readonly db: DB;

  constructor(filepath: string) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    this.db = new Database(filepath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    // Backwards-compat migrations: add columns to existing DBs in-place.
    const cols = this.db
      .prepare<[], { name: string }>(`PRAGMA table_info(trades)`)
      .all()
      .map((r) => r.name);
    const ensureColumn = (name: string, type: string) => {
      if (!cols.includes(name)) this.db.exec(`ALTER TABLE trades ADD COLUMN ${name} ${type}`);
    };
    ensureColumn('redeem_tx_digest', 'TEXT');
    ensureColumn('settlement_price', 'REAL');
    ensureColumn('settled_at_ms', 'INTEGER');
    ensureColumn('ms_to_expiry_at_exec', 'INTEGER');
    ensureColumn('predict_prob_at_exec', 'REAL');
    ensureColumn('poly_ask_at_exec', 'REAL');
    ensureColumn('predict_iv_at_exec', 'REAL');
    ensureColumn('edge_at_exec', 'REAL');
    // Polymarket execution leg
    ensureColumn('poly_network', 'TEXT');
    ensureColumn('poly_token_id', 'TEXT');
    ensureColumn('poly_condition_id', 'TEXT');
    ensureColumn('poly_side', 'TEXT');
    ensureColumn('poly_outcome', 'TEXT');
    ensureColumn('poly_order_id', 'TEXT');
    ensureColumn('poly_filled_shares', 'REAL');
    ensureColumn('poly_fill_price', 'REAL');
    ensureColumn('poly_cost_usdc', 'REAL');
    ensureColumn('poly_tx_hash', 'TEXT');
    ensureColumn('poly_status', 'TEXT');
    // Polymarket settlement leg (additive 2026-05-11). All NULL on existing
    // rows; populated by the settlement-poll loop as UMA resolves markets.
    ensureColumn('poly_settled', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn('poly_settled_at_ms', 'INTEGER');
    ensureColumn('poly_settlement_outcome', 'TEXT');
    ensureColumn('poly_payout_usdc', 'REAL');
    ensureColumn('poly_pnl_usdc', 'REAL');
    ensureColumn('poly_redeem_tx_hash', 'TEXT');
    ensureColumn('poly_redeem_status', 'TEXT');
    // Hyperliquid delta-hedge leg (additive 2026-05-11). All NULL on
    // existing rows; populated when the operator turns HL_EXECUTION_ENABLED on.
    ensureColumn('hl_asset', 'TEXT');
    ensureColumn('hl_order_id', 'TEXT');
    ensureColumn('hl_size', 'REAL');
    ensureColumn('hl_side', 'TEXT');
    ensureColumn('hl_open_price', 'REAL');
    ensureColumn('hl_close_price', 'REAL');
    ensureColumn('hl_status', 'TEXT');
    ensureColumn('hl_pnl_usdc', 'REAL');
    ensureColumn('hl_funding_paid_usdc', 'REAL');
    ensureColumn('hl_fees_usdc', 'REAL');
    ensureColumn('hl_closed_at_ms', 'INTEGER');
    // Trailing-ratchet exit (additive 2026-07). High-water mark of the poly
    // leg's mark-to-market P&L fraction; the early-exit walker sells when
    // P&L falls below the highest locked step. NULL on rows that predate it.
    ensureColumn('poly_high_water_frac', 'REAL');
    // Redeem retry bookkeeping (additive 2026-07). Failed redeems are now
    // retried with backoff instead of being parked forever behind one warn.
    ensureColumn('poly_redeem_attempts', 'INTEGER');
    ensureColumn('poly_redeem_last_attempt_ms', 'INTEGER');
    // Strategy tag (additive 2026-05-15). Existing rows are implicitly
    // 'poly_arb' (the original cross-venue strategy). New strategies tag
    // their trades so per-strategy PnL + positions can be segregated on
    // the dashboard.
    ensureColumn('strategy', "TEXT NOT NULL DEFAULT 'poly_arb'");

    // Backfill: pre-2026-05-20 vol-arb trades never had their `settled` flag
    // flipped when the HL leg closed, leaving them stuck in `openTrades()`
    // and inflating the generic openPositionCount feeding the risk gate.
    // Idempotent — only matches rows still in the broken state.
    this.db.exec(
      `UPDATE trades
         SET settled = 1,
             settled_at_ms = COALESCE(settled_at_ms, hl_closed_at_ms)
       WHERE strategy = 'vol_arb' AND hl_status = 'closed' AND settled = 0`,
    );

    // Backwards-compat migration for the circuit-breaker watermark column on
    // pause_state. Existing DBs created before 2026-06-13 don't have this.
    const pauseCols = this.db
      .prepare<[], { name: string }>(`PRAGMA table_info(pause_state)`)
      .all()
      .map((r) => r.name);
    if (!pauseCols.includes('circuit_breaker_reset_at_ms')) {
      this.db.exec(
        `ALTER TABLE pause_state ADD COLUMN circuit_breaker_reset_at_ms INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  /** Insert a signal; returns the ID. */
  insertSignal(s: Omit<SignalRecord, 'id'> & { id?: string }): string {
    const id = s.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO signals (id, ts_ms, oracle_id, underlying, expiry_ms, strike, predict_direction,
         predict_prob, predict_iv, poly_prob, poly_iv, spread, iv_spread, action, filter_reason,
         notional, cost_usdc)
         VALUES (@id, @ts, @oracleId, @underlying, @expiry, @strike, @dir,
         @pp, @pi, @yp, @yi, @spr, @ivs, @action, @fr, @notional, @cost)`,
      )
      .run({
        id,
        ts: s.timestampMs,
        oracleId: s.oracleId,
        underlying: s.underlyingAsset,
        expiry: s.expiryMs,
        strike: s.strike,
        dir: s.predictDirection,
        pp: s.predictProb,
        pi: s.predictIv,
        yp: s.polyProb,
        yi: s.polyIv ?? null,
        spr: s.spread,
        ivs: s.ivSpread ?? null,
        action: s.action,
        fr: s.filterReason ?? null,
        notional: s.notional ?? null,
        cost: s.costUsdc ?? null,
      });
    return id;
  }

  /**
   * Demote an already-inserted signal row to a new action (typically 'failed'
   * after the bot decided to execute but an upstream venue rejected the
   * order). Used so the dashboard stops showing exec rows that never produced
   * a trade — otherwise the signals page shows live_executed but
   * /positions/open is empty, which reads as "lost trade."
   */
  updateSignalAction(sigId: string, action: SignalAction, filterReason?: string): void {
    this.db
      .prepare(
        `UPDATE signals SET action = ?, filter_reason = COALESCE(?, filter_reason)
         WHERE id = ?`,
      )
      .run(action, filterReason ?? null, sigId);
  }

  insertTrade(
    t: Omit<TradeRecord, 'id'> & {
      id?: string;
      msToExpiryAtExec?: number;
      predictProbAtExec?: number;
      polyAskAtExec?: number;
      predictIvAtExec?: number;
      edgeAtExec?: number;
      /** Strategy tag. Defaults to 'poly_arb' for backwards compatibility. */
      strategy?: 'poly_arb' | 'vol_arb' | 'convergence';
    },
  ): string {
    const id = t.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO trades (id, signal_id, ts_ms, mode, oracle_id, underlying, expiry_ms, strike,
         direction, quantity_dusdc, cost_price, cost_usdc, tx_digest, settled, payout_usdc, pnl_usdc,
         ms_to_expiry_at_exec, predict_prob_at_exec, poly_ask_at_exec, predict_iv_at_exec, edge_at_exec,
         poly_network, poly_token_id, poly_condition_id, poly_side, poly_outcome,
         poly_order_id, poly_filled_shares, poly_fill_price, poly_cost_usdc, poly_tx_hash, poly_status,
         strategy)
         VALUES (@id, @sigId, @ts, @mode, @oracleId, @underlying, @expiry, @strike,
         @dir, @qty, @cp, @cost, @txd, @settled, @payout, @pnl,
         @msToE, @ppe, @pae, @pive, @edge,
         @polyNet, @polyTok, @polyCond, @polySide, @polyOut,
         @polyOrd, @polyShr, @polyPx, @polyUsd, @polyTx, @polyStat,
         @strategy)`,
      )
      .run({
        id,
        sigId: t.signalId,
        ts: t.timestampMs,
        mode: t.mode,
        oracleId: t.oracleId,
        underlying: t.underlyingAsset,
        expiry: t.expiryMs,
        strike: t.strike,
        dir: t.direction,
        qty: t.quantityDusdc,
        cp: t.costPrice,
        cost: t.costUsdc,
        txd: t.txDigest ?? null,
        settled: t.settled ? 1 : 0,
        payout: t.payoutUsdc ?? null,
        pnl: t.pnlUsdc ?? null,
        msToE: t.msToExpiryAtExec ?? null,
        ppe: t.predictProbAtExec ?? null,
        pae: t.polyAskAtExec ?? null,
        pive: t.predictIvAtExec ?? null,
        edge: t.edgeAtExec ?? null,
        polyNet: t.polyNetwork ?? null,
        polyTok: t.polyTokenId ?? null,
        polyCond: t.polyConditionId ?? null,
        polySide: t.polySide ?? null,
        polyOut: t.polyOutcome ?? null,
        polyOrd: t.polyOrderId ?? null,
        polyShr: t.polyFilledShares ?? null,
        polyPx: t.polyFillPrice ?? null,
        polyUsd: t.polyCostUsdc ?? null,
        polyTx: t.polyTxHash ?? null,
        polyStat: t.polyStatus ?? null,
        strategy: t.strategy ?? 'poly_arb',
      });
    return id;
  }

  recordSettlement(
    oracleId: string,
    underlying: string,
    expiryMs: number,
    settlementPrice: number,
    nowMs: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO settlements (oracle_id, underlying, expiry_ms, settlement_price, ts_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(oracleId, underlying, expiryMs, settlementPrice, nowMs);
  }

  /** Mark all unsettled trades for an oracle as settled, computing payouts. */
  settleTradesForOracle(oracleId: string, settlementPrice: number, nowMs: number): number {
    const trades = this.db
      .prepare<[string], { id: string; direction: string; strike: number; quantity_dusdc: number; cost_usdc: number }>(
        `SELECT id, direction, strike, quantity_dusdc, cost_usdc FROM trades WHERE oracle_id = ? AND settled = 0`,
      )
      .all(oracleId);
    const upd = this.db.prepare(
      `UPDATE trades SET settled = 1, payout_usdc = @payout, pnl_usdc = @pnl,
                          settlement_price = @sprice, settled_at_ms = @sat
       WHERE id = @id`,
    );
    const tx = this.db.transaction((items: typeof trades) => {
      let count = 0;
      for (const t of items) {
        const won = t.direction === 'up' ? settlementPrice > t.strike : settlementPrice <= t.strike;
        const payout = won ? t.quantity_dusdc : 0;
        const pnl = payout - t.cost_usdc;
        upd.run({ payout, pnl, sprice: settlementPrice, sat: nowMs, id: t.id });
        count++;
      }
      return count;
    });
    return tx(trades);
  }

  recordSviSnapshot(snapshot: OracleSnapshot): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO svi_snapshots
         (oracle_id, ts_ms, spot, forward, a, b, rho, m, sigma)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.oracleId,
        snapshot.timestampMs,
        snapshot.spot,
        snapshot.forward,
        snapshot.svi.a,
        snapshot.svi.b,
        snapshot.svi.rho,
        snapshot.svi.m,
        snapshot.svi.sigma,
      );
  }

  recordPolySnapshot(s: PolymarketSnapshot): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO poly_snapshots
         (condition_id, ts_ms, strike, expiry_ms, yes_bid, yes_ask, yes_bid_size, yes_ask_size,
          no_bid, no_ask, volume_24h_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.conditionId,
        s.fetchedAtMs,
        s.strike,
        s.expiryMs,
        s.yesBid,
        s.yesAsk,
        s.yesBidSize,
        s.yesAskSize,
        s.noBid,
        s.noAsk,
        s.volume24hUsd,
      );
  }

  recordNav(navUsdc: number, realized: number, unrealized: number, openPositions: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO nav_snapshots(ts_ms, nav_usdc, realized_pnl_usdc, unrealized_pnl_usdc, open_positions)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(Date.now(), navUsdc, realized, unrealized, openPositions);
  }

  /**
   * Trim each row-heavy table to its retention cap. Runs in a single
   * transaction. Safe to call frequently — each delete is fast on indexed
   * tables. Never deletes settled trades or settlements (the audit trail).
   */
  prune(retention: {
    signalsKeep: number;
    sviSnapshotsKeep: number;
    polySnapshotsKeep: number;
    navSnapshotsKeep: number;
  }): { deletedSignals: number; deletedSvi: number; deletedPoly: number; deletedNav: number } {
    const tx = this.db.transaction(() => {
      const dSig = this.db
        .prepare(
          `DELETE FROM signals WHERE id IN (
            SELECT id FROM signals ORDER BY ts_ms DESC LIMIT -1 OFFSET ?
          )`,
        )
        .run(retention.signalsKeep).changes;
      const dSvi = this.db
        .prepare(
          `DELETE FROM svi_snapshots WHERE rowid IN (
            SELECT rowid FROM svi_snapshots ORDER BY ts_ms DESC LIMIT -1 OFFSET ?
          )`,
        )
        .run(retention.sviSnapshotsKeep).changes;
      const dPoly = this.db
        .prepare(
          `DELETE FROM poly_snapshots WHERE rowid IN (
            SELECT rowid FROM poly_snapshots ORDER BY ts_ms DESC LIMIT -1 OFFSET ?
          )`,
        )
        .run(retention.polySnapshotsKeep).changes;
      const dNav = this.db
        .prepare(
          `DELETE FROM nav_snapshots WHERE ts_ms IN (
            SELECT ts_ms FROM nav_snapshots ORDER BY ts_ms DESC LIMIT -1 OFFSET ?
          )`,
        )
        .run(retention.navSnapshotsKeep).changes;
      return { dSig, dSvi, dPoly, dNav };
    });
    const r = tx();
    return {
      deletedSignals: r.dSig,
      deletedSvi: r.dSvi,
      deletedPoly: r.dPoly,
      deletedNav: r.dNav,
    };
  }

  /** Run SQLite VACUUM to reclaim freed pages back to the OS. */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  setPause(paused: boolean, reason?: string): void {
    this.db
      .prepare(
        `UPDATE pause_state SET paused = ?, reason = ?, ts_ms = ? WHERE id = 1`,
      )
      .run(paused ? 1 : 0, reason ?? null, Date.now());
  }

  getPause(): { paused: boolean; reason?: string; tsMs: number } {
    const row = this.db
      .prepare<[], { paused: number; reason: string | null; ts_ms: number }>(
        `SELECT paused, reason, ts_ms FROM pause_state WHERE id = 1`,
      )
      .get();
    if (!row) return { paused: false, tsMs: 0 };
    return { paused: row.paused === 1, reason: row.reason ?? undefined, tsMs: row.ts_ms };
  }

  /**
   * Count open (unsettled) live or paper positions for a specific signal —
   * the concentration cap reads this to decide whether to pyramid further.
   */
  countOpenPositionsForSignal(
    oracleId: string,
    strike: number,
    direction: 'up' | 'down',
  ): number {
    const r = this.db
      .prepare<[string, number, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM trades
         WHERE settled = 0 AND oracle_id = ? AND strike = ? AND direction = ?`,
      )
      .get(oracleId, strike, direction);
    return r?.c ?? 0;
  }

  /**
   * True if there's an open (unsettled) trade on the same (oracleId, strike)
   * but in the OPPOSITE direction. Used to refuse signals that would stack
   * UP + DOWN on the same strike — only one can win at settlement, so the
   * combined position guarantees paying the Predict spread (UP_price +
   * DOWN_price > 1 because of the protocol's fee).
   */
  hasOppositeOpenForSignal(
    oracleId: string,
    strike: number,
    direction: 'up' | 'down',
  ): boolean {
    const opposite = direction === 'up' ? 'down' : 'up';
    const r = this.db
      .prepare<[string, number, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM trades
         WHERE settled = 0 AND oracle_id = ? AND strike = ? AND direction = ?`,
      )
      .get(oracleId, strike, opposite);
    return (r?.c ?? 0) > 0;
  }

  /**
   * Count of OPEN Polymarket-leg positions — trades where the Poly fill went
   * through but the underlying market hasn't yet resolved on UMA. Read by the
   * Poly risk gate to enforce `maxOpenPolyPositions`.
   */
  countOpenPolyPositions(): number {
    const r = this.db
      .prepare<[], { c: number }>(
        `SELECT COUNT(*) AS c FROM trades
         WHERE poly_status IN ${OPEN_POLY_STATUSES} AND poly_settled = 0`,
      )
      .get();
    return r?.c ?? 0;
  }

  /**
   * Open poly-leg positions on ONE outcome token. This is the concentration
   * key that actually matters: the old per-(oracle,strike,direction) counter
   * keyed on the Predict leg's `settled` flag, which on mainnet is a paper
   * leg that oracle-settles within minutes — freeing the slot while the poly
   * leg was still live. Two Predict oracles also routinely match the same
   * poly market, so the per-oracle key let the same token fire twice in one
   * loop. Counting open poly legs per token closes both holes.
   */
  countOpenPolyForToken(tokenId: string): number {
    const r = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM trades
         WHERE poly_status IN ${OPEN_POLY_STATUSES} AND poly_settled = 0 AND poly_token_id = ?`,
      )
      .get(tokenId);
    return r?.c ?? 0;
  }

  /**
   * True if any strategy holds an open poly position on the SAME market
   * (conditionId) but a DIFFERENT outcome token. Holding Yes and No of one
   * binary simultaneously locks in a loss of the combined spread (both asks
   * sum > $1), so entries must refuse when the sibling token is held —
   * poly-arb vs convergence can otherwise take opposite sides of one market.
   */
  hasOpenPolyForOtherToken(conditionId: string, tokenId: string): boolean {
    const r = this.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM trades
         WHERE poly_status IN ${OPEN_POLY_STATUSES} AND poly_settled = 0
           AND poly_condition_id = ? AND poly_token_id != ?`,
      )
      .get(conditionId, tokenId);
    return (r?.c ?? 0) > 0;
  }

  /**
   * Trades whose Polymarket fill was successful but UMA hasn't resolved yet.
   * The settlement-poll loop iterates this each cycle, groups by conditionId,
   * and queries gamma for resolution status.
   */
  unsettledPolyTrades(): TradeRecord[] {
    return this.tradeRows(
      `WHERE poly_status IN ${OPEN_POLY_STATUSES} AND poly_settled = 0 ORDER BY ts_ms ASC`,
    );
  }

  /**
   * Mark a Poly leg as settled. Payout = filled_shares * (won ? 1 : 0); PnL =
   * payout - cost. The winning outcome ('yes'|'no') is recorded so that the
   * dashboard can show "lost" vs "won" without consulting gamma again.
   */
  markPolySettled(
    tradeId: string,
    outcome: 'yes' | 'no',
    payoutUsdc: number,
    pnlUsdc: number,
    settledAtMs: number,
  ): void {
    this.db
      .prepare(
        `UPDATE trades SET poly_settled = 1, poly_settled_at_ms = ?,
                            poly_settlement_outcome = ?, poly_payout_usdc = ?,
                            poly_pnl_usdc = ?
         WHERE id = ?`,
      )
      .run(settledAtMs, outcome, payoutUsdc, pnlUsdc, tradeId);
  }

  /**
   * Persist the trailing-ratchet high-water mark for a poly leg. Written by
   * the early-exit walker whenever mark-to-market P&L makes a new high, so
   * the locked floor survives restarts.
   */
  updatePolyHighWater(tradeId: string, highWaterFrac: number): void {
    this.db
      .prepare(`UPDATE trades SET poly_high_water_frac = ? WHERE id = ?`)
      .run(highWaterFrac, tradeId);
  }

  /**
   * Mark a Poly leg as closed via mid-life sell-back (not via UMA resolution).
   * Mirrors markPolySettled but stamps `poly_settlement_outcome = 'early_exit'`
   * and a redeem-tx sentinel so the UMA-resolution loop + redeem queue skip
   * this row. `proceedsUsdc` is what we got back from selling; PnL =
   * proceeds - poly_cost_usdc and feeds the same realizedPolyPnlSince query
   * as a normal settlement.
   */
  markPolyExited(
    tradeId: string,
    exitOrderId: string | null,
    proceedsUsdc: number,
    pnlUsdc: number,
    exitedAtMs: number,
  ): void {
    this.db
      .prepare(
        `UPDATE trades SET poly_settled = 1, poly_settled_at_ms = ?,
                            poly_settlement_outcome = 'early_exit',
                            poly_payout_usdc = ?, poly_pnl_usdc = ?,
                            poly_redeem_tx_hash = ?, poly_redeem_status = 'success'
         WHERE id = ?`,
      )
      .run(exitedAtMs, proceedsUsdc, pnlUsdc, exitOrderId ?? 'early-exit', tradeId);
  }

  /**
   * Abandon Polymarket trades that have been "filled but unsettled" for
   * longer than `maxAgeMs`. Marks them as settled with outcome='abandoned',
   * payout=0, PnL=-cost. Prevents stuck rows from pinning the
   * maxOpenPolyPositions counter indefinitely when UMA never resolves +
   * mid-life exit never triggers. Returns the number of rows touched.
   *
   * Recorded as a loss (payout=0, pnl=-cost) so the strategy stats reflect
   * the real worst-case rather than an optimistic ignore. The audit trail
   * survives via poly_settlement_outcome='abandoned'.
   */
  abandonStalePolyTrades(maxAgeMs: number, nowMs: number): number {
    const cutoff = nowMs - maxAgeMs;
    const r = this.db
      .prepare(
        `UPDATE trades
            SET poly_settled = 1,
                poly_settled_at_ms = ?,
                poly_settlement_outcome = 'abandoned',
                poly_payout_usdc = 0,
                poly_pnl_usdc = -COALESCE(poly_cost_usdc, 0),
                poly_redeem_tx_hash = 'abandoned',
                poly_redeem_status = 'success'
          WHERE poly_status IN ${OPEN_POLY_STATUSES}
            AND poly_settled = 0
            AND ts_ms < ?`,
      )
      .run(nowMs, cutoff);
    return r.changes;
  }

  /**
   * One-shot boot repair for the 2026-07 settlement incident: rows that were
   * force-abandoned (booked as full-cost losses) while getMarketResolution
   * was silently broken. Re-queues them through the now-working settlement
   * poll by flipping poly_settled back to 0 and clearing the abandon
   * bookkeeping. Real losses re-book as losses within one poll cycle; any
   * abandoned WINNER gets its true payout booked and its shares redeemed
   * instead of being written off.
   *
   * GENUINELY one-shot via a meta marker — the previous "idempotent" version
   * ran on every boot, which resurrected rows the ongoing 14-day rule had
   * *legitimately* abandoned post-fix: each redeploy re-opened them (pinning
   * maxOpenPolyPositions slots), re-failed resolution, and re-abandoned them,
   * flapping all-time PnL in the process.
   */
  resetAbandonedPolyTrades(): number {
    const MARKER = 'abandoned_heal_2026_07_done';
    if (this.getMeta(MARKER) !== undefined) return 0;
    const r = this.db
      .prepare(
        `UPDATE trades
            SET poly_settled = 0,
                poly_settled_at_ms = NULL,
                poly_settlement_outcome = NULL,
                poly_payout_usdc = NULL,
                poly_pnl_usdc = NULL,
                poly_redeem_tx_hash = NULL,
                poly_redeem_status = NULL
          WHERE poly_settlement_outcome = 'abandoned'`,
      )
      .run();
    this.setMeta(MARKER, String(Date.now()));
    return r.changes;
  }

  /** Read a persisted operational-state value; undefined if unset. */
  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare<[string], { value: string }>(`SELECT value FROM meta WHERE key = ?`)
      .get(key);
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, value);
  }

  deleteMeta(key: string): void {
    this.db.prepare(`DELETE FROM meta WHERE key = ?`).run(key);
  }

  /**
   * Winning Polymarket positions that haven't been redeemed on-chain yet,
   * INCLUDING previously-failed redeems that are due a retry. A failed
   * redeem is retried with linear backoff (`retryGapMs` since the last
   * attempt) up to `maxAttempts` — the pre-2026-07 behaviour parked failed
   * rows forever behind a single warn line, stranding winnings (a NegRisk
   * market routed through the wrong contract reverts 100% of the time, but a
   * transient RPC failure doesn't).
   */
  unredeemedWinningPolyTrades(opts?: { maxAttempts?: number; retryGapMs?: number; nowMs?: number }): TradeRecord[] {
    const maxAttempts = opts?.maxAttempts ?? 5;
    const retryGapMs = opts?.retryGapMs ?? 30 * 60_000;
    const nowMs = opts?.nowMs ?? Date.now();
    return this.tradeRows(
      `WHERE poly_settled = 1 AND poly_payout_usdc > 0
         AND poly_redeem_tx_hash IS NULL
         AND (
           poly_redeem_status IS NULL
           OR (
             poly_redeem_status = 'failed'
             AND COALESCE(poly_redeem_attempts, 0) < ?
             AND COALESCE(poly_redeem_last_attempt_ms, 0) <= ?
           )
         )
       ORDER BY ts_ms ASC`,
      [maxAttempts, nowMs - retryGapMs],
    );
  }

  /** Total pUSD of winning positions whose redeem hasn't landed on-chain —
   *  money the ledger counts as realized but the wallet doesn't hold yet.
   *  Surfaced on /status so stranded winnings are loud, not a log line. */
  unredeemedPolyPayoutUsdc(): number {
    const r = this.db
      .prepare<[], { s: number }>(
        `SELECT COALESCE(SUM(poly_payout_usdc), 0) AS s FROM trades
         WHERE poly_settled = 1 AND poly_payout_usdc > 0
           AND poly_redeem_tx_hash IS NULL`,
      )
      .get();
    return r?.s ?? 0;
  }

  /**
   * Persist a CTF redeem tx hash + status on a single trade row.
   * Pass `txHash=null` on failure so the column stays NULL — `poly_redeem_status`
   * carries the failure marker. Failures also bump the attempt counter +
   * timestamp that drive the retry backoff in `unredeemedWinningPolyTrades`.
   */
  markPolyRedeemed(
    tradeId: string,
    txHash: string | null,
    status: 'success' | 'failed' | 'pending' = 'success',
  ): void {
    this.db
      .prepare(
        `UPDATE trades SET poly_redeem_tx_hash = ?, poly_redeem_status = ?,
                            poly_redeem_attempts = CASE WHEN ? = 'failed'
                              THEN COALESCE(poly_redeem_attempts, 0) + 1
                              ELSE poly_redeem_attempts END,
                            poly_redeem_last_attempt_ms = ?
         WHERE id = ?`,
      )
      .run(txHash, status, status, Date.now(), tradeId);
  }

  /**
   * Sum of realized Polymarket-leg PnL across trades SETTLED since `sinceMs`.
   * Keyed on `poly_settled_at_ms` (when the money outcome became real), NOT
   * the trade's open time — a position opened days ago that settles at a loss
   * today must count toward today's limit. Keying on open time (`ts_ms`, the
   * pre-2026-07 behaviour) silently excluded every loss on a market older
   * than 24h, including all 14-day abandonments. Mirrors `realizedHlPnlSince`
   * which keys on `hl_closed_at_ms`. Feeds the daily-loss gate on
   * `RiskGate.checkPoly`.
   */
  realizedPolyPnlSince(sinceMs: number): number {
    const r = this.db
      .prepare<[number], { p: number }>(
        `SELECT COALESCE(SUM(poly_pnl_usdc), 0) AS p FROM trades
         WHERE poly_settled = 1 AND poly_settled_at_ms >= ?`,
      )
      .get(sinceMs);
    return r?.p ?? 0;
  }

  /**
   * Ledger-implied pUSD wallet offset — the reconciliation invariant's core
   * number. If the ledger is telling the truth, the wallet balance moves in
   * lockstep with:
   *
   *   Σ realized poly PnL (settled rows)
   *   − Σ cost of currently-open positions   (cash left the wallet, no PnL yet)
   *   − Σ payouts not yet redeemed on-chain  (PnL booked, cash not arrived)
   *
   * The bot snapshots (walletBalance − offset) as a baseline once, then on
   * every settlement cycle asserts the current (walletBalance − offset) still
   * equals it within a drift threshold. Operator deposits/withdrawals shift
   * the baseline legitimately — re-baseline via `svx rebaseline` after moving
   * funds. A silent settlement/booking bug (the July incident class) shows up
   * as drift and pauses the bot instead of compounding.
   */
  polyLedgerOffsetUsdc(): number {
    const r = this.db
      .prepare<[], { pnl: number; open: number; unred: number }>(
        `SELECT
           COALESCE(SUM(CASE WHEN poly_settled = 1 THEN poly_pnl_usdc END), 0) AS pnl,
           COALESCE(SUM(CASE WHEN poly_settled = 0 AND poly_status IN ${OPEN_POLY_STATUSES}
                             THEN poly_cost_usdc END), 0) AS open,
           COALESCE(SUM(CASE WHEN poly_settled = 1 AND poly_payout_usdc > 0
                              AND poly_redeem_tx_hash IS NULL
                             THEN poly_payout_usdc END), 0) AS unred
         FROM trades`,
      )
      .get();
    return (r?.pnl ?? 0) - (r?.open ?? 0) - (r?.unred ?? 0);
  }

  /**
   * Most recent poly entry time per outcome token within the window — used at
   * boot to rebuild the in-memory re-entry cooldown map, so a redeploy can't
   * bypass `polyReentryCooldownMs` (the July-2 churn protection).
   */
  recentPolyEntryTimes(sinceMs: number): Array<{ tokenId: string; lastEntryMs: number }> {
    const rows = this.db
      .prepare<[number], { token: string; last: number }>(
        `SELECT poly_token_id AS token, MAX(ts_ms) AS last FROM trades
         WHERE poly_token_id IS NOT NULL AND ts_ms >= ?
         GROUP BY poly_token_id`,
      )
      .all(sinceMs);
    return rows.map((r) => ({ tokenId: r.token, lastEntryMs: r.last }));
  }

  /** Closed Polymarket trades for the dashboard's "Closed positions" table. */
  closedPolyTrades(limit = 500): TradeRecord[] {
    return this.tradeRows(
      `WHERE poly_status IN ${OPEN_POLY_STATUSES} AND poly_settled = 1 ORDER BY poly_settled_at_ms DESC LIMIT ?`,
      [limit],
    );
  }

  // ============================================================
  // Hyperliquid delta-hedge leg (Part 2)
  // ============================================================

  /**
   * Persist HL hedge details on an existing trade row. Idempotent — called
   * immediately after the Polymarket fill that triggered the hedge.
   */
  recordHlLeg(
    tradeId: string,
    leg: {
      asset: string;
      orderId: string;
      size: number;
      side: 'long' | 'short';
      openPrice: number;
      status: 'open' | 'failed';
    },
  ): void {
    this.db
      .prepare(
        `UPDATE trades SET hl_asset = ?, hl_order_id = ?, hl_size = ?,
                            hl_side = ?, hl_open_price = ?, hl_status = ?
         WHERE id = ?`,
      )
      .run(leg.asset, leg.orderId, leg.size, leg.side, leg.openPrice, leg.status, tradeId);
  }

  /** Record close of an HL leg + final realized PnL.
   *
   * Vol-arb trades have only an HL leg, so closing HL completes the trade —
   * also flip `settled=1` so they exit `openTrades()` (which the generic risk
   * gate keys on via `openPositionCount`). pnl_usdc is left NULL: vol-arb PnL
   * is tracked via `hl_pnl_usdc` + `realizedHlPnlSince`, and we don't want it
   * to leak into the Sui-leg `realizedPnlSince` aggregation. */
  closeHlLeg(
    tradeId: string,
    leg: {
      closePrice: number;
      /** GROSS price PnL: (close - open) * size, signed for direction. */
      pnlUsdc: number;
      /** Cumulative funding actually paid on this position (positive = paid,
       *  negative = received). Captured from HL position state before close. */
      fundingPaidUsdc: number;
      /** Estimated taker fees on open + close legs combined. */
      feesUsdc: number;
      closedAtMs: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE trades SET hl_close_price = ?, hl_pnl_usdc = ?,
                            hl_funding_paid_usdc = ?, hl_fees_usdc = ?,
                            hl_closed_at_ms = ?,
                            hl_status = 'closed',
                            settled = CASE WHEN strategy = 'vol_arb' THEN 1 ELSE settled END,
                            settled_at_ms = CASE WHEN strategy = 'vol_arb' AND settled_at_ms IS NULL THEN ? ELSE settled_at_ms END
         WHERE id = ?`,
      )
      .run(
        leg.closePrice,
        leg.pnlUsdc,
        leg.fundingPaidUsdc,
        leg.feesUsdc,
        leg.closedAtMs,
        leg.closedAtMs,
        tradeId,
      );
  }

  /** Open HL hedges — used to close on settlement and compute current exposure. */
  openHlHedges(): TradeRecord[] {
    return this.tradeRows(
      `WHERE hl_status = 'open' AND hl_size IS NOT NULL ORDER BY ts_ms ASC`,
    );
  }

  /** Sum of open HL exposure (USD notional) — feeds the risk gate. */
  openHlExposureUsdc(): number {
    const r = this.db
      .prepare<[], { s: number }>(
        `SELECT COALESCE(SUM(hl_size * hl_open_price), 0) AS s FROM trades
         WHERE hl_status = 'open'`,
      )
      .get();
    return r?.s ?? 0;
  }

  /** Realized HL PnL since `sinceMs` — feeds the daily HL loss gate. */
  realizedHlPnlSince(sinceMs: number): number {
    // NET HL PnL = gross price PnL − funding paid − taker fees. Existing rows
    // pre-2026-06-14 have NULL fees and 0 funding, so COALESCE keeps them
    // accurate to what was actually recorded at the time.
    const r = this.db
      .prepare<[number], { p: number }>(
        `SELECT COALESCE(SUM(
            COALESCE(hl_pnl_usdc, 0)
            - COALESCE(hl_funding_paid_usdc, 0)
            - COALESCE(hl_fees_usdc, 0)
         ), 0) AS p
         FROM trades
         WHERE hl_status = 'closed' AND hl_closed_at_ms >= ?`,
      )
      .get(sinceMs);
    return r?.p ?? 0;
  }

  /** Sum of HL trading costs (fees + funding) across closed trades in the
   *  window. Surfaces the drag separately from gross PnL so the dashboard
   *  can show "you'd be up $X if not for fees." */
  hlCostsSince(sinceMs: number): { feesUsdc: number; fundingUsdc: number } {
    const r = this.db
      .prepare<[number], { f: number; g: number }>(
        `SELECT
            COALESCE(SUM(COALESCE(hl_fees_usdc, 0)), 0) AS f,
            COALESCE(SUM(COALESCE(hl_funding_paid_usdc, 0)), 0) AS g
         FROM trades
         WHERE hl_status = 'closed' AND hl_closed_at_ms >= ?`,
      )
      .get(sinceMs);
    return { feesUsdc: r?.f ?? 0, fundingUsdc: r?.g ?? 0 };
  }

  // ============================================================
  // Vol-arb strategy queries (standalone HL trading, strategy='vol_arb')
  // ============================================================

  /** Trades opened by the vol-arb strategy that still have an open HL leg. */
  openVolArbTrades(): TradeRecord[] {
    return this.tradeRows(
      `WHERE strategy = 'vol_arb' AND hl_status = 'open' ORDER BY ts_ms ASC`,
    );
  }

  /** Closed vol-arb trades — dashboard history view. */
  closedVolArbTrades(limit = 500): TradeRecord[] {
    return this.tradeRows(
      `WHERE strategy = 'vol_arb' AND hl_status = 'closed'
       ORDER BY hl_closed_at_ms DESC LIMIT ?`,
      [limit],
    );
  }

  /** Sum of realized vol-arb PnL since `sinceMs` — feeds daily-loss gate. */
  realizedVolArbPnlSince(sinceMs: number): number {
    const r = this.db
      .prepare<[number], { p: number }>(
        `SELECT COALESCE(SUM(hl_pnl_usdc), 0) AS p FROM trades
         WHERE strategy = 'vol_arb' AND hl_status = 'closed'
           AND hl_closed_at_ms >= ?`,
      )
      .get(sinceMs);
    return r?.p ?? 0;
  }

  /** Total open exposure (USD notional) for vol-arb positions. */
  openVolArbExposureUsdc(): number {
    const r = this.db
      .prepare<[], { s: number }>(
        `SELECT COALESCE(SUM(hl_size * hl_open_price), 0) AS s FROM trades
         WHERE strategy = 'vol_arb' AND hl_status = 'open'`,
      )
      .get();
    return r?.s ?? 0;
  }

  /** Sum of pUSD spent on currently-open Poly positions. */
  openPolyExposureUsdc(): number {
    const r = this.db
      .prepare<[], { s: number }>(
        `SELECT COALESCE(SUM(poly_cost_usdc), 0) AS s FROM trades
         WHERE poly_settled = 0 AND poly_status IN ${OPEN_POLY_STATUSES}`,
      )
      .get();
    return r?.s ?? 0;
  }

  /**
   * List trades that are settled, won (payout > 0), and not yet redeemed
   * on-chain. Auto-redeemer iterates this each loop iteration.
   */
  unredeemedWinningTrades(): TradeRecord[] {
    return this.tradeRows(
      `WHERE settled = 1 AND mode = 'live' AND payout_usdc > 0 AND redeem_tx_digest IS NULL ORDER BY ts_ms ASC`,
    );
  }

  markRedeemed(tradeId: string, redeemTxDigest: string): void {
    this.db
      .prepare(`UPDATE trades SET redeem_tx_digest = ? WHERE id = ?`)
      .run(redeemTxDigest, tradeId);
  }

  /**
   * Abandon Predict (Sui) trades that have sat in the unredeemed-winning
   * queue for longer than `maxAgeMs`. Mirrors abandonStalePolyTrades. The
   * usual cause is that the position was pruned from the on-chain
   * predict_manager (oracles age out and lose their position records),
   * leaving decrease_position to MoveAbort(1) on every retry forever.
   *
   * Marks the trade by setting redeem_tx_digest to a sentinel string so the
   * unredeemedWinningTrades query stops returning it. Audit trail is
   * preserved — the row's payout/pnl numbers are untouched, only the redeem
   * marker changes. Returns rows touched.
   */
  abandonStaleRedeems(maxAgeMs: number, nowMs: number): number {
    const cutoff = nowMs - maxAgeMs;
    const r = this.db
      .prepare(
        `UPDATE trades
            SET redeem_tx_digest = 'abandoned'
          WHERE settled = 1
            AND mode = 'live'
            AND payout_usdc > 0
            AND redeem_tx_digest IS NULL
            AND ts_ms < ?`,
      )
      .run(cutoff);
    return r.changes;
  }

  /**
   * Reconcile poly_arb HL hedges whose Predict leg settled long ago but whose
   * ledger hl_status is still 'open'. Cause: the HL-close path fires when the
   * Poly leg settles via UMA — if UMA never confirms the market (orphaned /
   * neg-risk cleanup), the HL close never happens and the row lingers as
   * "open" in the ledger. On chain the position was long since flat.
   *
   * Marks hl_status=closed with 0 realized PnL and closePrice=hlOpenPrice so
   * fees + funding numbers stay untouched and openHlExposureUsdc drops back
   * to reality. Only touches poly_arb (vol_arb has its own close path). Only
   * touches trades where the Predict leg is settled=1 and expiry is at least
   * `minAgeMs` in the past — protects live-in-flight trades.
   */
  abandonStaleHlLegs(minAgeMs: number, nowMs: number): number {
    const expiryCutoff = nowMs - minAgeMs;
    const r = this.db
      .prepare(
        `UPDATE trades
            SET hl_close_price = hl_open_price,
                hl_pnl_usdc = 0,
                hl_funding_paid_usdc = COALESCE(hl_funding_paid_usdc, 0),
                hl_fees_usdc = COALESCE(hl_fees_usdc, 0),
                hl_closed_at_ms = ?,
                hl_status = 'closed'
          WHERE hl_status = 'open'
            AND hl_open_price IS NOT NULL
            AND (strategy = 'poly_arb' OR strategy IS NULL)
            AND settled = 1
            AND expiry_ms < ?`,
      )
      .run(nowMs, expiryCutoff);
    return r.changes;
  }

  // ---- Read API for dashboard ----

  recentSignals(limit = 100): SignalRecord[] {
    const rows = this.db
      .prepare<
        [number],
        {
          id: string;
          ts_ms: number;
          oracle_id: string;
          underlying: string;
          expiry_ms: number;
          strike: number;
          predict_direction: 'up' | 'down';
          predict_prob: number;
          predict_iv: number;
          poly_prob: number;
          poly_iv: number | null;
          spread: number;
          iv_spread: number | null;
          action: SignalRecord['action'];
          filter_reason: string | null;
          notional: number | null;
          cost_usdc: number | null;
        }
      >(`SELECT * FROM signals ORDER BY ts_ms DESC LIMIT ?`)
      .all(limit);
    return rows.map((r) => ({
      id: r.id,
      timestampMs: r.ts_ms,
      oracleId: r.oracle_id,
      underlyingAsset: r.underlying,
      expiryMs: r.expiry_ms,
      strike: r.strike,
      predictDirection: r.predict_direction,
      predictProb: r.predict_prob,
      predictIv: r.predict_iv,
      polyProb: r.poly_prob,
      polyIv: r.poly_iv ?? 0,
      spread: r.spread,
      ivSpread: r.iv_spread ?? 0,
      action: r.action,
      filterReason: (r.filter_reason ?? undefined) as SignalRecord['filterReason'],
      notional: r.notional ?? undefined,
      costUsdc: r.cost_usdc ?? undefined,
    }));
  }

  openTrades(): TradeRecord[] {
    return this.tradeRows(`WHERE settled = 0 ORDER BY ts_ms DESC`);
  }

  closedTrades(limit = 500): TradeRecord[] {
    return this.tradeRows(`WHERE settled = 1 ORDER BY ts_ms DESC LIMIT ?`, [limit]);
  }

  allTrades(): TradeRecord[] {
    return this.tradeRows(`ORDER BY ts_ms DESC`);
  }

  recentSviSnapshotsForOracle(oracleId: string, limit = 100): Array<OracleSnapshot> {
    const rows = this.db
      .prepare<
        [string, number],
        {
          oracle_id: string;
          ts_ms: number;
          spot: number;
          forward: number;
          a: number;
          b: number;
          rho: number;
          m: number;
          sigma: number;
        }
      >(`SELECT * FROM svi_snapshots WHERE oracle_id = ? ORDER BY ts_ms DESC LIMIT ?`)
      .all(oracleId, limit);
    return rows.map((r) => ({
      oracleId: r.oracle_id,
      underlyingAsset: 'BTC',
      expiryMs: 0,
      spot: r.spot,
      forward: r.forward,
      svi: { a: r.a, b: r.b, rho: r.rho, m: r.m, sigma: r.sigma },
      timestampMs: r.ts_ms,
      isSettled: false,
    }));
  }

  countSignalsSince(sinceMs: number): number {
    const r = this.db
      .prepare<[number], { c: number }>(`SELECT COUNT(*) AS c FROM signals WHERE ts_ms >= ?`)
      .get(sinceMs);
    return r?.c ?? 0;
  }

  countTradesSince(sinceMs: number): number {
    const r = this.db
      .prepare<[number], { c: number }>(`SELECT COUNT(*) AS c FROM trades WHERE ts_ms >= ?`)
      .get(sinceMs);
    return r?.c ?? 0;
  }

  realizedPnlSince(sinceMs: number): number {
    const r = this.db
      .prepare<[number], { p: number }>(
        `SELECT COALESCE(SUM(pnl_usdc), 0) AS p FROM trades WHERE settled = 1 AND ts_ms >= ?`,
      )
      .get(sinceMs);
    return r?.p ?? 0;
  }

  consecutiveLosses(): number {
    // Only count losses since the last circuit-breaker reset. resume() bumps
    // the watermark to NOW so a deliberate resume actually clears the breaker
    // state — otherwise the count just rebuilds on the next risk check and
    // re-pauses the bot before any new trade can clear it.
    //
    // Counts REAL-MONEY PnL first (poly leg) and falls back to the Predict
    // leg for pure-Predict trades. Rows with no realized PnL at all (e.g.
    // convergence rows before their poly leg settles — inserted settled=1,
    // pnl_usdc NULL) are excluded in SQL rather than iterated: the old code
    // read `NULL < 0` (false in JS) as "streak over", so any such row
    // silently disabled the breaker.
    const watermark = this.getCircuitBreakerResetAtMs();
    const rows = this.db
      .prepare<[number], { pnl: number }>(
        `SELECT COALESCE(poly_pnl_usdc, pnl_usdc) AS pnl FROM trades
         WHERE COALESCE(poly_pnl_usdc, pnl_usdc) IS NOT NULL
           AND (poly_settled = 1 OR settled = 1)
           AND COALESCE(poly_settled_at_ms, settled_at_ms, ts_ms) > ?
         ORDER BY COALESCE(poly_settled_at_ms, settled_at_ms, ts_ms) DESC
         LIMIT 100`,
      )
      .all(watermark);
    let n = 0;
    for (const r of rows) {
      if (r.pnl < 0) n++;
      else break;
    }
    return n;
  }

  /** Bump the watermark so consecutiveLosses() ignores anything before now.
   *  Called by RiskGate.resume() — gives the breaker a clean slate. */
  resetCircuitBreaker(nowMs: number): void {
    this.db
      .prepare(`UPDATE pause_state SET circuit_breaker_reset_at_ms = ? WHERE id = 1`)
      .run(nowMs);
  }

  getCircuitBreakerResetAtMs(): number {
    const row = this.db
      .prepare<[], { v: number }>(
        `SELECT circuit_breaker_reset_at_ms AS v FROM pause_state WHERE id = 1`,
      )
      .get();
    return row?.v ?? 0;
  }

  private tradeRows(suffix: string, params: unknown[] = []): TradeRecord[] {
    const rows = this.db
      .prepare<
        unknown[],
        {
          id: string;
          signal_id: string;
          ts_ms: number;
          mode: 'paper' | 'live';
          oracle_id: string;
          underlying: string;
          expiry_ms: number;
          strike: number;
          direction: 'up' | 'down';
          quantity_dusdc: number;
          cost_price: number;
          cost_usdc: number;
          tx_digest: string | null;
          settled: number;
          payout_usdc: number | null;
          pnl_usdc: number | null;
          settlement_price: number | null;
          settled_at_ms: number | null;
          ms_to_expiry_at_exec: number | null;
          predict_prob_at_exec: number | null;
          poly_ask_at_exec: number | null;
          predict_iv_at_exec: number | null;
          edge_at_exec: number | null;
          redeem_tx_digest: string | null;
          poly_network: string | null;
          poly_token_id: string | null;
          poly_condition_id: string | null;
          poly_side: string | null;
          poly_outcome: string | null;
          poly_order_id: string | null;
          poly_filled_shares: number | null;
          poly_fill_price: number | null;
          poly_cost_usdc: number | null;
          poly_tx_hash: string | null;
          poly_status: string | null;
          poly_settled: number | null;
          poly_settled_at_ms: number | null;
          poly_settlement_outcome: string | null;
          poly_payout_usdc: number | null;
          poly_pnl_usdc: number | null;
          poly_redeem_tx_hash: string | null;
          poly_redeem_status: string | null;
          hl_asset: string | null;
          hl_order_id: string | null;
          hl_size: number | null;
          hl_side: string | null;
          hl_open_price: number | null;
          hl_close_price: number | null;
          hl_status: string | null;
          hl_pnl_usdc: number | null;
          hl_funding_paid_usdc: number | null;
          hl_closed_at_ms: number | null;
          strategy: string | null;
          poly_high_water_frac: number | null;
        }
      >(`SELECT * FROM trades ${suffix}`)
      .all(...params);
    return rows.map((r) => ({
      id: r.id,
      signalId: r.signal_id,
      timestampMs: r.ts_ms,
      mode: r.mode,
      oracleId: r.oracle_id,
      underlyingAsset: r.underlying,
      expiryMs: r.expiry_ms,
      strike: r.strike,
      direction: r.direction,
      quantityDusdc: r.quantity_dusdc,
      costPrice: r.cost_price,
      costUsdc: r.cost_usdc,
      txDigest: r.tx_digest ?? undefined,
      settled: r.settled === 1,
      payoutUsdc: r.payout_usdc ?? undefined,
      pnlUsdc: r.pnl_usdc ?? undefined,
      settlementPrice: r.settlement_price ?? undefined,
      settledAtMs: r.settled_at_ms ?? undefined,
      msToExpiryAtExec: r.ms_to_expiry_at_exec ?? undefined,
      predictProbAtExec: r.predict_prob_at_exec ?? undefined,
      polyAskAtExec: r.poly_ask_at_exec ?? undefined,
      predictIvAtExec: r.predict_iv_at_exec ?? undefined,
      edgeAtExec: r.edge_at_exec ?? undefined,
      redeemTxDigest: r.redeem_tx_digest ?? undefined,
      polyNetwork: (r.poly_network as 'amoy' | 'polygon' | undefined) ?? undefined,
      polyTokenId: r.poly_token_id ?? undefined,
      polyConditionId: r.poly_condition_id ?? undefined,
      polySide: (r.poly_side as 'buy' | 'sell' | undefined) ?? undefined,
      polyOutcome: (r.poly_outcome as 'yes' | 'no' | undefined) ?? undefined,
      polyOrderId: r.poly_order_id ?? undefined,
      polyFilledShares: r.poly_filled_shares ?? undefined,
      polyFillPrice: r.poly_fill_price ?? undefined,
      polyCostUsdc: r.poly_cost_usdc ?? undefined,
      polyTxHash: r.poly_tx_hash ?? undefined,
      polyStatus: (r.poly_status as 'submitted' | 'filled' | 'failed' | 'partial' | undefined) ?? undefined,
      polySettled: r.poly_settled === 1,
      polySettledAtMs: r.poly_settled_at_ms ?? undefined,
      polySettlementOutcome:
        (r.poly_settlement_outcome as TradeRecord['polySettlementOutcome']) ?? undefined,
      polyPayoutUsdc: r.poly_payout_usdc ?? undefined,
      polyPnlUsdc: r.poly_pnl_usdc ?? undefined,
      polyRedeemTxHash: r.poly_redeem_tx_hash ?? undefined,
      polyRedeemStatus:
        (r.poly_redeem_status as 'pending' | 'success' | 'failed' | undefined) ?? undefined,
      hlAsset: r.hl_asset ?? undefined,
      hlOrderId: r.hl_order_id ?? undefined,
      hlSize: r.hl_size ?? undefined,
      hlSide: (r.hl_side as 'long' | 'short' | undefined) ?? undefined,
      hlOpenPrice: r.hl_open_price ?? undefined,
      hlClosePrice: r.hl_close_price ?? undefined,
      hlStatus:
        (r.hl_status as 'open' | 'closed' | 'failed' | undefined) ?? undefined,
      hlPnlUsdc: r.hl_pnl_usdc ?? undefined,
      hlFundingPaidUsdc: r.hl_funding_paid_usdc ?? undefined,
      hlClosedAtMs: r.hl_closed_at_ms ?? undefined,
      strategy: (r.strategy as 'poly_arb' | 'vol_arb' | 'convergence' | null) ?? 'poly_arb',
      polyHighWaterFrac: r.poly_high_water_frac ?? undefined,
    }));
  }
}
