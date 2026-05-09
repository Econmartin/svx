/**
 * Inspect on-chain manager state — list owned positions and their fair values.
 *
 * Usage: pnpm --filter svx-bot inspect-position
 */

import path from 'node:path';
import fs from 'node:fs';
import { SuiClient } from '@mysten/sui/client';
import { ADDRESSES, assertAddressesPinned } from 'svx-shared/addresses';
import { loadConfig } from '../src/config.js';

interface OperatorRecord {
  operatorAddress: string;
  managerId: string;
}

async function main(): Promise<void> {
  assertAddressesPinned();
  const cfg = loadConfig();
  const operatorFile = path.join(path.resolve(cfg.dataDir), 'operator.json');
  if (!fs.existsSync(operatorFile)) throw new Error(`no ${operatorFile}`);
  const op = JSON.parse(fs.readFileSync(operatorFile, 'utf8')) as OperatorRecord;

  const sui = new SuiClient({ url: ADDRESSES.rpcUrl });

  // Read the manager object's dynamic fields (positions Table).
  const fields = await sui.getDynamicFields({ parentId: op.managerId });
  console.log(JSON.stringify({ msg: 'inspect.parent', managerId: op.managerId, fieldCount: fields.data.length }));

  // The PredictManager has an inner BalanceManager + positions Table.
  // For a quick scan, fetch the manager object and dump its content.
  const obj = await sui.getObject({
    id: op.managerId,
    options: { showContent: true, showType: true },
  });
  const content = obj.data?.content;
  if (content && 'fields' in content) {
    const f = content.fields as Record<string, unknown>;
    console.log(
      JSON.stringify({
        msg: 'inspect.manager',
        owner: f.owner,
        positionsTable: (f.positions as { fields?: { id?: { id: string }; size: string } } | undefined)?.fields,
        rangePositionsTable: (f.range_positions as { fields?: { id?: { id: string }; size: string } } | undefined)?.fields,
      }),
    );
  }

  // Walk dynamic fields on the positions Table, if any.
  for (const fld of fields.data) {
    console.log(JSON.stringify({ msg: 'inspect.field', objectType: fld.objectType, name: fld.name }));
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ msg: 'inspect.fatal', err: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
