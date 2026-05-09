/**
 * One-time setup: create a PredictManager owned by the operator address and
 * (optionally) deposit initial dUSDC.
 *
 * Usage:
 *   pnpm tsx scripts/setup-manager.ts
 *
 * Side effects:
 *   - Submits a tx that calls `predict::create_manager`.
 *   - Writes the resulting manager_id to `data/operator.json`.
 *
 * Prereqs:
 *   - Operator address has SUI for gas.
 *   - PREDICT_PACKAGE_ID etc. are pinned in svx-shared/addresses.ts.
 *   - For deposit: operator owns dUSDC (testnet faucet at https://tally.so/r/nrXOyL).
 */

import path from 'node:path';
import fs from 'node:fs';
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { ADDRESSES, assertAddressesPinned } from 'svx-shared/addresses';
import { loadOperatorKey } from '../packages/svx-bot/src/exec/keypair.js';
import { loadConfig } from '../packages/svx-bot/src/config.js';

async function main(): Promise<void> {
  assertAddressesPinned();
  const cfg = loadConfig();
  const { keypair, address } = loadOperatorKey();
  const sui = new SuiClient({ url: ADDRESSES.rpcUrl });

  console.log(JSON.stringify({ msg: 'setup.start', address, network: ADDRESSES.rpcUrl }));

  // dUSDC presence check.
  const balances = await sui.getBalance({ owner: address, coinType: ADDRESSES.dusdcType });
  console.log(JSON.stringify({ msg: 'setup.dusdc_balance', balance: balances.totalBalance }));

  // Build create_manager tx.
  const tx = new Transaction();
  tx.moveCall({
    target: `${ADDRESSES.packageId}::predict::create_manager`,
    arguments: [],
  });

  const result = await sui.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEffects: true, showObjectChanges: true },
  });
  console.log(JSON.stringify({ msg: 'setup.tx_submitted', digest: result.digest }));
  if (result.effects?.status?.status !== 'success') {
    console.error(JSON.stringify({ msg: 'setup.tx_failed', effects: result.effects }));
    process.exit(1);
  }

  // Find the new PredictManager from the object changes.
  const managerChange = (result.objectChanges ?? []).find((c) => {
    if (c.type !== 'created') return false;
    return c.objectType.endsWith('::predict_manager::PredictManager');
  });
  if (!managerChange || managerChange.type !== 'created') {
    console.error(JSON.stringify({ msg: 'setup.no_manager_found', changes: result.objectChanges }));
    process.exit(1);
  }
  const managerId = managerChange.objectId;
  console.log(JSON.stringify({ msg: 'setup.manager_created', managerId }));

  const out = {
    operatorAddress: address,
    managerId,
    createdAtMs: Date.now(),
    txDigest: result.digest,
  };
  const dataDir = path.resolve(cfg.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'operator.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ msg: 'setup.persisted', file }));
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: 'setup.fatal', err: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
