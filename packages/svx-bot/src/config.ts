/**
 * Centralized runtime configuration. All values default to safe-paper-trading
 * mode; live trading must be explicitly enabled.
 */

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Resolve the workspace root by walking up from cwd until we find
 * `pnpm-workspace.yaml`. This lets the bot write to `<workspace>/data`
 * regardless of which package is the cwd.
 */
function findWorkspaceRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const WORKSPACE_ROOT = findWorkspaceRoot();

// Load .env from the workspace root (not cwd) so scripts run via
// `pnpm --filter <pkg> <script>` still pick up secrets. Falls back to default
// dotenv behavior in production where there's no .env file.
const workspaceEnv = path.join(WORKSPACE_ROOT, '.env');
if (fs.existsSync(workspaceEnv)) {
  loadEnv({ path: workspaceEnv });
} else {
  loadEnv();
}

const Schema = z.object({
  paperTrading: z.boolean().default(true),
  spreadThreshold: z.number().min(0).max(1).default(0.03),
  // Week-1 live defaults: per-trade $15, 10 concurrent, daily loss limit $150.
  // Worst-case 24h loss = 10 * $15 = $150 (matches the daily auto-pause).
  // Worst-case weekly loss with pauses ≈ $525 — within the $1000 budget.
  maxPositionDusdc: z.number().positive().default(15),
  maxPositionPct: z.number().min(0).max(1).default(0.05),
  dailyLossLimitDusdc: z.number().positive().default(150),
  maxOpenPositions: z.number().int().positive().default(10),
  /**
   * Concentration cap: never hold more than this many open positions on the
   * same (oracle, strike, direction) tuple. Default 2 — one initial fire +
   * one confirmation, then stop pyramiding. Forces the rest of the position
   * budget to find different signals → more independent settlement events
   * for statistical power.
   */
  maxPositionsPerSignal: z.number().int().positive().default(2),
  /**
   * Skip signals where predictProb is in the deep-ITM/OTM tails. The protocol
   * also rejects asks > 99% or < 1%, so these waste gas on guaranteed
   * failures. Default is symmetric: skip if predictProb > 0.95 or < 0.05.
   */
  minPredictProb: z.number().min(0).max(0.5).default(0.05),
  maxPredictProb: z.number().min(0.5).max(1).default(0.95),
  /**
   * Don't write signals to the ledger if the action is 'filtered' AND the
   * absolute spread is below this fraction of the threshold. The bot still
   * EVALUATES every (oracle, strike) pair every loop — it just doesn't
   * persist boring rows. Default 0.3 = "log if spread > 30% of threshold,
   * i.e. > 0.9% by default; otherwise skip." Cuts ~80% of disk writes.
   * Set to 0 to log everything (old behavior).
   */
  signalLogMinSpreadFrac: z.number().min(0).max(1).default(0.3),
  maxSviStalenessSec: z.number().positive().default(300),
  polyMaxBidaskVolPts: z.number().positive().default(0.05),
  polyMinVolume24hUsd: z.number().nonnegative().default(1000),
  /**
   * Maximum |Predict-expiry − Polymarket-expiry| we'll consider. Pre-2026-05-11
   * this was 3600s (1h) and served as the primary expiry-match gate. Now that
   * `signal/spread.ts` reprices Predict's binary at the Polymarket expiry
   * (flat-vol-across-expiries), this is just a sanity cap to avoid
   * extrapolating a 15-min oracle's IV to a 30-day binary — 14 days is
   * generous enough to cover daily + weekly Polymarket markets without
   * silly extrapolation.
   */
  expiryToleranceSec: z.number().nonnegative().default(14 * 24 * 3600),
  circuitBreakerLosses: z.number().int().positive().default(5),
  polymarketGammaBase: z.string().url().default('https://gamma-api.polymarket.com'),
  polymarketClobBase: z.string().url().default('https://clob.polymarket.com'),

  // === Polymarket execution (v2 second leg, OFF by default) ===
  polyExecutionEnabled: z.boolean().default(false),
  /** 'amoy' (testnet, chain 80002) or 'polygon' (mainnet, chain 137). */
  polyNetwork: z.enum(['amoy', 'polygon']).default('amoy'),
  /** Optional override for the CLOB host. If empty, derived from polyNetwork. */
  polyClobHost: z.string().default(''),
  /** Optional override for the Polygon RPC. If empty, derived from polyNetwork. */
  polyRpcUrl: z.string().default(''),
  /** Per-trade pUSD cap on the Polymarket leg. Start tiny. */
  maxPolyPositionUsdc: z.number().positive().default(2),
  /** Hard cap on concurrent open Polymarket positions. Total open exposure
   *  is bounded above by maxPolyPositionUsdc * maxOpenPolyPositions. */
  maxOpenPolyPositions: z.number().int().positive().default(5),
  /** Refuse to fire if the best ask has fewer than this many shares available
   *  at our price level (we'd partial-fill at bad average prices otherwise). */
  polyMinBookDepthShares: z.number().int().positive().default(20),
  /** Daily pUSD loss limit on Polymarket leg — symmetric to dUSDC limit but
   *  separate because we're spending pUSD, not dUSDC. */
  dailyPolyLossLimitUsdc: z.number().positive().default(10),
  /** Max time (ms) to wait for the Polymarket leg to fill before we abort. */
  polyFillTimeoutMs: z.number().int().positive().default(30_000),
  /**
   * Polymarket signature mode: 'EOA' (direct EOA — works only for whitelisted
   * addresses), 'POLY_PROXY' (Polymarket-deployed proxy), or 'POLY_GNOSIS_SAFE'
   * (the current default for Polymarket UI signups — Gnosis Safe holds funds,
   * EOA owner signs orders).
   *
   * If you signed up via polymarket.com web UI, you have a POLY_GNOSIS_SAFE
   * setup. The proxy/safe address goes in `polyFunderAddress` and pUSD must
   * be held by the proxy (not the signing EOA).
   */
  polySignatureType: z.enum(['EOA', 'POLY_PROXY', 'POLY_GNOSIS_SAFE']).default('EOA'),
  /**
   * Funder address that owns the pUSD and outcome shares. Empty = use the EOA's
   * own address (SignatureType=EOA only). Required as a 0x address when
   * polySignatureType is POLY_PROXY or POLY_GNOSIS_SAFE.
   */
  polyFunderAddress: z.string().default(''),

  // === Hyperliquid delta hedge (Part 2 — OFF by default) ===
  /** Kill switch for the HL hedging leg. Defaults OFF — operator turns on
   *  after one-time bridge funding from Arbitrum. */
  hlExecutionEnabled: z.boolean().default(false),
  /** Hyperliquid network — `mainnet` or `testnet`. */
  hlNetwork: z.enum(['mainnet', 'testnet']).default('mainnet'),
  /** Asset to hedge (must match Hyperliquid's perp universe). */
  hlHedgeAsset: z.string().default('BTC'),
  /** Per-trade USD notional cap on the HL leg. Bounds the hedge size so a
   *  short-expiry gamma blow-up can't size a hedge bigger than we want. */
  maxHlPerTradeUsdc: z.number().positive().default(2),
  /** Total open HL exposure cap (USD notional, summed across all open hedges). */
  maxHlOpenUsdc: z.number().positive().default(10),
  /** Daily HL loss limit (USD). Auto-pauses on breach. */
  dailyHlLossLimitUsdc: z.number().positive().default(5),
  /** When the HL exchange is unreachable, should the bot refuse to open new
   *  poly trades? `true` = strict (no naked Poly), `false` = permissive
   *  (continue opening Poly without hedge, log a warning). Default false. */
  hlRequiredForPoly: z.boolean().default(false),

  dataDir: z.string().default('./data'),
  apiHost: z.string().default('127.0.0.1'),
  apiPort: z.number().int().positive().default(4321),
  loopIntervalMs: z.number().int().positive().default(15_000),

  /** Optional human label for this bot instance ("testnet", "mainnet", etc.).
   *  Surfaced on /status and the dashboard header so two parallel deployments
   *  are visually distinguishable. Defaults to '' (no label shown). */
  instanceLabel: z.string().default(''),
});

export type SvxConfig = z.infer<typeof Schema>;

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

function parseNum(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

export function loadConfig(): SvxConfig {
  return Schema.parse({
    paperTrading: parseBool(process.env.PAPER_TRADING, true),
    spreadThreshold: parseNum(process.env.SPREAD_THRESHOLD, 0.03),
    maxPositionDusdc: parseNum(process.env.MAX_POSITION_DUSDC, 15),
    maxPositionPct: parseNum(process.env.MAX_POSITION_PCT, 0.05),
    dailyLossLimitDusdc: parseNum(process.env.DAILY_LOSS_LIMIT_DUSDC, 150),
    maxOpenPositions: parseNum(process.env.MAX_OPEN_POSITIONS, 10),
    maxPositionsPerSignal: parseNum(process.env.MAX_POSITIONS_PER_SIGNAL, 2),
    minPredictProb: parseNum(process.env.MIN_PREDICT_PROB, 0.05),
    maxPredictProb: parseNum(process.env.MAX_PREDICT_PROB, 0.95),
    signalLogMinSpreadFrac: parseNum(process.env.SIGNAL_LOG_MIN_SPREAD_FRAC, 0.3),
    maxSviStalenessSec: parseNum(process.env.MAX_SVI_STALENESS_SEC, 300),
    polyMaxBidaskVolPts: parseNum(process.env.POLY_MAX_BIDASK_VOL_PTS, 0.05),
    polyMinVolume24hUsd: parseNum(process.env.POLY_MIN_24H_VOLUME_USD, 1000),
    expiryToleranceSec: parseNum(process.env.EXPIRY_TOLERANCE_SEC, 14 * 24 * 3600),
    circuitBreakerLosses: parseNum(process.env.CIRCUIT_BREAKER_LOSSES, 5),
    polymarketGammaBase: process.env.POLYMARKET_API_BASE ?? 'https://gamma-api.polymarket.com',
    polymarketClobBase: process.env.POLYMARKET_CLOB_BASE ?? 'https://clob.polymarket.com',
    polyExecutionEnabled: parseBool(process.env.POLY_EXECUTION_ENABLED, false),
    polyNetwork: (process.env.POLY_NETWORK as 'amoy' | 'polygon' | undefined) ?? 'amoy',
    polyClobHost: process.env.POLY_CLOB_HOST ?? '',
    polyRpcUrl: process.env.POLY_RPC_URL ?? '',
    maxPolyPositionUsdc: parseNum(process.env.MAX_POLY_POSITION_USDC, 2),
    maxOpenPolyPositions: parseNum(process.env.MAX_OPEN_POLY_POSITIONS, 5),
    polyMinBookDepthShares: parseNum(process.env.POLY_MIN_BOOK_DEPTH_SHARES, 20),
    dailyPolyLossLimitUsdc: parseNum(process.env.DAILY_POLY_LOSS_LIMIT_USDC, 10),
    polyFillTimeoutMs: parseNum(process.env.POLY_FILL_TIMEOUT_MS, 30_000),
    polySignatureType:
      (process.env.POLY_SIGNATURE_TYPE as 'EOA' | 'POLY_PROXY' | 'POLY_GNOSIS_SAFE' | undefined) ??
      'EOA',
    polyFunderAddress: process.env.POLY_FUNDER_ADDRESS ?? '',
    hlExecutionEnabled: parseBool(process.env.HL_EXECUTION_ENABLED, false),
    hlNetwork: (process.env.HL_NETWORK as 'mainnet' | 'testnet' | undefined) ?? 'mainnet',
    hlHedgeAsset: process.env.HL_HEDGE_ASSET ?? 'BTC',
    maxHlPerTradeUsdc: parseNum(process.env.MAX_HL_PER_TRADE_USDC, 2),
    maxHlOpenUsdc: parseNum(process.env.MAX_HL_OPEN_USDC, 10),
    dailyHlLossLimitUsdc: parseNum(process.env.DAILY_HL_LOSS_LIMIT_USDC, 5),
    hlRequiredForPoly: parseBool(process.env.HL_REQUIRED_FOR_POLY, false),
    dataDir: process.env.SVX_DATA_DIR ?? path.join(WORKSPACE_ROOT, 'data'),
    apiHost: process.env.SVX_API_HOST ?? '127.0.0.1',
    apiPort: parseNum(process.env.SVX_API_PORT, 4321),
    loopIntervalMs: parseNum(process.env.SVX_LOOP_INTERVAL_MS, 15_000),
    instanceLabel: process.env.SVX_INSTANCE_LABEL ?? '',
  });
}

export function dataPath(file: string, cfg: SvxConfig = loadConfig()): string {
  return path.resolve(cfg.dataDir, file);
}
