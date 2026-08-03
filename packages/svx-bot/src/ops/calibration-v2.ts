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
import { boardPrice, listSdkMarkets } from '../pricing/predict-sdk.js';
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
  /** Called with every fresh snapshot taken — lets the caller keep ambient
   *  state (e.g. /status spot price) alive without extra fetches. */
  onSnapshot?: (snap: import('svx-shared/types').OracleSnapshot) => void;
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
    if (!snap) continue;
    deps.onSnapshot?.(snap);
    if (snap.isSettled) continue;
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

// ── full-board tenor capture ────────────────────────────────────────────────

/** Life-stage buckets: one probe per market per slot builds a term structure
 *  for every market, from 31-day listings down to the final minutes. */
const SLOTS: Array<{ name: string; maxTtmMs: number }> = [
  { name: 't2m', maxTtmMs: 2 * 60_000 },
  { name: 't5m', maxTtmMs: 5 * 60_000 },
  { name: 't15m', maxTtmMs: 15 * 60_000 },
  { name: 't1h', maxTtmMs: 60 * 60_000 },
  { name: 't4h', maxTtmMs: 4 * 3600_000 },
  { name: 't1d', maxTtmMs: 24 * 3600_000 },
  { name: 't7d', maxTtmMs: 7 * 24 * 3600_000 },
  { name: 't7d_plus', maxTtmMs: Number.POSITIVE_INFINITY },
];

export function slotForTtm(ttmMs: number): string | null {
  if (ttmMs <= 0) return null;
  return SLOTS.find((s) => ttmMs <= s.maxTtmMs)?.name ?? null;
}

/** Strikes to sample per market, in z-units of ATM total variance. */
const BOARD_Z_GRID = [-2, -1, -0.5, 0, 0.5, 1, 2];

/** The protocol refuses live pricing very close to expiry (pricing abort 9),
 *  so don't ask for a board quote inside this window — the model price is
 *  still recorded, the board column is simply null. */
const MIN_BOARD_QUOTE_TTM_MS = 90_000;

/**
 * Full-board capture across EVERY listed market and tenor.
 *
 * For each market, once per life-stage slot, records at each grid strike:
 *   - our model probability (from the on-chain SVI surface), and
 *   - the protocol's BOARD quote (what a trade would actually pay).
 *
 * Both resolve against the same settlement, so the ledger accumulates a
 * three-way comparison — board vs model vs realized — across the whole
 * tenor ladder rather than only the minute-cycles.
 */
export async function recordBoardTenorProbes(deps: {
  predict: PredictReader;
  ledger: LedgerStore;
  nowMs?: number;
  onSnapshot?: (snap: import('svx-shared/types').OracleSnapshot) => void;
}): Promise<number> {
  const { predict, ledger } = deps;
  const now = deps.nowMs ?? Date.now();
  let recorded = 0;
  const markets = await listSdkMarkets();
  for (const m of markets) {
    const ttm = m.expiryMs - now;
    const slot = slotForTtm(ttm);
    if (!slot) continue;
    if (ledger.hasV2ProbeSlot(m.id, slot)) continue;
    const snap = await predict.snapshotOracle(m.id).catch(() => null);
    if (!snap || snap.isSettled) continue;
    deps.onSnapshot?.(snap);
    if (now - snap.timestampMs > MAX_SNAPSHOT_AGE_MS) continue;
    const wAtm = evalTotalVariance(0, snap.svi);
    if (!(wAtm > 0)) continue;
    const sd = Math.sqrt(wAtm);
    for (const z of BOARD_Z_GRID) {
      const strike = snap.forward * Math.exp(z * sd);
      const w = evalTotalVariance(Math.log(strike / snap.forward), snap.svi);
      const modelUp = binaryUpFromTotalVariance(strike, snap.forward, w);
      if (!Number.isFinite(modelUp) || modelUp <= 0 || modelUp >= 1) continue;
      // Board quote at the SAME strike — null when the protocol has no
      // reference yet or the read fails; the row still carries our model.
      const board =
        ttm >= MIN_BOARD_QUOTE_TTM_MS
          ? await boardPrice(snap.underlyingAsset, m.expiryMs, Math.round(strike))
          : null;
      ledger.insertV2CalibrationProbe({
        marketId: m.id,
        underlying: snap.underlyingAsset,
        expiryMs: m.expiryMs,
        strike,
        probUp: modelUp,
        spot: snap.spot,
        ttmMs: ttm,
        recordedAtMs: now,
        boardProbUp: board?.up ?? null,
        slot,
      });
      recorded++;
    }
  }
  if (recorded > 0) {
    log.info('svx.calib_v2.board_recorded', { probes: recorded, markets: markets.length });
  }
  return recorded;
}

/** Board vs model vs realized, bucketed by quoted probability. */
export function computeBoardComparison(
  ledger: LedgerStore,
  sinceMs = 0,
): {
  n: number;
  withBoard: number;
  model: { avg_quoted: number; realized: number; gap_pp: number };
  board: { avg_quoted: number; realized: number; gap_pp: number };
  bySlot: Array<{
    slot: string;
    n: number;
    model_gap_pp: number;
    board_gap_pp: number | null;
    board_minus_model_pp: number | null;
  }>;
} {
  const rows = ledger.settledV2Probes(sinceMs);
  const fold = (quoted: number, outcomeUp: boolean) => {
    const favoredUp = quoted >= 0.5;
    return { q: favoredUp ? quoted : 1 - quoted, win: favoredUp ? outcomeUp : !outcomeUp };
  };
  const modelRows = rows.map((r) => fold(r.probUp, r.outcomeUp));
  const boardRows = rows
    .filter((r) => r.boardProbUp != null)
    .map((r) => fold(r.boardProbUp!, r.outcomeUp));
  const stat = (xs: Array<{ q: number; win: boolean }>) => {
    if (xs.length === 0) return { avg_quoted: 0, realized: 0, gap_pp: 0 };
    const avg = xs.reduce((s, x) => s + x.q, 0) / xs.length;
    const real = xs.filter((x) => x.win).length / xs.length;
    return { avg_quoted: avg, realized: real, gap_pp: real - avg };
  };
  const slots = [...new Set(rows.map((r) => r.slot).filter((s): s is string => !!s))];
  const bySlot = slots
    .map((slot) => {
      const inSlot = rows.filter((r) => r.slot === slot);
      const m = stat(inSlot.map((r) => fold(r.probUp, r.outcomeUp)));
      const withB = inSlot.filter((r) => r.boardProbUp != null);
      const b = withB.length ? stat(withB.map((r) => fold(r.boardProbUp!, r.outcomeUp))) : null;
      return {
        slot,
        n: inSlot.length,
        model_gap_pp: m.gap_pp,
        board_gap_pp: b ? b.gap_pp : null,
        board_minus_model_pp: b ? b.avg_quoted - m.avg_quoted : null,
      };
    })
    .sort((a, b) => a.slot.localeCompare(b.slot));
  return {
    n: rows.length,
    withBoard: boardRows.length,
    model: stat(modelRows),
    board: stat(boardRows),
    bySlot,
  };
}
