/**
 * Data-quality filters applied AFTER spread computation but BEFORE sizing/exec.
 * Returns the first failed reason (or null = pass).
 */

import type { FilterReason, OracleSnapshot, PolymarketSnapshot } from 'svx-shared/types';
import type { SvxConfig } from '../config.js';

export interface FilterInput {
  oracleSnapshot: OracleSnapshot;
  polymarketSnapshot: PolymarketSnapshot;
  expiryDeltaMs: number;
  cfg: SvxConfig;
  /** Predict's UP probability at the matched strike (already computed). */
  predictProb?: number;
  nowMs?: number;
}

export function applyFilters(input: FilterInput): FilterReason | null {
  const { oracleSnapshot: o, polymarketSnapshot: p, expiryDeltaMs, cfg, predictProb } = input;
  const now = input.nowMs ?? Date.now();

  if (now - o.timestampMs > cfg.maxSviStalenessSec * 1000) return 'svi_stale';

  // Polymarket book sanity.
  if (p.yesAsk <= 0 || p.yesBid <= 0 || p.yesAsk >= 1 || p.yesBid >= 1) return 'poly_one_sided';
  if (p.yesAsk - p.yesBid > cfg.polyMaxBidaskVolPts) return 'poly_wide_spread';
  if (p.volume24hUsd < cfg.polyMinVolume24hUsd) return 'poly_low_volume';

  if (Math.abs(expiryDeltaMs) > cfg.expiryToleranceSec * 1000) return 'expiry_mismatch';

  // Settled oracle = no live trade.
  if (o.isSettled) return 'expiry_mismatch';

  // Deep ITM/OTM: protocol rejects asks > 99% or < 1%, and edge is meaningless
  // when predictProb is near a boundary. Backtest showed these as zero-edge
  // wins from $76k-when-spot-is-$80k strikes.
  if (predictProb !== undefined) {
    if (predictProb > cfg.maxPredictProb) return 'poly_one_sided';
    if (predictProb < cfg.minPredictProb) return 'poly_one_sided';
  }

  return null;
}
