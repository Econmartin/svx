/**
 * Range-ladder — the hackathon brief's flagship vault idea (idea bank #1),
 * built on our calibration data.
 *
 * A range (lower, higher] pays $1 when settlement lands in the band. Its
 * fair price off the SVI surface is the difference of two digitals:
 *
 *   price(lower, higher) = P_up(lower) − P_up(higher)
 *
 * The ladder mints N adjacent rungs centered on the at-the-money forward
 * each expiry and rolls on settlement. THE design question the brief poses
 * ("pick the strike-width policy") is answered with data by the simulator
 * in ops/range-sim.ts: fixed-bps widths vs SVI-implied 1σ widths, replayed
 * over every recorded surface snapshot + settlement.
 *
 * This module is pure math — no side effects, no I/O.
 */

import type { SVIParams } from 'svx-shared/types';
import { sviTotalVariance } from '../pricing/svi-arb.js';
import { binaryUpFromTotalVariance } from '../pricing/bs.js';

export type LadderPolicy = 'sigma' | 'fixed_bps';

export interface LadderCfg {
  policy: LadderPolicy;
  /** Number of rungs (adjacent bands). */
  rungs: number;
  /** sigma policy: rung width in units of the ATM 1σ price move. */
  widthZ: number;
  /** fixed_bps policy: rung width in basis points of forward. */
  widthBps: number;
  /** Skip rungs priced below this (deep-wing lottery tickets). */
  minRungPrice: number;
  /** ...or above this (no payoff room after fee). */
  maxRungPrice: number;
}

export interface LadderRung {
  lowerStrike: number;
  higherStrike: number;
  /** SVI-fair probability of settling in the band. */
  fairPrice: number;
  /** Rung offset from the ATM rung (0 = contains the forward). */
  offset: number;
}

/** Digital P_up at strike K off the surface. */
export function upAtStrike(strike: number, forward: number, svi: SVIParams): number {
  const k = Math.log(strike / forward);
  const w = sviTotalVariance(k, svi);
  if (!(w > 0)) return strike <= forward ? 1 : 0;
  return binaryUpFromTotalVariance(strike, forward, w);
}

/** Fair price of the range (lower, higher] off the surface. */
export function rangeFairPrice(
  lower: number,
  higher: number,
  forward: number,
  svi: SVIParams,
): number {
  return Math.max(0, upAtStrike(lower, forward, svi) - upAtStrike(higher, forward, svi));
}

/**
 * Build the ladder around the ATM forward. Returns rungs sorted by strike;
 * rungs outside [minRungPrice, maxRungPrice] are dropped (they're either
 * unpayable wings or all-fee).
 */
export function buildLadder(input: {
  forward: number;
  svi: SVIParams;
  tYears: number;
  cfg: LadderCfg;
}): LadderRung[] {
  const { forward, svi, tYears, cfg } = input;
  if (!(forward > 0) || !(tYears > 0) || cfg.rungs < 1) return [];

  let width: number;
  if (cfg.policy === 'sigma') {
    const w0 = sviTotalVariance(0, svi);
    if (!(w0 > 0)) return [];
    const sigmaAtm = Math.sqrt(w0 / tYears);
    width = cfg.widthZ * sigmaAtm * Math.sqrt(tYears) * forward;
  } else {
    width = (cfg.widthBps / 10_000) * forward;
  }
  if (!(width > 0)) return [];

  // N adjacent rungs spanning [F − N/2·w, F + N/2·w]; rung i covers
  // (F + (i − N/2)·w, F + (i + 1 − N/2)·w]. The rung containing F gets
  // offset 0 so the simulator can report center-vs-wing hit rates.
  const out: LadderRung[] = [];
  const half = cfg.rungs / 2;
  // Index of the rung whose band (lower, higher] contains the forward.
  const atmIndex = Math.ceil(half) - 1;
  for (let i = 0; i < cfg.rungs; i++) {
    const lower = forward + (i - half) * width;
    const higher = lower + width;
    if (lower <= 0) continue;
    const fairPrice = rangeFairPrice(lower, higher, forward, svi);
    if (fairPrice < cfg.minRungPrice || fairPrice > cfg.maxRungPrice) continue;
    out.push({
      lowerStrike: lower,
      higherStrike: higher,
      fairPrice,
      offset: i - atmIndex,
    });
  }
  return out;
}

/** Settlement rule per the protocol docs: pays when settle ∈ (lower, higher]. */
export function rangePays(rung: { lowerStrike: number; higherStrike: number }, settle: number): boolean {
  return settle > rung.lowerStrike && settle <= rung.higherStrike;
}
