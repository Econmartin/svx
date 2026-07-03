/**
 * Tests for the expiry-convergence decision math (strategy/convergence.ts).
 * Pure functions — no ledger, no network.
 */

import { describe, it, expect } from 'vitest';
import { decideConvergence, sigmaDistance } from '../src/strategy/convergence.js';

const cfg = {
  convergenceMaxMinutes: 90,
  convergenceMinMinutes: 5,
  convergenceMinSigma: 4,
  convergenceMinPrice: 0.9,
  convergenceMaxPrice: 0.97,
  convergenceMinEvFrac: 0.02,
};

// 30 minutes in years — the typical hold for a BTC daily entered late.
const T30M = 0.5 / (365.25 * 24);

describe('sigmaDistance', () => {
  it('grows with distance from strike and shrinks with vol/time', () => {
    const near = sigmaDistance(60_000, 59_500, 0.4, T30M);
    const far = sigmaDistance(60_000, 54_000, 0.4, T30M);
    expect(far).toBeGreaterThan(near);
    const calmer = sigmaDistance(60_000, 59_500, 0.2, T30M);
    expect(calmer).toBeGreaterThan(near); // lower vol → same gap is more sigmas
  });

  it('returns 0 on degenerate inputs', () => {
    expect(sigmaDistance(0, 60_000, 0.4, T30M)).toBe(0);
    expect(sigmaDistance(60_000, 60_000, 0, T30M)).toBe(0);
    expect(sigmaDistance(60_000, 60_000, 0.4, 0)).toBe(0);
  });
});

describe('decideConvergence', () => {
  it('enters the YES side when spot is far above strike at a 90-97c ask', () => {
    // BTC $61.5k, strike $58k, 30 min left, 40% vol → ~19 sigma.
    const d = decideConvergence({
      spot: 61_500,
      strike: 58_000,
      sigmaAnnual: 0.4,
      tYears: T30M,
      itmAsk: 0.95,
      cfg,
    });
    expect(d.enter).toBe(true);
    expect(d.side).toBe('yes');
    expect(d.dSigma).toBeGreaterThan(4);
    expect(d.pCross).toBeLessThan(1e-4);
    expect(d.evFrac).toBeGreaterThan(0.04);
  });

  it('enters the NO side when spot is far below strike', () => {
    const d = decideConvergence({
      spot: 58_000,
      strike: 62_000,
      sigmaAnnual: 0.4,
      tYears: T30M,
      itmAsk: 0.94,
      cfg,
    });
    expect(d.enter).toBe(true);
    expect(d.side).toBe('no');
  });

  it('rejects when spot is too close to the strike in sigma terms', () => {
    // $60.3k vs $60k with 30 min at 40% vol is only ~1.3 sigma.
    const d = decideConvergence({
      spot: 60_300,
      strike: 60_000,
      sigmaAnnual: 0.4,
      tYears: T30M,
      itmAsk: 0.93,
      cfg,
    });
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/too_close/);
  });

  it('stands down when the market prices real doubt despite the sigma gate', () => {
    const d = decideConvergence({
      spot: 61_500,
      strike: 58_000,
      sigmaAnnual: 0.4,
      tYears: T30M,
      itmAsk: 0.7, // crowd says 30% doubt — trust it, skip
      cfg,
    });
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/market_disagrees/);
  });

  it('rejects when there is no meat left above maxPrice', () => {
    const d = decideConvergence({
      spot: 61_500,
      strike: 58_000,
      sigmaAnnual: 0.4,
      tYears: T30M,
      itmAsk: 0.985,
      cfg,
    });
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/no_meat/);
  });

  it('rejects without realized vol rather than guessing', () => {
    const d = decideConvergence({
      spot: 61_500,
      strike: 58_000,
      sigmaAnnual: NaN,
      tYears: T30M,
      itmAsk: 0.95,
      cfg,
    });
    expect(d.enter).toBe(false);
    expect(d.reason).toBe('no_realized_vol');
  });

  it('rejects when EV after tail risk is below the minimum', () => {
    // Ask 0.96 leaves 4 points; with a modest 4.2-sigma distance the tail
    // eats little, but a tighter min EV can still reject.
    const d = decideConvergence({
      spot: 61_500,
      strike: 58_000,
      sigmaAnnual: 0.4,
      tYears: T30M,
      itmAsk: 0.965,
      cfg: { ...cfg, convergenceMinEvFrac: 0.05 },
    });
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/ev_below_min/);
  });
});
