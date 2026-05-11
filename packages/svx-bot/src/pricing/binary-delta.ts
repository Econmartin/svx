/**
 * Spot delta of a digital binary — the BTC-notional hedge size needed to
 * neutralize directional exposure on a Polymarket "above strike" position.
 *
 * For a binary `P(S) = N(d2)` where
 *
 *   k  = ln(K / S)                  // assuming forward ≈ spot (no carry)
 *   w  = sigma² · T                 // total variance
 *   d2 = -((k + w/2) / √w)
 *
 * the derivative w.r.t. spot is:
 *
 *   ∂P/∂S = N'(d2) · ∂d2/∂S
 *         = φ(d2) · (-1 / (S · √w))
 *         = -φ(d2) / (S · √w)
 *
 * The MAGNITUDE is what we want for hedge sizing. The sign is captured by
 * the chosen Polymarket outcome:
 *
 *   Yes-on-above-strike → bot has +Δ exposure → short BTC perp to neutralize
 *   No-on-above-strike  → bot has −Δ exposure → long BTC perp to neutralize
 *
 * Edge cases:
 *   - At/near expiry with strike very close to spot, gamma blows up and
 *     |∂P/∂S| → ∞. We clamp to `MAX_DELTA` so the bot never tries to size a
 *     hedge larger than the per-trade cap allows.
 *   - For extreme moneyness (deep ITM/OTM), delta → 0. We don't clamp the
 *     lower bound; a tiny hedge is fine — sizes round to nothing on HL.
 *
 * All inputs in standard finance units:
 *   spot   = current price of the underlying (USD)
 *   strike = strike price (USD)
 *   ivAnn  = annualized implied vol (e.g. 0.65)
 *   tYears = time to expiry in years
 *
 * Returns the magnitude of ∂P/∂S in BTC per dollar. Multiply by the number
 * of Polymarket shares × dollar exposure to get BTC notional.
 */

import { normalPdf } from './bs.js';

/** Hard upper bound on |Δ| (BTC per dollar) to bound hedge sizing under gamma blow-up. */
export const MAX_DELTA = 0.01;

export interface BinaryDeltaInput {
  spot: number;
  strike: number;
  ivAnnual: number;
  ttmYears: number;
}

export interface BinaryDelta {
  /** Magnitude |∂P/∂S| clamped to MAX_DELTA. Always ≥ 0. */
  magnitude: number;
  /** d2 used internally — exported for diagnostics + tests. */
  d2: number;
  /** True iff the raw value was clamped to MAX_DELTA. */
  clamped: boolean;
}

export function binaryDeltaWrtSpot(input: BinaryDeltaInput): BinaryDelta {
  const { spot, strike, ivAnnual, ttmYears } = input;
  if (!(spot > 0) || !(strike > 0) || !(ivAnnual > 0) || !(ttmYears > 0)) {
    return { magnitude: 0, d2: 0, clamped: false };
  }
  const k = Math.log(strike / spot);
  const w = ivAnnual * ivAnnual * ttmYears;
  const sqrtW = Math.sqrt(w);
  const d2 = -(k + w / 2) / sqrtW;
  const raw = normalPdf(d2) / (spot * sqrtW);
  if (!isFinite(raw) || raw < 0) return { magnitude: 0, d2, clamped: false };
  if (raw > MAX_DELTA) return { magnitude: MAX_DELTA, d2, clamped: true };
  return { magnitude: raw, d2, clamped: false };
}

/**
 * Convenience: compute the BTC-notional hedge size for a given Polymarket
 * fill. Returns `{ btcSize, hedgeSide, usdNotional }`.
 *
 *   btcSize     = |Δ| × shares     (BTC, not USD)
 *   usdNotional = btcSize × spot   (USD exposure of the perp leg)
 *   hedgeSide   = polyOutcome === 'yes' ? 'short' : 'long'
 *
 * Caller is responsible for round-tripping `btcSize` through HL's size
 * precision (BTC perp on HL accepts 5 decimal places).
 */
export function hedgeSizeForPolyFill(input: {
  spot: number;
  strike: number;
  ivAnnual: number;
  ttmYears: number;
  shares: number;
  polyOutcome: 'yes' | 'no';
}): {
  btcSize: number;
  hedgeSide: 'long' | 'short';
  usdNotional: number;
  delta: BinaryDelta;
} {
  const delta = binaryDeltaWrtSpot(input);
  const btcSize = delta.magnitude * input.shares;
  const hedgeSide: 'long' | 'short' = input.polyOutcome === 'yes' ? 'short' : 'long';
  return {
    btcSize,
    hedgeSide,
    usdNotional: btcSize * input.spot,
    delta,
  };
}
