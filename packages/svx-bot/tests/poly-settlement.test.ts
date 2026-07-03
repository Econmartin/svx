/**
 * Tests for the Polymarket settlement leg added in Part 1.
 *
 * Covers:
 *   - parseMarketResolution: yes/no/unresolved/ambiguous gamma responses.
 *   - Payout & PnL math for winning / losing / partial-fill trades.
 *   - Daily-loss-limit gate on RiskGate.checkPoly.
 *   - Schema migration: existing DBs gain the new columns and the row mapper
 *     surfaces them on TradeRecord.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { LedgerStore } from '../src/ledger/store.js';
import { parseMarketResolution } from '../src/pricing/polymarket.js';
import { RiskGate } from '../src/exec/risk.js';
import type { SvxConfig } from '../src/config.js';

const baseCfg: SvxConfig = {
  paperTrading: true,
  spreadThreshold: 0.03,
  maxPositionDusdc: 15,
  maxPositionPct: 0.5,
  dailyLossLimitDusdc: 150,
  maxOpenPositions: 10,
  maxPositionsPerSignal: 2,
  minPredictProb: 0.05,
  maxPredictProb: 0.95,
  signalLogMinSpreadFrac: 0.3,
  maxSviStalenessSec: 300,
  polyMaxBidaskVolPts: 0.05,
  polyMinVolume24hUsd: 1000,
  expiryToleranceSec: 3600,
  circuitBreakerLosses: 5,
  polymarketGammaBase: 'https://gamma-api.polymarket.com',
  polymarketClobBase: 'https://clob.polymarket.com',
  polyExecutionEnabled: true,
  polyNetwork: 'polygon',
  polyClobHost: '',
  polyRpcUrl: '',
  maxPolyPositionUsdc: 2,
  maxOpenPolyPositions: 5,
  polyMinBookDepthShares: 20,
  polyMinOrderUsdc: 0.5,
  polyFillFailedCooldownMs: 5 * 60_000,
  dailyPolyLossLimitUsdc: 10,
  polyFillTimeoutMs: 30_000,
  polyStaleSettlementDays: 14,
  predictStaleRedeemHours: 6,
  polyStopLossFrac: 0.5,
  polyReentryCooldownMs: 1_800_000,
  polyMinEntryPrice: 0.03,
  polyMaxEntryPrice: 0.97,
  polySignatureType: 'EOA',
  polyFunderAddress: '',
  hlExecutionEnabled: false,
  hlNetwork: 'mainnet',
  hlHedgeAsset: 'BTC',
  hlMinOrderUsdc: 10,
  hlTakerFeeRate: 0.00035,
  maxHlPerTradeUsdc: 2,
  maxHlOpenUsdc: 10,
  dailyHlLossLimitUsdc: 5,
  hlRequiredForPoly: false,
  volArbEnabled: false,
  volArbIvSpreadOpenThreshold: 0.05,
  volArbIvSpreadCloseThreshold: 0.02,
  volArbDirectionBiasThreshold: 0.03,
  volArbBiasBypassSpread: 0.15,
  maxVolArbPerTradeUsdc: 2,
  maxVolArbOpenUsdc: 10,
  dailyVolArbLossLimitUsdc: 5,
  volArbTimeStopMinutes: 60,
  volArbMinSamples: 30,
  volArbTickMs: 2_000,
  volArbOracleCacheMs: 30_000,
  marginLeverEnabled: false,
  marginLeverOpenBias: 0.10,
  marginLeverCloseBias: 0.04,
  marginLeverMaxHoldMinutes: 45,
  marginLeverPerTradeNotionalUsdc: 500,
  marginLeverMaxBorrowNotionalUsdc: 1500,
  marginLeverDailyLossLimitUsdc: 100,
  marginLeverTickMs: 15_000,
  polyEarlyExitEnabled: true,
  polyEarlyExitMinProfitFrac: 0.2,
  autoResumeOnBoot: true,
  dataDir: '/tmp/svx-test',
  apiHost: '127.0.0.1',
  apiPort: 4321,
  loopIntervalMs: 15_000,
  instanceLabel: '',
};

describe('parseMarketResolution', () => {
  const baseMarket = {
    id: 'mid-1',
    question: 'Bitcoin above $80,000 on May 11?',
    slug: 'btc-80k-may-11',
    endDate: '2026-05-11T16:00:00Z',
    conditionId: '0xabc',
    outcomes: '["Yes","No"]',
    clobTokenIds: '["1","2"]',
  };

  it('returns closed=false when the market is still open', () => {
    const r = parseMarketResolution({
      ...baseMarket,
      closed: false,
      outcomePrices: '["0.55","0.45"]',
    });
    expect(r.closed).toBe(false);
    expect(r.winningOutcome).toBeNull();
  });

  it('detects Yes as the winner when prices resolve to [1, 0]', () => {
    const r = parseMarketResolution({
      ...baseMarket,
      closed: true,
      outcomePrices: '["1","0"]',
      closedTime: '2026-05-11T20:14:00Z',
      negRisk: true,
    });
    expect(r.closed).toBe(true);
    expect(r.winningOutcome).toBe('yes');
    expect(r.negRisk).toBe(true);
    expect(r.resolvedAtMs).toBe(Date.parse('2026-05-11T20:14:00Z'));
  });

  it('detects No as the winner when prices resolve to [0, 1]', () => {
    const r = parseMarketResolution({
      ...baseMarket,
      closed: true,
      outcomePrices: '["0","1"]',
    });
    expect(r.closed).toBe(true);
    expect(r.winningOutcome).toBe('no');
    expect(r.negRisk).toBe(false); // default when flag is absent
  });

  it('treats a closed market with ambiguous prices as not-yet-resolved', () => {
    // Gamma sometimes flips `closed: true` during UMA's dispute window before
    // outcome prices settle to 0/1. We treat ambiguous prices as unresolved
    // so the bot doesn't mark a trade settled with the wrong payout.
    const r = parseMarketResolution({
      ...baseMarket,
      closed: true,
      outcomePrices: '["0.5","0.5"]',
    });
    expect(r.closed).toBe(false);
    expect(r.winningOutcome).toBeNull();
  });

  it('handles malformed outcomePrices gracefully', () => {
    const r = parseMarketResolution({
      ...baseMarket,
      closed: true,
      outcomePrices: 'not-json',
    });
    expect(r.closed).toBe(false);
    expect(r.winningOutcome).toBeNull();
  });
});

describe('Polymarket payout math', () => {
  // The same arithmetic used inside reconcilePolySettlements. We exercise it
  // through the ledger to also confirm column round-tripping.
  let tmp: string;
  let ledger: LedgerStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-payout-'));
    ledger = new LedgerStore(path.join(tmp, 'svx.sqlite'));
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function insertPolyTrade(opts: {
    outcome: 'yes' | 'no';
    shares: number;
    costUsdc: number;
    conditionId?: string;
  }): string {
    return ledger.insertTrade({
      signalId: 's',
      timestampMs: 1_700_000_000_000,
      mode: 'paper',
      oracleId: 'oracle-x',
      underlyingAsset: 'BTC',
      expiryMs: 1_700_000_900_000,
      strike: 80_000,
      direction: 'up',
      quantityDusdc: 0,
      costPrice: 0.5,
      costUsdc: 0,
      settled: false,
      polyNetwork: 'polygon',
      polyTokenId: '1',
      polyConditionId: opts.conditionId ?? '0xabc',
      polySide: 'buy',
      polyOutcome: opts.outcome,
      polyOrderId: 'ord',
      polyFilledShares: opts.shares,
      polyFillPrice: opts.costUsdc / opts.shares,
      polyCostUsdc: opts.costUsdc,
      polyStatus: 'filled',
    });
  }

  it('records full payout = filled_shares × 1 on a winning trade', () => {
    const id = insertPolyTrade({ outcome: 'yes', shares: 10, costUsdc: 2 });
    const payout = 10 * 1; // shares × (won ? 1 : 0)
    ledger.markPolySettled(id, 'yes', payout, payout - 2, 1_700_001_000_000);

    const [closed] = ledger.closedPolyTrades(10);
    expect(closed?.polySettled).toBe(true);
    expect(closed?.polyPayoutUsdc).toBe(10);
    expect(closed?.polyPnlUsdc).toBe(8);
    expect(closed?.polySettlementOutcome).toBe('yes');
  });

  it('records zero payout and full-cost loss on a losing trade', () => {
    const id = insertPolyTrade({ outcome: 'yes', shares: 10, costUsdc: 2 });
    ledger.markPolySettled(id, 'no', 0, -2, 1_700_001_000_000);

    const [closed] = ledger.closedPolyTrades(10);
    expect(closed?.polyPayoutUsdc).toBe(0);
    expect(closed?.polyPnlUsdc).toBe(-2);
  });

  it('sums realizedPolyPnlSince correctly across mixed wins and losses', () => {
    const a = insertPolyTrade({ outcome: 'yes', shares: 10, costUsdc: 2 });
    const b = insertPolyTrade({ outcome: 'no', shares: 5, costUsdc: 1.5 });
    const c = insertPolyTrade({ outcome: 'yes', shares: 4, costUsdc: 2 });
    ledger.markPolySettled(a, 'yes', 10, 8, 1_700_001_000_000); // win +8
    ledger.markPolySettled(b, 'yes', 0, -1.5, 1_700_001_000_000); // lose -1.5
    ledger.markPolySettled(c, 'no', 0, -2, 1_700_001_000_000); // lose -2

    // Sum across all settled rows since epoch.
    expect(ledger.realizedPolyPnlSince(0)).toBeCloseTo(4.5);
  });

  it('isolates unsettled trades so settlement-poll only revisits the ones it should', () => {
    insertPolyTrade({ outcome: 'yes', shares: 10, costUsdc: 2 });
    const b = insertPolyTrade({ outcome: 'no', shares: 5, costUsdc: 1.5 });
    ledger.markPolySettled(b, 'no', 5, 3.5, 1_700_001_000_000);

    const unsettled = ledger.unsettledPolyTrades();
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]!.polyOutcome).toBe('yes');
  });

  it('skips losing winners from the auto-redeem queue (saves gas)', () => {
    const a = insertPolyTrade({ outcome: 'yes', shares: 10, costUsdc: 2 });
    const b = insertPolyTrade({ outcome: 'no', shares: 5, costUsdc: 1.5 });
    ledger.markPolySettled(a, 'yes', 10, 8, 1_700_001_000_000); // winner
    ledger.markPolySettled(b, 'yes', 0, -1.5, 1_700_001_000_000); // loser

    const toRedeem = ledger.unredeemedWinningPolyTrades();
    expect(toRedeem).toHaveLength(1);
    expect(toRedeem[0]!.id).toBe(a);
  });

  it('does not retry failed redeems endlessly', () => {
    const id = insertPolyTrade({ outcome: 'yes', shares: 10, costUsdc: 2 });
    ledger.markPolySettled(id, 'yes', 10, 8, 1_700_001_000_000);
    expect(ledger.unredeemedWinningPolyTrades()).toHaveLength(1);
    ledger.markPolyRedeemed(id, null, 'failed');
    expect(ledger.unredeemedWinningPolyTrades()).toHaveLength(0);
  });
});

describe('RiskGate.checkPoly daily-loss gate', () => {
  // Note: each test gets a unique killFlag path to avoid cross-test
  // pause-flag leakage when running in parallel.
  function makeRisk(opts: { polyPnl24h: number; paused?: boolean }) {
    const fake = {
      getPause: () => ({ paused: !!opts.paused, reason: 'test pause' }),
      setPause: () => {},
      consecutiveLosses: () => 0,
      realizedPolyPnlSince: () => opts.polyPnl24h,
    } as unknown as import('../src/ledger/store.js').LedgerStore;
    return new RiskGate(fake, baseCfg, `/tmp/svx-paused-test-${Math.random()}`);
  }

  it('passes when 24h poly PnL is positive', () => {
    const r = makeRisk({ polyPnl24h: 1.5 });
    const d = r.checkPoly({ costUsdc: 1, openPolyPositionCount: 0 });
    expect(d.ok).toBe(true);
  });

  it('passes when 24h poly PnL is mildly negative but above the limit', () => {
    const r = makeRisk({ polyPnl24h: -5 }); // limit is -10
    const d = r.checkPoly({ costUsdc: 1, openPolyPositionCount: 0 });
    expect(d.ok).toBe(true);
  });

  it('blocks when 24h poly PnL reaches the daily-loss limit exactly', () => {
    const r = makeRisk({ polyPnl24h: -10 });
    const d = r.checkPoly({ costUsdc: 1, openPolyPositionCount: 0 });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/24h poly loss/);
  });

  it('blocks and includes the actual PnL value in the reason text', () => {
    const r = makeRisk({ polyPnl24h: -12.5 });
    const d = r.checkPoly({ costUsdc: 1, openPolyPositionCount: 0 });
    expect(d.ok).toBe(false);
    expect(d.reason).toContain('-12.50');
  });
});

describe('ledger migration: existing DB gains the new poly settlement columns', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-mig-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adds poly_settled and friends to a pre-existing trades table', () => {
    const dbPath = path.join(tmp, 'svx.sqlite');
    // Pre-seed a DB that has the trades table WITHOUT the new columns —
    // matches what an upgraded mainnet bot would have on disk.
    const seed = new Database(dbPath);
    seed.exec(`CREATE TABLE trades (
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
      pnl_usdc REAL
    )`);
    seed.close();

    // Opening the store applies the additive ALTER TABLE migrations.
    const ledger = new LedgerStore(dbPath);
    ledger.close();

    const reopen = new Database(dbPath);
    const rows = reopen.prepare(`PRAGMA table_info(trades)`).all() as Array<{ name: string }>;
    const cols = rows.map((r) => r.name);
    reopen.close();

    expect(cols).toContain('poly_settled');
    expect(cols).toContain('poly_settled_at_ms');
    expect(cols).toContain('poly_settlement_outcome');
    expect(cols).toContain('poly_payout_usdc');
    expect(cols).toContain('poly_pnl_usdc');
    expect(cols).toContain('poly_redeem_tx_hash');
    expect(cols).toContain('poly_redeem_status');
  });
});
