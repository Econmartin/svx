import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateMintCost, feePolicyFromMarketJson } from '../src/pricing/predict-sdk.js';

/**
 * Mainnet launch (2026-09-24) fee policy, as snapshotted on a live BTC
 * ExpiryMarket's `strike_exposure.config`. Trading fee per $1 contract is
 * base_fee·√(p(1−p)), ramping up to 3× inside the final 60s.
 */
const MARKET_JSON = {
  expiry: '1790337600000',
  strike_exposure: {
    admission_tick_size: '1000000000',
    tick_size: '10000000',
    inventory_impact_scale: '10000000000',
    settlement_price: null,
    config: {
      backing_buffer_lambda: '310000000',
      base_fee: '204000000',
      expiry_fee_max_multiplier: '3000000000',
      expiry_fee_window_ms: '60000',
      inventory_impact_max_rate: '0',
      max_entry_probability: '990000000',
      min_entry_probability: '10000000',
      min_fee: '22000000',
    },
  },
};

describe('mainnet fee policy', () => {
  const fees = feePolicyFromMarketJson(MARKET_JSON)!;
  const now = 1_790_337_000_000;

  it('parses the market-snapshotted policy', () => {
    expect(fees.baseFee).toBe(204_000_000n);
    expect(fees.expiryFeeMaxMultiplier).toBe(3_000_000_000n);
    expect(fees.inventoryImpactScale).toBe(10_000_000_000n);
  });

  it('returns null when a field is missing (caller falls back to a chain quote)', () => {
    expect(feePolicyFromMarketJson({ strike_exposure: { config: {} } })).toBeNull();
  });

  it('charges 0.204·√(p(1−p)) per contract outside the ramp', () => {
    const r = estimateMintCost({
      fees,
      expiryMs: now + 120_000,
      nowMs: now,
      sideProbability: 0.75,
      direction: 'up',
      quantity: 10,
    })!;
    expect(r.costPerContract).toBeCloseTo(0.75 + 0.204 * Math.sqrt(0.75 * 0.25), 3);
    expect(r.fee).toBeCloseTo(10 * 0.0883, 2);
  });

  it('prices a DOWN favorite the same as the mirrored UP', () => {
    const up = estimateMintCost({
      fees, expiryMs: now + 120_000, nowMs: now, sideProbability: 0.75, direction: 'up', quantity: 10,
    })!;
    const down = estimateMintCost({
      fees, expiryMs: now + 120_000, nowMs: now, sideProbability: 0.75, direction: 'down', quantity: 10,
    })!;
    expect(down.cost).toBeCloseTo(up.cost, 4);
  });

  it('survives float complements with >9 decimals (1 − 0.772)', () => {
    expect(
      estimateMintCost({
        fees, expiryMs: now + 120_000, nowMs: now, sideProbability: 0.772, direction: 'down', quantity: 5,
      }),
    ).not.toBeNull();
  });

  it('ramps the fee inside the last minute', () => {
    const early = estimateMintCost({
      fees, expiryMs: now + 120_000, nowMs: now, sideProbability: 0.75, direction: 'up', quantity: 10,
    })!;
    const late = estimateMintCost({
      fees, expiryMs: now + 20_000, nowMs: now, sideProbability: 0.75, direction: 'up', quantity: 10,
    })!;
    expect(late.fee).toBeGreaterThan(early.fee * 2);
  });

  it('is proportional to size — a bigger clip does not dilute the fee', () => {
    const small = estimateMintCost({
      fees, expiryMs: now + 120_000, nowMs: now, sideProbability: 0.75, direction: 'up', quantity: 5,
    })!;
    const big = estimateMintCost({
      fees, expiryMs: now + 120_000, nowMs: now, sideProbability: 0.75, direction: 'up', quantity: 500,
    })!;
    expect(big.costPerContract).toBeCloseTo(small.costPerContract, 4);
  });

  it('refuses an order below the $1 minimum premium (the chain would abort)', () => {
    expect(
      estimateMintCost({
        fees, expiryMs: now + 120_000, nowMs: now, sideProbability: 0.75, direction: 'up', quantity: 1,
      }),
    ).toBeNull();
  });
});

describe('mintLive: queued orders (Predict v4), gated on the exact plan', () => {
  afterEach(() => {
    vi.doUnmock('../src/pricing/predict-sdk.js');
    vi.doUnmock('../src/exec/submit.js');
    vi.resetModules();
  });

  type Outcome = { outcome: string; order: { view: Record<string, unknown> } | null } | null;
  async function run(
    quote: { cost: number; entryProbability: number; quantity: number },
    opts: { accepting?: boolean; refusal?: string | null; outcome?: Outcome; ledger?: unknown } = {},
  ) {
    const planQueuedMint = vi.fn(async () => ({
      quote: { ...quote, premium: quote.cost * 0.9 },
      orderFee: 0.02,
      accepting: opts.accepting ?? true,
      refusal: opts.refusal ?? null,
      expectedDebit: quote.cost + 0.02,
      totalDebit: quote.cost + 0.5,
    }));
    const buildQueuedMintTx = vi.fn(async () => ({}) as never);
    const submitTx = vi.fn(async () => ({ ok: true, digest: 'D', events: [{}] }));
    const waitQueuedOutcome = vi.fn(async () =>
      opts.outcome === undefined
        ? {
            outcome: 'filled',
            order: {
              view: {
                state: 'filled',
                quantityRaw: BigInt(quote.quantity * 1e6),
                amountRaw: BigInt(Math.round(quote.cost * 0.99 * 1e6)),
                position: { orderId: 99n },
              },
            },
          }
        : opts.outcome,
    );
    vi.doMock('../src/pricing/predict-sdk.js', () => ({
      planQueuedMint,
      buildQueuedMintTx,
      decodeEnqueueRecordId: () => 7n,
      waitQueuedOutcome,
    }));
    vi.doMock('../src/exec/submit.js', () => ({ submitTx }));
    const { mintLive, DEFAULT_LIVE_MINT_GATES } = await import('../src/exec/mint-v2.js');
    const out = await mintLive({
      sui: {} as never,
      keypair: {} as never,
      owner: '0x1',
      order: {
        underlying: 'BTC', expiryMs: 1, marketId: '0xm', strike: 84_000, direction: 'up', quantity: 10,
      },
      gates: { ...DEFAULT_LIVE_MINT_GATES, maxFeeDrag: 0.03, maxEntryProbability: 0.9 },
      ...(opts.ledger ? { ledger: opts.ledger as never } : {}),
    });
    return { out, planQueuedMint, submitTx };
  }

  it('skips when the fee drag (order fee included) exceeds the gate', async () => {
    const { out, submitTx } = await run({ cost: 8.383, entryProbability: 0.75, quantity: 10 });
    expect(out).toMatchObject({ kind: 'skipped', reason: 'fee_drag' });
    expect(submitTx).not.toHaveBeenCalled();
  });

  it('skips when the protocol fill is above the band', async () => {
    const { out } = await run({ cost: 9.3, entryProbability: 0.92, quantity: 10 });
    expect(out).toMatchObject({ kind: 'skipped', reason: 'entry_above_band' });
  });

  it("skips what the queue's own preflight refuses, without sending", async () => {
    const { out, submitTx } = await run(
      { cost: 7.7, entryProbability: 0.75, quantity: 10 },
      { accepting: false, refusal: 'entry-band' },
    );
    expect(out).toMatchObject({ kind: 'skipped', reason: 'refused:entry-band' });
    expect(submitTx).not.toHaveBeenCalled();
  });

  it('queues with slippage in cents and books what the fill actually paid plus the order fee', async () => {
    const { out, planQueuedMint } = await run({ cost: 7.7, entryProbability: 0.75, quantity: 10 });
    expect((planQueuedMint.mock.calls[0] as unknown[])[2]).toBe(2); // 0.02 probability slippage → 2¢
    expect(out.kind).toBe('filled');
    if (out.kind !== 'filled') return;
    expect(out.recordId).toBe('7');
    expect(out.fill!.quantityDusdc).toBe(10);
    expect(out.fill!.costUsdc).toBeCloseTo(7.7 * 0.99 + 0.02, 6);
    expect(out.fill!.orderId).toBe('99');
  });

  it('a refund that keeps the order fee is booked as an unbooked debit for the bank check', async () => {
    const meta = new Map<string, string>();
    const ledger = { getMeta: (k: string) => meta.get(k), setMeta: (k: string, v: string) => meta.set(k, v) };
    const { out } = await run(
      { cost: 7.7, entryProbability: 0.75, quantity: 10 },
      {
        ledger,
        outcome: { outcome: 'refunded', order: { view: { state: 'refunded', reason: { key: 'limits', feeKept: true } } } },
      },
    );
    expect(out).toMatchObject({ kind: 'skipped', reason: 'refunded:limits' });
    expect(Number(meta.get('predict_unbooked_debits_usdc'))).toBeCloseTo(0.02);
  });

  it('an order the keeper has not resolved in time is reported, not booked', async () => {
    const { out } = await run({ cost: 7.7, entryProbability: 0.75, quantity: 10 }, { outcome: { outcome: 'timeout', order: null } });
    expect(out).toMatchObject({ kind: 'failed', reason: 'queue_timeout' });
  });
});
