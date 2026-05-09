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
  redeem_tx_digest TEXT
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
  ts_ms INTEGER NOT NULL
);
INSERT OR IGNORE INTO pause_state(id, paused, ts_ms) VALUES (1, 0, 0);
`;

export class LedgerStore {
  private readonly db: DB;

  constructor(filepath: string) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    this.db = new Database(filepath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    // Backwards-compat migration: add `redeem_tx_digest` if a pre-existing
    // database doesn't have it yet. The CREATE above is a no-op if the
    // table already exists (without that column).
    const cols = this.db
      .prepare<[], { name: string }>(`PRAGMA table_info(trades)`)
      .all()
      .map((r) => r.name);
    if (!cols.includes('redeem_tx_digest')) {
      this.db.exec(`ALTER TABLE trades ADD COLUMN redeem_tx_digest TEXT`);
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

  insertTrade(t: Omit<TradeRecord, 'id'> & { id?: string }): string {
    const id = t.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO trades (id, signal_id, ts_ms, mode, oracle_id, underlying, expiry_ms, strike,
         direction, quantity_dusdc, cost_price, cost_usdc, tx_digest, settled, payout_usdc, pnl_usdc)
         VALUES (@id, @sigId, @ts, @mode, @oracleId, @underlying, @expiry, @strike,
         @dir, @qty, @cp, @cost, @txd, @settled, @payout, @pnl)`,
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
      `UPDATE trades SET settled = 1, payout_usdc = @payout, pnl_usdc = @pnl WHERE id = @id`,
    );
    const tx = this.db.transaction((items: typeof trades) => {
      let count = 0;
      for (const t of items) {
        const won = t.direction === 'up' ? settlementPrice > t.strike : settlementPrice <= t.strike;
        const payout = won ? t.quantity_dusdc : 0;
        const pnl = payout - t.cost_usdc;
        upd.run({ payout, pnl, id: t.id });
        count++;
      }
      return count;
    });
    void nowMs;
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
    const rows = this.db
      .prepare<[], { pnl: number }>(
        `SELECT pnl_usdc as pnl FROM trades WHERE settled = 1 ORDER BY ts_ms DESC LIMIT 50`,
      )
      .all();
    let n = 0;
    for (const r of rows) {
      if (r.pnl < 0) n++;
      else break;
    }
    return n;
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
    }));
  }
}
