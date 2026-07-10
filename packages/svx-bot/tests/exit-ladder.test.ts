/**
 * Exit-ladder + entry-cap tests (2026-07 execution upgrade).
 *
 * The old exits were market FOK sells that swept the book — intraday
 * price-history showed stops realizing 5–10pp below the tape. The ladder
 * bounds each attempt: a floor-priced FAK sells what the book offers at
 * ≥ (bestBid − polyExitMaxSlippagePts), and a partial fill splits the
 * ledger row so realized PnL books immediately (wallet-vs-ledger invariant
 * exact) while the remainder keeps walking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerStore } from '../src/ledger/store.js';
import { PolymarketExecClient } from '../src/exec/polymarket-client.js';

let tmp: string;
let ledger: LedgerStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-ladder-'));
  ledger = new LedgerStore(path.join(tmp, 'svx.sqlite'));
});
afterEach(() => {
  ledger.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function insertOpenPolyTrade(opts: { shares: number; costUsdc: number }): string {
  return ledger.insertTrade({
    signalId: 's',
    timestampMs: 1_700_000_000_000,
    mode: 'paper',
    oracleId: 'oracle-x',
    underlyingAsset: 'BTC',
    expiryMs: 1_700_000_900_000,
    strike: 80_000,
    direction: 'up',
    quantityDusdc: 0,
    costPrice: 0.5,
    costUsdc: 0,
    settled: true, // predict side irrelevant here
    strategy: 'poly_arb',
    polyNetwork: 'polygon',
    polyTokenId: 'tok-1',
    polyConditionId: '0xabc',
    polySide: 'buy',
    polyOutcome: 'yes',
    polyOrderId: 'ord',
    polyFilledShares: opts.shares,
    polyFillPrice: opts.costUsdc / opts.shares,
    polyCostUsdc: opts.costUsdc,
    polyStatus: 'filled',
  });
}

describe('splitPolyPartialExit', () => {
  it('shrinks the original pro-rata and books the chunk as settled early_exit', () => {
    // 40 shares @ 25¢ = $10 cost. Ladder sells 15 shares for $3.30 (22¢).
    const id = insertOpenPolyTrade({ shares: 40, costUsdc: 10 });
    const chunkId = ledger.splitPolyPartialExit(id, 15, 3.3, 'ord-exit', 1_700_000_100_000);

    const open = ledger.unsettledPolyTrades();
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(id);
    expect(open[0]!.polyFilledShares).toBeCloseTo(25, 9);
    expect(open[0]!.polyCostUsdc).toBeCloseTo(6.25, 9); // 10 × 25/40

    // Chunk: cost 10 × 15/40 = 3.75 → pnl = 3.30 − 3.75 = −0.45.
    const all = ledger.allTrades();
    const chunk = all.find((t) => t.id === chunkId)!;
    expect(chunk.polySettled).toBe(true);
    expect(chunk.polySettlementOutcome).toBe('early_exit');
    expect(chunk.polyPayoutUsdc).toBeCloseTo(3.3, 9);
    expect(chunk.polyPnlUsdc).toBeCloseTo(-0.45, 9);
    expect(chunk.polyFilledShares).toBeCloseTo(15, 9);
    // Predict side zeroed so oracle settlement can't double-count it.
    expect(chunk.quantityDusdc).toBe(0);
    expect(chunk.costUsdc).toBe(0);
    expect(chunk.settled).toBe(true);
  });

  it('books the chunk PnL into the realized poly window immediately', () => {
    const id = insertOpenPolyTrade({ shares: 40, costUsdc: 10 });
    const before = ledger.realizedPolyPnlSince(1_700_000_000_000);
    ledger.splitPolyPartialExit(id, 15, 3.3, null, 1_700_000_100_000);
    const after = ledger.realizedPolyPnlSince(1_700_000_000_000);
    expect(after - before).toBeCloseTo(-0.45, 9);
  });

  it('cost conservation: original cost + chunk cost = pre-split cost', () => {
    const id = insertOpenPolyTrade({ shares: 33, costUsdc: 7.77 });
    const chunkId = ledger.splitPolyPartialExit(id, 11, 2.0, null, 1_700_000_100_000);
    const all = ledger.allTrades();
    const orig = all.find((t) => t.id === id)!;
    const chunk = all.find((t) => t.id === chunkId)!;
    expect((orig.polyCostUsdc ?? 0) + (chunk.polyCostUsdc ?? 0)).toBeCloseTo(7.77, 9);
    expect((orig.polyFilledShares ?? 0) + (chunk.polyFilledShares ?? 0)).toBeCloseTo(33, 9);
  });

  it('refuses a full-position or zero split', () => {
    const id = insertOpenPolyTrade({ shares: 10, costUsdc: 5 });
    expect(() => ledger.splitPolyPartialExit(id, 10, 5, null, 1)).toThrow(/out of range/);
    expect(() => ledger.splitPolyPartialExit(id, 0, 0, null, 1)).toThrow(/out of range/);
    expect(() => ledger.splitPolyPartialExit('nope', 1, 1, null, 1)).toThrow(/no poly leg/);
  });
});

describe('order price bounds', () => {
  function fakeClob() {
    const calls: unknown[][] = [];
    return {
      calls,
      clob: {
        createAndPostMarketOrder: async (...args: unknown[]) => {
          calls.push(args);
          return { status: 'matched', makingAmount: '1', takingAmount: '1' };
        },
      },
    };
  }

  it('limitSell posts a floor-priced FAK', async () => {
    const fake = fakeClob();
    await PolymarketExecClient.prototype.limitSell.call(fake, {
      tokenId: 't',
      shares: 12,
      floorPrice: 0.41,
    });
    const [order, , orderType] = fake.calls[0]!;
    expect(order).toMatchObject({ amount: 12, price: 0.41, orderType: 'FAK' });
    expect(orderType).toBe('FAK');
  });

  it('marketBuy passes the price cap through (and omits it when absent)', async () => {
    const fake = fakeClob();
    await PolymarketExecClient.prototype.marketBuy.call(fake, {
      tokenId: 't',
      usdcAmount: 5,
      maxPrice: 0.62,
    });
    expect(fake.calls[0]![0]).toMatchObject({ amount: 5, price: 0.62, orderType: 'FOK' });

    await PolymarketExecClient.prototype.marketBuy.call(fake, {
      tokenId: 't',
      usdcAmount: 5,
    });
    expect(fake.calls[1]![0]).not.toHaveProperty('price');
  });
});
