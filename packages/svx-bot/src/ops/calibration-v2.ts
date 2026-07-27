/**
 * V2 calibration recorder — the auditor function rebuilt for the 2026-07-26
 * Predict cutover, with no Polymarket dependency.
 *
 * V2 markets cycle in minutes, so cross-venue matching is structurally idle
 * on most of them; instead we measure Predict against ITSELF: shortly before
 * each market's expiry we sample the probability its own on-chain surface
 * quotes at a grid of strikes around spot (no model of ours in the loop —
 * SVI in, digital price out), then resolve every probe against the on-chain
 * settlement price. Bucketing realized outcomes by quoted probability
 * answers the post-cutover question directly: is the surface still
 * underconfident on favorites after roll-down (DBU-655) and inventory skew,
 * or did those fixes close the edge we measured on V1?
 */

import type { LedgerStore } from '../ledger/store.js';
import type { PredictReader } from '../pricing/predict-v2.js';
import { binaryUpFromTotalVariance } from '../pricing/bs.js';
import { evalTotalVariance } from '../pricing/svi.js';
import { log } from '../util/log.js';

/** Probe when a market is within this window of its expiry. The lower bound
 *  keeps us clear of the settlement freeze; the upper bound keeps the quote
 *  representative of the near-expiry surface the strategies would trade. */
const PROBE_WINDOW_MS = { min: 15_000, max: 120_000 };

/** Strike grid in z-units of ATM total variance (log-moneyness / sqrt(w)). */
const PROBE_Z_GRID = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2];

/** Refuse to probe from a stale surface (mirrors the trading gate). */
const MAX_SNAPSHOT_AGE_MS = 30_000;

export async function recordV2CalibrationProbes(deps: {
  predict: PredictReader;
  ledger: LedgerStore;
  nowMs?: number;
}): Promise<number> {
  const { predict, ledger } = deps;
  const now = deps.nowMs ?? Date.now();
  let recorded = 0;
  const active = await predict.listActiveOracles();
  for (const o of active) {
    const ttm = o.expiryMs - now;
    if (ttm < PROBE_WINDOW_MS.min || ttm > PROBE_WINDOW_MS.max) continue;
    if (ledger.hasV2ProbesForMarket(o.oracleId)) continue;
    const snap = await predict.snapshotOracle(o.oracleId).catch(() => null);
    if (!snap || snap.isSettled) continue;
    if (now - snap.timestampMs > MAX_SNAPSHOT_AGE_MS) continue; // stale surface
    const wAtm = evalTotalVariance(0, snap.svi);
    if (!(wAtm > 0)) continue;
    const sd = Math.sqrt(wAtm);
    for (const z of PROBE_Z_GRID) {
      const strike = snap.forward * Math.exp(z * sd);
      const w = evalTotalVariance(Math.log(strike / snap.forward), snap.svi);
      const probUp = binaryUpFromTotalVariance(strike, snap.forward, w);
      if (!Number.isFinite(probUp) || probUp <= 0 || probUp >= 1) continue;
      ledger.insertV2CalibrationProbe({
        marketId: o.oracleId,
        underlying: o.underlyingAsset,
        expiryMs: o.expiryMs,
        strike,
        probUp,
        spot: snap.spot,
        ttmMs: ttm,
        recordedAtMs: now,
      });
      recorded++;
    }
  }
  if (recorded > 0) log.info('svx.calib_v2.recorded', { probes: recorded });
  return recorded;
}

export async function resolveV2CalibrationProbes(deps: {
  predict: PredictReader;
  ledger: LedgerStore;
  nowMs?: number;
}): Promise<number> {
  const { predict, ledger } = deps;
  const now = deps.nowMs ?? Date.now();
  let resolved = 0;
  // Small grace period: settlement lands a few seconds after expiry.
  for (const { marketId } of ledger.unsettledV2ProbeMarkets(now - 10_000)) {
    const snap = await predict.snapshotOracle(marketId).catch(() => null);
    if (!snap?.isSettled || snap.settlementPrice == null) continue;
    resolved += ledger.resolveV2ProbesForMarket(
      marketId,
      snap.settlementPrice,
      snap.timestampMs,
    );
  }
  if (resolved > 0) log.info('svx.calib_v2.resolved', { probes: resolved });
  return resolved;
}

export interface V2CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  wins: number;
  avg_quoted: number;
  realized: number;
  gap_pp: number;
}

/** Favored-side calibration buckets over settled probes: fold each probe to
 *  the side quoted >= 50% (regime-stable, same convention as V1). */
export function computeV2Calibration(
  ledger: LedgerStore,
  sinceMs = 0,
): { n: number; wins: number; avg_quoted: number; realized: number; buckets: V2CalibrationBucket[] } {
  const rows = ledger.settledV2Probes(sinceMs);
  const folded = rows.map((r) => {
    const favoredUp = r.probUp >= 0.5;
    return {
      quoted: favoredUp ? r.probUp : 1 - r.probUp,
      win: favoredUp ? r.outcomeUp : !r.outcomeUp,
    };
  });
  const bounds = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0000001];
  const buckets: V2CalibrationBucket[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i]!;
    const hi = bounds[i + 1]!;
    const inB = folded.filter((f) => f.quoted >= lo && f.quoted < hi);
    if (inB.length === 0) continue;
    const wins = inB.filter((f) => f.win).length;
    const avg = inB.reduce((s, f) => s + f.quoted, 0) / inB.length;
    buckets.push({
      lo,
      hi: Math.min(hi, 1),
      n: inB.length,
      wins,
      avg_quoted: avg,
      realized: wins / inB.length,
      gap_pp: wins / inB.length - avg,
    });
  }
  const n = folded.length;
  const wins = folded.filter((f) => f.win).length;
  const avg = n ? folded.reduce((s, f) => s + f.quoted, 0) / n : 0;
  return { n, wins, avg_quoted: avg, realized: n ? wins / n : 0, buckets };
}
