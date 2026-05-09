/**
 * Redeem a position from the manager. Works for both pre-expiry (live ask
 * price) and post-settlement (full payout if won, 0 if lost).
 *
 * Usage:
 *   pnpm --filter svx-bot redeem -- \
 *     --oracle 0x7a4e...6d9 \
 *     --strike 80297 \
 *     --direction up \
 *     --quantity 0.5
 */

import path from 'node:path';
import fs from 'node:fs';
import { SuiClient } from '@mysten/sui/client';
import { ADDRESSES, assertAddressesPinned } from 'svx-shared/addresses';
import { loadOperatorKey } from '../src/exec/keypair.js';
import { loadConfig } from '../src/config.js';
import { PredictClient } from '../src/pricing/predict.js';
import { buildRedeemTx } from '../src/exec/ptb.js';
import { submitTx } from '../src/exec/submit.js';

interface OperatorRecord {
  operatorAddress: string;
  managerId: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  assertAddressesPinned();
  const cfg = loadConfig();
  const oracleId = arg('oracle');
  const strike = Number(arg('strike'));
  const direction = (arg('direction', 'up') === 'down' ? 'down' : 'up') as 'up' | 'down';
  const quantity = Number(arg('quantity'));
  if (!oracleId || !isFinite(strike) || !isFinite(quantity) || quantity <= 0) {
    throw new Error('required flags: --oracle <id> --strike <usd> --direction up|down --quantity <dusdc>');
  }

  const operatorFile = path.join(path.resolve(cfg.dataDir), 'operator.json');
  if (!fs.existsSync(operatorFile)) throw new Error(`no ${operatorFile}`);
  const op = JSON.parse(fs.readFileSync(operatorFile, 'utf8')) as OperatorRecord;
  const { keypair } = loadOperatorKey();
  const sui = new SuiClient({ url: ADDRESSES.rpcUrl });

  const predict = new PredictClient();
  const oracleSummary = (await predict.listOracles(true)).find((o) => o.oracleId === oracleId);
  if (!oracleSummary) throw new Error(`oracle ${oracleId} not found`);

  // Use redeem_permissionless if settled, regular redeem otherwise.
  const permissionless = oracleSummary.status === 'settled';

  console.log(
    JSON.stringify({
      msg: 'redeem.start',
      oracleId,
      expiryMs: oracleSummary.expiryMs,
      settled: oracleSummary.status === 'settled',
      settlementPrice: oracleSummary.settlementPrice,
      strike,
      direction,
      quantity,
      permissionless,
    }),
  );

  const tx = buildRedeemTx({
    oracleId,
    expiryMs: oracleSummary.expiryMs,
    strike,
    direction,
    quantityDusdc: quantity,
    managerId: op.managerId,
    permissionless,
  });

  const result = await submitTx(sui, tx, keypair);
  console.log(JSON.stringify({ msg: 'redeem.result', ok: result.ok, digest: result.digest, status: result.status, error: result.error }));
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: 'redeem.fatal', err: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
