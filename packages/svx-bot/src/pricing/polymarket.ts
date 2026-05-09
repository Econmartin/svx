/**
 * Polymarket client — the gamma API for market discovery and CLOB API for
 * live order books.
 *
 * Polymarket BTC binaries we care about: events titled "Bitcoin above ___ on
 * <DATE>?" — each contains a strip of strike sub-markets that all settle at
 * the same expiry. Each sub-market has two outcome tokens (Yes and No) with
 * `clobTokenIds[0]` = Yes, `clobTokenIds[1]` = No.
 *
 * Convention: "Yes" on "Bitcoin above $X" maps to a Predict UP binary at
 * strike X — both pay if spot ends above X at expiry.
 */

import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { log } from '../util/log.js';

interface GammaEvent {
  title: string;
  slug: string;
  endDate?: string | null;
  volume24hr?: number | null;
  markets?: GammaMarket[];
}

interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  endDate: string;
  conditionId: string;
  outcomes: string;             // JSON-encoded array, e.g. '["Yes","No"]'
  outcomePrices: string;        // JSON-encoded array of mid prices
  clobTokenIds: string;         // JSON-encoded array of two token ids (Yes, No)
  orderPriceMinTickSize?: number;
  volume24hr?: number;
  liquidity?: string | number;
  active?: boolean;
  closed?: boolean;
}

export interface PolyStrikeMarket {
  conditionId: string;
  /** Strike price extracted from the question text (e.g. 80000). */
  strike: number;
  /** Expiry as ms epoch. */
  expiryMs: number;
  /** Question text, for diagnostics. */
  question: string;
  /** Yes/No clob token IDs. */
  yesTokenId: string;
  noTokenId: string;
  /** Mid prices from gamma (NOT order-book; use snapshot for live values). */
  yesMid?: number;
  noMid?: number;
  volume24hr: number;
  liquidity: number;
}

export interface PolyOrderBookSide {
  /** Best price (highest bid / lowest ask). */
  bestPrice: number;
  /** Total size at best price (in shares of the outcome token). */
  bestSize: number;
}

export interface PolyOrderBook {
  conditionId: string;
  tokenId: string;
  bid: PolyOrderBookSide | null;
  ask: PolyOrderBookSide | null;
  midpoint: number | null;
  timestamp: number;
}

const RGX_BTC_ABOVE = /(?:bitcoin|btc).*?above.*?\$?(\d{2,3}(?:[,_]?\d{3})?(?:k|K)?)/i;
const RGX_BTC_BE_ABOVE = /price of bitcoin be above \$?(\d{2,3}(?:[,_]?\d{3})?(?:k|K)?)/i;

export class PolymarketClient {
  private readonly gamma: AxiosInstance;
  private readonly clob: AxiosInstance;
  /** Cache of "BTC above" event lookup (gamma API), keyed by the slug pattern. */
  private eventsCache: { fetchedAtMs: number; data: PolyStrikeMarket[] } | null = null;
  private readonly eventsCacheTtlMs = 60_000;

  constructor(
    gammaBase = 'https://gamma-api.polymarket.com',
    clobBase = 'https://clob.polymarket.com',
    timeoutMs = 10_000,
  ) {
    this.gamma = axios.create({
      baseURL: gammaBase,
      timeout: timeoutMs,
      headers: { Accept: 'application/json' },
    });
    this.clob = axios.create({
      baseURL: clobBase,
      timeout: timeoutMs,
      headers: { Accept: 'application/json' },
    });
    for (const a of [this.gamma, this.clob]) {
      axiosRetry(a, { retries: 3, retryDelay: axiosRetry.exponentialDelay });
    }
  }

  /**
   * Discover all live "Bitcoin above ___ on <date>?" strike markets across
   * any active event matching that title pattern. Result includes one entry
   * per (event, strike).
   */
  async listBtcStrikeMarkets(force = false): Promise<PolyStrikeMarket[]> {
    const now = Date.now();
    if (!force && this.eventsCache && now - this.eventsCache.fetchedAtMs < this.eventsCacheTtlMs) {
      return this.eventsCache.data;
    }

    // Pull a generous slice of events, sorted by 24h volume. The "Bitcoin
    // above ___" series usually ranks in the top few dozen by volume.
    let events: GammaEvent[];
    try {
      const { data } = await this.gamma.get<GammaEvent[]>('/events', {
        params: {
          closed: false,
          active: true,
          limit: 200,
          order: 'volume24hr',
          ascending: false,
        },
      });
      events = data ?? [];
    } catch (e) {
      log.warn('polymarket.listBtcStrikeMarkets gamma fetch failed', { err: errMsg(e) });
      events = [];
    }

    const out: PolyStrikeMarket[] = [];
    for (const ev of events) {
      const t = (ev.title ?? '').toLowerCase();
      if (!(t.includes('bitcoin above') || t.includes('btc above'))) continue;
      for (const m of ev.markets ?? []) {
        if (m.closed === true || m.active === false) continue;
        const parsed = parseGammaMarket(m);
        if (parsed) out.push(parsed);
      }
    }
    this.eventsCache = { fetchedAtMs: now, data: out };
    log.info('polymarket.listBtcStrikeMarkets', { found: out.length });
    return out;
  }

  /** Fetch a single CLOB order book for one outcome token. */
  async orderBook(conditionId: string, tokenId: string): Promise<PolyOrderBook> {
    const [bookRes, midRes] = await Promise.all([
      this.clob.get<{
        bids: Array<{ price: string; size: string }>;
        asks: Array<{ price: string; size: string }>;
        timestamp?: string | number;
      }>('/book', { params: { token_id: tokenId } }),
      this.clob.get<{ mid: string }>('/midpoint', { params: { token_id: tokenId } }).catch(() => ({
        data: { mid: '' },
      })),
    ]);

    const data = bookRes.data;
    const bids = (data.bids ?? []).map((b) => ({ price: Number(b.price), size: Number(b.size) }));
    const asks = (data.asks ?? []).map((a) => ({ price: Number(a.price), size: Number(a.size) }));

    // Bids are returned ascending by price → best bid is the LAST entry.
    // Asks are returned descending by price → best ask is also the LAST entry
    // (the lowest ask). Defensive: compute by extreme.
    const bid = bids.length ? maxBy(bids, (x) => x.price) : null;
    const ask = asks.length ? minBy(asks, (x) => x.price) : null;
    const mid = midRes.data.mid ? Number(midRes.data.mid) : null;

    return {
      conditionId,
      tokenId,
      bid: bid ? { bestPrice: bid.price, bestSize: bid.size } : null,
      ask: ask ? { bestPrice: ask.price, bestSize: ask.size } : null,
      midpoint: mid,
      timestamp: typeof data.timestamp === 'string' ? Number(data.timestamp) : (data.timestamp ?? Date.now()),
    };
  }
}

function parseGammaMarket(m: GammaMarket): PolyStrikeMarket | null {
  const strike = parseStrikeFromQuestion(m.question);
  if (strike == null) return null;
  let tokenIds: string[];
  try {
    tokenIds = JSON.parse(m.clobTokenIds);
  } catch {
    return null;
  }
  if (tokenIds.length !== 2) return null;

  let outcomes: string[];
  try {
    outcomes = JSON.parse(m.outcomes);
  } catch {
    outcomes = ['Yes', 'No'];
  }
  // Sanity: Polymarket convention is [Yes, No] but verify.
  const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === 'yes');
  const noIdx = outcomes.findIndex((o) => o.toLowerCase() === 'no');
  if (yesIdx < 0 || noIdx < 0) return null;

  let outcomePrices: number[] = [];
  try {
    outcomePrices = JSON.parse(m.outcomePrices).map(Number);
  } catch {
    /* ignore */
  }

  const expiryMs = Date.parse(m.endDate);
  if (!isFinite(expiryMs)) return null;

  return {
    conditionId: m.conditionId,
    strike,
    expiryMs,
    question: m.question,
    yesTokenId: tokenIds[yesIdx]!,
    noTokenId: tokenIds[noIdx]!,
    yesMid: outcomePrices[yesIdx],
    noMid: outcomePrices[noIdx],
    volume24hr: Number(m.volume24hr ?? 0),
    liquidity: Number(m.liquidity ?? 0),
  };
}

/** Extract a strike like "$80,000" or "$80k" from the question text. */
export function parseStrikeFromQuestion(question: string): number | null {
  const m = question.match(RGX_BTC_BE_ABOVE) ?? question.match(RGX_BTC_ABOVE);
  if (!m || !m[1]) return null;
  const raw = m[1].replace(/[,_]/g, '').toLowerCase();
  if (raw.endsWith('k')) {
    return Number(raw.slice(0, -1)) * 1000;
  }
  return Number(raw);
}

function maxBy<T>(xs: T[], f: (x: T) => number): T {
  let best = xs[0]!;
  let bestV = f(best);
  for (let i = 1; i < xs.length; i++) {
    const v = f(xs[i]!);
    if (v > bestV) {
      bestV = v;
      best = xs[i]!;
    }
  }
  return best;
}
function minBy<T>(xs: T[], f: (x: T) => number): T {
  let best = xs[0]!;
  let bestV = f(best);
  for (let i = 1; i < xs.length; i++) {
    const v = f(xs[i]!);
    if (v < bestV) {
      bestV = v;
      best = xs[i]!;
    }
  }
  return best;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
