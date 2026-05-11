/**
 * Tests for the cross-expiry repricing added to signal/spread.ts.
 *
 * The math: Predict gives w(k) at the oracle's native expiry T_oracle.
 * We extract σ = √(w / T_oracle), then reprice the binary at the Polymarket
 * expiry T_poly: w_poly = σ² · T_poly, predictUp = N(d2).
 *
 * Sanity properties:
 *   - When T_poly == T_oracle, predictUp matches the legacy formula.
 *   - Repricing a longer expiry preserves the ATM probability (≈ 50%) but
 *     scales away-from-money probabilities toward 50% (vol-time grows).
 *   - The reprice keeps `predictIv` invariant across expiries (flat-vol).
 */

import { describe, it, expect } from 'vitest';
import { computeSpread } from '../src/signal/spread.js';
import type { OracleSnapshot, PolymarketSnapshot } from 'svx-shared/types';

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

const now = 1_700_000_000_000;
const spot = 80_000;

function makeOracle(expiryMs: number, ivAnnual: number): OracleSnapshot {
  const tYears = (expiryMs - now) / MS_PER_YEAR;
  const w = ivAnnual * ivAnnual * tYears;
  // SVI: a = w, b=0 → flat smile (w(k) = a). Easiest for hand-checking.
  return {
    oracleId: '0xa',
    underlyingAsset: 'BTC',
    expiryMs,
    spot,
    forward: spot,
    svi: { a: w, b: 0, rho: 0, m: 0, sigma: 0.0001 },
    timestampMs: now,
    isSettled: false,
  };
}

function makePoly(strike: number, expiryMs: number, yesAsk: number): PolymarketSnapshot {
  return {
    conditionId: 'c1',
    strike,
    expiryMs,
    yesBid: yesAsk - 0.02,
    yesAsk,
    yesBidSize: 1000,
    yesAskSize: 1000,
    noBid: 1 - yesAsk - 0.02,
    noAsk: 1 - yesAsk + 0.02,
    volume24hUsd: 100_000,
    fetchedAtMs: now,
  };
}

describe('computeSpread cross-expiry repricing', () => {
  it('matches legacy formula when T_poly == T_oracle', () => {
    const expiry = now + 15 * 60 * 1000; // 15 min out
    const o = makeOracle(expiry, 0.6);
    const p = makePoly(80_000, expiry, 0.5);
    const r = computeSpread({ oracleSnapshot: o, polymarketSnapshot: p, threshold: 0.03, nowMs: now });
    // At-the-money on a flat smile → predictUp ≈ 0.5 (small d2 from w/2 term).
    expect(r.predictUp).toBeGreaterThan(0.49);
    expect(r.predictUp).toBeLessThan(0.51);
  });

  it('preserves ATM probability (~50%) at a longer Polymarket expiry', () => {
    const oExpiry = now + 15 * 60 * 1000; // Predict 15-min
    const pExpiry = now + 8 * 3600 * 1000; // Polymarket 8h
    const o = makeOracle(oExpiry, 0.6);
    const p = makePoly(80_000, pExpiry, 0.5);
    const r = computeSpread({ oracleSnapshot: o, polymarketSnapshot: p, threshold: 0.03, nowMs: now });
    // Repricing at 8h vs 15m: more vol-time → d2 farther from 0 but only via
    // the w/2 drift term. For ATM and σ=0.6 the difference is small.
    expect(r.predictUp).toBeGreaterThan(0.40);
    expect(r.predictUp).toBeLessThan(0.50);
  });

  it('pulls deep-OTM probabilities toward 50% as Polymarket expiry grows', () => {
    // OTM strike 100k vs spot 80k. At short expiry, predictUp ≪ 0.5. At long
    // expiry (more vol-time), predictUp climbs back toward 0.5.
    const oExpiry = now + 15 * 60 * 1000;
    const shortPolyExp = now + 30 * 60 * 1000;
    const longPolyExp = now + 30 * 24 * 3600 * 1000; // 30 days
    const o = makeOracle(oExpiry, 0.8);
    const pShort = makePoly(100_000, shortPolyExp, 0.05);
    const pLong = makePoly(100_000, longPolyExp, 0.30);
    const rShort = computeSpread({ oracleSnapshot: o, polymarketSnapshot: pShort, threshold: 0.03, nowMs: now });
    const rLong = computeSpread({ oracleSnapshot: o, polymarketSnapshot: pLong, threshold: 0.03, nowMs: now });
    expect(rShort.predictUp).toBeLessThan(0.10);
    expect(rLong.predictUp).toBeGreaterThan(rShort.predictUp);
    expect(rLong.predictUp).toBeLessThan(0.50);
  });

  it('keeps predictIv invariant across Polymarket expiry choices', () => {
    // Flat-vol assumption: σ is a property of the surface at strike K, not
    // of the expiry we choose to price at. Two computeSpread calls at the
    // same strike with different Poly expiries should yield the same IV.
    const oExpiry = now + 15 * 60 * 1000;
    const o = makeOracle(oExpiry, 0.65);
    const p1 = makePoly(80_000, now + 1 * 3600 * 1000, 0.5);
    const p2 = makePoly(80_000, now + 24 * 3600 * 1000, 0.5);
    const r1 = computeSpread({ oracleSnapshot: o, polymarketSnapshot: p1, threshold: 0.03, nowMs: now });
    const r2 = computeSpread({ oracleSnapshot: o, polymarketSnapshot: p2, threshold: 0.03, nowMs: now });
    expect(r1.predictIv).toBeCloseTo(r2.predictIv, 6);
  });

  it('falls back to oracle expiry when Polymarket expiry has already passed', () => {
    const oExpiry = now + 15 * 60 * 1000;
    const expiredPoly = now - 1; // already settled on Poly's clock
    const o = makeOracle(oExpiry, 0.5);
    const p = makePoly(80_000, expiredPoly, 0.5);
    const r = computeSpread({ oracleSnapshot: o, polymarketSnapshot: p, threshold: 0.03, nowMs: now });
    // Doesn't crash; predictUp finite + in (0, 1).
    expect(Number.isFinite(r.predictUp)).toBe(true);
    expect(r.predictUp).toBeGreaterThan(0);
    expect(r.predictUp).toBeLessThan(1);
  });
});
