/**
 * Expiry-convergence strategy — the "late-certainty discount" on Polymarket
 * BTC dailies.
 *
 * The mechanism
 * -------------
 * In the last hour before a daily binary resolves, the near-certain side
 * routinely trades at 90–97¢ even when spot is many sigmas away from the
 * strike. Holders sell early to free capital for the next market, and no
 * market maker pins the book that close to resolution. Buying that side
 * collects the discount within the hour when the market resolves at $1.
 *
 * We have first-hand proof this edge exists: during the 2026-07 incident the
 * bot bought 800 shares of the 1¢ side of "BTC above $54k" with spot at $59k
 * — the counterparty who sold us that lottery ticket was running exactly
 * this trade and collected our $8. This module flips us to the collecting
 * side, with a hard sigma-distance gate so we only buy "certainty" that
 * realized vol actually supports.
 *
 * Risk shape
 * ----------
 * Win: +(1 − ask) per share, roughly +3–10% per ~1h hold.
 * Loss: −ask (≈ −95%) if spot crosses the strike before expiry.
 * The gate requires the crossing probability (Φ(−dσ), computed from live
 * HL realized vol) to be negligible relative to the discount collected, and
 * the shared stop-loss walker still applies on the way down — if BTC lurches
 * toward the strike the position exits at −50% instead of riding to zero.
 *
 * This module is pure math — no side effects, no I/O. Bot-loop wiring is
 * in index.ts (walkExpiryConvergence).
 */

import { normalCdf } from '../pricing/bs.js';

export interface ConvergenceCfg {
  /** Only consider markets expiring within this many minutes. */
  convergenceMaxMinutes: number;
  /** ...but not closer than this (books go haywire in the last minutes). */
  convergenceMinMinutes: number;
  /** Required sigma-distance between spot and strike. */
  convergenceMinSigma: number;
  /** Entry ask must be at least this (below = market genuinely unsure —
   *  if our sigma-gate disagrees with the crowd that hard, trust the crowd). */
  convergenceMinPrice: number;
  /** Entry ask must be below this (above = no meat left after costs). */
  convergenceMaxPrice: number;
  /** Required model EV per $1 share: (1 − ask) − Φ(−dσ). */
  convergenceMinEvFrac: number;
}

export interface ConvergenceDecision {
  enter: boolean;
  /** Which side is currently in the money (spot ≥ strike → 'yes'). */
  side: 'yes' | 'no';
  /** |ln(K/S)| / (σ√T) — how many sigmas spot sits from the strike. */
  dSigma: number;
  /** Model probability the strike gets crossed by expiry ≈ Φ(−dσ). */
  pCross: number;
  /** Expected value per $1 share after tail risk: (1 − ask) − pCross. */
  evFrac: number;
  reason: string;
}

/** Sigma-distance between spot and strike over horizon tYears. */
export function sigmaDistance(
  spot: number,
  strike: number,
  sigmaAnnual: number,
  tYears: number,
): number {
  if (spot <= 0 || strike <= 0 || sigmaAnnual <= 0 || tYears <= 0) return 0;
  return Math.abs(Math.log(strike / spot)) / (sigmaAnnual * Math.sqrt(tYears));
}

/**
 * Core decision. `itmAsk` is the best ask of the side that is currently in
 * the money. All rejections carry a reason for the decision log.
 */
export function decideConvergence(input: {
  spot: number;
  strike: number;
  sigmaAnnual: number;
  tYears: number;
  itmAsk: number;
  cfg: ConvergenceCfg;
}): ConvergenceDecision {
  const { spot, strike, sigmaAnnual, tYears, itmAsk, cfg } = input;
  const side: 'yes' | 'no' = spot >= strike ? 'yes' : 'no';
  const base = { side, dSigma: 0, pCross: 1, evFrac: 0 };

  if (!isFinite(sigmaAnnual) || sigmaAnnual <= 0) {
    return { ...base, enter: false, reason: 'no_realized_vol' };
  }
  if (tYears <= 0) {
    return { ...base, enter: false, reason: 'expired' };
  }
  const dSigma = sigmaDistance(spot, strike, sigmaAnnual, tYears);
  const pCross = normalCdf(-dSigma);
  const evFrac = 1 - itmAsk - pCross;
  const full = { side, dSigma, pCross, evFrac };

  if (dSigma < cfg.convergenceMinSigma) {
    return {
      ...full,
      enter: false,
      reason: `too_close:${dSigma.toFixed(1)}sigma<${cfg.convergenceMinSigma}`,
    };
  }
  if (!isFinite(itmAsk) || itmAsk <= 0) {
    return { ...full, enter: false, reason: 'no_ask' };
  }
  if (itmAsk < cfg.convergenceMinPrice) {
    // Sigma-gate says near-certain but the market prices real doubt. The
    // crowd knows something the trailing-RV estimate doesn't (news, a
    // resolution quirk) — stand down rather than fight it.
    return { ...full, enter: false, reason: `market_disagrees:ask=${itmAsk.toFixed(2)}` };
  }
  if (itmAsk > cfg.convergenceMaxPrice) {
    return { ...full, enter: false, reason: `no_meat:ask=${itmAsk.toFixed(3)}` };
  }
  if (evFrac < cfg.convergenceMinEvFrac) {
    return { ...full, enter: false, reason: `ev_below_min:${(evFrac * 100).toFixed(1)}%` };
  }
  return {
    ...full,
    enter: true,
    reason: `convergence:${dSigma.toFixed(1)}sigma_ev${(evFrac * 100).toFixed(1)}%`,
  };
}
