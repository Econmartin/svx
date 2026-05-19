/**
 * Tests for the vol-arb strategy module — pure-math + decision logic.
 *
 * Coverage:
 *   - appendMid: buffer truncation + idempotent insert
 *   - computeRealizedVol: known vol from constructed return series
 *   - computePredictAtmIv: picks shortest-expiry oracle, computes ATM IV
 *   - computePredictUpAtSpot: bias detection
 *   - decide: open/close/hold transitions across the threshold matrix
 *   - RiskGate.checkVolArb: cap + daily-loss enforcement
 */

import { describe, it, expect } from 'vitest';
import {
  appendMid,
  btcSizeForUsdNotional,
  computePredictAtmIv,
  computePredictUpAtSpot,
  computeRealizedVol,
  decide,
  freshVolArbState,
  recordDecision,
  type VolArbState,
} from '../src/strategy/vol-arb.js';
import { RiskGate } from '../src/exec/risk.js';
import type { SvxConfig } from '../src/config.js';
import type { LedgerStore } from '../src/ledger/store.js';
import type { OracleSnapshot } from 'svx-shared/types';

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
  expiryToleranceSec: 14 * 24 * 3600,
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
  dailyPolyLossLimitUsdc: 10,
  polyFillTimeoutMs: 30_000,
  polySignatureType: 'EOA',
  polyFunderAddress: '',
  hlExecutionEnabled: false,
  hlNetwork: 'mainnet',
  hlHedgeAsset: 'BTC',
  maxHlPerTradeUsdc: 2,
  maxHlOpenUsdc: 10,
  dailyHlLossLimitUsdc: 5,
  hlRequiredForPoly: false,
  volArbEnabled: true,
  volArbIvSpreadOpenThreshold: 0.05,
  volArbIvSpreadCloseThreshold: 0.02,
  volArbDirectionBiasThreshold: 0.03,
  volArbBiasBypassSpread: 0.15,
  maxVolArbPerTradeUsdc: 2,
  maxVolArbOpenUsdc: 10,
  dailyVolArbLossLimitUsdc: 5,
  volArbTimeStopMinutes: 60,
  volArbMinSamples: 30,
  dataDir: '/tmp/svx-test',
  apiHost: '127.0.0.1',
  apiPort: 4321,
  loopIntervalMs: 15_000,
  instanceLabel: '',
};

describe('appendMid', () => {
  it('appends new samples and trims to lookback window', () => {
    const state = freshVolArbState();
    const start = 1_700_000_000_000;
    for (let i = 0; i < 250; i++) {
      appendMid(state, { ts: start + i * 15_000, price: 80_000 + i }, 3600_000);
    }
    // 250 × 15s = 3750s = 62.5 min. Last 60min worth should remain.
    expect(state.midHistory.length).toBeLessThanOrEqual(241); // 1h / 15s = 240, +1 boundary
    expect(state.midHistory[state.midHistory.length - 1]!.price).toBe(80_000 + 249);
  });

  it('is idempotent for duplicate timestamps', () => {
    const state = freshVolArbState();
    appendMid(state, { ts: 1_700_000_000_000, price: 80_000 });
    appendMid(state, { ts: 1_700_000_000_000, price: 80_001 });
    expect(state.midHistory.length).toBe(1);
  });
});

describe('computeRealizedVol', () => {
  it('returns NaN for fewer than 2 samples', () => {
    expect(Number.isNaN(computeRealizedVol([]))).toBe(true);
    expect(Number.isNaN(computeRealizedVol([{ ts: 1, price: 80_000 }]))).toBe(true);
  });

  it('returns ~0 for a flat price series', () => {
    const history = Array.from({ length: 100 }, (_, i) => ({
      ts: 1_700_000_000_000 + i * 15_000,
      price: 80_000,
    }));
    const rv = computeRealizedVol(history);
    expect(rv).toBeCloseTo(0, 6);
  });

  it('produces annualized vol that scales with return amplitude', () => {
    // Smaller jumps → smaller annualized vol; larger jumps → larger vol.
    const small = Array.from({ length: 200 }, (_, i) => ({
      ts: 1_700_000_000_000 + i * 15_000,
      price: 80_000 + (i % 2 === 0 ? 1 : -1) * 5,
    }));
    const large = Array.from({ length: 200 }, (_, i) => ({
      ts: 1_700_000_000_000 + i * 15_000,
      price: 80_000 + (i % 2 === 0 ? 1 : -1) * 50,
    }));
    const rvSmall = computeRealizedVol(small);
    const rvLarge = computeRealizedVol(large);
    expect(rvSmall).toBeGreaterThan(0);
    expect(rvLarge).toBeGreaterThan(rvSmall * 5);
  });
});

describe('computePredictAtmIv', () => {
  it('returns null when no usable oracle', () => {
    expect(computePredictAtmIv([], Date.now())).toBeNull();
  });

  it('picks the shortest-expiry oracle', () => {
    const now = 1_700_000_000_000;
    const o1: OracleSnapshot = mkOracle('a', now + 600_000, 80_000, 0.6);
    const o2: OracleSnapshot = mkOracle('b', now + 3600_000, 80_000, 0.6);
    const r = computePredictAtmIv([o1, o2], now);
    expect(r?.oracle.oracleId).toBe('a');
  });

  it('recovers ~target IV when SVI is flat-vol', () => {
    const now = 1_700_000_000_000;
    const o = mkOracle('a', now + 900_000, 80_000, 0.6);
    const r = computePredictAtmIv([o], now);
    expect(r?.iv).toBeGreaterThan(0.55);
    expect(r?.iv).toBeLessThan(0.65);
  });
});

describe('computePredictUpAtSpot', () => {
  it('returns ~0.5 for flat smile at-the-money', () => {
    const now = 1_700_000_000_000;
    const o = mkOracle('a', now + 900_000, 80_000, 0.6);
    const p = computePredictUpAtSpot(o, now);
    expect(p).toBeGreaterThan(0.45);
    expect(p).toBeLessThan(0.55);
  });

  it('returns 0.5 when oracle has expired', () => {
    const now = 1_700_000_000_000;
    const o = mkOracle('a', now - 1, 80_000, 0.6);
    expect(computePredictUpAtSpot(o, now)).toBe(0.5);
  });
});

describe('decide', () => {
  const cfg = {
    volArbIvSpreadOpenThreshold: 0.05,
    volArbIvSpreadCloseThreshold: 0.02,
    volArbDirectionBiasThreshold: 0.03,
    volArbBiasBypassSpread: 0.15,
    volArbTimeStopMinutes: 60,
  };
  const now = 1_700_000_000_000;

  it('holds when spread is below open threshold', () => {
    const d = decide({
      predictIv: 0.6,
      realizedVol: 0.58,
      predictUpAtSpot: 0.6,
      hasOpenPosition: false,
      cfg,
      nowMs: now,
    });
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/spread_below_open_thresh/);
  });

  it('holds when bias is too neutral despite vol divergence (modest spread)', () => {
    const d = decide({
      predictIv: 0.7,
      realizedVol: 0.6,
      predictUpAtSpot: 0.5, // neutral
      hasOpenPosition: false,
      cfg,
      nowMs: now,
    });
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/neutral_surface_bias/);
  });

  it('bypasses the bias gate when IV-RV spread exceeds the bypass threshold (regression case)', () => {
    // Production scenario 2026-05-17: IV 34.2% vs RV 11.5%, P(↑) 49.46%.
    // Spread = 22.7%, way above the 15% bypass default. Should fire short
    // (since p_up < 0.5) despite p_up being inside the bias band.
    const d = decide({
      predictIv: 0.342,
      realizedVol: 0.115,
      predictUpAtSpot: 0.4946, // neutral — would normally block
      hasOpenPosition: false,
      cfg,
      nowMs: now,
    });
    expect(d.action).toBe('open_short');
    expect(d.reason).toMatch(/bias_bypassed/);
  });

  it('still holds when bypass is disabled even with extreme spread', () => {
    const d = decide({
      predictIv: 0.342,
      realizedVol: 0.115,
      predictUpAtSpot: 0.4946,
      hasOpenPosition: false,
      cfg: { ...cfg, volArbBiasBypassSpread: 1.0 }, // effectively disabled
      nowMs: now,
    });
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/neutral_surface_bias/);
  });

  it('picks direction from p_up tilt even when bypass is active (p_up > 0.5 → long)', () => {
    const d = decide({
      predictIv: 0.4,
      realizedVol: 0.15,
      predictUpAtSpot: 0.501, // microscopically positive tilt
      hasOpenPosition: false,
      cfg,
      nowMs: now,
    });
    expect(d.action).toBe('open_long');
    expect(d.reason).toMatch(/bias_bypassed/);
  });

  it('opens long when vol diverges and surface bias is up', () => {
    const d = decide({
      predictIv: 0.7,
      realizedVol: 0.6,
      predictUpAtSpot: 0.6,
      hasOpenPosition: false,
      cfg,
      nowMs: now,
    });
    expect(d.action).toBe('open_long');
  });

  it('opens short when surface bias is down', () => {
    const d = decide({
      predictIv: 0.7,
      realizedVol: 0.6,
      predictUpAtSpot: 0.4,
      hasOpenPosition: false,
      cfg,
      nowMs: now,
    });
    expect(d.action).toBe('open_short');
  });

  it('closes open position when spread weakens below close threshold', () => {
    const d = decide({
      predictIv: 0.601,
      realizedVol: 0.6,
      predictUpAtSpot: 0.55,
      hasOpenPosition: true,
      openPositionAgeMs: 60_000,
      cfg,
      nowMs: now,
    });
    expect(d.action).toBe('close');
    expect(d.reason).toMatch(/spread_below_close_thresh/);
  });

  it('closes on time-stop even if signal still valid', () => {
    const d = decide({
      predictIv: 0.7,
      realizedVol: 0.6,
      predictUpAtSpot: 0.6,
      hasOpenPosition: true,
      openPositionAgeMs: 61 * 60 * 1000,
      cfg,
      nowMs: now,
    });
    expect(d.action).toBe('close');
    expect(d.reason).toMatch(/time_stop/);
  });

  it('holds open position when signal still valid + within time-stop', () => {
    const d = decide({
      predictIv: 0.7,
      realizedVol: 0.6,
      predictUpAtSpot: 0.6,
      hasOpenPosition: true,
      openPositionAgeMs: 30 * 60 * 1000,
      cfg,
      nowMs: now,
    });
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/position_open/);
  });

  it('holds when IV or RV is NaN (warm-up)', () => {
    expect(
      decide({
        predictIv: NaN,
        realizedVol: 0.6,
        predictUpAtSpot: 0.6,
        hasOpenPosition: false,
        cfg,
        nowMs: now,
      }).action,
    ).toBe('hold');
  });
});

describe('RiskGate.checkVolArb', () => {
  function makeRisk(opts: { volArbPnl24h?: number; paused?: boolean } = {}) {
    const fake = {
      getPause: () => ({ paused: !!opts.paused, reason: 'test pause' }),
      setPause: () => {},
      consecutiveLosses: () => 0,
      realizedPolyPnlSince: () => 0,
      realizedHlPnlSince: () => 0,
      realizedVolArbPnlSince: () => opts.volArbPnl24h ?? 0,
    } as unknown as LedgerStore;
    return new RiskGate(fake, baseCfg, `/tmp/svx-paused-test-${Math.random()}`);
  }

  it('passes when under all caps', () => {
    const d = makeRisk().checkVolArb({ notionalUsdc: 1, openVolArbExposureUsdc: 0 });
    expect(d.ok).toBe(true);
  });

  it('blocks when notional exceeds per-trade cap', () => {
    const d = makeRisk().checkVolArb({ notionalUsdc: 5, openVolArbExposureUsdc: 0 });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/per-trade cap/);
  });

  it('blocks when total exposure would exceed cap', () => {
    const d = makeRisk().checkVolArb({ notionalUsdc: 2, openVolArbExposureUsdc: 9.5 });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/total exposure/);
  });

  it('blocks + pauses when 24h vol-arb PnL hits the daily loss limit', () => {
    const r = makeRisk({ volArbPnl24h: -5 });
    const d = r.checkVolArb({ notionalUsdc: 1, openVolArbExposureUsdc: 0 });
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/24h vol-arb loss/);
  });
});

describe('recordDecision', () => {
  it('caches the last decision and ring-buffers recent decisions', () => {
    const state = freshVolArbState();
    for (let i = 0; i < 105; i++) {
      recordDecision(
        state,
        {
          action: 'hold',
          reason: 'test',
          predictIv: 0.6,
          realizedVol: 0.55,
          ivSpread: 0.05,
          predictUpAtSpot: 0.5,
          ts: 1_700_000_000_000 + i,
        },
        false,
      );
    }
    expect(state.recentDecisions.length).toBe(100);
    expect(state.lastDecision?.ts).toBe(1_700_000_000_000 + 104);
  });
});

describe('btcSizeForUsdNotional', () => {
  it('returns the right BTC size for a USD notional', () => {
    expect(btcSizeForUsdNotional(2000, 80_000)).toBeCloseTo(0.025, 6);
  });

  it('returns 0 when price is zero (safety)', () => {
    expect(btcSizeForUsdNotional(100, 0)).toBe(0);
  });
});

function mkOracle(id: string, expiryMs: number, spot: number, ivAnnual: number): OracleSnapshot {
  const now = 1_700_000_000_000;
  const tYears = Math.max(1e-9, (expiryMs - now) / (365.25 * 24 * 3600 * 1000));
  const w = ivAnnual * ivAnnual * tYears;
  return {
    oracleId: id,
    underlyingAsset: 'BTC',
    expiryMs,
    spot,
    forward: spot,
    svi: { a: w, b: 0, rho: 0, m: 0, sigma: 0.0001 },
    timestampMs: now,
    isSettled: false,
  };
}
