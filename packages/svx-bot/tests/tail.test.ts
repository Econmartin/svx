import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore, type EdgeProbeRow } from '../src/ledger/store.js';
import { normalCdf } from '../src/pricing/bs.js';
import {
  TAIL_HOT_RATIO,
  tailPicks,
  tailStrike,
  tailSwitchScores,
  type TailPayload,
} from '../src/ops/edge-trackers.js';
import { runTailTrade } from '../src/index.js';
import { strategyTagFor, type SwitchEntry } from '../src/strategy/switchboard.js';

// A chain whose UP digital is N(100_000, $50) — 6¢ tails sit ~1.55σ out.
const F = 100_000;
const up = (k: number) => 1 - normalCdf((k - F) / 50);

const payload = (over: Partial<TailPayload> = {}): TailPayload => ({
  forward: F,
  reference: F,
  rv15: 2, // $/√s: scaled over 120s ≈ $29.6, vs chain sd $50 → ratio ≈ 0.59 (cool)
  rv5: null,
  chainSdUsd: 50,
  quotes: [
    { direction: 'up', target: 0.06, strike: 100_078, prob: 0.06, cost: 0.105 },
    { direction: 'down', target: 0.06, strike: 99_922, prob: 0.06, cost: 0.105 },
    { direction: 'up', target: 0.1, strike: 100_064, prob: 0.1, cost: 0.15 },
    { direction: 'down', target: 0.06, strike: 99_990, prob: 0.015, cost: 0.041 }, // below the bot's 2¢ band
  ],
  ...over,
});
const row = (settle: number, market = '0xm', p = payload()): EdgeProbeRow<TailPayload> => ({
  marketId: market,
  slot: 't2m',
  expiryMs: 1_000,
  recordedAtMs: 0,
  ttmMs: 120_000,
  settlementPrice: settle,
  payload: p,
});

describe('tail tracker', () => {
  it('finds the grid strike whose side pays at the target', () => {
    const k = tailStrike(up, F, 'up', 0.06, 1, 1_000)!;
    expect(k).toBe(Math.round(F + 50 * 1.5548));
    expect(up(k)).toBeCloseTo(0.06, 2);
    const d = tailStrike(up, F, 'down', 0.06, 1, 1_000)!;
    expect(1 - up(d)).toBeCloseTo(0.06, 2);
    expect(tailStrike(up, F, 'up', 0.06, 1, 50)).toBeNull(); // span too short to reach 6¢
  });

  it('tail buys both 6¢ sides; tail_hot only when realized vol runs hot', () => {
    expect(tailPicks('tail', payload(), 120_000).map((q) => q.direction)).toEqual(['up', 'down']);
    expect(tailPicks('tail_hot', payload(), 120_000)).toEqual([]);
    const hot = payload({ rv15: 5 }); // ≈ 1.48 ≥ TAIL_HOT_RATIO
    expect(TAIL_HOT_RATIO).toBeLessThan(1.48);
    expect(tailPicks('tail_hot', hot, 120_000)).toHaveLength(2);
  });

  it('scores each side as a decision: a big move wins one side, a quiet market loses both', () => {
    const scores = tailSwitchScores([row(100_200, '0xa'), row(100_010, '0xb')]);
    const s = scores.find((x) => x.signal === 'tail' && x.slot === 't2m')!;
    expect(s.n).toBe(4);
    expect(s.hitRate).toBeCloseTo(0.25);
    expect(s.pnlPerContract).toBeCloseTo(0.25 - 0.105);
    expect(scores.find((x) => x.signal === 'tail_hot')).toBeUndefined(); // no hot rows
    expect(strategyTagFor('tail')).toBe('edge_vol');
    expect(strategyTagFor('tail_hot')).toBe('edge_vol');
  });
});

describe('tail executor', () => {
  let dir: string;
  let ledger: LedgerStore;
  const prev = process.env.SVX_TAIL_LIVE;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-tail-'));
    ledger = new LedgerStore(path.join(dir, 'l.sqlite'));
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev == null) delete process.env.SVX_TAIL_LIVE;
    else process.env.SVX_TAIL_LIVE = prev;
  });
  const on = (key: string): SwitchEntry[] => [
    { key, signal: key.split('@')[0]!, slot: key.split('@')[1]!, n: 60, pnlPerContract: 0.1, recent: [], streak: 0, recentPnl: 0, status: 'on', sinceMs: 0 },
  ];
  const event = () => ({
    market: { id: '0xt', expiryMs: Date.now() + 120_000, tickSize: 0.01, admissionTickSize: 1, mintPaused: false, referencePrice: F },
    slot: 't2m',
    ttmMs: 120_000,
    payload: payload(),
  });
  const deps = (switchboard: SwitchEntry[]) => ({ ledger, cfg: { paperTrading: true } as never, live: undefined, switchboard });

  it('books nothing until SVX_TAIL_LIVE is on, even when the line is green', async () => {
    delete process.env.SVX_TAIL_LIVE;
    await runTailTrade(event(), deps(on('tail@t2m')));
    expect(ledger.openTrades()).toHaveLength(0);
  });

  it('once enabled, buys both sides at their own strikes, once each', async () => {
    process.env.SVX_TAIL_LIVE = 'true';
    await runTailTrade(event(), deps(on('tail@t2m')));
    await runTailTrade(event(), deps(on('tail@t2m'))); // same market again: no repeat
    const open = ledger.openTrades().sort((a, b) => a.strike - b.strike);
    expect(open.map((t) => [t.direction, t.strike, t.signalId])).toEqual([
      ['down', 99_922, 'tail@t2m'],
      ['up', 100_078, 'tail@t2m'],
    ]);
    ledger.settleTradesForOracle('0xt', 100_200, Date.now());
    const won = ledger.closedTrades().filter((t) => (t.payoutUsdc ?? 0) > 0);
    expect(won.map((t) => t.direction)).toEqual(['up']);
  });

  it('does nothing while the line is off', async () => {
    process.env.SVX_TAIL_LIVE = 'true';
    await runTailTrade(event(), deps([]));
    expect(ledger.openTrades()).toHaveLength(0);
  });
});
