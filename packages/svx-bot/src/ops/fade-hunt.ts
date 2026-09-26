/**
 * Fade-spike "hunt" snapshot — the live state behind the dashboard radar.
 *
 * Every few seconds: each live up/down market's reference strike, where the
 * chain's forward sits against it, the board price, which side is the "far"
 * (cheap) one and its all-in cost, plus Binance mid and 30s momentum. The
 * dashboard draws this as one lane per market with the trigger conditions
 * lighting up. Read-only; trading decisions stay in the shadow executor.
 */

import { makeSuiClient } from '../exec/sui-client.js';
import { boardPrice, estimateMintCost, listSdkMarkets } from '../pricing/predict-sdk.js';
import { PredictV2Client, type PredictReader } from '../pricing/predict-v2.js';
import { fetchExternalSignals } from './shadow-signals.js';

export interface HuntMarket {
  marketId: string;
  /** Window length in seconds (60 or 300), when known. */
  cadenceSec: number | null;
  expiryMs: number;
  reference: number;
  /** Chain forward (what the market settles against) minus the strike, USD. */
  forwardVsRef: number;
  forward: number;
  boardUp: number;
  farSide: 'up' | 'down';
  farPrice: number;
  /** All-in cost per $1 contract of the far side (fees included), or null. */
  farCost: number | null;
  updatedAtMs: number;
}

/** One executor check of one market (at the ~50s or ~30s checkpoint). */
export interface FadeEval {
  marketId: string;
  slot: string;
  atMs: number;
  /** 'entered' | 'skipped' | 'no_signal' | 'not_filled' */
  outcome: string;
  /** Plain-words reason / detail for the dashboard. */
  detail: string;
}

const evals: FadeEval[] = [];
export function recordFadeEval(e: FadeEval): void {
  evals.push(e);
  if (evals.length > 200) evals.splice(0, evals.length - 200);
}
export function recentFadeEvals(limit = 60): FadeEval[] {
  return evals.slice(-limit).reverse();
}

/** A window listed on-chain whose strike is not set yet (opens soon). */
export interface HuntUpcoming {
  marketId: string;
  cadenceSec: number | null;
  expiryMs: number;
  /** When the window opens (strike is set), if the cadence is known. */
  opensAtMs: number | null;
}

export interface HuntState {
  updatedAtMs: number;
  btcMid: number | null;
  /** Binance mid / chain forward, so the client can map a live Binance
   *  price onto the chain's scale. */
  basis: number | null;
  mom30s: number | null;
  markets: HuntMarket[];
  upcoming: HuntUpcoming[];
}

let state: HuntState | null = null;
const cadenceCache = new Map<string, number | null>();
const HORIZON_MS = 330_000; // current 1m + 5m windows and the next ones

async function cadenceOf(marketId: string, expiryMs: number): Promise<number | null> {
  if (cadenceCache.has(marketId)) return cadenceCache.get(marketId)!;
  try {
    const res = await makeSuiClient().getObject({ objectId: marketId, include: { json: true } });
    const se = (res.object?.json as { strike_exposure?: Record<string, unknown> } | undefined)
      ?.strike_exposure;
    const src = Number(se?.reference_tick_source_timestamp_ms);
    const c = Number.isFinite(src) && src > 0 ? Math.round((expiryMs - src) / 1000) : null;
    cadenceCache.set(marketId, c);
    if (cadenceCache.size > 200) cadenceCache.delete(cadenceCache.keys().next().value!);
    return c;
  } catch {
    return null;
  }
}

export async function refreshHunt(deps: { predict: PredictReader; nowMs?: number }): Promise<void> {
  const now = deps.nowMs ?? Date.now();
  const [markets, ext] = await Promise.all([listSdkMarkets(), fetchExternalSignals(now)]);
  const live = markets.filter(
    (m) => m.referencePrice != null && m.expiryMs > now && m.expiryMs - now <= HORIZON_MS,
  );
  const upcoming: HuntUpcoming[] = [];
  for (const m of markets) {
    if (m.referencePrice != null || m.expiryMs <= now || m.expiryMs - now > 11 * 60_000) continue;
    const cadenceSec = await cadenceOf(m.id, m.expiryMs);
    upcoming.push({
      marketId: m.id,
      cadenceSec,
      expiryMs: m.expiryMs,
      opensAtMs: cadenceSec ? m.expiryMs - cadenceSec * 1000 : null,
    });
  }
  const out: HuntMarket[] = [];
  let basis: number | null = null;
  await Promise.all(
    live.map(async (m) => {
      const [snap, board, cadenceSec] = await Promise.all([
        deps.predict.snapshotOracle(m.id).catch(() => null),
        boardPrice('BTC', m.expiryMs, 'reference'),
        cadenceOf(m.id, m.expiryMs),
      ]);
      if (!snap || snap.isSettled || !board) return;
      const reference = m.referencePrice!;
      const farSide: 'up' | 'down' = snap.forward > reference ? 'down' : 'up';
      const farPrice = farSide === 'up' ? board.up : board.down;
      const meta =
        deps.predict instanceof PredictV2Client ? deps.predict.marketMetaFor(m.id) : undefined;
      const farCost = meta?.feePolicy
        ? (estimateMintCost({
            fees: meta.feePolicy,
            expiryMs: m.expiryMs,
            nowMs: now,
            sideProbability: farPrice,
            direction: farSide,
            quantity: 100,
          })?.costPerContract ?? null)
        : null;
      if (ext.binMid != null && snap.forward > 0) basis = ext.binMid / snap.forward;
      out.push({
        marketId: m.id,
        cadenceSec,
        expiryMs: m.expiryMs,
        reference,
        forward: snap.forward,
        forwardVsRef: snap.forward - reference,
        boardUp: board.up,
        farSide,
        farPrice,
        farCost,
        updatedAtMs: now,
      });
    }),
  );
  // A market whose quote failed this round (transient gRPC / pricer error)
  // keeps its previous row for up to 12s instead of vanishing from the radar.
  for (const prev of state?.markets ?? []) {
    if (
      prev.expiryMs > now &&
      now - prev.updatedAtMs < 12_000 &&
      live.some((m) => m.id === prev.marketId) &&
      !out.some((m) => m.marketId === prev.marketId)
    ) {
      out.push(prev);
    }
  }
  state = {
    updatedAtMs: now,
    btcMid: ext.binMid,
    basis,
    mom30s: ext.mom30s,
    markets: out.sort((a, b) => a.expiryMs - b.expiryMs),
    upcoming: upcoming.sort((a, b) => a.expiryMs - b.expiryMs),
  };
}

export function huntState(): HuntState | null {
  return state;
}
