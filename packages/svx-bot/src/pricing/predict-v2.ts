/**
 * DeepBook Predict V2 client (testnet cutover of 2026-07-26).
 *
 * Presents the SAME three-method interface the bot consumes from the V1
 * client (`listOracles` / `listActiveOracles` / `snapshotOracle`), adapted to
 * the V2 world:
 *
 *   - "oracles" are now expiry MARKETS (`GET /markets`, `/markets/:id/state`
 *     on predict-server) — one market per (underlying, expiry), carrying the
 *     reference tick (spot) and settlement.
 *   - the SVI surface no longer has a server route; it lives in the propbook
 *     BlockScholesSVIFeed shared object as one lane PER MARKET EXPIRY,
 *     already rolled down upstream (DBU-655). We read lanes directly from
 *     chain objects over gRPC — Sui retired JSON-RPC on its own fullnodes,
 *     and GraphQL event queries proved flaky, so gRPC is the one transport
 *     every read in this file uses.
 *   - freshness is anchored to `source_timestamp_ms` (market-data time), NOT
 *     the chain write time: since DBU-655 the feeder retransmits unchanged
 *     tuples every second, so envelope recency proves the feed is alive but
 *     only source-time movement proves the DATA moved. The snapshot's
 *     `timestampMs` uses source time so the existing svi_stale gate measures
 *     the right thing.
 *   - signed SVI fields arrive as `{magnitude, is_negative}` structs; plain
 *     numbers are also accepted, and `a` may be either shape (DBU-548 made it
 *     signable; live events currently emit it unsigned).
 *
 * The V2 testnet is redeployed with non-upgrade-safe changes, so package ids
 * are env-overridable and market/vault ids always come from the live API.
 */

import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { bcs } from '@mysten/sui/bcs';
import { ADDRESSES } from 'svx-shared/addresses';
import { FLOAT_SCALING_NUM } from 'svx-shared/constants';
import type { OracleSnapshot, SVIParams } from 'svx-shared/types';
import { makeSuiClient, readObjectJson } from '../exec/sui-client.js';
import { log } from '../util/log.js';
import { listSdkMarkets, sdkConfig } from './predict-sdk.js';
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

interface RawMarketState {
  expiry_market_id: string;
  market: RawMarketRow;
  reference_tick: {
    spot: number | string;
    tick: number;
    source_timestamp_ms: number;
    checkpoint_timestamp_ms: number;
  } | null;
  mint_paused: unknown;
  settlement: {
    settlement_price: number | string;
    settled_at_ms: number;
  } | null;
}

const RAW_TO_NUMBER = (v: unknown): number => {
  if (typeof v === 'number') return v / FLOAT_SCALING_NUM;
  if (typeof v === 'string') return Number(v) / FLOAT_SCALING_NUM;
  if (typeof v === 'bigint') return Number(v) / FLOAT_SCALING_NUM;
  return NaN;
};

/** Unwrap Sui JSON-RPC's `{type, fields}` struct encoding (recursively). */
const UNWRAP = (v: unknown): unknown => {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as { type?: unknown; fields?: unknown };
    if (typeof o.type === 'string' && o.fields && typeof o.fields === 'object') {
      return o.fields;
    }
  }
  return v;
};

/** Signed propbook field: `{magnitude, is_negative}` struct (possibly wrapped
 *  in `{type, fields}`) OR a plain value. */
const SIGNED_TO_NUMBER = (v: unknown): number => {
  const u = UNWRAP(v);
  if (u !== null && typeof u === 'object' && !Array.isArray(u)) {
    const o = u as { magnitude?: unknown; is_negative?: unknown; isNegative?: unknown };
    const m = RAW_TO_NUMBER(o.magnitude);
    return (o.is_negative ?? o.isNegative) === true ? -m : m;
  }
  return RAW_TO_NUMBER(u);
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

interface SviLaneEntry {
  svi: SVIParams;
  sourceTimestampMs: number;
}

/** Skip the indexer entirely (chain-native reads only). */
const CHAIN_ONLY = process.env.PREDICT_V2_CHAIN_ONLY === 'true';

export class PredictV2Client {
  private readonly http: AxiosInstance;
  private readonly sviFeedId: string;
  private readonly spotFeedId: string;
  private sviTableIdCache: string | null = null;
  private chainPackageCache: string | null = null;
  private readonly marketMeta = new Map<
    string,
    {
      expiryMs: number;
      tickSizeRaw: number;
      /** Mint bounds must sit on this coarser grid (assert_admitted_mint_ticks). */
      admissionTickSizeRaw: number;
      packageId: string;
    }
  >();
  private spotCache: { fetchedAtMs: number; spot: number; sourceTimestampMs: number } | null =
    null;
  private marketListCache: { fetchedAtMs: number; data: PredictOracleSummary[] } | null = null;
  private readonly listCacheTtlMs = 30_000;
  private readonly laneCache = new Map<
    number,
    { fetchedAtMs: number; entry: SviLaneEntry | null }
  >();
  private readonly laneCacheTtlMs = 2_000;

  constructor(baseUrl = ADDRESSES.predictServerUrl, timeoutMs = 10_000) {
    this.http = axios.create({ baseURL: baseUrl, timeout: timeoutMs });
    axiosRetry(this.http, {
      retries: 2,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (err) =>
        axiosRetry.isNetworkOrIdempotentRequestError(err) || err.code === 'ECONNABORTED',
    });
    // Propbook feed shared objects — default to the SDK's deployment record
    // for the active network (env-overridable for pinning across redeploys).
    const btcFeeds = sdkConfig().underlyings.BTC;
    this.sviFeedId =
      process.env.PREDICT_SVI_FEED_ID ??
      btcFeeds?.bsSviFeedId ??
      '0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69';
    this.spotFeedId =
      process.env.PREDICT_SPOT_FEED_ID ??
      btcFeeds?.bsSpotFeedId ??
      '0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745';
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
   * JSON-RPC has been retired. Admission tick sizes are NOT on the SDK row;
   * they are learned from the ExpiryMarket object on first snapshot (and from
   * the indexer row when that path is up), before any mint needs them.
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
        // SDK tick size is in USD; raw grid units are 1e9-scaled.
        tickSizeRaw: Math.round(m.tickSize * FLOAT_SCALING_NUM),
        admissionTickSizeRaw: prev?.admissionTickSizeRaw ?? NaN,
        packageId: prev?.packageId ?? pkg,
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
    | { expiryMs: number; tickSizeRaw: number; admissionTickSizeRaw: number; packageId: string }
    | undefined {
    return this.marketMeta.get(marketId);
  }

  async listActiveOracles(): Promise<PredictOracleSummary[]> {
    const all = await this.listOracles();
    const now = Date.now();
    return all.filter((o) => o.status === 'active' && o.expiryMs > now);
  }

  async snapshotOracle(marketId: string): Promise<OracleSnapshot | null> {
    let state: RawMarketState | null = null;
    if (!CHAIN_ONLY) {
      try {
        ({ data: state } = await this.http.get<RawMarketState>(`/markets/${marketId}/state`));
      } catch (err) {
        // 404 = young/pruned market via the indexer; anything else (host gone)
        // falls through to the chain read below.
        if (axios.isAxiosError(err) && err.response?.status !== 404) state = null;
        else if (axios.isAxiosError(err)) return this.snapshotFromChain(marketId);
        else throw err;
      }
    }
    if (!state) return this.snapshotFromChain(marketId);
    const m = state.market;
    if (!m) return null;
    // The indexer row carries full metadata — keep the meta cache warm so the
    // exec layer has admission ticks even when discovery ran through the SDK.
    this.marketMeta.set(m.expiry_market_id, {
      expiryMs: Number(m.expiry),
      tickSizeRaw: Number(m.tick_size),
      admissionTickSizeRaw: Number(m.admission_tick_size ?? m.tick_size),
      packageId: m.package,
    });
    const expiryMs = Number(m.expiry);
    // The feeder maintains an SVI lane PER MARKET EXPIRY (already rolled down
    // upstream per DBU-655) — read it straight off the feed object's table.
    const sviLane = await this.sviLane(expiryMs);
    if (!sviLane) return null;
    // Reference ticks only appear on the indexer near settlement; for most of
    // a market's life, spot comes from the propbook spot feed's latest read.
    const spotRead = state.reference_tick
      ? {
          spot: RAW_TO_NUMBER(state.reference_tick.spot),
          sourceTimestampMs: Number(state.reference_tick.source_timestamp_ms),
        }
      : await this.spotFromFeed();
    if (!spotRead || !Number.isFinite(spotRead.spot)) return null;
    const spot = spotRead.spot;
    const settled = state.settlement != null;
    return {
      oracleId: m.expiry_market_id,
      underlyingAsset: underlyingMap()[String(m.propbook_underlying_id)] ?? 'BTC',
      expiryMs,
      spot,
      // Sub-hour tenor: carry is negligible; the protocol's own pricer takes
      // the forward feed, but for our fair-value model spot suffices until
      // the forward lane reader lands.
      forward: spot,
      svi: sviLane.svi,
      // Freshness = the OLDEST source-time input we price from, so one stale
      // leg makes the whole snapshot stale (same contract as V1).
      timestampMs: Math.min(spotRead.sourceTimestampMs, sviLane.sourceTimestampMs),
      isSettled: settled,
      settlementPrice: settled
        ? RAW_TO_NUMBER(state.settlement!.settlement_price)
        : undefined,
    };
  }

  // ── propbook SVI lane reader (direct object reads over gRPC) ─────────────
  //
  // GraphQL event queries proved unreliable (module filters intermittently
  // return nothing), so we read the feed OBJECT: BlockScholesSVIFeed holds a
  // Table<expiry_ms, OracleLane<RawSVI>> and the feeder maintains one lane
  // per market expiry, already rolled down upstream (DBU-655). A lane lookup
  // is one dynamic-field read; `latest` carries the current OracleRead.

  /**
   * Snapshot built entirely from chain state: the ExpiryMarket object carries
   * expiry / settlement / pause / tick sizes, spot comes from the Block
   * Scholes spot feed and the surface from the per-expiry SVI lane. No
   * indexer involved, and no JSON-RPC — the object reads ride gRPC.
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
    // Learn package + tick sizes from the object itself so the exec layer has
    // everything it needs even when discovery ran through the SDK (whose rows
    // carry no admission tick size).
    const pkg = obj?.object?.type?.split('::')[0];
    if (pkg && !this.chainPackageCache) this.chainPackageCache = pkg;
    const se = f.strike_exposure as
      | { tick_size?: unknown; admission_tick_size?: unknown }
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
    });
    const [sviLane, spotRead] = await Promise.all([
      this.sviLane(expiryMs),
      this.spotFromFeed(),
    ]);
    if (!sviLane || !spotRead || !Number.isFinite(spotRead.spot)) return null;
    const settlementRaw = f.settlement_price;
    const settled = settlementRaw !== null && settlementRaw !== undefined;
    return {
      oracleId: marketId,
      underlyingAsset:
        underlyingMap()[String(f.propbook_underlying_id ?? 1)] ?? 'BTC',
      expiryMs,
      spot: spotRead.spot,
      forward: spotRead.spot,
      svi: sviLane.svi,
      timestampMs: Math.min(spotRead.sourceTimestampMs, sviLane.sourceTimestampMs),
      isSettled: settled,
      settlementPrice: settled ? RAW_TO_NUMBER(settlementRaw) : undefined,
    };
  }

  /** Latest spot from the propbook BlockScholesSpotFeed's inline lane. */
  private async spotFromFeed(): Promise<{ spot: number; sourceTimestampMs: number } | null> {
    const now = Date.now();
    if (this.spotCache && now - this.spotCache.fetchedAtMs < this.laneCacheTtlMs) {
      return this.spotCache;
    }
    const json = await readObjectJson<{ lane?: unknown }>(makeSuiClient(), this.spotFeedId);
    const lane = UNWRAP(json?.lane) as { latest?: unknown } | undefined;
    const latest = UNWRAP(lane?.latest) as
      | { source_timestamp_ms?: unknown; value?: unknown }
      | undefined;
    const raw = UNWRAP(latest?.value) as { spot?: unknown } | undefined;
    const spot = RAW_TO_NUMBER(raw?.spot);
    if (!latest || !Number.isFinite(spot)) return null;
    this.spotCache = {
      fetchedAtMs: now,
      spot,
      sourceTimestampMs: Number(latest.source_timestamp_ms),
    };
    return this.spotCache;
  }

  /** Resolve (and cache) the SVI feed's expiry→lane table id. */
  private async sviTableId(): Promise<string | null> {
    if (this.sviTableIdCache) return this.sviTableIdCache;
    const json = await readObjectJson<{ expiries?: { id?: string | { id?: string } } }>(
      makeSuiClient(),
      this.sviFeedId,
    );
    // gRPC renders a Table as `{id: "0x…", size}`; JSON-RPC nested it one
    // level deeper — accept both so an env-pinned transport swap stays safe.
    const rawId = json?.expiries?.id;
    const id = (typeof rawId === 'string' ? rawId : rawId?.id) ?? null;
    if (id) this.sviTableIdCache = id;
    else log.warn('svx.predict_v2.svi_feed_unreadable', { feedId: this.sviFeedId });
    return id;
  }

  private async sviLane(expiryMs: number): Promise<SviLaneEntry | null> {
    const cached = this.laneCache.get(expiryMs);
    if (cached && Date.now() - cached.fetchedAtMs < this.laneCacheTtlMs) return cached.entry;
    const tableId = await this.sviTableId();
    if (!tableId) return null;
    const sui = makeSuiClient();
    // Table entry = dynamic field keyed by BCS-encoded u64 expiry; the field
    // object's json carries the lane struct as `value`.
    const lane = await (async () => {
      try {
        const df = await sui.getDynamicField({
          parentId: tableId,
          name: { type: 'u64', bcs: bcs.u64().serialize(BigInt(expiryMs)).toBytes() },
        });
        const fieldId = df.dynamicField?.fieldId;
        if (!fieldId) return undefined;
        const json = await readObjectJson<{ value?: unknown }>(sui, fieldId);
        return UNWRAP(json?.value) as Record<string, unknown> | undefined;
      } catch {
        return undefined; // no lane for this expiry (yet)
      }
    })();
    const latest = UNWRAP(lane?.latest) as
      | {
          source_timestamp_ms?: unknown;
          update_timestamp_ms?: unknown;
          value?: unknown;
        }
      | undefined;
    const raw = UNWRAP(latest?.value) as
      | { svi?: unknown; expiry_ms?: unknown }
      | undefined;
    const svi = UNWRAP(raw?.svi) as Record<string, unknown> | undefined;
    if (!latest || !svi) {
      this.laneCache.set(expiryMs, { fetchedAtMs: Date.now(), entry: null });
      return null;
    }
    const entry: SviLaneEntry = {
      svi: {
        a: SIGNED_TO_NUMBER(svi.a),
        b: SIGNED_TO_NUMBER(svi.b),
        rho: SIGNED_TO_NUMBER(svi.rho),
        m: SIGNED_TO_NUMBER(svi.m),
        sigma: SIGNED_TO_NUMBER(svi.sigma),
      },
      sourceTimestampMs: Number(latest.source_timestamp_ms),
    };
    this.laneCache.set(expiryMs, { fetchedAtMs: Date.now(), entry });
    return entry;
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
