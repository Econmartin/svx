/**
 * Wrap USDC.e -> pUSD via the Polymarket Collateral Onramp on POLYGON MAINNET.
 *
 * This script is mainnet-only — the onramp doesn't exist on Amoy, and the
 * canonical USDC.e contract address is mainnet-only too. We hardcode the
 * Polygon mainnet RPC and contract addresses so it can't accidentally run
 * against Amoy / a wrong network.
 *
 * Two-step process (standard ERC20 approval pattern):
 *   1. Approve the onramp to spend our USDC.e (only if current allowance < amount)
 *   2. Call onramp.wrap(USDC.e, our address, amount) — burns USDC.e, mints pUSD
 *
 * Defaults to DRY-RUN: prints what would happen without sending anything.
 * Pass --confirm to actually submit the transactions.
 *
 * Usage (from repo root):
 *   pnpm --filter svx-bot wrap-usdce-to-pusd -- --amount=5
 *   pnpm --filter svx-bot wrap-usdce-to-pusd -- --amount=5 --confirm
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

// Polygon mainnet addresses — verified on polygonscan 2026-05-10:
//   USDC.e   — 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 (canonical bridged USDC)
//   pUSD     — 0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB (Polymarket collateral)
//   Onramp   — 0x93070a847efEf7F70739046A929D47a521F5B8ee (Polymarket: Deployer 1)
const USDCE: Address = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const PUSD: Address = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const ONRAMP: Address = '0x93070a847efEf7F70739046A929D47a521F5B8ee';
const USDC_DECIMALS = 6;

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const ONRAMP_ABI = parseAbi([
  'function wrap(address _asset, address _to, uint256 _amount)',
]);

interface Args {
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
    if (k === 'amount') {
      const n = Number(v);
      if (!isFinite(n) || n <= 0) throw new Error(`--amount must be a positive number (got ${v})`);
      out.amount = n;
    }
  }
  if (out.amount == null) {
    throw new Error('--amount=<usdce> is required (e.g. --amount=5 to wrap 5 USDC.e)');
  }
  return out as Args;
}

function fmtUsdc(raw: bigint): string {
  return Number(formatUnits(raw, USDC_DECIMALS)).toFixed(USDC_DECIMALS);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadConfig(); // populates process.env from .env

  const pk = process.env.POLY_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk.trim())) {
    throw new Error('POLY_PRIVATE_KEY missing or malformed in .env');
  }

  const account = privateKeyToAccount(pk.trim() as `0x${string}`);
  const rpcUrl = process.env.POLY_RPC_URL_MAINNET ?? 'https://polygon-bor.publicnode.com';
  const publicClient = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(rpcUrl) });

  // Network sanity: confirm the RPC is actually Polygon mainnet.
  const chainId = await publicClient.getChainId();
  if (chainId !== 137) {
    throw new Error(`Expected chainId 137 (Polygon mainnet), got ${chainId}. Wrong RPC?`);
  }

  // Confirm the onramp address actually has bytecode (not an EOA / typo).
  const code = await publicClient.getCode({ address: ONRAMP });
  if (!code || code === '0x') {
    throw new Error(`No contract code at onramp address ${ONRAMP}. Refusing to send funds to an EOA.`);
  }

  const amountRaw = parseUnits(args.amount.toString(), USDC_DECIMALS);

  // Read current state.
  const [usdceBalance, pusdBalance, allowance, gasWei] = await Promise.all([
    publicClient.readContract({
      address: USDCE,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    }),
    publicClient.readContract({
      address: PUSD,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    }),
    publicClient.readContract({
      address: USDCE,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, ONRAMP],
    }),
    publicClient.getBalance({ address: account.address }),
  ]);

  const needsApproval = allowance < amountRaw;
  const sufficientBalance = usdceBalance >= amountRaw;
  const sufficientGas = gasWei > parseUnits('0.05', 18); // ~$0.01 worth, generous

  console.log(
    JSON.stringify(
      {
        msg: 'wrap.plan',
        chain: 'Polygon mainnet (137)',
        operator: account.address,
        amount_usdce: args.amount,
        amount_raw: amountRaw.toString(),
        usdce_balance: fmtUsdc(usdceBalance),
        pusd_balance_before: fmtUsdc(pusdBalance),
        current_allowance: fmtUsdc(allowance),
        gas_pol: Number(formatUnits(gasWei, 18)),
        needs_approval: needsApproval,
        sufficient_balance: sufficientBalance,
        sufficient_gas: sufficientGas,
        onramp: ONRAMP,
        usdce: USDCE,
        pusd: PUSD,
      },
      null,
      2,
    ),
  );

  if (!sufficientBalance) {
    throw new Error(
      `Insufficient USDC.e: have ${fmtUsdc(usdceBalance)}, need ${args.amount}`,
    );
  }
  if (!sufficientGas) {
    throw new Error(
      `Insufficient POL for gas: have ${formatUnits(gasWei, 18)}. Top up the wallet.`,
    );
  }

  if (!args.confirm) {
    console.log(
      JSON.stringify({
        msg: 'wrap.dry_run',
        plan: needsApproval
          ? `would APPROVE ${args.amount} USDC.e to onramp, then WRAP ${args.amount} USDC.e -> pUSD`
          : `allowance already sufficient — would WRAP ${args.amount} USDC.e -> pUSD`,
        hint: 're-run with --confirm to submit',
      }),
    );
    return;
  }

  // === EXECUTION ===
  if (needsApproval) {
    console.log(JSON.stringify({ msg: 'wrap.approve.submit', amount_usdce: args.amount }));
    const approveTx = await walletClient.writeContract({
      address: USDCE,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [ONRAMP, amountRaw],
    });
    console.log(JSON.stringify({ msg: 'wrap.approve.tx', hash: approveTx }));
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log(
      JSON.stringify({
        msg: 'wrap.approve.confirmed',
        block: Number(approveReceipt.blockNumber),
        status: approveReceipt.status,
      }),
    );
    if (approveReceipt.status !== 'success') {
      throw new Error(`approve() reverted in tx ${approveTx}`);
    }
  } else {
    console.log(JSON.stringify({ msg: 'wrap.approve.skipped', reason: 'allowance already sufficient' }));
  }

  console.log(
    JSON.stringify({
      msg: 'wrap.wrap.submit',
      asset: USDCE,
      to: account.address,
      amount_usdce: args.amount,
    }),
  );
  const wrapTx = await walletClient.writeContract({
    address: ONRAMP,
    abi: ONRAMP_ABI,
    functionName: 'wrap',
    args: [USDCE, account.address, amountRaw],
  });
  console.log(JSON.stringify({ msg: 'wrap.wrap.tx', hash: wrapTx }));
  const wrapReceipt = await publicClient.waitForTransactionReceipt({ hash: wrapTx });
  console.log(
    JSON.stringify({
      msg: 'wrap.wrap.confirmed',
      block: Number(wrapReceipt.blockNumber),
      status: wrapReceipt.status,
    }),
  );
  if (wrapReceipt.status !== 'success') {
    throw new Error(`wrap() reverted in tx ${wrapTx}`);
  }

  // Final balance read for confirmation. Anchor to the wrap tx's block so
  // load-balanced public RPCs can't return a stale snapshot (1-block-behind
  // node would show 0 pUSD even though the mint already happened).
  const [usdceAfter, pusdAfter] = await Promise.all([
    publicClient.readContract({
      address: USDCE,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
      blockNumber: wrapReceipt.blockNumber,
    }),
    publicClient.readContract({
      address: PUSD,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
      blockNumber: wrapReceipt.blockNumber,
    }),
  ]);

  console.log(
    JSON.stringify(
      {
        msg: 'wrap.done',
        usdce_balance_after: fmtUsdc(usdceAfter),
        pusd_balance_after: fmtUsdc(pusdAfter),
        approve_tx: needsApproval ? `https://polygonscan.com/tx/${'<see above>'}` : null,
        wrap_tx: `https://polygonscan.com/tx/${wrapTx}`,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(
    JSON.stringify({ msg: 'wrap.fatal', err: e instanceof Error ? e.message : String(e) }),
  );
  process.exit(1);
});
