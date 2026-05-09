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
  // Bug-flush defaults: keep trades < $1 and daily loss < $5 until the live
  // path is proven. Increase via env when you're ready to scale.
  maxPositionDusdc: z.number().positive().default(0.5),
  maxPositionPct: z.number().min(0).max(1).default(0.05),
  dailyLossLimitDusdc: z.number().positive().default(5),
  maxOpenPositions: z.number().int().positive().default(5),
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
    maxPositionDusdc: parseNum(process.env.MAX_POSITION_DUSDC, 0.5),
    maxPositionPct: parseNum(process.env.MAX_POSITION_PCT, 0.05),
    dailyLossLimitDusdc: parseNum(process.env.DAILY_LOSS_LIMIT_DUSDC, 5),
    maxOpenPositions: parseNum(process.env.MAX_OPEN_POSITIONS, 5),
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
