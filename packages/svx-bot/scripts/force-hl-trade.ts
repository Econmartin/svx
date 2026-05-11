/**
 * Force-trade a single Hyperliquid BTC perp — bug-flush utility, NOT
 * called by the live bot loop.
 *
 * Defaults to a tiny size (0.0001 BTC, ~$8 at current prices) and dry-run.
 * Refuses sizes > 0.001 BTC without `--i-know-what-im-doing`. Refuses any
 * `--confirm` invocation without `--side` specified explicitly to prevent
 * fat-finger direction errors.
 *
 * Usage:
 *   # Dry run a short open + close (no orders sent)
 *   pnpm --filter svx-bot force-hl-trade -- --size=0.0001 --side=short --dry-run
 *   # Execute (open only)
 *   pnpm --filter svx-bot force-hl-trade -- --size=0.0001 --side=short --confirm
 *   # Open + immediately close (round-trip test)
 *   pnpm --filter svx-bot force-hl-trade -- --size=0.0001 --side=short --confirm --round-trip
 */

import { loadConfig } from '../src/config.js';
import { HyperliquidExecClient } from '../src/exec/hyperliquid-client.js';

interface Args {
  size: number;
  side?: 'long' | 'short';
  confirm: boolean;
  dryRun: boolean;
  roundTrip: boolean;
  iKnow: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    size: 0.0001,
    confirm: false,
    dryRun: false,
    roundTrip: false,
    iKnow: false,
  };
  for (const raw of argv) {
    const a = raw.startsWith('--') ? raw.slice(2) : raw;
    if (a === 'confirm') {
      out.confirm = true;
      continue;
    }
    if (a === 'dry-run') {
      out.dryRun = true;
      continue;
    }
    if (a === 'round-trip') {
      out.roundTrip = true;
      continue;
    }
    if (a === 'i-know-what-im-doing') {
      out.iKnow = true;
      continue;
    }
    const [k, v] = a.split('=', 2);
    if (k === 'size') {
      const n = Number(v);
      if (!isFinite(n) || n <= 0) throw new Error(`--size must be positive (got ${v})`);
      out.size = n;
    } else if (k === 'side') {
      if (v !== 'long' && v !== 'short') throw new Error(`--side must be long or short (got ${v})`);
      out.side = v;
    }
  }
  return out as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadConfig();

  if (args.confirm && !args.side) {
    throw new Error('`--side=long|short` is required with --confirm to avoid fat-fingering direction');
  }
  if (args.size > 0.001 && !args.iKnow) {
    throw new Error(`Refusing size ${args.size} BTC without --i-know-what-im-doing (default cap 0.001 BTC ≈ $80)`);
  }

  const client = new HyperliquidExecClient();
  const [balance, mid] = await Promise.all([client.getBalance(), client.getMid('BTC')]);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      msg: 'force_hl.plan',
      address: client.address,
      network: client.endpoints.network,
      accountValueUsdc: balance.accountValueUsdc,
      withdrawableUsdc: balance.withdrawableUsdc,
      mid,
      size_btc: args.size,
      side: args.side ?? '(dry-run, no side required)',
      usd_notional: args.size * mid,
      round_trip: args.roundTrip,
      confirm: args.confirm,
    }),
  );

  if (args.dryRun || !args.confirm) {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        msg: 'force_hl.dry_run_ok',
        hint: 'Re-run with --confirm --side=long|short to submit.',
      }),
    );
    return;
  }

  const openFill = await client.openMarketPerp({ side: args.side!, size: args.size });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg: 'force_hl.open.ok', fill: openFill }));

  if (args.roundTrip) {
    const closeFill = await client.closeMarketPerp({
      originalSide: args.side!,
      size: openFill.filledSize || args.size,
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ msg: 'force_hl.close.ok', fill: closeFill }));
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      msg: 'force_hl.fatal',
      err: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    }),
  );
  process.exit(1);
});
