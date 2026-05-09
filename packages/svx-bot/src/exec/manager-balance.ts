/**
 * Read the on-chain dUSDC balance held inside a PredictManager via
 * dev-inspect of `predict_manager::balance<DUSDC>(manager)`.
 *
 * Used by the auto-redeem accounting and the dashboard's "manager balance"
 * stat. Pure read, no tx submitted.
 */

import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { ADDRESSES } from 'svx-shared/addresses';
import { QUOTE_UNIT } from 'svx-shared/constants';

/** Returns the manager's dUSDC balance in human-readable units (e.g. 12.34). */
export async function readManagerDusdcBalance(
  sui: SuiClient,
  managerId: string,
  sender: string,
): Promise<number> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ADDRESSES.packageId}::predict_manager::balance`,
    typeArguments: [ADDRESSES.dusdcType],
    arguments: [tx.object(managerId)],
  });
  const inspect = await sui.devInspectTransactionBlock({
    sender,
    transactionBlock: tx,
  });
  const ret = inspect.results?.[0]?.returnValues?.[0];
  if (!ret) return 0;
  // returnValues[0] is [bytes[], type]. bytes is u64 little-endian.
  const bytes = ret[0] as number[];
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]!);
  }
  return Number(v) / Number(QUOTE_UNIT);
}

/** Returns the operator's wallet dUSDC balance (sum of all owned coin objects). */
export async function readWalletDusdcBalance(sui: SuiClient, owner: string): Promise<number> {
  const { totalBalance } = await sui.getBalance({ owner, coinType: ADDRESSES.dusdcType });
  return Number(totalBalance) / Number(QUOTE_UNIT);
}
