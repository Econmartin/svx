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

import { SuiClient } from '@mysten/sui/client';
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
  sui: SuiClient,
  tx: Transaction,
  signer: Ed25519Keypair,
): Promise<TxResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await sui.signAndExecuteTransaction({
        transaction: tx,
        signer,
        options: { showEffects: true },
      });
      const status = result.effects?.status?.status ?? 'unknown';
      const error = result.effects?.status?.error;
      if (status === 'success') {
        return { ok: true, digest: result.digest, status };
      }
      log.warn('svx.tx.failed', { digest: result.digest, status, error, attempt });
      return { ok: false, digest: result.digest, status, error };
    } catch (e) {
      lastErr = e;
      log.warn('svx.tx.network_error', { err: errMsg(e), attempt });
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
