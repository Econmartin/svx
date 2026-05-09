/**
 * Compute the (probability, IV) spread for a matched (Predict, Polymarket)
 * pair and decide which side to take.
 *
 * Convention everywhere:
 *   - `predictUp` = N(d2) from SVI = probability spot ends ABOVE strike.
 *   - `polyYes`   = Polymarket "Yes" price for "BTC above strike at expiry".
 *
 * If `predictUp > polyYes_ask + threshold`, Predict thinks the event is more
 * likely than Polymarket does → buy "Yes" on Polymarket (cheap), and on
 * Predict mint the matching DOWN position to lock the spread (since
 * UP + DOWN = 1, selling UP ≡ buying DOWN at the parity price).
 *
 * If `predictDn > polyNo_ask + threshold` (equivalently, polyYes_bid > predictUp
 * + threshold), Predict thinks the event is less likely than Polymarket does →
 * buy "Yes" on Predict (UP cheap on Predict), sell on Polymarket.
 *
 * For paper trading we record both legs as a notional opportunity.
 */

import { binaryUpFromTotalVariance, invertIV } from '../pricing/bs.js';
import { evalTotalVariance, tYearsFromMs } from '../pricing/svi.js';
import type { OracleSnapshot, PolymarketSnapshot, SVIParams } from 'svx-shared/types';

export interface SpreadResult {
  /** Predict's UP probability evaluated at Polymarket's strike. */
  predictUp: number;
  /** Predict's annualized IV at this strike. */
  predictIv: number;
  /** Polymarket's "Yes" ask (what we'd pay to BUY yes). */
  polyYesAsk: number;
  /** Polymarket's "Yes" bid (what we'd RECEIVE if we sold yes). */
  polyYesBid: number;
  /** IV implied by Polymarket's "Yes" ask. */
  polyIv: number | null;
  /** predictUp - polyYesAsk; positive means Predict favors UP more. */
  spreadBuyOnPoly: number;
  /** polyYesBid - predictUp; positive means Predict favors UP less. */
  spreadSellOnPoly: number;
  /**
   * The trade we'd take (or null if neither side beats threshold). Direction is
   * the side we'd buy on Predict — UP means buy UP on Predict + sell Yes on
   * Polymarket; DOWN means buy DOWN on Predict + buy Yes on Polymarket.
   */
  decision: TradeDecision | null;
}

export interface TradeDecision {
  /** Which side to take on Predict. */
  predictDirection: 'up' | 'down';
  /** Magnitude of the edge (max of the two spreads, in probability points). */
  edge: number;
  /** Spread in IV points. */
  ivEdge: number;
  /** A short human-readable rationale for the log. */
  rationale: string;
}

export interface ComputeSpreadInput {
  oracleSnapshot: OracleSnapshot;
  polymarketSnapshot: PolymarketSnapshot;
  threshold: number;
  /** Override for "now" — used in backtests. */
  nowMs?: number;
}

export function computeSpread(input: ComputeSpreadInput): SpreadResult {
  const { oracleSnapshot: o, polymarketSnapshot: p, threshold } = input;
  const now = input.nowMs ?? Date.now();
  const T = tYearsFromMs(o.expiryMs - now);

  const predictUp = sviUpAtStrike(p.strike, o.forward, o.svi);
  const predictIv = T > 0 ? Math.sqrt(evalTotalVariance(Math.log(p.strike / o.forward), o.svi) / T) : NaN;
  const polyIv = T > 0 && p.yesAsk > 0 && p.yesAsk < 1
    ? invertIV(p.yesAsk, p.strike, o.forward, T)
    : null;

  const spreadBuyOnPoly = predictUp - p.yesAsk; // buy Yes on Poly cheap, sell-equivalent (DOWN) on Predict
  const spreadSellOnPoly = p.yesBid - predictUp; // sell Yes on Poly rich, buy UP on Predict

  let decision: TradeDecision | null = null;
  if (spreadBuyOnPoly > threshold && spreadBuyOnPoly >= spreadSellOnPoly) {
    decision = {
      predictDirection: 'down',
      edge: spreadBuyOnPoly,
      ivEdge: predictIv && polyIv ? predictIv - polyIv : NaN,
      rationale: `Predict UP=${pct(predictUp)} > Poly Yes ask=${pct(p.yesAsk)} by ${pct(spreadBuyOnPoly)} → buy Yes Poly + buy DOWN Predict`,
    };
  } else if (spreadSellOnPoly > threshold) {
    decision = {
      predictDirection: 'up',
      edge: spreadSellOnPoly,
      ivEdge: predictIv && polyIv ? polyIv - predictIv : NaN,
      rationale: `Poly Yes bid=${pct(p.yesBid)} > Predict UP=${pct(predictUp)} by ${pct(spreadSellOnPoly)} → sell Yes Poly + buy UP Predict`,
    };
  }

  return {
    predictUp,
    predictIv,
    polyYesAsk: p.yesAsk,
    polyYesBid: p.yesBid,
    polyIv: isFinite(polyIv ?? NaN) ? (polyIv as number) : null,
    spreadBuyOnPoly,
    spreadSellOnPoly,
    decision,
  };
}

function sviUpAtStrike(strike: number, forward: number, svi: SVIParams): number {
  const k = Math.log(strike / forward);
  const w = evalTotalVariance(k, svi);
  return binaryUpFromTotalVariance(strike, forward, w);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}
