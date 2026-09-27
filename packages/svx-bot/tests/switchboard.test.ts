import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore, type ShadowDecisionInput } from '../src/ledger/store.js';
import { enabledAt, evaluateSwitchboard } from '../src/strategy/switchboard.js';

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

  it('switches on at the first green average and off when it turns red, then back', () => {
    // always_up at 60c all-in: one win → +40c/contract → green.
    ledger.insertShadowDecision(d(1));
    settle(1, true);
    expect(status('always_up@t50s', 10)).toBe('on');
    expect(status('always_down@t50s', 10)).toBe('off'); // lost that one
    // One loss: average (1 − 0.6 + 0 − 0.6) / 2 = −10c → red → off.
    ledger.insertShadowDecision(d(2));
    settle(2, false);
    expect(status('always_up@t50s', 20)).toBe('off');
    // Two more wins: (0.4 − 0.6 + 0.4 + 0.4) / 4 = +15c → green → on again.
    for (const i of [3, 4]) {
      ledger.insertShadowDecision(d(i));
      settle(i, true);
    }
    expect(status('always_up@t50s', 30)).toBe('on');
  });

  it('needs more than +2c to switch on, then stays on until it is losing', () => {
    // always_up at 97c all-in: each win nets +3c, each loss −97c.
    const at = (i: number, up: boolean) => {
      ledger.insertShadowDecision(d(i, { costUp: 0.97 }));
      settle(i, up);
    };
    at(1, true); // +3c → above +2c → on
    expect(status('always_up@t50s', 10)).toBe('on');
    // Nudge the average into (0, +2c): still on (hysteresis).
    // (mom_1m_follow first sees data on this row: its only decision, +0.5c.)
    ledger.insertShadowDecision(d(2, { costUp: 0.995, mom1m: 0.01 })); // +0.5c win
    settle(2, true);
    expect(status('always_up@t50s', 20)).toBe('on'); // avg +1.75c: stays on
    // Never been on and only +0.5c: below the +2c bar, so it stays off.
    expect(status('mom_1m_follow@t50s', 20)).toBe('off');
  });

  it('has no cap on how many strategies run, and scopes them to their checkpoint', () => {
    ledger.insertShadowDecision(d(1, { mom1m: 0.01, mom5m: 0.01, mom15m: 0.01 }));
    settle(1, true);
    const board = evaluateSwitchboard(ledger, 'mainnet', 10, true);
    const on = enabledAt(board, 't50s').map((e) => e.signal);
    expect(on).toEqual(expect.arrayContaining(['always_up', 'mom_1m_follow', 'mom_5m_follow', 'mom_15m_follow']));
    expect(enabledAt(board, 't30s')).toHaveLength(0);
  });
});

import { HARVEST_KEY, switchboardRealized24h } from '../src/strategy/switchboard.js';

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

  it('scores harvest only from its trades since the first live switchboard trade', () => {
    const now = Date.now();
    trade('calibration_harvest', 'paper', now - 10 * 3600_000, false); // before live start: ignored
    trade('fade_spike', 'live', now - 5 * 3600_000, false); // live trading starts here
    for (let i = 0; i < 4; i++) trade('calibration_harvest', 'paper', now - 4 * 3600_000 + i, true);
    const e = evaluateSwitchboard(ledger, 'mainnet', now, true).find((x) => x.key === HARVEST_KEY)!;
    expect(e.n).toBe(4);
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
