/**
 * One-time setup: create a PredictManager owned by the operator address and
 * persist its ID to `data/operator.json`.
 *
 * Usage (from repo root): pnpm --filter svx-bot setup-manager
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
import { loadOperatorKey } from '../src/exec/keypair.js';
import { loadConfig } from '../src/config.js';

async function main(): Promise<void> {
  assertAddressesPinned();
  const cfg = loadConfig();
  const { keypair, address } = loadOperatorKey();
  const sui = new SuiClient({ url: ADDRESSES.rpcUrl });

  console.log(JSON.stringify({ msg: 'setup.start', address, network: ADDRESSES.rpcUrl }));

  const balances = await sui.getBalance({ owner: address, coinType: ADDRESSES.dusdcType });
  console.log(JSON.stringify({ msg: 'setup.dusdc_balance', balance: balances.totalBalance }));

  // Refuse to proceed if there's already a manager record on disk — the user
  // probably ran this by mistake.
  const dataDir = path.resolve(cfg.dataDir);
  const operatorFile = path.join(dataDir, 'operator.json');
  if (fs.existsSync(operatorFile)) {
    const existing = JSON.parse(fs.readFileSync(operatorFile, 'utf8'));
    console.log(
      JSON.stringify({
        msg: 'setup.already_exists',
        managerId: existing.managerId,
        operatorFile,
        hint: 'Delete data/operator.json to re-create.',
      }),
    );
    return;
  }

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
    console.error(
      JSON.stringify({ msg: 'setup.tx_failed', effects: result.effects, digest: result.digest }),
    );
    process.exit(1);
  }

  const managerChange = (result.objectChanges ?? []).find(
    (c) => c.type === 'created' && c.objectType.endsWith('::predict_manager::PredictManager'),
  );
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
    network: ADDRESSES.rpcUrl,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(operatorFile, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ msg: 'setup.persisted', file: operatorFile }));
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: 'setup.fatal', err: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
