/**
 * Hyperliquid execution client — thin wrapper around @nktkas/hyperliquid
 * with the methods the SVX bot needs to open + close BTC perp hedges.
 *
 * Hyperliquid doesn't expose a native "market order" — we emulate by
 * sending a limit order with `tif: "Ioc"` (immediate-or-cancel) at a price
 * aggressive enough to fill against the book (±2% from mid by default).
 * That's the standard pattern documented in HL's own docs.
 *
 * Asset indexing: BTC perp is asset 0 on Hyperliquid mainnet today. We
 * confirm this at startup via `meta()` so the bot can't silently route
 * orders to the wrong asset if HL reorders their universe.
 *
 * All sizes are in BTC (base currency). Prices are in USDC. The HL API
 * accepts these as strings to preserve precision — we format with 5 dp
 * for size (HL BTC perp tick) and 1 dp for price.
 */

import { HttpTransport, InfoClient, ExchangeClient } from '@nktkas/hyperliquid';
import { loadHlOperatorKey, type HlNetwork, type HlEndpoints } from './hyperliquid-keypair.js';
import { log } from '../util/log.js';

/** Default symbol the bot trades. Multi-asset support is future work. */
export const HL_DEFAULT_ASSET = 'BTC';

/** How aggressively to cross the spread when emulating a market order. */
const MARKET_PRICE_SLIPPAGE = 0.02; // 2%

export interface HlOpenPosition {
  asset: string;
  side: 'long' | 'short';
  /** Position size in base currency (always positive — `side` carries the sign). */
  szi: number;
  entryPx: number;
  unrealizedPnlUsd: number;
  /** Cumulative funding paid (positive) or received (negative) on this position. */
  cumFundingUsdc: number;
}

export interface HlFillResult {
  orderId?: string;
  /** Average fill price in USDC. */
  fillPrice: number;
  /** Size actually filled (BTC). */
  filledSize: number;
  /** Status reported by HL. */
  status: 'filled' | 'partial' | 'rejected';
  /** Raw response for diagnostics / debugging. */
  raw: unknown;
}

export interface HlBalance {
  /** Total USDC in the perps cross-margin account (not isolated). */
  accountValueUsdc: number;
  /** USDC currently available to open new positions (free margin). */
  withdrawableUsdc: number;
}

export class HyperliquidExecClient {
  readonly address: `0x${string}`;
  readonly endpoints: HlEndpoints;
  private readonly info: InfoClient;
  private readonly exchange: ExchangeClient;
  /** Lazily-loaded asset index map ("BTC" -> 0, "ETH" -> 1, ...). */
  private assetIndex: Map<string, number> | null = null;
  /** Cached size-decimals per asset (BTC=5, ETH=4, ...). Set when assetIndex
   *  is populated; used by formatPriceForHl to enforce HL's price tick rules. */
  private assetSzDecimals: Map<string, number> | null = null;

  constructor(opts: { network?: HlNetwork } = {}) {
    const { account, address, endpoints } = loadHlOperatorKey(opts.network);
    this.address = address;
    this.endpoints = endpoints;
    const transport = new HttpTransport({ isTestnet: endpoints.network === 'testnet' });
    this.info = new InfoClient({ transport });
    // The SDK accepts a viem Account as the `wallet` signer (AbstractWallet
    // is structural — viem accounts satisfy it).
    this.exchange = new ExchangeClient({ transport, wallet: account });
  }

  /**
   * Hyperliquid orders the perp universe in `meta().universe`. The index is
   * what `OrderParameters.a` must be set to. Cached after first fetch.
   * Also caches `szDecimals` per asset for the price formatter.
   */
  async getAssetIndex(asset: string = HL_DEFAULT_ASSET): Promise<number> {
    await this.ensureAssetMetaCached();
    const idx = this.assetIndex!.get(asset);
    if (idx == null) {
      throw new Error(`Hyperliquid: asset ${asset} not found in perp universe`);
    }
    return idx;
  }

  /**
   * `szDecimals` for an asset. Hyperliquid's price-tick rule depends on this:
   *   - Max `6 - szDecimals` decimal places (perps)
   *   - Max 5 significant figures
   * BTC: 5, ETH: 4, etc.
   */
  async getAssetSzDecimals(asset: string = HL_DEFAULT_ASSET): Promise<number> {
    await this.ensureAssetMetaCached();
    const sz = this.assetSzDecimals!.get(asset);
    if (sz == null) {
      throw new Error(`Hyperliquid: asset ${asset} szDecimals not found in meta`);
    }
    return sz;
  }

  private async ensureAssetMetaCached(): Promise<void> {
    if (this.assetIndex && this.assetSzDecimals) return;
    const m = await this.info.meta();
    const indexMap = new Map<string, number>();
    const szMap = new Map<string, number>();
    m.universe.forEach((u, i) => {
      indexMap.set(u.name, i);
      szMap.set(u.name, u.szDecimals);
    });
    this.assetIndex = indexMap;
    this.assetSzDecimals = szMap;
  }

  /** Current mark price for an asset, from the `allMids` endpoint. */
  async getMid(asset: string = HL_DEFAULT_ASSET): Promise<number> {
    const mids = await this.info.allMids();
    const raw = (mids as Record<string, string>)[asset];
    if (!raw) throw new Error(`Hyperliquid: no mid price for ${asset}`);
    return Number(raw);
  }

  /** Cross-margin USDC balance for the operator wallet. */
  async getBalance(): Promise<HlBalance> {
    const state = await this.info.clearinghouseState({ user: this.address });
    return {
      accountValueUsdc: Number(state.marginSummary.accountValue),
      withdrawableUsdc: Number(state.withdrawable),
    };
  }

  /** All open perp positions on the operator account. */
  async getOpenPositions(): Promise<HlOpenPosition[]> {
    const state = await this.info.clearinghouseState({ user: this.address });
    return state.assetPositions
      .filter((p) => Number(p.position.szi) !== 0)
      .map((p) => {
        const szi = Number(p.position.szi);
        return {
          asset: p.position.coin,
          side: szi > 0 ? 'long' : 'short',
          szi: Math.abs(szi),
          entryPx: Number(p.position.entryPx ?? 0),
          unrealizedPnlUsd: Number(p.position.unrealizedPnl ?? 0),
          // sinceOpen, NOT allTime: allTime is the ACCOUNT-LIFETIME funding on
          // this coin, and every leg close used to book the whole number as
          // that one trade's cost — re-counting all historical funding on
          // every close (and multiply so with concurrent legs). sinceOpen
          // resets when the netted position opens; still approximate when
          // several ledger legs share one net position, but bounded by the
          // current position's life instead of the account's.
          cumFundingUsdc: Number(p.position.cumFunding?.sinceOpen ?? 0),
        };
      });
  }

  /**
   * Open a market position (emulated via IOC limit at ±2% from mid).
   * Returns `{ orderId, fillPrice, filledSize, status }`.
   *
   * `size` is in BTC (base currency, positive). `side='long'` opens a long
   * position, `side='short'` opens a short.
   */
  async openMarketPerp(args: {
    asset?: string;
    side: 'long' | 'short';
    size: number;
  }): Promise<HlFillResult> {
    const asset = args.asset ?? HL_DEFAULT_ASSET;
    const assetIdx = await this.getAssetIndex(asset);
    const szDecimals = await this.getAssetSzDecimals(asset);
    const mid = await this.getMid(asset);
    // Aggressive limit to ensure fill. The book is normally tight on BTC
    // perp; the slippage cushion just guarantees we cross.
    const price =
      args.side === 'long' ? mid * (1 + MARKET_PRICE_SLIPPAGE) : mid * (1 - MARKET_PRICE_SLIPPAGE);
    const priceStr = formatPriceForHl(price, szDecimals);
    const sizeStr = formatSize(args.size, szDecimals);
    log.info('svx.hl_client.open.submit', {
      asset,
      side: args.side,
      size: args.size,
      sizeFormatted: sizeStr,
      mid,
      limitPx: price,
      limitPxFormatted: priceStr,
      szDecimals,
    });
    const resp = await this.exchange.order({
      orders: [
        {
          a: assetIdx,
          b: args.side === 'long',
          p: priceStr,
          s: sizeStr,
          r: false,
          t: { limit: { tif: 'Ioc' } },
        },
      ],
      grouping: 'na',
    });
    // Pass the FORMATTED size (what HL actually trades) so the "fully
    // filled" check compares apples-to-apples — rounding from formatSize
    // would otherwise make every fill look "partial".
    const fill = parseHlOrderResponse(resp, Number(sizeStr));
    log.info('svx.hl_client.open.result', {
      orderId: fill.orderId,
      status: fill.status,
      fillPrice: fill.fillPrice,
      filledSize: fill.filledSize,
    });
    return fill;
  }

  /**
   * Close an open position by submitting a reduce-only IOC limit on the
   * opposite side. `size` matches the position size we opened earlier.
   */
  async closeMarketPerp(args: {
    asset?: string;
    /** The side of the perp leg we are CLOSING — pass the original side. */
    originalSide: 'long' | 'short';
    size: number;
  }): Promise<HlFillResult> {
    const asset = args.asset ?? HL_DEFAULT_ASSET;
    const assetIdx = await this.getAssetIndex(asset);
    const szDecimals = await this.getAssetSzDecimals(asset);
    const mid = await this.getMid(asset);
    // Closing direction is OPPOSITE of original.
    const closingLong = args.originalSide === 'short';
    const price = closingLong ? mid * (1 + MARKET_PRICE_SLIPPAGE) : mid * (1 - MARKET_PRICE_SLIPPAGE);
    const priceStr = formatPriceForHl(price, szDecimals);
    const sizeStr = formatSize(args.size, szDecimals);
    log.info('svx.hl_client.close.submit', {
      asset,
      originalSide: args.originalSide,
      size: args.size,
      sizeFormatted: sizeStr,
      mid,
      limitPx: price,
      limitPxFormatted: priceStr,
    });
    const resp = await this.exchange.order({
      orders: [
        {
          a: assetIdx,
          b: closingLong,
          p: priceStr,
          s: sizeStr,
          r: true,
          t: { limit: { tif: 'Ioc' } },
        },
      ],
      grouping: 'na',
    });
    // Pass the FORMATTED size (what HL actually trades) so the "fully
    // filled" check compares apples-to-apples — rounding from formatSize
    // would otherwise make every fill look "partial".
    const fill = parseHlOrderResponse(resp, Number(sizeStr));
    log.info('svx.hl_client.close.result', {
      orderId: fill.orderId,
      status: fill.status,
      fillPrice: fill.fillPrice,
      filledSize: fill.filledSize,
    });
    return fill;
  }
}

/**
 * Format an HL price string. Hyperliquid enforces TWO rules simultaneously:
 *   1. Max `6 - szDecimals` decimal places (perps; spot is 8 instead of 6)
 *   2. Max 5 significant figures
 *
 * For BTC (szDecimals=5) at $78k:
 *   - Decimal rule allows 1 decimal: 78582.5
 *   - Sig-figs rule allows 5 figs total: 78580 or 78583 (no decimals)
 *   - The tighter wins → integer prices only
 *
 * For ETH (szDecimals=4) at $3.2k:
 *   - Decimal rule allows 2 decimals: 3245.67
 *   - Sig-figs rule allows 5 figs: 3245.6
 *   - Tighter (1 decimal) wins
 *
 * Exported for tests.
 */
export function formatPriceForHl(px: number, szDecimals: number): string {
  if (!isFinite(px) || px <= 0) return '0';
  const maxDecimalsByPerpRule = 6 - szDecimals;
  // Sig-figs-based decimal allowance: 5 sig figs total minus the digits
  // before the decimal point.
  const log10 = Math.floor(Math.log10(Math.abs(px)));
  const sigFigDecimals = 5 - 1 - log10;
  const decimals = Math.max(0, Math.min(maxDecimalsByPerpRule, sigFigDecimals));
  return px.toFixed(decimals);
}

/**
 * Format an HL size string. Hyperliquid enforces size precision via
 * `szDecimals` directly (e.g. BTC=5 → 0.00001 increments).
 *
 * Exported for tests.
 */
export function formatSize(size: number, szDecimals: number = 5): string {
  return size.toFixed(szDecimals);
}

/**
 * Normalize an HL order response into a unified fill record. HL returns a
 * `{ status: 'ok', response: { type: 'order', data: { statuses: [...] } } }`
 * shape — each status is either `{ filled: { totalSz, avgPx, oid } }` or
 * `{ error: '...' }`. We collapse to a single result for the bot caller.
 *
 * Exported for tests.
 */
export function parseHlOrderResponse(resp: unknown, requestedSize: number): HlFillResult {
  // Defensive parsing — the SDK's success type ensures shape, but if the
  // user is on a future version we'd rather degrade than crash.
  const r = (resp ?? {}) as Record<string, unknown>;
  const response = r.response as Record<string, unknown> | undefined;
  const data = response?.data as Record<string, unknown> | undefined;
  const statuses = data?.statuses as unknown[] | undefined;
  const first = statuses?.[0] as Record<string, unknown> | undefined;

  if (!first) {
    return { fillPrice: 0, filledSize: 0, status: 'rejected', raw: resp };
  }
  const filled = first.filled as Record<string, unknown> | undefined;
  if (filled) {
    const sz = Number(filled.totalSz ?? 0);
    const avgPx = Number(filled.avgPx ?? 0);
    const oid = filled.oid != null ? String(filled.oid) : undefined;
    // Tolerance: HL truncates `s` to szDecimals before matching, so an
    // order requesting 0.000140453 BTC trades 0.00014 BTC and reports
    // back 0.00014. Our requestedSize may be the formatted value (when
    // the client passes Number(sizeStr)) or the raw pre-format value
    // (defensive). 0.0001 covers up to szDecimals=4 rounding; for
    // tighter szDecimals, 1% of requestedSize as fallback.
    const tolerance = Math.max(1e-4, requestedSize * 0.01);
    const status: HlFillResult['status'] =
      sz >= requestedSize - tolerance ? 'filled' : sz > 0 ? 'partial' : 'rejected';
    return { orderId: oid, fillPrice: avgPx, filledSize: sz, status, raw: resp };
  }
  return { fillPrice: 0, filledSize: 0, status: 'rejected', raw: resp };
}

/**
 * Construct a HyperliquidExecClient whenever the operator has provided a
 * private key. Returns null when secrets aren't configured (the dashboard
 * still works; the bot just won't open hedges). Mirrors the
 * `tryCreatePolymarketExecClient` pattern.
 */
export function tryCreateHyperliquidExecClient(): HyperliquidExecClient | null {
  if (!process.env.HL_PRIVATE_KEY) return null;
  try {
    return new HyperliquidExecClient();
  } catch (e) {
    log.warn('svx.hl.skip_init', {
      reason: 'client construction failed',
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
