/**
 * DeepBook Predict client (V2 protocol — testnet since 2026-07-26, Sui
 * mainnet since 2026-09-24; SUI_NETWORK picks which).
 *
 * Presents the SAME three-method interface the bot consumes from the V1
 * client (`listOracles` / `listActiveOracles` / `snapshotOracle`), adapted to
 * the V2 world:
 *
 *   - "oracles" are expiry MARKETS — one per (underlying, expiry), listed by
 *     the SDK's `read.markets()` (with their admission grid).
 *   - a snapshot is the ExpiryMarket object (expiry, settlement, tick sizes,
 *     fee policy) plus the chain's own resolved pricer — forward and the
 *     already-rolled SVI surface, exactly what a mint prices against.
 *   - freshness is the Block Scholes SOURCE time behind that pricer, so the
 *     existing svi_stale gate measures market-data age, not chain writes.
 *
 * Everything rides gRPC through the SDK; the REST indexer is optional
 * (PREDICT_V2_CHAIN_ONLY=false) and never required.
 */

import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { ADDRESSES } from 'svx-shared/addresses';
import { FLOAT_SCALING_NUM } from 'svx-shared/constants';
import type { OracleSnapshot } from 'svx-shared/types';
import { makeSuiClient } from '../exec/sui-client.js';
import { log } from '../util/log.js';
import {
  feePolicyFromMarketJson,
  listSdkMarkets,
  resolvedPricer,
  sdkConfig,
  type FeePolicy,
  type ResolvedPricer,
} from './predict-sdk.js';
import type { PredictClient, PredictOracleSummary } from './predict.js';

/** The read surface the bot actually consumes — satisfied by both the V1 and
 *  V2 clients, so call sites stay version-agnostic. */
export type PredictReader = Pick<
  PredictClient,
  'listOracles' | 'listActiveOracles' | 'snapshotOracle' | 'lpSupplies' | 'lpWithdrawals'
>;

// ── raw V2 rows ─────────────────────────────────────────────────────────────

interface RawMarketRow {
  package: string;
  expiry_market_id: string;
  pool_vault_id: string;
  propbook_underlying_id: number;
  expiry: number;
  tick_size: number | string;
  admission_tick_size?: number | string;
  min_entry_probability?: number | string;
  max_entry_probability?: number | string;
  checkpoint_timestamp_ms: number;
}

const RAW_TO_NUMBER = (v: unknown): number => {
  if (typeof v === 'number') return v / FLOAT_SCALING_NUM;
  if (typeof v === 'string') return Number(v) / FLOAT_SCALING_NUM;
  if (typeof v === 'bigint') return Number(v) / FLOAT_SCALING_NUM;
  return NaN;
};

/** propbook underlying id → asset symbol. Env-overridable JSON map. */
function underlyingMap(): Record<string, string> {
  try {
    const raw = process.env.PROPBOOK_UNDERLYING_MAP;
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch {
    /* fall through to default */
  }
  return { '1': 'BTC' };
}

/** Chain-native discovery is the default: Mysten's indexer host was torn
 *  down twice on testnet and mainnet has none we depend on. Set
 *  PREDICT_V2_CHAIN_ONLY=false to try the REST indexer first. */
const CHAIN_ONLY = process.env.PREDICT_V2_CHAIN_ONLY !== 'false';

export class PredictV2Client {
  private readonly http: AxiosInstance;
  private chainPackageCache: string | null = null;
  private readonly marketMeta = new Map<
    string,
    {
      expiryMs: number;
      tickSizeRaw: number;
      /** Mint bounds must sit on this coarser grid (assert_admitted_mint_ticks). */
      admissionTickSizeRaw: number;
      packageId: string;
      /** The market's snapshotted fee policy (for fee-inclusive paper fills). */
      feePolicy?: FeePolicy;
    }
  >();
  private marketListCache: { fetchedAtMs: number; data: PredictOracleSummary[] } | null = null;
  private readonly listCacheTtlMs = 30_000;
  private readonly pricerCache = new Map<
    string,
    { fetchedAtMs: number; snap: ResolvedPricer }
  >();
  private readonly pricerCacheTtlMs = 2_000;

  constructor(baseUrl = ADDRESSES.predictServerUrl, timeoutMs = 10_000) {
    this.http = axios.create({ baseURL: baseUrl, timeout: timeoutMs });
    axiosRetry(this.http, {
      retries: 2,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) || err.code === 'ECONNABORTED',
    });
  }

  /** V2 vault flows live under /vaults/:id/* with a different shape; the
   *  plp-sim consumers tolerate empty history, so stub until wired. */
  async lpSupplies(): Promise<Array<{ tsMs: number; amount: number; shares: number }>> {
    return [];
  }

  async lpWithdrawals(): Promise<Array<{ tsMs: number; amount: number; shares: number }>> {
    return [];
  }

  /**
   * Market discovery. Prefers the indexer API (one call for the whole list),
   * falls back to CHAIN-NATIVE discovery when it is unavailable — Mysten's
   * predict-server hostname was torn down twice during this integration while
   * the protocol itself kept running, so the API is treated as an accelerator,
   * never a dependency.
   */
  async listOracles(): Promise<PredictOracleSummary[]> {
    const now = Date.now();
    if (this.marketListCache && now - this.marketListCache.fetchedAtMs < this.listCacheTtlMs) {
      return this.marketListCache.data;
    }
    const map = underlyingMap();
    let summaries: PredictOracleSummary[] | null = null;
    if (!CHAIN_ONLY) {
      try {
        const { data } = await this.http.get<RawMarketRow[]>('/markets');
        summaries = data.map((m) => {
          this.marketMeta.set(m.expiry_market_id, {
            expiryMs: Number(m.expiry),
            tickSizeRaw: Number(m.tick_size),
            admissionTickSizeRaw: Number(m.admission_tick_size ?? m.tick_size),
            packageId: m.package,
          });
          return marketToSummary(m, map);
        });
      } catch {
        summaries = null; // fall through to chain
      }
    }
    if (!summaries) summaries = await this.discoverMarketsFromSdk(map);
    this.marketListCache = { fetchedAtMs: now, data: summaries };
    return summaries;
  }

  /**
   * The full market board via the Predict SDK (`read.markets()` over gRPC) —
   * the DeepBook-supported discovery path, and one that works on hosts whose
   * JSON-RPC has been retired. Rows carry the admission grid; the fee policy
   * is learned from the ExpiryMarket object on first snapshot.
   */
  private async discoverMarketsFromSdk(
    map: Record<string, string>,
  ): Promise<PredictOracleSummary[]> {
    const pkg = this.chainPackageId();
    const markets = await listSdkMarkets();
    const now = Date.now();
    const out: PredictOracleSummary[] = [];
    for (const m of markets) {
      const prev = this.marketMeta.get(m.id);
      this.marketMeta.set(m.id, {
        expiryMs: m.expiryMs,
        // SDK sizes are in USD; raw grid units are 1e9-scaled.
        tickSizeRaw: Math.round(m.tickSize * FLOAT_SCALING_NUM),
        admissionTickSizeRaw: Number.isFinite(m.admissionTickSize)
          ? Math.round(m.admissionTickSize * FLOAT_SCALING_NUM)
          : (prev?.admissionTickSizeRaw ?? NaN),
        packageId: prev?.packageId ?? pkg,
        feePolicy: prev?.feePolicy,
      });
      out.push({
        oracleId: m.id,
        underlyingAsset: map['1'] ?? 'BTC',
        expiryMs: m.expiryMs,
        minStrike: 0,
        tickSize: m.tickSize,
        status: m.expiryMs <= now ? 'pending_settlement' : 'active',
      });
    }
    return out;
  }

  /** Predict package id: env pin → learned from a market → SDK's record. */
  private chainPackageId(): string {
    if (this.chainPackageCache) return this.chainPackageCache;
    const pinned = process.env.PREDICT_V2_PACKAGE_ID;
    if (pinned) {
      this.chainPackageCache = pinned;
      return pinned;
    }
    const known = [...this.marketMeta.values()].find((m) => m.packageId)?.packageId;
    this.chainPackageCache = known ?? sdkConfig().packages.predict;
    return this.chainPackageCache;
  }

  /** Market metadata (tick size, package) for the exec layer. */
  marketMetaFor(marketId: string):
    | {
        expiryMs: number;
        tickSizeRaw: number;
        admissionTickSizeRaw: number;
        packageId: string;
        feePolicy?: FeePolicy;
      }
    | undefined {
    return this.marketMeta.get(marketId);
  }

  async listActiveOracles(): Promise<PredictOracleSummary[]> {
    const all = await this.listOracles();
    const now = Date.now();
    return all.filter((o) => o.status === 'active' && o.expiryMs > now);
  }

  async snapshotOracle(marketId: string): Promise<OracleSnapshot | null> {
    return this.snapshotFromChain(marketId);
  }

  /**
   * Snapshot built entirely from chain state. The ExpiryMarket object carries
   * expiry / settlement / pause / tick sizes / fee policy; forward and the
   * rolled SVI surface come from the chain's own `load_live_pricer` (one
   * simulate via the SDK) — exactly what a mint would be priced against, and
   * independent of how the oracle feeds are stored (the mainnet launch moved
   * them to store-era objects our old lane reader could not parse).
   */
  private async snapshotFromChain(marketId: string): Promise<OracleSnapshot | null> {
    const sui = makeSuiClient();
    const obj = await sui
      .getObject({ objectId: marketId, include: { json: true } })
      .catch(() => null);
    const f = obj?.object?.json as Record<string, unknown> | undefined;
    if (!f) return null;
    const expiryMs = Number(f.expiry);
    if (!Number.isFinite(expiryMs)) return null;
    // Learn package + tick sizes + fee policy from the object itself so the
    // exec layer has everything it needs before any mint.
    const pkg = obj?.object?.type?.split('::')[0];
    if (pkg && !this.chainPackageCache) this.chainPackageCache = pkg;
    const se = f.strike_exposure as
      | { tick_size?: unknown; admission_tick_size?: unknown; settlement_price?: unknown }
      | undefined;
    const prev = this.marketMeta.get(marketId);
    const tickSizeRaw = Number(se?.tick_size);
    const admissionTickSizeRaw = Number(se?.admission_tick_size);
    this.marketMeta.set(marketId, {
      expiryMs,
      tickSizeRaw: Number.isFinite(tickSizeRaw) ? tickSizeRaw : (prev?.tickSizeRaw ?? NaN),
      admissionTickSizeRaw: Number.isFinite(admissionTickSizeRaw)
        ? admissionTickSizeRaw
        : (prev?.admissionTickSizeRaw ?? NaN),
      packageId: pkg ?? prev?.packageId ?? this.chainPackageId(),
      feePolicy: feePolicyFromMarketJson(f) ?? prev?.feePolicy,
    });
    const underlying = underlyingMap()[String(f.propbook_underlying_id ?? 1)] ?? 'BTC';
    // Settlement lives on the strike exposure since the mainnet release; the
    // top-level field is the pre-launch testnet layout.
    const settlementRaw = se?.settlement_price ?? f.settlement_price;
    const settled = settlementRaw !== null && settlementRaw !== undefined;
    if (settled) {
      // A settled market can no longer be priced; carry the last surface we
      // saw (consumers of a settled snapshot only read the settlement).
      const last = this.pricerCache.get(marketId)?.snap;
      return {
        oracleId: marketId,
        underlyingAsset: underlying,
        expiryMs,
        spot: last?.forward ?? RAW_TO_NUMBER(settlementRaw),
        forward: last?.forward ?? RAW_TO_NUMBER(settlementRaw),
        svi: last?.svi ?? { a: 0, b: 0, rho: 0, m: 0, sigma: 0 },
        timestampMs: Date.now(),
        isSettled: true,
        settlementPrice: RAW_TO_NUMBER(settlementRaw),
      };
    }
    const pricer = await this.pricer(marketId, underlying, expiryMs);
    if (!pricer) return null;
    return {
      oracleId: marketId,
      underlyingAsset: underlying,
      expiryMs,
      // The pricer's forward is Pyth spot re-anchored by the Block Scholes
      // basis — the price the digital settles against. Sub-hour tenors carry
      // no meaningful basis, so it doubles as spot.
      spot: pricer.forward,
      forward: pricer.forward,
      svi: pricer.svi,
      timestampMs: pricer.sourceTimestampMs,
      isSettled: false,
      settlementPrice: undefined,
    };
  }

  private async pricer(
    marketId: string,
    underlying: string,
    expiryMs: number,
  ): Promise<ResolvedPricer | null> {
    const cached = this.pricerCache.get(marketId);
    if (cached && Date.now() - cached.fetchedAtMs < this.pricerCacheTtlMs) return cached.snap;
    try {
      const snap = await resolvedPricer(underlying, expiryMs);
      this.pricerCache.set(marketId, { fetchedAtMs: Date.now(), snap });
      return snap;
    } catch (e) {
      // Stale oracle / expired / not yet quotable — the chain would refuse a
      // mint too, so no snapshot is the right answer.
      log.debug('svx.predict_v2.pricer_unavailable', {
        marketId,
        err: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }
}

function marketToSummary(
  m: RawMarketRow,
  underlyings: Record<string, string>,
): PredictOracleSummary {
  const now = Date.now();
  const expiryMs = Number(m.expiry);
  return {
    oracleId: m.expiry_market_id,
    underlyingAsset: underlyings[String(m.propbook_underlying_id)] ?? 'BTC',
    expiryMs,
    // V2 markets have no min_strike; the strike grid is the full tick tree.
    minStrike: 0,
    tickSize: RAW_TO_NUMBER(m.tick_size),
    status: expiryMs <= now ? 'pending_settlement' : 'active',
  };
}
