/**
 * Bug-flush helper: build and submit ONE tiny mint tx, ignoring threshold and
 * Polymarket entirely. Picks the soonest-expiring active BTC oracle and the
 * at-the-money UP strike (rounded to grid).
 *
 * Defaults:
 *   --quantity 0.5        max payout in dUSDC
 *   --direction up        UP or DOWN
 *
 * Usage:
 *   pnpm --filter svx-bot force-mint
 *   pnpm --filter svx-bot force-mint -- --quantity 0.2 --direction down
 *
 * Refuses to run if quantity > 1 (sanity guard for bug-flush use). Override
 * with --i-know-what-im-doing.
 */

import path from 'node:path';
import fs from 'node:fs';
import { SuiClient } from '@mysten/sui/client';
import { ADDRESSES, assertAddressesPinned } from 'svx-shared/addresses';
import { loadOperatorKey } from '../src/exec/keypair.js';
import { loadConfig } from '../src/config.js';
import { PredictClient } from '../src/pricing/predict.js';
import { buildMintTx } from '../src/exec/ptb.js';
import { submitTx } from '../src/exec/submit.js';

interface OperatorRecord {
  operatorAddress: string;
  managerId: string;
}

function arg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

async function main(): Promise<void> {
  assertAddressesPinned();
  const cfg = loadConfig();
  const quantity = Number(arg('quantity', '0.5'));
  const direction = (arg('direction', 'up') === 'down' ? 'down' : 'up') as 'up' | 'down';
  const allowLarge = process.argv.includes('--i-know-what-im-doing');

  if (!isFinite(quantity) || quantity <= 0) throw new Error(`bad --quantity: ${quantity}`);
  if (!allowLarge && quantity > 1) {
    throw new Error(
      `--quantity ${quantity} > $1 sanity cap; pass --i-know-what-im-doing to override`,
    );
  }

  const operatorFile = path.join(path.resolve(cfg.dataDir), 'operator.json');
  if (!fs.existsSync(operatorFile)) throw new Error(`no ${operatorFile}; run setup-manager first`);
  const op = JSON.parse(fs.readFileSync(operatorFile, 'utf8')) as OperatorRecord;

  const { keypair, address } = loadOperatorKey();
  if (address.toLowerCase() !== op.operatorAddress.toLowerCase()) {
    throw new Error(`active address ${address} != operator.json ${op.operatorAddress}`);
  }

  const sui = new SuiClient({ url: ADDRESSES.rpcUrl });
  const predict = new PredictClient();

  // Pick soonest-expiring active BTC oracle that is past activation cooldown.
  const oracles = await predict.listActiveOracles('BTC');
  if (oracles.length === 0) throw new Error('no active BTC oracles');
  // Skip oracles that expire in under 90 seconds — too close to settlement.
  const now = Date.now();
  const usable = oracles.find((o) => o.expiryMs - now > 90_000);
  if (!usable) throw new Error('no oracles with > 90s to expiry; try again');
  const snap = await predict.snapshotOracle(usable.oracleId);
  if (!snap) throw new Error('failed to snapshot oracle');

  // Pick at-the-money strike rounded to tick.
  const F = snap.forward;
  const tickFromMin = Math.round((F - usable.minStrike) / usable.tickSize);
  const strike = usable.minStrike + tickFromMin * usable.tickSize;

  // Get the coin objects to top up from.
  const coins = await sui.getCoins({ owner: address, coinType: ADDRESSES.dusdcType });
  if (coins.data.length === 0) throw new Error('no dUSDC in wallet');

  console.log(
    JSON.stringify({
      msg: 'force-mint.start',
      oracle: usable.oracleId,
      expiryMs: usable.expiryMs,
      msToExpiry: usable.expiryMs - now,
      forward: F,
      strike,
      quantityDusdc: quantity,
      direction,
      managerId: op.managerId,
    }),
  );

  const tx = buildMintTx({
    oracleId: usable.oracleId,
    expiryMs: usable.expiryMs,
    strike,
    direction,
    quantityDusdc: quantity,
    managerId: op.managerId,
    topUpDusdc: quantity, // top up the full notional — overshoots cost, refunded on next interaction
    dusdcCoinObjectIds: coins.data.map((c) => c.coinObjectId),
  });

  const result = await submitTx(sui, tx, keypair);
  console.log(JSON.stringify({ msg: 'force-mint.result', ok: result.ok, digest: result.digest, status: result.status, error: result.error }));
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: 'force-mint.fatal', err: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
