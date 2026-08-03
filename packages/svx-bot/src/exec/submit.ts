/**
 * Transaction submission helpers.
 *
 * Strategy:
 *   1. Submit the tx; wait for execution.
 *   2. If status is 'failure', log and return error; do NOT auto-retry on
 *      protocol-level failures (those usually mean state conflict — retrying
 *      makes it worse).
 *   3. On RPC/network errors, retry once with the same payload.
 *
 * We deliberately do NOT bump gas — the protocol's mint cost is a function
 * of the trade size, not gas; if a tx fails for budget reasons it's
 * misconfigured.
 */

import type { SuiChainClient } from './sui-client.js';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { log } from '../util/log.js';

export interface TxResult {
  ok: boolean;
  digest: string;
  status?: string;
  error?: string;
  /** Move events from the executed tx — lets callers decode exact fills
   *  (entry probability, quantity, fees) instead of booking modeled costs. */
  events?: Array<{ eventType?: string; type?: string; bcs?: Uint8Array | string }>;
}

export async function submitTx(
  sui: SuiChainClient,
  tx: Transaction,
  signer: Ed25519Keypair,
): Promise<TxResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = (await sui.signAndExecuteTransaction({
        transaction: tx,
        signer,
        include: { events: true },
      })) as unknown as {
        $kind?: string;
        Transaction?: {
          digest?: string;
          status?: { success?: boolean; error?: unknown };
          events?: TxResult['events'];
        };
        // gRPC failures come back as a discriminated FailedTransaction — the
        // earlier parse missed this arm entirely and read a failure as
        // success with an empty digest.
        FailedTransaction?: {
          digest?: string;
          status?: { success?: boolean; error?: unknown };
        };
      };
      const txn = raw.Transaction ?? raw.FailedTransaction;
      const digest = txn?.digest ?? '';
      const ok =
        raw.$kind !== 'FailedTransaction' &&
        raw.FailedTransaction == null &&
        txn?.status?.success !== false;
      const status = ok ? 'success' : 'failure';
      const error = txn?.status?.error ? JSON.stringify(txn.status.error) : undefined;
      if (ok) {
        return { ok: true, digest, status, events: raw.Transaction?.events };
      }
      log.warn('svx.tx.failed', { digest, status, error, attempt });
      return { ok: false, digest, status, error };
    } catch (e) {
      lastErr = e;
      const msg = errMsg(e);
      // A MoveAbort is deterministic: the same payload will fail identically.
      // Retrying wastes gas budget and floods the logs (2026-08-03: an
      // off-grid mint tick produced a retry storm on every 10s tick).
      // CommandArgumentError/TypeMismatch means the PTB itself is malformed
      // for this package — as deterministic as an abort.
      if (/MoveAbort|abort code|CommandArgumentError|TypeMismatch/i.test(msg)) {
        log.warn('svx.tx.deterministic_failure', { err: msg });
        return { ok: false, digest: '', status: 'deterministic_failure', error: msg };
      }
      log.warn('svx.tx.network_error', { err: msg, attempt });
      if (attempt === 0) await sleep(500);
    }
  }
  return { ok: false, digest: '', error: errMsg(lastErr) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
