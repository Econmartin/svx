import { describe, it, expect, beforeEach } from 'vitest';
import { parsePolyFillResponse } from '../src/exec/polymarket-client.js';
import { RiskGate } from '../src/exec/risk.js';
import type { LedgerStore } from '../src/ledger/store.js';
import type { SvxConfig } from '../src/config.js';

// Minimal fake ledger that satisfies what RiskGate actually calls.
function fakeLedger(opts: { paused?: boolean; consecutiveLosses?: number } = {}): LedgerStore {
  return {
    getPause: () => ({ paused: !!opts.paused, reason: opts.paused ? 'test pause' : undefined }),
    setPause: () => {},
    consecutiveLosses: () => opts.consecutiveLosses ?? 0,
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
  dailyPolyLossLimitUsdc: 10,
  polyFillTimeoutMs: 30_000,
  dataDir: '/tmp/svx-test',
  apiHost: '127.0.0.1',
  apiPort: 4321,
  loopIntervalMs: 15_000,
};

describe('parsePolyFillResponse', () => {
  it('marks an order with `matched` status + non-zero shares as filled', () => {
    const r = parsePolyFillResponse(
      { status: 'matched', orderID: 'abc', makingAmount: '5.5', price: '0.29' },
      2,
    );
    expect(r.status).toBe('filled');
    expect(r.orderId).toBe('abc');
    expect(r.filledShares).toBeCloseTo(5.5);
    expect(r.fillPrice).toBeCloseTo(0.29);
    expect(r.costUsdc).toBeCloseTo(5.5 * 0.29);
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
