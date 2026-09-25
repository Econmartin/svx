/**
 * Wallet watch — follow a few mainnet Predict wallets whose results luck
 * does not explain, and keep an exact running record of them.
 *
 * Found 2026-09-25 on the live tape: three wallets buying cheap underdogs
 * (21–29¢) in the final 30–60s won 2–3× as often as their prices implied
 * (z = 6.6, 3.9, 3.7 over 40–81 trades), profitably after fees. Their oracle
 * inputs were as fresh as everyone's (~0.27s), so it is not a stale-feed
 * trick; the working hypothesis is that the chain underprices last-minute
 * jumps. Watching them tells us whether the edge persists and what exactly
 * they buy — nothing here copies their trades.
 *
 * They trade through session keys, so events are matched on the `owner`
 * field, never the tx sender. Early exits (LiveOrderRedeemed) are credited
 * at their net proceeds; held positions resolve against the market's
 * on-chain settlement.
 */

import type { LedgerStore, WatchedPositionRow } from '../ledger/store.js';
import { makeSuiClient } from '../exec/sui-client.js';
import { sdkConfig } from '../pricing/predict-sdk.js';
import { log } from '../util/log.js';

export const DEFAULT_WATCHED_WALLETS = [
  '0x5c22733d496e38828e74ce3c361ccfc5fc566f0fc9da7e16ee623543ef2b6b9f',
  '0xb4d939833a6ba9c6c7b8d1c5da95f127dd76248294f2d45d17567dba558afe66',
  '0xfffd090eb63c393a5f3049c013cbb6b5c0d2f1ba0f6609227a9735ff832c53bb',
];

/** SVX_WATCH_WALLETS: comma list overrides the default; "none" disables. */
export function watchedWallets(): string[] {
  const raw = process.env.SVX_WATCH_WALLETS?.trim();
  if (!raw) return DEFAULT_WATCHED_WALLETS;
  if (raw === 'none') return [];
  return raw
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => /^0x[0-9a-f]{64}$/.test(w));
}

const BACKFILL_MS = 72 * 3600_000;
const POS_INF = (1n << 30n) - 1n;
const USDC = 1e6;

interface MarketInfo {
  expiryMs: number;
  tickSizeUsd: number;
  settlement: number | null;
}
const marketCache = new Map<string, MarketInfo>();

async function marketInfo(marketId: string, fresh = false): Promise<MarketInfo | null> {
  const hit = marketCache.get(marketId);
  if (hit && (!fresh || hit.settlement != null)) return hit;
  try {
    const res = await makeSuiClient().getObject({ objectId: marketId, include: { json: true } });
    const j = res.object?.json as Record<string, unknown> | undefined;
    const se = j?.strike_exposure as Record<string, unknown> | undefined;
    if (!j || !se) return null;
    const raw = se.settlement_price ?? j.settlement_price;
    const info = {
      expiryMs: Number(j.expiry),
      tickSizeUsd: Number(se.tick_size) / 1e9,
      settlement: raw == null ? null : Number(raw) / 1e9,
    };
    marketCache.set(marketId, info);
    return info;
  } catch {
    return null;
  }
}

/** Newest-first event pages, stopping at the watermark. */
async function eventsSince(
  eventName: string,
  sinceMs: number,
): Promise<Array<Record<string, string | null>>> {
  const sui = makeSuiClient();
  const type = `${sdkConfig().packages.predictV1}::order_events::${eventName}`;
  const out: Array<Record<string, string | null>> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const r = (await sui.listEvents({
      filter: { eventType: type },
      limit: 50,
      ...(cursor ? { before: cursor } : { order: 'descending' }),
    } as never)) as unknown as {
      events?: Array<{ json?: Record<string, string | null> }>;
      hasNextPage?: boolean;
      endCursor?: string;
    };
    let reachedOld = false;
    for (const e of r.events ?? []) {
      const j = e.json ?? {};
      if (Number(j.onchain_timestamp_ms) <= sinceMs) {
        reachedOld = true;
        continue;
      }
      out.push(j);
    }
    if (reachedOld || !r.hasNextPage || !r.endCursor) break;
    cursor = r.endCursor;
  }
  return out;
}

const sideOf = (lo: bigint, hi: bigint) => (lo === 0n ? 'down' : hi === POS_INF ? 'up' : 'range');

export async function pollWatchedWallets(deps: { ledger: LedgerStore; nowMs?: number }): Promise<number> {
  const watch = new Set(watchedWallets());
  if (!watch.size) return 0;
  const { ledger } = deps;
  const now = deps.nowMs ?? Date.now();
  let changed = 0;

  // Mints first, so an exit in the same poll finds its position.
  const mintMark = Number(ledger.getMeta('watch_mint_ms') ?? now - BACKFILL_MS);
  const mints = await eventsSince('OrderMinted', mintMark);
  let newestMint = mintMark;
  for (const m of mints) {
    newestMint = Math.max(newestMint, Number(m.onchain_timestamp_ms));
    const owner = String(m.owner ?? '').toLowerCase();
    if (!watch.has(owner)) continue;
    const q = Number(m.quantity) / USDC;
    if (!(q > 0)) continue;
    const cost =
      (Number(m.premium) +
        Number(m.trading_fee) -
        Number(m.fee_incentive_subsidy ?? 0) +
        Number(m.builder_fee ?? 0) +
        Number(m.penalty_fee ?? 0) +
        Number(m.inventory_impact_charge ?? 0)) /
      USDC;
    const marketId = String(m.expiry_market_id);
    const info = await marketInfo(marketId);
    const lo = BigInt(String(m.lower_tick));
    const hi = BigInt(String(m.higher_tick));
    if (
      ledger.insertWatchedPosition({
        rootId: String(m.position_root_id ?? m.order_id),
        owner,
        marketId,
        mintedAtMs: Number(m.onchain_timestamp_ms),
        expiryMs: info?.expiryMs ?? null,
        entryProb: Number(m.entry_probability) / 1e9,
        quantity: q,
        cost,
        lowerTick: lo.toString(),
        higherTick: hi.toString(),
        side: sideOf(lo, hi),
      })
    ) {
      changed++;
    }
  }
  ledger.setMeta('watch_mint_ms', String(newestMint));

  const exitMark = Number(ledger.getMeta('watch_exit_ms') ?? now - BACKFILL_MS);
  const exits = await eventsSince('LiveOrderRedeemed', exitMark);
  let newestExit = exitMark;
  for (const x of exits) {
    newestExit = Math.max(newestExit, Number(x.onchain_timestamp_ms));
    if (!watch.has(String(x.owner ?? '').toLowerCase())) continue;
    const proceeds =
      (Number(x.redeem_amount) -
        Number(x.trading_fee) -
        Number(x.builder_fee ?? 0) -
        Number(x.penalty_fee ?? 0) +
        Number(x.inventory_impact_rebate ?? 0)) /
      USDC;
    changed += ledger.addWatchedExit(
      String(x.position_root_id ?? x.order_id),
      proceeds,
      Number(x.quantity_closed) / USDC,
    );
  }
  ledger.setMeta('watch_exit_ms', String(newestExit));

  for (const marketId of ledger.unresolvedWatchedMarkets(now - 10_000)) {
    const info = await marketInfo(marketId, true);
    if (info?.settlement == null || !(info.tickSizeUsd > 0)) continue;
    changed += ledger.resolveWatchedMarket(marketId, info.settlement, info.tickSizeUsd);
  }
  if (changed) log.info('svx.watch.updated', { changes: changed });
  return changed;
}

// ── report ───────────────────────────────────────────────────────────────────

export interface WatchedWalletReport {
  owner: string;
  positions: number;
  lastTradeMs: number | null;
  /** Share closed early (exit before expiry). */
  earlyExitRate: number;
  /** Held-to-expiry positions only: wins vs the sum of entry probabilities. */
  held: { n: number; wins: number; expectedWins: number; z: number | null };
  /** Exact cash result over positions that are closed or settled. */
  cashPnl: number;
  spent: number;
  avgEntryProb: number;
  avgSecondsToExpiryAtEntry: number | null;
  sides: Record<string, number>;
  recent: Array<{
    mintedAtMs: number;
    side: string;
    entryProb: number;
    quantity: number;
    cost: number;
    secondsToExpiry: number | null;
    result: 'won' | 'lost' | 'exited' | 'open';
  }>;
}

export function reportWatchedWallets(rows: WatchedPositionRow[]): WatchedWalletReport[] {
  const byOwner = new Map<string, WatchedPositionRow[]>();
  for (const r of rows) byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r]);
  const out: WatchedWalletReport[] = [];
  for (const [owner, ps] of byOwner) {
    const exited = ps.filter((p) => p.exitProceeds != null);
    const held = ps.filter((p) => p.exitProceeds == null && p.won != null);
    const wins = held.filter((p) => p.won).length;
    const expected = held.reduce((a, p) => a + p.entryProb, 0);
    const variance = held.reduce((a, p) => a + p.entryProb * (1 - p.entryProb), 0);
    let cash = 0;
    let spent = 0;
    for (const p of ps) {
      const closed = p.exitProceeds != null && (p.exitQuantity ?? 0) >= p.quantity - 1e-9;
      if (p.won == null && !closed) continue; // still open
      spent += p.cost;
      const remaining = p.quantity - (p.exitQuantity ?? 0);
      cash += (p.exitProceeds ?? 0) + (p.won ? remaining : 0) - p.cost;
    }
    const ttms = ps
      .filter((p) => p.expiryMs != null)
      .map((p) => (p.expiryMs! - p.mintedAtMs) / 1000);
    const sides: Record<string, number> = {};
    for (const p of ps) sides[p.side] = (sides[p.side] ?? 0) + 1;
    out.push({
      owner,
      positions: ps.length,
      lastTradeMs: ps.length ? Math.max(...ps.map((p) => p.mintedAtMs)) : null,
      earlyExitRate: ps.length ? exited.length / ps.length : 0,
      held: {
        n: held.length,
        wins,
        expectedWins: expected,
        z: variance > 0 ? (wins - expected) / Math.sqrt(variance) : null,
      },
      cashPnl: cash,
      spent,
      avgEntryProb: ps.reduce((a, p) => a + p.entryProb, 0) / Math.max(1, ps.length),
      avgSecondsToExpiryAtEntry: ttms.length ? ttms.reduce((a, b) => a + b, 0) / ttms.length : null,
      sides,
      recent: ps.slice(-10).map((p) => ({
        mintedAtMs: p.mintedAtMs,
        side: p.side,
        entryProb: p.entryProb,
        quantity: p.quantity,
        cost: p.cost,
        secondsToExpiry: p.expiryMs == null ? null : (p.expiryMs - p.mintedAtMs) / 1000,
        result:
          p.exitProceeds != null ? 'exited' : p.won == null ? 'open' : p.won ? 'won' : 'lost',
      })),
    });
  }
  return out.sort((a, b) => b.cashPnl - a.cashPnl);
}
