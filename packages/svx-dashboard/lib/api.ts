/**
 * Tiny client-side API wrapper. Pure fetch, no caching. The dashboard is
 * read-only and polls every few seconds via SWR-like patterns.
 */

const BASE = process.env.NEXT_PUBLIC_SVX_API ?? 'http://127.0.0.1:4321';

export interface BotStatus {
  startedAtMs: number;
  paused: boolean;
  pauseReason?: string;
  liveTradingEnabled: boolean;
  navUsdc: number;
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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  status: () => get<BotStatus>('/status'),
  signals: (limit = 100) => get<SignalRecord[]>(`/signals?limit=${limit}`),
  positionsOpen: () => get<TradeRecord[]>('/positions/open'),
  positionsClosed: (limit = 500) => get<TradeRecord[]>(`/positions/closed?limit=${limit}`),
  oracles: () => get<OracleSummary[]>('/oracles'),
  surface: (oracleId: string) => get<SurfaceResponse>(`/surface/${oracleId}`),
};

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
