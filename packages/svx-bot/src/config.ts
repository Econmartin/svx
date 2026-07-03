/**
 * Centralized runtime configuration. All values default to safe-paper-trading
 * mode; live trading must be explicitly enabled.
 */

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { TUNABLES } from './tunables.js';

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
  /** Floor on the depth-clamped order size. Below this we skip rather than
   *  submit a tiny order that's barely worth the gas / slippage. */
  polyMinOrderUsdc: z.number().positive().default(0.5),
  /** Cooldown after a Polymarket fill_failed before retrying the SAME tokenId.
   *  Without this the bot hammers the same FOK-failing order every loop. */
  polyFillFailedCooldownMs: z.number().int().positive().default(5 * 60_000),
  /** Daily pUSD loss limit on Polymarket leg — symmetric to dUSDC limit but
   *  separate because we're spending pUSD, not dUSDC. */
  dailyPolyLossLimitUsdc: z.number().positive().default(10),
  /** Max time (ms) to wait for the Polymarket leg to fill before we abort. */
  polyFillTimeoutMs: z.number().int().positive().default(30_000),
  /** Auto-abandon stuck poly trades after this many days. */
  polyStaleSettlementDays: z.number().positive().default(14),
  predictStaleRedeemHours: z.number().positive().default(6),
  /** Mid-life stop-loss: sell the poly leg at pnlFrac ≤ −this. 0 disables. */
  polyStopLossFrac: z.number().min(0).max(1).default(0.5),
  /** Min ms between entries on the same poly token — kills exit→re-buy churn. */
  polyReentryCooldownMs: z.number().int().positive().default(30 * 60_000),
  /** Refuse poly entries priced at/below this (deep-OTM lottery zone). */
  polyMinEntryPrice: z.number().min(0).max(1).default(0.03),
  /** Refuse poly entries priced at/above this (near-certain, no payoff room). */
  polyMaxEntryPrice: z.number().min(0).max(1).default(0.97),
  /** Model edge over the entry ask required to trade: modelProb − ask. */
  polyMinEvFrac: z.number().min(0).max(1).default(0.05),
  // ── Expiry-convergence strategy (see strategy/convergence.ts) ──
  convergenceEnabled: z.boolean().default(true),
  convergenceMaxMinutes: z.number().positive().default(90),
  convergenceMinMinutes: z.number().min(0).default(5),
  convergenceMinSigma: z.number().positive().default(4),
  /** RV multiplier applied before the sigma-distance test (fat-tail margin). */
  convergenceSigmaSafetyMult: z.number().min(1).default(2),
  /** Min mid-price history before the RV estimate is trusted. */
  convergenceMinRvHistoryMs: z.number().int().positive().default(15 * 60_000),
  /** Strike sanity band as fractions of spot — rejects non-price markets. */
  convergenceStrikeBandLoFrac: z.number().positive().default(0.5),
  convergenceStrikeBandHiFrac: z.number().positive().default(2.0),
  /** Convergence-specific stop-loss fraction (tighter than the shared one). */
  convergenceStopLossFrac: z.number().min(0).max(1).default(0.15),
  convergenceMinPrice: z.number().min(0).max(1).default(0.9),
  convergenceMaxPrice: z.number().min(0).max(1).default(0.97),
  convergenceMinEvFrac: z.number().min(0).max(1).default(0.02),
  maxConvergencePerTradeUsdc: z.number().positive().default(4),
  convergenceCheckIntervalMs: z.number().int().positive().default(60_000),
  /** Redeem retry backoff + attempt cap. */
  polyRedeemRetryGapMs: z.number().int().positive().default(30 * 60_000),
  polyRedeemMaxAttempts: z.number().int().positive().default(5),
  /** Wallet-vs-ledger reconciliation drift threshold (pUSD). */
  reconcileDriftThresholdUsdc: z.number().positive().default(5),
  /**
   * Polymarket signature mode:
   *   - 'EOA':              direct EOA — works only for whitelisted addresses.
   *   - 'POLY_PROXY':       legacy Polymarket-deployed proxy (pre-2024).
   *   - 'POLY_GNOSIS_SAFE': pre-2026-05 Gnosis Safe signups via polymarket.com.
   *   - 'POLY_1271':        the May 2026 "Deposit Wallet" rollout — smart-
   *                         contract wallets that verify signatures via
   *                         EIP-1271. NEW signups via polymarket.com get
   *                         these. EOA owner signs orders; the Deposit
   *                         Wallet's `isValidSignature` validates them.
   *
   * For POLY_1271, the L2 API key MUST be re-derived against the proxy
   * (not the EOA) — use scripts/derive-poly-api-key-1271.ts since the SDK's
   * top-level createApiKey() has a known bug that binds keys to the EOA.
   */
  polySignatureType: z.enum(['EOA', 'POLY_PROXY', 'POLY_GNOSIS_SAFE', 'POLY_1271']).default('EOA'),
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
  /** Opens of NEW hedge legs on poly fills. Disabled by the 2026-07 audit
   *  (delta was sized at the wrong expiry and capped into irrelevance) —
   *  see tunables.ts. Close paths for legacy legs ignore this. */
  hlHedgeEnabled: z.boolean().default(false),
  /** Hyperliquid network — `mainnet` or `testnet`. */
  hlNetwork: z.enum(['mainnet', 'testnet']).default('mainnet'),
  /** Asset to hedge (must match Hyperliquid's perp universe). */
  hlHedgeAsset: z.string().default('BTC'),
  /** Hyperliquid minimum order value (USD). Pre-check that skips HL
   *  submissions below this so the bot doesn't error-spam every loop. */
  hlMinOrderUsdc: z.number().positive().default(10),
  /** Hyperliquid taker fee rate (decimal). Deducted from realized HL PnL. */
  hlTakerFeeRate: z.number().nonnegative().max(0.01).default(0.00035),
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

  // === Vol-arb standalone strategy on Hyperliquid (Part 2 stretch) ===
  /**
   * Kill switch for the vol-arb strategy. Default OFF — operator turns
   * on after eyeballing the signals on the dashboard. Independent of
   * `hlExecutionEnabled` (which gates the Polymarket hedge leg).
   */
  volArbEnabled: z.boolean().default(false),
  /**
   * Open trigger: if |Predict ATM IV − HL realized vol| exceeds this, AND
   * the SVI surface has a clear directional bias, open a perp position.
   * In vol points (0.05 = 5%). Default 0.05.
   */
  volArbIvSpreadOpenThreshold: z.number().positive().default(0.05),
  /**
   * Close trigger: if |IV − RV| falls below this after a trade is open,
   * close. Default 0.02 (smaller than open threshold for hysteresis).
   */
  volArbIvSpreadCloseThreshold: z.number().nonnegative().default(0.02),
  /**
   * Directional bias threshold from Predict's surface. The bot picks a
   * direction only when P(spot > strike at expiry, evaluated at K=spot)
   * exceeds `0.5 + volArbDirectionBiasThreshold` (long) or is below
   * `0.5 − volArbDirectionBiasThreshold` (short). Default 0.03.
   */
  volArbDirectionBiasThreshold: z.number().min(0).max(0.5).default(0.03),
  /**
   * Bias-gate bypass: when the IV-RV spread exceeds this magnitude, the
   * surface-neutrality check is skipped. Rationale: at extreme vol
   * divergences (e.g. IV 34% vs RV 11.5%), the vol thesis dominates and
   * directional conviction is no longer required — even a "wrong
   * direction" trade still profits if vol arrives.
   *
   * Default 0.15 (15 vol points). Set to a high value (e.g. 1.0) to
   * effectively disable the bypass and always require directional bias.
   */
  volArbBiasBypassSpread: z.number().min(0).max(2).default(0.15),
  /** Per-trade USD-notional cap on vol-arb perp positions. */
  maxVolArbPerTradeUsdc: z.number().positive().default(2),
  /** Total open vol-arb exposure cap (USD). */
  maxVolArbOpenUsdc: z.number().positive().default(10),
  /** Daily vol-arb loss limit (USD); auto-pauses on breach. */
  dailyVolArbLossLimitUsdc: z.number().positive().default(5),
  /** Maximum time a vol-arb position stays open before time-stop close. */
  volArbTimeStopMinutes: z.number().positive().default(60),
  /** Min realized-vol samples in the rolling buffer before the strategy
   *  fires. Below this we're still warming up. */
  volArbMinSamples: z.number().int().positive().default(30),
  /** Vol-arb sampler/decision tick — runs on its OWN timer, decoupled from
   *  the poly-arb 15s loop. See tunables.ts for the explanation. */
  volArbTickMs: z.number().int().positive().default(2_000),
  /** Predict ATM-IV cache TTL — the vol-arb fast ticker reuses the snapshot
   *  for this many ms before re-fetching. */
  volArbOracleCacheMs: z.number().int().positive().default(30_000),

  // Margin-Lever (paper). Gated entirely in v1 — never sends a tx.
  marginLeverEnabled: z.boolean().default(false),
  marginLeverOpenBias: z.number().min(0).max(0.5).default(0.10),
  marginLeverCloseBias: z.number().min(0).max(0.5).default(0.04),
  marginLeverMaxHoldMinutes: z.number().positive().default(45),
  marginLeverPerTradeNotionalUsdc: z.number().positive().default(500),
  marginLeverMaxBorrowNotionalUsdc: z.number().positive().default(1500),
  marginLeverDailyLossLimitUsdc: z.number().positive().default(100),
  marginLeverTickMs: z.number().int().positive().default(15_000),
  /** Master switch for mid-life Polymarket exits. */
  polyEarlyExitEnabled: z.boolean().default(true),
  /** Profit-take fraction (vs cost) at which we sell the poly leg early. */
  polyEarlyExitMinProfitFrac: z.number().positive().default(0.2),
  /** When true, the bot clears any persisted pause on startup so a fresh
   *  deploy boots into a trading state. */
  autoResumeOnBoot: z.boolean().default(true),

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
  // Env-driven fields: secrets, network choices, execution gates, RPC URLs,
  // and instance/infra identity. Everything else flows from TUNABLES so
  // strategy params can be tweaked by editing tunables.ts directly.
  return Schema.parse({
    // ── Execution gates (env — safety + per-deployment) ──
    paperTrading: parseBool(process.env.PAPER_TRADING, true),
    polyExecutionEnabled: parseBool(process.env.POLY_EXECUTION_ENABLED, false),
    hlExecutionEnabled: parseBool(process.env.HL_EXECUTION_ENABLED, false),
    // HARD OFF (2026-07 audit): the IV-RV perp strategy paid $29.12 in fees
    // to flip a coin 2,600 times (direction PnL −$1.80 over 5,219 fills —
    // reconciled to the cent against HL's own records). A perp has no vega;
    // an IV−RV spread cannot be harvested with a delta-one instrument. The
    // env var is deliberately ignored so a stale MAINNET_VOL_ARB_ENABLED=true
    // can't resurrect it; re-enabling requires a code change and a real
    // edge argument. The ticker still runs for telemetry + RV sampling
    // (the convergence strategy consumes the mid history).
    volArbEnabled: false,
    marginLeverEnabled: parseBool(process.env.MARGIN_LEVER_ENABLED, false),

    // ── Network choices (env — per-deployment) ──
    polyNetwork: (process.env.POLY_NETWORK as 'amoy' | 'polygon' | undefined) ?? 'amoy',
    polyClobHost: process.env.POLY_CLOB_HOST ?? '',
    polyRpcUrl: process.env.POLY_RPC_URL ?? '',
    polySignatureType:
      (process.env.POLY_SIGNATURE_TYPE as
        | 'EOA'
        | 'POLY_PROXY'
        | 'POLY_GNOSIS_SAFE'
        | 'POLY_1271'
        | undefined) ?? 'EOA',
    polyFunderAddress: process.env.POLY_FUNDER_ADDRESS ?? '',
    hlNetwork: (process.env.HL_NETWORK as 'mainnet' | 'testnet' | undefined) ?? 'mainnet',

    // ── Infra identity (env) ──
    dataDir: process.env.SVX_DATA_DIR ?? path.join(WORKSPACE_ROOT, 'data'),
    apiHost: process.env.SVX_API_HOST ?? '127.0.0.1',
    apiPort: parseNum(process.env.SVX_API_PORT, 4321),
    instanceLabel: process.env.SVX_INSTANCE_LABEL ?? '',

    // ── Strategy tunables (from tunables.ts) ──
    spreadThreshold: TUNABLES.spreadThreshold,
    maxPositionDusdc: TUNABLES.maxPositionDusdc,
    maxPositionPct: TUNABLES.maxPositionPct,
    dailyLossLimitDusdc: TUNABLES.dailyLossLimitDusdc,
    maxOpenPositions: TUNABLES.maxOpenPositions,
    maxPositionsPerSignal: TUNABLES.maxPositionsPerSignal,
    minPredictProb: TUNABLES.minPredictProb,
    maxPredictProb: TUNABLES.maxPredictProb,
    signalLogMinSpreadFrac: TUNABLES.signalLogMinSpreadFrac,
    maxSviStalenessSec: TUNABLES.maxSviStalenessSec,
    polyMaxBidaskVolPts: TUNABLES.polyMaxBidaskVolPts,
    polyMinVolume24hUsd: TUNABLES.polyMinVolume24hUsd,
    expiryToleranceSec: TUNABLES.expiryToleranceSec,
    circuitBreakerLosses: TUNABLES.circuitBreakerLosses,
    polymarketGammaBase: TUNABLES.polymarketGammaBase,
    polymarketClobBase: TUNABLES.polymarketClobBase,
    maxPolyPositionUsdc: TUNABLES.maxPolyPositionUsdc,
    maxOpenPolyPositions: TUNABLES.maxOpenPolyPositions,
    polyMinBookDepthShares: TUNABLES.polyMinBookDepthShares,
    polyMinOrderUsdc: TUNABLES.polyMinOrderUsdc,
    polyFillFailedCooldownMs: TUNABLES.polyFillFailedCooldownMs,
    dailyPolyLossLimitUsdc: TUNABLES.dailyPolyLossLimitUsdc,
    polyFillTimeoutMs: TUNABLES.polyFillTimeoutMs,
    polyStaleSettlementDays: TUNABLES.polyStaleSettlementDays,
    predictStaleRedeemHours: TUNABLES.predictStaleRedeemHours,
    polyStopLossFrac: TUNABLES.polyStopLossFrac,
    polyReentryCooldownMs: TUNABLES.polyReentryCooldownMs,
    polyMinEntryPrice: TUNABLES.polyMinEntryPrice,
    polyMaxEntryPrice: TUNABLES.polyMaxEntryPrice,
    polyMinEvFrac: TUNABLES.polyMinEvFrac,
    convergenceEnabled: TUNABLES.convergenceEnabled,
    convergenceMaxMinutes: TUNABLES.convergenceMaxMinutes,
    convergenceMinMinutes: TUNABLES.convergenceMinMinutes,
    convergenceMinSigma: TUNABLES.convergenceMinSigma,
    convergenceSigmaSafetyMult: TUNABLES.convergenceSigmaSafetyMult,
    convergenceMinRvHistoryMs: TUNABLES.convergenceMinRvHistoryMs,
    convergenceStrikeBandLoFrac: TUNABLES.convergenceStrikeBandLoFrac,
    convergenceStrikeBandHiFrac: TUNABLES.convergenceStrikeBandHiFrac,
    convergenceStopLossFrac: TUNABLES.convergenceStopLossFrac,
    convergenceMinPrice: TUNABLES.convergenceMinPrice,
    convergenceMaxPrice: TUNABLES.convergenceMaxPrice,
    convergenceMinEvFrac: TUNABLES.convergenceMinEvFrac,
    maxConvergencePerTradeUsdc: TUNABLES.maxConvergencePerTradeUsdc,
    convergenceCheckIntervalMs: TUNABLES.convergenceCheckIntervalMs,
    polyRedeemRetryGapMs: TUNABLES.polyRedeemRetryGapMs,
    polyRedeemMaxAttempts: TUNABLES.polyRedeemMaxAttempts,
    reconcileDriftThresholdUsdc: TUNABLES.reconcileDriftThresholdUsdc,
    hlHedgeEnabled: TUNABLES.hlHedgeEnabled,
    hlHedgeAsset: TUNABLES.hlHedgeAsset,
    hlMinOrderUsdc: TUNABLES.hlMinOrderUsdc,
    hlTakerFeeRate: TUNABLES.hlTakerFeeRate,
    maxHlPerTradeUsdc: TUNABLES.maxHlPerTradeUsdc,
    maxHlOpenUsdc: TUNABLES.maxHlOpenUsdc,
    dailyHlLossLimitUsdc: TUNABLES.dailyHlLossLimitUsdc,
    hlRequiredForPoly: TUNABLES.hlRequiredForPoly,
    volArbIvSpreadOpenThreshold: TUNABLES.volArbIvSpreadOpenThreshold,
    volArbIvSpreadCloseThreshold: TUNABLES.volArbIvSpreadCloseThreshold,
    volArbDirectionBiasThreshold: TUNABLES.volArbDirectionBiasThreshold,
    volArbBiasBypassSpread: TUNABLES.volArbBiasBypassSpread,
    maxVolArbPerTradeUsdc: TUNABLES.maxVolArbPerTradeUsdc,
    maxVolArbOpenUsdc: TUNABLES.maxVolArbOpenUsdc,
    dailyVolArbLossLimitUsdc: TUNABLES.dailyVolArbLossLimitUsdc,
    volArbTimeStopMinutes: TUNABLES.volArbTimeStopMinutes,
    volArbMinSamples: TUNABLES.volArbMinSamples,
    volArbTickMs: TUNABLES.volArbTickMs,
    volArbOracleCacheMs: TUNABLES.volArbOracleCacheMs,
    marginLeverOpenBias: TUNABLES.marginLeverOpenBias,
    marginLeverCloseBias: TUNABLES.marginLeverCloseBias,
    marginLeverMaxHoldMinutes: TUNABLES.marginLeverMaxHoldMinutes,
    marginLeverPerTradeNotionalUsdc: TUNABLES.marginLeverPerTradeNotionalUsdc,
    marginLeverMaxBorrowNotionalUsdc: TUNABLES.marginLeverMaxBorrowNotionalUsdc,
    marginLeverDailyLossLimitUsdc: TUNABLES.marginLeverDailyLossLimitUsdc,
    marginLeverTickMs: TUNABLES.marginLeverTickMs,
    polyEarlyExitEnabled: TUNABLES.polyEarlyExitEnabled,
    polyEarlyExitMinProfitFrac: TUNABLES.polyEarlyExitMinProfitFrac,
    autoResumeOnBoot: TUNABLES.autoResumeOnBoot,
    loopIntervalMs: TUNABLES.loopIntervalMs,
  });
}

export function dataPath(file: string, cfg: SvxConfig = loadConfig()): string {
  return path.resolve(cfg.dataDir, file);
}
