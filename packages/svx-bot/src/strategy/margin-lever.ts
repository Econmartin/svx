/**
 * Strategy 3 — Margin-Lever (paper).
 *
 * Three-protocol composition story on Sui mainnet:
 *
 *   USDsui ──supply──▶ iron_bank ──share token──▶ deepbook_margin (collateral)
 *                                                       │
 *                                                       │ borrow dUSDC
 *                                                       ▼
 *                                                DeepBook BTC spot
 *                                              (long if P(↑) high,
 *                                               short via borrow if low)
 *                                                       │
 *                                                       ▼
 *                                                 close on signal flip
 *                                                       │
 *                                                       ▼
 *                                                 repay → unlock collateral
 *
 * Signal: same Predict SVI surface that drives the other two strategies,
 * read here as `P(spot > spot at expiry)` = N(d2) ≈ 0.5 + bias. We open
 * when |bias| ≥ openThreshold and close when |bias| < closeThreshold OR
 * time-stop fires.
 *
 * Live trading on `deepbook_margin` + `iron_bank` is intentionally GATED:
 * the strategy runs in paper mode only in v1. PTBs are constructed via
 * the exec/{deepbook-margin,iron-bank}-client stubs, recorded to the
 * in-memory ledger, and reported as simulated PnL on the dashboard.
 * Flipping `paper=false` is a future step that requires the operator
 * to fund USDsui collateral on iron_bank first.
 *
 * Independent ticker. Does NOT touch the poly-arb 15s loop or the vol-arb
 * 2s ticker. Each strategy is its own loop with its own risk gates.
 */

import type { OracleSnapshot } from 'svx-shared/types';
import { evalTotalVariance, tYearsFromMs } from '../pricing/svi.js';

const SQRT2 = Math.SQRT2;

/** A paper position opened by the margin-lever strategy. */
export interface MarginLeverPosition {
  id: string;
  openedAtMs: number;
  side: 'long' | 'short';
  /** USD notional sized into the BTC leg (collateral × leverage). */
  notionalUsdc: number;
  /** BTC entry price for PnL bookkeeping. */
  entryPrice: number;
  /** Predict P(↑) at the moment we opened — saved for verification. */
  openPredictUp: number;
  /** Oracle the signal came from. */
  oracleId: string;
  /** Reason the bot fired. Short string. */
  openReason: string;
}

export interface ClosedMarginLeverPosition extends MarginLeverPosition {
  closedAtMs: number;
  exitPrice: number;
  /** Realised PnL (paper) in USDC, signed. */
  pnlUsdc: number;
  closeReason: string;
}

export interface MarginLeverDecision {
  ts: number;
  action: 'hold' | 'open_long' | 'open_short' | 'close';
  reason: string;
  predictUpAtSpot: number;
  /** |P_up − 0.5|. */
  biasMagnitude: number;
  spot: number;
}

export interface MarginLeverState {
  /** At most one open position at a time in v1. */
  open: MarginLeverPosition | null;
  /** Ring buffer of recent closed positions, newest first. */
  closed: ClosedMarginLeverPosition[];
  /** Ring buffer of recent decisions, newest first. */
  recentDecisions: MarginLeverDecision[];
  /** Last decision (also at index 0 of recentDecisions). */
  lastDecision: MarginLeverDecision | null;
}

export function freshMarginLeverState(): MarginLeverState {
  return { open: null, closed: [], recentDecisions: [], lastDecision: null };
}

/** Compute P(spot_t > spot_now at oracle expiry) from the SVI surface. */
export function predictUpAtSpot(oracle: OracleSnapshot, nowMs: number): number {
  const k = Math.log(oracle.spot / oracle.forward);
  const w = evalTotalVariance(k, oracle.svi);
  if (!(w > 0)) return 0.5;
  const T = Math.max(1e-9, tYearsFromMs(Math.max(1, oracle.expiryMs - nowMs)));
  void T; // T is folded into w via the SVI surface (total variance); we don't divide here.
  const d2 = -(k + w / 2) / Math.sqrt(w);
  // N(d2)
  return 0.5 * (1 + erf(d2 / SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export interface MarginLeverThresholds {
  /** |P_up − 0.5| at which we open. Default 0.10 (i.e. P_up ≤ 0.40 or ≥ 0.60). */
  openBias: number;
  /** |P_up − 0.5| at which we close, < openBias for hysteresis. */
  closeBias: number;
  /** Max time a position can stay open before time-stop fires. */
  maxHoldMs: number;
}

export interface MarginLeverRiskCaps {
  /** Per-trade USD-notional cap. */
  perTradeNotionalUsdc: number;
  /** Cap on borrowable USD notional given simulated collateral. */
  maxBorrowNotionalUsdc: number;
  /** Daily loss limit (paper). Strategy auto-pauses on breach. */
  dailyLossLimitUsdc: number;
}

export interface MarginLeverDecideInput {
  oracle: OracleSnapshot;
  spot: number;
  nowMs: number;
  thresholds: MarginLeverThresholds;
  caps: MarginLeverRiskCaps;
  state: MarginLeverState;
  /** Paper-mode daily PnL accumulator (for the daily-loss-limit gate). */
  pnl24hUsdc: number;
}

/**
 * Decide the next action. Returns `null` if no decision yet warrants a
 * recorded entry (e.g. malformed oracle). Pure function — does NOT mutate
 * state; the caller persists if `acted` from `applyDecision`.
 */
export function decide(input: MarginLeverDecideInput): MarginLeverDecision {
  const { oracle, spot, nowMs, thresholds, caps, state, pnl24hUsdc } = input;
  const upAtSpot = predictUpAtSpot(oracle, nowMs);
  const bias = upAtSpot - 0.5;
  const biasMag = Math.abs(bias);

  // ── Already open: handle exits ──
  if (state.open) {
    const heldMs = nowMs - state.open.openedAtMs;
    if (biasMag < thresholds.closeBias) {
      return {
        ts: nowMs,
        action: 'close',
        reason: `bias decayed to ${biasMag.toFixed(3)} < close ${thresholds.closeBias.toFixed(3)}`,
        predictUpAtSpot: upAtSpot,
        biasMagnitude: biasMag,
        spot,
      };
    }
    if (heldMs >= thresholds.maxHoldMs) {
      return {
        ts: nowMs,
        action: 'close',
        reason: `time-stop ${(heldMs / 60_000).toFixed(1)}m ≥ ${(thresholds.maxHoldMs / 60_000).toFixed(1)}m`,
        predictUpAtSpot: upAtSpot,
        biasMagnitude: biasMag,
        spot,
      };
    }
    return {
      ts: nowMs,
      action: 'hold',
      reason: `held ${(heldMs / 60_000).toFixed(1)}m · bias ${biasMag.toFixed(3)} ≥ close ${thresholds.closeBias.toFixed(3)}`,
      predictUpAtSpot: upAtSpot,
      biasMagnitude: biasMag,
      spot,
    };
  }

  // ── No open position: handle opens ──
  if (pnl24hUsdc <= -caps.dailyLossLimitUsdc) {
    return {
      ts: nowMs,
      action: 'hold',
      reason: `daily loss limit hit (${pnl24hUsdc.toFixed(2)} ≤ −${caps.dailyLossLimitUsdc})`,
      predictUpAtSpot: upAtSpot,
      biasMagnitude: biasMag,
      spot,
    };
  }
  if (biasMag < thresholds.openBias) {
    return {
      ts: nowMs,
      action: 'hold',
      reason: `bias ${biasMag.toFixed(3)} < open ${thresholds.openBias.toFixed(3)}`,
      predictUpAtSpot: upAtSpot,
      biasMagnitude: biasMag,
      spot,
    };
  }
  return {
    ts: nowMs,
    action: bias > 0 ? 'open_long' : 'open_short',
    reason: `P_up ${(upAtSpot * 100).toFixed(1)}% · bias ${biasMag.toFixed(3)} ≥ ${thresholds.openBias.toFixed(3)}`,
    predictUpAtSpot: upAtSpot,
    biasMagnitude: biasMag,
    spot,
  };
}

/**
 * Apply a decision to state. Mutates `state` for convenience. Returns
 * `true` if the decision resulted in an open/close (i.e. a paper trade
 * was recorded), `false` for hold.
 */
export function applyDecision(
  state: MarginLeverState,
  decision: MarginLeverDecision,
  caps: MarginLeverRiskCaps,
  oracleId: string,
  idFactory: () => string = defaultIdFactory,
): boolean {
  state.lastDecision = decision;
  state.recentDecisions = [decision, ...state.recentDecisions].slice(0, 100);
  if (decision.action === 'open_long' || decision.action === 'open_short') {
    if (state.open) return false; // can't double-open
    const notional = Math.min(caps.perTradeNotionalUsdc, caps.maxBorrowNotionalUsdc);
    state.open = {
      id: idFactory(),
      openedAtMs: decision.ts,
      side: decision.action === 'open_long' ? 'long' : 'short',
      notionalUsdc: notional,
      entryPrice: decision.spot,
      openPredictUp: decision.predictUpAtSpot,
      oracleId,
      openReason: decision.reason,
    };
    return true;
  }
  if (decision.action === 'close' && state.open) {
    const sign = state.open.side === 'long' ? 1 : -1;
    const ret = (decision.spot - state.open.entryPrice) / state.open.entryPrice;
    const pnl = sign * ret * state.open.notionalUsdc;
    const closed: ClosedMarginLeverPosition = {
      ...state.open,
      closedAtMs: decision.ts,
      exitPrice: decision.spot,
      pnlUsdc: pnl,
      closeReason: decision.reason,
    };
    state.closed = [closed, ...state.closed].slice(0, 200);
    state.open = null;
    return true;
  }
  return false;
}

let _idSeq = 0;
function defaultIdFactory(): string {
  _idSeq = (_idSeq + 1) % 1_000_000;
  return `ml-${Date.now().toString(36)}-${_idSeq.toString(36)}`;
}

/** Sum of pnlUsdc across closed positions whose closeMs ≥ sinceMs. */
export function realizedPnlSince(state: MarginLeverState, sinceMs: number): number {
  return state.closed
    .filter((c) => c.closedAtMs >= sinceMs)
    .reduce((acc, c) => acc + c.pnlUsdc, 0);
}
