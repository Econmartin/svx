/**
 * SVI evaluator tests.
 *
 * Reference vectors generated via Python `math.erf`-based reference impl with
 * the SVI formula `w(k) = a + b*(rho*(k-m) + sqrt((k-m)^2 + sigma^2))`.
 * See docs/math-validation.md for the source script and provenance.
 */
import { describe, expect, it } from 'vitest';
import { evalTotalVariance, impliedVol, parseSVIEvent, rawToSVIParams } from '../src/pricing/svi.js';
import type { SVIParams } from 'svx-shared/types';

const TOL = 1e-12;

const REF_PARAMS: SVIParams = {
  a: 0.04,
  b: 0.4,
  rho: -0.4,
  m: 0.0,
  sigma: 0.1,
};

const TOTAL_VAR_VECTORS: Array<[number, number]> = [
  [-0.5, 0.323960780544],
  [-0.2, 0.161442719100],
  [-0.05, 0.092721359550],
  [0.0, 0.08],
  [0.05, 0.076721359550],
  [0.2, 0.097442719100],
  [0.5, 0.163960780544],
];

describe('evalTotalVariance', () => {
  for (const [k, expected] of TOTAL_VAR_VECTORS) {
    it(`matches reference at k=${k}`, () => {
      const got = evalTotalVariance(k, REF_PARAMS);
      expect(got).toBeCloseTo(expected, 9);
    });
  }

  it('throws when params produce non-positive variance', () => {
    // Construct a param set that drives w<=0 for some k. b*sqrt(σ²)=b*σ adds a
    // floor, but a < -b*σ when rho is +1 and (k-m) is tiny will go negative.
    const broken: SVIParams = { a: -10, b: 0.1, rho: 0.5, m: 0, sigma: 0.001 };
    expect(() => evalTotalVariance(0, broken)).toThrow();
  });
});

describe('impliedVol', () => {
  it('inverts the iv = sqrt(w/T) relation correctly', () => {
    const T = 1 / 12; // 1 month
    const F = 100_000;
    for (const K of [80_000, 100_000, 120_000]) {
      const k = Math.log(K / F);
      const w = evalTotalVariance(k, REF_PARAMS);
      const iv = impliedVol(K, F, T, REF_PARAMS);
      expect(iv).toBeCloseTo(Math.sqrt(w / T), 12);
    }
  });

  it('rejects invalid forward / time', () => {
    expect(() => impliedVol(100, 0, 1, REF_PARAMS)).toThrow();
    expect(() => impliedVol(100, 100, 0, REF_PARAMS)).toThrow();
  });
});

describe('parseSVIEvent', () => {
  it('parses on-chain scaled u64 strings', () => {
    // Scaling: a=0.04 → 40_000_000; b=0.4 → 400_000_000; rho=-0.4 → mag 400_000_000 negative;
    // m=0 → zero; sigma=0.1 → 100_000_000.
    const raw = {
      a: '40000000',
      b: '400000000',
      rho: { magnitude: '400000000', is_negative: true },
      m: { magnitude: '0', is_negative: false },
      sigma: '100000000',
    };
    const got = parseSVIEvent(raw);
    expect(got.a).toBeCloseTo(0.04, TOL);
    expect(got.b).toBeCloseTo(0.4, TOL);
    expect(got.rho).toBeCloseTo(-0.4, TOL);
    expect(got.m).toBeCloseTo(0.0, TOL);
    expect(got.sigma).toBeCloseTo(0.1, TOL);
  });

  it('parses signed strings (-N) form too', () => {
    const got = parseSVIEvent({ a: '0', b: '0', rho: '-400000000', m: '0', sigma: '0' });
    expect(got.rho).toBeCloseTo(-0.4, TOL);
  });

  it('round-trips RawSVIParams', () => {
    const raw = {
      a: 40_000_000n,
      b: 400_000_000n,
      rho: -400_000_000n,
      m: 0n,
      sigma: 100_000_000n,
    };
    const got = rawToSVIParams(raw);
    expect(got.a).toBeCloseTo(0.04, TOL);
    expect(got.rho).toBeCloseTo(-0.4, TOL);
  });
});
