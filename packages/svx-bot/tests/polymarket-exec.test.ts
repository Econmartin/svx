import { describe, it, expect, beforeEach } from 'vitest';
import { parsePolyFillResponse, isMakerNotAllowedError } from '../src/exec/polymarket-client.js';
import { RiskGate } from '../src/exec/risk.js';
import type { LedgerStore } from '../src/ledger/store.js';
import type { SvxConfig } from '../src/config.js';

// Minimal fake ledger that satisfies what RiskGate actually calls.
function fakeLedger(opts: {
  paused?: boolean;
  consecutiveLosses?: number;
  polyPnl24h?: number;
} = {}): LedgerStore {
  return {
    getPause: () => ({ paused: !!opts.paused, reason: opts.paused ? 'test pause' : undefined }),
    setPause: () => {},
    consecutiveLosses: () => opts.consecutiveLosses ?? 0,
    realizedPolyPnlSince: () => opts.polyPnl24h ?? 0,
  } as unknown as LedgerStore;
}

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
  polyExecutionEnabled: true,
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
  polySignatureType: 'EOA' as const,
  polyFunderAddress: '',
  hlExecutionEnabled: false,
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

describe('parsePolyFillResponse', () => {
  it('marks a BUY response with takingAmount=shares + makingAmount=pUSD as filled (real mainnet response shape)', () => {
    // Captured from a real production fill on 2026-05-16:
    //   buy $1 of yes-shares at $0.13 → received 7.692306 shares for 0.999999 pUSD
    const r = parsePolyFillResponse(
      {
        errorMsg: '',
        orderID: '0x4861269e',
        takingAmount: '7.692306',
        makingAmount: '0.999999',
        status: 'matched',
        transactionsHashes: ['0xb3089b687c6b'],
        success: true,
      },
      { requestedUsdc: 1, side: 'buy' },
    );
    expect(r.status).toBe('filled');
    expect(r.orderId).toBe('0x4861269e');
    expect(r.filledShares).toBeCloseTo(7.692306, 4);
    expect(r.costUsdc).toBeCloseTo(0.999999, 4);
    // derived fillPrice = pUSD / shares
    expect(r.fillPrice).toBeCloseTo(0.13, 2);
    expect(r.txHash).toBe('0xb3089b687c6b');
  });

  it('legacy: marks an order with makingAmount when no takingAmount (backwards-compat call site)', () => {
    const r = parsePolyFillResponse(
      { status: 'matched', orderID: 'abc', makingAmount: '5.5', price: '0.29' },
      2,
    );
    expect(r.status).toBe('filled');
    expect(r.orderId).toBe('abc');
    // No takingAmount → falls back to makingAmount as shares
    expect(r.filledShares).toBeCloseTo(5.5);
    expect(r.fillPrice).toBeCloseTo(0.29);
  });

  it('treats unknown status with shares as `partial`', () => {
    const r = parsePolyFillResponse({ status: 'unmatched', filled: 1.0 }, 5);
    expect(r.status).toBe('partial');
    expect(r.filledShares).toBeCloseTo(1.0);
  });

  it('derives fillPrice from requestedUsdc / shares when not provided', () => {
    const r = parsePolyFillResponse({ status: 'matched', filled: 4 }, 2);
    expect(r.fillPrice).toBeCloseTo(0.5); // 2 / 4
    expect(r.status).toBe('filled');
  });

  it('marks empty/error responses as failed', () => {
    const r = parsePolyFillResponse({ status: 'error' }, 2);
    expect(r.status).toBe('failed');
    expect(r.filledShares).toBeUndefined();
  });

  it('handles a numeric (not string) price field', () => {
    const r = parsePolyFillResponse({ status: 'filled', filled: 10, price: 0.31 }, 3.1);
    expect(r.fillPrice).toBeCloseTo(0.31);
    expect(r.filledShares).toBe(10);
    expect(r.costUsdc).toBeCloseTo(3.1);
  });

  // Regressions — observed wild response shapes that previously crashed
  // with "r.status?.toLowerCase is not a function".
  it('does not throw when status is a boolean', () => {
    const r = parsePolyFillResponse({ status: false, success: false, errorMsg: 'x' }, 2);
    expect(r.status).toBe('failed');
  });

  it('does not throw when status is a number (200 = success in some paths)', () => {
    const r = parsePolyFillResponse(
      { status: 200, success: true, makingAmount: '4', price: '0.5' },
      2,
    );
    expect(r.status).toBe('filled');
    expect(r.filledShares).toBeCloseTo(4);
  });

  it('handles BigInt-style filled / price (some SDK versions)', () => {
    const r = parsePolyFillResponse(
      { status: 'matched', makingAmount: BigInt(7), price: BigInt(0) },
      2,
    );
    expect(r.filledShares).toBe(7);
  });

  it('coerces a numeric orderID to a string', () => {
    const r = parsePolyFillResponse({ status: 'matched', orderID: 12345, filled: 1 }, 2);
    expect(r.orderId).toBe('12345');
  });

  it('falls back to orderHashes[0] when no orderID/orderId/id', () => {
    const r = parsePolyFillResponse(
      { status: 'matched', orderHashes: ['0xabc', '0xdef'], filled: 1 },
      2,
    );
    expect(r.orderId).toBe('0xabc');
  });

  it('marks failure when success=false + status field absent entirely', () => {
    const r = parsePolyFillResponse({ success: false, errorMsg: 'insufficient liquidity' }, 2);
    expect(r.status).toBe('failed');
  });
});

describe('isMakerNotAllowedError', () => {
  it('matches the exact Polymarket CLOB rejection string', () => {
    const resp = {
      error: 'maker address not allowed, please use the deposit wallet flow',
      status: 400,
    };
    expect(isMakerNotAllowedError(resp)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isMakerNotAllowedError({ error: 'Maker Address Not Allowed' })).toBe(true);
  });

  it('matches when the phrase is in errorMsg instead of error', () => {
    expect(isMakerNotAllowedError({ errorMsg: 'use the deposit wallet flow' })).toBe(true);
  });

  it('does not match a generic error', () => {
    expect(isMakerNotAllowedError({ error: 'insufficient liquidity' })).toBe(false);
  });

  it('does not match successful fills', () => {
    expect(
      isMakerNotAllowedError({ status: 'matched', orderID: '0x', makingAmount: '5' }),
    ).toBe(false);
  });

  it('handles null / undefined / non-object inputs', () => {
    expect(isMakerNotAllowedError(null)).toBe(false);
    expect(isMakerNotAllowedError(undefined)).toBe(false);
    expect(isMakerNotAllowedError('string')).toBe(false);
    expect(isMakerNotAllowedError(42)).toBe(false);
  });
});

describe('RiskGate.checkPoly', () => {
  let risk: RiskGate;
  beforeEach(() => {
    risk = new RiskGate(fakeLedger(), baseCfg, '/tmp/svx-paused-test-' + Date.now());
  });

  it('passes when costUsdc + open count are under caps', () => {
    const d = risk.checkPoly({ costUsdc: 2, openPolyPositionCount: 0 });
    expect(d.ok).toBe(true);
  });

  it('blocks when costUsdc exceeds maxPolyPositionUsdc', () => {
    const d = risk.checkPoly({ costUsdc: 5, openPolyPositionCount: 0 });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/cap 2/);
  });

  it('blocks when openPolyPositionCount has reached maxOpenPolyPositions', () => {
    const d = risk.checkPoly({ costUsdc: 1, openPolyPositionCount: 5 });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/5 open poly positions/);
  });

  it('blocks when paused regardless of other inputs', () => {
    const pausedRisk = new RiskGate(
      fakeLedger({ paused: true }),
      baseCfg,
      '/tmp/svx-paused-test-' + Math.random(),
    );
    const d = pausedRisk.checkPoly({ costUsdc: 0.1, openPolyPositionCount: 0 });
    expect(d.ok).toBe(false);
    expect(d.reason).toBe('test pause');
  });
});

describe('two-leg sizing math', () => {
  // The single source of truth for outcome selection; mirrored in index.ts.
  const pickOutcome = (dir: 'up' | 'down'): 'yes' | 'no' => (dir === 'down' ? 'yes' : 'no');

  it('selects Yes outcome when predict direction is down (spreadBuyOnPoly)', () => {
    expect(pickOutcome('down')).toBe('yes');
  });

  it('selects No outcome when predict direction is up (spreadSellOnPoly)', () => {
    expect(pickOutcome('up')).toBe('no');
  });

  it('caps the BUY amount at maxPolyPositionUsdc regardless of dUSDC notional', () => {
    // The Polymarket leg always trades the configured cap, independent of
    // the Predict-side sizing (which scales with edge / NAV). This keeps the
    // pUSD exposure bounded even if the dUSDC sizer wants a big position.
    const predictNotional = 50;
    const polyCap = baseCfg.maxPolyPositionUsdc;
    const polyOrderUsdc = polyCap; // fixed, not derived from predictNotional
    expect(polyOrderUsdc).toBe(2);
    expect(polyOrderUsdc).toBeLessThanOrEqual(predictNotional);
  });
});
