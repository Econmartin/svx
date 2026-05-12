/**
 * Send pUSD from the operator's EOA to their Polymarket Safe proxy.
 *
 * When Polymarket's CLOB rejects orders with "maker address not allowed,
 * please use the deposit wallet flow", the fix is:
 *   1. Visit polymarket.com behind Ireland VPN with the EOA connected.
 *      This auto-deploys a Gnosis Safe proxy + tells you its address.
 *   2. Move pUSD from the EOA into the proxy (this script).
 *   3. Update Coolify env:
 *        MAINNET_POLY_FUNDER_ADDRESS=<proxy_address>
 *        MAINNET_POLY_SIGNATURE_TYPE=POLY_GNOSIS_SAFE
 *      Restart the service.
 *
 * Defaults to DRY-RUN. Pass --confirm to submit the transfer.
 *
 * Usage:
 *   pnpm --filter svx-bot send-pusd-to-proxy -- --to=0xPROXY --amount=10
 *   pnpm --filter svx-bot send-pusd-to-proxy -- --to=0xPROXY --amount=10 --confirm
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  parseAbi,
  type Address,
} from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.js';

const PUSD: Address = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const USDC_DECIMALS = 6;

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address recipient, uint256 amount) returns (bool)',
]);

interface Args {
  to: Address;
  amount: number;
  confirm: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { confirm: false };
  for (const raw of argv) {
    const a = raw.startsWith('--') ? raw.slice(2) : raw;
    if (a === 'confirm') {
      out.confirm = true;
      continue;
    }
    const [k, v] = a.split('=', 2);
    if (k === 'to') {
      if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v))
        throw new Error(`--to must be a 0x EVM address (got "${v ?? ''}")`);
      out.to = v as Address;
    }
    if (k === 'amount') {
      const n = Number(v);
      if (!isFinite(n) || n <= 0) throw new Error(`--amount must be positive (got ${v})`);
      out.amount = n;
    }
  }
  if (!out.to) throw new Error('--to=0x<proxy address> is required');
  if (out.amount == null) throw new Error('--amount=<pUSD amount> is required (e.g. --amount=10)');
  return out as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadConfig();

  const pk = process.env.POLY_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk.trim()))
    throw new Error('POLY_PRIVATE_KEY missing or malformed in env');

  const account = privateKeyToAccount(pk.trim() as `0x${string}`);
  const rpcUrl = process.env.POLY_RPC_URL_MAINNET ?? 'https://polygon-bor.publicnode.com';
  const publicClient = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(rpcUrl) });

  if (account.address.toLowerCase() === args.to.toLowerCase()) {
    throw new Error('--to is the SAME as the EOA address. Transfer would be a no-op.');
  }

  const chainId = await publicClient.getChainId();
  if (chainId !== 137) throw new Error(`Expected Polygon mainnet (137), got chainId ${chainId}`);

  const amountRaw = parseUnits(args.amount.toString(), USDC_DECIMALS);
  const [eoaBalance, proxyBalance, gasWei] = await Promise.all([
    publicClient.readContract({
      address: PUSD,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    }),
    publicClient.readContract({
      address: PUSD,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [args.to],
    }),
    publicClient.getBalance({ address: account.address }),
  ]);

  console.log(
    JSON.stringify(
      {
        msg: 'send_pusd.plan',
        from: account.address,
        to: args.to,
        amount_pusd: args.amount,
        amount_raw: amountRaw.toString(),
        eoa_balance_before: Number(formatUnits(eoaBalance, USDC_DECIMALS)),
        proxy_balance_before: Number(formatUnits(proxyBalance, USDC_DECIMALS)),
        eoa_pol_gas: Number(formatUnits(gasWei, 18)),
      },
      null,
      2,
    ),
  );

  if (eoaBalance < amountRaw) {
    throw new Error(
      `EOA pUSD balance ${formatUnits(eoaBalance, USDC_DECIMALS)} < requested ${args.amount}`,
    );
  }
  if (gasWei < parseUnits('0.05', 18)) {
    throw new Error(`EOA POL balance too low for gas: ${formatUnits(gasWei, 18)}. Need ≥ 0.05.`);
  }

  if (!args.confirm) {
    console.log(
      JSON.stringify({
        msg: 'send_pusd.dry_run',
        plan: `Would transfer ${args.amount} pUSD from EOA → proxy. Re-run with --confirm to submit.`,
      }),
    );
    return;
  }

  console.log(JSON.stringify({ msg: 'send_pusd.submit', from: account.address, to: args.to, amount: args.amount }));
  const tx = await walletClient.writeContract({
    address: PUSD,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [args.to, amountRaw],
  });
  console.log(JSON.stringify({ msg: 'send_pusd.tx', hash: tx }));
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== 'success') {
    throw new Error(`transfer reverted in tx ${tx}`);
  }

  const [eoaAfter, proxyAfter] = await Promise.all([
    publicClient.readContract({
      address: PUSD,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
      blockNumber: receipt.blockNumber,
    }),
    publicClient.readContract({
      address: PUSD,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [args.to],
      blockNumber: receipt.blockNumber,
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        msg: 'send_pusd.done',
        eoa_balance_after: Number(formatUnits(eoaAfter, USDC_DECIMALS)),
        proxy_balance_after: Number(formatUnits(proxyAfter, USDC_DECIMALS)),
        tx_url: `https://polygonscan.com/tx/${tx}`,
        next_steps: [
          `Set MAINNET_POLY_FUNDER_ADDRESS=${args.to} in Coolify`,
          'Set MAINNET_POLY_SIGNATURE_TYPE=POLY_GNOSIS_SAFE in Coolify',
          'Save → bot-mainnet restarts → next signal fires through the proxy',
        ],
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(
    JSON.stringify({ msg: 'send_pusd.fatal', err: e instanceof Error ? e.message : String(e) }),
  );
  process.exit(1);
});
