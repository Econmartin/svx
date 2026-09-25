import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore } from '../src/ledger/store.js';
import { reportWatchedWallets, watchedWallets, DEFAULT_WATCHED_WALLETS } from '../src/ops/wallet-watch.js';

const POS_INF = ((1n << 30n) - 1n).toString();
const TICK_USD = 0.01; // tick_size 1e7 raw

describe('wallet watch ledger + report', () => {
  let tmp: string;
  let ledger: LedgerStore;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-watch-'));
    ledger = new LedgerStore(path.join(tmp, 'svx.sqlite'));
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const pos = (rootId: string, over: Partial<Parameters<LedgerStore['insertWatchedPosition']>[0]>) => ({
    rootId,
    owner: '0xw',
    marketId: '0xm',
    mintedAtMs: 1_000,
    expiryMs: 41_000,
    entryProb: 0.25,
    quantity: 10,
    cost: 3,
    lowerTick: '8400000', // $84,000
    higherTick: POS_INF,
    side: 'up',
    ...over,
  });

  it('resolves up / down / range positions against the settlement', () => {
    ledger.insertWatchedPosition(pos('up', {}));
    ledger.insertWatchedPosition(pos('down', { lowerTick: '0', higherTick: '8400000', side: 'down' }));
    ledger.insertWatchedPosition(
      pos('range', { lowerTick: '8399000', higherTick: '8401000', side: 'range' }),
    );
    expect(ledger.unresolvedWatchedMarkets(100_000)).toEqual(['0xm']);
    ledger.resolveWatchedMarket('0xm', 84_005, TICK_USD);
    const won = Object.fromEntries(
      ledger.watchedPositions().map((p, i) => [['up', 'down', 'range'][i], p.won]),
    );
    expect(won).toEqual({ up: true, down: false, range: true });
  });

  it('counts early exits at net proceeds and keeps them out of the held z-score', () => {
    ledger.insertWatchedPosition(pos('a', {}));
    ledger.insertWatchedPosition(pos('b', {}));
    ledger.addWatchedExit('b', 6, 10); // fully closed early for $6
    ledger.resolveWatchedMarket('0xm', 84_005, TICK_USD); // 'a' wins $10
    const [r] = reportWatchedWallets(ledger.watchedPositions());
    expect(r!.held.n).toBe(1);
    expect(r!.held.wins).toBe(1);
    expect(r!.earlyExitRate).toBe(0.5);
    expect(r!.cashPnl).toBeCloseTo(10 - 3 + (6 - 3), 10);
    expect(r!.spent).toBe(6);
  });

  it('leaves open positions out of cash PnL', () => {
    ledger.insertWatchedPosition(pos('open', {}));
    const [r] = reportWatchedWallets(ledger.watchedPositions());
    expect(r!.spent).toBe(0);
    expect(r!.recent[0]!.result).toBe('open');
  });
});

describe('watchedWallets()', () => {
  const prev = process.env.SVX_WATCH_WALLETS;
  afterEach(() => {
    if (prev === undefined) delete process.env.SVX_WATCH_WALLETS;
    else process.env.SVX_WATCH_WALLETS = prev;
  });
  it('defaults, overrides, and disables', () => {
    delete process.env.SVX_WATCH_WALLETS;
    expect(watchedWallets()).toEqual(DEFAULT_WATCHED_WALLETS);
    process.env.SVX_WATCH_WALLETS = `0x${'a'.repeat(64)}, junk`;
    expect(watchedWallets()).toEqual([`0x${'a'.repeat(64)}`]);
    process.env.SVX_WATCH_WALLETS = 'none';
    expect(watchedWallets()).toEqual([]);
  });
});
