/**
 * Regression tests for the 2026-07 pre-relaunch audit fixes. Each describe
 * block maps to one audited failure mode — see docs/risk-controls.md §audit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerStore } from '../src/ledger/store.js';
import { parseStrikeFromQuestion, parseMarketResolution } from '../src/pricing/polymarket.js';
import { applyFilters } from '../src/signal/filter.js';
import { reconcileExternallyRedeemedPositions } from '../src/index.js';
import type { SvxConfig } from '../src/config.js';
import type { OracleSnapshot, PolymarketSnapshot } from 'svx-shared/types';

let tmp: string;
let ledger: LedgerStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-audit-'));
  ledger = new LedgerStore(path.join(tmp, 'svx.sqlite'));
});
afterEach(() => {
  ledger.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function insertPolyTrade(opts: {
  tsMs?: number;
  outcome?: 'yes' | 'no';
  shares?: number;
  costUsdc?: number;
  conditionId?: string;
  tokenId?: string;
  polyStatus?: 'submitted' | 'filled' | 'failed' | 'partial';
  strategy?: 'poly_arb' | 'vol_arb' | 'convergence';
  settled?: boolean;
}): string {
  return ledger.insertTrade({
    signalId: 's',
    timestampMs: opts.tsMs ?? 1_700_000_000_000,
    mode: 'paper',
    oracleId: 'oracle-x',
    underlyingAsset: 'BTC',
    expiryMs: (opts.tsMs ?? 1_700_000_000_000) + 900_000,
    strike: 80_000,
    direction: 'up',
    quantityDusdc: 0,
    costPrice: 0.5,
    costUsdc: 0,
    settled: opts.settled ?? false,
    strategy: opts.strategy ?? 'poly_arb',
    polyNetwork: 'polygon',
    polyTokenId: opts.tokenId ?? 'tok-1',
    polyConditionId: opts.conditionId ?? '0xabc',
    polySide: 'buy',
    polyOutcome: opts.outcome ?? 'yes',
    polyOrderId: 'ord',
    polyFilledShares: opts.shares ?? 10,
    polyFillPrice: (opts.costUsdc ?? 2) / (opts.shares ?? 10),
    polyCostUsdc: opts.costUsdc ?? 2,
    polyStatus: opts.polyStatus ?? 'filled',
  });
}

describe('daily poly loss limit keys on SETTLEMENT time (not open time)', () => {
  it('counts a loss settled now on a trade opened 3 days ago', () => {
    const threeDaysAgo = Date.now() - 3 * 24 * 3600_000;
    const id = insertPolyTrade({ tsMs: threeDaysAgo, costUsdc: 4 });
    ledger.markPolySettled(id, 'no', 0, -4, Date.now());
    const pnl24h = ledger.realizedPolyPnlSince(Date.now() - 24 * 3600_000);
    expect(pnl24h).toBe(-4);
  });

  it('counts a 14-day abandonment toward the window it lands in', () => {
    const fifteenDaysAgo = Date.now() - 15 * 24 * 3600_000;
    insertPolyTrade({ tsMs: fifteenDaysAgo, costUsdc: 4 });
    const changed = ledger.abandonStalePolyTrades(14 * 24 * 3600_000, Date.now());
    expect(changed).toBe(1);
    const pnl24h = ledger.realizedPolyPnlSince(Date.now() - 24 * 3600_000);
    expect(pnl24h).toBe(-4);
  });

  it('does NOT count a loss settled outside the window', () => {
    const id = insertPolyTrade({ tsMs: Date.now() - 3 * 24 * 3600_000, costUsdc: 4 });
    ledger.markPolySettled(id, 'no', 0, -4, Date.now() - 2 * 24 * 3600_000);
    expect(ledger.realizedPolyPnlSince(Date.now() - 24 * 3600_000)).toBe(0);
  });
});

describe('circuit breaker survives NULL-pnl rows and counts real poly PnL', () => {
  it('a convergence row with NULL pnl does not truncate the streak', () => {
    // Three settled poly losses, then a convergence row that is settled=1 on
    // the Predict side but has no realized PnL anywhere yet.
    for (let i = 0; i < 3; i++) {
      const id = insertPolyTrade({ tsMs: 1_700_000_000_000 + i, costUsdc: 2, tokenId: `t${i}` });
      ledger.markPolySettled(id, 'no', 0, -2, 1_700_000_100_000 + i);
    }
    insertPolyTrade({
      tsMs: 1_700_000_200_000,
      strategy: 'convergence',
      settled: true,
      tokenId: 'conv-token',
    });
    expect(ledger.consecutiveLosses()).toBe(3);
  });

  it('counts poly (real-money) losses, and a poly WIN breaks the streak', () => {
    const a = insertPolyTrade({ tsMs: 1_700_000_000_000, costUsdc: 2, tokenId: 'a' });
    ledger.markPolySettled(a, 'no', 0, -2, 1_700_000_100_000);
    const b = insertPolyTrade({ tsMs: 1_700_000_000_001, costUsdc: 2, tokenId: 'b' });
    ledger.markPolySettled(b, 'yes', 10, 8, 1_700_000_200_000);
    const c = insertPolyTrade({ tsMs: 1_700_000_000_002, costUsdc: 2, tokenId: 'c' });
    ledger.markPolySettled(c, 'no', 0, -2, 1_700_000_300_000);
    // Newest-first: loss(c) → win(b) breaks → streak = 1.
    expect(ledger.consecutiveLosses()).toBe(1);
  });
});

describe('invisible-position fix: submitted/partial rows are visible everywhere', () => {
  it('countOpenPolyPositions and unsettledPolyTrades include submitted rows', () => {
    insertPolyTrade({ polyStatus: 'submitted', tokenId: 'sub-1' });
    insertPolyTrade({ polyStatus: 'partial', tokenId: 'part-1' });
    insertPolyTrade({ polyStatus: 'filled', tokenId: 'fill-1' });
    insertPolyTrade({ polyStatus: 'failed', tokenId: 'fail-1' });
    expect(ledger.countOpenPolyPositions()).toBe(3);
    expect(ledger.unsettledPolyTrades().length).toBe(3);
  });

  it('abandonStalePolyTrades sweeps submitted rows too', () => {
    insertPolyTrade({
      polyStatus: 'submitted',
      tsMs: Date.now() - 15 * 24 * 3600_000,
    });
    expect(ledger.abandonStalePolyTrades(14 * 24 * 3600_000, Date.now())).toBe(1);
  });
});

describe('opposite-token guard', () => {
  it('flags the sibling token on the same conditionId', () => {
    insertPolyTrade({ conditionId: '0xcond', tokenId: 'yes-token' });
    expect(ledger.hasOpenPolyForOtherToken('0xcond', 'no-token')).toBe(true);
    expect(ledger.hasOpenPolyForOtherToken('0xcond', 'yes-token')).toBe(false);
    expect(ledger.hasOpenPolyForOtherToken('0xother', 'no-token')).toBe(false);
  });

  it('clears once the sibling settles', () => {
    const id = insertPolyTrade({ conditionId: '0xcond', tokenId: 'yes-token' });
    ledger.markPolySettled(id, 'yes', 10, 8, Date.now());
    expect(ledger.hasOpenPolyForOtherToken('0xcond', 'no-token')).toBe(false);
  });
});

describe('resetAbandonedPolyTrades is genuinely one-shot', () => {
  it('second call is a no-op even with fresh abandoned rows', () => {
    insertPolyTrade({ tsMs: Date.now() - 15 * 24 * 3600_000, tokenId: 'a' });
    ledger.abandonStalePolyTrades(14 * 24 * 3600_000, Date.now());
    expect(ledger.resetAbandonedPolyTrades()).toBe(1);
    // Re-abandon (the ongoing 14-day rule fires again) …
    ledger.abandonStalePolyTrades(14 * 24 * 3600_000, Date.now());
    // … but the boot heal must NOT resurrect it a second time.
    expect(ledger.resetAbandonedPolyTrades()).toBe(0);
  });
});

describe('redeem retry queue', () => {
  it('failed redeems re-enter the queue after the backoff gap, up to the cap', () => {
    const id = insertPolyTrade({});
    ledger.markPolySettled(id, 'yes', 10, 8, Date.now());
    ledger.markPolyRedeemed(id, null, 'failed');
    // Inside the gap: not retryable.
    expect(
      ledger.unredeemedWinningPolyTrades({ maxAttempts: 5, retryGapMs: 30 * 60_000 }).length,
    ).toBe(0);
    // Past the gap: retryable.
    expect(
      ledger.unredeemedWinningPolyTrades({
        maxAttempts: 5,
        retryGapMs: 30 * 60_000,
        nowMs: Date.now() + 31 * 60_000,
      }).length,
    ).toBe(1);
    // Attempt cap: after 5 failures it stays parked.
    for (let i = 0; i < 4; i++) ledger.markPolyRedeemed(id, null, 'failed');
    expect(
      ledger.unredeemedWinningPolyTrades({
        maxAttempts: 5,
        retryGapMs: 30 * 60_000,
        nowMs: Date.now() + 24 * 3600_000,
      }).length,
    ).toBe(0);
  });

  it("Safe-mode 'pending' rows are excluded from retry but count as unredeemed", () => {
    const id = insertPolyTrade({});
    ledger.markPolySettled(id, 'yes', 10, 8, Date.now());
    ledger.markPolyRedeemed(id, null, 'pending');
    expect(
      ledger.unredeemedWinningPolyTrades({
        maxAttempts: 5,
        retryGapMs: 0,
        nowMs: Date.now() + 1,
      }).length,
    ).toBe(0);
    expect(ledger.unredeemedPolyPayoutUsdc()).toBe(10);
  });
});

describe('reconciliation offset math', () => {
  it('offset = settled pnl − open cost − unredeemed payouts', () => {
    // Open position: $4 left the wallet.
    insertPolyTrade({ costUsdc: 4, tokenId: 'open-1' });
    // Settled loss: −$2 realized, nothing to redeem.
    const lost = insertPolyTrade({ costUsdc: 2, tokenId: 'lost-1', conditionId: '0xl' });
    ledger.markPolySettled(lost, 'no', 0, -2, Date.now());
    // Settled win, redeemed: +$8 realized, cash arrived.
    const won = insertPolyTrade({ costUsdc: 2, shares: 10, tokenId: 'won-1', conditionId: '0xw' });
    ledger.markPolySettled(won, 'yes', 10, 8, Date.now());
    ledger.markPolyRedeemed(won, '0xtx', 'success');
    // Settled win, NOT redeemed: +$8 booked, $10 not in the wallet yet.
    const stuck = insertPolyTrade({ costUsdc: 2, shares: 10, tokenId: 'stuck-1', conditionId: '0xs' });
    ledger.markPolySettled(stuck, 'yes', 10, 8, Date.now());
    ledger.markPolyRedeemed(stuck, null, 'failed');

    // (−2 + 8 + 8) − 4 − 10 = 0
    expect(ledger.polyLedgerOffsetUsdc()).toBe(0);
  });
});

describe('meta key-value store', () => {
  it('round-trips and deletes', () => {
    expect(ledger.getMeta('k')).toBeUndefined();
    ledger.setMeta('k', 'v1');
    expect(ledger.getMeta('k')).toBe('v1');
    ledger.setMeta('k', 'v2');
    expect(ledger.getMeta('k')).toBe('v2');
    ledger.deleteMeta('k');
    expect(ledger.getMeta('k')).toBeUndefined();
  });
});

describe('reentry-cooldown rebuild source', () => {
  it('returns the most recent entry time per token in the window', () => {
    const now = Date.now();
    insertPolyTrade({ tsMs: now - 10 * 60_000, tokenId: 'tok-a' });
    insertPolyTrade({ tsMs: now - 5 * 60_000, tokenId: 'tok-a', conditionId: '0xa2' });
    insertPolyTrade({ tsMs: now - 2 * 3600_000, tokenId: 'tok-old' });
    const rows = ledger.recentPolyEntryTimes(now - 30 * 60_000);
    expect(rows).toEqual([{ tokenId: 'tok-a', lastEntryMs: now - 5 * 60_000 }]);
  });
});

describe('market-universe filter (parseStrikeFromQuestion)', () => {
  it('accepts genuine BTC price binaries', () => {
    expect(parseStrikeFromQuestion('Will Bitcoin be above $105,000 on July 4?')).toBe(105_000);
    expect(parseStrikeFromQuestion('Bitcoin above $98k on July 4?')).toBe(98_000);
    expect(parseStrikeFromQuestion('Will the price of bitcoin be above $110,000 by 4pm ET?')).toBe(
      110_000,
    );
    expect(parseStrikeFromQuestion('BTC above 105k today?')).toBe(105_000);
  });

  it('rejects non-price and no-touch questions', () => {
    expect(parseStrikeFromQuestion('Bitcoin dominance above 60% in July?')).toBeNull();
    expect(
      parseStrikeFromQuestion("Will MicroStrategy's bitcoin holdings be above $500,000?"),
    ).toBeNull();
    expect(parseStrikeFromQuestion('Will Bitcoin stay above $100k through Friday?')).toBeNull();
    expect(parseStrikeFromQuestion('Will Bitcoin remain above $95k until August?')).toBeNull();
    expect(parseStrikeFromQuestion('Bitcoin ETF inflows above 500 million?')).toBeNull();
    // Bare number with no $ or k marker — could be anything; refuse.
    expect(parseStrikeFromQuestion('Bitcoin above 60 on the fear index?')).toBeNull();
  });
});

describe('negRisk tri-state', () => {
  const baseMarket = {
    conditionId: '0xc',
    question: 'Will Bitcoin be above $100,000?',
    outcomes: '["Yes","No"]',
    outcomePrices: '["1","0"]',
    closed: true,
  };

  it('absent flag is undefined (never guessed)', () => {
    expect(parseMarketResolution(baseMarket as never).negRisk).toBeUndefined();
  });
  it('explicit false is false', () => {
    expect(parseMarketResolution({ ...baseMarket, negRisk: false } as never).negRisk).toBe(false);
  });
  it('explicit true is true', () => {
    expect(parseMarketResolution({ ...baseMarket, negRisk: true } as never).negRisk).toBe(true);
  });
});

describe('expired-market gate in the signal filter', () => {
  const now = 1_700_000_000_000;
  const oracle = {
    oracleId: 'o',
    underlyingAsset: 'BTC',
    expiryMs: now + 900_000,
    spot: 100_000,
    forward: 100_000,
    svi: { a: 0.01, b: 0.1, rho: 0, m: 0, sigma: 0.1 },
    timestampMs: now,
    isSettled: false,
  } satisfies OracleSnapshot;
  const polySnap = (expiryMs: number): PolymarketSnapshot => ({
    conditionId: '0xc',
    strike: 100_000,
    expiryMs,
    yesBid: 0.5,
    yesAsk: 0.52,
    yesBidSize: 100,
    yesAskSize: 100,
    noBid: 0.48,
    noAsk: 0.5,
    volume24hUsd: 10_000,
    fetchedAtMs: now,
    yesTokenId: 'y',
    noTokenId: 'n',
  });
  const cfg = {
    maxSviStalenessSec: 300,
    polyMaxBidaskVolPts: 0.05,
    polyMinVolume24hUsd: 1000,
    expiryToleranceSec: 14 * 24 * 3600,
    minPredictProb: 0.05,
    maxPredictProb: 0.95,
  } as SvxConfig;

  it('rejects a market past its end time', () => {
    const r = applyFilters({
      oracleSnapshot: oracle,
      polymarketSnapshot: polySnap(now - 1),
      expiryDeltaMs: 0,
      cfg,
      nowMs: now,
    });
    expect(r).toBe('expiry_mismatch');
  });

  it('passes a live market', () => {
    const r = applyFilters({
      oracleSnapshot: oracle,
      polymarketSnapshot: polySnap(now + 3600_000),
      expiryDeltaMs: 0,
      cfg,
      nowMs: now,
    });
    expect(r).toBeNull();
  });
});

describe('reconcileExternallyRedeemedPositions', () => {
  it('marks a row redeemed when the funder holds zero of that token on-chain', async () => {
    const id = insertPolyTrade({ tokenId: 'tok-claimed', shares: 10, costUsdc: 2 });
    ledger.markPolySettled(id, 'yes', 10, 8, Date.now());
    ledger.markPolyRedeemed(id, null, 'failed'); // pre-fix bot attempt that reverted

    const fakePolyExec = { getConditionalTokenBalance: async () => 0n };
    await reconcileExternallyRedeemedPositions({ polyExec: fakePolyExec, ledger });

    expect(ledger.unredeemedPolyPayoutUsdc()).toBe(0);
    const [row] = ledger.closedPolyTrades(10);
    expect(row?.polyRedeemStatus).toBe('success');
    expect(row?.polyRedeemTxHash).toBe('external-claim');
  });

  it('leaves a row alone when the funder still holds the token on-chain', async () => {
    const id = insertPolyTrade({ tokenId: 'tok-still-held', shares: 10, costUsdc: 2 });
    ledger.markPolySettled(id, 'yes', 10, 8, Date.now());

    const fakePolyExec = { getConditionalTokenBalance: async () => 10_000_000n };
    await reconcileExternallyRedeemedPositions({ polyExec: fakePolyExec, ledger });

    expect(ledger.unredeemedPolyPayoutUsdc()).toBe(10);
  });

  it('groups multiple ledger rows sharing one outcome token into a single balance check', async () => {
    let calls = 0;
    const a = insertPolyTrade({ tokenId: 'tok-shared', shares: 5, costUsdc: 1, conditionId: '0xshared' });
    const b = insertPolyTrade({ tokenId: 'tok-shared', shares: 5, costUsdc: 1, conditionId: '0xshared' });
    ledger.markPolySettled(a, 'yes', 5, 4, Date.now());
    ledger.markPolySettled(b, 'yes', 5, 4, Date.now());

    const fakePolyExec = {
      getConditionalTokenBalance: async () => {
        calls++;
        return 0n;
      },
    };
    await reconcileExternallyRedeemedPositions({ polyExec: fakePolyExec, ledger });

    expect(calls).toBe(1);
    expect(ledger.unredeemedPolyPayoutUsdc()).toBe(0);
  });

  it('is a no-op when there is nothing unredeemed', async () => {
    let calls = 0;
    const fakePolyExec = {
      getConditionalTokenBalance: async () => {
        calls++;
        return 0n;
      },
    };
    await reconcileExternallyRedeemedPositions({ polyExec: fakePolyExec, ledger });
    expect(calls).toBe(0);
  });

  it('does not retry-backoff-gate the balance check (unlike the submit-retry queue)', async () => {
    // A row that failed a submit attempt seconds ago would be excluded from
    // the SUBMIT retry queue by polyRedeemRetryGapMs, but the read-only
    // balance check must still see it — it costs no gas and isn't rate
    // limited by Polymarket.
    const id = insertPolyTrade({ tokenId: 'tok-recent-fail', shares: 10, costUsdc: 2 });
    ledger.markPolySettled(id, 'yes', 10, 8, Date.now());
    ledger.markPolyRedeemed(id, null, 'failed');

    const fakePolyExec = { getConditionalTokenBalance: async () => 0n };
    await reconcileExternallyRedeemedPositions({ polyExec: fakePolyExec, ledger });

    expect(ledger.unredeemedPolyPayoutUsdc()).toBe(0);
  });
});
