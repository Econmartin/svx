/**
 * Divergence-mint strategy — mint Predict's favorite when the venues disagree.
 *
 * The edge
 * --------
 * When Predict's SVI-implied probability and the Polymarket book disagree by
 * ≥8pp on the same (strike, expiry), Predict's FAVORITE (the side it prices
 * above 50¢) is directionally right but underconfident: quoted ~74–84¢, it
 * realizes 84–94%. Validated on two disjoint windows of recorded signals:
 *
 *   May 2026  (n=50 deduped, settled): 94.0% win, +11.9% ROI after 2% fee
 *   July 2026 (n=24 deduped, settled): ~87.5% win, ~+18% ROI after 2% fee
 *
 * The formulation matters. Betting the arb's Predict LEG (`predict_direction`)
 * or its mirror both flip sign between those windows, because which side the
 * leg points at depends on which venue happens to be quoting rich. "Bet the
 * side Predict prices above 50¢" is the regime-stable version — reproduce it
 * any time with `GET /backtest?side=favored&dedupe=true&fee=0.02`.
 *
 * Risk shape
 * ----------
 * Win: +(1 − cost) per share, cost ~0.74–0.84 → +19–35% per trade.
 * Loss: −cost (the favorite loses ~6–16% of the time). One bet per
 * (oracle, strike) — the 15s loop re-observes the same opportunity dozens of
 * times and stacking those would be leverage on one coin flip, not n bets.
 *
 * This module is pure math — no side effects, no I/O. Bot-loop wiring is in
 * index.ts (the divergence-mint block inside the match loop).
 */

export interface DivergenceMintCfg {
  /** Min |Predict − Polymarket| probability divergence to act on. */
  divergenceMintThreshold: number;
  /** Refuse entries above this favored-side price (no payoff room left). */
  divergenceMintMaxCostPrice: number;
  /** dUSDC notional per trade (fixed clip). */
  divergenceMintNotionalDusdc: number;
  /** Max simultaneous open divergence-mint positions. */
  divergenceMintMaxOpen: number;
  /** Stand down when the strategy's realized 24h PnL is at/below −this. */
  divergenceMintDailyLossLimitDusdc: number;
}

export interface DivergenceMintDecision {
  enter: boolean;
  /** The favored side — the direction Predict prices above 50¢. */
  direction: 'up' | 'down';
  /** Fair-price proxy for the favored side (protocol fee comes on top). */
  costPrice: number;
  divergence: number;
  reason: string;
}

/**
 * Core decision. `divergence` is the observed |Predict − Poly| spread the
 * signal stream records (same quantity the backtest fires on, so live
 * behavior and backtest stay comparable). All rejections carry a reason.
 */
export function decideDivergenceMint(input: {
  /** P(up) per Predict's SVI surface. */
  predictUp: number;
  /** Observed cross-venue divergence in probability points. */
  divergence: number;
  expiryMs: number;
  nowMs: number;
  /** An open divergence-mint trade already exists on this (oracle, strike). */
  hasOpenForSignal: boolean;
  /** Current count of open divergence-mint positions. */
  openStrategyCount: number;
  /** Realized divergence-mint PnL over the trailing 24h (dUSDC, ≤0 when losing). */
  dailyStrategyPnlUsdc: number;
  cfg: DivergenceMintCfg;
}): DivergenceMintDecision {
  const { predictUp, divergence, cfg } = input;
  const direction: 'up' | 'down' = predictUp >= 0.5 ? 'up' : 'down';
  const costPrice = direction === 'up' ? predictUp : 1 - predictUp;
  const base = { direction, costPrice, divergence };

  if (!isFinite(predictUp) || predictUp <= 0 || predictUp >= 1) {
    return { ...base, enter: false, reason: 'bad_predict_prob' };
  }
  if (input.expiryMs <= input.nowMs) {
    return { ...base, enter: false, reason: 'expired' };
  }
  if (divergence < cfg.divergenceMintThreshold) {
    return {
      ...base,
      enter: false,
      reason: `sub_threshold:${divergence.toFixed(3)}<${cfg.divergenceMintThreshold}`,
    };
  }
  if (costPrice > cfg.divergenceMintMaxCostPrice) {
    return { ...base, enter: false, reason: `too_rich:${costPrice.toFixed(3)}` };
  }
  if (input.hasOpenForSignal) {
    return { ...base, enter: false, reason: 'already_open_for_signal' };
  }
  if (input.openStrategyCount >= cfg.divergenceMintMaxOpen) {
    return {
      ...base,
      enter: false,
      reason: `max_open:${input.openStrategyCount}>=${cfg.divergenceMintMaxOpen}`,
    };
  }
  if (input.dailyStrategyPnlUsdc <= -cfg.divergenceMintDailyLossLimitDusdc) {
    return {
      ...base,
      enter: false,
      reason: `daily_loss_limit:${input.dailyStrategyPnlUsdc.toFixed(2)}`,
    };
  }
  return {
    ...base,
    enter: true,
    reason: `divergence_mint:${(divergence * 100).toFixed(1)}pp_fav_${direction}@${costPrice.toFixed(2)}`,
  };
}
