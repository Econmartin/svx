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
import { createPublicClient, http, parseAbi } from 'viem';
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

    const chain = endpoints.network === 'amoy' ? Chain.AMOY : Chain.POLYGON;
    this.clob = new ClobClient({
      host: endpoints.clobHost,
      chain,
      signer: walletClient,
      creds: opts.creds,
      signatureType: SignatureTypeV2.EOA,
      funderAddress: address,
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
 * Construct a PolymarketExecClient if the bot is configured to execute
 * Polymarket orders AND has both a private key and L2 creds. Returns null
 * otherwise (paper mode, or misconfigured) so the caller can no-op cleanly.
 */
export function tryCreatePolymarketExecClient(cfg: SvxConfig): PolymarketExecClient | null {
  if (!cfg.polyExecutionEnabled) return null;
  if (!process.env.POLY_PRIVATE_KEY) {
    log.warn('svx.poly.skip_init', {
      reason: 'POLY_EXECUTION_ENABLED=true but POLY_PRIVATE_KEY missing',
    });
    return null;
  }
  const creds = loadPolyCreds(cfg);
  if (!creds) {
    log.warn('svx.poly.skip_init', {
      reason: 'no L2 creds — set POLY_API_{KEY,SECRET,PASSPHRASE} or run setup-poly-wallet',
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
 * The exact shape varies by SDK version + order type; we normalize defensively
 * and treat anything we don't recognize as `submitted` (no shares filled).
 */
export function parsePolyFillResponse(resp: unknown, requestedUsdc: number): PolyFillResult {
  const r = (resp ?? {}) as Record<string, unknown>;
  const statusRaw = (r.status as string | undefined)?.toLowerCase();
  const orderId = (r.orderID ?? r.orderId ?? r.id) as string | undefined;
  const filledRaw = r.makingAmount ?? r.takingAmount ?? r.filled ?? r.size;
  const filledShares =
    typeof filledRaw === 'string' ? Number(filledRaw) : (filledRaw as number | undefined);
  const fillPriceRaw = r.price ?? r.avgPrice;
  let fillPrice: number | undefined =
    typeof fillPriceRaw === 'string' ? Number(fillPriceRaw) : (fillPriceRaw as number | undefined);
  if (fillPrice == null && filledShares && filledShares > 0) {
    fillPrice = requestedUsdc / filledShares;
  }
  const txHash = (r.transactionHash ?? r.txHash) as string | undefined;
  const success =
    statusRaw === 'matched' ||
    statusRaw === 'filled' ||
    statusRaw === 'live' ||
    r.success === true;
  let status: PolyFillResult['status'] = 'submitted';
  if (success && filledShares && filledShares > 0) status = 'filled';
  else if (!success && filledShares && filledShares > 0) status = 'partial';
  else if (!success) status = 'failed';
  const costUsdc =
    fillPrice != null && filledShares != null ? fillPrice * filledShares : undefined;
  return { orderId, status, filledShares, fillPrice, costUsdc, txHash, raw: resp };
}
