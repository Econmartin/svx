/**
 * Tests for the Hyperliquid hedge leg (Part 2).
 *
 * Covers:
 *   - binaryDeltaWrtSpot: signs, magnitudes, edge cases, clamp.
 *   - hedgeSizeForPolyFill: directional choice, USD notional math.
 *   - parseHlOrderResponse: full fill / partial / rejected shapes.
 *   - RiskGate.checkHl: per-trade cap, exposure cap, daily-loss gate.
 *   - Combined PnL math: poly + HL → variance reduction direction.
 */

import { describe, it, expect } from 'vitest';
import {
  binaryDeltaWrtSpot,
  hedgeSizeForPolyFill,
  MAX_DELTA,
} from '../src/pricing/binary-delta.js';
import {
  parseHlOrderResponse,
  formatPriceForHl,
  formatSize,
} from '../src/exec/hyperliquid-client.js';
import { RiskGate } from '../src/exec/risk.js';
import type { SvxConfig } from '../src/config.js';
import type { LedgerStore } from '../src/ledger/store.js';

const baseCfg: SvxConfig = {
  paperTrading: true,
  spreadThreshold: 0.03,
  maxPositionDusdc: 15,
  maxPositionPct: 0.5,
  dailyLossLimitDusdc: 150,
  maxOpenPositions: 10,
  maxPositionsPerSignal: 2,
  minPredictProb: 0.05,
  maxPredictProb: 0.95,
  signalLogMinSpreadFrac: 0.3,
  maxSviStalenessSec: 300,
  polyMaxBidaskVolPts: 0.05,
  polyMinVolume24hUsd: 1000,
  expiryToleranceSec: 3600,
  circuitBreakerLosses: 5,
  polymarketGammaBase: 'https://gamma-api.polymarket.com',
  polymarketClobBase: 'https://clob.polymarket.com',
  polyExecutionEnabled: false,
  polyNetwork: 'polygon',
  polyClobHost: '',
  polyRpcUrl: '',
  maxPolyPositionUsdc: 2,
  maxOpenPolyPositions: 5,
  polyMinBookDepthShares: 20,
  polyMinOrderUsdc: 0.5,
  polyFillFailedCooldownMs: 5 * 60_000,
  dailyPolyLossLimitUsdc: 10,
  polyFillTimeoutMs: 30_000,
  polyStaleSettlementDays: 14,
  predictStaleRedeemHours: 6,
  polyStopLossFrac: 0.5,
  polyExitMaxSlippagePts: 0.02,
  polyEntryMaxSlippagePts: 0.02,
  polyReentryCooldownMs: 1_800_000,
  polyMinEntryPrice: 0.03,
  polyMaxEntryPrice: 0.97,
  polyMinEvFrac: 0.05,
  convergenceEnabled: true,
  convergenceMaxMinutes: 90,
  convergenceMinMinutes: 5,
  convergenceMinSigma: 4,
  convergenceMinPrice: 0.9,
  convergenceMaxPrice: 0.97,
  convergenceMinEvFrac: 0.02,
  maxConvergencePerTradeUsdc: 4,
  convergenceCheckIntervalMs: 60_000,
  divergenceMintEnabled: true,
  divergenceMintThreshold: 0.08,
  divergenceMintMaxCostPrice: 0.95,
  divergenceMintNotionalDusdc: 5,
  divergenceMintMaxOpen: 10,
  divergenceMintDailyLossLimitDusdc: 20,
  convergenceSigmaSafetyMult: 2,
  convergenceMinRvHistoryMs: 15 * 60_000,
  convergenceStrikeBandLoFrac: 0.5,
  convergenceStrikeBandHiFrac: 2.0,
  convergenceStopLossFrac: 0.15,
  polyRedeemRetryGapMs: 30 * 60_000,
  polyRedeemMaxAttempts: 5,
  reconcileDriftThresholdUsdc: 5,
  hlHedgeEnabled: true,
  polySignatureType: 'EOA',
  polyFunderAddress: '',
  hlExecutionEnabled: true,
  hlNetwork: 'mainnet',
  hlHedgeAsset: 'BTC',
  hlMinOrderUsdc: 10,
  hlTakerFeeRate: 0.00035,
  maxHlPerTradeUsdc: 2,
  maxHlOpenUsdc: 10,
  dailyHlLossLimitUsdc: 5,
  hlRequiredForPoly: false,
  volArbEnabled: false,
  volArbIvSpreadOpenThreshold: 0.05,
  volArbIvSpreadCloseThreshold: 0.02,
  volArbDirectionBiasThreshold: 0.03,
  volArbBiasBypassSpread: 0.15,
  maxVolArbPerTradeUsdc: 2,
  maxVolArbOpenUsdc: 10,
  dailyVolArbLossLimitUsdc: 5,
  volArbTimeStopMinutes: 60,
  volArbMinSamples: 30,
  volArbTickMs: 2_000,
  volArbOracleCacheMs: 30_000,
  marginLeverEnabled: false,
  marginLeverOpenBias: 0.10,
  marginLeverCloseBias: 0.04,
  marginLeverMaxHoldMinutes: 45,
  marginLeverPerTradeNotionalUsdc: 500,
  marginLeverMaxBorrowNotionalUsdc: 1500,
  marginLeverDailyLossLimitUsdc: 100,
  marginLeverTickMs: 15_000,
  polyEarlyExitEnabled: true,
  polyEarlyExitMinProfitFrac: 0.2,
  autoResumeOnBoot: true,
  dataDir: '/tmp/svx-test',
  apiHost: '127.0.0.1',
  apiPort: 4321,
  loopIntervalMs: 15_000,
  instanceLabel: '',
};

describe('binaryDeltaWrtSpot', () => {
  it('returns 0 for malformed inputs', () => {
    expect(binaryDeltaWrtSpot({ spot: 0, strike: 100, ivAnnual: 0.5, ttmYears: 0.1 }).magnitude).toBe(0);
    expect(binaryDeltaWrtSpot({ spot: 100, strike: 0, ivAnnual: 0.5, ttmYears: 0.1 }).magnitude).toBe(0);
    expect(binaryDeltaWrtSpot({ spot: 100, strike: 100, ivAnnual: 0, ttmYears: 0.1 }).magnitude).toBe(0);
    expect(binaryDeltaWrtSpot({ spot: 100, strike: 100, ivAnnual: 0.5, ttmYears: 0 }).magnitude).toBe(0);
  });

  it('peaks near the strike (gamma is highest at-the-money)', () => {
    // ATM (strike = spot) for short expiry → maximum delta among nearby strikes.
    const atm = binaryDeltaWrtSpot({ spot: 80_000, strike: 80_000, ivAnnual: 0.6, ttmYears: 0.05 });
    const otm = binaryDeltaWrtSpot({ spot: 80_000, strike: 90_000, ivAnnual: 0.6, ttmYears: 0.05 });
    const itm = binaryDeltaWrtSpot({ spot: 80_000, strike: 70_000, ivAnnual: 0.6, ttmYears: 0.05 });
    expect(atm.magnitude).toBeGreaterThan(otm.magnitude);
    expect(atm.magnitude).toBeGreaterThan(itm.magnitude);
  });

  it('falls off as time to expiry grows (more time = lower gamma)', () => {
    const short = binaryDeltaWrtSpot({ spot: 80_000, strike: 80_000, ivAnnual: 0.5, ttmYears: 0.01 });
    const long = binaryDeltaWrtSpot({ spot: 80_000, strike: 80_000, ivAnnual: 0.5, ttmYears: 0.5 });
    expect(short.magnitude).toBeGreaterThan(long.magnitude);
  });

  it('clamps at MAX_DELTA when gamma would blow up at near-zero TTM', () => {
    const r = binaryDeltaWrtSpot({
      spot: 80_000,
      strike: 80_000,
      ivAnnual: 0.5,
      ttmYears: 1e-12,
    });
    expect(r.magnitude).toBe(MAX_DELTA);
    expect(r.clamped).toBe(true);
  });
});

describe('hedgeSizeForPolyFill', () => {
  it('picks SHORT when we bought Yes (long-BTC exposure)', () => {
    const r = hedgeSizeForPolyFill({
      spot: 80_000,
      strike: 80_000,
      ivAnnual: 0.6,
      ttmYears: 0.05,
      shares: 10,
      polyOutcome: 'yes',
    });
    expect(r.hedgeSide).toBe('short');
    expect(r.btcSize).toBeGreaterThan(0);
    expect(r.usdNotional).toBeCloseTo(r.btcSize * 80_000);
  });

  it('picks LONG when we bought No (short-BTC exposure)', () => {
    const r = hedgeSizeForPolyFill({
      spot: 80_000,
      strike: 80_000,
      ivAnnual: 0.6,
      ttmYears: 0.05,
      shares: 10,
      polyOutcome: 'no',
    });
    expect(r.hedgeSide).toBe('long');
  });

  it('scales hedge linearly with share count', () => {
    const small = hedgeSizeForPolyFill({
      spot: 80_000,
      strike: 80_000,
      ivAnnual: 0.6,
      ttmYears: 0.05,
      shares: 5,
      polyOutcome: 'yes',
    });
    const big = hedgeSizeForPolyFill({
      spot: 80_000,
      strike: 80_000,
      ivAnnual: 0.6,
      ttmYears: 0.05,
      shares: 25,
      polyOutcome: 'yes',
    });
    expect(big.btcSize / small.btcSize).toBeCloseTo(5, 4);
  });
});

describe('parseHlOrderResponse', () => {
  it('treats a fully-filled response as filled', () => {
    const resp = {
      status: 'ok',
      response: {
        type: 'order',
        data: { statuses: [{ filled: { totalSz: '0.001', avgPx: '82500.5', oid: 12345 } }] },
      },
    };
    const r = parseHlOrderResponse(resp, 0.001);
    expect(r.status).toBe('filled');
    expect(r.fillPrice).toBeCloseTo(82500.5);
    expect(r.filledSize).toBeCloseTo(0.001);
    expect(r.orderId).toBe('12345');
  });

  it('treats a smaller fill than requested as partial', () => {
    const resp = {
      response: {
        data: { statuses: [{ filled: { totalSz: '0.0005', avgPx: '82500', oid: 999 } }] },
      },
    };
    const r = parseHlOrderResponse(resp, 0.001);
    expect(r.status).toBe('partial');
    expect(r.filledSize).toBeCloseTo(0.0005);
  });

  it('treats an empty statuses array as rejected', () => {
    const r = parseHlOrderResponse({ response: { data: { statuses: [] } } }, 0.001);
    expect(r.status).toBe('rejected');
    expect(r.filledSize).toBe(0);
  });

  it('treats a status with `error` as rejected', () => {
    const r = parseHlOrderResponse(
      { response: { data: { statuses: [{ error: 'insufficient margin' }] } } },
      0.001,
    );
    expect(r.status).toBe('rejected');
  });

  it('regression: real production fill where HL rounds to szDecimals (was incorrectly marked partial)', () => {
    // Captured from production 2026-05-16. Bot requested 0.000140453 BTC,
    // sent formatted 0.00014, HL filled 0.00014 reported back. Before the
    // tolerance fix this was marked 'partial' and the trade wasn't
    // recorded — orphan position. Should now be 'filled'.
    const resp = {
      response: {
        type: 'order',
        data: {
          statuses: [
            { filled: { totalSz: '0.00014', avgPx: '78318', oid: 428355383448 } },
          ],
        },
      },
    };
    // Raw size requested (full precision)
    const r1 = parseHlOrderResponse(resp, 0.000140453921537332);
    expect(r1.status).toBe('filled');
    expect(r1.filledSize).toBeCloseTo(0.00014);
    expect(r1.orderId).toBe('428355383448');
    // Formatted size (what the client now passes after the fix)
    const r2 = parseHlOrderResponse(resp, 0.00014);
    expect(r2.status).toBe('filled');
  });
});

describe('RiskGate.checkHl', () => {
  function makeRisk(opts: { hlPnl24h?: number; paused?: boolean } = {}) {
    const fake = {
      getPause: () => ({ paused: !!opts.paused, reason: 'test pause' }),
      setPause: () => {},
      consecutiveLosses: () => 0,
      realizedPolyPnlSince: () => 0,
      realizedHlPnlSince: () => opts.hlPnl24h ?? 0,
    } as unknown as LedgerStore;
    return new RiskGate(fake, baseCfg, `/tmp/svx-paused-test-${Math.random()}`);
  }

  it('passes when notional + exposure under caps', () => {
    const r = makeRisk();
    expect(r.checkHl({ notionalUsdc: 1, openHlExposureUsdc: 0 }).ok).toBe(true);
  });

  it('blocks when notional exceeds per-trade cap', () => {
    const r = makeRisk();
    const d = r.checkHl({ notionalUsdc: 5, openHlExposureUsdc: 0 });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/per-trade cap/);
  });

  it('blocks when total exposure (existing + proposed) exceeds total cap', () => {
    const r = makeRisk();
    const d = r.checkHl({ notionalUsdc: 2, openHlExposureUsdc: 9.5 });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/total exposure/);
  });

  it('blocks + pauses when 24h HL PnL hits the daily loss limit', () => {
    const r = makeRisk({ hlPnl24h: -5 });
    const d = r.checkHl({ notionalUsdc: 1, openHlExposureUsdc: 0 });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/24h HL loss/);
  });
});

describe('formatPriceForHl', () => {
  // Hyperliquid: max (6 - szDecimals) decimals AND max 5 significant figures
  // — whichever is more restrictive.

  it('produces integer-only prices for BTC at $78k (sig-figs wins)', () => {
    // szDecimals=5 → decimal rule allows 1 decimal (78582.5)
    // Sig-figs rule (5 total) at 78k → no decimals (78583)
    // The tighter rule wins.
    expect(formatPriceForHl(78582.5, 5)).toBe('78583');
    expect(formatPriceForHl(80168.43, 5)).toBe('80168');
    expect(formatPriceForHl(77010.85, 5)).toBe('77011');
  });

  it('rejects regression: previous formatPrice produced .5 prices that HL rejected', () => {
    // The bot's logs showed limitPx=77010.85, 80168.43 — both rejected with
    // "Price must be divisible by tick size". Formatter must now produce
    // integers at this magnitude.
    expect(formatPriceForHl(77010.85, 5)).not.toMatch(/\./);
    expect(formatPriceForHl(80168.43, 5)).not.toMatch(/\./);
  });

  it('allows 1 decimal for ETH at $3.2k (sig-figs+decimal both allow 1)', () => {
    // szDecimals=4 → max 2 decimals from perp rule
    // Sig-figs at 3245 → 1 decimal allowed
    // Min(2, 1) = 1 decimal.
    expect(formatPriceForHl(3245.67, 4)).toBe('3245.7');
  });

  it('allows more decimals for low-price assets', () => {
    // A $1.234 token with szDecimals=0 → 4 decimals from sig-figs rule
    expect(formatPriceForHl(1.23456, 0)).toBe('1.2346');
  });

  it('floors to 0 for invalid inputs', () => {
    expect(formatPriceForHl(0, 5)).toBe('0');
    expect(formatPriceForHl(-100, 5)).toBe('0');
    expect(formatPriceForHl(Infinity, 5)).toBe('0');
    expect(formatPriceForHl(NaN, 5)).toBe('0');
  });
});

describe('formatSize', () => {
  it('honors szDecimals for size precision', () => {
    expect(formatSize(0.00012345, 5)).toBe('0.00012');
    expect(formatSize(1.23456, 4)).toBe('1.2346');
    expect(formatSize(100, 0)).toBe('100');
  });
});

describe('combined PnL: hedge reduces directional variance', () => {
  // Sanity check on the framing: across a few synthetic outcomes, the
  // combined (poly + hl) PnL has a smaller swing than the poly-only PnL.
  function syntheticTrade(outcome: 'win' | 'lose'): {
    polyPnl: number;
    hlPnl: number;
  } {
    // 10 shares of Yes at 0.30 → cost $3, payout $10 if win, $0 if lose.
    const poly = outcome === 'win' ? 10 - 3 : 0 - 3;
    // Short BTC perp sized at delta × shares. Outcome moves the perp the
    // OPPOSITE direction (winning the binary means BTC rose, perp lost).
    const hl = outcome === 'win' ? -4 : +2; // win → perp lost $4; lose → perp won $2
    return { polyPnl: poly, hlPnl: hl };
  }

  it('shows lower std-dev for combined vs. poly-only across paired outcomes', () => {
    const wins = syntheticTrade('win');
    const losses = syntheticTrade('lose');
    const polySwing = wins.polyPnl - losses.polyPnl; // +10
    const combinedSwing = wins.polyPnl + wins.hlPnl - (losses.polyPnl + losses.hlPnl); // 3 - (-1) = 4
    expect(Math.abs(combinedSwing)).toBeLessThan(Math.abs(polySwing));
  });
});
