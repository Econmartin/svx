/**
 * SVI arbitrage-free diagnostics tests.
 *
 * Strategy: validate derivatives against finite differences (closed-form
 * w', w'' against numerical), then exercise butterfly / wing / calendar
 * checks on:
 *   - a clean reference SVI (same params as svi.test.ts) — must pass all.
 *   - synthetic surfaces engineered to violate one constraint at a time.
 */
import { describe, expect, it } from 'vitest';
import type { SVIParams } from 'svx-shared/types';
import {
  arbReport,
  butterflyDensity,
  calendarCheck,
  scanButterfly,
  sviTotalVariance,
  sviWPrime,
  sviWDoublePrime,
  wingNoArb,
} from '../src/pricing/svi-arb.js';

const CLEAN: SVIParams = {
  a: 0.04,
  b: 0.4,
  rho: -0.4,
  m: 0.0,
  sigma: 0.1,
};

function grid(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let k = lo; k <= hi + 1e-12; k += step) out.push(Number(k.toFixed(12)));
  return out;
}

describe('SVI derivatives', () => {
  it('sviWPrime matches finite differences on the clean surface', () => {
    const h = 1e-6;
    for (const k of [-0.3, -0.1, 0, 0.1, 0.3]) {
      const fd = (sviTotalVariance(k + h, CLEAN) - sviTotalVariance(k - h, CLEAN)) / (2 * h);
      const cf = sviWPrime(k, CLEAN);
      expect(Math.abs(fd - cf)).toBeLessThan(1e-6);
    }
  });

  it('sviWDoublePrime matches finite differences on the clean surface', () => {
    const h = 1e-4;
    for (const k of [-0.3, -0.1, 0, 0.1, 0.3]) {
      const fd =
        (sviTotalVariance(k + h, CLEAN) - 2 * sviTotalVariance(k, CLEAN) + sviTotalVariance(k - h, CLEAN)) /
        (h * h);
      const cf = sviWDoublePrime(k, CLEAN);
      // Looser tolerance — second-order FD has more roundoff.
      expect(Math.abs(fd - cf)).toBeLessThan(1e-3);
    }
  });
});

describe('butterfly density', () => {
  it('is non-negative for the clean reference surface across ±0.5 in log-moneyness', () => {
    const scan = scanButterfly(grid(-0.5, 0.5, 0.01), CLEAN);
    expect(scan.ok).toBe(true);
    expect(scan.worst).toBeGreaterThanOrEqual(0);
  });

  it('flips negative when b grows large enough to introduce a butterfly arb', () => {
    // Pump b past the wing bound — the smile gets too curved and the
    // implied density turns negative in the wings.
    const bad: SVIParams = { ...CLEAN, b: 5, rho: -0.9 };
    const scan = scanButterfly(grid(-1.0, 1.0, 0.02), bad);
    expect(scan.ok).toBe(false);
    expect(scan.worst).toBeLessThan(0);
    // Worst point should land away from at-the-money.
    expect(Math.abs(scan.points[scan.worstIndex]!.k)).toBeGreaterThan(0.1);
  });

  it('butterflyDensity at k=0 reduces to 1 + w_pp(0)/2 when w_p(0)=0', () => {
    // Symmetric surface: m=0, rho=0 ⇒ w'(0) = b·(0 + 0/σ) = 0.
    const sym: SVIParams = { a: 0.05, b: 0.3, rho: 0, m: 0, sigma: 0.2 };
    const w0 = sviTotalVariance(0, sym);
    const wpp0 = sviWDoublePrime(0, sym);
    const expected = 1 - 0 + wpp0 / 2; // (1-0)^2 - 0 + w''(0)/2
    const got = butterflyDensity(0, sym);
    expect(Math.abs(got - expected)).toBeLessThan(1e-12);
    // sanity: w(0) > 0 prevents divide-by-zero
    expect(w0).toBeGreaterThan(0);
  });
});

describe('wing no-arb (Lee)', () => {
  it('accepts the clean surface at 30-minute expiry', () => {
    // T ≈ 30 minutes
    const T = (30 * 60 * 1000) / (365.25 * 24 * 3600 * 1000);
    const r = wingNoArb(CLEAN, T);
    // 4/T is huge for tiny T, clean surface easily satisfies.
    expect(r.ok).toBe(true);
    expect(r.actual).toBeLessThan(r.bound);
  });

  it('rejects b·(1+|ρ|) > 4/T', () => {
    const T = 1; // one year
    // bound = 4, so b·(1+|ρ|) > 4 must fail.
    const bad: SVIParams = { ...CLEAN, b: 3, rho: 0.5 }; // 3·1.5 = 4.5 > 4
    const r = wingNoArb(bad, T);
    expect(r.ok).toBe(false);
    expect(r.actual).toBeCloseTo(4.5, 12);
    expect(r.bound).toBeCloseTo(4, 12);
  });
});

describe('calendar no-arb', () => {
  it('passes when the longer-expiry surface has uniformly higher total variance', () => {
    // Same shape, slightly higher base level for the longer expiry.
    const longer: SVIParams = { ...CLEAN, a: CLEAN.a + 0.02 };
    const r = calendarCheck(CLEAN, longer, grid(-0.4, 0.4, 0.02));
    expect(r.ok).toBe(true);
    expect(r.worstDeficit).toBeGreaterThanOrEqual(0);
  });

  it('fails when the longer-expiry surface has lower total variance somewhere', () => {
    const longer: SVIParams = { ...CLEAN, a: CLEAN.a - 0.02 };
    const r = calendarCheck(CLEAN, longer, grid(-0.4, 0.4, 0.02));
    expect(r.ok).toBe(false);
    expect(r.worstDeficit).toBeLessThan(0);
  });
});

describe('arbReport', () => {
  it('returns all green for the clean surface, calendar undefined when no longer expiry supplied', () => {
    const T = 0.05; // ≈ 2.6 weeks
    const r = arbReport(CLEAN, T, grid(-0.5, 0.5, 0.02));
    expect(r.butterfly.ok).toBe(true);
    expect(r.wing.ok).toBe(true);
    expect(r.calendar).toBeUndefined();
  });

  it('includes calendar block when a longer expiry is passed', () => {
    const T1 = 0.02;
    const T2 = 0.05;
    const longer: SVIParams = { ...CLEAN, a: CLEAN.a + 0.01 };
    const r = arbReport(CLEAN, T1, grid(-0.3, 0.3, 0.02), { svi: longer, tYears: T2 });
    expect(r.calendar).toBeDefined();
    expect(r.calendar?.ok).toBe(true);
    expect(r.calendar?.longerTYears).toBe(T2);
  });
});
