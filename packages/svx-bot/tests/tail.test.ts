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
import { estimateBoundaryCost } from '../src/pricing/predict-sdk.js';

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

  it('tail buys the cheapest admitted rung on each side; tail_hot only when realized vol runs hot', () => {
    expect(tailPicks('tail', payload(), 120_000).map((q) => [q.direction, q.target])).toEqual([
      ['up', 0.06],
      ['down', 0.06],
    ]);
    // A market that admits only 10¢+: the 10¢ rung is taken.
    const floor10 = payload({ quotes: payload().quotes.filter((q) => q.target >= 0.1) });
    expect(tailPicks('tail', floor10, 120_000).map((q) => [q.direction, q.target])).toEqual([['up', 0.1]]);
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

describe('per-boundary admission', () => {
  const fees = {
    baseFee: 204_000_000n,
    minFee: 22_000_000n,
    expiryFeeWindowMs: 60_000n,
    expiryFeeMaxMultiplier: 3_000_000_000n,
    minEntryProbability: 100_000_000n, // 10¢
    maxEntryProbability: 900_000_000n, // 90¢
    inventoryImpactMaxRate: 0n,
    inventoryImpactScale: 10_000_000_000n,
    backingBufferLambda: 310_000_000n,
  } as never;
  const quote = (lowerUp: number | null, higherUp: number | null) =>
    estimateBoundaryCost({ fees, expiryMs: Date.now() + 120_000, nowMs: Date.now(), lowerUp, higherUp, quantity: 100 });

  it('refuses a range whose total is fine but one end sits outside the band (as the chain does)', () => {
    expect(quote(0.73, 0.27)).not.toBeNull(); // both ends inside 10–90¢
    expect(quote(0.999, 0.4)).toBeNull(); // lower end 99.9¢: refused on-chain, 2026-09-29
    expect(quote(0.6, 0.001)).toBeNull(); // upper end 0.1¢
    expect(quote(0.12, null)).not.toBeNull(); // a 12¢ up tail
    expect(quote(0.06, null)).toBeNull(); // a 6¢ tail under a 10¢ floor
  });
});

import {
  burstRatio,
  clockSdFactor,
  edgeSwitchScores,
  MINUTE_OF_HOUR_VARIANCE,
  type VolRegimePayload,
} from '../src/ops/edge-trackers.js';
import { evaluateSwitchboard, PAPER_ONLY_SIGNALS } from '../src/strategy/switchboard.js';

describe('paper lines from the 2026-09-29 vol-shape analysis', () => {
  it('clock factor: the quiet top of the hour shrinks the sd, the loud turn of the hour grows it', () => {
    const at = (h: number, m: number, s = 0) => Date.UTC(2026, 8, 29, h, m, s);
    const lastThree = Math.sqrt((0.65 + 0.62 + 0.49) / 3);
    expect(clockSdFactor(at(10, 57), at(11, 0))).toBeCloseTo(lastThree, 6);
    expect(clockSdFactor(at(11, 0), at(11, 2))).toBeCloseTo(Math.sqrt((1.25 + 1.1) / 2), 6);
    expect(clockSdFactor(at(11, 0), at(12, 0))).toBeCloseTo(
      Math.sqrt(MINUTE_OF_HOUR_VARIANCE.reduce((a, x) => a + x, 0) / 60),
      6,
    );
  });

  it('tail_burst buys only when the last 2 minutes run ≥ 1.2× the last hour', () => {
    expect(tailPicks('tail_burst', payload(), 120_000)).toEqual([]); // no burst data (old rows)
    expect(burstRatio({ rv2: 3, rv60: 2 })).toBeCloseTo(1.5);
    expect(tailPicks('tail_burst', payload({ rv2: 3, rv60: 2 }), 120_000)).toHaveLength(2);
    expect(tailPicks('tail_burst', payload({ rv2: 2, rv60: 2 }), 120_000)).toEqual([]);
  });

  it('scores vol_clock beside vol_model, off the same rows', () => {
    const vol = (settle: number): EdgeProbeRow<VolRegimePayload> => ({
      marketId: '0xv',
      slot: 't2m',
      expiryMs: Date.UTC(2026, 8, 29, 11, 0),
      recordedAtMs: Date.UTC(2026, 8, 29, 10, 58),
      ttmMs: 120_000,
      settlementPrice: settle,
      payload: {
        forward: 100_000,
        reference: 100_000,
        rv15: 0.5,
        rv5: 0.5,
        chainSdUsd: 50,
        candidates: [{ name: 'W25', lower: 99_987, upper: 100_012, prob: 0.2, cost: 0.4 }],
      },
    });
    const keys = edgeSwitchScores([], [vol(100_005), vol(100_050)]).map((s) => `${s.signal}@${s.slot}`);
    expect(keys).toEqual(expect.arrayContaining(['vol_model@t2m', 'vol_clock@t2m']));
  });

  it('marks the new lines paper-only on the switchboard', () => {
    expect([...PAPER_ONLY_SIGNALS].sort()).toEqual(['tail_burst']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-paper-'));
    const l = new LedgerStore(path.join(dir, 'l.sqlite'));
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      l.insertEdgeProbe({
        id: `tail:0x${i}:t2m`,
        network: 'mainnet',
        kind: 'tail',
        marketId: `0x${i}`,
        slot: 't2m',
        expiryMs: now - 60_000 + i,
        recordedAtMs: now - 180_000 + i,
        ttmMs: 120_000,
        payload: payload({ rv2: 3, rv60: 2 }),
      });
      l.resolveEdgeProbeMarket(`0x${i}`, 100_200, now);
    }
    const board = evaluateSwitchboard(l, 'mainnet', now, true);
    expect(board.find((e) => e.key === 'tail_burst@t2m')?.paperOnly).toBe(true);
    expect(board.find((e) => e.key === 'tail@t2m')?.paperOnly).toBeUndefined();
    l.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
