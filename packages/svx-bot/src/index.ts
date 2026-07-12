/**
 * SVX main scheduler.
 *
 * Loop:
 *   1. Refresh active Predict oracles + their SVI/price snapshots.
 *   2. Refresh Polymarket BTC strike markets.
 *   3. Match by (expiry within tolerance, strike on grid).
 *   4. For each match: fetch live order book, compute spread, filter, decide.
 *   5. For threshold-crossing decisions: size, risk-check, log paper trade.
 *      (Phase 3 will append on-chain submission here once dUSDC is funded.)
 *   6. Reconcile settlements: if any oracle settled, settle paper trades.
 *
 * Loop runs every `cfg.loopIntervalMs` (default 15s).
 */

import path from 'node:path';
import fs from 'node:fs';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ADDRESSES, isAddressPinned } from 'svx-shared/addresses';
import { QUOTE_UNIT } from 'svx-shared/constants';
import type {
  OracleSnapshot,
  PolymarketSnapshot,
  SignalAction,
  SignalRecord,
} from 'svx-shared/types';
import { loadConfig, type SvxConfig } from './config.js';
import { LedgerStore } from './ledger/store.js';
import { PredictClient } from './pricing/predict.js';
import {
  PolymarketClient,
  type PolyOrderBook,
  type PolyStrikeMarket,
} from './pricing/polymarket.js';
import { matchOraclesToPoly } from './signal/match.js';
import { computeSpread } from './signal/spread.js';
import { applyFilters } from './signal/filter.js';
import { sizeTrade } from './exec/sizer.js';
import { RiskGate } from './exec/risk.js';
import { buildMintTx, buildRedeemTx } from './exec/ptb.js';
import { submitTx } from './exec/submit.js';
import { loadOperatorKey } from './exec/keypair.js';
import { readManagerDusdcBalance } from './exec/manager-balance.js';
import {
  PolymarketExecClient,
  parsePolyFillResponse,
  tryCreatePolymarketExecClient,
  isMakerNotAllowedError,
} from './exec/polymarket-client.js';
import {
  HyperliquidExecClient,
  tryCreateHyperliquidExecClient,
} from './exec/hyperliquid-client.js';
import { sizePolyOrder } from './exec/poly-order-sizer.js';
import { hedgeSizeForPolyFill } from './pricing/binary-delta.js';
import {
  appendMid as appendVolArbMid,
  btcSizeForUsdNotional,
  computePredictAtmIv,
  computePredictUpAtSpot,
  computeRealizedVol,
  decide as decideVolArb,
  freshVolArbState,
  recordDecision as recordVolArbDecision,
  type VolArbState,
} from './strategy/vol-arb.js';
import {
  applyDecision as applyMarginLeverDecision,
  decide as decideMarginLever,
  freshMarginLeverState,
  realizedPnlSince as marginLeverRealizedPnlSince,
  type MarginLeverState,
} from './strategy/margin-lever.js';
import { decideConvergence, sigmaDistance } from './strategy/convergence.js';
import { decideFavoredMint, type FavoredMintGates } from './strategy/divergence-mint.js';
import { findCrossedStrikes } from './strategy/butterfly.js';
import { sviTotalVariance } from './pricing/svi-arb.js';
import { erf } from './pricing/bs.js';
import { startApiServer } from './api/server.js';
import { log } from './util/log.js';

interface BotState {
  startedAtMs: number;
  /** Sui operator address — populated when live or when paper-mode loads
   *  the keypair for dashboard display. Null when no keypair is configured. */
  suiAddress?: string;
  /** Sui PredictManager object ID — populated alongside suiAddress in live mode. */
  managerId?: string;
  /** Operator wallet dUSDC balance (live mode) or virtual budget (paper). */
  navUsdc: number;
  /** dUSDC sitting inside the PredictManager — payouts from auto-redeem land
   *  here. The dashboard surfaces this separately so the operator can see
   *  their full bankroll (wallet + manager). */
  managerBalanceUsdc: number;
  /** Last time we refreshed the on-chain manager balance. */
  lastManagerBalanceAtMs: number;
  /** Last time we ran prune+vacuum on the SQLite ledger. */
  lastPruneAtMs: number;
  /** Last butterfly-telemetry surface scan. */
  lastButterflyCheckMs: number;
  /** Most recent BTC spot from the freshest oracle snapshot. Populated by the
   *  main loop on each iteration so the dashboard can colour open positions
   *  ITM/OTM without making its own oracle calls. */
  lastBtcSpot?: { value: number; updatedAtMs: number };
  /** Polymarket pUSD + gas balance, refreshed periodically when polyExec is
   *  configured. Surfaced on /status so the dashboard can show poly bankroll.
   *  `address` = the FUNDER (Safe in POLY_GNOSIS_SAFE mode, EOA in EOA mode).
   *  `signerAddress` = always the EOA. */
  polyBalance?: {
    address: `0x${string}`;
    network: 'amoy' | 'polygon';
    pUsd: number;
    gasPol: number;
    signerAddress?: `0x${string}`;
    signatureMode?: 'EOA' | 'POLY_PROXY' | 'POLY_GNOSIS_SAFE' | 'POLY_1271';
    updatedAtMs: number;
  };
  /** Last time we refreshed the Polymarket balance from on-chain. */
  lastPolyBalanceAtMs: number;
  /** Wallet-vs-ledger reconciliation invariant — recomputed on every poly
   *  balance refresh. `driftUsdc` should hover near 0; breaching the
   *  threshold pauses the bot (the July-incident class of silent booking
   *  bug shows up HERE regardless of which query is broken). */
  polyReconcile?: {
    baselineUsdc: number;
    baselineSetAtMs: number;
    driftUsdc: number;
    thresholdUsdc: number;
    unredeemedPayoutUsdc: number;
    checkedAtMs: number;
  };
  /** Consecutive balance-refresh cycles the drift has exceeded the
   *  threshold. A single breach is usually settlement latency — the ledger
   *  marks an early-exit/redeem closed the instant the sell/redeem call
   *  returns, but the actual pUSD credit can lag a poll cycle. Only pausing
   *  on a CONFIRMED (2nd consecutive) breach filters that out without
   *  weakening the check against a real, persistent booking bug — one
   *  costs an extra ~60s of exposure, the other means real drift and
   *  real trading resume every day. */
  polyReconcileBreachStreak: number;
  /** Hyperliquid margin balance — populated when hlExec is configured.
   *  Surfaces on /status so the dashboard's health panel can show whether
   *  the HL leg is ready to fire. */
  hlBalance?: {
    address: `0x${string}`;
    network: 'mainnet' | 'testnet';
    accountValueUsdc: number;
    withdrawableUsdc: number;
    updatedAtMs: number;
  };
  /** Hyperliquid on-chain open positions — truth-from-chain. The bot's
   *  ledger tracks hedges it OPENED, but HL state might have arbitrary
   *  positions (operator manual trades, force-hl-trade tests). The
   *  /wallets page compares this to the ledger to spot drift. */
  hlPositions?: Array<{
    asset: string;
    side: 'long' | 'short';
    szi: number;
    entryPx: number;
    unrealizedPnlUsd: number;
    cumFundingUsdc: number;
  }>;
  /** Last time we refreshed the HL balance via clearinghouseState. */
  lastHlBalanceAtMs: number;
  /** Last time the bot attempted a Polymarket fill (success or fail). 0 if never. */
  lastPolyAttemptAtMs: number;
  /** tokenId → ms of last fill_failed. Used to skip retries during the
   *  cooldown window so a stuck-on-thin-book signal doesn't spam the CLOB. */
  polyFillFailedAt: Map<string, number>;
  /** tokenId → ms of last SUCCESSFUL entry. Enforces polyReentryCooldownMs:
   *  an early exit frees the concentration slot, and without this gate the
   *  very next loop re-bought the same market at a worse price. */
  polyEntryAt: Map<string, number>;
  /** Set when the Polymarket leg needs an operator refill (wallet out of pUSD
   *  or allowance drained). Poly submits skip while set; vol-arb + Predict
   *  keep trading. Cleared on process restart after refill. Using a
   *  Poly-only flag instead of the global RiskGate pause keeps unrelated
   *  strategies alive. */
  polyDisabledReason?: string;
  /** Last time the bot attempted an HL hedge (success or fail). 0 if never. */
  lastHlAttemptAtMs: number;
  /** Last time we polled gamma for Polymarket settlement / ran auto-redeem.
   *  UMA resolves markets hours after expiry, so 5-min cadence is plenty. */
  lastPolySettlementCheckMs: number;
  /** Last time the expiry-convergence walker scanned near-expiry markets. */
  lastConvergenceCheckMs: number;
  /** Vol-arb strategy state — in-memory rolling buffer + last decision. */
  volArb: VolArbState;
  /** Margin-Lever (paper) strategy state — see strategy/margin-lever.ts. */
  marginLever: MarginLeverState;
  /**
   * Cached shortest-expiry BTC oracle snapshot for the vol-arb fast ticker.
   * Refreshed every `cfg.volArbOracleCacheMs` so a 2s ticker doesn't pay
   * Predict's REST latency on every iteration — ATM IV moves slowly relative
   * to HL mid, so this is essentially free signal.
   */
  cachedAtmIvSnapshot?: { snap: OracleSnapshot; computedAtMs: number };
}

const MANAGER_BALANCE_REFRESH_MS = 30_000;
const POLY_BALANCE_REFRESH_MS = 60_000;
const HL_BALANCE_REFRESH_MS = 60_000;
const POLY_SETTLEMENT_CHECK_INTERVAL_MS = 5 * 60_000; // every 5 minutes — UMA resolution takes hours, no benefit polling faster

const PRUNE_INTERVAL_MS = 6 * 3600_000; // every 6 hours
const RETENTION = {
  // Bumped 50k → 250k for the 2026-07 prize week: at ~20k signals/day the
  // old cap held only ~2.5 days, which starves the /backtest endpoint of a
  // meaningful validation window for the divergence-mint strategy (each
  // independent ≥8pp opportunity needs its oracle to also SETTLE inside the
  // window). 250k ≈ 12 days ≈ ~100MB of sqlite — fine on the volume.
  signalsKeep: 250_000,
  sviSnapshotsKeep: 20_000, // surface viewer history
  polySnapshotsKeep: 50_000,
  navSnapshotsKeep: 10_000,
};

interface LiveContext {
  sui: SuiClient;
  keypair: Ed25519Keypair;
  managerId: string;
  operatorAddress: string;
}

const PAPER_INITIAL_NAV = 10_000;

export async function runBot(opts: { onceOnly?: boolean } = {}): Promise<void> {
  const cfg = loadConfig();
  const dataDir = path.resolve(cfg.dataDir);
  const ledger = new LedgerStore(path.join(dataDir, 'svx.sqlite'));
  const risk = new RiskGate(ledger, cfg);
  const predict = new PredictClient();
  const poly = new PolymarketClient(cfg.polymarketGammaBase, cfg.polymarketClobBase);

  // Clear any persisted pause flag if configured (default OFF since the
  // 2026-07 audit — a crash-looping process must not un-pause itself). Even
  // when enabled, the boot path NEVER removes the operator's manual kill
  // flag: /tmp/svx-paused only goes away via an explicit `svx resume`.
  if (cfg.autoResumeOnBoot) {
    const prior = risk.isPaused();
    if (prior.paused) {
      log.warn('svx.boot.auto_resume', {
        priorReason: prior.reason ?? 'unknown',
        note: 'autoResumeOnBoot=true in tunables.ts cleared a persisted pause',
      });
    }
    risk.resume({ clearManualFlag: false });
  } else {
    const prior = risk.isPaused();
    if (prior.paused) {
      log.warn('svx.boot.paused', {
        reason: prior.reason ?? 'unknown',
        note: 'persisted pause carried over from the previous process; run `svx resume` to trade',
      });
    }
  }

  // One-shot stale-redeem cleanup on boot. The periodic prune handles this
  // long-term every 6h, but on a fresh deploy we want any pre-existing
  // stuck redeem queue cleared immediately so the bot stops spamming
  // svx.redeem.failed every 15s from the first loop iteration.
  // Predict cutoff is HOURS not days — oracles settle in 15 min so a
  // redeem either succeeds quickly or it's a permanent MoveAbort(1).
  {
    const staleAgeMs = cfg.predictStaleRedeemHours * 3600_000;
    const cleared = ledger.abandonStaleRedeems(staleAgeMs, Date.now());
    if (cleared > 0) {
      log.warn('svx.boot.abandoned_stale_redeems', {
        count: cleared,
        olderThanHours: cfg.predictStaleRedeemHours,
        note: 'positions likely pruned from on-chain predict_manager; retry was failing forever',
      });
    }
  }

  // Also reconcile poly_arb HL hedges whose Predict expired long ago but whose
  // ledger row still says hl_status='open'. Cause: the HL-close path only
  // fires when Polymarket settles via UMA — if UMA never confirms (orphan
  // markets, neg-risk cleanup), the HL leg lingers as "open" forever and
  // openHlExposureUsdc reports phantom risk. Give expired Predict trades a
  // 24h grace so we don't step on genuinely in-flight closes.
  {
    const reconciled = ledger.abandonStaleHlLegs(24 * 3600_000, Date.now());
    if (reconciled > 0) {
      log.warn('svx.boot.reconciled_stale_hl_legs', {
        count: reconciled,
        note: 'HL positions long since flat on-chain; ledger drift from orphan UMA settlements',
      });
    }
  }

  // One-shot repair for the 2026-07 settlement incident: rows force-abandoned
  // (booked as full-cost losses) while getMarketResolution was silently
  // broken (missing closed=true — gamma hides closed markets by default, so
  // resolution was NEVER observed; 0 of 307 lifetime closures came from UMA).
  // Re-queue them through the now-working settlement poll: real losses
  // re-book as losses within one cycle, and any abandoned WINNER gets its
  // true payout booked + shares redeemed instead of written off.
  {
    const requeued = ledger.resetAbandonedPolyTrades();
    if (requeued > 0) {
      log.warn('svx.boot.requeued_abandoned_poly', {
        count: requeued,
        note: 'will re-settle with true outcomes via gamma closed=true within one settlement cycle',
      });
    }
  }

  const state: BotState = {
    startedAtMs: Date.now(),
    navUsdc: PAPER_INITIAL_NAV,
    managerBalanceUsdc: 0,
    lastManagerBalanceAtMs: 0,
    lastPruneAtMs: 0,
    lastPolyBalanceAtMs: 0,
    polyReconcileBreachStreak: 0,
    lastHlBalanceAtMs: 0,
    lastPolyAttemptAtMs: 0,
    lastHlAttemptAtMs: 0,
    lastPolySettlementCheckMs: 0,
    lastConvergenceCheckMs: 0,
    lastButterflyCheckMs: 0,
    polyFillFailedAt: new Map(),
    polyEntryAt: new Map(),
    volArb: freshVolArbState(),
    marginLever: freshMarginLeverState(),
  };

  // Rebuild the re-entry cooldown map from the ledger so a redeploy can't
  // bypass polyReentryCooldownMs — the in-memory map was the only thing
  // standing between an early exit and an immediate worse-priced re-buy
  // (the July-2 churn), and it used to die with the process.
  for (const { tokenId, lastEntryMs } of ledger.recentPolyEntryTimes(
    Date.now() - cfg.polyReentryCooldownMs,
  )) {
    state.polyEntryAt.set(tokenId, lastEntryMs);
  }

  // If we have an operator key + manager record, read the real wallet balance
  // for the dashboard NAV display, even in paper mode. Live mode below uses
  // the same value; paper mode just reports it but uses the PAPER_INITIAL_NAV
  // virtual budget for sizing.
  let realWalletReader: undefined | (() => Promise<number>);

  // Live-trading context — only loaded when paperTrading is false. The
  // operator must have run `setup-manager` first.
  let live: LiveContext | undefined;
  if (!cfg.paperTrading) {
    const operatorFile = path.join(dataDir, 'operator.json');
    let op: { operatorAddress: string; managerId: string };
    // Coolify-friendly: allow injecting the operator record via env var
    // (OPERATOR_JSON) instead of a file. Falls back to the on-disk file.
    if (process.env.OPERATOR_JSON) {
      op = JSON.parse(process.env.OPERATOR_JSON);
    } else if (fs.existsSync(operatorFile)) {
      op = JSON.parse(fs.readFileSync(operatorFile, 'utf8'));
    } else {
      throw new Error(
        `Live trading enabled but no operator record found. Set OPERATOR_JSON env var or run \`pnpm --filter svx-bot setup-manager\` to write ${operatorFile}.`,
      );
    }
    const { keypair, address } = loadOperatorKey();
    if (address.toLowerCase() !== op.operatorAddress.toLowerCase()) {
      throw new Error(
        `operator.json says address ${op.operatorAddress} but loaded keypair is ${address}. Refusing to live-trade.`,
      );
    }
    live = {
      sui: new SuiClient({ url: ADDRESSES.rpcUrl }),
      keypair,
      managerId: op.managerId,
      operatorAddress: op.operatorAddress,
    };
    state.suiAddress = op.operatorAddress;
    state.managerId = op.managerId;
    realWalletReader = () => readManagerBalance(live!);
    // Refresh NAV (operator wallet) and manager balance from on-chain.
    state.navUsdc = await realWalletReader();
    state.managerBalanceUsdc = await readManagerDusdcBalance(
      live.sui,
      live.managerId,
      live.operatorAddress,
    );
    state.lastManagerBalanceAtMs = Date.now();
    log.info('svx.live.context_loaded', {
      operator: op.operatorAddress,
      manager: op.managerId,
      walletDusdc: state.navUsdc,
      managerDusdc: state.managerBalanceUsdc,
    });
  } else {
    // Paper mode: also try to read the real wallet for dashboard display only.
    // If the operator key isn't present (e.g. SUI_PRIVATE_KEY_BECH32 unset on
    // a fresh instance), silently fall back to the virtual NAV.
    try {
      const { loadOperatorKey: tryLoad } = await import('./exec/keypair.js');
      const { keypair, address } = tryLoad();
      state.suiAddress = address;
      const sui = new SuiClient({ url: ADDRESSES.rpcUrl });
      realWalletReader = async () => {
        const { totalBalance } = await sui.getBalance({ owner: address, coinType: ADDRESSES.dusdcType });
        return Number(totalBalance) / Number(QUOTE_UNIT);
      };
      const real = await realWalletReader();
      state.navUsdc = real;
      log.info('svx.paper.real_wallet_loaded', { address, navDusdc: real, virtualBudget: PAPER_INITIAL_NAV });
      void keypair; // marked used
    } catch {
      // No keypair available — keep the virtual NAV, log nothing (this is the
      // expected path for fresh instances without a configured operator).
    }
  }

  // Polymarket client — loaded whenever POLY_PRIVATE_KEY + L2 creds exist,
  // independent of POLY_EXECUTION_ENABLED. The flag only gates ORDER
  // submission downstream; balance/orderbook reads always work so the
  // dashboard can surface the wallet state ahead of going live.
  const polyExec = tryCreatePolymarketExecClient(cfg);
  const hlExec = tryCreateHyperliquidExecClient();
  if (hlExec) {
    log.info(cfg.hlExecutionEnabled ? 'svx.hl.exec_enabled' : 'svx.hl.read_only', {
      address: hlExec.address,
      network: hlExec.endpoints.network,
      hedgeAsset: cfg.hlHedgeAsset,
      maxHlPerTradeUsdc: cfg.maxHlPerTradeUsdc,
      maxHlOpenUsdc: cfg.maxHlOpenUsdc,
    });
  }
  if (polyExec) {
    log.info(cfg.polyExecutionEnabled ? 'svx.poly.exec_enabled' : 'svx.poly.read_only', {
      address: polyExec.address,
      network: polyExec.endpoints.network,
      clobHost: polyExec.endpoints.clobHost,
      executionEnabled: cfg.polyExecutionEnabled,
      perTradeCapUsdc: cfg.maxPolyPositionUsdc,
      maxOpenPositions: cfg.maxOpenPolyPositions,
    });

    // One-shot backlog cleanup: rows the ledger still calls "unredeemed"
    // whose on-chain balance is already zero — money claimed manually
    // through Polymarket's UI (the only path in non-EOA signature modes;
    // see reconcileExternallyRedeemedPositions doc comment) that the ledger
    // never observed. Runs again periodically from the main loop for
    // anything claimed after boot.
    try {
      await reconcileExternallyRedeemedPositions({ polyExec, ledger });
    } catch (e) {
      log.warn('svx.boot.onchain_redeem_reconcile_error', { err: errMsg(e) });
    }
  }

  // Boot the API server for the dashboard. The server is read-only.
  // Skip the server in --once mode so the process can exit cleanly.
  let stopApi: (() => void) | undefined;
  if (!opts.onceOnly) {
    const { stop } = startApiServer({
      ledger,
      cfg,
      state,
      predict,
      addresses: ADDRESSES,
    });
    stopApi = stop;
  }

  log.info('svx.boot', {
    paperTrading: cfg.paperTrading,
    spreadThreshold: cfg.spreadThreshold,
    expiryToleranceSec: cfg.expiryToleranceSec,
    addressesPinned: isAddressPinned(ADDRESSES.packageId),
    apiAt: `http://${cfg.apiHost}:${cfg.apiPort}`,
    volArbTickMs: cfg.volArbTickMs,
  });

  // Vol-arb fast ticker — decoupled from the poly-arb loop below. Runs every
  // cfg.volArbTickMs (default 2s) so signal detection and order submission
  // aren't gated by Polymarket HTTP latency. Only spawned when HL credentials
  // are present (read-only or live); skipped in --once mode.
  let volArbTimer: NodeJS.Timeout | undefined;
  if (!opts.onceOnly && hlExec) {
    let volArbInFlight = false;
    volArbTimer = setInterval(() => {
      // Skip if the prior tick is still running — happens if a Predict call
      // stalls past the 2s cadence. Better to drop a tick than queue.
      if (volArbInFlight) return;
      volArbInFlight = true;
      runVolArbStep({ cfg, state, ledger, risk, hlExec, predict })
        .catch((e) => log.warn('svx.vol_arb.step_error', { err: errMsg(e) }))
        .finally(() => {
          volArbInFlight = false;
        });
    }, cfg.volArbTickMs);
    log.info('svx.vol_arb.ticker_started', {
      tickMs: cfg.volArbTickMs,
      minSamples: cfg.volArbMinSamples,
      oracleCacheMs: cfg.volArbOracleCacheMs,
      enabled: cfg.volArbEnabled,
    });
  }
  // The convergence strategy's realized-vol input comes from this ticker's
  // mid sampling. Without HL credentials the sampler never runs, sigma stays
  // NaN, and convergence silently never trades — make that loud at boot.
  if (!hlExec && cfg.convergenceEnabled && cfg.polyExecutionEnabled) {
    log.warn('svx.convergence.no_rv_sampler', {
      note:
        'convergenceEnabled=true but no HL_PRIVATE_KEY — the RV sampler (vol-arb ticker) is not running, so the convergence strategy will never fire. Set HL creds (read-only is enough) or disable convergence.',
    });
  }

  // Margin-Lever paper ticker — third strategy, independent loop. Always
  // safe to run because it never sends a transaction in v1 (paper-mode
  // only). Doesn't gate on hlExec because it doesn't trade HL.
  let marginLeverTimer: NodeJS.Timeout | undefined;
  if (!opts.onceOnly) {
    let marginLeverInFlight = false;
    marginLeverTimer = setInterval(() => {
      if (marginLeverInFlight) return;
      marginLeverInFlight = true;
      runMarginLeverStep({ cfg, state, predict })
        .catch((e) => log.warn('svx.margin_lever.step_error', { err: errMsg(e) }))
        .finally(() => {
          marginLeverInFlight = false;
        });
    }, cfg.marginLeverTickMs);
    log.info('svx.margin_lever.ticker_started', {
      tickMs: cfg.marginLeverTickMs,
      enabled: cfg.marginLeverEnabled,
      mode: 'paper',
    });
  }

  while (true) {
    const t0 = Date.now();
    try {
      await runOnce({
        cfg,
        state,
        ledger,
        risk,
        predict,
        poly,
        live,
        polyExec: polyExec ?? undefined,
        hlExec: hlExec ?? undefined,
      });
    } catch (e) {
      log.error('svx.loop.error', { err: errMsg(e), stack: errStack(e) });
    }
    if (opts.onceOnly) {
      if (volArbTimer) clearInterval(volArbTimer);
      if (marginLeverTimer) clearInterval(marginLeverTimer);
      stopApi?.();
      ledger.close();
      return;
    }
    const elapsed = Date.now() - t0;
    const wait = Math.max(0, cfg.loopIntervalMs - elapsed);
    await sleep(wait);
  }
}

/** Round to the CLOB's default 1¢ tick — order prices must sit on the grid. */
function roundTo2(x: number): number {
  return Math.round(x * 100) / 100;
}

async function getOperatorDusdcCoinIds(live: LiveContext): Promise<string[]> {
  const coins = await live.sui.getCoins({
    owner: live.operatorAddress,
    coinType: ADDRESSES.dusdcType,
  });
  return coins.data.map((c) => c.coinObjectId);
}

async function readManagerBalance(live: LiveContext): Promise<number> {
  // Use the manager's BalanceManager balance for our quote asset.
  // PredictManager exposes `balance<T>()` as a public function, but reading
  // it requires a Move call (devInspect). Simpler: query the manager object
  // directly and read the inner balance_manager balance field.
  // For now we approximate by summing dUSDC coins owned by the operator,
  // since the bot tops up the manager from the wallet on each mint.
  const { totalBalance } = await live.sui.getBalance({
    owner: live.operatorAddress,
    coinType: ADDRESSES.dusdcType,
  });
  return Number(totalBalance) / Number(QUOTE_UNIT);
}

interface LoopDeps {
  cfg: SvxConfig;
  state: BotState;
  ledger: LedgerStore;
  risk: RiskGate;
  predict: PredictClient;
  poly: PolymarketClient;
  live?: LiveContext;
  polyExec?: PolymarketExecClient;
  hlExec?: HyperliquidExecClient;
}

export async function runOnce(deps: LoopDeps): Promise<void> {
  const { cfg, state, ledger, risk, predict, poly, live, polyExec, hlExec } = deps;

  // 1. Pull active Predict oracles + Polymarket strike markets in parallel.
  const [oracles, polyMarkets] = await Promise.all([
    predict.listActiveOracles('BTC'),
    poly.listBtcStrikeMarkets(),
  ]);

  log.info('svx.loop.start', {
    activeOracles: oracles.length,
    polyMarkets: polyMarkets.length,
  });

  // 2. Reconcile settlements first — pull a fresh oracle list and settle any
  // newly-settled oracles in the local ledger.
  await reconcileSettlements(predict, ledger, live);

  // 2b. Reconcile Polymarket settlements — UMA resolves markets hours after
  // expiry, so we only poll every POLY_SETTLEMENT_CHECK_INTERVAL_MS.
  // Detect resolved markets, mark trades settled w/ payout+PnL, and submit
  // CTF redeem txs for winning positions. Runs in BOTH paper-Predict /
  // live-Poly mode (current state) and full-live mode (future).
  if (
    polyExec &&
    Date.now() - state.lastPolySettlementCheckMs > POLY_SETTLEMENT_CHECK_INTERVAL_MS
  ) {
    try {
      await reconcilePolySettlements(poly, polyExec, ledger, hlExec, cfg);
    } catch (e) {
      log.warn('svx.poly.settlement_loop_error', { err: errMsg(e) });
    }
    state.lastPolySettlementCheckMs = Date.now();
  }

  // 2c. Mid-life Polymarket exits — walk open poly positions, sell back via
  // marketSell when mark-to-market P&L crosses the profit-take threshold.
  // Predict's leg has no exit primitive so it still waits for settlement,
  // but the poly leg can be cashed any time — turns "hold for hours until
  // UMA resolves" into "lock in poly gains the moment they appear."
  if (polyExec && cfg.polyEarlyExitEnabled && cfg.polyExecutionEnabled) {
    try {
      await walkPolyEarlyExits({ poly, polyExec, hlExec, ledger, cfg });
    } catch (e) {
      log.warn('svx.poly.early_exit_loop_error', { err: errMsg(e) });
    }
  }

  // 2d. Expiry-convergence — buy the deep-ITM side of BTC dailies in their
  // final hour when realized vol says the strike is out of reach. Sigma
  // comes from the vol-arb ticker's always-on mid sampling. Throttled: the
  // edge is a price level (the discount), not a race.
  if (
    polyExec &&
    cfg.convergenceEnabled &&
    cfg.polyExecutionEnabled &&
    Date.now() - state.lastConvergenceCheckMs > cfg.convergenceCheckIntervalMs
  ) {
    state.lastConvergenceCheckMs = Date.now();
    try {
      await walkExpiryConvergence({ poly, polyExec, ledger, risk, cfg, state, polyMarkets });
    } catch (e) {
      log.warn('svx.convergence.loop_error', { err: errMsg(e) });
    }
  }

  // Refresh Polymarket pUSD + gas balance every POLY_BALANCE_REFRESH_MS.
  // Cheap (two RPC reads) but we throttle to avoid hammering the public RPC.
  //
  // Deliberately runs BEFORE the match-and-possibly-return below (moved here
  // 2026-07 alongside auto-redeem support) — this used to sit after the
  // match step, which meant any loop tick with zero active oracle/poly
  // matches skipped balance refresh AND the drift check entirely. With
  // auto-redeem enabled on Polymarket, claims land continuously and
  // silently; this must run on every tick regardless of match availability
  // or the drift alarm goes stale exactly when it matters most.
  if (
    polyExec &&
    Date.now() - state.lastPolyBalanceAtMs > POLY_BALANCE_REFRESH_MS
  ) {
    try {
      // Reconcile winnings claimed OUTSIDE the bot FIRST, before computing
      // drift. In every signature mode except EOA (POLY_1271, Safe, Proxy),
      // the bot cannot submit a redeem itself — Polymarket's UI or an
      // auto-redeem setting is the only path, and the ledger has no way to
      // observe that except by checking on-chain balance. Without this
      // ordering, a fresh auto-redeem lands in the wallet a full cycle
      // before the ledger's "unredeemed" total catches up, and the drift
      // check below would misread real, already-expected money as an
      // unexplained mismatch and pause the bot — the opposite of what
      // enabling auto-redeem is for.
      try {
        await reconcileExternallyRedeemedPositions({ polyExec, ledger });
      } catch (e) {
        log.warn('svx.poly.onchain_redeem_reconcile_error', { err: errMsg(e) });
      }

      const [pUsd, gas] = await Promise.all([
        polyExec.getCollateralBalance(),
        polyExec.getGasBalance(),
      ]);
      // address surfaces the FUNDER (Safe/proxy in POLY_GNOSIS_SAFE mode,
      // EOA in EOA mode) so the dashboard polygonscan link points to
      // where the money actually is. EOA (signer) is exposed separately
      // via state.polyExec for completeness.
      state.polyBalance = {
        address: polyExec.funderAddress,
        network: polyExec.endpoints.network,
        pUsd: pUsd.pUsd,
        gasPol: gas.eth,
        signerAddress: polyExec.address,
        signatureMode: polyExec.signatureMode,
        updatedAtMs: Date.now(),
      };
      state.lastPolyBalanceAtMs = Date.now();

      // ── Reconciliation invariant ──────────────────────────────────────
      // If every ledger write is truthful, (wallet − ledgerOffset) is a
      // constant (the baseline). Any silent booking bug — a settlement poll
      // that stops seeing losses, a phantom payout, an invisible position —
      // moves the wallet without moving the offset (or vice versa) and
      // shows up as drift. This is the control that would have caught the
      // 2026-07 incident weeks earlier, independent of WHERE the bug was.
      // Operator deposits/withdrawals legitimately move the baseline:
      // re-baseline after funding via `svx rebaseline`.
      try {
        const offset = ledger.polyLedgerOffsetUsdc();
        const unredeemed = ledger.unredeemedPolyPayoutUsdc();
        const impliedBaseline = pUsd.pUsd - offset;
        const rawBaseline = ledger.getMeta('poly_reconcile_baseline');
        if (rawBaseline === undefined) {
          ledger.setMeta(
            'poly_reconcile_baseline',
            JSON.stringify({ baselineUsdc: impliedBaseline, setAtMs: Date.now() }),
          );
          log.info('svx.poly.reconcile.baseline_set', {
            baselineUsdc: impliedBaseline.toFixed(2),
            walletUsdc: pUsd.pUsd.toFixed(2),
            ledgerOffsetUsdc: offset.toFixed(2),
          });
          state.polyReconcile = {
            baselineUsdc: impliedBaseline,
            baselineSetAtMs: Date.now(),
            driftUsdc: 0,
            thresholdUsdc: cfg.reconcileDriftThresholdUsdc,
            unredeemedPayoutUsdc: unredeemed,
            checkedAtMs: Date.now(),
          };
        } else {
          const baseline = JSON.parse(rawBaseline) as { baselineUsdc: number; setAtMs: number };
          const driftUsdc = impliedBaseline - baseline.baselineUsdc;
          state.polyReconcile = {
            baselineUsdc: baseline.baselineUsdc,
            baselineSetAtMs: baseline.setAtMs,
            driftUsdc,
            thresholdUsdc: cfg.reconcileDriftThresholdUsdc,
            unredeemedPayoutUsdc: unredeemed,
            checkedAtMs: Date.now(),
          };
          if (Math.abs(driftUsdc) > cfg.reconcileDriftThresholdUsdc) {
            state.polyReconcileBreachStreak++;
            if (state.polyReconcileBreachStreak < 2) {
              // First breach — very often just settlement latency: the
              // ledger marks an early-exit sell or redeem closed the
              // instant the call returns success, but the actual pUSD
              // credit can take a poll cycle to land on-chain. Confirm on
              // the NEXT cycle before pausing so a trade settling cleanly
              // one cycle late doesn't force a manual resume every time it
              // happens to land in that window.
              log.warn('svx.poly.reconcile.drift_unconfirmed', {
                driftUsdc: driftUsdc.toFixed(2),
                thresholdUsdc: cfg.reconcileDriftThresholdUsdc,
                walletUsdc: pUsd.pUsd.toFixed(2),
                ledgerOffsetUsdc: offset.toFixed(2),
                note: 'breach #1 — will pause if it repeats next cycle (~60s); likely settlement latency if it clears on its own',
              });
            } else {
              log.error('svx.poly.reconcile.drift', {
                driftUsdc: driftUsdc.toFixed(2),
                thresholdUsdc: cfg.reconcileDriftThresholdUsdc,
                walletUsdc: pUsd.pUsd.toFixed(2),
                ledgerOffsetUsdc: offset.toFixed(2),
                baselineUsdc: baseline.baselineUsdc.toFixed(2),
                confirmedCycles: state.polyReconcileBreachStreak,
                note:
                  'wallet and ledger disagree across 2 consecutive checks — trading paused. If YOU moved funds, re-baseline with `svx rebaseline`; otherwise audit recent settlements before resuming.',
              });
              risk.pause(
                `reconciliation drift ${driftUsdc.toFixed(2)} pUSD exceeds ±${cfg.reconcileDriftThresholdUsdc} — wallet vs ledger mismatch (confirmed across 2 checks)`,
              );
            }
          } else {
            state.polyReconcileBreachStreak = 0;
          }
        }
      } catch (e) {
        log.warn('svx.poly.reconcile_failed', { err: errMsg(e) });
      }
    } catch (e) {
      log.warn('svx.poly.balance_refresh_failed', { err: errMsg(e) });
    }
  }

  // 3. Match by strike grid only — the expiry filter runs in step 4 and is
  // recorded in the signal log so we can see the full consideration set.
  const matches = matchOraclesToPoly(oracles, polyMarkets);
  if (matches.length === 0) {
    log.info('svx.loop.no_matches', {});
    return;
  }

  log.info('svx.loop.matches', { count: matches.length });

  // 4. For each match: snapshot oracle, snapshot poly book, compute spread.
  // We deduplicate oracle snapshots by oracle_id to avoid hitting the indexer
  // multiple times per loop.
  const uniqueOracleIds = new Set(matches.map((m) => m.oracle.oracleId));
  const oracleSnapshots = new Map<string, OracleSnapshot>();
  await Promise.all(
    [...uniqueOracleIds].map(async (oid) => {
      const snap = await predict.snapshotOracle(oid);
      if (snap) {
        oracleSnapshots.set(oid, snap);
        ledger.recordSviSnapshot(snap);
      }
    }),
  );

  // Stash the freshest spot we just pulled so /status can serve it.
  let freshest: OracleSnapshot | undefined;
  for (const s of oracleSnapshots.values()) {
    if (!freshest || s.timestampMs > freshest.timestampMs) freshest = s;
  }
  if (freshest) {
    state.lastBtcSpot = { value: freshest.spot, updatedAtMs: freshest.timestampMs };
  }

  // Refresh HL margin balance + on-chain positions every HL_BALANCE_REFRESH_MS.
  // Two REST calls (clearinghouseState pulls both, we just project the bits
  // we need). Powers the dashboard's health panel + /wallets truth-from-chain.
  if (hlExec && Date.now() - state.lastHlBalanceAtMs > HL_BALANCE_REFRESH_MS) {
    try {
      const [bal, positions] = await Promise.all([
        hlExec.getBalance(),
        hlExec.getOpenPositions().catch(() => []),
      ]);
      state.hlBalance = {
        address: hlExec.address,
        network: hlExec.endpoints.network,
        accountValueUsdc: bal.accountValueUsdc,
        withdrawableUsdc: bal.withdrawableUsdc,
        updatedAtMs: Date.now(),
      };
      state.hlPositions = positions;
      state.lastHlBalanceAtMs = Date.now();
    } catch (e) {
      log.warn('svx.hl.balance_refresh_failed', { err: errMsg(e) });
    }
  }

  // Dedupe per-match risk-block log lines within a single loop iteration.
  // With dozens of matches per loop, an unchanging cap-hit reason would
  // otherwise log identically every 15s × every match — drowns real errors.
  const loggedRiskReasons = new Set<string>();
  // One poly attempt per outcome token per loop. Two Predict oracles
  // routinely match the same poly market (22 matches from 11 markets), and
  // the per-(oracle,strike,direction) concentration key let both fire —
  // every clip went out twice, same second, same price.
  const polyTokensThisLoop = new Set<string>();

  for (const match of matches) {
    const oracleSnap = oracleSnapshots.get(match.oracle.oracleId);
    if (!oracleSnap) continue;

    const polySnap = await snapshotPolymarket(poly, match.poly);
    if (!polySnap) continue;
    ledger.recordPolySnapshot(polySnap);

    const spread = computeSpread({
      oracleSnapshot: oracleSnap,
      polymarketSnapshot: polySnap,
      threshold: cfg.spreadThreshold,
    });

    const filterReason = applyFilters({
      oracleSnapshot: oracleSnap,
      polymarketSnapshot: polySnap,
      expiryDeltaMs: match.expiryDeltaMs,
      cfg,
      predictProb: spread.predictUp,
    });

    let action: SignalAction;
    let signalNotional: number | undefined;
    let signalCost: number | undefined;
    let predictDirection: 'up' | 'down' = spread.decision?.predictDirection ?? 'up';

    if (filterReason !== null) {
      action = 'filtered';
    } else if (spread.decision === null) {
      action = 'sub_threshold';
    } else {
      // Compute size; risk-check; log paper trade.
      predictDirection = spread.decision.predictDirection;
      // The cost we'd pay on the Predict side. The protocol prices fair +
      // spread; for sizing we use the FAIR price as a proxy and let risk caps
      // catch over-sizing. (Live mode in Phase 3 should query
      // `predict::get_trade_amounts` to get the post-spread ask.)
      const costPrice =
        predictDirection === 'up' ? spread.predictUp : 1 - spread.predictUp;

      const sized = sizeTrade({
        navUsdc: state.navUsdc,
        budgetUsedToday: 0, // TODO Phase 3: track from ledger
        dailyBudget: cfg.dailyLossLimitDusdc * 4,
        edge: spread.decision.edge,
        costPrice,
        cfg,
      });

      // Opposing-side block: refuse when we already hold a trade on the same
      // (oracle, strike) but the OPPOSITE direction. Only one of UP/DOWN can
      // win at expiry, so stacking both guarantees paying the Predict spread
      // (UP_ask + DOWN_ask > 1) on the combined position — net negative
      // regardless of where spot lands. The poly hedge legs would also
      // cancel out, paying their own spread on top.
      const hasOpposite = ledger.hasOppositeOpenForSignal(
        oracleSnap.oracleId,
        polySnap.strike,
        predictDirection,
      );
      // Concentration check: don't pyramid into the same (oracle, strike,
      // direction) beyond the per-signal cap. Forces diversification across
      // distinct settlement events.
      const sameSignalOpen = ledger.countOpenPositionsForSignal(
        oracleSnap.oracleId,
        polySnap.strike,
        predictDirection,
      );
      if (hasOpposite) {
        action = 'filtered';
        log.info('svx.signal.opposite_blocked', {
          oracleId: oracleSnap.oracleId.slice(0, 10),
          strike: polySnap.strike,
          wantDirection: predictDirection,
          reason: 'open trade exists on opposite direction',
        });
      } else if (sameSignalOpen >= cfg.maxPositionsPerSignal) {
        action = 'filtered';
        log.info('svx.signal.concentration_blocked', {
          oracleId: oracleSnap.oracleId.slice(0, 10),
          strike: polySnap.strike,
          direction: predictDirection,
          openCount: sameSignalOpen,
          cap: cfg.maxPositionsPerSignal,
        });
      } else {
        const decision = risk.check({
          costUsdc: sized.costUsdc,
          edge: spread.decision.edge,
          openPositionCount: ledger.openTrades().length,
          rolling24hPnlUsdc: ledger.realizedPnlSince(Date.now() - 24 * 3600_000),
          navUsdc: state.navUsdc,
        });

        if (!decision.ok) {
          action = 'filtered';
          log.info('svx.signal.risk_blocked', { reason: decision.reason });
        } else if (sized.quantityDusdc <= 0) {
          action = 'filtered';
        } else {
          action = cfg.paperTrading ? 'paper_executed' : 'live_executed';
          signalNotional = sized.quantityDusdc;
          signalCost = sized.costUsdc;
        }
      }
    }

    const observedSpread =
      spread.decision?.edge ?? Math.max(spread.spreadBuyOnPoly, spread.spreadSellOnPoly);

    // Disk-saving: skip persisting low-signal rows. We always log executed
    // and risk-blocked signals; we skip cheap-to-recompute filtered rows
    // whose spread is well below threshold (the boring 90% of the stream).
    const isExecuted = action === 'paper_executed' || action === 'live_executed';
    const isRiskBlocked = action === 'filtered' && filterReason === undefined;
    const meetsLogFloor = observedSpread >= cfg.spreadThreshold * cfg.signalLogMinSpreadFrac;
    if (!isExecuted && !isRiskBlocked && !meetsLogFloor) {
      continue;
    }

    const signal: Omit<SignalRecord, 'id'> = {
      timestampMs: Date.now(),
      oracleId: oracleSnap.oracleId,
      underlyingAsset: oracleSnap.underlyingAsset,
      expiryMs: oracleSnap.expiryMs,
      strike: polySnap.strike,
      predictDirection,
      predictProb: spread.predictUp,
      predictIv: spread.predictIv,
      polyProb: spread.polyYesAsk,
      polyIv: spread.polyIv ?? 0,
      spread: observedSpread,
      ivSpread: spread.decision?.ivEdge ?? 0,
      action,
      filterReason: filterReason ?? undefined,
      notional: signalNotional,
      costUsdc: signalCost,
    };
    const sigId = ledger.insertSignal(signal);

    // Open a paper or live trade for executed signals.
    if (
      (action === 'paper_executed' || action === 'live_executed') &&
      signalNotional &&
      signalCost
    ) {
      const costPrice = predictDirection === 'up' ? spread.predictUp : 1 - spread.predictUp;
      let txDigest: string | undefined;
      let mode: 'paper' | 'live' = 'paper';

      // === Polymarket execution leg ===
      // When configured, submit Polymarket FIRST (since it's the side that
      // can fail to fill). If Poly fails, abort the whole trade — we don't
      // want a half-hedge. If Poly succeeds, continue to the Predict leg.
      //
      // Side selection mirrors the spread rationale:
      //   predictDirection='down' (spreadBuyOnPoly) → buy Yes on Poly
      //   predictDirection='up'   (spreadSellOnPoly) → buy No  on Poly
      //   (Buying No is mathematically equivalent to selling Yes for a binary
      //    market and avoids needing to short / accumulate Yes shares first.)
      let polyLeg:
        | {
            tokenId: string;
            outcome: 'yes' | 'no';
            entryPrice: number;
            depth: number;
            fillResult: ReturnType<typeof parsePolyFillResponse>;
          }
        | undefined;

      // Only fire orders when the kill-switch is on. Without it, polyExec is
      // still loaded for read-only balance/orderbook surfacing on the dashboard.
      if (cfg.polyExecutionEnabled && polyExec && polySnap.yesTokenId && polySnap.noTokenId) {
        // Poly-side disabled after an unrecoverable operator condition
        // (wallet out of pUSD, allowance drained). Skip silently — the
        // one-shot warn log at set-time is enough, and vol-arb keeps trading.
        if (state.polyDisabledReason) {
          ledger.updateSignalAction(sigId, 'failed', 'poly_disabled');
          continue;
        }
        const outcome: 'yes' | 'no' = predictDirection === 'down' ? 'yes' : 'no';
        const polyTokenId = outcome === 'yes' ? polySnap.yesTokenId : polySnap.noTokenId;
        const polyEntryPrice = outcome === 'yes' ? polySnap.yesAsk : polySnap.noAsk;
        // No-side depth is optional; if the No book wasn't fetched we fall
        // back to the Yes-side depth as a proxy (binary markets are usually
        // symmetric in liquidity).
        const polyDepth =
          outcome === 'yes' ? polySnap.yesAskSize : polySnap.noAskSize ?? polySnap.yesAskSize;

        // ── Entry guards (2026-07 incident hardening) ──────────────────────
        // One attempt per token per loop — two oracles matching the same poly
        // market must not double-fire the same clip.
        if (polyTokensThisLoop.has(polyTokenId)) {
          ledger.updateSignalAction(sigId, 'failed', 'poly_dup_in_loop');
          continue;
        }
        polyTokensThisLoop.add(polyTokenId);
        // One OPEN position per token, keyed on the poly leg itself. The old
        // per-(oracle,strike,direction) counter keyed on the Predict leg's
        // settled flag — a paper leg that oracle-settles within minutes on
        // mainnet, freeing the slot while real pUSD was still deployed.
        if (ledger.countOpenPolyForToken(polyTokenId) >= 1) {
          ledger.updateSignalAction(sigId, 'failed', 'poly_token_already_open');
          continue;
        }
        // Never hold BOTH sides of one binary. Convergence and poly-arb trade
        // the same books; without this check a signal flip (or the two
        // strategies disagreeing) buys the sibling token and locks in a loss
        // of the combined spread — both asks sum > $1.
        if (ledger.hasOpenPolyForOtherToken(polySnap.conditionId, polyTokenId)) {
          ledger.updateSignalAction(sigId, 'failed', 'poly_opposite_side_open');
          continue;
        }
        // Re-entry cooldown — an early exit frees the slot, but re-buying the
        // same market seconds later at a worse price was the churn engine.
        const lastEntryAt = state.polyEntryAt.get(polyTokenId);
        if (lastEntryAt && Date.now() - lastEntryAt < cfg.polyReentryCooldownMs) {
          ledger.updateSignalAction(sigId, 'failed', 'poly_reentry_cooldown');
          continue;
        }
        // Wing guard — a 1-2¢ ask means the market is ~99% sure; any "edge"
        // the SVI wing claims out there is model junk, not information.
        if (
          polyEntryPrice <= cfg.polyMinEntryPrice ||
          polyEntryPrice >= cfg.polyMaxEntryPrice
        ) {
          log.debug('svx.poly.entry_price_wing_blocked', {
            outcome,
            entryPrice: polyEntryPrice,
            bounds: [cfg.polyMinEntryPrice, cfg.polyMaxEntryPrice],
          });
          ledger.updateSignalAction(sigId, 'failed', 'poly_entry_price_wing');
          continue;
        }
        // EV-after-cost gate: the model's edge must clear the price we
        // actually PAY. spreadThreshold compares two probabilities and is
        // blind to the book — an 8-point prob edge on a 10¢-wide book still
        // loses. modelProb − ask is the realized entry EV per $1 share.
        const modelProb = outcome === 'yes' ? spread.predictUp : 1 - spread.predictUp;
        const entryEvFrac = modelProb - polyEntryPrice;
        if (entryEvFrac < cfg.polyMinEvFrac) {
          log.debug('svx.poly.ev_blocked', {
            outcome,
            modelProb: modelProb.toFixed(3),
            entryAsk: polyEntryPrice,
            evFrac: entryEvFrac.toFixed(3),
            min: cfg.polyMinEvFrac,
          });
          ledger.updateSignalAction(sigId, 'failed', 'poly_ev_below_min');
          continue;
        }

        const polyRisk = risk.checkPoly({
          costUsdc: cfg.maxPolyPositionUsdc,
          openPolyPositionCount: ledger.countOpenPolyPositions(),
        });
        if (!polyRisk.ok) {
          // Log this reason only once per loop iteration — the same cap-hit
          // would otherwise fire on every match (often 20+ per loop) and
          // bury any real errors that show up at the same time.
          const reason = polyRisk.reason ?? 'unknown';
          if (!loggedRiskReasons.has(reason)) {
            log.info('svx.poly.risk_blocked', {
              reason,
              note: 'subsequent matches this loop suppressed',
            });
            loggedRiskReasons.add(reason);
          }
          ledger.updateSignalAction(sigId, 'failed', `poly_risk:${reason}`);
          continue;
        }

        // Per-token cooldown after fill_failed — prevents the bot from
        // hammering the same FOK-failing order every 15s loop while the
        // book stays thin.
        const lastFailedAt = state.polyFillFailedAt.get(polyTokenId);
        if (lastFailedAt && Date.now() - lastFailedAt < cfg.polyFillFailedCooldownMs) {
          log.info('svx.poly.cooldown', {
            outcome,
            tokenId: polyTokenId.slice(0, 12) + '…',
            secondsRemaining: Math.ceil(
              (cfg.polyFillFailedCooldownMs - (Date.now() - lastFailedAt)) / 1000,
            ),
          });
          ledger.updateSignalAction(sigId, 'failed', 'poly_cooldown');
          continue;
        }

        if (polyDepth < cfg.polyMinBookDepthShares) {
          log.info('svx.poly.thin_book', {
            outcome,
            depth: polyDepth,
            min: cfg.polyMinBookDepthShares,
            entryPrice: polyEntryPrice,
          });
          ledger.updateSignalAction(sigId, 'failed', 'poly_thin_book');
          continue;
        }

        // Size the order to what the visible book can actually fill.
        // Polymarket FOK kills the order if usdcAmount can't be fully matched,
        // so submitting `maxPolyPositionUsdc` blindly on a thin book wastes
        // an attempt. The sizer clamps to depth × ask × safety_factor.
        const sized = sizePolyOrder({
          maxOrderUsdc: cfg.maxPolyPositionUsdc,
          minOrderUsdc: cfg.polyMinOrderUsdc,
          bookDepthShares: polyDepth,
          ask: polyEntryPrice,
        });
        if (!sized.ok) {
          log.info('svx.poly.size_skipped', {
            reason: sized.reason,
            outcome,
            depth: polyDepth,
            entryPrice: polyEntryPrice,
            minOrderUsdc: cfg.polyMinOrderUsdc,
          });
          ledger.updateSignalAction(sigId, 'failed', `poly_size:${sized.reason}`);
          continue;
        }

        state.lastPolyAttemptAtMs = Date.now();
        try {
          log.info('svx.poly.submit', {
            outcome,
            tokenId: polyTokenId.slice(0, 12) + '…',
            usdcAmount: sized.submitUsdc,
            entryPrice: polyEntryPrice,
            clampedToDepth: sized.clampedToDepth,
          });
          // Cap the fill price at ask + polyEntryMaxSlippagePts: with FOK
          // semantics a thin book now FAILS the order (skip the tick)
          // instead of walking up and paying away the edge that justified
          // the entry.
          const resp = await polyExec.marketBuy({
            tokenId: polyTokenId,
            usdcAmount: sized.submitUsdc,
            maxPrice: Math.min(0.99, roundTo2(polyEntryPrice + cfg.polyEntryMaxSlippagePts)),
          });

          // Operator-action-required: maker-not-allowed means the EOA
          // isn't registered as a proxy. Bot can't recover; auto-pause
          // to stop the tight retry loop and surface a clear message.
          if (isMakerNotAllowedError(resp)) {
            log.error('svx.poly.maker_not_allowed', {
              hint:
                'Polymarket Deposit Wallet (DW) requires POLY_1271 mode + an API key re-derived against the DW address. Run `pnpm --filter svx-bot derive-poly-api-key-1271`, copy the new creds to MAINNET_POLY_API_*, set MAINNET_POLY_SIGNATURE_TYPE=POLY_1271 in Coolify. Full instructions in runbook §1.4.5.',
              rawResponse: resp,
              currentSigType: cfg.polySignatureType,
              currentFunder: cfg.polyFunderAddress || 'unset',
            });
            risk.pause(
              'Polymarket maker-address rejected — Deposit Wallet (POLY_1271) setup required (runbook §1.4.5)',
            );
            ledger.updateSignalAction(sigId, 'failed', 'poly_maker_not_allowed');
            continue;
          }

          // Defense-in-depth: parsing the SDK response can throw on
          // unexpected shapes (we've seen status=boolean, status=number).
          // Wrap so an unparseable response doesn't crash the trade flow —
          // log the raw response so we can update the parser, and treat
          // the order as failed (won't be retried in a tight loop since
          // the next signal evaluation may not match).
          let fill: ReturnType<typeof parsePolyFillResponse>;
          try {
            fill = parsePolyFillResponse(resp, { requestedUsdc: sized.submitUsdc, side: 'buy' });
          } catch (parseErr) {
            log.error('svx.poly.parse_failed', {
              err: errMsg(parseErr),
              rawResponse: resp,
              note: 'Order MAY have been submitted on-chain — check the wallet history.',
            });
            ledger.updateSignalAction(sigId, 'failed', 'poly_parse_failed');
            continue;
          }
          if (fill.status === 'failed') {
            // "not enough balance / allowance" is an operator-refill situation
            // — cycling through 22 tokens with the same balance still burns
            // ~4 CLOB requests/minute forever. Pause the bot so the operator
            // sees a single, actionable line and can top up pUSD.
            const respErr =
              (resp as { error?: unknown })?.error != null
                ? String((resp as { error?: unknown }).error)
                : '';
            if (/not enough balance|not enough allowance/i.test(respErr)) {
              const alreadyDisabled = !!state.polyDisabledReason;
              if (!alreadyDisabled) {
                log.error('svx.poly.insufficient_balance', {
                  rawResponse: resp,
                  hint:
                    'Polymarket EOA / deposit wallet is out of pUSD (or allowance). Top up the funder address and restart — Poly submits are disabled to stop wasting CLOB requests. Vol-arb + Predict keep trading.',
                });
              }
              state.polyDisabledReason = 'poly wallet out of pUSD / allowance';
              ledger.updateSignalAction(sigId, 'failed', 'poly_insufficient_balance');
              continue;
            }
            // Mark this tokenId for cooldown so we don't hammer the same
            // FOK-failing order every loop.
            state.polyFillFailedAt.set(polyTokenId, Date.now());
            log.warn('svx.poly.fill_failed', { resp: fill.raw });
            ledger.updateSignalAction(sigId, 'failed', 'poly_fill_failed');
            continue;
          }
          // A non-failed parse WITHOUT extractable fill details means the SDK
          // accepted the order but the response shape hid the numbers — money
          // was (very likely) spent. This used to insert a row invisible to
          // every lifecycle query (the July "ledger can't see the money"
          // class). Record it as 'submitted' with conservative estimates so
          // the position cap, stop-loss walker, settlement poll, and 14-day
          // backstop all see it; settlement trues the numbers up at
          // resolution.
          if (fill.status === 'submitted' || !((fill.filledShares ?? 0) > 0)) {
            const estShares = (fill.filledShares ?? 0) > 0
              ? fill.filledShares!
              : sized.submitUsdc / polyEntryPrice;
            log.error('svx.poly.fill_details_unknown', {
              rawResponse: fill.raw,
              estimatedShares: estShares,
              estimatedCostUsdc: sized.submitUsdc,
              note: 'recorded as poly_status=submitted with estimates; verify against wallet history',
            });
            fill = {
              ...fill,
              status: 'submitted',
              filledShares: estShares,
              fillPrice: (fill.fillPrice ?? 0) > 0 ? fill.fillPrice : polyEntryPrice,
              costUsdc: (fill.costUsdc ?? 0) > 0 ? fill.costUsdc : sized.submitUsdc,
            };
          }
          // Successful fill — clear any prior cooldown for this token and
          // start the re-entry clock.
          state.polyFillFailedAt.delete(polyTokenId);
          state.polyEntryAt.set(polyTokenId, Date.now());
          log.info('svx.poly.filled', {
            orderId: fill.orderId,
            shares: fill.filledShares,
            price: fill.fillPrice,
            costUsdc: fill.costUsdc,
            status: fill.status,
          });
          polyLeg = {
            tokenId: polyTokenId,
            outcome,
            entryPrice: polyEntryPrice,
            depth: polyDepth,
            fillResult: fill,
          };
        } catch (e) {
          log.warn('svx.poly.order_error', { err: errMsg(e), stack: errStack(e) });
          ledger.updateSignalAction(sigId, 'failed', 'poly_order_error');
          continue;
        }
      }

      // === Hyperliquid delta hedge (Part 2) ===
      // After a successful Polymarket fill, open a delta-sized BTC perp
      // hedge on Hyperliquid. The hedge size is derived from binary Δ
      // evaluated at the snapshot's spot, strike, IV, and TTM. The side is
      // OPPOSITE of the directional exposure introduced by the Poly buy.
      let hlLeg:
        | {
            asset: string;
            orderId: string;
            size: number;
            side: 'long' | 'short';
            openPrice: number;
          }
        | undefined;
      // hlHedgeEnabled is OFF by default since the 2026-07 audit: delta was
      // sized at the 15-min ORACLE expiry instead of the poly market's
      // (~5× oversize via 1/√T), and a correctly-sized ATM hedge exceeds the
      // per-trade HL cap anyway. Poly positions are naked binaries bounded by
      // the per-trade clip — documented in strategy-spec.md. The TTM below is
      // fixed to the POLY expiry for whenever the hedge is re-enabled.
      if (cfg.hlExecutionEnabled && cfg.hlHedgeEnabled && hlExec && polyLeg) {
        const ttmYears = Math.max(
          1e-6,
          (polySnap.expiryMs - Date.now()) / (365.25 * 24 * 3600 * 1000),
        );
        const hedge = hedgeSizeForPolyFill({
          spot: oracleSnap.spot,
          strike: polySnap.strike,
          ivAnnual: spread.predictIv,
          ttmYears,
          shares: polyLeg.fillResult.filledShares ?? 0,
          polyOutcome: polyLeg.outcome,
        });
        const hlRisk = risk.checkHl({
          notionalUsdc: hedge.usdNotional,
          openHlExposureUsdc: ledger.openHlExposureUsdc(),
        });
        if (!hlRisk.ok) {
          log.warn('svx.hl.risk_blocked', {
            reason: hlRisk.reason,
            usdNotional: hedge.usdNotional,
            btcSize: hedge.btcSize,
          });
          if (cfg.hlRequiredForPoly) {
            // Strict mode: skip the trade entirely. Poly leg is already
            // submitted — we accept the directional exposure and log it.
            log.error('svx.hl.skipped_naked_poly', {
              reason: 'risk_blocked, hlRequiredForPoly=true',
              polyOrderId: polyLeg.fillResult.orderId,
            });
          }
        } else if (hedge.btcSize > 0 && hedge.usdNotional < cfg.hlMinOrderUsdc) {
          // Hyperliquid rejects orders under $10. Below the minimum we leave
          // the poly leg naked (already filled) rather than error-spamming.
          log.info('svx.hl.below_min_order', {
            usdNotional: hedge.usdNotional.toFixed(2),
            min: cfg.hlMinOrderUsdc,
            polyOrderId: polyLeg.fillResult.orderId,
          });
        } else if (hedge.btcSize > 0) {
          state.lastHlAttemptAtMs = Date.now();
          try {
            const fill = await hlExec.openMarketPerp({
              asset: cfg.hlHedgeAsset,
              side: hedge.hedgeSide,
              size: hedge.btcSize,
            });
            if (fill.status === 'filled' && fill.orderId && fill.fillPrice > 0) {
              hlLeg = {
                asset: cfg.hlHedgeAsset,
                orderId: fill.orderId,
                size: fill.filledSize,
                side: hedge.hedgeSide,
                openPrice: fill.fillPrice,
              };
              log.info('svx.hl.opened', {
                asset: cfg.hlHedgeAsset,
                side: hedge.hedgeSide,
                size: fill.filledSize,
                price: fill.fillPrice,
                orderId: fill.orderId,
              });
            } else {
              log.warn('svx.hl.open_partial_or_rejected', {
                status: fill.status,
                filledSize: fill.filledSize,
              });
            }
          } catch (e) {
            log.error('svx.hl.open_failed', { err: errMsg(e), stack: errStack(e) });
            // Don't pause — naked poly is the original state. Operator
            // sees the warning + can flip hlRequiredForPoly if they want
            // strict behavior.
          }
        }
      }

      if (action === 'live_executed' && live) {
        // The manager holds pre-deposited dUSDC that Predict::mint spends
        // from directly. The top-up path only exists to refill the manager
        // when the wallet is the pre-position dUSDC holder. On testnet the
        // trading budget lives inside the manager and the wallet holds
        // only a few $ of dust (gas coins etc.) — a "> 0 coins" check would
        // still ask for a top-up we can't fund, and the splitCoins trips
        // InsufficientCoinBalance. Compare actual wallet balance to the
        // desired top-up and skip when it wouldn't cover.
        const wantedTopUpDusdc = Math.min(signalCost * 1.5, signalNotional);
        const walletCoinIds = await getOperatorDusdcCoinIds(live);
        const walletDusdc =
          walletCoinIds.length > 0
            ? Number(
                (
                  await live.sui.getBalance({
                    owner: live.operatorAddress,
                    coinType: ADDRESSES.dusdcType,
                  })
                ).totalBalance,
              ) / Number(QUOTE_UNIT)
            : 0;
        const shouldTopUp = walletDusdc >= wantedTopUpDusdc;
        const tx = buildMintTx({
          oracleId: oracleSnap.oracleId,
          expiryMs: oracleSnap.expiryMs,
          strike: polySnap.strike,
          direction: predictDirection,
          quantityDusdc: signalNotional,
          managerId: live.managerId,
          topUpDusdc: shouldTopUp ? wantedTopUpDusdc : 0,
          dusdcCoinObjectIds: shouldTopUp ? walletCoinIds : undefined,
        });
        const result = await submitTx(live.sui, tx, live.keypair);
        if (!result.ok) {
          log.warn('svx.signal.live_failed', {
            digest: result.digest,
            error: result.error,
            status: result.status,
          });
          ledger.updateSignalAction(sigId, 'failed', `predict_tx:${result.status ?? 'unknown'}`);
          continue;
        }
        txDigest = result.digest;
        mode = 'live';
        // Refresh NAV after the tx.
        state.navUsdc = await readManagerBalance(live);
      }

      const tradeId = ledger.insertTrade({
        signalId: sigId,
        timestampMs: signal.timestampMs,
        mode,
        oracleId: oracleSnap.oracleId,
        underlyingAsset: oracleSnap.underlyingAsset,
        expiryMs: oracleSnap.expiryMs,
        strike: polySnap.strike,
        direction: predictDirection,
        quantityDusdc: signalNotional,
        costPrice,
        costUsdc: signalCost,
        txDigest,
        settled: false,
        // analytics fields — captured at execution time so we can audit
        // calibration / slippage / time-decay later.
        msToExpiryAtExec: oracleSnap.expiryMs - signal.timestampMs,
        predictProbAtExec: spread.predictUp,
        polyAskAtExec: spread.polyYesAsk,
        predictIvAtExec: spread.predictIv,
        edgeAtExec: spread.decision?.edge ?? observedSpread,
        // Polymarket leg — populated only when polyExec was active and filled.
        polyNetwork: polyLeg ? polyExec!.endpoints.network : undefined,
        polyTokenId: polyLeg?.tokenId,
        polyConditionId: polyLeg ? polySnap.conditionId : undefined,
        polySide: polyLeg ? 'buy' : undefined,
        polyOutcome: polyLeg?.outcome,
        polyOrderId: polyLeg?.fillResult.orderId,
        polyFilledShares: polyLeg?.fillResult.filledShares,
        polyFillPrice: polyLeg?.fillResult.fillPrice,
        polyCostUsdc: polyLeg?.fillResult.costUsdc,
        polyTxHash: polyLeg?.fillResult.txHash,
        polyStatus: polyLeg?.fillResult.status,
      });
      // Persist the HL leg onto the same trade row. Separate UPDATE so the
      // insertTrade signature stays compatible with the existing column set.
      if (hlLeg) {
        ledger.recordHlLeg(tradeId, { ...hlLeg, status: 'open' });
      }
      if (mode === 'paper') {
        state.navUsdc -= signalCost;
      }
      log.info(`svx.signal.${mode}_executed`, {
        oracleId: oracleSnap.oracleId,
        strike: polySnap.strike,
        dir: predictDirection,
        notional: signalNotional,
        cost: signalCost,
        edge: spread.decision?.edge,
        ...(txDigest && { txDigest }),
      });
    } else if (action !== 'paper_executed' && action !== 'live_executed') {
      log.debug('svx.signal.observed', {
        oracle: oracleSnap.oracleId.slice(0, 8),
        strike: polySnap.strike,
        predictUp: spread.predictUp,
        polyAsk: spread.polyYesAsk,
        spread: signal.spread,
        action,
        filterReason,
      });
    }

    // === Favored-side mints — independent of the arb path ===
    // Bet the side Predict prices above 50¢. Two disjoint bands share the
    // calibration edge (the surface is underconfident below ~90¢):
    //   divergence-mint:     divergence ≥ divergenceMintThreshold
    //   calibration-harvest: divergence ∈ [0, threshold), tighter 90¢ cap
    // Predict-side only: no Poly leg, no hedge. Data-integrity filters
    // (stale SVI, expiry mismatch) still gate entry; poly-book-quality
    // reasons don't — the mint never touches the book. (Slightly tighter
    // than the backtest population, which had no filters.)
    if (
      filterReason === null ||
      filterReason === 'poly_one_sided' ||
      filterReason === 'poly_wide_spread' ||
      filterReason === 'poly_low_volume'
    ) {
      const isMintBand = observedSpread >= cfg.divergenceMintThreshold;
      const params = isMintBand
        ? cfg.divergenceMintEnabled
          ? {
              strategy: 'divergence_mint' as const,
              notionalDusdc: cfg.divergenceMintNotionalDusdc,
              gates: {
                minDivergence: cfg.divergenceMintThreshold,
                maxDivergenceExclusive: Infinity,
                maxCostPrice: cfg.divergenceMintMaxCostPrice,
                maxOpen: cfg.divergenceMintMaxOpen,
                dailyLossLimitDusdc: cfg.divergenceMintDailyLossLimitDusdc,
              },
            }
          : null
        : cfg.calibrationHarvestEnabled
          ? {
              strategy: 'calibration_harvest' as const,
              notionalDusdc: cfg.calibrationHarvestNotionalDusdc,
              gates: {
                minDivergence: 0,
                maxDivergenceExclusive: cfg.divergenceMintThreshold,
                maxCostPrice: cfg.calibrationHarvestMaxCostPrice,
                maxOpen: cfg.calibrationHarvestMaxOpen,
                dailyLossLimitDusdc: cfg.calibrationHarvestDailyLossLimitDusdc,
              },
            }
          : null;
      if (params) {
        try {
          await maybeFavoredMint({
            ledger,
            cfg,
            live,
            state,
            sigId,
            oracleSnap,
            polySnap,
            predictUp: spread.predictUp,
            polyYesAsk: spread.polyYesAsk,
            predictIv: spread.predictIv,
            divergence: observedSpread,
            ...params,
          });
        } catch (e) {
          log.warn('svx.divergence.error', { err: errMsg(e), stack: errStack(e) });
        }
      }
    }
  }

  // Butterfly telemetry - scan each fitted surface for digital-monotonicity
  // violations (P_up rising in strike = crossed strikes = a near-riskless
  // structure). TELEMETRY ONLY: we count opportunities and whether their
  // margin survives fees before wiring any execution. Uses the snapshots
  // this loop already pulled - zero extra indexer calls.
  if (
    oracleSnapshots.size > 0 &&
    Date.now() - state.lastButterflyCheckMs > cfg.butterflyCheckIntervalMs
  ) {
    state.lastButterflyCheckMs = Date.now();
    try {
      let scans = 0;
      for (const snap of oracleSnapshots.values()) {
        if (snap.expiryMs <= Date.now()) continue;
        const F = snap.forward;
        const points: Array<{ strike: number; up: number }> = [];
        for (let pct = -0.1; pct <= 0.1001; pct += 0.005) {
          const strike = F * (1 + pct);
          const k = Math.log(strike / F);
          const w = sviTotalVariance(k, snap.svi);
          if (!(w > 0)) continue;
          const d2 = -(k + w / 2) / Math.sqrt(w);
          points.push({ strike, up: 0.5 * (1 + erf(d2 / Math.SQRT2)) });
        }
        scans++;
        for (const c of findCrossedStrikes(points, cfg.butterflyMinMarginFrac)) {
          const tradeable = c.marginFrac >= cfg.butterflyTradeableMarginFrac;
          ledger.recordButterflyEvent({
            tsMs: Date.now(),
            oracleId: snap.oracleId,
            expiryMs: snap.expiryMs,
            lowerStrike: c.lowerStrike,
            higherStrike: c.higherStrike,
            upLower: c.upLower,
            upHigher: c.upHigher,
            marginFrac: c.marginFrac,
            tradeable,
          });
          log.info('svx.butterfly.violation', {
            oracleId: snap.oracleId.slice(0, 10),
            lowerStrike: Math.round(c.lowerStrike),
            higherStrike: Math.round(c.higherStrike),
            marginPp: (c.marginFrac * 100).toFixed(2),
            tradeable,
          });
        }
      }
      ledger.bumpButterflyChecks(scans);
    } catch (e) {
      log.warn('svx.butterfly.scan_error', { err: errMsg(e) });
    }
  }

  // Refresh on-chain manager balance every ~30s (live mode only). Manager
  // balance grows from auto-redeems and shrinks from per-trade top-ups.
  if (live && Date.now() - state.lastManagerBalanceAtMs > MANAGER_BALANCE_REFRESH_MS) {
    try {
      state.managerBalanceUsdc = await readManagerDusdcBalance(
        live.sui,
        live.managerId,
        live.operatorAddress,
      );
      state.lastManagerBalanceAtMs = Date.now();
    } catch (e) {
      log.warn('svx.manager_balance.read_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // NOTE: vol-arb runs on its OWN fast ticker (see runBot), decoupled from
  // this 15s poly-arb loop. Decoupling is the whole point — a slow
  // Polymarket HTTP call here used to delay every vol-arb decision by up to
  // 15s, which is forever when IV-RV diverges and you want to be IN.

  // Periodic NAV snapshot for the dashboard chart.
  ledger.recordNav(
    state.navUsdc,
    ledger.realizedPnlSince(state.startedAtMs),
    /* unrealized */ 0,
    ledger.openTrades().length,
  );

  // Periodic ledger prune + vacuum. Cheap (single tx) and bounds disk usage.
  if (Date.now() - state.lastPruneAtMs > PRUNE_INTERVAL_MS) {
    const r = ledger.prune(RETENTION);
    if (r.deletedSignals + r.deletedSvi + r.deletedPoly + r.deletedNav > 0) {
      log.info('svx.ledger.pruned', r);
      ledger.vacuum();
    }
    // Auto-abandon poly trades stuck as filled+unsettled past the staleness
    // window. Stops them from pinning maxOpenPolyPositions forever when UMA
    // never resolves and mid-life-exit never triggers. Recorded as a
    // realized loss (payout=0, pnl=-cost) so the audit trail is honest.
    const staleAgeMs = cfg.polyStaleSettlementDays * 24 * 3600_000;
    const abandoned = ledger.abandonStalePolyTrades(staleAgeMs, Date.now());
    if (abandoned > 0) {
      log.warn('svx.poly.abandoned_stale', {
        count: abandoned,
        olderThanDays: cfg.polyStaleSettlementDays,
      });
    }
    // Same treatment for Predict (Sui) trades whose redeem keeps
    // MoveAbort(1)'ing — typically because the position was pruned from the
    // on-chain predict_manager. Cutoff is HOURS (not days like poly) — see
    // predictStaleRedeemHours commentary in tunables.
    const predictStaleAgeMs = cfg.predictStaleRedeemHours * 3600_000;
    const abandonedRedeems = ledger.abandonStaleRedeems(predictStaleAgeMs, Date.now());
    if (abandonedRedeems > 0) {
      log.warn('svx.predict.abandoned_stale_redeem', {
        count: abandonedRedeems,
        olderThanHours: cfg.predictStaleRedeemHours,
      });
    }
    state.lastPruneAtMs = Date.now();
  }
}

/**
 * Walk open Polymarket positions and sell back via marketSell when the
 * mark-to-market P&L crosses the profit-take threshold.
 *
 * Why this exists: a "buy on one side, sell on the other" arbitrage is only
 * truly captured when you can exit either leg. Predict has no sell primitive
 * (only `mint` + `redeem` at settlement), so that leg is locked. But the
 * Polymarket CLOB has both sides — so when the poly mark has moved enough
 * to lock in a profit, we sell instead of waiting hours for UMA.
 *
 *   1. List open poly trades (filled, not yet settled).
 *   2. For each: fetch the current order book, compute mark = bid × shares.
 *   3. Exit on either of two conditions:
 *        stop-loss:      pnlFrac ≤ −`polyStopLossFrac` (cut losers)
 *        trail-ratchet:  once the high-water pnlFrac crosses a multiple of
 *                        `polyEarlyExitMinProfitFrac` (+20%, +40%, ...) that
 *                        multiple becomes a locked floor; sell only when
 *                        pnlFrac falls back below the highest locked floor.
 *      Both are submitted as a market-sell for the full position via FOK.
 *   4. On a successful fill: mark the trade as exited (settled-early), and
 *      close any open HL hedge attached to the same trade row.
 *
 * Exit-style history: v1 was take-profit-only ("hold to settlement on the
 * way down") — winners clipped at +20%, losers rode to $0; two weeks of
 * live data showed +$174 of clips swamped by ~$290 of expiry losses. v2
 * added the stop-loss. v3 (current) replaces the fixed clip with the
 * ratchet so winners RIDE: a trade that runs clean to resolution never
 * sells at all — it redeems at $1 — while every 20%-step it passes on the
 * way is locked in against a reversal. High-water is persisted per trade
 * (poly_high_water_frac) so locked floors survive restarts.
 */
export async function walkPolyEarlyExits(args: {
  poly: PolymarketClient;
  polyExec: PolymarketExecClient;
  hlExec: HyperliquidExecClient | undefined;
  ledger: LedgerStore;
  cfg: SvxConfig;
}): Promise<void> {
  const { poly, polyExec, hlExec, ledger, cfg } = args;
  const open = ledger.unsettledPolyTrades();
  if (open.length === 0) return;

  for (const trade of open) {
    if (
      !trade.polyTokenId ||
      !trade.polyConditionId ||
      !trade.polyFilledShares ||
      trade.polyCostUsdc == null ||
      trade.polyFilledShares <= 0
    ) {
      continue;
    }

    let book;
    try {
      book = await poly.orderBook(trade.polyConditionId, trade.polyTokenId);
    } catch (e) {
      log.debug('svx.poly.early_exit.book_failed', {
        tradeId: trade.id,
        err: errMsg(e),
      });
      continue;
    }
    if (!book?.bid?.bestPrice) continue;

    const bestBid = book.bid.bestPrice;
    const markUsdc = bestBid * trade.polyFilledShares;
    const pnlUsdc = markUsdc - trade.polyCostUsdc;
    const pnlFrac = pnlUsdc / trade.polyCostUsdc;

    // Trailing ratchet: persist the high-water mark, derive the highest
    // locked floor (largest step multiple the high-water has crossed), and
    // exit only when P&L falls back below it. A winner that never reverses
    // holds to resolution and redeems at $1.
    const step = cfg.polyEarlyExitMinProfitFrac;
    const prevHighWater = trade.polyHighWaterFrac ?? 0;
    const highWater = Math.max(prevHighWater, pnlFrac);
    if (highWater > prevHighWater) {
      ledger.updatePolyHighWater(trade.id, highWater);
    }
    const lockedFloor =
      step > 0 && highWater >= step ? Math.floor(highWater / step + 1e-9) * step : null;
    const ratchetHit = lockedFloor != null && pnlFrac < lockedFloor;
    // Strategy-specific stop. Convergence entries sit at 90-97¢ where the
    // shared −50% stop is miscalibrated: by −50% the market already prices
    // ~50/50 crossing odds and half the clip is gone. −15% (ask ≈ 79¢ on a
    // 93¢ entry) means market doubt has ~tripled vs entry — thesis dead,
    // exit while a bid still exists.
    const stopFrac =
      trade.strategy === 'convergence' ? cfg.convergenceStopLossFrac : cfg.polyStopLossFrac;
    const stopLoss = stopFrac > 0 && pnlFrac <= -stopFrac;
    if (!ratchetHit && !stopLoss) {
      continue;
    }

    log.info('svx.poly.early_exit.submit', {
      tradeId: trade.id,
      kind: ratchetHit ? 'trail_ratchet' : 'stop_loss',
      tokenId: trade.polyTokenId.slice(0, 12) + '…',
      shares: trade.polyFilledShares,
      bestBid,
      markUsdc: markUsdc.toFixed(4),
      costUsdc: trade.polyCostUsdc.toFixed(4),
      pnlUsdc: pnlUsdc.toFixed(4),
      pnlPct: (pnlFrac * 100).toFixed(1),
      highWaterPct: (highWater * 100).toFixed(1),
      lockedFloorPct: lockedFloor != null ? (lockedFloor * 100).toFixed(0) : null,
    });

    // Exit ladder: floor-priced FAK instead of a market FOK. The FOK sweep
    // realized 5–10pp below the tape on thin books (the whole position
    // filled whatever was resting). The FAK sells only what the book offers
    // at ≥ (bestBid − polyExitMaxSlippagePts) and the remainder retries next
    // tick against a fresh book — a crash costs ≤ the slippage cap per tick,
    // not the whole depth of a hollow book at once.
    const floorPrice = Math.max(0.01, roundTo2(bestBid - cfg.polyExitMaxSlippagePts));
    let resp: unknown;
    try {
      resp = await polyExec.limitSell({
        tokenId: trade.polyTokenId,
        shares: trade.polyFilledShares,
        floorPrice,
      });
    } catch (e) {
      log.warn('svx.poly.early_exit.sell_error', {
        tradeId: trade.id,
        err: errMsg(e),
      });
      continue;
    }

    let fill;
    try {
      fill = parsePolyFillResponse(resp, {
        requestedUsdc: trade.polyFilledShares,
        side: 'sell',
      });
    } catch (parseErr) {
      log.error('svx.poly.early_exit.parse_failed', {
        tradeId: trade.id,
        err: errMsg(parseErr),
        rawResponse: resp,
        note: 'Order MAY have submitted on-chain — check the wallet.',
      });
      continue;
    }
    if (fill.status === 'failed' || !fill.costUsdc || fill.costUsdc <= 0) {
      log.warn('svx.poly.early_exit.fill_failed', {
        tradeId: trade.id,
        floorPrice,
        rawStatus: fill.status,
        raw: fill.raw,
        note: 'no liquidity at/above the floor — remainder retries next tick',
      });
      continue;
    }

    const proceedsUsdc = fill.costUsdc;
    const nowMs = Date.now();
    // Partial fill: the ladder sold a chunk; split the row so realized PnL
    // books now (invariant-exact) and the remainder keeps walking.
    const soldShares = fill.filledShares ?? trade.polyFilledShares;
    const isPartial = soldShares > 0 && soldShares < trade.polyFilledShares * 0.995;
    if (isPartial) {
      try {
        const chunkId = ledger.splitPolyPartialExit(
          trade.id,
          soldShares,
          proceedsUsdc,
          fill.orderId ?? null,
          nowMs,
        );
        log.info('svx.poly.early_exit.partial', {
          tradeId: trade.id,
          chunkId,
          soldShares,
          remainingShares: trade.polyFilledShares - soldShares,
          proceedsUsdc: proceedsUsdc.toFixed(4),
          floorPrice,
        });
      } catch (e) {
        log.error('svx.poly.early_exit.partial_book_failed', {
          tradeId: trade.id,
          err: errMsg(e),
        });
      }
      continue; // position still open — hedge (if any) stays until full exit
    }

    const realizedPnl = proceedsUsdc - trade.polyCostUsdc;
    ledger.markPolyExited(trade.id, fill.orderId ?? null, proceedsUsdc, realizedPnl, nowMs);
    log.info('svx.poly.early_exit.done', {
      tradeId: trade.id,
      proceedsUsdc: proceedsUsdc.toFixed(4),
      pnlUsdc: realizedPnl.toFixed(4),
      orderId: fill.orderId,
    });

    // Close the matching HL hedge so the strategy's exposure goes flat the
    // moment we lock in the poly side. Mirrors what reconcilePolySettlements
    // does on UMA-resolved trades.
    if (
      hlExec &&
      trade.hlStatus === 'open' &&
      trade.hlSize != null &&
      trade.hlSide &&
      trade.hlOpenPrice != null
    ) {
      try {
        // Capture funding BEFORE close — once HL settles the close, the
        // position drops from getOpenPositions() and the funding number is
        // gone. cumFundingUsdc is signed (positive = paid, negative = received).
        const fundingAtClose = await readCumFundingForAsset(
          hlExec,
          trade.hlAsset ?? 'BTC',
        );
        const closeFill = await hlExec.closeMarketPerp({
          asset: trade.hlAsset ?? 'BTC',
          originalSide: trade.hlSide,
          size: trade.hlSize,
        });
        if (closeFill.status !== 'rejected' && closeFill.fillPrice > 0) {
          const closePx = closeFill.fillPrice;
          const hlPnl =
            trade.hlSide === 'short'
              ? (trade.hlOpenPrice - closePx) * trade.hlSize
              : (closePx - trade.hlOpenPrice) * trade.hlSize;
          const feesUsdc = estimateHlFees(
            trade.hlOpenPrice,
            closePx,
            trade.hlSize,
            cfg.hlTakerFeeRate,
          );
          ledger.closeHlLeg(trade.id, {
            closePrice: closePx,
            pnlUsdc: hlPnl,
            fundingPaidUsdc: fundingAtClose,
            feesUsdc,
            closedAtMs: nowMs,
          });
          log.info('svx.poly.early_exit.hl_closed', {
            tradeId: trade.id,
            closePx,
            hlGrossPnlUsdc: hlPnl.toFixed(4),
            hlFeesUsdc: feesUsdc.toFixed(4),
            hlFundingUsdc: fundingAtClose.toFixed(4),
            hlNetPnlUsdc: (hlPnl - feesUsdc - fundingAtClose).toFixed(4),
          });
        } else {
          log.warn('svx.poly.early_exit.hl_close_rejected', {
            tradeId: trade.id,
            raw: closeFill.raw,
          });
        }
      } catch (e) {
        log.error('svx.poly.early_exit.hl_close_failed', {
          tradeId: trade.id,
          err: errMsg(e),
        });
      }
    }
  }
}

/**
 * Reconcile Polymarket positions against UMA resolutions on gamma.
 *
 *   1. Pull unsettled poly trades; group by conditionId.
 *   2. For each unique condition, query gamma for `closed: true` + winning
 *      outcome.
 *   3. For each resolved market: compute payout (= shares * 1 if won, else 0)
 *      and PnL (= payout - poly_cost_usdc); mark settled.
 *   4. For winning trades not yet redeemed: submit CTF redeemPositions tx
 *      (NegRiskAdapter for multi-strike markets, standard CTF otherwise).
 *      Best-effort — if a redeem reverts, we log + persist 'failed' so the
 *      operator can manually clear it.
 */
/**
 * Expiry-convergence walker — the strategy math lives in
 * strategy/convergence.ts; this wires it to live books and the ledger.
 *
 * For each BTC daily expiring within [convergenceMinMinutes,
 * convergenceMaxMinutes]: if spot sits ≥ convergenceMinSigma sigmas from the
 * strike (realized vol from the HL mid sampler), buy the in-the-money side
 * at 90-97¢ and hold to resolution. Settlement + auto-redeem handle the
 * payout; the shared stop-loss walker cuts the position at −50% if BTC
 * lurches toward the strike. Trades tag strategy='convergence'.
 */
async function walkExpiryConvergence(args: {
  poly: PolymarketClient;
  polyExec: PolymarketExecClient;
  ledger: LedgerStore;
  risk: RiskGate;
  cfg: SvxConfig;
  state: BotState;
  polyMarkets: PolyStrikeMarket[];
}): Promise<void> {
  const { poly, polyExec, ledger, risk, cfg, state, polyMarkets } = args;
  if (state.polyDisabledReason) return;

  // Sigma from the vol-arb ticker's rolling HL mid history (always-on
  // telemetry, ~2s cadence). No vol estimate → no trades. Never guess.
  //
  // Trust gates on the estimator itself (2026-07 audit):
  //   - Require convergenceMinRvHistoryMs of actual history span. The buffer
  //     is memory-only; seconds after a restart it holds a handful of 2s
  //     returns and the RV number is noise in either direction.
  //   - Multiply RV by convergenceSigmaSafetyMult before the distance test.
  //     Trailing lognormal RV understates BTC tails by orders of magnitude
  //     (Student-t tails, vol clustering, scheduled macro events invisible
  //     to any trailing window). 2× means "4σ" demands 8 trailing sigmas.
  const rawSigma = computeRealizedVol(state.volArb.midHistory);
  const firstMid = state.volArb.midHistory[0];
  const lastMid = state.volArb.midHistory[state.volArb.midHistory.length - 1];
  const historySpanMs = firstMid && lastMid ? lastMid.ts - firstMid.ts : 0;
  const spot = lastMid?.price ?? state.lastBtcSpot?.value;
  if (!spot || !isFinite(rawSigma) || rawSigma <= 0) return;
  if (historySpanMs < cfg.convergenceMinRvHistoryMs) {
    log.debug('svx.convergence.rv_warming_up', {
      historyMinutes: (historySpanMs / 60_000).toFixed(1),
      requiredMinutes: (cfg.convergenceMinRvHistoryMs / 60_000).toFixed(0),
    });
    return;
  }
  const sigma = rawSigma * cfg.convergenceSigmaSafetyMult;

  const nowMs = Date.now();
  for (const market of polyMarkets) {
    const tMs = market.expiryMs - nowMs;
    if (
      tMs < cfg.convergenceMinMinutes * 60_000 ||
      tMs > cfg.convergenceMaxMinutes * 60_000
    ) {
      continue;
    }
    // Strike sanity band — the parser already rejects non-price questions,
    // but this is the belt to that suspender: no genuine BTC price binary
    // has a strike at 0.0005× or 3× spot. A strike outside the band means
    // the universe filter mis-parsed something; skip AND log loudly.
    if (
      market.strike < spot * cfg.convergenceStrikeBandLoFrac ||
      market.strike > spot * cfg.convergenceStrikeBandHiFrac
    ) {
      log.warn('svx.convergence.strike_out_of_band', {
        question: market.question,
        strike: market.strike,
        spot,
      });
      continue;
    }
    // Volume floor — same rail the arb path applies via the signal filter.
    // A dead book's 95¢ ask is not a discount, it's an absence of sellers.
    if (market.volume24hr < cfg.polyMinVolume24hUsd) continue;
    const tYears = tMs / (365.25 * 24 * 3600 * 1000);
    // Cheap sigma pre-gate before paying for a book fetch — most strikes
    // near spot fail here and never generate an HTTP call.
    if (sigmaDistance(spot, market.strike, sigma, tYears) < cfg.convergenceMinSigma) {
      continue;
    }

    const side: 'yes' | 'no' = spot >= market.strike ? 'yes' : 'no';
    const tokenId = side === 'yes' ? market.yesTokenId : market.noTokenId;

    // Same per-token rails as the arb path: one open position per token,
    // opposite-side block, re-entry cooldown, failed-fill cooldown.
    if (ledger.countOpenPolyForToken(tokenId) >= 1) continue;
    if (ledger.hasOpenPolyForOtherToken(market.conditionId, tokenId)) continue;
    const lastEntryAt = state.polyEntryAt.get(tokenId);
    if (lastEntryAt && nowMs - lastEntryAt < cfg.polyReentryCooldownMs) continue;
    const lastFailedAt = state.polyFillFailedAt.get(tokenId);
    if (lastFailedAt && nowMs - lastFailedAt < cfg.polyFillFailedCooldownMs) continue;

    let book;
    try {
      book = await poly.orderBook(market.conditionId, tokenId);
    } catch (e) {
      log.debug('svx.convergence.book_failed', {
        conditionId: market.conditionId.slice(0, 10),
        err: errMsg(e),
      });
      continue;
    }
    if (!book?.ask?.bestPrice || !book.ask.bestSize) continue;

    const decision = decideConvergence({
      spot,
      strike: market.strike,
      sigmaAnnual: sigma,
      tYears,
      itmAsk: book.ask.bestPrice,
      cfg,
    });
    if (!decision.enter) {
      log.debug('svx.convergence.skip', {
        question: market.question,
        reason: decision.reason,
      });
      continue;
    }

    const sized = sizePolyOrder({
      maxOrderUsdc: cfg.maxConvergencePerTradeUsdc,
      minOrderUsdc: cfg.polyMinOrderUsdc,
      bookDepthShares: book.ask.bestSize,
      ask: book.ask.bestPrice,
    });
    if (!sized.ok) continue;

    // Shared risk rails: pause flag, per-trade cap, open-position count,
    // daily poly loss limit — all of which now read truthful numbers.
    const gate = risk.checkPoly({
      costUsdc: sized.submitUsdc,
      openPolyPositionCount: ledger.countOpenPolyPositions(),
    });
    if (!gate.ok) {
      log.info('svx.convergence.risk_blocked', { reason: gate.reason });
      return; // pause / daily-loss applies to every market — stop the scan
    }

    state.lastPolyAttemptAtMs = Date.now();
    let resp: unknown;
    try {
      // Same entry cap as the arb leg — convergence buys sit at 90–97¢
      // where overpaying 3–4pp erases the whole discount being collected.
      resp = await polyExec.marketBuy({
        tokenId,
        usdcAmount: sized.submitUsdc,
        maxPrice: Math.min(0.99, roundTo2(book.ask.bestPrice + cfg.polyEntryMaxSlippagePts)),
      });
    } catch (e) {
      log.warn('svx.convergence.buy_error', { tokenId: tokenId.slice(0, 12) + '…', err: errMsg(e) });
      continue;
    }
    let fill: ReturnType<typeof parsePolyFillResponse>;
    try {
      fill = parsePolyFillResponse(resp, { requestedUsdc: sized.submitUsdc, side: 'buy' });
    } catch (parseErr) {
      log.error('svx.convergence.parse_failed', {
        err: errMsg(parseErr),
        rawResponse: resp,
        note: 'Order MAY have been submitted on-chain — check the wallet history.',
      });
      continue;
    }
    if (fill.status === 'failed' || !fill.filledShares || fill.filledShares <= 0) {
      const respErr =
        (resp as { error?: unknown })?.error != null
          ? String((resp as { error?: unknown }).error)
          : '';
      if (/not enough balance|not enough allowance/i.test(respErr)) {
        if (!state.polyDisabledReason) {
          log.error('svx.poly.insufficient_balance', {
            rawResponse: resp,
            hint: 'Polymarket wallet out of pUSD/allowance — Poly submits disabled until refill + restart.',
          });
        }
        state.polyDisabledReason = 'poly wallet out of pUSD / allowance';
        return;
      }
      state.polyFillFailedAt.set(tokenId, Date.now());
      log.warn('svx.convergence.fill_failed', { raw: fill.raw });
      continue;
    }

    state.polyEntryAt.set(tokenId, Date.now());
    const tradeId = ledger.insertTrade({
      signalId: 'convergence',
      timestampMs: nowMs,
      // mode describes the SUI leg (mainnet convention: paper). settled=true
      // because there IS no Predict leg — keeps the row out of openTrades();
      // the poly leg's lifecycle runs on poly_settled as usual.
      mode: 'paper',
      oracleId: `conv:${market.conditionId.slice(0, 16)}`,
      underlyingAsset: 'BTC',
      expiryMs: market.expiryMs,
      strike: market.strike,
      direction: side === 'yes' ? 'up' : 'down',
      quantityDusdc: 0,
      costPrice: fill.fillPrice ?? book.ask.bestPrice,
      costUsdc: 0,
      settled: true,
      strategy: 'convergence',
      polyNetwork: cfg.polyNetwork,
      polyTokenId: tokenId,
      polyConditionId: market.conditionId,
      polySide: 'buy',
      polyOutcome: side,
      polyOrderId: fill.orderId,
      polyFilledShares: fill.filledShares,
      polyFillPrice: fill.fillPrice,
      polyCostUsdc: fill.costUsdc,
      polyTxHash: fill.txHash,
      polyStatus: fill.status,
    });
    log.info('svx.convergence.opened', {
      tradeId,
      question: market.question,
      side,
      dSigma: decision.dSigma.toFixed(1),
      pCross: decision.pCross.toExponential(1),
      evPct: (decision.evFrac * 100).toFixed(1),
      shares: fill.filledShares,
      fillPrice: fill.fillPrice,
      costUsdc: fill.costUsdc,
      minutesToExpiry: (tMs / 60_000).toFixed(0),
    });
  }
}

export async function reconcilePolySettlements(
  poly: PolymarketClient,
  polyExec: PolymarketExecClient,
  ledger: LedgerStore,
  hlExec?: HyperliquidExecClient,
  cfg?: SvxConfig,
): Promise<void> {
  const unsettled = ledger.unsettledPolyTrades();
  if (unsettled.length === 0) return;

  // Group by conditionId so we hit gamma at most once per market.
  const byCondition = new Map<string, typeof unsettled>();
  for (const t of unsettled) {
    if (!t.polyConditionId) continue;
    const list = byCondition.get(t.polyConditionId) ?? [];
    list.push(t);
    byCondition.set(t.polyConditionId, list);
  }

  for (const [conditionId, trades] of byCondition) {
    const resolution = await poly.getMarketResolution(conditionId);
    if (!resolution || !resolution.closed || resolution.winningOutcome == null) {
      log.debug('svx.poly.unresolved', { conditionId: conditionId.slice(0, 10), count: trades.length });
      continue;
    }

    const settledAt = resolution.resolvedAtMs ?? Date.now();
    for (const trade of trades) {
      if (trade.polyFilledShares == null || trade.polyCostUsdc == null || !trade.polyOutcome) {
        log.warn('svx.poly.settle.skip_malformed', { tradeId: trade.id });
        continue;
      }
      const won = trade.polyOutcome === resolution.winningOutcome;
      const payout = won ? trade.polyFilledShares : 0;
      const pnl = payout - trade.polyCostUsdc;
      ledger.markPolySettled(trade.id, resolution.winningOutcome, payout, pnl, settledAt);
      log.info('svx.poly.settled', {
        tradeId: trade.id,
        conditionId: conditionId.slice(0, 10),
        winningOutcome: resolution.winningOutcome,
        ourOutcome: trade.polyOutcome,
        won,
        payoutUsdc: payout,
        pnlUsdc: pnl.toFixed(4),
      });

      // Close the matching HL hedge on the same trade row, if present. We do
      // this synchronously here so the HL PnL gate updates within the same
      // settlement cycle.
      if (
        hlExec &&
        trade.hlStatus === 'open' &&
        trade.hlSize != null &&
        trade.hlSide &&
        trade.hlOpenPrice != null
      ) {
        try {
          const fundingAtClose = await readCumFundingForAsset(
            hlExec,
            trade.hlAsset ?? 'BTC',
          );
          const closeFill = await hlExec.closeMarketPerp({
            asset: trade.hlAsset ?? 'BTC',
            originalSide: trade.hlSide,
            size: trade.hlSize,
          });
          if (closeFill.status === 'rejected' || closeFill.fillPrice <= 0) {
            log.warn('svx.hl.close_rejected', { tradeId: trade.id, raw: closeFill.raw });
          } else {
            const closePx = closeFill.fillPrice;
            const hlPnl =
              trade.hlSide === 'short'
                ? (trade.hlOpenPrice - closePx) * trade.hlSize
                : (closePx - trade.hlOpenPrice) * trade.hlSize;
            // Fall back to standard 3.5bps if cfg isn't passed (tests).
            const feesUsdc = estimateHlFees(
              trade.hlOpenPrice,
              closePx,
              trade.hlSize,
              cfg?.hlTakerFeeRate ?? 0.00035,
            );
            ledger.closeHlLeg(trade.id, {
              closePrice: closePx,
              pnlUsdc: hlPnl,
              fundingPaidUsdc: fundingAtClose,
              feesUsdc,
              closedAtMs: Date.now(),
            });
            log.info('svx.hl.closed', {
              tradeId: trade.id,
              side: trade.hlSide,
              size: trade.hlSize,
              openPx: trade.hlOpenPrice,
              closePx,
              grossPnlUsdc: hlPnl.toFixed(4),
              feesUsdc: feesUsdc.toFixed(4),
              fundingUsdc: fundingAtClose.toFixed(4),
              netPnlUsdc: (hlPnl - feesUsdc - fundingAtClose).toFixed(4),
            });
          }
        } catch (e) {
          log.error('svx.hl.close_failed', { tradeId: trade.id, err: errMsg(e) });
        }
      }
    }

    // Redeem winning shares. Group all winners on this market into a single
    // tx (one redeem covers the operator's full balance on the conditionId).
    const winners = trades.filter((t) => t.polyOutcome === resolution.winningOutcome);
    if (winners.length === 0) continue;
    const totalShares = winners.reduce((s, t) => s + (t.polyFilledShares ?? 0), 0);
    if (totalShares <= 0) continue;

    // Safe-mode limitation: the Safe (not the EOA we sign with) owns the
    // outcome shares. Direct EOA-signed redeem calls would revert with
    // "no balance". Marked 'pending' (NOT 'failed') — these are manual-claim
    // rows, not errors: the retry queue skips them, but the unredeemed-payout
    // total on /status keeps them loud until the operator clicks "Claim" on
    // polymarket.com. Auto-redeem via Safe.execTransaction is follow-up work.
    if (polyExec.signatureMode !== 'EOA') {
      for (const w of winners) ledger.markPolyRedeemed(w.id, null, 'pending');
      log.warn('svx.poly.redeem.skipped_safe_mode', {
        conditionId: conditionId.slice(0, 10),
        winnerCount: winners.length,
        totalShares,
        hint:
          'Operator: click "Claim" on the resolved market at polymarket.com to redeem shares.',
      });
      continue;
    }

    await attemptPolyRedeem(polyExec, ledger, conditionId, resolution.negRisk, {
      winningOutcome: resolution.winningOutcome,
      winners,
      totalShares,
    });
  }

  // Retry pass for previously-FAILED redeems (transient RPC errors, a
  // negRisk flag gamma omitted last time, …). Backoff + attempt cap live in
  // the ledger query. Pre-2026-07 a failed redeem was parked forever behind
  // one warn line; winnings stayed stranded until the operator noticed.
  if (polyExec.signatureMode === 'EOA') {
    const retryable = ledger
      .unredeemedWinningPolyTrades({
        maxAttempts: cfg?.polyRedeemMaxAttempts ?? 5,
        retryGapMs: cfg?.polyRedeemRetryGapMs ?? 30 * 60_000,
      })
      .filter((t) => t.polyRedeemStatus === 'failed');
    const retryByCondition = new Map<string, typeof retryable>();
    for (const t of retryable) {
      if (!t.polyConditionId) continue;
      const list = retryByCondition.get(t.polyConditionId) ?? [];
      list.push(t);
      retryByCondition.set(t.polyConditionId, list);
    }
    for (const [conditionId, winners] of retryByCondition) {
      const totalShares = winners.reduce((s, t) => s + (t.polyFilledShares ?? 0), 0);
      const outcome = winners[0]?.polySettlementOutcome;
      if (totalShares <= 0 || (outcome !== 'yes' && outcome !== 'no')) continue;
      // Re-fetch resolution — the retry may exist precisely because negRisk
      // was unknown on the previous attempt.
      const resolution = await poly.getMarketResolution(conditionId);
      log.info('svx.poly.redeem.retry', {
        conditionId: conditionId.slice(0, 10),
        winnerCount: winners.length,
      });
      await attemptPolyRedeem(polyExec, ledger, conditionId, resolution?.negRisk, {
        winningOutcome: outcome,
        winners,
        totalShares,
      });
    }
  }
}

/**
 * Submit one redeem tx covering all winning trades on a conditionId, and
 * persist the outcome. Refuses to submit when the negRisk flag is UNKNOWN —
 * guessing routes NegRisk markets through the wrong contract (guaranteed
 * revert, gas burned); marking 'failed' instead lets the retry pass re-fetch
 * the flag later while the unredeemed total stays visible on /status.
 */
async function attemptPolyRedeem(
  polyExec: PolymarketExecClient,
  ledger: LedgerStore,
  conditionId: string,
  negRisk: boolean | undefined,
  args: {
    winningOutcome: 'yes' | 'no';
    winners: Array<{ id: string }>;
    totalShares: number;
  },
): Promise<void> {
  const { winningOutcome, winners, totalShares } = args;
  if (negRisk === undefined) {
    for (const w of winners) ledger.markPolyRedeemed(w.id, null, 'failed');
    log.error('svx.poly.redeem.negrisk_unknown', {
      conditionId: conditionId.slice(0, 10),
      winnerCount: winners.length,
      note: 'gamma omitted the negRisk flag; refusing to guess the contract — will retry',
    });
    return;
  }
  try {
    const txHash = await polyExec.redeemPolyWinnings({
      conditionId,
      negRisk,
      winningOutcome,
      shares: totalShares,
    });
    for (const w of winners) ledger.markPolyRedeemed(w.id, txHash, 'success');
    log.info('svx.poly.redeem.success', {
      conditionId: conditionId.slice(0, 10),
      tx: txHash,
      winnerCount: winners.length,
      totalShares,
    });
  } catch (e) {
    const err = errMsg(e);
    for (const w of winners) ledger.markPolyRedeemed(w.id, null, 'failed');
    log.error('svx.poly.redeem.failed', {
      conditionId: conditionId.slice(0, 10),
      winnerCount: winners.length,
      err,
      note: 'will retry with backoff; unredeemed total surfaced on /status',
    });
  }
}

/**
 * Reconcile ledger rows the bot still calls "unredeemed" against the
 * funder's ACTUAL on-chain ERC1155 balance.
 *
 * In every non-EOA signature mode (POLY_1271, POLY_GNOSIS_SAFE, POLY_PROXY)
 * `redeemPolyWinnings` can never succeed as a bot-submitted transaction: the
 * EOA can sign order messages on the Deposit Wallet / Safe's behalf (that's
 * what EIP-1271 / Safe-owner signatures are for), but `redeemPositions`
 * burns tokens from `msg.sender`'s own balance and pays out to
 * `msg.sender` — there's no "redeem on behalf of" parameter. The Deposit
 * Wallet itself has to be the caller, which requires the operator to claim
 * manually through Polymarket's UI (its "Redeem" button constructs that
 * transaction). The ledger has no event feed for that — a manual claim is
 * on-chain, but nothing pings the bot when it happens.
 *
 * So: for every row still marked unredeemed, check whether the funder
 * already holds zero of that outcome token. If a market resolved and we're
 * not holding the winning side anymore, and we never sold it early either,
 * the only way that happens is redemption — done outside the bot. Mark it
 * redeemed with a sentinel hash so `/status`'s unredeemed total and the
 * reconciliation invariant stop treating already-claimed money as pending.
 *
 * Runs regardless of signatureMode (harmless no-op for EOA rows, which
 * clear their own tx hash via `attemptPolyRedeem` before ever reaching this
 * check). Ignores the submit-retry backoff/attempt cap entirely — this is a
 * read-only balance check, not a resubmission, so there's no reason to
 * throttle it the same way.
 */
export async function reconcileExternallyRedeemedPositions(args: {
  polyExec: Pick<PolymarketExecClient, 'getConditionalTokenBalance'>;
  ledger: LedgerStore;
}): Promise<void> {
  const { polyExec, ledger } = args;
  const rows = ledger.unredeemedWinningPolyTrades({
    maxAttempts: Number.MAX_SAFE_INTEGER,
    retryGapMs: 0,
  });
  if (rows.length === 0) return;

  // Group by outcome token — balance is per-token, and repeat buys on the
  // same market produce multiple ledger rows sharing one token.
  const byToken = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.polyTokenId) continue;
    const list = byToken.get(r.polyTokenId) ?? [];
    list.push(r);
    byToken.set(r.polyTokenId, list);
  }

  for (const [tokenId, group] of byToken) {
    let balance: bigint;
    try {
      balance = await polyExec.getConditionalTokenBalance(tokenId);
    } catch (e) {
      log.debug('svx.poly.redeem.onchain_check_failed', {
        tokenId: tokenId.slice(0, 12) + '…',
        err: errMsg(e),
      });
      continue;
    }
    if (balance === 0n) {
      const totalPayout = group.reduce((s, t) => s + (t.polyPayoutUsdc ?? 0), 0);
      for (const row of group) {
        ledger.markPolyRedeemed(row.id, 'external-claim', 'success');
      }
      log.info('svx.poly.redeem.reconciled_external_claim', {
        tokenId: tokenId.slice(0, 12) + '…',
        rows: group.length,
        totalPayoutUsdc: totalPayout.toFixed(2),
        note: 'on-chain balance already 0 — claimed manually outside the bot; ledger now matches reality',
      });
    }
  }
}

/**
 * Vol-arb strategy step. Runs on its own fast ticker (`cfg.volArbTickMs`,
 * default 2s) — decoupled from the 15s poly-arb loop so a slow Polymarket
 * HTTP call can't starve the signal.
 *
 * Always-on for telemetry (records BTC mids, computes IV / RV / decisions).
 * Only fires HL orders when `cfg.volArbEnabled === true` AND
 * `cfg.hlExecutionEnabled === true`.
 *
 * Predict ATM-IV is cached for `cfg.volArbOracleCacheMs` (default 30s) — at
 * 2s ticks we'd otherwise hit Predict 30× more often than needed, and IV
 * doesn't move tick-to-tick.
 *
 * Position lifecycle:
 *   - Open: |IV − RV| > openThresh AND surface bias clear
 *   - Close: |IV − RV| < closeThresh OR time-stop hit
 */
async function runVolArbStep(args: {
  cfg: SvxConfig;
  state: BotState;
  ledger: LedgerStore;
  risk: RiskGate;
  hlExec: HyperliquidExecClient;
  predict: PredictClient;
}): Promise<void> {
  const { cfg, state, ledger, risk, hlExec, predict } = args;
  const nowMs = Date.now();

  // 1. Sample current BTC mid from HL and append to the rolling buffer.
  let btcMid: number | null = null;
  try {
    btcMid = await hlExec.getMid(cfg.hlHedgeAsset);
  } catch (e) {
    log.debug('svx.vol_arb.mid_failed', { err: errMsg(e) });
    return;
  }
  if (btcMid && isFinite(btcMid) && btcMid > 0) {
    appendVolArbMid(state.volArb, { ts: nowMs, price: btcMid });
  }

  // 2. Require warm-up.
  if (state.volArb.midHistory.length < cfg.volArbMinSamples) {
    return;
  }

  // 3. Get the shortest-expiry BTC oracle snapshot. Cached: at 2s ticks we
  //    would otherwise hammer Predict; ATM IV barely moves in 30s.
  const cache = state.cachedAtmIvSnapshot;
  let snap: OracleSnapshot | undefined = cache?.snap;
  if (!cache || nowMs - cache.computedAtMs > cfg.volArbOracleCacheMs) {
    try {
      const oracleSummaries = await predict.listActiveOracles('BTC');
      const btcOracles = oracleSummaries
        .filter((o) => o.underlyingAsset === 'BTC' && o.status === 'active' && o.expiryMs > nowMs)
        .sort((a, b) => a.expiryMs - b.expiryMs);
      if (btcOracles.length === 0) return;
      const fresh = await predict.snapshotOracle(btcOracles[0]!.oracleId);
      if (fresh) {
        snap = fresh;
        state.cachedAtmIvSnapshot = { snap: fresh, computedAtMs: nowMs };
      }
    } catch (e) {
      log.debug('svx.vol_arb.oracle_refresh_failed', { err: errMsg(e) });
      // Fall through with stale snap if we have one; else bail.
      if (!snap) return;
    }
  }
  if (!snap) return;

  // 4. Compute IV / RV / surface bias.
  const ivResult = computePredictAtmIv([snap], nowMs);
  if (!ivResult) return;
  const realizedVol = computeRealizedVol(state.volArb.midHistory);
  const predictUpAtSpot = computePredictUpAtSpot(ivResult.oracle, nowMs);

  // 4. Identify any open vol-arb position. v1 supports at most one at a time.
  const openVolArb = ledger.openVolArbTrades();
  const openPos = openVolArb[0];
  const openPosAgeMs = openPos ? nowMs - openPos.timestampMs : undefined;

  // 5. Decide.
  const decision = decideVolArb({
    predictIv: ivResult.iv,
    realizedVol,
    predictUpAtSpot,
    hasOpenPosition: !!openPos,
    openPositionAgeMs: openPosAgeMs,
    cfg,
    nowMs,
  });

  let acted = false;

  // 6. Execute (or just record).
  if (cfg.volArbEnabled && cfg.hlExecutionEnabled) {
    if (decision.action === 'open_long' || decision.action === 'open_short') {
      // Size the trade against per-trade USD cap.
      const usdNotional = cfg.maxVolArbPerTradeUsdc;
      const riskCheck = risk.checkVolArb({
        notionalUsdc: usdNotional,
        openVolArbExposureUsdc: ledger.openVolArbExposureUsdc(),
      });
      if (!riskCheck.ok) {
        log.info('svx.vol_arb.risk_blocked', { reason: riskCheck.reason });
      } else if (usdNotional < cfg.hlMinOrderUsdc) {
        // Hyperliquid rejects orders < $10. Bumping maxVolArbPerTradeUsdc
        // above the minimum is the real fix; this guard keeps us from
        // spamming the API every 2s if it's misconfigured.
        log.info('svx.vol_arb.below_min_order', {
          usdNotional: usdNotional.toFixed(2),
          min: cfg.hlMinOrderUsdc,
        });
      } else {
        const btcSize = btcSizeForUsdNotional(usdNotional, btcMid ?? ivResult.oracle.spot);
        const side: 'long' | 'short' = decision.action === 'open_long' ? 'long' : 'short';
        try {
          const fill = await hlExec.openMarketPerp({
            asset: cfg.hlHedgeAsset,
            side,
            size: btcSize,
          });
          if (fill.status === 'filled' && fill.orderId && fill.fillPrice > 0) {
            const tradeId = ledger.insertTrade({
              signalId: 'vol_arb',
              timestampMs: nowMs,
              mode: 'live',
              oracleId: ivResult.oracle.oracleId,
              underlyingAsset: ivResult.oracle.underlyingAsset,
              expiryMs: ivResult.oracle.expiryMs,
              strike: ivResult.oracle.spot,
              direction: side === 'long' ? 'up' : 'down',
              quantityDusdc: 0,
              costPrice: 0,
              costUsdc: 0,
              settled: false,
              strategy: 'vol_arb',
              predictIvAtExec: ivResult.iv,
            });
            ledger.recordHlLeg(tradeId, {
              asset: cfg.hlHedgeAsset,
              orderId: fill.orderId,
              size: fill.filledSize,
              side,
              openPrice: fill.fillPrice,
              status: 'open',
            });
            acted = true;
            log.info('svx.vol_arb.opened', {
              side,
              size: fill.filledSize,
              price: fill.fillPrice,
              ivSpread: decision.ivSpread,
              predictUpAtSpot,
              tradeId,
            });
          } else {
            log.warn('svx.vol_arb.open_partial_or_rejected', {
              status: fill.status,
              filledSize: fill.filledSize,
            });
          }
        } catch (e) {
          log.error('svx.vol_arb.open_failed', { err: errMsg(e) });
        }
      }
    } else if (decision.action === 'close' && openPos && openPos.hlSize && openPos.hlSide) {
      try {
        const fundingAtClose = await readCumFundingForAsset(
          hlExec,
          openPos.hlAsset ?? 'BTC',
        );
        const closeFill = await hlExec.closeMarketPerp({
          asset: openPos.hlAsset ?? 'BTC',
          originalSide: openPos.hlSide,
          size: openPos.hlSize,
        });
        if (closeFill.status !== 'rejected' && closeFill.fillPrice > 0 && openPos.hlOpenPrice) {
          const closePx = closeFill.fillPrice;
          const pnl =
            openPos.hlSide === 'short'
              ? (openPos.hlOpenPrice - closePx) * openPos.hlSize
              : (closePx - openPos.hlOpenPrice) * openPos.hlSize;
          const feesUsdc = estimateHlFees(
            openPos.hlOpenPrice,
            closePx,
            openPos.hlSize,
            cfg.hlTakerFeeRate,
          );
          ledger.closeHlLeg(openPos.id, {
            closePrice: closePx,
            pnlUsdc: pnl,
            fundingPaidUsdc: fundingAtClose,
            feesUsdc,
            closedAtMs: nowMs,
          });
          acted = true;
          log.info('svx.vol_arb.closed', {
            tradeId: openPos.id,
            reason: decision.reason,
            grossPnlUsdc: pnl.toFixed(4),
            feesUsdc: feesUsdc.toFixed(4),
            fundingUsdc: fundingAtClose.toFixed(4),
            netPnlUsdc: (pnl - feesUsdc - fundingAtClose).toFixed(4),
            ageMinutes: (openPosAgeMs! / 60_000).toFixed(1),
          });
        } else {
          log.warn('svx.vol_arb.close_rejected', { tradeId: openPos.id, raw: closeFill.raw });
        }
      } catch (e) {
        const msg = errMsg(e);
        // HL says "reduce-only would INCREASE position" iff we're asking it
        // to close a position that isn't actually there. Cause: ledger drift
        // (manual close on HL, funding-liquidation, or a prior close that
        // filled but crashed before ledger commit). Retrying every 3s spams
        // the exchange forever, so reconcile: mark the leg closed with 0
        // realized PnL (we can't reconstruct the phantom close price). Use
        // the recorded openPrice so audit doesn't show a bogus mark.
        if (/reduce only order would increase position/i.test(msg)) {
          ledger.closeHlLeg(openPos.id, {
            closePrice: openPos.hlOpenPrice ?? 0,
            pnlUsdc: 0,
            fundingPaidUsdc: 0,
            feesUsdc: 0,
            closedAtMs: nowMs,
          });
          log.warn('svx.vol_arb.reconciled_flat_on_hl', {
            tradeId: openPos.id,
            note: 'HL had no position to close; leg marked closed with 0 PnL to stop retry spam',
          });
        } else {
          log.error('svx.vol_arb.close_failed', { tradeId: openPos.id, err: msg });
        }
      }
    }
  }

  recordVolArbDecision(state.volArb, decision, acted);
}

/**
 * Favored-side mint execution — bet the side Predict prices above 50¢.
 * Shared by divergence-mint (divergence ≥ threshold) and calibration-harvest
 * (the complement band, tighter price cap); the caller passes the band's
 * gates + strategy tag. Predict-side only (no Poly leg, no hedge).
 * Settlement, PnL, and redeem ride the existing oracle-settlement machinery —
 * the trade row is a normal Predict trade tagged with the strategy.
 */
async function maybeFavoredMint(args: {
  ledger: LedgerStore;
  cfg: SvxConfig;
  live?: LiveContext;
  state: BotState;
  sigId: string;
  oracleSnap: OracleSnapshot;
  polySnap: PolymarketSnapshot;
  predictUp: number;
  polyYesAsk: number;
  predictIv: number;
  divergence: number;
  strategy: 'divergence_mint' | 'calibration_harvest';
  notionalDusdc: number;
  gates: FavoredMintGates;
}): Promise<void> {
  const { ledger, cfg, live, state, oracleSnap, polySnap, strategy, gates } = args;
  const nowMs = Date.now();

  // Tenor gate: the favored-side edge is validated on sub-day oracle cycles
  // (~5.6h average). Predict also lists longer-dated oracles (weeklies) —
  // out-of-sample tenor, and each mint parks a clip until expiry with no
  // exit primitive. Stand down beyond the validated horizon.
  const ttmMs = oracleSnap.expiryMs - nowMs;
  if (ttmMs > cfg.favoredMintMaxTtmHours * 3600_000) {
    log.debug('svx.divergence.skip', {
      oracle: oracleSnap.oracleId.slice(0, 10),
      strategy,
      reason: `ttm_beyond_validated:${(ttmMs / 3600_000).toFixed(1)}h>${cfg.favoredMintMaxTtmHours}h`,
    });
    return;
  }

  // Cross-strategy dedupe: divergence can drift across the band boundary
  // between ticks, so one (oracle, strike) must never hold BOTH a mint and
  // a harvest — that would be double exposure to one settlement event.
  // ALSO refuse when ANY strategy holds the OPPOSITE direction on this
  // (oracle, strike): the arb leg runs earlier in the same tick and can
  // open the other side — stacking UP+DOWN pays the protocol spread on a
  // partially self-cancelling position (the audit's opposite-block, which
  // only guarded the arb path, extended to the favored-mint path).
  const favoredDirection: 'up' | 'down' = args.predictUp >= 0.5 ? 'up' : 'down';
  const hasOpenForSignal =
    ledger.hasOpenStrategyTradeForSignal(oracleSnap.oracleId, polySnap.strike, 'divergence_mint') ||
    ledger.hasOpenStrategyTradeForSignal(
      oracleSnap.oracleId,
      polySnap.strike,
      'calibration_harvest',
    ) ||
    ledger.hasOppositeOpenForSignal(oracleSnap.oracleId, polySnap.strike, favoredDirection);

  const decision = decideFavoredMint(
    {
      predictUp: args.predictUp,
      divergence: args.divergence,
      expiryMs: oracleSnap.expiryMs,
      nowMs,
      hasOpenForSignal,
      openStrategyCount: ledger.countOpenStrategyTrades(strategy),
      dailyStrategyPnlUsdc: ledger.realizedStrategyPnlSince(strategy, nowMs - 24 * 3600_000),
    },
    gates,
    strategy,
  );

  if (!decision.enter) {
    // Only surface skips rejected by risk gates (dedupe/caps/standdown) —
    // band/threshold skips are the boring 99% of the stream.
    if (
      decision.reason !== 'bad_predict_prob' &&
      !decision.reason.startsWith('sub_threshold') &&
      !decision.reason.startsWith('above_band')
    ) {
      log.debug('svx.divergence.skip', {
        oracle: oracleSnap.oracleId.slice(0, 10),
        strike: polySnap.strike,
        strategy,
        reason: decision.reason,
      });
    }
    return;
  }

  const quantityDusdc = args.notionalDusdc;
  const costUsdc = quantityDusdc * decision.costPrice;
  let txDigest: string | undefined;
  let mode: 'paper' | 'live' = 'paper';

  if (!cfg.paperTrading && live) {
    // Mirror the arb leg's top-up rule: refill the manager from the wallet
    // only when the wallet can actually cover it (testnet wallets hold dust).
    const wantedTopUpDusdc = Math.min(costUsdc * 1.5, quantityDusdc);
    const walletCoinIds = await getOperatorDusdcCoinIds(live);
    const walletDusdc =
      walletCoinIds.length > 0
        ? Number(
            (
              await live.sui.getBalance({
                owner: live.operatorAddress,
                coinType: ADDRESSES.dusdcType,
              })
            ).totalBalance,
          ) / Number(QUOTE_UNIT)
        : 0;
    const shouldTopUp = walletDusdc >= wantedTopUpDusdc;
    const tx = buildMintTx({
      oracleId: oracleSnap.oracleId,
      expiryMs: oracleSnap.expiryMs,
      strike: polySnap.strike,
      direction: decision.direction,
      quantityDusdc,
      managerId: live.managerId,
      topUpDusdc: shouldTopUp ? wantedTopUpDusdc : 0,
      dusdcCoinObjectIds: shouldTopUp ? walletCoinIds : undefined,
    });
    const result = await submitTx(live.sui, tx, live.keypair);
    if (!result.ok) {
      log.warn('svx.divergence.live_failed', {
        digest: result.digest,
        error: result.error,
        status: result.status,
      });
      return;
    }
    txDigest = result.digest;
    mode = 'live';
    state.navUsdc = await readManagerBalance(live);
  }

  ledger.insertTrade({
    signalId: args.sigId,
    timestampMs: nowMs,
    mode,
    oracleId: oracleSnap.oracleId,
    underlyingAsset: oracleSnap.underlyingAsset,
    expiryMs: oracleSnap.expiryMs,
    strike: polySnap.strike,
    direction: decision.direction,
    quantityDusdc,
    costPrice: decision.costPrice,
    costUsdc,
    txDigest,
    settled: false,
    msToExpiryAtExec: oracleSnap.expiryMs - nowMs,
    predictProbAtExec: args.predictUp,
    polyAskAtExec: args.polyYesAsk,
    predictIvAtExec: args.predictIv,
    edgeAtExec: args.divergence,
    strategy,
  });
  if (mode === 'paper') {
    state.navUsdc -= costUsdc;
  }
  log.info(`svx.divergence.${mode}_executed`, {
    strategy,
    oracleId: oracleSnap.oracleId,
    strike: polySnap.strike,
    dir: decision.direction,
    costPrice: decision.costPrice,
    notional: quantityDusdc,
    cost: costUsdc,
    divergence: args.divergence,
    reason: decision.reason,
    ...(txDigest && { txDigest }),
  });
}

async function reconcileSettlements(
  predict: PredictClient,
  ledger: LedgerStore,
  live?: LiveContext,
): Promise<void> {
  const all = await predict.listOracles(true);
  const settled = all.filter((o) => o.status === 'settled' && o.settlementPrice != null);
  for (const o of settled) {
    if (o.settlementPrice == null) continue;
    ledger.recordSettlement(o.oracleId, o.underlyingAsset, o.expiryMs, o.settlementPrice, Date.now());
    const settledCount = ledger.settleTradesForOracle(o.oracleId, o.settlementPrice, Date.now());
    if (settledCount > 0) {
      log.info('svx.settlements.applied', {
        oracleId: o.oracleId,
        settlementPrice: o.settlementPrice,
        tradesSettled: settledCount,
      });
    }
  }

  // Auto-redeem winning live trades on-chain. Skip lost trades — payout is
  // zero and redeeming just burns gas. Money lands in the manager balance.
  if (live) {
    const toRedeem = ledger.unredeemedWinningTrades();
    for (const t of toRedeem) {
      try {
        const tx = buildRedeemTx({
          oracleId: t.oracleId,
          expiryMs: t.expiryMs,
          strike: t.strike,
          direction: t.direction,
          quantityDusdc: t.quantityDusdc,
          managerId: live.managerId,
          permissionless: true,
        });
        const result = await submitTx(live.sui, tx, live.keypair);
        if (result.ok) {
          ledger.markRedeemed(t.id, result.digest);
          log.info('svx.redeem.success', {
            tradeId: t.id,
            oracleId: t.oracleId,
            strike: t.strike,
            payoutUsdc: t.payoutUsdc,
            digest: result.digest,
          });
        } else {
          log.warn('svx.redeem.failed', {
            tradeId: t.id,
            digest: result.digest,
            error: result.error,
          });
        }
      } catch (e) {
        log.warn('svx.redeem.error', {
          tradeId: t.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}

async function snapshotPolymarket(
  poly: PolymarketClient,
  market: PolyStrikeMarket,
): Promise<PolymarketSnapshot | null> {
  try {
    const [yes, no] = await Promise.all([
      poly.orderBook(market.conditionId, market.yesTokenId),
      poly.orderBook(market.conditionId, market.noTokenId).catch(() => null as PolyOrderBook | null),
    ]);
    if (!yes.bid || !yes.ask) return null;
    return {
      conditionId: market.conditionId,
      strike: market.strike,
      expiryMs: market.expiryMs,
      yesBid: yes.bid.bestPrice,
      yesAsk: yes.ask.bestPrice,
      yesBidSize: yes.bid.bestSize,
      yesAskSize: yes.ask.bestSize,
      noBid: no?.bid?.bestPrice ?? 1 - yes.ask.bestPrice,
      noAsk: no?.ask?.bestPrice ?? 1 - yes.bid.bestPrice,
      noBidSize: no?.bid?.bestSize,
      noAskSize: no?.ask?.bestSize,
      volume24hUsd: market.volume24hr,
      fetchedAtMs: yes.timestamp,
      // Carry the CLOB token IDs through so the execution layer can submit
      // orders without re-fetching the gamma metadata.
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
    };
  } catch (e) {
    log.warn('svx.poly.snapshot_failed', { conditionId: market.conditionId, err: errMsg(e) });
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
/**
 * Read cumulative funding for our position on `asset` before closing, so we
 * can subtract the actual funding cost from PnL. After the position closes
 * HL drops it from `getOpenPositions()` and the funding number is gone.
 *
 * Returns 0 if the position isn't found (already closed, or HL API hiccupped).
 */
async function readCumFundingForAsset(
  hlExec: HyperliquidExecClient,
  asset: string,
): Promise<number> {
  try {
    const positions = await hlExec.getOpenPositions();
    const ours = positions.find((p) => p.asset === asset);
    return ours?.cumFundingUsdc ?? 0;
  } catch {
    return 0;
  }
}

/** Estimated HL taker fees on open + close legs combined. IOC orders are
 *  always taker, so both legs pay. */
function estimateHlFees(
  openPrice: number,
  closePrice: number,
  size: number,
  takerRate: number,
): number {
  const openNotional = openPrice * size;
  const closeNotional = closePrice * size;
  return (openNotional + closeNotional) * takerRate;
}

/**
 * Margin-Lever (paper) tick. Pull the shortest BTC oracle, compute
 * P(↑) at spot, decide, apply. No PTBs submitted — see
 * strategy/margin-lever.ts for the framing.
 *
 * Independent from poly-arb (15s) and vol-arb (2s). Only the Predict
 * snapshot is read; nothing on Sui mainnet or HL is touched, so this
 * is always safe to run.
 */
async function runMarginLeverStep(args: {
  cfg: SvxConfig;
  state: BotState;
  predict: PredictClient;
}): Promise<void> {
  const { cfg, state, predict } = args;
  if (!cfg.marginLeverEnabled) return;
  const nowMs = Date.now();
  let oracle: OracleSnapshot | null = null;
  try {
    const oracles = await predict.listActiveOracles('BTC');
    const shortest = oracles
      .filter((o) => o.status === 'active' && o.expiryMs > nowMs)
      .sort((a, b) => a.expiryMs - b.expiryMs)[0];
    if (!shortest) return;
    oracle = await predict.snapshotOracle(shortest.oracleId);
  } catch (e) {
    log.debug('svx.margin_lever.oracle_refresh_failed', { err: errMsg(e) });
    return;
  }
  if (!oracle) return;
  const spot = oracle.spot;
  const since24h = nowMs - 24 * 3600_000;
  const pnl24h = marginLeverRealizedPnlSince(state.marginLever, since24h);
  const decision = decideMarginLever({
    oracle,
    spot,
    nowMs,
    thresholds: {
      openBias: cfg.marginLeverOpenBias,
      closeBias: cfg.marginLeverCloseBias,
      maxHoldMs: cfg.marginLeverMaxHoldMinutes * 60_000,
    },
    caps: {
      perTradeNotionalUsdc: cfg.marginLeverPerTradeNotionalUsdc,
      maxBorrowNotionalUsdc: cfg.marginLeverMaxBorrowNotionalUsdc,
      dailyLossLimitUsdc: cfg.marginLeverDailyLossLimitUsdc,
    },
    state: state.marginLever,
    pnl24hUsdc: pnl24h,
  });
  const acted = applyMarginLeverDecision(
    state.marginLever,
    decision,
    {
      perTradeNotionalUsdc: cfg.marginLeverPerTradeNotionalUsdc,
      maxBorrowNotionalUsdc: cfg.marginLeverMaxBorrowNotionalUsdc,
      dailyLossLimitUsdc: cfg.marginLeverDailyLossLimitUsdc,
    },
    oracle.oracleId,
  );
  if (acted || decision.action !== 'hold') {
    log.info('svx.margin_lever.decision', {
      action: decision.action,
      reason: decision.reason,
      pUp: decision.predictUpAtSpot,
      bias: decision.biasMagnitude,
      spot,
      acted,
      hasOpen: !!state.marginLever.open,
    });
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function errStack(e: unknown): string | undefined {
  return e instanceof Error ? e.stack : undefined;
}

// CLI entry — `pnpm svx start`
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();
if (isMain) {
  runBot().catch((e) => {
    log.error('svx.fatal', { err: errMsg(e), stack: errStack(e) });
    process.exit(1);
  });
}
