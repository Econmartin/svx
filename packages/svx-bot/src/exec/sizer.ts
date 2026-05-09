/**
 * Position sizing. Fixed-fraction with hard caps. NO Kelly until v2.
 *
 * Every input/output is in dUSDC notional units (i.e. max payout = quantity).
 */

import type { SvxConfig } from '../config.js';

export interface SizerInput {
  /** Bot NAV in dUSDC (real or paper). */
  navUsdc: number;
  /** dUSDC budget already used today. */
  budgetUsedToday: number;
  /** Daily budget cap (dUSDC). */
  dailyBudget: number;
  /** Strategy edge in probability points (e.g. 0.05 = 5%). */
  edge: number;
  /** Per-unit cost: ask price for the side we're buying. */
  costPrice: number;
  cfg: SvxConfig;
}

export interface SizerOutput {
  /** Position notional (max payout) in dUSDC. */
  quantityDusdc: number;
  /** Cost in dUSDC. */
  costUsdc: number;
}

export function sizeTrade(input: SizerInput): SizerOutput {
  const { navUsdc, budgetUsedToday, dailyBudget, edge, costPrice, cfg } = input;
  const remainingDailyBudget = Math.max(0, dailyBudget - budgetUsedToday);
  const navCap = navUsdc * cfg.maxPositionPct;

  // Edge-aware throttling — bigger edge → larger size, but capped.
  // For a 3% threshold and 10% edge, size is 1.5×; clamp at 2× max.
  const edgeMultiplier = Math.min(2, Math.max(0.5, edge / cfg.spreadThreshold));

  // Notional in dUSDC. We're buying `quantity` units at `costPrice` per unit,
  // so cost = quantity * costPrice. Solve quantity from each cap.
  const fixedNotional = cfg.maxPositionDusdc * edgeMultiplier;
  const navNotional = navCap; // navCap is in dUSDC and represents max cost we'll accept
  const dailyNotional = remainingDailyBudget; // remaining cost budget today

  // Convert "cost cap" to "notional cap" — we want max payout up to (cap / costPrice).
  // For binaries, costPrice ∈ (0,1), so notional > cost always. cap_notional = cap_cost / costPrice.
  const costCap = Math.min(fixedNotional * costPrice, navNotional, dailyNotional);
  if (costCap <= 0 || costPrice <= 0) {
    return { quantityDusdc: 0, costUsdc: 0 };
  }

  const quantity = costCap / costPrice;
  const cost = quantity * costPrice;
  return {
    quantityDusdc: round2(quantity),
    costUsdc: round2(cost),
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
