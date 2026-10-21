/**
 * Live Predict mint — plan, gate, queue, wait, book.
 *
 * One path for every strategy that mints on Predict. Since the 2026-10-20
 * relaunch (Predict v4, delayed execution) a mint is a QUEUED order: it is
 * placed now and filled ~0.8s later by a keeper at Pyth's signed price for
 * its tick, or refunded (the $0.02 order fee is kept either way).
 *
 *   1. `read.planMint` quotes the exact order against our real account and
 *      the live market — the entry probability, the all-in cost and the flat
 *      order fee — and runs the queue's own preflight (`accepting`/`refusal`).
 *   2. Gates on that quote, never on our model, because the quote is what we
 *      pay: the entry probability must sit inside the strategy's band, the
 *      FEE DRAG (all-in cost per $1 contract, order fee included, minus the
 *      entry probability) must not exceed `maxFeeDrag`, and the worst-case
 *      debit must fit the cost cap.
 *   3. Queues it with the plan's limits (slippage in cents per contract,
 *      from `probabilitySlippage`), then waits for the keeper's outcome.
 *   4. Books the fill the record reports — quantity and amount actually paid
 *      plus the order fee — not the quote.
 */

import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { LedgerStore } from '../ledger/store.js';
import {
  buildQueuedMintTx,
  decodeEnqueueRecordId,
  planQueuedMint,
  waitQueuedOutcome,
  type MintFill,
  type PredictOrder,
  type QueuedMintPlan,
} from '../pricing/predict-sdk.js';
import { log } from '../util/log.js';
import { noteUnbookedDebit } from '../ops/bank-gauge.js';
import type { SuiChainClient } from './sui-client.js';
import { submitTx } from './submit.js';

export type LiveMintOutcome =
  | { kind: 'filled'; digest: string; fill: MintFill | null; recordId?: string }
  | { kind: 'skipped'; reason: string; quote?: { entryProbability: number; costPerContract: number } }
  | { kind: 'failed'; reason: string; digest?: string };

export interface LiveMintGates {
  /** Refuse when the protocol's entry probability exceeds this. */
  maxEntryProbability: number;
  /** Refuse when all-in cost per contract − entry probability exceeds this. */
  maxFeeDrag: number;
  /** Slippage headroom on the quoted all-in cost (fraction, e.g. 0.02). */
  costSlippage: number;
  /** Headroom on the entry-probability cap (absolute, e.g. 0.02). */
  probabilitySlippage: number;
  /** Optional hard cap on the trade's all-in cost, USD. */
  maxCostUsd?: number;
}

export const DEFAULT_LIVE_MINT_GATES: LiveMintGates = {
  maxEntryProbability: 0.9,
  maxFeeDrag: 0.03,
  costSlippage: 0.02,
  probabilitySlippage: 0.02,
};

/** How long to wait for the keeper to fill or refund a queued order. */
export const QUEUE_OUTCOME_TIMEOUT_MS = 20_000;

export async function mintLive(args: {
  sui: SuiChainClient;
  keypair: Ed25519Keypair;
  owner: string;
  order: PredictOrder;
  gates: LiveMintGates;
  /** For booking order fees a refund keeps (the bank check reconciles them). */
  ledger?: LedgerStore;
}): Promise<LiveMintOutcome> {
  const { order, gates } = args;
  const slippageCents = Math.max(1, Math.round(gates.probabilitySlippage * 100));
  let plan: QueuedMintPlan;
  try {
    plan = await planQueuedMint(args.owner, order, slippageCents);
  } catch (e) {
    // The plan reads the real queue and quote, so a refusal here (entry band,
    // min premium, stale oracle, past cutoff) is what the enqueue would hit.
    return { kind: 'failed', reason: `plan:${e instanceof Error ? e.message : String(e)}` };
  }
  const q = plan.quote;
  if (!(q.quantity > 0)) return { kind: 'failed', reason: 'plan:zero_quantity' };
  const costPerContract = (q.cost + plan.orderFee) / q.quantity;
  const quote = { entryProbability: q.entryProbability, costPerContract };
  if (!plan.accepting) {
    return { kind: 'skipped', reason: `refused:${plan.refusal ?? 'unknown'}`, quote };
  }
  if (q.entryProbability > gates.maxEntryProbability) {
    return { kind: 'skipped', reason: 'entry_above_band', quote };
  }
  if (costPerContract - q.entryProbability > gates.maxFeeDrag) {
    return { kind: 'skipped', reason: 'fee_drag', quote };
  }
  if (gates.maxCostUsd != null && plan.expectedDebit * (1 + gates.costSlippage) > gates.maxCostUsd) {
    return { kind: 'skipped', reason: 'cost_above_cap', quote };
  }
  const tx = await buildQueuedMintTx(args.owner, order, plan);
  const result = await submitTx(args.sui, tx, args.keypair);
  if (!result.ok) {
    return { kind: 'failed', reason: String(result.error ?? 'submit_failed'), digest: result.digest };
  }
  const recordId = decodeEnqueueRecordId(result.events);
  if (recordId == null) {
    log.error('svx.queue.receipt_missing', { digest: result.digest, marketId: order.marketId });
    return { kind: 'failed', reason: 'enqueue_receipt_missing', digest: result.digest };
  }
  const outcome = await waitQueuedOutcome(order, recordId, QUEUE_OUTCOME_TIMEOUT_MS).catch((e) => {
    log.warn('svx.queue.wait_error', { recordId: String(recordId), err: e instanceof Error ? e.message : String(e) });
    return null;
  });
  const view = outcome?.order?.view;
  if (outcome?.outcome === 'filled' && view?.state === 'filled') {
    const quantity = Number(view.quantityRaw) / 1e6;
    const paid = Number(view.amountRaw) / 1e6;
    const fill: MintFill = {
      // The record reports what was paid, not the fill price: the planned
      // entry probability stands in (the fill is within the plan's limits).
      entryProbability: q.entryProbability,
      quantityDusdc: quantity,
      netPremiumUsdc: q.premium,
      fees: { trading: 0, subsidy: 0, builder: 0, penalty: 0, inventoryImpact: 0 },
      costUsdc: paid + plan.orderFee,
      orderId: view.position ? view.position.orderId.toString() : '',
    };
    log.info('svx.queue.filled', { recordId: String(recordId), quantity, costUsdc: fill.costUsdc, digest: result.digest });
    return { kind: 'filled', digest: result.digest, fill, recordId: String(recordId) };
  }
  if (outcome?.outcome === 'refunded') {
    // The refund returns the escrow; for some reasons it keeps the order fee.
    const info = view && view.state === 'refunded' ? view.reason : null;
    if (args.ledger && info?.feeKept !== false) noteUnbookedDebit(args.ledger, plan.orderFee);
    const reason = info?.key ?? 'unknown';
    log.info('svx.queue.refunded', { recordId: String(recordId), reason, digest: result.digest });
    return { kind: 'skipped', reason: `refunded:${reason}`, quote };
  }
  // Timeout or gone: the order may still fill. Not booked here — the bank
  // check (account vs ledger) shows it if it did.
  log.error('svx.queue.unresolved', {
    recordId: String(recordId),
    outcome: outcome?.outcome ?? 'error',
    marketId: order.marketId,
    digest: result.digest,
  });
  return { kind: 'failed', reason: `queue_${outcome?.outcome ?? 'error'}`, digest: result.digest };
}
