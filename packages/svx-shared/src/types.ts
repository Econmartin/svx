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
  /** Trailing-24h notional volume in USD on this market. */
  volume24hUsd: number;
  fetchedAtMs: number;
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
