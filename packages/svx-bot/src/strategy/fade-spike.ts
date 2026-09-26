/**
 * Fade-spike — the last-minute pattern three mainnet wallets profit from.
 *
 * In the final minute of a Predict up/down window, when BTC has run >= $20
 * past the reference strike over the previous 30s, the far side is cheap
 * (<= 30c). Buying it bets the spike partly reverses before settlement.
 * Shadow data (2026-09-26, n=135): +4.0c per $1 contract after fees, but
 * inside the noise; the no-spike control lost -11.3c. Treat live trading as
 * an experiment: tiny clips, hard daily loss limit, kill switch respected.
 *
 * Decision logic is shared with the shadow scorer so paper, live and the
 * scoreboard can never disagree about what the signal is.
 */

import type { ShadowDecisionRow } from '../ledger/store.js';

export interface FadeSpikeSettings {
  /** Record paper trades (fee-inclusive) when the signal fires. */
  enabled: boolean;
  /** Mint for real. Also needs PAPER_TRADING=false and a funded account. */
  live: boolean;
  /** Minimum USD distance past the strike (basis-adjusted Binance). */
  minMoveUsd: number;
  /** Maximum board price of the far side. */
  maxFarPrice: number;
  /** Hard cap on one trade's all-in cost, USD. */
  maxCostUsd: number;
  /** Stand down for 24h at this trailing realized loss, USD. */
  dailyLossLimitUsd: number;
  /** Max trades opened in the trailing 24h. */
  maxTradesPerDay: number;
  /** Max positions open at once. */
  maxOpen: number;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) ? n : d;
};

/** Env-driven so Coolify can tune without a redeploy of code. */
export function fadeSpikeSettings(env: NodeJS.ProcessEnv = process.env): FadeSpikeSettings {
  return {
    enabled: env.SVX_FADE_SPIKE !== 'false',
    live: env.SVX_FADE_SPIKE_LIVE === 'true',
    minMoveUsd: num(env.SVX_FADE_SPIKE_MIN_MOVE_USD, 20),
    maxFarPrice: num(env.SVX_FADE_SPIKE_MAX_PRICE, 0.3),
    maxCostUsd: num(env.SVX_FADE_SPIKE_MAX_COST_USD, 2.5),
    dailyLossLimitUsd: num(env.SVX_FADE_SPIKE_DAILY_LOSS_USD, 15),
    maxTradesPerDay: num(env.SVX_FADE_SPIKE_MAX_TRADES_DAY, 80),
    maxOpen: num(env.SVX_FADE_SPIKE_MAX_OPEN, 4),
  };
}

type Side = 'up' | 'down';

/** The far side to buy, or null when the pattern is absent. */
export function fadeSpikeSide(
  r: Pick<ShadowDecisionRow, 'ttmMs' | 'binVsRef' | 'mom30s' | 'boardUp'>,
  minMoveUsd: number,
  maxFarPrice: number,
): Side | null {
  if (r.ttmMs > 60_000 || r.binVsRef == null || r.mom30s == null) return null;
  if (Math.abs(r.binVsRef) < minMoveUsd) return null;
  // The last 30s must have pushed price AWAY from the strike (a spike).
  if (Math.sign(r.mom30s) !== Math.sign(r.binVsRef)) return null;
  const far: Side = r.binVsRef > 0 ? 'down' : 'up';
  const farPrice = far === 'up' ? r.boardUp : 1 - r.boardUp;
  // Predict refuses entries under its min entry probability (1%) with
  // EEntryProbabilityOutOfBounds; keep clear of it.
  return farPrice >= MIN_FAR_PRICE && farPrice <= maxFarPrice ? far : null;
}

const MIN_FAR_PRICE = 0.02;

/** Predict rejects mints whose premium is under $1 (constants::min_premium). */
const MIN_PREMIUM_USD = 1;
const PREMIUM_HEADROOM = 1.12;

/**
 * Smallest clip that clears the minimum premium with headroom for price
 * drift, in $0.01 payout lots. Null when that clip would cost more than the
 * cap (very cheap contracts need a large payout to reach $1 of premium).
 */
export function fadeSpikeQuantity(
  farPrice: number,
  costPerContract: number,
  maxCostUsd: number,
): number | null {
  if (!(farPrice > 0) || !(costPerContract > 0)) return null;
  const q = Math.ceil(((MIN_PREMIUM_USD * PREMIUM_HEADROOM) / farPrice) * 100) / 100;
  return q * costPerContract <= maxCostUsd ? q : null;
}
