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
  /** Gamma sets this once UMA has resolved the market. */
  closedTime?: string | null;
  /** True for NegRisk multi-outcome events (our BTC strike markets are
   *  typically NegRisk). Drives which adapter we call to redeem. */
  negRisk?: boolean;
  /** Underlying spot at resolution, when gamma surfaces it. */
  resolvedPrice?: number | null;
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

/**
 * Resolution snapshot for a Polymarket market. Returned by
 * `PolymarketClient.getMarketResolution(conditionId)` once UMA has resolved
 * the market.
 *
 * `winningOutcome` matches the conventional Yes/No labeling — Yes = "Bitcoin
 * above $X at expiry" for our markets. `null` until the market closes.
 *
 * `negRisk` is true for Polymarket's NegRisk markets (typical for multi-strike
 * BTC events): redemption goes through `NegRiskAdapter.redeemPositions`
 * instead of the standard CTF flow. Default false when gamma omits the field.
 */
export interface PolyMarketResolution {
  conditionId: string;
  closed: boolean;
  winningOutcome: 'yes' | 'no' | null;
  /** When gamma reports the market as closed (ms epoch). */
  resolvedAtMs?: number;
  /** Underlying spot at resolution, if gamma exposes it. */
  resolvedPrice?: number;
  /** True for NegRisk multi-outcome events (our BTC strike markets).
   *  `undefined` when gamma omits the field — the redeem path must NOT
   *  guess: routing a NegRisk market through the plain CTF contract
   *  reverts 100% of the time and used to strand winnings forever. */
  negRisk: boolean | undefined;
}

export interface PolyOrderBook {
  conditionId: string;
  tokenId: string;
  bid: PolyOrderBookSide | null;
  ask: PolyOrderBookSide | null;
  midpoint: number | null;
  timestamp: number;
}

// The strike number must be a DOLLAR amount: `$`-prefixed or `k`-suffixed.
// The old pattern accepted any bare 2-3 digit number after "above", which
// matched "Bitcoin dominance above 60%" (strike 60 → passes every sigma gate
// as free money) and "MicroStrategy's bitcoin holdings above 500,000". A
// dominance/holdings question never writes "$60" or "500k BTC above $…", so
// requiring the currency marker kills the whole contamination class.
const RGX_BTC_ABOVE =
  /(?:bitcoin|btc).*?above\s+(?:\$(\d{2,3}(?:[,_]?\d{3})?(?:k|K)?)|(\d{2,3}(?:[,_]?\d{3})?[kK]))\b/i;
const RGX_BTC_BE_ABOVE =
  /price of bitcoin be above\s+(?:\$(\d{2,3}(?:[,_]?\d{3})?(?:k|K)?)|(\d{2,3}(?:[,_]?\d{3})?[kK]))\b/i;
// Questions about a DIFFERENT quantity than the BTC spot price, or with
// no-touch semantics ("stay above X through Friday" pays on the path, not
// the terminal print — our terminal-probability model is wrong for those
// by construction). Any match disqualifies the market.
const RGX_NOT_SPOT_PRICE =
  /dominance|holdings|treasur|reserve|hashrate|market\s*cap|etf|mining|supply|\b(?:stay|remain|hold)s?\s+above|\bthrough\b|\buntil\b/i;

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
    const seen = new Set<string>();
    for (const ev of events) {
      const t = (ev.title ?? '').toLowerCase();
      // Loose filter at event level — any BTC-related event is in. The
      // strict per-market regex below rejects events whose questions don't
      // parse a strike (e.g. "Will BTC top ETH this month"). This change
      // (May 2026) lets us pick up Polymarket's intraday BTC strike markets
      // ("Bitcoin above $X by 4pm ET today") which were previously excluded
      // by the "bitcoin above" title check.
      if (!t.includes('bitcoin') && !t.includes('btc')) continue;
      for (const m of ev.markets ?? []) {
        if (m.closed === true || m.active === false) continue;
        const parsed = parseGammaMarket(m);
        if (!parsed) continue;
        // Dedup — the same conditionId can appear under multiple events
        // when Polymarket cross-lists or groups markets.
        if (seen.has(parsed.conditionId)) continue;
        seen.add(parsed.conditionId);
        out.push(parsed);
      }
    }
    this.eventsCache = { fetchedAtMs: now, data: out };
    log.info('polymarket.listBtcStrikeMarkets', { found: out.length });
    return out;
  }

  /**
   * Fetch resolution status for a single market by condition ID. UMA resolves
   * Polymarket markets hours after expiry; gamma's `closed: true` is the
   * signal we wait on. Returns null on transient fetch error (caller retries
   * next loop iteration) or when no market matches the conditionId.
   */
  async getMarketResolution(conditionId: string): Promise<PolyMarketResolution | null> {
    try {
      // `closed: true` is LOAD-BEARING. Gamma's /markets endpoint excludes
      // closed markets by default, and this poll only ever cares about
      // markets AFTER they close. Without the param the query returns []
      // the moment a market resolves, so every trade held to expiry stays
      // unsettled forever — losses invisible to PnL, to the daily-loss
      // limit, and to the dashboard (the 2026-07 mainnet incident: ledger
      // said +$122 while the wallet had lost $120). While a market is still
      // open this returns [] → null → treated as unresolved, which is
      // exactly the behavior we want.
      const { data } = await this.gamma.get<GammaMarket | GammaMarket[]>('/markets', {
        params: { condition_ids: conditionId, limit: 1, closed: true },
      });
      const market = Array.isArray(data) ? data[0] : data;
      if (!market) return null;
      return parseMarketResolution(market);
    } catch (e) {
      log.warn('polymarket.getMarketResolution failed', { conditionId, err: errMsg(e) });
      return null;
    }
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

/**
 * Convert a raw gamma market response into a normalized resolution snapshot.
 * Exported for tests — production code paths call it through
 * `PolymarketClient.getMarketResolution`.
 *
 * Outcome detection: gamma's `outcomePrices` is a JSON array parallel to
 * `outcomes` ("['Yes','No']"). Once UMA resolves, exactly one entry becomes
 * "1" / "1.0" and the other "0" / "0.0". We pick whichever is closer to 1.
 *
 * `negRisk` is `undefined` when the field is absent — the gamma schema
 * sometimes omits it. The old code defaulted to `false`, which routed
 * NegRisk markets (our usual BTC strips) through the plain CTF contract:
 * guaranteed revert, winnings stranded. The redeem path now refuses to
 * guess and retries after re-fetching.
 */
export function parseMarketResolution(market: GammaMarket): PolyMarketResolution {
  const closed = market.closed === true;
  let winningOutcome: 'yes' | 'no' | null = null;
  try {
    const outcomes: string[] = JSON.parse(market.outcomes).map((s: string) => s.toLowerCase());
    const prices: number[] = JSON.parse(market.outcomePrices).map(Number);
    if (closed && outcomes.length === prices.length && outcomes.length >= 2) {
      const yesIdx = outcomes.findIndex((o) => o === 'yes');
      const noIdx = outcomes.findIndex((o) => o === 'no');
      if (yesIdx >= 0 && noIdx >= 0) {
        const yesP = prices[yesIdx] ?? 0;
        const noP = prices[noIdx] ?? 0;
        if (yesP >= 0.9 && noP <= 0.1) winningOutcome = 'yes';
        else if (noP >= 0.9 && yesP <= 0.1) winningOutcome = 'no';
        // else: gamma may show fractional probabilities during the
        // dispute window — treat as not-yet-resolved.
      }
    }
  } catch {
    /* malformed outcomes/prices — treat as unresolved */
  }
  const resolvedAtMs = market.closedTime ? Date.parse(market.closedTime) : undefined;
  return {
    conditionId: market.conditionId,
    closed: closed && winningOutcome !== null,
    winningOutcome,
    resolvedAtMs: isFinite(resolvedAtMs ?? NaN) ? resolvedAtMs : undefined,
    resolvedPrice: market.resolvedPrice ?? undefined,
    negRisk:
      market.negRisk === true ? true : market.negRisk === false ? false : undefined,
  };
}

/** Extract a strike like "$80,000" or "$80k" from the question text.
 *  Returns null for questions that aren't terminal BTC-spot-price binaries
 *  (dominance, holdings, no-touch "stay above" phrasing, …). */
export function parseStrikeFromQuestion(question: string): number | null {
  if (RGX_NOT_SPOT_PRICE.test(question)) return null;
  const m = question.match(RGX_BTC_BE_ABOVE) ?? question.match(RGX_BTC_ABOVE);
  const captured = m?.[1] ?? m?.[2];
  if (!captured) return null;
  const raw = captured.replace(/[,_]/g, '').toLowerCase();
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
