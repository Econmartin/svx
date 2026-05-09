/**
 * Raw SVI (Stochastic Volatility Inspired) evaluator — matches Predict's
 * on-chain `oracle::compute_nd2`.
 *
 * Parameterization (Gatheral 2004; the "raw" SVI surface):
 *   k = ln(K / F)
 *   w(k) = a + b * (rho * (k - m) + sqrt((k - m)^2 + sigma^2))
 *
 * where w(k) is *total implied variance* at log-moneyness k, and (a, b, rho,
 * m, sigma) are the five SVI params. Annualized IV is `iv = sqrt(w(k) / T)`
 * for time-to-expiry T in years.
 *
 * Predict's on-chain encoding stores all five params scaled by 1e9 (a, b,
 * sigma as u64; rho, m as signed). This module operates in floating-point;
 * conversion lives in `parseSVIEvent`.
 */

import type { RawSVIParams, SVIParams } from 'svx-shared/types';
import { FLOAT_SCALING_NUM, MS_PER_YEAR } from 'svx-shared/constants';

/** Total implied variance w(k) for the surface at log-moneyness k. */
export function evalTotalVariance(k: number, p: SVIParams): number {
  const km = k - p.m;
  const root = Math.sqrt(km * km + p.sigma * p.sigma);
  const w = p.a + p.b * (p.rho * km + root);
  if (w <= 0) {
    throw new Error(
      `SVI returned non-positive variance ${w} at k=${k}. Params probably invalid: ${JSON.stringify(p)}`,
    );
  }
  return w;
}

/**
 * Annualized implied volatility at strike K, given forward F and
 * time-to-expiry T (years).
 */
export function impliedVol(strike: number, forward: number, tYears: number, p: SVIParams): number {
  if (forward <= 0) throw new Error(`forward must be > 0, got ${forward}`);
  if (tYears <= 0) throw new Error(`tYears must be > 0, got ${tYears}`);
  const k = Math.log(strike / forward);
  const w = evalTotalVariance(k, p);
  return Math.sqrt(w / tYears);
}

/** Convert ms-to-expiry into years on a 365.25-day basis (matches `ms_per_year`). */
export function tYearsFromMs(msToExpiry: number): number {
  return msToExpiry / MS_PER_YEAR;
}

/** Lift a signed scaled u64 (magnitude + sign) into a JS number. */
function signedScaledToNumber(magnitude: bigint, isNegative: boolean): number {
  const mag = Number(magnitude) / FLOAT_SCALING_NUM;
  return isNegative ? -mag : mag;
}

/**
 * Parse the raw scaled-u64 SVI params (from `OracleSVIUpdated` or the Predict
 * server's `/oracles/{id}/svi/latest`) into floating-point.
 *
 * The on-chain encoding: a, b, sigma are unsigned u64 magnitudes; rho, m are
 * signed (Predict's `i64` struct = (magnitude: u64, is_negative: bool)).
 * The Predict server JSON-encodes these signed fields as either
 *   { magnitude: "12345", is_negative: false }
 * or as plain signed strings/numbers — we accept both shapes.
 */
export function parseSVIEvent(raw: unknown): SVIParams {
  const r = raw as Record<string, unknown>;
  return {
    a: parseUnsigned(r.a),
    b: parseUnsigned(r.b),
    rho: parseSigned(r.rho),
    m: parseSigned(r.m),
    sigma: parseUnsigned(r.sigma),
  };
}

export function rawToSVIParams(raw: RawSVIParams): SVIParams {
  return {
    a: Number(raw.a) / FLOAT_SCALING_NUM,
    b: Number(raw.b) / FLOAT_SCALING_NUM,
    rho: Number(raw.rho) / FLOAT_SCALING_NUM,
    m: Number(raw.m) / FLOAT_SCALING_NUM,
    sigma: Number(raw.sigma) / FLOAT_SCALING_NUM,
  };
}

function parseUnsigned(v: unknown): number {
  if (typeof v === 'number') return v / FLOAT_SCALING_NUM;
  if (typeof v === 'string') return Number(BigInt(v)) / FLOAT_SCALING_NUM;
  if (typeof v === 'bigint') return Number(v) / FLOAT_SCALING_NUM;
  throw new Error(`unparseable unsigned u64: ${JSON.stringify(v)}`);
}

function parseSigned(v: unknown): number {
  // Object form: { magnitude, is_negative } or { magnitude, isNegative }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('magnitude' in o) {
      const mag = parseUnsigned(o.magnitude);
      const neg = (o.is_negative ?? o.isNegative) === true;
      return neg ? -mag : mag;
    }
  }
  if (typeof v === 'number') return v / FLOAT_SCALING_NUM;
  if (typeof v === 'string') {
    if (v.startsWith('-')) return -Number(BigInt(v.slice(1))) / FLOAT_SCALING_NUM;
    return Number(BigInt(v)) / FLOAT_SCALING_NUM;
  }
  if (typeof v === 'bigint') return Number(v) / FLOAT_SCALING_NUM;
  throw new Error(`unparseable signed i64: ${JSON.stringify(v)}`);
}

export { signedScaledToNumber };
