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
      })) as unknown as {
        Transaction?: { digest?: string; effects?: unknown };
        transaction?: { digest?: string; effects?: unknown };
        digest?: string;
        effects?: unknown;
      };
      // gRPC wraps the executed tx ($kind: 'Transaction'); tolerate the plain
      // shape too so a client change can't silently break status parsing.
      const txn = raw.Transaction ?? raw.transaction ?? raw;
      const effects = txn.effects as
        | { status?: { success?: boolean; error?: unknown } }
        | undefined;
      const digest = txn.digest ?? '';
      const ok = effects?.status?.success !== false;
      const status = ok ? 'success' : 'failure';
      const error = effects?.status?.error ? JSON.stringify(effects.status.error) : undefined;
      if (ok) {
        return { ok: true, digest, status };
      }
      log.warn('svx.tx.failed', { digest, status, error, attempt });
      return { ok: false, digest, status, error };
    } catch (e) {
      lastErr = e;
      const msg = errMsg(e);
      // A MoveAbort is deterministic: the same payload will fail identically.
      // Retrying wastes gas budget and floods the logs (2026-08-03: an
      // off-grid mint tick produced a retry storm on every 10s tick).
      if (/MoveAbort|abort code/i.test(msg)) {
        log.warn('svx.tx.move_abort', { err: msg });
        return { ok: false, digest: '', status: 'move_abort', error: msg };
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
