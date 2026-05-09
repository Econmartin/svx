/**
 * Match Predict oracles to Polymarket strike sub-markets.
 *
 * Pairing rule:
 *   1. Same underlying (BTC).
 *   2. Polymarket expiry within ±toleranceMs of a Predict oracle expiry.
 *   3. Polymarket strike falls inside the Predict oracle's strike grid
 *      (`[minStrike, minStrike + tickSize * 100_000]`).
 *
 * For each match we evaluate the Predict SVI surface AT THE POLYMARKET STRIKE
 * (Predict prices every strike continuously) and compare to the Polymarket
 * order book.
 */

import type { PolyStrikeMarket } from '../pricing/polymarket.js';
import type { PredictOracleSummary } from '../pricing/predict.js';

export interface MatchedPair {
  oracle: PredictOracleSummary;
  poly: PolyStrikeMarket;
  /** Time gap between Predict oracle expiry and Polymarket expiry (ms). */
  expiryDeltaMs: number;
}

const STRIKE_GRID_TICKS = 100_000; // matches `oracle_strike_grid_ticks!()` in Move

/**
 * For each Polymarket strike, return the *closest-by-expiry* Predict oracle
 * whose strike grid contains the strike. The expiry delta is reported but
 * NOT enforced here — the data-quality filter (`signal/filter.ts`) rejects
 * pairs whose delta exceeds tolerance. This split lets the bot log the full
 * "consideration set" for observability while keeping execution strictly
 * gated on financial soundness.
 *
 * Pass `toleranceMs = Infinity` to match any expiry; pass a finite value to
 * pre-filter.
 */
export function matchOraclesToPoly(
  oracles: PredictOracleSummary[],
  polyMarkets: PolyStrikeMarket[],
  toleranceMs: number = Infinity,
): MatchedPair[] {
  const out: MatchedPair[] = [];
  for (const poly of polyMarkets) {
    let best: { oracle: PredictOracleSummary; deltaMs: number } | null = null;
    for (const o of oracles) {
      if (o.underlyingAsset !== 'BTC') continue;
      const delta = Math.abs(poly.expiryMs - o.expiryMs);
      if (delta > toleranceMs) continue;
      const maxStrike = o.minStrike + o.tickSize * STRIKE_GRID_TICKS;
      if (poly.strike < o.minStrike || poly.strike > maxStrike) continue;
      const offset = (poly.strike - o.minStrike) / o.tickSize;
      const offsetRounded = Math.round(offset);
      const tickError = Math.abs(offset - offsetRounded);
      if (tickError > 0.01) continue;
      if (!best || delta < best.deltaMs) best = { oracle: o, deltaMs: delta };
    }
    if (best) {
      out.push({ oracle: best.oracle, poly, expiryDeltaMs: best.deltaMs });
    }
  }
  return out;
}
