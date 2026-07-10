/**
 * Butterfly harvester — TELEMETRY stage.
 *
 * The SVI surface implies a digital price P_up(K) that must be
 * non-increasing in K (an UP binary at a higher strike can never be more
 * likely to pay). When a fitted surface violates that, the crossed strikes
 * form a near-riskless structure:
 *
 *   K1 < K2 with P_up(K2) > P_up(K1):
 *     buy UP(K1) at ~P_up(K1)  +  buy DOWN(K2) at ~1 − P_up(K2)
 *     combined cost = 1 − (P_up(K2) − P_up(K1))  <  1
 *     payoff ≥ 1 always (settle ≤ K2 pays the DOWN, settle > K1 pays the
 *     UP; both pay 2 in between) → riskless gross ≥ the margin.
 *
 * SVI fits are smooth, so violations are rare and transient — which is why
 * this ships as telemetry first: count real opportunities (and whether
 * their margin survives the protocol fee) before wiring any execution.
 * This module is pure math; loop wiring + persistence live in index.ts.
 */

export interface CrossedStrikePair {
  lowerStrike: number;
  higherStrike: number;
  upLower: number;
  upHigher: number;
  /** P_up(K2) − P_up(K1): riskless gross profit per $1 pair, pre-fee. */
  marginFrac: number;
}

/**
 * Scan a strike grid (sorted ascending) for digital-monotonicity
 * violations. Adjacent pairs suffice for detection (any crossing implies an
 * adjacent crossing), but the WIDEST enclosing pair carries the largest
 * margin — so this merges runs of consecutive violations into one pair per
 * run, from the strike before the run starts to its peak.
 */
export function findCrossedStrikes(
  points: Array<{ strike: number; up: number }>,
  minMarginFrac: number,
): CrossedStrikePair[] {
  const out: CrossedStrikePair[] = [];
  if (points.length < 2) return out;

  let i = 0;
  while (i < points.length - 1) {
    if (points[i + 1]!.up <= points[i]!.up) {
      i++;
      continue;
    }
    // A rising run starts at i — extend to its peak.
    const start = points[i]!;
    let j = i + 1;
    while (j < points.length - 1 && points[j + 1]!.up > points[j]!.up) j++;
    const peak = points[j]!;
    const marginFrac = peak.up - start.up;
    if (marginFrac >= minMarginFrac) {
      out.push({
        lowerStrike: start.strike,
        higherStrike: peak.strike,
        upLower: start.up,
        upHigher: peak.up,
        marginFrac,
      });
    }
    i = j;
  }
  return out;
}
