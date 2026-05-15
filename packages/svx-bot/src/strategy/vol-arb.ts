/**
 * Vol-arb: standalone Hyperliquid directional perp strategy driven by the
 * divergence between Predict's implied vol and HL's realized vol.
 *
 * The idea
 * --------
 * Predict's SVI surface is a forward-looking IV forecast. Hyperliquid's
 * recent mid-price history gives us realized vol (RV). When the two
 * diverge significantly, the market is mispricing future volatility
 * relative to what's actually being delivered:
 *
 *   - Predict IV ≫ HL RV  → market expects more vol than HL is delivering.
 *                            If Predict's surface also has a directional
 *                            bias, take a perp position in that direction.
 *   - Predict IV ≪ HL RV  → market underprices forward vol. Same logic
 *                            with opposite framing — but for v1 we trade
 *                            both sides identically: trigger on |IV − RV|,
 *                            direction from surface skew.
 *
 * Position lifecycle
 * ------------------
 *   open:   |IV − RV| > openThreshold  AND  |P_up − 0.5| > biasThreshold
 *   close:  |IV − RV| < closeThreshold  OR  time-stop hit
 *
 * Risk
 * ----
 * Per-trade USD cap, total open exposure cap, daily PnL stop. All separate
 * from the poly-arb HL hedge gates so the two strategies don't crowd each
 * other out of the HL margin budget.
 *
 * This module is pure math — no side effects, no I/O. Bot-loop wiring is
 * in index.ts.
 */

import type { SvxConfig } from '../config.js';
import { evalTotalVariance, tYearsFromMs } from '../pricing/svi.js';
import { binaryUpFromTotalVariance } from '../pricing/bs.js';
import type { OracleSnapshot } from 'svx-shared/types';

const MS_PER_SECOND = 1000;
const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

/** A single sampled HL mid price. Buffer is sorted ascending by ts. */
export interface BtcMidSample {
  ts: number;
  price: number;
}

/**
 * Rolling-window state for vol-arb. Lives in BotState; persisted only
 * in memory (the strategy warms up after a restart over ~1 hour).
 */
export interface VolArbState {
  /** BTC mid-price samples over the lookback window. */
  midHistory: BtcMidSample[];
  /** Last computed Predict ATM IV (for dashboard display). */
  lastPredictIv: number | null;
  /** Last computed HL realized vol. */
  lastRealizedVol: number | null;
  /** Last signal decision — null if no decision yet. */
  lastDecision: VolArbDecision | null;
  /** Cached log of recent decisions (ring buffer, ≤ 100 entries). */
  recentDecisions: VolArbDecisionLog[];
}

export interface VolArbDecision {
  action: 'hold' | 'open_long' | 'open_short' | 'close';
  /** Why we made this call — for log + dashboard display. */
  reason: string;
  predictIv: number;
  realizedVol: number;
  ivSpread: number;
  /** Predict's UP probability at spot, derived from the freshest oracle. */
  predictUpAtSpot: number;
  ts: number;
}

export interface VolArbDecisionLog extends VolArbDecision {
  /** True if the bot actually fired an HL order on this decision. */
  acted: boolean;
}

/**
 * Append a new HL BTC mid sample to the rolling buffer and trim to the
 * lookback window. Idempotent — calling with a sample whose ts already
 * exists is a no-op (handles loop replay).
 *
 * Returns the updated history (mutates `state` for convenience).
 */
export function appendMid(state: VolArbState, sample: BtcMidSample, lookbackMs: number = 3600_000): void {
  const last = state.midHistory[state.midHistory.length - 1];
  if (last && last.ts === sample.ts) return;
  state.midHistory.push(sample);
  const cutoff = sample.ts - lookbackMs;
  while (state.midHistory.length > 0 && state.midHistory[0]!.ts < cutoff) {
    state.midHistory.shift();
  }
}

/**
 * Annualized realized vol from log returns. Standard formula:
 *   r_i = ln(p_i / p_{i-1})
 *   variance = sum((r_i − mean)²) / (n − 1)
 *   annualized = √(variance × samples_per_year)
 *
 * `samples_per_year` is derived from the median inter-sample gap in the
 * history — handles irregular sampling (loop iterations skip when busy).
 *
 * Returns NaN if there are < 2 samples or the gap is non-positive.
 */
export function computeRealizedVol(history: BtcMidSample[]): number {
  if (history.length < 2) return NaN;
  const returns: number[] = [];
  const gaps: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1]!;
    const cur = history[i]!;
    if (prev.price <= 0 || cur.price <= 0) continue;
    const dtMs = cur.ts - prev.ts;
    if (dtMs <= 0) continue;
    returns.push(Math.log(cur.price / prev.price));
    gaps.push(dtMs);
  }
  if (returns.length < 1 || gaps.length === 0) return NaN;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  let ssd = 0;
  for (const r of returns) ssd += (r - mean) * (r - mean);
  const variance = returns.length > 1 ? ssd / (returns.length - 1) : ssd;
  // Median gap (robust to outlier loop iterations).
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medGap = sortedGaps[Math.floor(sortedGaps.length / 2)]!;
  const samplesPerYear = (SECONDS_PER_YEAR * MS_PER_SECOND) / medGap;
  return Math.sqrt(variance * samplesPerYear);
}

/**
 * Predict ATM IV from a list of active oracles. Picks the SHORTEST-expiry
 * oracle (most relevant for near-term vol forecasting) and computes IV at
 * the strike closest to current spot:
 *
 *   k = ln(spot / forward)
 *   w = SVI total variance at k
 *   IV = √(w / T)
 *
 * Returns NaN if no usable oracle exists.
 */
export function computePredictAtmIv(
  oracles: OracleSnapshot[],
  nowMs: number,
): { iv: number; oracle: OracleSnapshot } | null {
  let best: { iv: number; oracle: OracleSnapshot; t: number } | null = null;
  for (const o of oracles) {
    if (o.isSettled) continue;
    const t = tYearsFromMs(o.expiryMs - nowMs);
    if (t <= 0) continue;
    const k = Math.log(o.spot / o.forward);
    const w = evalTotalVariance(k, o.svi);
    if (!isFinite(w) || w <= 0) continue;
    const iv = Math.sqrt(w / t);
    if (!isFinite(iv) || iv <= 0) continue;
    if (!best || t < best.t) best = { iv, oracle: o, t };
  }
  return best ? { iv: best.iv, oracle: best.oracle } : null;
}

/**
 * Predict's UP probability at the current spot (K = spot) — the bias
 * indicator we use to pick direction. > 0.5 means Predict says BTC is
 * more likely up than down; < 0.5 means the opposite.
 */
export function computePredictUpAtSpot(oracle: OracleSnapshot, nowMs: number): number {
  const t = tYearsFromMs(oracle.expiryMs - nowMs);
  if (t <= 0) return 0.5;
  const k = Math.log(oracle.spot / oracle.forward);
  const w = evalTotalVariance(k, oracle.svi);
  return binaryUpFromTotalVariance(oracle.spot, oracle.forward, w);
}

/**
 * Core decision function. Pure — depends only on inputs.
 *
 * Returns a VolArbDecision describing what the bot should do. The bot
 * loop is responsible for executing the action and recording the outcome.
 */
export function decide(input: {
  predictIv: number;
  realizedVol: number;
  predictUpAtSpot: number;
  hasOpenPosition: boolean;
  openPositionAgeMs?: number;
  cfg: Pick<
    SvxConfig,
    | 'volArbIvSpreadOpenThreshold'
    | 'volArbIvSpreadCloseThreshold'
    | 'volArbDirectionBiasThreshold'
    | 'volArbTimeStopMinutes'
  >;
  nowMs: number;
}): VolArbDecision {
  const { predictIv, realizedVol, predictUpAtSpot, hasOpenPosition, openPositionAgeMs, cfg, nowMs } = input;
  const ivSpread = predictIv - realizedVol;
  const baseDecision: Omit<VolArbDecision, 'action' | 'reason'> = {
    predictIv,
    realizedVol,
    ivSpread,
    predictUpAtSpot,
    ts: nowMs,
  };

  // No-data cases.
  if (!isFinite(predictIv) || !isFinite(realizedVol)) {
    return { ...baseDecision, action: 'hold', reason: 'waiting_for_data' };
  }

  // Position management — if we hold a vol-arb trade, only consider closing.
  if (hasOpenPosition) {
    // Time-stop.
    if (
      openPositionAgeMs != null &&
      openPositionAgeMs > cfg.volArbTimeStopMinutes * 60 * 1000
    ) {
      return {
        ...baseDecision,
        action: 'close',
        reason: `time_stop:${(openPositionAgeMs / 60_000).toFixed(0)}m`,
      };
    }
    // Signal weakened — IV-RV spread no longer significant.
    if (Math.abs(ivSpread) < cfg.volArbIvSpreadCloseThreshold) {
      return {
        ...baseDecision,
        action: 'close',
        reason: `spread_below_close_thresh:${(ivSpread * 100).toFixed(2)}%`,
      };
    }
    return { ...baseDecision, action: 'hold', reason: 'position_open_signal_still_valid' };
  }

  // No open position — consider opening.
  if (Math.abs(ivSpread) < cfg.volArbIvSpreadOpenThreshold) {
    return {
      ...baseDecision,
      action: 'hold',
      reason: `spread_below_open_thresh:${(ivSpread * 100).toFixed(2)}%`,
    };
  }
  if (Math.abs(predictUpAtSpot - 0.5) < cfg.volArbDirectionBiasThreshold) {
    return {
      ...baseDecision,
      action: 'hold',
      reason: `neutral_surface_bias:p_up=${(predictUpAtSpot * 100).toFixed(2)}%`,
    };
  }
  const direction = predictUpAtSpot > 0.5 ? 'open_long' : 'open_short';
  return {
    ...baseDecision,
    action: direction,
    reason: `vol_divergence:${(ivSpread * 100).toFixed(2)}%_bias:${(predictUpAtSpot * 100).toFixed(2)}%`,
  };
}

/** Convert a vol-arb USD notional to BTC size at a given spot price. */
export function btcSizeForUsdNotional(usdNotional: number, btcPrice: number): number {
  if (btcPrice <= 0) return 0;
  return usdNotional / btcPrice;
}

/** Initial state for a fresh bot boot. */
export function freshVolArbState(): VolArbState {
  return {
    midHistory: [],
    lastPredictIv: null,
    lastRealizedVol: null,
    lastDecision: null,
    recentDecisions: [],
  };
}

/** Record a decision in the ring buffer (max 100 entries). */
export function recordDecision(state: VolArbState, decision: VolArbDecision, acted: boolean): void {
  state.lastDecision = decision;
  state.lastPredictIv = isFinite(decision.predictIv) ? decision.predictIv : state.lastPredictIv;
  state.lastRealizedVol = isFinite(decision.realizedVol) ? decision.realizedVol : state.lastRealizedVol;
  state.recentDecisions.unshift({ ...decision, acted });
  if (state.recentDecisions.length > 100) state.recentDecisions.length = 100;
}
