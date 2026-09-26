import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore, type ShadowDecisionInput } from '../src/ledger/store.js';
import { runFadeSpikeDecision } from '../src/index.js';

const decision = (over: Partial<ShadowDecisionInput> = {}): ShadowDecisionInput => ({
  network: 'mainnet',
  marketId: '0xmarket',
  slot: 't50s',
  expiryMs: Date.now() + 50_000,
  recordedAtMs: Date.now(),
  ttmMs: 50_000,
  reference: 84_000,
  forward: 84_030,
  boardUp: 0.88, // DOWN (the far side) costs 12c
  costUp: 0.93,
  costDown: 0.2,
  binMid: 84_030,
  binImpliedUp: 0.9,
  mom1m: null,
  mom5m: null,
  mom15m: null,
  bookImb: null,
  takerBuyRatio: null,
  funding: null,
  mom30s: 0.0004, // rose over 30s…
  binVsRef: 30, // …to $30 above the strike: a spike
  ...over,
});

describe('runFadeSpikeDecision (paper)', () => {
  let tmp: string;
  let ledger: LedgerStore;
  const env = { ...process.env };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svx-fade-'));
    ledger = new LedgerStore(path.join(tmp, 'svx.sqlite'));
    // Live requested but PAPER_TRADING on: must still book paper, never mint.
    process.env.SVX_FADE_SPIKE_LIVE = 'true';
  });
  afterEach(() => {
    ledger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = { ...env };
  });

  const run = (d: ShadowDecisionInput) =>
    runFadeSpikeDecision({ decision: d, underlying: 'BTC' }, {
      ledger,
      cfg: { paperTrading: true } as never,
      live: undefined,
    });

  it('books the far side at the reference strike, sized to clear the $1 premium', async () => {
    await run(decision());
    const [t] = ledger.openTrades().filter((x) => x.strategy === 'fade_spike');
    expect(t).toBeDefined();
    expect(t!.mode).toBe('paper');
    expect(t!.direction).toBe('down');
    expect(t!.strike).toBe(84_000);
    expect(t!.quantityDusdc).toBeCloseTo(9.34, 6); // ceil(1.12 / 0.12, $0.01 lots)
    expect(t!.costUsdc).toBeCloseTo(9.34 * 0.2, 6); // fee-inclusive cost
  });

  it('settles a reversal as a win (DOWN wins at or below the strike)', async () => {
    await run(decision());
    ledger.settleTradesForOracle('0xmarket', 83_990, Date.now());
    expect(ledger.realizedStrategyPnlSince('fade_spike', 0)).toBeCloseTo(9.34 - 9.34 * 0.2, 6);
  });

  it('takes one position per market and ignores non-signals', async () => {
    await run(decision());
    await run(decision());
    await run(decision({ marketId: '0xother', mom30s: -0.0004 })); // not a spike
    expect(ledger.openTrades().filter((x) => x.strategy === 'fade_spike')).toHaveLength(1);
  });

  it('only trades at the configured checkpoint (default ~50s); 30s stays shadow-only', async () => {
    await run(decision({ slot: 't30s', ttmMs: 30_000 }));
    expect(ledger.openTrades().filter((x) => x.strategy === 'fade_spike')).toHaveLength(0);
    process.env.SVX_FADE_SPIKE_SLOTS = 't50s,t30s';
    await run(decision({ slot: 't30s', ttmMs: 30_000 }));
    expect(ledger.openTrades().filter((x) => x.strategy === 'fade_spike')).toHaveLength(1);
  });

  it('stands down at the daily loss limit', async () => {
    process.env.SVX_FADE_SPIKE_DAILY_LOSS_USD = '1';
    await run(decision());
    ledger.settleTradesForOracle('0xmarket', 84_100, Date.now()); // spike held: loss
    await run(decision({ marketId: '0xnext' }));
    expect(ledger.openTrades().filter((x) => x.strategy === 'fade_spike')).toHaveLength(0);
  });
});
