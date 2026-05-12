/**
 * Polymarket execution client — wraps @polymarket/clob-client-v2 with the
 * higher-level helpers we need: API-cred bootstrap, balance read, market
 * order placement, and a small order-book sanity check that mirrors our
 * pricing-side reader.
 *
 * Trades are signed by the L1 EVM key (SignatureTypeV2.EOA) with the same
 * address as the funder — no proxy / Gnosis Safe derivation required in V2.
 *
 * Uses pUSD as the collateral asset (per Polymarket V2 contract config). The
 * collateral address is the same on Polygon mainnet and Amoy testnet:
 *   0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB
 */

import fs from 'node:fs';
import {
  ClobClient,
  Chain,
  OrderType,
  Side,
  SignatureTypeV2,
  getContractConfig,
  type ApiKeyCreds,
  type OrderBookSummary,
} from '@polymarket/clob-client-v2';
import { createPublicClient, http, parseAbi, parseUnits, type Address } from 'viem';
import { polygon, polygonAmoy } from 'viem/chains';
import type { SvxConfig } from '../config.js';
import { dataPath } from '../config.js';
import { log } from '../util/log.js';
import {
  loadPolyOperatorKey,
  derivePolyEndpoints,
  type PolyEndpoints,
} from './polymarket-keypair.js';

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

/**
 * Polymarket multi-strike events (e.g. "Bitcoin above $80k/$82k/$84k on
 * May 11") are NegRisk markets. Redemption goes through the NegRiskAdapter,
 * which combines the per-strike conditional tokens and pays out pUSD 1:1
 * for winning shares.
 *
 * Standard CTF (`ConditionalTokens.redeemPositions`) is the fallback for
 * non-NegRisk markets. The signatures differ — we choose at call time based
 * on the `negRisk` flag returned by gamma.
 *
 * Addresses confirmed on Polygon mainnet (chain 137) from getContractConfig
 * + Polymarket public docs.
 */
const NEG_RISK_ADAPTER: Address = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CONDITIONAL_TOKENS: Address = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const NEG_RISK_ADAPTER_ABI = parseAbi([
  'function redeemPositions(bytes32 _conditionId, uint256[] _amounts)',
]);
const CONDITIONAL_TOKENS_ABI = parseAbi([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
]);

const ZERO_BYTES32 = ('0x' + '0'.repeat(64)) as `0x${string}`;

export interface PolyExecOptions {
  /** L2 API credentials. Required for any state-changing call. */
  creds?: ApiKeyCreds;
}

export class PolymarketExecClient {
  readonly endpoints: PolyEndpoints;
  readonly address: `0x${string}`;
  private readonly clob: ClobClient;
  private readonly cfg: SvxConfig;

  constructor(cfg: SvxConfig, opts: PolyExecOptions = {}) {
    this.cfg = cfg;
    const { walletClient, address, endpoints } = loadPolyOperatorKey(cfg);
    this.endpoints = endpoints;
    this.address = address;

    // Polymarket signature mode selection. Default 'EOA' keeps the existing
    // direct-EOA behavior (works only for whitelisted addresses). Most
    // operators land on POLY_GNOSIS_SAFE — Polymarket's web UI auto-deploys
    // a Safe proxy that owns the pUSD; the EOA signs orders on its behalf.
    const sigTypeMap = {
      EOA: SignatureTypeV2.EOA,
      POLY_PROXY: SignatureTypeV2.POLY_PROXY,
      POLY_GNOSIS_SAFE: SignatureTypeV2.POLY_GNOSIS_SAFE,
    } as const;
    const signatureType = sigTypeMap[cfg.polySignatureType];
    const funderAddress =
      cfg.polyFunderAddress && /^0x[0-9a-fA-F]{40}$/.test(cfg.polyFunderAddress)
        ? (cfg.polyFunderAddress as `0x${string}`)
        : address;

    if (cfg.polySignatureType !== 'EOA' && funderAddress.toLowerCase() === address.toLowerCase()) {
      log.warn('svx.poly_client.funder_mismatch', {
        signatureType: cfg.polySignatureType,
        funderAddress,
        hint:
          'POLY_SIGNATURE_TYPE is non-EOA but POLY_FUNDER_ADDRESS is unset — falling back to EOA address as funder. Orders will reject if a proxy is required.',
      });
    }

    const chain = endpoints.network === 'amoy' ? Chain.AMOY : Chain.POLYGON;
    this.clob = new ClobClient({
      host: endpoints.clobHost,
      chain,
      signer: walletClient,
      creds: opts.creds,
      signatureType,
      funderAddress,
    });

    log.info('svx.poly_client.constructed', {
      eoa: address,
      funder: funderAddress,
      signatureType: cfg.polySignatureType,
      network: endpoints.network,
    });
  }

  /**
   * Bootstrap (or recover) L2 API credentials. Idempotent — derives the
   * existing key if one is already registered for this EOA. The returned
   * creds should be persisted (data/poly-operator.json) and used to
   * construct future PolymarketExecClient instances.
   */
  async bootstrapApiKey(): Promise<ApiKeyCreds> {
    log.info('svx.poly_client.bootstrap_api_key.start', {
      address: this.address,
      host: this.endpoints.clobHost,
    });
    const creds = await this.clob.createOrDeriveApiKey();
    log.info('svx.poly_client.bootstrap_api_key.ok', {
      address: this.address,
      apiKeyPrefix: creds.key.slice(0, 6) + '…',
    });
    return creds;
  }

  /** Read pUSD balance at the operator address (returns floating pUSD, 6 dp). */
  async getCollateralBalance(): Promise<{
    address: `0x${string}`;
    pUsd: number;
    raw: bigint;
  }> {
    const contracts = getContractConfig(this.endpoints.chainId);
    const collateral = contracts.collateral as `0x${string}`;
    const chain = this.endpoints.network === 'amoy' ? polygonAmoy : polygon;
    const pub = createPublicClient({ chain, transport: http(this.endpoints.rpcUrl) });
    const raw = await pub.readContract({
      address: collateral,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [this.address],
    });
    return { address: this.address, pUsd: Number(raw) / 1e6, raw };
  }

  /** Read native gas (MATIC/POL) balance at the operator address. */
  async getGasBalance(): Promise<{ wei: bigint; eth: number }> {
    const chain = this.endpoints.network === 'amoy' ? polygonAmoy : polygon;
    const pub = createPublicClient({ chain, transport: http(this.endpoints.rpcUrl) });
    const wei = await pub.getBalance({ address: this.address });
    return { wei, eth: Number(wei) / 1e18 };
  }

  /** Pass-through: full L2 order book for one outcome token. */
  async getOrderBook(tokenId: string): Promise<OrderBookSummary> {
    return this.clob.getOrderBook(tokenId);
  }

  /**
   * Place a market FOK buy order — `usdcAmount` is the maximum pUSD you're
   * willing to spend (per V2 SDK convention, the `amount` field on a market
   * BUY is the quote-side cap, NOT a share count). Resolves with the SDK
   * response, which includes order id and any partial-fill details.
   */
  async marketBuy(args: {
    tokenId: string;
    usdcAmount: number;
    tickSize?: '0.001' | '0.01' | '0.1';
  }): Promise<unknown> {
    const tickSize = args.tickSize ?? '0.01';
    log.info('svx.poly_client.market_buy.submit', {
      tokenId: args.tokenId,
      usdcAmount: args.usdcAmount,
      tickSize,
    });
    const resp = await this.clob.createAndPostMarketOrder(
      {
        tokenID: args.tokenId,
        amount: args.usdcAmount,
        side: Side.BUY,
        orderType: OrderType.FOK,
      },
      { tickSize },
      OrderType.FOK,
    );
    log.info('svx.poly_client.market_buy.ok', { tokenId: args.tokenId, resp });
    return resp;
  }

  /** Cheap accessor — same address used for funder/signer. */
  get operatorAddress(): `0x${string}` {
    return this.address;
  }

  /**
   * Redeem CTF positions for a resolved market. Burns the outcome tokens
   * we hold and credits pUSD to the operator wallet 1:1 with winning shares.
   * Losing shares pay 0 and are still consumed by the redeem (no penalty,
   * but no point spending gas on them — caller should skip pure-losers).
   *
   * `shares` is the number of WINNING outcome shares we hold (the redeem
   * payout in pUSD). Wei conversion uses 6 decimals matching pUSD.
   *
   * Polymarket's "Bitcoin above X" strikes are NegRisk markets — set
   * `negRisk=true`. The NegRiskAdapter takes a parallel `_amounts` array;
   * we pass [winningShares, 0] when Yes won, [0, winningShares] otherwise.
   * Standard CTF takes `indexSets` instead — [1] for Yes only, [2] for No
   * only — and redeems all of our balance for those index sets (no amount).
   *
   * Returns the Polygon tx hash. Throws on revert (caller logs + retries
   * next loop iteration).
   */
  async redeemPolyWinnings(args: {
    conditionId: string;
    negRisk: boolean;
    winningOutcome: 'yes' | 'no';
    shares: number;
  }): Promise<`0x${string}`> {
    const { walletClient } = loadPolyOperatorKey(this.cfg);
    const contracts = getContractConfig(this.endpoints.chainId);
    const conditionId = args.conditionId as `0x${string}`;
    log.info('svx.poly_client.redeem.submit', {
      conditionId,
      winningOutcome: args.winningOutcome,
      shares: args.shares,
      negRisk: args.negRisk,
    });

    // walletClient was constructed with account+chain bound in
    // loadPolyOperatorKey, so we don't repeat them here.
    if (args.negRisk) {
      // NegRisk: amounts parallel to outcomes [Yes, No] in wei (6 dp).
      const sharesWei = parseUnits(args.shares.toFixed(6), 6);
      const amounts = args.winningOutcome === 'yes' ? [sharesWei, 0n] : [0n, sharesWei];
      const tx = await walletClient.writeContract({
        chain: walletClient.chain,
        account: walletClient.account!,
        address: NEG_RISK_ADAPTER,
        abi: NEG_RISK_ADAPTER_ABI,
        functionName: 'redeemPositions',
        args: [conditionId, amounts],
      });
      log.info('svx.poly_client.redeem.ok', { conditionId, tx, path: 'negRisk' });
      return tx;
    }

    // Standard CTF: index sets are bitmask-style [1, 2] for [Yes, No]. Pass
    // only the winning side so we don't waste gas burning losing tokens
    // (we don't hold any if we never bought them, but redeemPositions still
    // reads ERC1155 balances for each indexSet passed).
    const winningIndex = args.winningOutcome === 'yes' ? 1n : 2n;
    const collateral = contracts.collateral as Address;
    const tx = await walletClient.writeContract({
      chain: walletClient.chain,
      account: walletClient.account!,
      address: CONDITIONAL_TOKENS,
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: 'redeemPositions',
      args: [collateral, ZERO_BYTES32, conditionId, [winningIndex]],
    });
    log.info('svx.poly_client.redeem.ok', { conditionId, tx, path: 'ctf' });
    return tx;
  }

  /** Symmetric to marketBuy. `shares` is the number of outcome shares to sell. */
  async marketSell(args: {
    tokenId: string;
    shares: number;
    tickSize?: '0.001' | '0.01' | '0.1';
  }): Promise<unknown> {
    const tickSize = args.tickSize ?? '0.01';
    log.info('svx.poly_client.market_sell.submit', {
      tokenId: args.tokenId,
      shares: args.shares,
      tickSize,
    });
    const resp = await this.clob.createAndPostMarketOrder(
      {
        tokenID: args.tokenId,
        amount: args.shares,
        side: Side.SELL,
        orderType: OrderType.FOK,
      },
      { tickSize },
      OrderType.FOK,
    );
    log.info('svx.poly_client.market_sell.ok', { tokenId: args.tokenId, resp });
    return resp;
  }
}

/**
 * Load L2 API creds from POLY_API_{KEY,SECRET,PASSPHRASE} env vars first,
 * then fall back to data/poly-operator.<network>.json on disk. Returns null
 * if neither is available — the caller can no-op cleanly without crashing.
 */
export function loadPolyCreds(cfg: SvxConfig): ApiKeyCreds | null {
  const envKey = process.env.POLY_API_KEY;
  const envSecret = process.env.POLY_API_SECRET;
  const envPass = process.env.POLY_API_PASSPHRASE;
  if (envKey && envSecret && envPass) {
    return { key: envKey, secret: envSecret, passphrase: envPass };
  }
  const endpoints = derivePolyEndpoints(cfg);
  const file = dataPath(`poly-operator.${endpoints.network}.json`, cfg);
  if (!fs.existsSync(file)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (rec.apiKey && rec.apiSecret && rec.apiPassphrase) {
      return { key: rec.apiKey, secret: rec.apiSecret, passphrase: rec.apiPassphrase };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Construct a PolymarketExecClient whenever the operator has provided a
 * private key + L2 creds — regardless of whether `POLY_EXECUTION_ENABLED`
 * is on. The flag only gates ORDER SUBMISSION; balance reads, address
 * surfacing, and orderbook queries should always be available so the
 * dashboard can show "you have $X pUSD, ready to fire when you flip the
 * switch." Returns null only when secrets aren't configured at all.
 */
export function tryCreatePolymarketExecClient(cfg: SvxConfig): PolymarketExecClient | null {
  if (!process.env.POLY_PRIVATE_KEY) {
    // Don't warn — this is the expected path for instances that haven't
    // configured a Poly wallet yet (e.g. the existing testnet bot).
    return null;
  }
  const creds = loadPolyCreds(cfg);
  if (!creds) {
    log.warn('svx.poly.skip_init', {
      reason: 'POLY_PRIVATE_KEY set but no L2 creds — run setup-poly-wallet',
    });
    return null;
  }
  try {
    return new PolymarketExecClient(cfg, { creds });
  } catch (e) {
    log.warn('svx.poly.skip_init', {
      reason: 'client construction failed',
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** Normalized result of a market-order submission. */
export interface PolyFillResult {
  orderId?: string;
  status: 'submitted' | 'filled' | 'failed' | 'partial';
  filledShares?: number;
  fillPrice?: number;
  costUsdc?: number;
  txHash?: string;
  raw: unknown;
}

/**
 * Parse the V2 SDK's market-order response into a normalized fill record.
 *
 * The response shape varies by SDK version, order type, and fill outcome.
 * Observed shapes in the wild:
 *   { status: 'matched', orderID: '0x...', makingAmount: '5.5', price: '0.29' }
 *   { status: 'unmatched', filled: 0 }
 *   { success: false, errorMsg: 'insufficient liquidity', status: false }
 *   { success: true, status: 200, orderHashes: ['0x...'] }
 *
 * Defensive about every field — `r.status` has been seen as a string, a
 * boolean, AND a number depending on the path. Returns a normalized
 * PolyFillResult; throws only if `resp` itself is corrupt (caller catches
 * + logs as 'failed').
 */
export function parsePolyFillResponse(resp: unknown, requestedUsdc: number): PolyFillResult {
  const r = (resp ?? {}) as Record<string, unknown>;

  // Status normalization — coerce whatever shape into a lowercase string
  // for the success check, or undefined if nothing usable.
  const statusRaw = coerceString(r.status)?.toLowerCase();

  // Order id — Polymarket has used orderID / orderId / id / orderHash(es)
  // historically. Some return strings, some bigints. Coerce to string.
  const orderIdRaw =
    r.orderID ?? r.orderId ?? r.id ?? r.orderHash ?? firstOf(r.orderHashes);
  const orderId = coerceString(orderIdRaw);

  // Share count — successful market orders report filled size via one of
  // several field names. All paths return string OR number.
  const filledRaw = r.makingAmount ?? r.takingAmount ?? r.filled ?? r.size;
  const filledShares = coerceNumber(filledRaw);

  // Fill price — directly reported, OR derivable from requestedUsdc/shares.
  const fillPriceRaw = r.price ?? r.avgPrice;
  let fillPrice = coerceNumber(fillPriceRaw);
  if ((fillPrice == null || !isFinite(fillPrice)) && filledShares && filledShares > 0) {
    fillPrice = requestedUsdc / filledShares;
  }

  const txHash = coerceString(r.transactionHash ?? r.txHash);

  const success =
    statusRaw === 'matched' ||
    statusRaw === 'filled' ||
    statusRaw === 'live' ||
    statusRaw === '200' ||  // some SDK versions stringify HTTP-like status
    r.success === true;

  let status: PolyFillResult['status'] = 'submitted';
  if (success && filledShares && filledShares > 0) status = 'filled';
  else if (!success && filledShares && filledShares > 0) status = 'partial';
  else if (r.success === false || statusRaw === 'error' || statusRaw === 'rejected') {
    status = 'failed';
  } else if (!success) {
    status = 'failed';
  }

  const costUsdc =
    fillPrice != null && filledShares != null ? fillPrice * filledShares : undefined;
  return { orderId, status, filledShares, fillPrice, costUsdc, txHash, raw: resp };
}

/**
 * Detect the "maker address not allowed" CLOB error that fires when an EOA
 * tries to trade without a registered proxy wallet. The error response shape:
 *   { error: 'maker address not allowed, please use the deposit wallet flow',
 *     status: 400 }
 * The fix is operator-side (set up a Safe proxy) — the bot can't recover
 * on its own. We use this to surface a clear error AND short-circuit the
 * tight retry loop.
 */
export function isMakerNotAllowedError(resp: unknown): boolean {
  if (!resp || typeof resp !== 'object') return false;
  const r = resp as Record<string, unknown>;
  const errStr = typeof r.error === 'string' ? r.error.toLowerCase() : '';
  const msgStr = typeof r.errorMsg === 'string' ? r.errorMsg.toLowerCase() : '';
  return (
    errStr.includes('maker address not allowed') ||
    errStr.includes('deposit wallet flow') ||
    msgStr.includes('maker address not allowed') ||
    msgStr.includes('deposit wallet flow')
  );
}

/** Coerce strings, numbers, bigints, booleans into a string. Returns undefined for null/undefined/objects. */
function coerceString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** Coerce strings/numbers/bigints into a finite number, else undefined. */
function coerceNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    const n = Number(v);
    return isFinite(n) ? n : undefined;
  }
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

function firstOf(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : undefined;
}
