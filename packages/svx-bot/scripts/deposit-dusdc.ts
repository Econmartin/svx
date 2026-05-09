/**
 * Deposit dUSDC from the operator's wallet into the PredictManager so the bot
 * has spending balance.
 *
 * Usage: pnpm --filter svx-bot deposit-dusdc -- --amount 200
 *   amount is in dUSDC (the script scales by 1e6).
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

function parseArg(name: string, fallback: number): number {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  const n = Number(process.argv[idx + 1]);
  return isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  assertAddressesPinned();
  const cfg = loadConfig();
  const operatorFile = path.join(path.resolve(cfg.dataDir), 'operator.json');
  if (!fs.existsSync(operatorFile)) {
    console.error(JSON.stringify({ msg: 'deposit.no_operator', file: operatorFile, hint: 'run setup-manager first' }));
    process.exit(1);
  }
  const op = JSON.parse(fs.readFileSync(operatorFile, 'utf8')) as OperatorRecord;

  const amountDusdc = parseArg('amount', 200);
  const amountUnits = BigInt(Math.round(amountDusdc * Number(QUOTE_UNIT)));

  const { keypair, address } = loadOperatorKey();
  if (address.toLowerCase() !== op.operatorAddress.toLowerCase()) {
    console.error(
      JSON.stringify({
        msg: 'deposit.address_mismatch',
        loaded: address,
        expected: op.operatorAddress,
        hint: 'sui client switch --address <correct>',
      }),
    );
    process.exit(1);
  }

  const sui = new SuiClient({ url: ADDRESSES.rpcUrl });

  // Find dUSDC coin objects we own.
  const coins = await sui.getCoins({ owner: address, coinType: ADDRESSES.dusdcType });
  const total = coins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
  console.log(
    JSON.stringify({
      msg: 'deposit.start',
      address,
      managerId: op.managerId,
      amountDusdc,
      amountUnits: amountUnits.toString(),
      walletDusdc: Number(total) / Number(QUOTE_UNIT),
      coinObjects: coins.data.length,
    }),
  );
  if (total < amountUnits) {
    console.error(JSON.stringify({ msg: 'deposit.insufficient', wallet: total.toString(), needed: amountUnits.toString() }));
    process.exit(1);
  }

  const tx = new Transaction();
  // Merge all coin objects into the first (idempotent: noop if only one).
  const [primary, ...rest] = coins.data;
  if (!primary) throw new Error('unreachable');
  const primaryRef = tx.object(primary.coinObjectId);
  if (rest.length > 0) {
    tx.mergeCoins(primaryRef, rest.map((c) => tx.object(c.coinObjectId)));
  }
  const [depositCoin] = tx.splitCoins(primaryRef, [amountUnits]);
  tx.moveCall({
    target: `${ADDRESSES.packageId}::predict_manager::deposit`,
    typeArguments: [ADDRESSES.dusdcType],
    arguments: [tx.object(op.managerId), depositCoin],
  });

  const result = await sui.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true },
  });
  console.log(JSON.stringify({ msg: 'deposit.tx_submitted', digest: result.digest, status: result.effects?.status?.status }));
  if (result.effects?.status?.status !== 'success') {
    console.error(JSON.stringify({ msg: 'deposit.tx_failed', effects: result.effects }));
    process.exit(1);
  }

  // Verify post-deposit balance via the on-chain BalanceManager.
  // Easiest path: read the manager object dynamic fields. For now just print success.
  console.log(JSON.stringify({ msg: 'deposit.done', amountDusdc, managerId: op.managerId }));
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: 'deposit.fatal', err: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
