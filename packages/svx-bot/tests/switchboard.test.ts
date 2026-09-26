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
