/**
 * DeepBook Predict server client.
 *
 * Wraps the public REST surface at `predict-server.testnet.mystenlabs.com`.
 * All on-chain numeric fields come back scaled by 1e9 (per the protocol's
 * FLOAT_SCALING convention — see `svx-shared/constants.ts`). This client
 * de-scales into floating-point at the boundary so downstream code never
 * sees raw u64s.
 */

import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { ADDRESSES, PREDICT_ENDPOINTS } from 'svx-shared/addresses';
import { FLOAT_SCALING_NUM } from 'svx-shared/constants';
import type { OracleSnapshot, SVIParams } from 'svx-shared/types';
import { log } from '../util/log.js';

interface RawOracle {
  oracle_id: string;
  underlying_asset: string;
  expiry: number;
  min_strike: number;
  tick_size: number;
  status: string;
  settlement_price: number | null;
  activated_at: number | null;
  settled_at: number | null;
}

interface RawPriceEvent {
  oracle_id: string;
  spot: number;
  forward: number;
  onchain_timestamp: number;
}

interface RawSviEvent {
  oracle_id: string;
  a: number;
  b: number;
  rho: number;
  rho_negative: boolean;
  m: number;
  m_negative: boolean;
  sigma: number;
  onchain_timestamp: number;
}

export interface PredictOracleSummary {
  oracleId: string;
  underlyingAsset: string;
  expiryMs: number;
  minStrike: number;
  tickSize: number;
  status: 'inactive' | 'active' | 'pending_settlement' | 'settled';
  settlementPrice?: number;
  activatedAtMs?: number;
  settledAtMs?: number;
}

const RAW_TO_NUMBER = (v: unknown): number => {
  if (typeof v === 'number') return v / FLOAT_SCALING_NUM;
  if (typeof v === 'string') return Number(v) / FLOAT_SCALING_NUM;
  if (typeof v === 'bigint') return Number(v) / FLOAT_SCALING_NUM;
  return NaN;
};

const RAW_SIGNED_TO_NUMBER = (mag: unknown, isNeg: boolean): number => {
  const m = RAW_TO_NUMBER(mag);
  return isNeg ? -m : m;
};

export class PredictClient {
  private readonly http: AxiosInstance;
  private oracleListCache: { fetchedAtMs: number; data: PredictOracleSummary[] } | null = null;
  private readonly cacheTtlMs = 30_000;

  constructor(baseUrl = ADDRESSES.predictServerUrl, timeoutMs = 10_000) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: timeoutMs,
      headers: { Accept: 'application/json' },
    });
    axiosRetry(this.http, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) || err.code === 'ECONNABORTED',
    });
  }

  /** Indexer health probe. */
  async health(): Promise<unknown> {
    const { data } = await this.http.get(PREDICT_ENDPOINTS.health);
    return data;
  }

  /** Indexer status (lag, pipelines). */
  async status(): Promise<unknown> {
    const { data } = await this.http.get(PREDICT_ENDPOINTS.status);
    return data;
  }

  /** PLP supply events (share mints). Share price at event = amount/shares. */
  async lpSupplies(): Promise<Array<{ tsMs: number; amount: number; shares: number }>> {
    const { data } = await this.http.get<
      Array<{ checkpoint_timestamp_ms: number; amount: number; shares_minted: number }>
    >(PREDICT_ENDPOINTS.lpSupplies);
    return (data ?? [])
      .filter((r) => r.shares_minted > 0)
      .map((r) => ({ tsMs: r.checkpoint_timestamp_ms, amount: r.amount, shares: r.shares_minted }));
  }

  /** PLP withdrawal events (share burns). */
  async lpWithdrawals(): Promise<Array<{ tsMs: number; amount: number; shares: number }>> {
    const { data } = await this.http.get<
      Array<{ checkpoint_timestamp_ms: number; amount: number; shares_burned: number }>
    >(PREDICT_ENDPOINTS.lpWithdrawals);
    return (data ?? [])
      .filter((r) => r.shares_burned > 0)
      .map((r) => ({ tsMs: r.checkpoint_timestamp_ms, amount: r.amount, shares: r.shares_burned }));
  }

  /**
   * List all oracles. The response is large (every oracle ever created).
   * Result is cached for `cacheTtlMs` to avoid hammering the indexer; pass
   * `force=true` to bypass.
   */
  async listOracles(force = false): Promise<PredictOracleSummary[]> {
    const now = Date.now();
    if (!force && this.oracleListCache && now - this.oracleListCache.fetchedAtMs < this.cacheTtlMs) {
      return this.oracleListCache.data;
    }
    const { data } = await this.http.get<RawOracle[]>(PREDICT_ENDPOINTS.oracles);
    const summaries = data.map(rawToSummary);
    this.oracleListCache = { fetchedAtMs: now, data: summaries };
    return summaries;
  }

  /**
   * Active oracles (status='active') matching a given underlying, sorted by
   * expiry ascending. Useful for picking a working set each loop iteration.
   */
  async listActiveOracles(underlying = 'BTC'): Promise<PredictOracleSummary[]> {
    const all = await this.listOracles();
    return all
      .filter((o) => o.status === 'active' && o.underlyingAsset === underlying)
      .sort((a, b) => a.expiryMs - b.expiryMs);
  }

  async oracleState(oracleId: string): Promise<{
    oracle: PredictOracleSummary;
    latestPrice?: { spot: number; forward: number; timestampMs: number };
    latestSvi?: { svi: SVIParams; timestampMs: number };
  }> {
    const { data } = await this.http.get<{
      oracle: RawOracle;
      latest_price: RawPriceEvent | null;
      latest_svi: RawSviEvent | null;
    }>(PREDICT_ENDPOINTS.oracleState(oracleId));
    return {
      oracle: rawToSummary(data.oracle),
      latestPrice: data.latest_price ? rawToPrice(data.latest_price) : undefined,
      latestSvi: data.latest_svi ? rawToSvi(data.latest_svi) : undefined,
    };
  }

  async latestSvi(oracleId: string): Promise<{ svi: SVIParams; timestampMs: number } | null> {
    try {
      const { data } = await this.http.get<RawSviEvent | null>(
        PREDICT_ENDPOINTS.oracleLatestSvi(oracleId),
      );
      return data ? rawToSvi(data) : null;
    } catch (e) {
      log.warn('predict.latestSvi failed', { oracleId, err: errMsg(e) });
      return null;
    }
  }

  async latestPrice(
    oracleId: string,
  ): Promise<{ spot: number; forward: number; timestampMs: number } | null> {
    try {
      const { data } = await this.http.get<RawPriceEvent | null>(
        PREDICT_ENDPOINTS.oracleLatestPrice(oracleId),
      );
      return data ? rawToPrice(data) : null;
    } catch (e) {
      log.warn('predict.latestPrice failed', { oracleId, err: errMsg(e) });
      return null;
    }
  }

  /**
   * Snapshot a single oracle (price + SVI + metadata) — convenience wrapper
   * around `oracleState`.
   */
  async snapshotOracle(oracleId: string): Promise<OracleSnapshot | null> {
    const { oracle, latestPrice, latestSvi } = await this.oracleState(oracleId);
    if (!latestPrice || !latestSvi) return null;
    return {
      oracleId: oracle.oracleId,
      underlyingAsset: oracle.underlyingAsset,
      expiryMs: oracle.expiryMs,
      spot: latestPrice.spot,
      forward: latestPrice.forward,
      svi: latestSvi.svi,
      timestampMs: Math.min(latestPrice.timestampMs, latestSvi.timestampMs),
      isSettled: oracle.status === 'settled',
      settlementPrice: oracle.settlementPrice,
    };
  }
}

function rawToSummary(o: RawOracle): PredictOracleSummary {
  return {
    oracleId: o.oracle_id,
    underlyingAsset: o.underlying_asset,
    expiryMs: o.expiry,
    minStrike: o.min_strike / FLOAT_SCALING_NUM,
    tickSize: o.tick_size / FLOAT_SCALING_NUM,
    status: o.status as PredictOracleSummary['status'],
    settlementPrice: o.settlement_price != null ? o.settlement_price / FLOAT_SCALING_NUM : undefined,
    activatedAtMs: o.activated_at ?? undefined,
    settledAtMs: o.settled_at ?? undefined,
  };
}

function rawToPrice(p: RawPriceEvent): { spot: number; forward: number; timestampMs: number } {
  return {
    spot: p.spot / FLOAT_SCALING_NUM,
    forward: p.forward / FLOAT_SCALING_NUM,
    timestampMs: p.onchain_timestamp,
  };
}

function rawToSvi(s: RawSviEvent): { svi: SVIParams; timestampMs: number } {
  return {
    svi: {
      a: RAW_TO_NUMBER(s.a),
      b: RAW_TO_NUMBER(s.b),
      rho: RAW_SIGNED_TO_NUMBER(s.rho, s.rho_negative),
      m: RAW_SIGNED_TO_NUMBER(s.m, s.m_negative),
      sigma: RAW_TO_NUMBER(s.sigma),
    },
    timestampMs: s.onchain_timestamp,
  };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
