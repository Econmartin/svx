/**
 * Live Predict mint — quote, gate, cap, submit, decode.
 *
 * One path for every strategy that mints on Predict:
 *
 *   1. `read.quoteMint` dry-runs the EXACT mint against our real account and
 *      the live market: the entry probability the protocol will fill at (its
 *      skewed board, not our model) and the all-in debit including every fee.
 *   2. Gates on that quote — never on our model — because the quote is what
 *      we pay. Two gates: the entry probability must still sit inside the
 *      strategy's band, and the FEE DRAG (all-in cost per $1 contract minus
 *      the entry probability) must not exceed `maxFeeDrag`. Mainnet charges
 *      base_fee·√(p(1−p)) per contract, ramping to 3× in the last minute —
 *      6–15¢ at 60–90¢ entries, which is larger than the favorites edge we
 *      measured on testnet. The fee gate is what stops that from quietly
 *      turning a validated edge into a loss.
 *   3. Mints with BOTH slippage caps derived from the quote (the SDK leaves
 *      them uncapped by default).
 *   4. Books the decoded receipt, not the quote.
 */

import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  buildMintTx,
  decodeMintFill,
  quoteMint,
  type BinaryOrder,
  type MintFill,
} from '../pricing/predict-sdk.js';
import type { SuiChainClient } from './sui-client.js';
import { submitTx } from './submit.js';

export type LiveMintOutcome =
  | { kind: 'filled'; digest: string; fill: MintFill | null }
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
}

export const DEFAULT_LIVE_MINT_GATES: LiveMintGates = {
  maxEntryProbability: 0.9,
  maxFeeDrag: 0.03,
  costSlippage: 0.02,
  probabilitySlippage: 0.02,
};

export async function mintLive(args: {
  sui: SuiChainClient;
  keypair: Ed25519Keypair;
  owner: string;
  order: BinaryOrder;
  gates: LiveMintGates;
}): Promise<LiveMintOutcome> {
  const { order, gates } = args;
  let q: Awaited<ReturnType<typeof quoteMint>>;
  try {
    q = await quoteMint(args.owner, order);
  } catch (e) {
    // The quote runs the real code path, so a refusal here (stale oracle,
    // trade window closed, no backing, below min premium) is the same abort
    // the mint would hit — without paying gas to learn it.
    return { kind: 'failed', reason: `quote:${e instanceof Error ? e.message : String(e)}` };
  }
  if (!(q.quantity > 0)) return { kind: 'failed', reason: 'quote:zero_quantity' };
  const costPerContract = q.cost / q.quantity;
  const quote = { entryProbability: q.entryProbability, costPerContract };
  if (q.entryProbability > gates.maxEntryProbability) {
    return { kind: 'skipped', reason: 'entry_above_band', quote };
  }
  if (costPerContract - q.entryProbability > gates.maxFeeDrag) {
    return { kind: 'skipped', reason: 'fee_drag', quote };
  }
  const tx = await buildMintTx(args.owner, order, {
    maxCost: q.cost * (1 + gates.costSlippage),
    maxProbability: q.entryProbability + gates.probabilitySlippage,
  });
  const result = await submitTx(args.sui, tx, args.keypair);
  if (!result.ok) {
    return { kind: 'failed', reason: String(result.error ?? 'submit_failed'), digest: result.digest };
  }
  return { kind: 'filled', digest: result.digest, fill: decodeMintFill(result.events) };
}
