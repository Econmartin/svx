/**
 * Margin-Lever (paper) strategy tests.
 *
 * Covers:
 *   - decide() open / close / hold / time-stop / daily-loss-limit branches
 *   - applyDecision() position lifecycle (open → close PnL bookkeeping)
 *   - PTB intent construction (snapshot of intent shape for both clients)
 */
import { describe, expect, it } from 'vitest';
import type { OracleSnapshot, SVIParams } from 'svx-shared/types';
import {
  applyDecision,
  decide,
  freshMarginLeverState,
  predictUpAtSpot,
  realizedPnlSince,
} from '../src/strategy/margin-lever.js';
import {
  buildIronBankSupplyIntent,
  buildIronBankWithdrawIntent,
} from '../src/exec/iron-bank-client.js';
import {
  buildOpenLeveragedSpotIntent,
  buildCloseAndRepayIntent,
} from '../src/exec/deepbook-margin-client.js';

const NOW = 1_750_000_000_000;
const MIN = 60 * 1000;

function makeOracle(over: Partial<OracleSnapshot> = {}): OracleSnapshot {
  // Symmetric clean SVI surface, spot = forward → P(↑) ≈ 50%.
  const svi: SVIParams = { a: 0.04, b: 0.4, rho: 0, m: 0, sigma: 0.1 };
  return {
    oracleId: '0xoracle',
    underlyingAsset: 'BTC',
    expiryMs: NOW + 30 * MIN,
    spot: 100_000,
    forward: 100_000,
    svi,
    timestampMs: NOW,
    isSettled: false,
    ...over,
  };
}

const THRESHOLDS = { openBias: 0.10, closeBias: 0.04, maxHoldMs: 45 * MIN };
const CAPS = {
  perTradeNotionalUsdc: 500,
  maxBorrowNotionalUsdc: 1500,
  dailyLossLimitUsdc: 100,
};

describe('predictUpAtSpot', () => {
  it('lands just under 0.5 for a symmetric surface at-the-forward (variance drag in d2)', () => {
    // d2 = -(k + w/2)/sqrt(w); at k=0 that's -sqrt(w)/2 ⇒ N(d2) ≈ 0.44 for w≈0.08.
    const p = predictUpAtSpot(makeOracle(), NOW);
    expect(p).toBeGreaterThan(0.40);
    expect(p).toBeLessThan(0.50);
  });

  it('returns > 0.5 when forward > spot (market expects spot to rise)', () => {
    // Forward = E[S_T]; forward > spot ⇒ expected drift up ⇒ P(S_T > spot_now) > 0.5.
    const p = predictUpAtSpot(makeOracle({ forward: 110_000 }), NOW);
    expect(p).toBeGreaterThan(0.50);
  });

  it('returns < 0.5 when forward < spot (market expects spot to drop)', () => {
    const p = predictUpAtSpot(makeOracle({ forward: 90_000 }), NOW);
    expect(p).toBeLessThan(0.50);
  });
});

describe('decide — open branch', () => {
  it('holds when bias is below open threshold', () => {
    const d = decide({
      oracle: makeOracle(),
      spot: 100_000,
      nowMs: NOW,
      thresholds: THRESHOLDS,
      caps: CAPS,
      state: freshMarginLeverState(),
      pnl24hUsdc: 0,
    });
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/bias .* < open/);
  });

  it('opens long when P(↑) > 0.6 (synthetic skew via forward >> spot)', () => {
    // Forward >> spot ⇒ expected drift up ⇒ P(↑) > 0.5. Crank big enough
    // to clear the 0.10 open threshold against the variance drag.
    const oracle = makeOracle({ forward: 200_000 });
    const d = decide({
      oracle,
      spot: 100_000,
      nowMs: NOW,
      thresholds: THRESHOLDS,
      caps: CAPS,
      state: freshMarginLeverState(),
      pnl24hUsdc: 0,
    });
    expect(d.action).toBe('open_long');
    expect(d.predictUpAtSpot).toBeGreaterThan(0.5 + THRESHOLDS.openBias);
  });

  it('opens short when P(↑) < 0.4', () => {
    const oracle = makeOracle({ forward: 50_000 });
    const d = decide({
      oracle,
      spot: 100_000,
      nowMs: NOW,
      thresholds: THRESHOLDS,
      caps: CAPS,
      state: freshMarginLeverState(),
      pnl24hUsdc: 0,
    });
    expect(d.action).toBe('open_short');
  });

  it('holds (no open) when daily-loss limit is breached', () => {
    const oracle = makeOracle({ forward: 200_000 }); // would normally open long
    const d = decide({
      oracle,
      spot: 100_000,
      nowMs: NOW,
      thresholds: THRESHOLDS,
      caps: CAPS,
      state: freshMarginLeverState(),
      pnl24hUsdc: -150, // worse than -100
    });
    expect(d.action).toBe('hold');
    expect(d.reason).toMatch(/daily loss/);
  });
});

describe('decide — close branch', () => {
  it('closes when bias decays below close threshold', () => {
    const state = freshMarginLeverState();
    applyDecision(
      state,
      {
        ts: NOW - 5 * MIN,
        action: 'open_long',
        reason: 'test',
        predictUpAtSpot: 0.7,
        biasMagnitude: 0.2,
        spot: 100_000,
      },
      CAPS,
      'oracleA',
    );
    // Tiny surface (a, b small) so variance drag in d2 is negligible and
    // P_up sits within 0.04 of 0.5 → bias < closeBias triggers close.
    const flat: SVIParams = { a: 1e-6, b: 1e-4, rho: 0, m: 0, sigma: 1e-4 };
    const d = decide({
      oracle: makeOracle({ svi: flat }),
      spot: 100_500,
      nowMs: NOW,
      thresholds: THRESHOLDS,
      caps: CAPS,
      state,
      pnl24hUsdc: 0,
    });
    expect(d.action).toBe('close');
    expect(d.reason).toMatch(/decayed/);
  });

  it('closes when time-stop fires even if bias still high', () => {
    const state = freshMarginLeverState();
    applyDecision(
      state,
      {
        ts: NOW - 50 * MIN,
        action: 'open_long',
        reason: 'test',
        predictUpAtSpot: 0.7,
        biasMagnitude: 0.2,
        spot: 100_000,
      },
      CAPS,
      'oracleA',
    );
    // Heavy skew (forward >> spot) so bias stays well above close threshold.
    const d = decide({
      oracle: makeOracle({ forward: 200_000 }),
      spot: 100_000,
      nowMs: NOW,
      thresholds: THRESHOLDS,
      caps: CAPS,
      state,
      pnl24hUsdc: 0,
    });
    expect(d.action).toBe('close');
    expect(d.reason).toMatch(/time-stop/);
  });
});

describe('applyDecision — lifecycle', () => {
  it('opens then closes and books signed PnL on close', () => {
    const state = freshMarginLeverState();
    applyDecision(
      state,
      {
        ts: NOW,
        action: 'open_long',
        reason: 'open',
        predictUpAtSpot: 0.7,
        biasMagnitude: 0.2,
        spot: 100_000,
      },
      CAPS,
      'oracleA',
    );
    expect(state.open).not.toBeNull();
    expect(state.open!.side).toBe('long');
    expect(state.open!.notionalUsdc).toBe(CAPS.perTradeNotionalUsdc);

    applyDecision(
      state,
      {
        ts: NOW + 10 * MIN,
        action: 'close',
        reason: 'decay',
        predictUpAtSpot: 0.51,
        biasMagnitude: 0.01,
        spot: 101_000, // +1% move on a long ⇒ +1% of 500 = +5 USDC
      },
      CAPS,
      'oracleA',
    );
    expect(state.open).toBeNull();
    expect(state.closed.length).toBe(1);
    expect(state.closed[0]!.pnlUsdc).toBeCloseTo(5, 6);
    expect(realizedPnlSince(state, NOW)).toBeCloseTo(5, 6);
  });

  it('shorts make money on price down moves', () => {
    const state = freshMarginLeverState();
    applyDecision(
      state,
      {
        ts: NOW,
        action: 'open_short',
        reason: 'open',
        predictUpAtSpot: 0.3,
        biasMagnitude: 0.2,
        spot: 100_000,
      },
      CAPS,
      'oracleA',
    );
    applyDecision(
      state,
      {
        ts: NOW + 5 * MIN,
        action: 'close',
        reason: 'decay',
        predictUpAtSpot: 0.5,
        biasMagnitude: 0,
        spot: 98_000, // -2% on a short ⇒ +2% of 500 = +10
      },
      CAPS,
      'oracleA',
    );
    expect(state.closed[0]!.pnlUsdc).toBeCloseTo(10, 6);
  });

  it('refuses to double-open', () => {
    const state = freshMarginLeverState();
    applyDecision(
      state,
      {
        ts: NOW,
        action: 'open_long',
        reason: 'a',
        predictUpAtSpot: 0.7,
        biasMagnitude: 0.2,
        spot: 100_000,
      },
      CAPS,
      'oA',
    );
    const acted = applyDecision(
      state,
      {
        ts: NOW + MIN,
        action: 'open_short',
        reason: 'b',
        predictUpAtSpot: 0.3,
        biasMagnitude: 0.2,
        spot: 99_000,
      },
      CAPS,
      'oA',
    );
    expect(acted).toBe(false);
    expect(state.open!.side).toBe('long'); // unchanged
  });
});

describe('PTB intent construction', () => {
  it('iron_bank::supply builds with positive amount', () => {
    const intent = buildIronBankSupplyIntent(1_000_000n, '0xop');
    expect(intent.kind).toBe('iron_bank::supply');
    expect(intent.amountRaw).toBe(1_000_000n);
    expect(intent.operator).toBe('0xop');
  });

  it('iron_bank::supply rejects zero amount', () => {
    expect(() => buildIronBankSupplyIntent(0n, '0xop')).toThrow();
  });

  it('iron_bank::withdraw needs operator', () => {
    expect(() => buildIronBankWithdrawIntent(1n, '')).toThrow();
  });

  it('open-leveraged-spot composes the four expected sub-intents in order', () => {
    const intents = buildOpenLeveragedSpotIntent({
      operator: '0xop',
      collateralTypeTag: '0x1::iron::Share',
      collateralAmountRaw: 1_000_000n,
      borrowCoinTypeTag: '0x2::dusdc::DUSDC',
      borrowAmountRaw: 500_000n,
      poolId: '0xpool',
      side: 'buy',
      baseAmountRaw: 50_000n,
      pricePaperHint: 100_000,
    });
    expect(intents.map((i) => i.kind)).toEqual([
      'deepbook_margin::open_account',
      'deepbook_margin::deposit_collateral',
      'deepbook_margin::borrow',
      'deepbook_margin::spot_trade',
    ]);
  });

  it('close-and-repay rejects zero base amount', () => {
    expect(() =>
      buildCloseAndRepayIntent({
        operator: '0xop',
        poolId: '0xpool',
        side: 'sell',
        baseAmountRaw: 0n,
        borrowCoinTypeTag: '0x2::dusdc::DUSDC',
        repayAmountRaw: 500_000n,
      }),
    ).toThrow();
  });
});
