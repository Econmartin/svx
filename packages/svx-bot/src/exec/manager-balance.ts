/**
 * Read the on-chain dUSDC balance held inside a PredictManager via
 * dev-inspect of `predict_manager::balance<DUSDC>(manager)`.
 *
 * Used by the auto-redeem accounting and the dashboard's "manager balance"
 * stat. Pure read, no tx submitted.
 */

import type { SuiChainClient } from './sui-client.js';
import { readCoinBalance } from './sui-client.js';
import { Transaction } from '@mysten/sui/transactions';
import { ADDRESSES } from 'svx-shared/addresses';
import { QUOTE_UNIT } from 'svx-shared/constants';

/** Returns the manager's dUSDC balance in human-readable units (e.g. 12.34). */
export async function readManagerDusdcBalance(
  sui: SuiChainClient,
  managerId: string,
  sender: string,
): Promise<number> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ADDRESSES.packageId}::predict_manager::balance`,
    typeArguments: [ADDRESSES.dusdcType],
    arguments: [tx.object(managerId)],
  });
  tx.setSender(sender);
  const sim = (await sui.simulateTransaction({ transaction: tx })) as unknown as {
    commandResults?: Array<{ returnValues?: Array<{ value?: unknown; bcs?: unknown }> }>;
    results?: Array<{ returnValues?: Array<[number[], string]> }>;
  };
  const grpcRet = sim.commandResults?.[0]?.returnValues?.[0];
  const legacyRet = sim.results?.[0]?.returnValues?.[0];
  const rawBytes = (grpcRet?.value ?? grpcRet?.bcs ?? legacyRet?.[0]) as
    | number[]
    | Uint8Array
    | undefined;
  if (!rawBytes) return 0;
  // u64, little-endian.
  const bytes = Array.from(rawBytes as ArrayLike<number>);
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]!);
  }
  return Number(v) / Number(QUOTE_UNIT);
}

/** Returns the operator's wallet dUSDC balance (sum of all owned coin objects). */
export async function readWalletDusdcBalance(sui: SuiChainClient, owner: string): Promise<number> {
  const totalBalance = String(
    (await sui.getBalance({ owner, coinType: ADDRESSES.dusdcType })).balance?.balance ?? '0',
  );
  return Number(totalBalance) / Number(QUOTE_UNIT);
}
