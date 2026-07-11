/**
 * Three-protocol margin loop SIMULATION — idea bank #4: borrow dUSDC on
 * `deepbook_margin` against an `iron_bank` USDsui share, deploy the borrow
 * into Predict strategy clips, repay from settlement payouts.
 *
 * The strategy leg is REAL: per-trade ROI, hold times, and deployment rate
 * come from this bot's own settled favored-side trades (divergence-mint +
 * calibration-harvest). The borrow APR is an explicit input (labeled as an
 * assumption in the output) because deepbook_margin exposes no public rate
 * feed yet — reading it on-chain is the go-live TODO. The loop stays
 * simulated regardless until Predict ships Sui mainnet: deepbook_margin is
 * mainnet, Predict is testnet — the borrow and the deployment can't touch
 * the same real dollar today. The old margin-lever intent builders
 * (exec/deepbook-margin-client.ts, iron-bank-client.ts) are the execution
 * path when they can.
 */

export interface SettledStrategyTrade {
  tsMs: number;
  settledAtMs: number;
  costUsdc: number;
  pnlUsdc: number;
}

export interface MarginLoopArgs {
  /** Collateral posted (USDsui share value backing the borrow), dUSDC-equivalent. */
  collateralUsdc: number;
  /** Borrow as a fraction of collateral. */
  ltv: number;
  /** ASSUMED deepbook_margin borrow APR — no public rate feed exists yet. */
  borrowApr: number;
}

export interface MarginLoopSummary {
  strategy: {
    trades: number;
    window_days: number | null;
    roi_per_trade: number | null;
    win_rate: number | null;
    avg_hold_hours: number | null;
    /** Average concurrent capital the strategy actually had at risk. */
    typical_open_exposure_usdc: number | null;
    daily_pnl_usdc: number | null;
    annualized_pnl_usdc: number | null;
    worst_day_pnl_usdc: number | null;
  };
  loop: {
    collateral_usdc: number;
    ltv: number;
    borrowed_usdc: number;
    borrow_apr_assumed: number;
    interest_per_year_usdc: number;
    /** How much of the borrow the observed signal flow can actually deploy. */
    utilization: number | null;
    /** (funded strategy PnL − interest) / collateral. */
    levered_net_apy: number | null;
    /** Strategy PnL / typical exposure — the unlevered comparator. */
    unlevered_apy: number | null;
  };
  note: string;
  data_window: { firstTsIso: string | null; lastTsIso: string | null };
}

export function computeMarginLoopSim(
  trades: SettledStrategyTrade[],
  args: MarginLoopArgs,
): MarginLoopSummary {
  const YEAR_MS = 365.25 * 24 * 3600 * 1000;
  const valid = trades.filter(
    (t) => t.settledAtMs > t.tsMs && t.costUsdc > 0 && isFinite(t.pnlUsdc),
  );

  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let cost = 0;
  let pnl = 0;
  let holdMsSum = 0;
  let exposureMsSum = 0; // Σ cost × holdMs — integrates concurrent exposure
  let wins = 0;
  const byDay = new Map<number, number>();
  for (const t of valid) {
    if (firstTs === null || t.tsMs < firstTs) firstTs = t.tsMs;
    if (lastTs === null || t.settledAtMs > lastTs) lastTs = t.settledAtMs;
    cost += t.costUsdc;
    pnl += t.pnlUsdc;
    if (t.pnlUsdc > 0) wins++;
    const holdMs = t.settledAtMs - t.tsMs;
    holdMsSum += holdMs;
    exposureMsSum += t.costUsdc * holdMs;
    const day = Math.floor(t.settledAtMs / (24 * 3600 * 1000));
    byDay.set(day, (byDay.get(day) ?? 0) + t.pnlUsdc);
  }

  const windowMs = firstTs != null && lastTs != null ? lastTs - firstTs : 0;
  const windowDays = windowMs > 0 ? windowMs / (24 * 3600 * 1000) : null;
  const typicalExposure = windowMs > 0 ? exposureMsSum / windowMs : null;
  const dailyPnl = windowDays && windowDays > 0 ? pnl / windowDays : null;
  const annualPnl = dailyPnl != null ? dailyPnl * 365.25 : null;
  const worstDay = byDay.size ? Math.min(...byDay.values()) : null;

  const borrowed = args.collateralUsdc * args.ltv;
  const interest = borrowed * args.borrowApr;
  // The borrow can only earn where the signal flow deploys it.
  const utilization =
    typicalExposure != null && borrowed > 0 ? Math.min(1, typicalExposure / borrowed) : null;
  const fundedAnnualPnl =
    annualPnl != null && typicalExposure != null && typicalExposure > 0
      ? annualPnl * Math.min(1, borrowed / typicalExposure)
      : null;
  const leveredNetApy =
    fundedAnnualPnl != null && args.collateralUsdc > 0
      ? (fundedAnnualPnl - interest) / args.collateralUsdc
      : null;
  const unleveredApy =
    annualPnl != null && typicalExposure != null && typicalExposure > 0
      ? annualPnl / typicalExposure
      : null;

  return {
    strategy: {
      trades: valid.length,
      window_days: windowDays != null ? round(windowDays, 2) : null,
      roi_per_trade: cost > 0 ? round(pnl / cost, 4) : null,
      win_rate: valid.length ? round(wins / valid.length, 4) : null,
      avg_hold_hours: valid.length ? round(holdMsSum / valid.length / 3600_000, 2) : null,
      typical_open_exposure_usdc: typicalExposure != null ? round(typicalExposure, 2) : null,
      daily_pnl_usdc: dailyPnl != null ? round(dailyPnl, 4) : null,
      annualized_pnl_usdc: annualPnl != null ? round(annualPnl, 2) : null,
      worst_day_pnl_usdc: worstDay != null ? round(worstDay, 4) : null,
    },
    loop: {
      collateral_usdc: args.collateralUsdc,
      ltv: args.ltv,
      borrowed_usdc: round(borrowed, 2),
      borrow_apr_assumed: args.borrowApr,
      interest_per_year_usdc: round(interest, 2),
      utilization: utilization != null ? round(utilization, 4) : null,
      levered_net_apy: leveredNetApy != null ? round(leveredNetApy, 4) : null,
      unlevered_apy: unleveredApy != null ? round(unleveredApy, 4) : null,
    },
    note:
      'SIMULATION. Borrow APR is an assumption (deepbook_margin has no public rate feed); ' +
      'the loop cannot go live until Predict ships Sui mainnet — deepbook_margin (mainnet) and ' +
      'Predict (testnet) cannot touch the same real dollar today. Strategy leg is real: this ' +
      "bot's own settled favored-side trades.",
    data_window: {
      firstTsIso: firstTs != null ? new Date(firstTs).toISOString() : null,
      lastTsIso: lastTs != null ? new Date(lastTs).toISOString() : null,
    },
  };
}

function round(x: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(x * m) / m;
}
