/**
 * Shared backtest compute — replays the recorded signal stream against
 * recorded oracle settlements. Used by both scripts/backtest.ts (CLI, CSV
 * output) and the read-only GET /backtest API endpoint (so the deployed
 * bot's OWN ledger can be backtested without pulling the sqlite file off
 * the server).
 *
 * Three sides:
 *  - predict: bet `predict_direction` — the Predict leg of the cross-venue
 *    arb. Which side that is depends on which venue is quoting rich, so its
 *    performance flips sign between regimes (−49% on May-2026 data, +19% on
 *    July-2026 data). Kept as the baseline, not a strategy.
 *  - flip:    bet the opposite of `predict_direction`. Same regime problem,
 *    mirrored (+8% May, −56% July).
 *  - favored: bet whichever side Predict prices ABOVE 50¢. This is the
 *    regime-stable formulation of the divergence edge: at ≥8pp divergence
 *    from Polymarket, Predict's favorite is directionally right but
 *    UNDERCONFIDENT (quoted ~74–76¢, realizes ~84–88%) in BOTH windows —
 *    the "divergence-mint" candidate strategy.
 */

export interface BacktestSignalRow {
  tsMs: number;
  oracleId: string;
  strike: number;
  predictDirection: 'up' | 'down';
  /** P(up) per Predict's surface at signal time. */
  predictProb: number;
  polyProb: number;
  spread: number;
}

export type BacktestSide = 'predict' | 'flip' | 'favored';

export interface BacktestArgs {
  /** Min |spread| for a signal to fire. */
  threshold: number;
  /** Which side of the divergence to bet — see module doc. */
  side: BacktestSide;
  /** One bet per (oracle, strike, direction) — first observation only.
   *  Without this the 15s loop's re-logging inflates n ~40×. */
  dedupe: boolean;
  /** Cost markup fraction approximating the protocol fee (UP+DOWN > 1). */
  fee: number;
  /** Simulated dUSDC notional per trade. */
  notional: number;
}

export interface BacktestTrade {
  ts: number;
  oracleId: string;
  strike: number;
  direction: 'up' | 'down';
  predictProb: number;
  polyProb: number;
  spread: number;
  costPrice: number;
  cost: number;
  settlement: number | undefined;
  outcome: 'win' | 'loss' | 'open';
  payout: number;
  pnl: number | null;
}

export interface BacktestSummary {
  threshold: number;
  side: BacktestSide;
  dedupe: boolean;
  fee: number;
  notional_per_trade: number;
  signals_with_spread: number;
  would_fire: number;
  fire_rate: number;
  settled_trades: number;
  still_open: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  avg_cost_price: number | null;
  total_cost_usdc: number;
  total_pnl_usdc: number;
  roi: number | null;
  /** Time span of the signal data the backtest saw — read this before
   *  trusting the stats: retention pruning bounds how far back it goes. */
  data_window: { firstTsIso: string | null; lastTsIso: string | null };
}

export function computeBacktest(
  signals: BacktestSignalRow[],
  settlements: Map<string, number>,
  args: BacktestArgs,
): { summary: BacktestSummary; trades: BacktestTrade[] } {
  let wouldFire = signals.filter((s) => s.spread >= args.threshold);

  if (args.dedupe) {
    const seen = new Set<string>();
    wouldFire = wouldFire.filter((s) => {
      const key = `${s.oracleId}|${s.strike}|${s.predictDirection}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const trades: BacktestTrade[] = wouldFire.map((s) => {
    const betDirection: 'up' | 'down' =
      args.side === 'favored'
        ? s.predictProb >= 0.5 ? 'up' : 'down'
        : args.side === 'flip'
          ? s.predictDirection === 'up' ? 'down' : 'up'
          : s.predictDirection;
    const rawCostPrice = betDirection === 'up' ? s.predictProb : 1 - s.predictProb;
    const costPrice = rawCostPrice * (1 + args.fee);
    const cost = args.notional * costPrice;
    const settlement = settlements.get(s.oracleId);
    let outcome: 'win' | 'loss' | 'open' = 'open';
    let payout = 0;
    if (settlement !== undefined) {
      const upWon = settlement > s.strike;
      const won = betDirection === 'up' ? upWon : !upWon;
      outcome = won ? 'win' : 'loss';
      payout = won ? args.notional : 0;
    }
    return {
      ts: s.tsMs,
      oracleId: s.oracleId,
      strike: s.strike,
      direction: betDirection,
      predictProb: s.predictProb,
      polyProb: s.polyProb,
      spread: s.spread,
      costPrice,
      cost,
      settlement,
      outcome,
      payout,
      pnl: outcome === 'open' ? null : payout - cost,
    };
  });

  const closed = trades.filter((t) => t.outcome !== 'open');
  const wins = closed.filter((t) => t.outcome === 'win').length;
  const losses = closed.length - wins;
  const totalPnl = closed.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
  const totalCost = closed.reduce((acc, t) => acc + t.cost, 0);

  // Loop, not Math.min(...spread) — spreading 200k+ elements onto the call
  // stack overflows it.
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  for (const s of signals) {
    if (firstTs === null || s.tsMs < firstTs) firstTs = s.tsMs;
    if (lastTs === null || s.tsMs > lastTs) lastTs = s.tsMs;
  }

  return {
    summary: {
      threshold: args.threshold,
      side: args.side,
      dedupe: args.dedupe,
      fee: args.fee,
      notional_per_trade: args.notional,
      signals_with_spread: signals.length,
      would_fire: wouldFire.length,
      fire_rate: signals.length > 0 ? wouldFire.length / signals.length : 0,
      settled_trades: closed.length,
      still_open: trades.length - closed.length,
      wins,
      losses,
      win_rate: closed.length ? wins / closed.length : null,
      avg_cost_price: closed.length
        ? closed.reduce((a, t) => a + t.costPrice, 0) / closed.length
        : null,
      total_cost_usdc: round(totalCost, 4),
      total_pnl_usdc: round(totalPnl, 4),
      roi: totalCost > 0 ? round(totalPnl / totalCost, 4) : null,
      data_window: {
        firstTsIso: firstTs != null ? new Date(firstTs).toISOString() : null,
        lastTsIso: lastTs != null ? new Date(lastTs).toISOString() : null,
      },
    },
    trades,
  };
}

function round(x: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(x * m) / m;
}
