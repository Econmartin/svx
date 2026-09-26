/**
 * Fade-spike — the last-minute pattern three mainnet wallets profit from.
 *
 * In the final minute of a Predict up/down window, when BTC has run >= $20
 * past the reference strike over the previous 30s, the far side is cheap
 * (<= 30c). Buying it bets the spike partly reverses before settlement.
 * Shadow data (2026-09-26, n=135): +4.0c per $1 contract after fees, but
 * inside the noise; the no-spike control lost -11.3c. Treat live trading as
 * an experiment: tiny clips, hard daily loss limit, kill switch respected.
 *
 * Decision logic is shared with the shadow scorer so paper, live and the
 * scoreboard can never disagree about what the signal is.
 */

import type { ShadowDecisionRow } from '../ledger/store.js';

/** The fade-spike rule's parameters. Whether it trades is decided by the
 *  strategy switchboard (strategy/switchboard.ts), not by settings. */
/** The fade-spike rule's parameters. Whether it trades is decided by the
 *  strategy switchboard (strategy/switchboard.ts), not by settings. */
export interface FadeSpikeSettings {
  /** Minimum USD distance past the strike (basis-adjusted Binance). */
  minMoveUsd: number;
  /** Maximum board price of the far side. */
  maxFarPrice: number;
}

export const FADE_SPIKE_RULE: FadeSpikeSettings = { minMoveUsd: 20, maxFarPrice: 0.3 };

export function fadeSpikeSettings(): FadeSpikeSettings {
  return FADE_SPIKE_RULE;
}

type Side = 'up' | 'down';

/** The far side to buy, or null when the pattern is absent. */
export function fadeSpikeSide(
  r: Pick<ShadowDecisionRow, 'ttmMs' | 'binVsRef' | 'mom30s' | 'boardUp'>,
  minMoveUsd: number,
  maxFarPrice: number,
  /** Latest entry the rule accepts (the live rule: the last minute). */
  maxTtmMs = 60_000,
): Side | null {
  if (r.ttmMs > maxTtmMs || r.binVsRef == null || r.mom30s == null) return null;
  if (Math.abs(r.binVsRef) < minMoveUsd) return null;
  // The last 30s must have pushed price AWAY from the strike (a spike).
  if (Math.sign(r.mom30s) !== Math.sign(r.binVsRef)) return null;
  const far: Side = r.binVsRef > 0 ? 'down' : 'up';
  const farPrice = far === 'up' ? r.boardUp : 1 - r.boardUp;
  // Predict refuses entries under its min entry probability (1%) with
  // EEntryProbabilityOutOfBounds; keep clear of it.
  return farPrice >= MIN_FAR_PRICE && farPrice <= maxFarPrice ? far : null;
}

const MIN_FAR_PRICE = 0.02;

/**
 * Why the rule did NOT fire, in plain words (null when it fires). Same
 * checks, same order as fadeSpikeSide — the dashboard shows this per check.
 */
export function fadeSpikeWhyNot(
  r: Pick<ShadowDecisionRow, 'ttmMs' | 'binVsRef' | 'mom30s' | 'boardUp'>,
  minMoveUsd: number,
  maxFarPrice: number,
): string | null {
  if (r.ttmMs > 60_000) return 'not in the last minute';
  if (r.binVsRef == null || r.mom30s == null) return 'no price data';
  if (Math.abs(r.binVsRef) < minMoveUsd) {
    return `only $${Math.abs(r.binVsRef).toFixed(0)} from the strike (needs $${minMoveUsd})`;
  }
  if (Math.sign(r.mom30s) !== Math.sign(r.binVsRef)) return 'already moving back toward the strike';
  const far = r.binVsRef > 0 ? 'down' : 'up';
  const farPrice = far === 'up' ? r.boardUp : 1 - r.boardUp;
  if (farPrice < MIN_FAR_PRICE) return `far side too cheap (${(farPrice * 100).toFixed(1)}¢, min 2¢)`;
  if (farPrice > maxFarPrice) {
    return `far side too dear (${(farPrice * 100).toFixed(1)}¢, max ${(maxFarPrice * 100).toFixed(0)}¢)`;
  }
  return null;
}

/** Predict rejects mints whose premium is under $1 (constants::min_premium). */
const MIN_PREMIUM_USD = 1;
const PREMIUM_HEADROOM = 1.12;

/**
 * Smallest clip that clears the minimum premium with headroom for price
 * drift, in $0.01 payout lots. Null when that clip would cost more than the
 * cap (very cheap contracts need a large payout to reach $1 of premium).
 */
export function fadeSpikeQuantity(
  farPrice: number,
  costPerContract: number,
  maxCostUsd: number,
): number | null {
  if (!(farPrice > 0) || !(costPerContract > 0)) return null;
  const q = Math.ceil(((MIN_PREMIUM_USD * PREMIUM_HEADROOM) / farPrice) * 100) / 100;
  return q * costPerContract <= maxCostUsd ? q : null;
}
