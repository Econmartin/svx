import { describe, it, expect } from 'vitest';
import { matchOraclesToPoly } from '../src/signal/match.js';
import type { PolyStrikeMarket } from '../src/pricing/polymarket.js';
import type { PredictOracleSummary } from '../src/pricing/predict.js';

const baseOracle: PredictOracleSummary = {
  oracleId: '0xa',
  underlyingAsset: 'BTC',
  expiryMs: 1_000_000,
  minStrike: 50_000,
  tickSize: 1,
  status: 'active',
};

const polyAt80k: PolyStrikeMarket = {
  conditionId: 'c1',
  strike: 80_000,
  expiryMs: 1_000_000,
  question: 'Will the price of Bitcoin be above $80,000 on test?',
  yesTokenId: 'y',
  noTokenId: 'n',
  yesMid: 0.5,
  noMid: 0.5,
  volume24hr: 50_000,
  liquidity: 10_000,
};

describe('matchOraclesToPoly', () => {
  it('matches when strike is on-grid and expiry is exact', () => {
    const matches = matchOraclesToPoly([baseOracle], [polyAt80k]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.expiryDeltaMs).toBe(0);
  });

  it('matches when expiry is far apart (loose mode), reports the delta', () => {
    const farOracle: PredictOracleSummary = { ...baseOracle, expiryMs: 9_000_000 };
    const matches = matchOraclesToPoly([farOracle], [polyAt80k]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.expiryDeltaMs).toBe(8_000_000);
  });

  it('rejects when toleranceMs is exceeded', () => {
    const farOracle: PredictOracleSummary = { ...baseOracle, expiryMs: 9_000_000 };
    expect(matchOraclesToPoly([farOracle], [polyAt80k], 1_000)).toEqual([]);
  });

  it('rejects strikes outside the grid', () => {
    const tinyOracle: PredictOracleSummary = { ...baseOracle, minStrike: 50_000, tickSize: 1 };
    const wayOut: PolyStrikeMarket = { ...polyAt80k, strike: 200_000 };
    expect(matchOraclesToPoly([tinyOracle], [wayOut])).toEqual([]);
  });

  it('rejects strikes that aren’t on the tick grid', () => {
    const o: PredictOracleSummary = { ...baseOracle, minStrike: 50_000, tickSize: 100 };
    const offGrid: PolyStrikeMarket = { ...polyAt80k, strike: 80_050 }; // 50 = half a tick
    expect(matchOraclesToPoly([o], [offGrid])).toEqual([]);
  });

  it('picks the closest-by-expiry oracle when multiple are eligible', () => {
    const oracles: PredictOracleSummary[] = [
      { ...baseOracle, oracleId: '0xa', expiryMs: 100 },
      { ...baseOracle, oracleId: '0xb', expiryMs: 1_000 },
      { ...baseOracle, oracleId: '0xc', expiryMs: 10_000 },
    ];
    const poly: PolyStrikeMarket = { ...polyAt80k, expiryMs: 950 };
    const matches = matchOraclesToPoly(oracles, [poly]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.oracle.oracleId).toBe('0xb');
  });

  it('skips non-BTC oracles', () => {
    const eth: PredictOracleSummary = { ...baseOracle, underlyingAsset: 'ETH' };
    expect(matchOraclesToPoly([eth], [polyAt80k])).toEqual([]);
  });
});
