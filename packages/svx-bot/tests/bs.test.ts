/**
 * Black-Scholes binary pricing + IV inversion tests.
 *
 * Reference values produced by Python `math.erf` (full IEEE 754 precision).
 * Our TypeScript implementation uses the Abramowitz & Stegun erf approximation
 * (max error ~1.5e-7), so cross-impl tolerance is 1e-6. Round-trip tests
 * (price → IV → price using the *same* erf) hit 1e-9.
 *
 * Source script: docs/math-validation.md.
 */
import { describe, expect, it } from 'vitest';
import {
  binaryDownPrice,
  binaryUpFromTotalVariance,
  binaryUpPrice,
  invertIV,
  normalCdf,
} from '../src/pricing/bs.js';
import { evalTotalVariance } from '../src/pricing/svi.js';
import type { SVIParams } from 'svx-shared/types';

const A_AND_S_TOL = 1e-6;
const ROUND_TRIP_TOL = 1e-9;

const REF_PARAMS: SVIParams = { a: 0.04, b: 0.4, rho: -0.4, m: 0.0, sigma: 0.1 };
const F = 100_000;
const T = 0.0833;

const PREDICT_PATH_VECTORS: Array<{ K: number; w: number; up: number }> = [
  { K: 80_000, w: 0.173513433493, up: 0.628325077011 },
  { K: 95_000, w: 0.093162019448, up: 0.506158924555 },
  { K: 99_000, w: 0.081809564655, up: 0.457047925691 },
  { K: 100_000, w: 0.08, up: 0.443768541991 },
  { K: 101_000, w: 0.078605477503, up: 0.430275125518 },
  { K: 105_000, w: 0.076700616087, up: 0.376515700889 },
  { K: 120_000, w: 0.094006576926, up: 0.227245458131 },
];

describe('normalCdf', () => {
  it('matches known reference values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 8);
    expect(normalCdf(1)).toBeCloseTo(0.8413447461, 6);
    expect(normalCdf(-1)).toBeCloseTo(0.1586552539, 6);
    expect(normalCdf(2)).toBeCloseTo(0.9772498681, 6);
    expect(normalCdf(-3)).toBeCloseTo(0.0013498980, 6);
  });

  it('handles extreme inputs', () => {
    expect(normalCdf(20)).toBeCloseTo(1, 12);
    expect(normalCdf(-20)).toBeCloseTo(0, 12);
  });
});

describe('binaryUpFromTotalVariance (Predict on-chain path)', () => {
  for (const { K, w, up } of PREDICT_PATH_VECTORS) {
    it(`matches Predict at K=${K}`, () => {
      const got = binaryUpFromTotalVariance(K, F, w);
      expect(got).toBeCloseTo(up, 5);
    });
  }
});

describe('binaryUpPrice / binaryDownPrice', () => {
  it('UP + DOWN parity invariant: must sum to 1.0', () => {
    for (const sigma of [0.2, 0.6, 1.5]) {
      for (const K of [50_000, 100_000, 200_000]) {
        const u = binaryUpPrice(K, F, T, sigma);
        const d = binaryDownPrice(K, F, T, sigma);
        expect(u + d).toBeCloseTo(1, 12);
      }
    }
  });

  it('UP price is monotone non-increasing in strike', () => {
    const sigma = 0.6;
    let prev = 1;
    for (const K of [40_000, 60_000, 80_000, 100_000, 150_000, 200_000]) {
      const u = binaryUpPrice(K, F, T, sigma);
      expect(u).toBeLessThanOrEqual(prev + 1e-12);
      prev = u;
    }
  });

  it('w-form and σ-form agree (consistency check)', () => {
    const sigma = 0.6;
    const w = sigma * sigma * T;
    for (const K of [80_000, 100_000, 120_000]) {
      const a = binaryUpPrice(K, F, T, sigma);
      const b = binaryUpFromTotalVariance(K, F, w);
      expect(a).toBeCloseTo(b, 12);
    }
  });

  it('SVI-priced UP probability matches direct w-path', () => {
    for (const K of [80_000, 100_000, 120_000]) {
      const k = Math.log(K / F);
      const w = evalTotalVariance(k, REF_PARAMS);
      const fromW = binaryUpFromTotalVariance(K, F, w);
      const fromSigma = binaryUpPrice(K, F, T, Math.sqrt(w / T));
      expect(fromW).toBeCloseTo(fromSigma, 12);
    }
  });
});

describe('invertIV', () => {
  it('round-trips price → iv → price within numerical tolerance', () => {
    for (const sigma of [0.2, 0.4, 0.6, 0.8, 1.0, 1.5, 2.0]) {
      for (const K of [60_000, 80_000, 100_000, 120_000, 150_000]) {
        const p = binaryUpPrice(K, F, T, sigma);
        if (p < 0.001 || p > 0.999) continue; // skip near-degenerate
        const iv = invertIV(p, K, F, T);
        expect(iv).toBeGreaterThan(0);
        const pBack = binaryUpPrice(K, F, T, iv);
        expect(pBack).toBeCloseTo(p, 9);
      }
    }
  });

  it('returns NaN on out-of-domain probabilities', () => {
    expect(invertIV(0, 100, 100, 1)).toBeNaN();
    expect(invertIV(1, 100, 100, 1)).toBeNaN();
    expect(invertIV(-0.1, 100, 100, 1)).toBeNaN();
    expect(invertIV(1.5, 100, 100, 1)).toBeNaN();
  });

  it('inverts a target IV closely', () => {
    const targetSigma = 0.65;
    const K = 105_000;
    const p = binaryUpPrice(K, F, T, targetSigma);
    const recovered = invertIV(p, K, F, T);
    expect(recovered).toBeCloseTo(targetSigma, 8);
  });
});
