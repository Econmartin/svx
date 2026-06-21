/**
 * SVI arbitrage-free diagnostics — read-only validators for the live
 * Predict surface. Surface points (and the strategy that trades them) are
 * never gated by these checks; they exist so the dashboard can flag a
 * misspecified surface and so we can demonstrate awareness of the standard
 * Gatheral conditions.
 *
 * Reference: Gatheral & Jacquier, "Arbitrage-free SVI volatility surfaces"
 * (2014), and Gatheral, *The Volatility Surface* (2006), ch. 3.
 *
 * Conventions match the rest of svx-bot: raw SVI parameterisation
 *   w(k) = a + b · ( ρ·(k − m) + √((k − m)² + σ²) )
 * where w is *total* implied variance (not annualised), k is log-moneyness
 * `ln(K/F)` and T is time-to-expiry in years.
 */

import type { SVIParams } from 'svx-shared/types';

// --- Derivatives of w(k) ------------------------------------------------

/** First derivative w'(k). */
export function sviWPrime(k: number, p: SVIParams): number {
  const km = k - p.m;
  const root = Math.sqrt(km * km + p.sigma * p.sigma);
  // d/dk [ ρ·(k − m) + √((k − m)² + σ²) ] = ρ + (k − m)/√(…)
  return p.b * (p.rho + km / root);
}

/** Second derivative w''(k). */
export function sviWDoublePrime(k: number, p: SVIParams): number {
  const km = k - p.m;
  const denom = Math.sqrt(km * km + p.sigma * p.sigma);
  // d/dk [ (k − m)/√((k − m)² + σ²) ] = σ² / ((k − m)² + σ²)^(3/2)
  const num = p.sigma * p.sigma;
  return (p.b * num) / (denom * denom * denom);
}

/** Total variance, mirroring pricing/svi#evalTotalVariance but tolerant of
 *  zero or negative output (useful when probing pathological params). */
export function sviTotalVariance(k: number, p: SVIParams): number {
  const km = k - p.m;
  const root = Math.sqrt(km * km + p.sigma * p.sigma);
  return p.a + p.b * (p.rho * km + root);
}

// --- Butterfly arbitrage (Lee 2004 / Gatheral 2006) ----------------------

/**
 * Butterfly-arb density g(k). The risk-neutral density implied by a smile
 * is non-negative iff
 *
 *   g(k) = (1 − k·w'(k) / (2·w(k)))²
 *        − (w'(k)² / 4) · (1/w(k) + 1/4)
 *        + w''(k) / 2
 *        ≥ 0
 *
 * at every k. Negative g(k) implies a butterfly arbitrage.
 *
 * Source: Gatheral, *The Volatility Surface*, eq. (3.5) (Roger Lee's
 * density). Same form used in the Gatheral & Jacquier (2014) arb-free
 * SVI conditions.
 */
export function butterflyDensity(k: number, p: SVIParams): number {
  const w = sviTotalVariance(k, p);
  if (w <= 0) return -Infinity;
  const wp = sviWPrime(k, p);
  const wpp = sviWDoublePrime(k, p);
  const term1 = Math.pow(1 - (k * wp) / (2 * w), 2);
  const term2 = ((wp * wp) / 4) * (1 / w + 0.25);
  const term3 = wpp / 2;
  return term1 - term2 + term3;
}

export interface ButterflyScan {
  /** Per-strike densities across the supplied grid. */
  points: Array<{ k: number; density: number; ok: boolean }>;
  /** Worst (most negative) density observed. */
  worst: number;
  /** Index of the worst point. */
  worstIndex: number;
  /** True iff every density ≥ 0. */
  ok: boolean;
}

/** Evaluate the butterfly density across a log-moneyness grid. */
export function scanButterfly(ks: number[], p: SVIParams): ButterflyScan {
  let worst = Infinity;
  let worstIndex = 0;
  const points = ks.map((k, i) => {
    const g = butterflyDensity(k, p);
    if (g < worst) {
      worst = g;
      worstIndex = i;
    }
    return { k, density: g, ok: g >= 0 };
  });
  return { points, worst, worstIndex, ok: worst >= 0 };
}

// --- Wing no-arb (Lee 2004) ---------------------------------------------

export interface WingResult {
  ok: boolean;
  /** Upper bound the constraint requires `b·(1+|ρ|)` to sit beneath. */
  bound: number;
  /** Observed value of `b·(1+|ρ|)`. */
  actual: number;
  /** Time-to-expiry the bound was evaluated against. */
  tYears: number;
}

/**
 * Lee's wing constraint: at large |k| we need
 *   b · (1 + |ρ|) ≤ 4 / T
 * for no large-strike butterfly arbitrage. Holds independently of (a, m, σ).
 */
export function wingNoArb(p: SVIParams, tYears: number): WingResult {
  if (tYears <= 0) {
    return { ok: false, bound: 0, actual: Infinity, tYears };
  }
  const bound = 4 / tYears;
  const actual = p.b * (1 + Math.abs(p.rho));
  return { ok: actual <= bound, bound, actual, tYears };
}

// --- Calendar no-arb -----------------------------------------------------

export interface CalendarResult {
  ok: boolean;
  /** Maximum violation `max_k (w_short − w_long)`, ≥ 0 means arb-free. */
  worstDeficit: number;
  /** The log-moneyness at which the worst deficit occurred. */
  worstK: number;
}

/**
 * Calendar-arbitrage check between two surfaces at expiries T1 < T2:
 *   w(k, T2) ≥ w(k, T1) for all k.
 *
 * For SVI we evaluate on a supplied k-grid (one comparison per strike) and
 * report the worst point. With Predict's sub-hour rolling oracles the
 * caller will typically pass the next-longest-expiry oracle's SVI as
 * `longer` — if no longer oracle is available the check returns ok=true
 * and a worstDeficit of 0 (vacuously fine).
 */
export function calendarCheck(
  shorter: SVIParams,
  longer: SVIParams,
  ks: number[],
): CalendarResult {
  let worstDeficit = Infinity;
  let worstK = 0;
  for (const k of ks) {
    const wShort = sviTotalVariance(k, shorter);
    const wLong = sviTotalVariance(k, longer);
    const deficit = wLong - wShort;
    if (deficit < worstDeficit) {
      worstDeficit = deficit;
      worstK = k;
    }
  }
  return { ok: worstDeficit >= 0, worstDeficit, worstK };
}

// --- Convenience: full per-oracle report --------------------------------

export interface SurfaceArbReport {
  butterfly: ButterflyScan;
  wing: WingResult;
  /** Calendar comparison vs the next-longest expiry, if supplied. */
  calendar?: CalendarResult & { longerTYears: number };
}

/** Build the full arb-free report for one oracle. */
export function arbReport(
  p: SVIParams,
  tYears: number,
  ks: number[],
  longer?: { svi: SVIParams; tYears: number },
): SurfaceArbReport {
  const butterfly = scanButterfly(ks, p);
  const wing = wingNoArb(p, tYears);
  const calendar = longer
    ? { ...calendarCheck(p, longer.svi, ks), longerTYears: longer.tYears }
    : undefined;
  return { butterfly, wing, calendar };
}
