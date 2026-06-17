/**
 * Tiny client-side API wrapper. Pure fetch, no caching. The dashboard is
 * read-only and polls every few seconds via SWR-like patterns.
 *
 * Two API instances ship by default:
 *   - `api`         → testnet Predict bot (NEXT_PUBLIC_SVX_API)
 *   - `apiMainnet`  → mainnet Polymarket bot (NEXT_PUBLIC_SVX_API_MAINNET)
 *
 * Pages under `/` use `api`; pages under `/mainnet` use `apiMainnet`. Both
 * URLs are baked into the client bundle at build time via Dockerfile.dashboard
 * args + docker-compose.
 */

const TESTNET_BASE = process.env.NEXT_PUBLIC_SVX_API ?? 'http://127.0.0.1:4321';
const MAINNET_BASE = process.env.NEXT_PUBLIC_SVX_API_MAINNET ?? '';

export interface BotStatus {
  startedAtMs: number;
  paused: boolean;
  pauseReason?: string;
  liveTradingEnabled: boolean;
  /** Operator wallet dUSDC balance. */
  navUsdc: number;
  /** dUSDC sitting inside the PredictManager (payouts from auto-redeem). */
  managerBalanceUsdc?: number;
  /** When manager balance was last refreshed from chain (ms). */
  managerBalanceAtMs?: number | null;
  /** wallet + manager — the operator's full bankroll. */
  totalBalanceUsdc?: number;
  /** All-time realized PnL across every settled trade (survives restarts). */
  realizedPnlUsdc: number;
  /** Realized PnL over the last rolling 24h — ties to the daily loss limit. */
  realizedPnl24hUsdc?: number;
  unrealizedPnlUsdc: number;
  openPositionCount: number;
  signalsLast24h: number;
  tradesLast24h: number;
  spotBtc: number | null;
  spotBtcAtMs: number | null;
  predictPackageId: string;
  /** Human label for this bot ("testnet", "mainnet", etc.) — null when unset. */
  instanceLabel?: string | null;
  // Polymarket execution leg.
  polyExecutionEnabled?: boolean;
  polyNetwork?: 'amoy' | 'polygon' | null;
  /** Funder address — where pUSD lives. Safe address in POLY_GNOSIS_SAFE mode. */
  polyAddress?: `0x${string}` | null;
  /** Signer address — the EOA whose private key the bot holds. */
  polySignerAddress?: `0x${string}` | null;
  polySignatureMode?: 'EOA' | 'POLY_PROXY' | 'POLY_GNOSIS_SAFE' | 'POLY_1271' | null;
  polyPusdBalance?: number | null;
  polyGasPol?: number | null;
  polyBalanceAtMs?: number | null;
  /** Cumulative HL taker fees deducted from PnL. */
  hlFeesUsdc?: number;
  /** Cumulative HL funding paid (positive) or received (negative). */
  hlFundingUsdc?: number;
  /** Realized Polymarket-leg PnL across all settled trades (pUSD). */
  realizedPolyPnlUsdc?: number;
  /** Rolling 24h realized Polymarket-leg PnL (pUSD) — feeds the daily limit. */
  realizedPolyPnl24hUsdc?: number;
  /** Configured daily loss limit (pUSD) for the Polymarket leg. */
  dailyPolyLossLimitUsdc?: number;
  // Hyperliquid hedge leg.
  hlExecutionEnabled?: boolean;
  hlNetwork?: 'mainnet' | 'testnet';
  hlHedgeAsset?: string;
  hlAddress?: `0x${string}` | null;
  hlAccountValueUsdc?: number | null;
  hlWithdrawableUsdc?: number | null;
  hlBalanceAtMs?: number | null;
  maxHlPerTradeUsdc?: number;
  maxHlOpenUsdc?: number;
  hlRequiredForPoly?: boolean;
  openHlExposureUsdc?: number;
  realizedHlPnlUsdc?: number;
  realizedHlPnl24hUsdc?: number;
  dailyHlLossLimitUsdc?: number;
  // Cross-venue combined (poly + hl) — the pure-vol PnL story.
  realizedCombinedPnlUsdc?: number;
  realizedCombinedPnl24hUsdc?: number;
  // Last-attempt timestamps + risk thresholds for the health panel.
  lastPolyAttemptAtMs?: number | null;
  lastHlAttemptAtMs?: number | null;
  maxPolyPositionUsdc?: number;
  maxOpenPolyPositions?: number;
  polyMinBookDepthShares?: number;
  spreadThreshold?: number;
}

export interface SignalRecord {
  id: string;
  timestampMs: number;
  oracleId: string;
  underlyingAsset: string;
  expiryMs: number;
  strike: number;
  predictDirection: 'up' | 'down';
  predictProb: number;
  predictIv: number;
  polyProb: number;
  polyIv: number;
  spread: number;
  ivSpread: number;
  action: string;
  filterReason?: string;
  notional?: number;
  costUsdc?: number;
}

export interface TradeRecord {
  id: string;
  signalId: string;
  timestampMs: number;
  mode: 'paper' | 'live';
  oracleId: string;
  underlyingAsset: string;
  expiryMs: number;
  strike: number;
  direction: 'up' | 'down';
  quantityDusdc: number;
  costPrice: number;
  costUsdc: number;
  txDigest?: string;
  settled: boolean;
  payoutUsdc?: number;
  pnlUsdc?: number;
  // Analytics — captured at execution time for math-validation / calibration.
  msToExpiryAtExec?: number;
  predictProbAtExec?: number;
  polyAskAtExec?: number;
  predictIvAtExec?: number;
  /** Predict-vs-Polymarket spread the bot saw when it pulled the trigger. */
  edgeAtExec?: number;
  // Polymarket execution leg (populated when POLY_EXECUTION_ENABLED).
  polyNetwork?: 'amoy' | 'polygon';
  polyTokenId?: string;
  polyConditionId?: string;
  polySide?: 'buy' | 'sell';
  polyOutcome?: 'yes' | 'no';
  polyOrderId?: string;
  polyFilledShares?: number;
  polyFillPrice?: number;
  polyCostUsdc?: number;
  polyTxHash?: string;
  polyStatus?: 'submitted' | 'filled' | 'failed' | 'partial';
  // Polymarket settlement (populated once UMA resolves the market).
  polySettled?: boolean;
  polySettledAtMs?: number;
  polySettlementOutcome?: 'yes' | 'no';
  polyPayoutUsdc?: number;
  polyPnlUsdc?: number;
  polyRedeemTxHash?: string;
  polyRedeemStatus?: 'pending' | 'success' | 'failed';
  // Hyperliquid hedge leg.
  hlAsset?: string;
  hlOrderId?: string;
  hlSize?: number;
  hlSide?: 'long' | 'short';
  hlOpenPrice?: number;
  hlClosePrice?: number;
  hlStatus?: 'open' | 'closed' | 'failed';
  hlPnlUsdc?: number;
  hlFundingPaidUsdc?: number;
  hlClosedAtMs?: number;
  /** Strategy that opened the trade. 'poly_arb' (original cross-venue) or
   *  'vol_arb' (standalone HL vol strategy). Defaults to 'poly_arb' on
   *  rows that pre-date the strategy tag (May 2026). */
  strategy?: 'poly_arb' | 'vol_arb';
}

export interface OracleSummary {
  oracleId: string;
  underlyingAsset: string;
  expiryMs: number;
  minStrike: number;
  tickSize: number;
  status: string;
  settlementPrice?: number;
}

export interface SurfacePoint {
  strike: number;
  iv: number;
  up: number;
}

export interface SurfaceResponse {
  oracleId: string;
  forward: number;
  spot: number;
  expiryMs: number;
  timestampMs: number;
  svi: { a: number; b: number; rho: number; m: number; sigma: number };
  points: SurfacePoint[];
}

/**
 * Truth-from-chain snapshot for the three operator wallets. Returned by
 * `GET /wallets`. Each block is null when the corresponding venue isn't
 * configured for this bot instance.
 */
/**
 * Vol-arb strategy state. Returned by `GET /strategy/vol-arb/state`.
 * The dashboard's /vol-arb page renders this end to end.
 */
export interface VolArbDecisionLog {
  ts: number;
  action: 'hold' | 'open_long' | 'open_short' | 'close';
  reason: string;
  predictIv: number;
  realizedVol: number;
  ivSpread: number;
  predictUpAtSpot: number;
  acted: boolean;
}

export interface VolArbStateResponse {
  enabled: boolean;
  thresholds: {
    openSpread: number;
    closeSpread: number;
    directionBias: number;
    timeStopMinutes: number;
    minSamples: number;
  };
  caps: {
    perTradeUsdc: number;
    totalUsdc: number;
    dailyLossUsdc: number;
  };
  state: {
    midHistory: Array<{ ts: number; price: number }>;
    lastPredictIv: number | null;
    lastRealizedVol: number | null;
    lastDecision: VolArbDecisionLog | null;
    recentDecisions: VolArbDecisionLog[];
  } | null;
  openPositions: TradeRecord[];
  closedPositions: TradeRecord[];
  openExposureUsdc: number;
  realizedPnl24hUsdc: number;
  realizedPnlUsdc: number;
}

export interface WalletsSnapshot {
  sui: null | {
    address: string;
    managerId: string | null;
    navUsdc: number;
    managerBalanceUsdc: number;
    managerBalanceAtMs: number | null;
    predictPackageId: string;
    paperTrading: boolean;
    openPositions: Array<{
      tradeId: string;
      oracleId: string;
      strike: number;
      direction: 'up' | 'down';
      quantity: number;
      cost: number;
      txDigest?: string;
    }>;
  };
  polygon: null | {
    address: `0x${string}`;
    signerAddress?: `0x${string}`;
    signatureMode?: 'EOA' | 'POLY_PROXY' | 'POLY_GNOSIS_SAFE' | 'POLY_1271';
    network: 'amoy' | 'polygon';
    pUsdBalance: number;
    polBalance: number;
    balanceAtMs: number;
    executionEnabled: boolean;
    openPositions: Array<{
      tradeId: string;
      conditionId?: string;
      outcome?: 'yes' | 'no';
      tokenId?: string;
      shares?: number;
      fillPrice?: number;
      costUsdc?: number;
      openedAtMs: number;
      polyTxHash?: string;
    }>;
  };
  hyperliquid: null | {
    address: `0x${string}`;
    network: 'mainnet' | 'testnet';
    accountValueUsdc: number;
    withdrawableUsdc: number;
    balanceAtMs: number;
    executionEnabled: boolean;
    ledgerHedges: Array<{
      tradeId: string;
      asset?: string;
      side?: 'long' | 'short';
      size?: number;
      openPrice?: number;
      orderId?: string;
      openedAtMs: number;
    }>;
    chainPositions: null | Array<{
      asset: string;
      side: 'long' | 'short';
      szi: number;
      entryPx: number;
      unrealizedPnlUsd: number;
      cumFundingUsdc: number;
    }>;
  };
}

function makeGet(base: string) {
  return async function get<T>(path: string): Promise<T> {
    if (!base) throw new Error(`API base URL not configured for ${path}`);
    const res = await fetch(`${base}${path}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    return res.json();
  };
}

/**
 * Build an API client for the given bot base URL. Each route group on the
 * dashboard wires up its own client (testnet predict bot, mainnet polymarket
 * bot, etc.) so a single Next.js deployment can poll multiple bots.
 */
export function createApi(base: string) {
  const get = makeGet(base);
  return {
    /** True when this client has a configured base URL — false for the mainnet
     *  client when NEXT_PUBLIC_SVX_API_MAINNET wasn't set at build time. */
    enabled: !!base,
    base,
    status: () => get<BotStatus>('/status'),
    signals: (limit = 100) => get<SignalRecord[]>(`/signals?limit=${limit}`),
    positionsOpen: () => get<TradeRecord[]>('/positions/open'),
    positionsClosed: (limit = 500) => get<TradeRecord[]>(`/positions/closed?limit=${limit}`),
    positionsClosedPoly: (limit = 500) =>
      get<TradeRecord[]>(`/positions/closed-poly?limit=${limit}`),
    positionsHlOpen: () => get<TradeRecord[]>('/positions/hl-open'),
    wallets: () => get<WalletsSnapshot>('/wallets'),
    volArbState: () => get<VolArbStateResponse>('/strategy/vol-arb/state'),
    oracles: () => get<OracleSummary[]>('/oracles'),
    surface: (oracleId: string) => get<SurfaceResponse>(`/surface/${oracleId}`),
  };
}

export type ApiClient = ReturnType<typeof createApi>;

/** Default — used by every page under `/` (testnet Predict bot). */
export const api = createApi(TESTNET_BASE);

/** Used by every page under `/mainnet/*` (mainnet Polymarket bot). */
export const apiMainnet = createApi(MAINNET_BASE);

export function formatUsdc(x: number | undefined | null, places = 2): string {
  if (x == null || !isFinite(x)) return '—';
  return x.toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}
export function formatPct(x: number | undefined | null, places = 2): string {
  if (x == null || !isFinite(x)) return '—';
  return `${(x * 100).toFixed(places)}%`;
}
export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString();
}
export function formatRelative(ms: number, nowMs = Date.now()): string {
  const sec = Math.round((nowMs - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}
