/**
 * Withdraw dUSDC from the PredictManager back to the operator wallet.
 *
 * Payouts from `predict::redeem` accumulate inside the PredictManager — they
 * are NOT auto-returned to the wallet. This script is the explicit sweep.
 *
 * Usage:
 *   pnpm --filter svx-bot withdraw-dusdc -- --amount 50      # withdraw $50
 *   pnpm --filter svx-bot withdraw-dusdc -- --all            # sweep everything
 *
 * The script always reads the manager's current balance and refuses to
 * withdraw more than is available.
 */

import path from 'node:path';
import fs from 'node:fs';
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { ADDRESSES, assertAddressesPinned } from 'svx-shared/addresses';
import { QUOTE_UNIT } from 'svx-shared/constants';
import { loadOperatorKey } from '../src/exec/keypair.js';
import { loadConfig } from '../src/config.js';

interface OperatorRecord {
  operatorAddress: string;
  managerId: string;
}

function parseArgs(): { amount?: number; all: boolean } {
  const args: { amount?: number; all: boolean } = { all: false };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--all') args.all = true;
    else if (process.argv[i] === '--amount') args.amount = Number(process.argv[++i]);
  }
  return args;
}

async function main(): Promise<void> {
  assertAddressesPinned();
  const cfg = loadConfig();
  const args = parseArgs();
  if (!args.all && (args.amount === undefined || !isFinite(args.amount) || args.amount <= 0)) {
    throw new Error('required: --amount <dUSDC> OR --all');
  }

  const operatorFile = path.join(path.resolve(cfg.dataDir), 'operator.json');
  if (!fs.existsSync(operatorFile)) throw new Error(`no ${operatorFile}; run setup-manager first`);
  const op = JSON.parse(fs.readFileSync(operatorFile, 'utf8')) as OperatorRecord;

  const { keypair, address } = loadOperatorKey();
  if (address.toLowerCase() !== op.operatorAddress.toLowerCase()) {
    throw new Error(`active address ${address} != operator.json ${op.operatorAddress}`);
  }

  const sui = new SuiClient({ url: ADDRESSES.rpcUrl });

  // Read the manager's current dUSDC balance via dev-inspect of
  // predict_manager::balance<DUSDC>(manager).
  const managerBalanceRaw = await readManagerBalance(sui, op.managerId, address);
  const managerBalanceDusdc = Number(managerBalanceRaw) / Number(QUOTE_UNIT);
  console.log(
    JSON.stringify({
      msg: 'withdraw.start',
      managerId: op.managerId,
      currentManagerBalance: managerBalanceDusdc,
    }),
  );

  if (managerBalanceRaw === 0n) {
    console.log(JSON.stringify({ msg: 'withdraw.empty', hint: 'nothing to withdraw' }));
    return;
  }

  const requestedRaw = args.all
    ? managerBalanceRaw
    : BigInt(Math.round(args.amount! * Number(QUOTE_UNIT)));

  if (requestedRaw > managerBalanceRaw) {
    throw new Error(
      `requested ${args.amount} dUSDC but manager only has ${managerBalanceDusdc.toFixed(6)}`,
    );
  }

  const tx = new Transaction();
  const coin = tx.moveCall({
    target: `${ADDRESSES.packageId}::predict_manager::withdraw`,
    typeArguments: [ADDRESSES.dusdcType],
    arguments: [tx.object(op.managerId), tx.pure.u64(requestedRaw)],
  });
  tx.transferObjects([coin], tx.pure.address(address));

  const result = await sui.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true },
  });
  console.log(
    JSON.stringify({
      msg: 'withdraw.tx_submitted',
      digest: result.digest,
      status: result.effects?.status?.status,
      withdrawn: Number(requestedRaw) / Number(QUOTE_UNIT),
    }),
  );
  if (result.effects?.status?.status !== 'success') {
    console.error(JSON.stringify({ msg: 'withdraw.tx_failed', effects: result.effects }));
    process.exit(1);
  }
}

/** Dev-inspect `predict_manager::balance<DUSDC>(manager)` to read the current manager balance. */
async function readManagerBalance(
  sui: SuiClient,
  managerId: string,
  sender: string,
): Promise<bigint> {
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
  if (!ret) return 0n;
  // returnValues[0] is [bytes[], type]. bytes is u64 little-endian.
  const bytes = ret[0] as number[];
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i]!);
  }
  return v;
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: 'withdraw.fatal', err: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
