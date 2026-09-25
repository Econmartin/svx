import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore, type CrossVenuePairInput, type CrossVenuePairRow } from '../src/ledger/store.js';
import { pmTakerFee, scoreCrossVenue } from '../src/ops/cross-venue.js';

describe('pmTakerFee (Polymarket crypto_fees_v2)', () => {
  it('matches the published 1.75¢ per share peak at 50¢ with rate 0.07', () => {
    expect(pmTakerFee(0.5, 0.07, 1)).toBeCloseTo(0.0175, 10);
  });
  it('is zero when fees are disabled', () => {
    expect(pmTakerFee(0.5, 0, 1)).toBe(0);
    expect(pmTakerFee(0.5, null, 1)).toBe(0);
  });
});

const row = (over: Partial<CrossVenuePairRow>): CrossVenuePairRow => ({
  marketId: '0xm',
  slot: 't4m',
  predCostUp: 0.271,
  predCostDown: 0.89,
  pmAskUp: 0.34,
  pmAskDown: 0.67,
  pmDepthUp: 38,
  pmDepthDown: 993,
  pmFeeRate: 0.07,
  pmFeeExponent: 1,
  predOutcomeUp: false,
  pmOutcomeUp: false,
  ...over,
});

describe('scoreCrossVenue', () => {
  it('prices the 2026-09-25 window: Predict-Up + PM-Down under $1 including PM fee', () => {
    const s = scoreCrossVenue([row({})]);
    const c = s.combos.find((x) => x.combo === 'predUp_pmDown' && x.slot === 'all')!;
    expect(c.underDollar).toBe(1);
    expect(c.avgCostWhenUnder!).toBeCloseTo(0.271 + 0.67 + 0.07 * 0.67 * 0.33, 6);
    // Both venues said Down: the PM leg pays $1.
    expect(c.realizedPnlWhenUnder!).toBeCloseTo(1 - c.avgCostWhenUnder!, 6);
    const other = s.combos.find((x) => x.combo === 'pmUp_predDown' && x.slot === 'all')!;
    expect(other.underDollar).toBe(0); // 0.34 + 0.89 > $1
  });

  it('counts a settlement-rule disagreement where both legs lose', () => {
    // Predict: Down (spot not above reference). Polymarket: Up (TWAP >= start).
    const s = scoreCrossVenue([row({ marketId: '0xa', predOutcomeUp: false, pmOutcomeUp: true })]);
    const c = s.combos.find((x) => x.combo === 'predUp_pmDown' && x.slot === 'all')!;
    expect(c.bothLost).toBe(1);
    expect(c.realizedPnlWhenUnder!).toBeLessThan(-0.9);
    expect(s.disagreementRate).toBe(1);
  });

  it('counts each window once in the disagreement rate across slots', () => {
    const s = scoreCrossVenue([
      row({ marketId: '0xa', slot: 't4m', pmOutcomeUp: true }),
      row({ marketId: '0xa', slot: 't50s', pmOutcomeUp: true }),
      row({ marketId: '0xb', slot: 't4m' }),
    ]);
    expect(s.windows).toBe(2);
    expect(s.disagreementRate).toBe(0.5);
  });
});

describe('cross-venue ledger', () => {
  let tmp: string;
  let ledger: LedgerStore;
  const base: CrossVenuePairInput = {
    network: 'mainnet',
    marketId: '0xm',
    pmConditionId: '0xc',
    slot: 't4m',
    expiryMs: 1_000_000,
    recordedAtMs: 760_000,
    ttmMs: 240_000,
    predReference: 84_000,
    predBoardUp: 0.19,
    predCostUp: 0.271,
    predCostDown: 0.89,
    pmAskUp: 0.34,
    pmAskDown: 0.67,
    pmDepthUp: 38,
    pmDepthDown: 993,
    pmFeeRate: 0.07,
    pmFeeExponent: 1,
    spotMid: 84_010,
  };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-cvp-'));
    ledger = new LedgerStore(path.join(tmp, 'svx.sqlite'));
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('only reports a pair once BOTH venues have resolved', () => {
    expect(ledger.insertCrossVenuePair(base)).toBe(true);
    expect(ledger.insertCrossVenuePair(base)).toBe(false);
    expect(ledger.unresolvedCrossVenuePairs(2_000_000)).toEqual([
      { marketId: '0xm', pmConditionId: '0xc', needPred: true, needPm: true },
    ]);
    ledger.resolveCrossVenuePred('0xm', 84_000, 1_000_100); // tie → Predict Down
    expect(ledger.resolvedCrossVenuePairs('mainnet')).toEqual([]);
    ledger.resolveCrossVenuePm('0xc', true, 1_000_200);
    const rows = ledger.resolvedCrossVenuePairs('mainnet');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.predOutcomeUp).toBe(false);
    expect(rows[0]!.pmOutcomeUp).toBe(true);
    expect(ledger.unresolvedCrossVenuePairs(2_000_000)).toEqual([]);
  });
});
