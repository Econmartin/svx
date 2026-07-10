/**
 * Divergence-mint decision module — the favored-side strategy validated at
 * 94% win / +11.9% ROI (May 2026) and ~87.5% / +18% (July 2026) by the
 * side=favored backtest. These tests pin the gates so live behavior stays
 * comparable to the backtest population.
 */

import { describe, it, expect } from 'vitest';
import {
  decideDivergenceMint,
  decideFavoredMint,
  type DivergenceMintCfg,
  type FavoredMintGates,
} from '../src/strategy/divergence-mint.js';

const cfg: DivergenceMintCfg = {
  divergenceMintThreshold: 0.08,
  divergenceMintMaxCostPrice: 0.95,
  divergenceMintNotionalDusdc: 5,
  divergenceMintMaxOpen: 10,
  divergenceMintDailyLossLimitDusdc: 20,
};

const base = {
  predictUp: 0.76,
  divergence: 0.09,
  expiryMs: 2_000,
  nowMs: 1_000,
  hasOpenForSignal: false,
  openStrategyCount: 0,
  dailyStrategyPnlUsdc: 0,
  cfg,
};

describe('decideDivergenceMint', () => {
  it('bets the favored side at its own cost — up when P(up) ≥ 0.5', () => {
    const d = decideDivergenceMint(base);
    expect(d.enter).toBe(true);
    expect(d.direction).toBe('up');
    expect(d.costPrice).toBeCloseTo(0.76, 10);
  });

  it('bets down when Predict favors down', () => {
    const d = decideDivergenceMint({ ...base, predictUp: 0.22 });
    expect(d.enter).toBe(true);
    expect(d.direction).toBe('down');
    expect(d.costPrice).toBeCloseTo(0.78, 10);
  });

  it('rejects below the divergence threshold', () => {
    const d = decideDivergenceMint({ ...base, divergence: 0.079 });
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/^sub_threshold/);
  });

  it('rejects when the favorite is too rich to pay for', () => {
    const d = decideDivergenceMint({ ...base, predictUp: 0.96 });
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/^too_rich/);
  });

  it('dedupes — one bet per (oracle, strike)', () => {
    const d = decideDivergenceMint({ ...base, hasOpenForSignal: true });
    expect(d.enter).toBe(false);
    expect(d.reason).toBe('already_open_for_signal');
  });

  it('respects the open-position cap', () => {
    const d = decideDivergenceMint({ ...base, openStrategyCount: 10 });
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/^max_open/);
  });

  it('stands down at the daily loss limit', () => {
    const d = decideDivergenceMint({ ...base, dailyStrategyPnlUsdc: -20 });
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/^daily_loss_limit/);
  });

  it('rejects expired oracles and degenerate probabilities', () => {
    expect(decideDivergenceMint({ ...base, expiryMs: 999 }).enter).toBe(false);
    expect(decideDivergenceMint({ ...base, predictUp: 0 }).enter).toBe(false);
    expect(decideDivergenceMint({ ...base, predictUp: 1 }).enter).toBe(false);
    expect(decideDivergenceMint({ ...base, predictUp: NaN }).enter).toBe(false);
  });

  it('a 50/50 favorite still resolves to a side (up) and can enter', () => {
    const d = decideDivergenceMint({ ...base, predictUp: 0.5 });
    expect(d.direction).toBe('up');
    expect(d.costPrice).toBeCloseTo(0.5, 10);
    expect(d.enter).toBe(true);
  });
});

describe('calibration harvest (complement band)', () => {
  const { cfg: _cfg, ...noCfg } = base;
  const harvestGates: FavoredMintGates = {
    minDivergence: 0,
    maxDivergenceExclusive: 0.08, // = divergenceMintThreshold
    maxCostPrice: 0.9,
    maxOpen: 10,
    dailyLossLimitDusdc: 20,
  };

  it('takes the sub-threshold band the mint refuses', () => {
    const input = { ...noCfg, divergence: 0.03 };
    const harvest = decideFavoredMint(input, harvestGates, 'calibration_harvest');
    expect(harvest.enter).toBe(true);
    expect(harvest.reason).toMatch(/^calibration_harvest/);
    const mint = decideDivergenceMint({ ...input, cfg });
    expect(mint.enter).toBe(false);
  });

  it('refuses the mint band — the bands are disjoint', () => {
    const input = { ...noCfg, divergence: 0.09 };
    const harvest = decideFavoredMint(input, harvestGates, 'calibration_harvest');
    expect(harvest.enter).toBe(false);
    expect(harvest.reason).toMatch(/^above_band/);
    expect(decideDivergenceMint({ ...input, cfg }).enter).toBe(true);
  });

  it('every divergence value is claimed by exactly one band', () => {
    for (const div of [0, 0.02, 0.0799, 0.08, 0.12, 0.5]) {
      const input = { ...noCfg, divergence: div, predictUp: 0.75 };
      const h = decideFavoredMint(input, harvestGates, 'calibration_harvest').enter;
      const m = decideDivergenceMint({ ...input, cfg }).enter;
      expect(h !== m).toBe(true); // XOR — never both, never neither
    }
  });

  it('applies the tighter 90¢ cap', () => {
    const d = decideFavoredMint(
      { ...noCfg, divergence: 0.03, predictUp: 0.92 },
      harvestGates,
      'calibration_harvest',
    );
    expect(d.enter).toBe(false);
    expect(d.reason).toMatch(/^too_rich/);
  });
});
