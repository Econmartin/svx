/**
 * Shared backtest engine (ops/backtest.ts) — the same code path serves the
 * CLI (scripts/backtest.ts) and GET /backtest, so these tests guard both.
 */

import { describe, it, expect } from 'vitest';
import { computeBacktest, type BacktestSignalRow } from '../src/ops/backtest.js';

const sig = (over: Partial<BacktestSignalRow>): BacktestSignalRow => ({
  tsMs: 1_700_000_000_000,
  oracleId: 'o1',
  strike: 60_000,
  predictDirection: 'down',
  predictProb: 0.76, // P(up) — predict FAVORS up; hedge-side mint is 'down'
  polyProb: 0.68,
  spread: 0.08,
  ...over,
});

const ARGS = { threshold: 0.08, side: 'predict' as const, dedupe: false, fee: 0, notional: 1 };

describe('computeBacktest', () => {
  it('default bets predict_direction at that side\'s cost', () => {
    const { trades } = computeBacktest(
      [sig({})],
      new Map([['o1', 61_000]]), // settle above strike → up won → 'down' loses
      ARGS,
    );
    expect(trades[0]!.direction).toBe('down');
    expect(trades[0]!.costPrice).toBeCloseTo(1 - 0.76, 10);
    expect(trades[0]!.outcome).toBe('loss');
  });

  it('flip bets the favored side at the complementary cost', () => {
    const { trades } = computeBacktest(
      [sig({})],
      new Map([['o1', 61_000]]),
      { ...ARGS, side: 'flip' as const },
    );
    expect(trades[0]!.direction).toBe('up');
    expect(trades[0]!.costPrice).toBeCloseTo(0.76, 10);
    expect(trades[0]!.outcome).toBe('win');
    expect(trades[0]!.pnl).toBeCloseTo(1 - 0.76, 10);
  });

  it('default and flip are exact complements on the same signal set', () => {
    const signals = [
      sig({ oracleId: 'o1' }),
      sig({ oracleId: 'o2', predictDirection: 'up', predictProb: 0.3 }),
    ];
    const settlements = new Map([
      ['o1', 61_000],
      ['o2', 59_000],
    ]);
    const a = computeBacktest(signals, settlements, ARGS).summary;
    const b = computeBacktest(signals, settlements, { ...ARGS, side: 'flip' as const }).summary;
    expect(a.wins).toBe(b.losses);
    expect(a.losses).toBe(b.wins);
    // costs are complementary per trade at fee=0
    expect(a.total_cost_usdc + b.total_cost_usdc).toBeCloseTo(signals.length, 6);
  });

  it('favored bets the >50¢ side regardless of predict_direction', () => {
    const signals = [
      // predict_direction 'down' but Predict favors up (0.76) → favored bets up
      sig({ oracleId: 'o1' }),
      // predict_direction 'up' and Predict favors up (0.55) → favored bets up too
      sig({ oracleId: 'o2', predictDirection: 'up', predictProb: 0.55 }),
      // Predict favors down (P(up)=0.2) → favored bets down
      sig({ oracleId: 'o3', predictDirection: 'up', predictProb: 0.2 }),
    ];
    const settlements = new Map([
      ['o1', 61_000], // up won
      ['o2', 61_000], // up won
      ['o3', 59_000], // down won
    ]);
    const { trades } = computeBacktest(signals, settlements, {
      ...ARGS,
      side: 'favored' as const,
    });
    expect(trades.map((t) => t.direction)).toEqual(['up', 'up', 'down']);
    // Cost is always the favored side's price — never below 0.5.
    expect(trades.map((t) => t.costPrice)).toEqual([0.76, 0.55, 0.8]);
    expect(trades.every((t) => t.outcome === 'win')).toBe(true);
  });

  it('favored matches flip when predict_direction is the hedge side, and predict when it is the favored side', () => {
    const hedgeSideSignal = sig({}); // dir 'down', P(up)=0.76 → favored=up=flip
    const favoredSideSignal = sig({ predictDirection: 'up', predictProb: 0.74 }); // favored=up=predict
    const settlements = new Map([['o1', 61_000]]);
    const fav1 = computeBacktest([hedgeSideSignal], settlements, { ...ARGS, side: 'favored' as const }).trades[0]!;
    const flip1 = computeBacktest([hedgeSideSignal], settlements, { ...ARGS, side: 'flip' as const }).trades[0]!;
    expect(fav1.direction).toBe(flip1.direction);
    expect(fav1.costPrice).toBe(flip1.costPrice);
    const fav2 = computeBacktest([favoredSideSignal], settlements, { ...ARGS, side: 'favored' as const }).trades[0]!;
    const pred2 = computeBacktest([favoredSideSignal], settlements, ARGS).trades[0]!;
    expect(fav2.direction).toBe(pred2.direction);
    expect(fav2.costPrice).toBe(pred2.costPrice);
  });

  it('dedupe keeps only the first observation per (oracle, strike, direction)', () => {
    const signals = [
      sig({ tsMs: 1, spread: 0.09 }),
      sig({ tsMs: 2, spread: 0.10 }), // same key — dropped
      sig({ tsMs: 3, oracleId: 'o2' }), // different oracle — kept
      sig({ tsMs: 4, predictDirection: 'up', predictProb: 0.3 }), // different dir — kept
    ];
    const { summary } = computeBacktest(signals, new Map(), { ...ARGS, dedupe: true });
    expect(summary.would_fire).toBe(3);
    expect(summary.still_open).toBe(3); // no settlements provided
  });

  it('fee marks up the cost price', () => {
    const { trades } = computeBacktest([sig({})], new Map([['o1', 59_000]]), {
      ...ARGS,
      fee: 0.02,
    });
    expect(trades[0]!.costPrice).toBeCloseTo((1 - 0.76) * 1.02, 10);
    expect(trades[0]!.outcome).toBe('win'); // settle below strike → down won
  });

  it('threshold excludes sub-threshold signals', () => {
    const { summary } = computeBacktest(
      [sig({ spread: 0.079 }), sig({ oracleId: 'o2', spread: 0.081 })],
      new Map(),
      ARGS,
    );
    expect(summary.would_fire).toBe(1);
  });

  it('handles large signal arrays without stack overflow (data_window)', () => {
    const signals: BacktestSignalRow[] = [];
    for (let i = 0; i < 300_000; i++) signals.push(sig({ tsMs: i, spread: 0.01 }));
    const { summary } = computeBacktest(signals, new Map(), ARGS);
    expect(summary.data_window.firstTsIso).toBe(new Date(0).toISOString());
    expect(summary.data_window.lastTsIso).toBe(new Date(299_999).toISOString());
  });
});
