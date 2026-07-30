/**
 * Harvest V2 — surface-only favored-side entries for the V2 cutover.
 *
 * V1's favored strategies triggered off Predict↔Polymarket divergence
 * signals. V2 markets cycle in ~3 minutes and have no Polymarket
 * counterpart, so that trigger never fires. This strategy enters purely
 * from Predict's own surface — the exact setup the V2 calibration recorder
 * validates continuously: favorites quoted 60–90¢ shortly before expiry
 * realize several points above quote (GET /calibration-v2).
 *
 * Entry: inside a time-to-expiry window, scan a strike grid around the
 * forward, and take the strike whose FAVORED side is quoted closest to the
 * target probability while inside the band. All the usual gates apply on
 * top (per-market dedupe, max open, daily loss limit, surface freshness).
 */

import type { OracleSnapshot } from 'svx-shared/types';
import { binaryUpFromTotalVariance } from '../pricing/bs.js';
import { evalTotalVariance } from '../pricing/svi.js';

export interface HarvestV2Gates {
  /** Entry window before expiry, in ms. */
  minTtmMs: number;
  maxTtmMs: number;
  /** Favored-side band (from /calibration-v2: edge lives in 60–90¢). */
  minCostPrice: number;
  maxCostPrice: number;
  /** Prefer the strike quoted nearest this favored probability. */
  targetProb: number;
  /** Refuse to act on a surface older than this. */
  maxSnapshotAgeMs: number;
  maxOpen: number;
  dailyLossLimitDusdc: number;
}

export interface HarvestV2Decision {
  enter: boolean;
  strike: number;
  direction: 'up' | 'down';
  /** Favored-side quoted probability = our cost-price proxy. */
  costPrice: number;
  reason: string;
}

const Z_GRID = [-1.5, -1.25, -1, -0.75, -0.5, 0.5, 0.75, 1, 1.25, 1.5];

export function decideHarvestV2(
  input: {
    snap: OracleSnapshot;
    nowMs: number;
    hasOpenForMarket: boolean;
    openStrategyCount: number;
    dailyStrategyPnlUsdc: number;
  },
  gates: HarvestV2Gates,
): HarvestV2Decision {
  const { snap, nowMs } = input;
  const none = (reason: string): HarvestV2Decision => ({
    enter: false,
    strike: 0,
    direction: 'up',
    costPrice: 0,
    reason,
  });

  const ttm = snap.expiryMs - nowMs;
  if (ttm < gates.minTtmMs || ttm > gates.maxTtmMs) {
    return none(`outside_window:${Math.round(ttm / 1000)}s`);
  }
  if (nowMs - snap.timestampMs > gates.maxSnapshotAgeMs) {
    return none(`stale_surface:${Math.round((nowMs - snap.timestampMs) / 1000)}s`);
  }
  if (input.hasOpenForMarket) return none('already_open_for_market');
  if (input.openStrategyCount >= gates.maxOpen) {
    return none(`max_open:${input.openStrategyCount}`);
  }
  if (input.dailyStrategyPnlUsdc <= -gates.dailyLossLimitDusdc) {
    return none('daily_loss_limit');
  }

  const wAtm = evalTotalVariance(0, snap.svi);
  if (!(wAtm > 0)) return none('bad_surface_variance');
  const sd = Math.sqrt(wAtm);

  let best: { strike: number; direction: 'up' | 'down'; prob: number } | undefined;
  for (const z of Z_GRID) {
    const strike = snap.forward * Math.exp(z * sd);
    const w = evalTotalVariance(Math.log(strike / snap.forward), snap.svi);
    const up = binaryUpFromTotalVariance(strike, snap.forward, w);
    if (!Number.isFinite(up) || up <= 0 || up >= 1) continue;
    const direction: 'up' | 'down' = up >= 0.5 ? 'up' : 'down';
    const prob = direction === 'up' ? up : 1 - up;
    if (prob < gates.minCostPrice || prob > gates.maxCostPrice) continue;
    if (!best || Math.abs(prob - gates.targetProb) < Math.abs(best.prob - gates.targetProb)) {
      best = { strike, direction, prob };
    }
  }
  if (!best) return none('no_strike_in_band');
  return {
    enter: true,
    strike: best.strike,
    direction: best.direction,
    costPrice: best.prob,
    reason: `harvest_v2:${best.direction}@${best.prob.toFixed(2)}_ttm${Math.round(ttm / 1000)}s`,
  };
}
