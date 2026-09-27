import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore, type ShadowDecisionInput } from '../src/ledger/store.js';
import { backfillEntryEdges, enabledAt, evaluateSwitchboard } from '../src/strategy/switchboard.js';

const d = (i: number, over: Partial<ShadowDecisionInput> = {}): ShadowDecisionInput => ({
  network: 'mainnet',
  marketId: `0xm${i}`,
  slot: 't50s',
  expiryMs: 1_000_000 + i,
  recordedAtMs: 1_000 + i,
  ttmMs: 50_000,
  reference: 84_000,
  forward: 84_000,
  boardUp: 0.5,
  costUp: 0.6,
  costDown: 0.6,
  binMid: null,
  binImpliedUp: null,
  mom1m: null,
  mom5m: null,
  mom15m: null,
  bookImb: null,
  takerBuyRatio: null,
  funding: null,
  ...over,
});

describe('switchboard: green on, red off', () => {
  let tmp: string;
  let ledger: LedgerStore;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-sb-'));
    ledger = new LedgerStore(path.join(tmp, 'svx.sqlite'));
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const settle = (i: number, up: boolean) =>
    ledger.resolveShadowMarket(`0xm${i}`, up ? 84_100 : 83_900, 2_000_000);
  const status = (key: string, now: number) =>
    evaluateSwitchboard(ledger, 'mainnet', now, true).find((e) => e.key === key)?.status;

  /** `count` always_up decisions at `cost` all-in, the first `wins` of them won. */
  const batch = (from: number, count: number, wins: number, over: Partial<ShadowDecisionInput> = {}) => {
    for (let i = 0; i < count; i++) {
      ledger.insertShadowDecision(d(from + i, over));
      settle(from + i, i < wins);
    }
  };

  it('stays off until it has 50 paper decisions, however good they look', () => {
    batch(1, 49, 49); // 49 straight wins at 60c: +40c/contract, but only 49
    const e = () => evaluateSwitchboard(ledger, 'mainnet', 10, true).find((x) => x.key === 'always_up@t50s')!;
    expect(e().status).toBe('off');
    expect(e().reason).toMatch(/only 49 paper decisions/);
    batch(50, 1, 1);
    expect(status('always_up@t50s', 20)).toBe('on');
  });

  it('needs the average clearly above zero (mean − 2·stderr), not just positive', () => {
    // 34/50 wins at 60c: +8c/contract, stderr ≈ 6.7c → lower bound < 0 → off.
    batch(1, 50, 34);
    const e = evaluateSwitchboard(ledger, 'mainnet', 10, true).find((x) => x.key === 'always_up@t50s')!;
    expect(e.pnlPerContract).toBeCloseTo(0.08);
    expect(e.status).toBe('off');
    expect(e.reason).toMatch(/not clearly profitable/);
  });

  it('once on, stays on while the average is positive and switches off when it turns red', () => {
    batch(1, 50, 40); // +20c, clearly positive → on
    expect(status('always_up@t50s', 10)).toBe('on');
    batch(51, 20, 11); // 51/70 won: +12.9c, no longer "clearly" positive — still on (hysteresis)
    expect(status('always_up@t50s', 20)).toBe('on');
    batch(71, 30, 0); // 51/100: −9c → red → off
    expect(status('always_up@t50s', 30)).toBe('off');
  });

  it('vetoes a slot when the same signal is clearly losing across all slots', () => {
    batch(1, 50, 40); // always_up@t50s: +20c
    // always_up@t30s: 1/200 won at 60c — deeply red, dragging the pooled score down.
    for (let i = 0; i < 200; i++) {
      ledger.insertShadowDecision(d(1000 + i, { slot: 't30s' }));
      settle(1000 + i, i === 0);
    }
    const e = evaluateSwitchboard(ledger, 'mainnet', 10, true).find((x) => x.key === 'always_up@t50s')!;
    expect(e.status).toBe('off');
    expect(e.reason).toMatch(/clearly losing across all slots/);
  });

  const live = (i: number, tsMs: number, won: boolean) => {
    ledger.insertTrade({
      signalId: 'always_up@t50s',
      timestampMs: tsMs,
      mode: 'live',
      oracleId: `0xlive${i}`,
      underlyingAsset: 'BTC',
      expiryMs: tsMs + 60_000,
      strike: 100,
      direction: 'up',
      quantityDusdc: 5,
      costPrice: 0.6,
      costUsdc: 3,
      settled: false,
      strategy: 'auto_shadow',
    });
    ledger.settleTradesForOracle(`0xlive${i}`, won ? 101 : 99, tsMs + 60_000);
  };

  it('switches off when live fills win far less often than paper, then must relearn', () => {
    batch(1, 50, 40); // 80% on paper → on at t=10
    expect(status('always_up@t50s', 10)).toBe('on');
    for (let i = 0; i < 6; i++) live(i, 100 + i, false); // 0/6 live: P = 0.2^6 ≈ 0.0001
    const e = evaluateSwitchboard(ledger, 'mainnet', 1_000, true).find((x) => x.key === 'always_up@t50s')!;
    expect(e.status).toBe('off');
    expect(e.reason).toMatch(/live 0\/6 wins vs 80% on paper/);
    expect(e.blockedAtN).toBe(50);
    // Paper still looks great, but it needs 50 fresh decisions first.
    batch(51, 49, 49);
    expect(status('always_up@t50s', 2_000)).toBe('off');
    batch(100, 1, 1);
    expect(status('always_up@t50s', 3_000)).toBe('on');
  });

  it('lets a long shot ride a losing run its hit rate explains (13 straight at 17%)', () => {
    // always_up at 3c all-in winning 17%: +14c/contract.
    batch(1, 100, 17, { costUp: 0.03 });
    expect(status('always_up@t50s', 10)).toBe('on');
    for (let i = 0; i < 13; i++) live(i, 100 + i, false); // P(0/13 | 17%) ≈ 0.089 > 0.025
    const e = evaluateSwitchboard(ledger, 'mainnet', 1_000, true).find((x) => x.key === 'always_up@t50s')!;
    expect(e.status).toBe('on');
    expect(e.liveN).toBe(13);
    // …but not a run it can't: 0/25 has P ≈ 0.009.
    for (let i = 13; i < 25; i++) live(i, 100 + i, false);
    expect(status('always_up@t50s', 2_000)).toBe('off');
  });

  it('backfills old live trades with the score they had when placed, not today\'s', () => {
    ledger.insertShadowDecision(d(1)); // expires 1_000_001: a win → +40¢
    settle(1, true);
    ledger.insertShadowDecision(d(2)); // expires 1_000_002: a loss → today −10¢
    settle(2, false);
    ledger.insertTrade({
      signalId: 'always_up@t50s',
      timestampMs: 1_000_001, // placed after the win settled, before the loss
      mode: 'live',
      oracleId: '0xlive',
      underlyingAsset: 'BTC',
      expiryMs: 1_060_000,
      strike: 84_000,
      direction: 'up',
      quantityDusdc: 5,
      costPrice: 0.6,
      costUsdc: 3,
      settled: false,
      strategy: 'auto_shadow',
    });
    expect(backfillEntryEdges(ledger, 'mainnet')).toBe(1);
    expect(ledger.livePredictTradesSince(0)[0]!.edgeAtExec).toBeCloseTo(0.4);
    expect(backfillEntryEdges(ledger, 'mainnet')).toBe(0); // one-shot
  });

  it('rings shadow results we traded live on the same market', () => {
    for (const i of [1, 2]) {
      ledger.insertShadowDecision(d(i));
      settle(i, true);
    }
    ledger.insertTrade({
      signalId: 'always_up@t50s',
      timestampMs: 500,
      mode: 'live',
      oracleId: '0xm2',
      underlyingAsset: 'BTC',
      expiryMs: 1_000_002,
      strike: 84_000,
      direction: 'up',
      quantityDusdc: 5,
      costPrice: 0.6,
      costUsdc: 3,
      settled: false,
      strategy: 'auto_shadow',
    });
    const e = evaluateSwitchboard(ledger, 'mainnet', 10, true).find((x) => x.key === 'always_up@t50s')!;
    expect(e.recentCaptured).toEqual([0, 1]);
  });

  it('has no cap on how many strategies run, and scopes them to their checkpoint', () => {
    batch(1, 50, 45, { mom1m: 0.01, mom5m: 0.01, mom15m: 0.01 });
    const board = evaluateSwitchboard(ledger, 'mainnet', 10, true);
    const on = enabledAt(board, 't50s').map((e) => e.signal);
    expect(on).toEqual(expect.arrayContaining(['always_up', 'mom_1m_follow', 'mom_5m_follow', 'mom_15m_follow']));
    expect(enabledAt(board, 't30s')).toHaveLength(0);
  });
});

import {
  HARVEST_KEY,
  SWITCHBOARD,
  binomialLowerTail,
  strategyStop,
  switchboardRealized24h,
} from '../src/strategy/switchboard.js';

describe('harvest v2 on the switchboard', () => {
  let tmp: string;
  let ledger: LedgerStore;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-sbh-'));
    ledger = new LedgerStore(path.join(tmp, 'svx.sqlite'));
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  let n = 0;
  const trade = (strategy: string, mode: 'paper' | 'live', tsMs: number, won: boolean, costUsdc = 4) => {
    const oracleId = `o${n++}`;
    ledger.insertTrade({
      signalId: strategy === 'calibration_harvest' ? 'harvest_v2' : 'fade_spike@t50s',
      timestampMs: tsMs,
      mode,
      oracleId,
      underlyingAsset: 'BTC',
      expiryMs: tsMs + 60_000,
      strike: 100,
      direction: 'up',
      quantityDusdc: 5,
      costPrice: 0.8,
      costUsdc,
      settled: false,
      strategy: strategy as never,
    });
    ledger.settleTradesForOracle(oracleId, won ? 101 : 99, tsMs + 60_000);
  };

  it('rings the results we actually traded live', () => {
    const now = Date.now();
    trade('fade_spike', 'live', now - 5 * 3600_000, false); // live trading starts here
    trade('calibration_harvest', 'paper', now - 4 * 3600_000, true);
    trade('calibration_harvest', 'live', now - 3 * 3600_000, true);
    const e = evaluateSwitchboard(ledger, 'mainnet', now, true).find((x) => x.key === HARVEST_KEY)!;
    expect(e.recent).toEqual([1, 1]);
    expect(e.recentCaptured).toEqual([0, 1]);
    // Each result is stamped with when it was known (the trade settled).
    expect(e.recentAtMs).toEqual([now - 4 * 3600_000 + 60_000, now - 3 * 3600_000 + 60_000]);
  });

  it('scores harvest only from its trades since the first live switchboard trade', () => {
    const now = Date.now();
    trade('calibration_harvest', 'paper', now - 10 * 3600_000, false); // before live start: ignored
    trade('fade_spike', 'live', now - 5 * 3600_000, false); // live trading starts here
    for (let i = 0; i < 50; i++) trade('calibration_harvest', 'paper', now - 4 * 3600_000 + i, true);
    const e = evaluateSwitchboard(ledger, 'mainnet', now, true).find((x) => x.key === HARVEST_KEY)!;
    expect(e.n).toBe(50);
    expect(e.pnlPerContract).toBeCloseTo(1 - 4 / 5); // won $5 on $4 each: +20¢ per contract
    expect(e.status).toBe('on');
  });

  it("counts harvest's live losses toward the daily stop, never its paper ones", () => {
    const now = Date.now();
    trade('calibration_harvest', 'paper', now - 3600_000, false);
    trade('calibration_harvest', 'live', now - 3600_000, false, 3);
    trade('fade_spike', 'live', now - 3600_000, false, 2);
    expect(switchboardRealized24h(ledger, now)).toBeCloseTo(-5);
  });
});

describe('switchboard stops', () => {
  let tmp: string;
  let ledger: LedgerStore;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-sbs-'));
    ledger = new LedgerStore(path.join(tmp, 'svx.sqlite'));
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  let n = 0;
  const loss = (signalId: string, strategy: string, tsMs: number, costUsdc: number, mode: 'live' | 'paper' = 'live') => {
    const oracleId = `s${n++}`;
    ledger.insertTrade({
      signalId,
      timestampMs: tsMs,
      mode,
      oracleId,
      underlyingAsset: 'BTC',
      expiryMs: tsMs + 60_000,
      strike: 100,
      direction: 'up',
      quantityDusdc: 5,
      costPrice: 0.8,
      costUsdc,
      settled: false,
      strategy: strategy as never,
    });
    ledger.settleTradesForOracle(oracleId, 99, tsMs + 60_000);
  };

  it('stops a line at −$15 without stopping the others', () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) loss('fade_spike@t50s', 'fade_spike', now - 3600_000 + i, 4); // −$16
    expect(strategyStop(ledger, now, 'fade_spike@t50s', 0.3)).toBe('line_daily_loss_limit');
    expect(strategyStop(ledger, now, 'vol_model@t65s', 0.6)).toBeNull();
  });

  it('never dollar-stops a long-shot clip on its line', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) loss('longshot_12c@t50s', 'auto_shadow', now - 3600_000 + i, 3.8); // −$19
    expect(strategyStop(ledger, now, 'longshot_12c@t50s', 0.08)).toBeNull();
  });

  it('stops everything, long shots included, at the account limit', () => {
    const now = Date.now();
    for (let i = 0; i < 8; i++) loss(`line${i}@t50s`, 'fade_spike', now - 3600_000 + i, 4); // −$32 over 8 lines
    expect(SWITCHBOARD.accountDailyLossLimitUsd).toBe(30);
    expect(strategyStop(ledger, now, 'longshot_12c@t50s', 0.08)).toBe('account_daily_loss_limit');
    expect(strategyStop(ledger, now, 'vol_model@t65s', 0.6)).toBe('account_daily_loss_limit');
  });

  it("stops harvest on its own live losses only", () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) loss('harvest_v2', 'calibration_harvest', now - 3600_000 + i, 4, 'paper');
    expect(strategyStop(ledger, now, HARVEST_KEY, 0.86)).toBeNull();
    for (let i = 0; i < 4; i++) loss('harvest_v2', 'calibration_harvest', now - 3600_000 + i, 4);
    expect(strategyStop(ledger, now, HARVEST_KEY, 0.86)).toBe('line_daily_loss_limit');
  });

  it('computes the binomial lower tail', () => {
    expect(binomialLowerTail(13, 0, 0.17)).toBeCloseTo(0.83 ** 13, 10);
    expect(binomialLowerTail(10, 10, 0.3)).toBe(1);
    expect(binomialLowerTail(2, 1, 0.5)).toBeCloseTo(0.75, 10);
  });
});
