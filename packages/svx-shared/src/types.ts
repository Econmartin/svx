/**
 * Types shared across the bot, shared lib, dashboard, and API.
 * Wire format conventions:
 *  - Prices and probabilities: number in [0, 1] (already de-scaled from 1e9).
 *  - IVs: number in vol points (e.g. 0.65 = 65% annualized).
 *  - Quantities/notionals: number in dUSDC (de-scaled from 1e6).
 *  - On-chain raw values keep their u64 bigint encoding.
 */

/** Raw SVI parameters as scaled u64 from on-chain `OracleSVIUpdated`. */
export interface RawSVIParams {
  a: bigint;       // u64
  b: bigint;       // u64
  rho: bigint;     // signed (mag * sign), here as JS signed number
  m: bigint;       // signed
  sigma: bigint;   // u64
}

/** SVI parameters in floating-point. */
export interface SVIParams {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

export interface OracleSnapshot {
  oracleId: string;
  underlyingAsset: string; // e.g. "BTC"
  expiryMs: number;
  spot: number;
  forward: number;
  svi: SVIParams;
  /** Last on-chain update timestamp (ms). */
  timestampMs: number;
  /** True iff the protocol has settled this oracle. */
  isSettled: boolean;
  settlementPrice?: number;
}

export interface PolymarketSnapshot {
  conditionId: string;
  marketSlug?: string;
  /** Strike in $ on the underlying. e.g. 70000. */
  strike: number;
  /** Expiry timestamp (ms). */
  expiryMs: number;
  /** "Yes" outcome here always means "underlying > strike at expiry". */
  yesBid: number; // 0..1
  yesAsk: number;
  yesBidSize: number;
  yesAskSize: number;
  noBid: number;
  noAsk: number;
  /** Optional — recent additions, omitted by older readers. Computed from
   *  the No-side order book when present; otherwise execution code falls
   *  back to mirroring yesBidSize / yesAskSize. */
  noBidSize?: number;
  noAskSize?: number;
  /** Trailing-24h notional volume in USD on this market. */
  volume24hUsd: number;
  fetchedAtMs: number;
  /** CLOB token IDs for the Yes/No outcomes — required to submit orders. */
  yesTokenId?: string;
  noTokenId?: string;
}

export type SignalAction =
  | 'sub_threshold'
  | 'filtered'
  | 'paper_executed'
  | 'live_executed'
  | 'failed';

export type FilterReason =
  | 'svi_stale'
  | 'poly_one_sided'
  | 'poly_wide_spread'
  | 'poly_low_volume'
  | 'expiry_mismatch'
  | 'risk_gate'
  | 'duplicate'
  | 'paused';

export interface SignalRecord {
  id: string;
  timestampMs: number;
  oracleId: string;
  underlyingAsset: string;
  expiryMs: number;
  strike: number;
  /** Direction of the trade we'd take: 'up' = buy UP on Predict / "Yes" on Poly. */
  predictDirection: 'up' | 'down';
  /** Probability that the strike resolves UP per Predict's surface. */
  predictProb: number;
  /** Implied annualized vol per Predict at this strike. */
  predictIv: number;
  /** Polymarket ask for the matching outcome (the price you'd actually pay). */
  polyProb: number;
  polyIv: number;
  /** predictProb - polyProb (positive => Predict thinks more likely than Poly) */
  spread: number;
  ivSpread: number;
  /** Action taken given current filters/risk. */
  action: SignalAction;
  /** If filtered, why? */
  filterReason?: FilterReason;
  notional?: number;
  costUsdc?: number;
}

export interface TradeRecord {
  id: string;
  signalId: string;
  timestampMs: number;
  /** 'paper' or 'live'. */
  mode: 'paper' | 'live';
  oracleId: string;
  underlyingAsset: string;
  expiryMs: number;
  strike: number;
  direction: 'up' | 'down';
  /** Notional in dUSDC quote units (i.e. max payout). */
  quantityDusdc: number;
  /** Price paid per unit (in [0, 1]). */
  costPrice: number;
  /** Total cost in dUSDC (= quantity * costPrice). */
  costUsdc: number;
  /** Optional on-chain digest if mode='live'. */
  txDigest?: string;
  /** Filled at settlement once known. */
  settled: boolean;
  payoutUsdc?: number;
  pnlUsdc?: number;
  /** Underlying spot at settlement. Null until settled. */
  settlementPrice?: number;
  /** When settlement was detected by the bot (ms). */
  settledAtMs?: number;
  /** Captured at execution time — used by the analytics/calibration page. */
  msToExpiryAtExec?: number;
  predictProbAtExec?: number;
  polyAskAtExec?: number;
  predictIvAtExec?: number;
  /** Spread (probability points) the signal claimed at execution. */
  edgeAtExec?: number;
  /** Tx digest of the on-chain redeem call (live mode only, after settle). */
  redeemTxDigest?: string;

  // === Polymarket execution leg (populated when POLY_EXECUTION_ENABLED) ===
  /** Network the Polymarket order was placed on. */
  polyNetwork?: 'amoy' | 'polygon';
  /** Polymarket CLOB token ID we traded (Yes or No outcome). */
  polyTokenId?: string;
  /** Polymarket condition ID (the market). */
  polyConditionId?: string;
  /** 'buy' (long Yes/No) or 'sell' (short Yes/No). */
  polySide?: 'buy' | 'sell';
  /** 'yes' or 'no' — which outcome we traded. */
  polyOutcome?: 'yes' | 'no';
  /** Polymarket order id returned by the CLOB. */
  polyOrderId?: string;
  /** Shares actually filled (may be partial for FAK; FOK is all-or-nothing). */
  polyFilledShares?: number;
  /** Average fill price (probability, 0..1). */
  polyFillPrice?: number;
  /** Total pUSD spent (BUY) or received (SELL). */
  polyCostUsdc?: number;
  /** Polygon tx hash for the on-chain settlement of the fill. */
  polyTxHash?: string;
  /** Status of the Poly leg: 'submitted' | 'filled' | 'failed' | 'partial'. */
  polyStatus?: 'submitted' | 'filled' | 'failed' | 'partial';

  // === Polymarket settlement leg (populated by the settlement-poll loop) ===
  /** True once UMA has resolved the market and we've recorded payout/PnL. */
  polySettled?: boolean;
  /** Wall-clock when we recorded settlement (ms). */
  polySettledAtMs?: number;
  /** Winning outcome — 'yes' = "BTC above strike", 'no' = the other side. */
  polySettlementOutcome?: 'yes' | 'no';
  /** pUSD payout = filled_shares * (won ? 1 : 0). */
  polyPayoutUsdc?: number;
  /** Realized Poly-leg PnL = payout - poly_cost_usdc. Drives daily-loss gate. */
  polyPnlUsdc?: number;
  /** Polygon tx hash of the CTF redeemPositions call. */
  polyRedeemTxHash?: string;
  /** 'success' | 'failed' | 'pending'. 'pending' = waiting on next sweep. */
  polyRedeemStatus?: 'pending' | 'success' | 'failed';

  // === Hyperliquid delta-hedge leg (Part 2) ===
  /** Asset on Hyperliquid — defaults to 'BTC' today. */
  hlAsset?: string;
  /** HL order ID returned by the exchange API. */
  hlOrderId?: string;
  /** Hedge size in base currency (e.g. BTC). */
  hlSize?: number;
  /** 'long' | 'short' — opposite of the Polymarket-side directional exposure. */
  hlSide?: 'long' | 'short';
  /** Avg fill price (USDC) when the hedge opened. */
  hlOpenPrice?: number;
  /** Avg fill price (USDC) when the hedge closed at settlement. */
  hlClosePrice?: number;
  /** 'open' | 'closed' | 'failed'. */
  hlStatus?: 'open' | 'closed' | 'failed';
  /** Realized HL leg PnL — drives the daily HL loss gate. */
  hlPnlUsdc?: number;
  /** Cumulative funding paid while the position was open (positive = cost). */
  hlFundingPaidUsdc?: number;
  /** When the HL leg closed (ms). */
  hlClosedAtMs?: number;

  /** Which strategy opened this trade. Defaults to 'poly_arb' (the original
   *  Predict×Polymarket arb). 'vol_arb' is the standalone HL vol strategy;
   *  'convergence' is the near-expiry Polymarket certainty-discount buyer. */
  strategy?: 'poly_arb' | 'vol_arb' | 'convergence';
  /** Highest mark-to-market P&L fraction seen on the poly leg — drives the
   *  trailing ratchet exit (lock +20%, +40%, ... as the trade runs). */
  polyHighWaterFrac?: number;
}

export interface RiskDecision {
  ok: boolean;
  reason?: string;
}

export interface BotStatus {
  startedAtMs: number;
  paused: boolean;
  pauseReason?: string;
  liveTradingEnabled: boolean;
  navUsdc: number;
  realizedPnlUsdc: number;
  unrealizedPnlUsdc: number;
  openPositionCount: number;
  signalsLast24h: number;
  tradesLast24h: number;
  lastSignalAtMs?: number;
  lastTradeAtMs?: number;
  lastSviUpdateAtMs?: number;
  predictPackageId: string;
}
