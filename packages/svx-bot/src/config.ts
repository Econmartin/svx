/**
 * Centralized runtime configuration. All values default to safe-paper-trading
 * mode; live trading must be explicitly enabled.
 */

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';

loadEnv();

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
  expiryToleranceSec: z.number().nonnegative().default(3600),
  circuitBreakerLosses: z.number().int().positive().default(5),
  polymarketGammaBase: z.string().url().default('https://gamma-api.polymarket.com'),
  polymarketClobBase: z.string().url().default('https://clob.polymarket.com'),
  dataDir: z.string().default('./data'),
  apiHost: z.string().default('127.0.0.1'),
  apiPort: z.number().int().positive().default(4321),
  loopIntervalMs: z.number().int().positive().default(15_000),
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
    expiryToleranceSec: parseNum(process.env.EXPIRY_TOLERANCE_SEC, 3600),
    circuitBreakerLosses: parseNum(process.env.CIRCUIT_BREAKER_LOSSES, 5),
    polymarketGammaBase: process.env.POLYMARKET_API_BASE ?? 'https://gamma-api.polymarket.com',
    polymarketClobBase: process.env.POLYMARKET_CLOB_BASE ?? 'https://clob.polymarket.com',
    dataDir: process.env.SVX_DATA_DIR ?? path.join(WORKSPACE_ROOT, 'data'),
    apiHost: process.env.SVX_API_HOST ?? '127.0.0.1',
    apiPort: parseNum(process.env.SVX_API_PORT, 4321),
    loopIntervalMs: parseNum(process.env.SVX_LOOP_INTERVAL_MS, 15_000),
  });
}

export function dataPath(file: string, cfg: SvxConfig = loadConfig()): string {
  return path.resolve(cfg.dataDir, file);
}
