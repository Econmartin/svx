/**
 * Range-ladder — pricing, ladder construction, settlement rule, and the
 * vault simulator. Flat surface (b=0 → w(k)=a) keeps expectations exact.
 */

import { describe, it, expect } from 'vitest';
import {
  buildLadder,
  rangeFairPrice,
  rangePays,
  upAtStrike,
  type LadderCfg,
} from '../src/strategy/range-ladder.js';
import { computeRangeSim } from '../src/ops/range-sim.js';

const F = 60_000;
// Flat total variance w = 0.0004 → 1σ price move = F·√w = $1,200.
const FLAT = { a: 0.0004, b: 0, rho: 0, m: 0, sigma: 0.1 };
const T = 1 / (365.25 * 24); // 1 hour, arbitrary — flat w is T-independent
const SIGMA_MOVE = F * Math.sqrt(0.0004); // 1200

const cfg = (over: Partial<LadderCfg> = {}): LadderCfg => ({
  policy: 'sigma',
  rungs: 5,
  widthZ: 1,
  widthBps: 25,
  minRungPrice: 0.0,
  maxRungPrice: 1.0,
  ...over,
});

describe('range pricing', () => {
  it('digital P_up is decreasing in strike', () => {
    expect(upAtStrike(F - 1000, F, FLAT)).toBeGreaterThan(upAtStrike(F, F, FLAT));
    expect(upAtStrike(F, F, FLAT)).toBeGreaterThan(upAtStrike(F + 1000, F, FLAT));
  });

  it('adjacent ranges + tails partition probability ≈ 1', () => {
    const k1 = F - SIGMA_MOVE;
    const k2 = F + SIGMA_MOVE;
    const below = 1 - upAtStrike(k1, F, FLAT); // P(S ≤ k1)
    const mid = rangeFairPrice(k1, k2, F, FLAT);
    const above = upAtStrike(k2, F, FLAT);
    expect(below + mid + above).toBeCloseTo(1, 10);
    // ±1σ band on a normal ≈ 68%
    expect(mid).toBeGreaterThan(0.6);
    expect(mid).toBeLessThan(0.72);
  });
});

describe('buildLadder', () => {
  it('sigma policy: N adjacent rungs of 1σ width, ATM rung offset 0', () => {
    const rungs = buildLadder({ forward: F, svi: FLAT, tYears: T, cfg: cfg() });
    expect(rungs).toHaveLength(5);
    for (const r of rungs) {
      expect(r.higherStrike - r.lowerStrike).toBeCloseTo(SIGMA_MOVE, 6);
    }
    // adjacency
    for (let i = 1; i < rungs.length; i++) {
      expect(rungs[i]!.lowerStrike).toBeCloseTo(rungs[i - 1]!.higherStrike, 6);
    }
    const atm = rungs.find((r) => r.offset === 0)!;
    expect(rangePays(atm, F)).toBe(true);
    expect(rungs.map((r) => r.offset)).toEqual([-2, -1, 0, 1, 2]);
  });

  it('fixed_bps policy: width from bps of forward', () => {
    const rungs = buildLadder({
      forward: F,
      svi: FLAT,
      tYears: T,
      cfg: cfg({ policy: 'fixed_bps', widthBps: 50 }),
    });
    expect(rungs[0]!.higherStrike - rungs[0]!.lowerStrike).toBeCloseTo(F * 0.005, 6);
  });

  it('price band drops unpayable wings', () => {
    const rungs = buildLadder({
      forward: F,
      svi: FLAT,
      tYears: T,
      cfg: cfg({ rungs: 11, minRungPrice: 0.05 }),
    });
    // ±5σ wings priced ≈ 0 must be gone
    expect(rungs.length).toBeLessThan(11);
    for (const r of rungs) expect(r.fairPrice).toBeGreaterThanOrEqual(0.05);
  });
});

describe('rangePays — protocol band rule (lower, higher]', () => {
  const rung = { lowerStrike: 59_000, higherStrike: 60_000 };
  it('excludes the lower bound, includes the higher', () => {
    expect(rangePays(rung, 59_000)).toBe(false);
    expect(rangePays(rung, 59_000.01)).toBe(true);
    expect(rangePays(rung, 60_000)).toBe(true);
    expect(rangePays(rung, 60_000.01)).toBe(false);
  });
});

describe('computeRangeSim', () => {
  const row = (settle: number, oracleId = 'o1') => ({
    oracleId,
    tsMs: 1_700_000_000_000,
    expiryMs: 1_700_000_000_000 + 3600_000,
    forward: F,
    svi: FLAT,
    settlementPrice: settle,
  });

  it('settles the ATM rung as a hit when spot stays put', () => {
    const sim = computeRangeSim([row(F)], {
      policy: 'sigma',
      rungs: 5,
      widthZ: 1,
      widthBps: 25,
      fee: 0,
      notionalPerRung: 1,
      minRungPrice: 0,
      maxRungPrice: 1,
    });
    expect(sim.oracles_simulated).toBe(1);
    expect(sim.rungs_minted).toBe(5);
    expect(sim.total_payout_usdc).toBe(1); // exactly one rung contains settle
    const atm = sim.by_offset.find((b) => b.offset === 0)!;
    expect(atm.hits).toBe(1);
    // Total cost at fee 0 = sum of fair prices ≈ P(settle within ±2.5σ) < 1
    expect(sim.total_cost_usdc).toBeLessThan(1);
    expect(sim.total_cost_usdc).toBeGreaterThan(0.95); // ±2.5σ ≈ 98.8%
  });

  it('fee scales cost, not payout', () => {
    const noFee = computeRangeSim([row(F)], {
      policy: 'sigma', rungs: 3, widthZ: 1, widthBps: 25, fee: 0,
      notionalPerRung: 2, minRungPrice: 0, maxRungPrice: 1,
    });
    const withFee = computeRangeSim([row(F)], {
      policy: 'sigma', rungs: 3, widthZ: 1, widthBps: 25, fee: 0.02,
      notionalPerRung: 2, minRungPrice: 0, maxRungPrice: 1,
    });
    // summary fields are rounded to 4dp — compare at 3dp
    expect(withFee.total_cost_usdc).toBeCloseTo(noFee.total_cost_usdc * 1.02, 3);
    expect(withFee.total_payout_usdc).toBe(noFee.total_payout_usdc);
  });

  it('a big move pays a wing rung, not the center', () => {
    // 1.2σ sits mid-rung inside (+0.5σ, +1.5σ] — safely off any boundary.
    const sim = computeRangeSim([row(F + 1.2 * SIGMA_MOVE)], {
      policy: 'sigma', rungs: 5, widthZ: 1, widthBps: 25, fee: 0,
      notionalPerRung: 1, minRungPrice: 0, maxRungPrice: 1,
    });
    const hitBucket = sim.by_offset.find((b) => b.hits === 1)!;
    expect(hitBucket.offset).toBe(1);
  });
});
