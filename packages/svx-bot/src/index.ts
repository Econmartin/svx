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
import { PredictClient, type PredictOracleSummary } from './pricing/predict.js';
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
import { hedgeSizeForPolyFill } from './pricing/binary-delta.js';
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
  /** Last time the bot attempted an HL hedge (success or fail). 0 if never. */
  lastHlAttemptAtMs: number;
  /** Last time we polled gamma for Polymarket settlement / ran auto-redeem.
   *  UMA resolves markets hours after expiry, so 5-min cadence is plenty. */
  lastPolySettlementCheckMs: number;
}

const MANAGER_BALANCE_REFRESH_MS = 30_000;
const POLY_BALANCE_REFRESH_MS = 60_000;
const HL_BALANCE_REFRESH_MS = 60_000;
const POLY_SETTLEMENT_CHECK_INTERVAL_MS = 5 * 60_000; // every 5 minutes — UMA resolution takes hours, no benefit polling faster

const PRUNE_INTERVAL_MS = 6 * 3600_000; // every 6 hours
const RETENTION = {
  signalsKeep: 50_000, // ~few weeks of high-signal rows after the log floor
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

  const state: BotState = {
    startedAtMs: Date.now(),
    navUsdc: PAPER_INITIAL_NAV,
    managerBalanceUsdc: 0,
    lastManagerBalanceAtMs: 0,
    lastPruneAtMs: 0,
    lastPolyBalanceAtMs: 0,
    lastHlBalanceAtMs: 0,
    lastPolyAttemptAtMs: 0,
    lastHlAttemptAtMs: 0,
    lastPolySettlementCheckMs: 0,
  };

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
  });

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
      stopApi?.();
      ledger.close();
      return;
    }
    const elapsed = Date.now() - t0;
    const wait = Math.max(0, cfg.loopIntervalMs - elapsed);
    await sleep(wait);
  }
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
      await reconcilePolySettlements(poly, polyExec, ledger, hlExec);
    } catch (e) {
      log.warn('svx.poly.settlement_loop_error', { err: errMsg(e) });
    }
    state.lastPolySettlementCheckMs = Date.now();
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

  // Refresh Polymarket pUSD + gas balance every POLY_BALANCE_REFRESH_MS.
  // Cheap (two RPC reads) but we throttle to avoid hammering the public RPC.
  if (
    polyExec &&
    Date.now() - state.lastPolyBalanceAtMs > POLY_BALANCE_REFRESH_MS
  ) {
    try {
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
    } catch (e) {
      log.warn('svx.poly.balance_refresh_failed', { err: errMsg(e) });
    }
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

      // Concentration check: don't pyramid into the same (oracle, strike,
      // direction) beyond the per-signal cap. Forces diversification across
      // distinct settlement events.
      const sameSignalOpen = ledger.countOpenPositionsForSignal(
        oracleSnap.oracleId,
        polySnap.strike,
        predictDirection,
      );
      if (sameSignalOpen >= cfg.maxPositionsPerSignal) {
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
        const outcome: 'yes' | 'no' = predictDirection === 'down' ? 'yes' : 'no';
        const polyTokenId = outcome === 'yes' ? polySnap.yesTokenId : polySnap.noTokenId;
        const polyEntryPrice = outcome === 'yes' ? polySnap.yesAsk : polySnap.noAsk;
        // No-side depth is optional; if the No book wasn't fetched we fall
        // back to the Yes-side depth as a proxy (binary markets are usually
        // symmetric in liquidity).
        const polyDepth =
          outcome === 'yes' ? polySnap.yesAskSize : polySnap.noAskSize ?? polySnap.yesAskSize;

        const polyRisk = risk.checkPoly({
          costUsdc: cfg.maxPolyPositionUsdc,
          openPolyPositionCount: ledger.countOpenPolyPositions(),
        });
        if (!polyRisk.ok) {
          log.info('svx.poly.risk_blocked', { reason: polyRisk.reason });
          continue;
        }

        if (polyDepth < cfg.polyMinBookDepthShares) {
          log.info('svx.poly.thin_book', {
            outcome,
            depth: polyDepth,
            min: cfg.polyMinBookDepthShares,
            entryPrice: polyEntryPrice,
          });
          continue;
        }

        state.lastPolyAttemptAtMs = Date.now();
        try {
          log.info('svx.poly.submit', {
            outcome,
            tokenId: polyTokenId.slice(0, 12) + '…',
            usdcAmount: cfg.maxPolyPositionUsdc,
            entryPrice: polyEntryPrice,
          });
          const resp = await polyExec.marketBuy({
            tokenId: polyTokenId,
            usdcAmount: cfg.maxPolyPositionUsdc,
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
            fill = parsePolyFillResponse(resp, cfg.maxPolyPositionUsdc);
          } catch (parseErr) {
            log.error('svx.poly.parse_failed', {
              err: errMsg(parseErr),
              rawResponse: resp,
              note: 'Order MAY have been submitted on-chain — check the wallet history.',
            });
            continue;
          }
          if (fill.status === 'failed') {
            log.warn('svx.poly.fill_failed', { resp: fill.raw });
            continue;
          }
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
      if (cfg.hlExecutionEnabled && hlExec && polyLeg) {
        const ttmYears = Math.max(
          1e-6,
          (oracleSnap.expiryMs - Date.now()) / (365.25 * 24 * 3600 * 1000),
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
        const tx = buildMintTx({
          oracleId: oracleSnap.oracleId,
          expiryMs: oracleSnap.expiryMs,
          strike: polySnap.strike,
          direction: predictDirection,
          quantityDusdc: signalNotional,
          managerId: live.managerId,
          // Top up the manager from the operator wallet for the cost (with a
          // small buffer for the protocol's spread on top of fair price).
          topUpDusdc: Math.min(signalCost * 1.5, signalNotional),
          dusdcCoinObjectIds: await getOperatorDusdcCoinIds(live),
        });
        const result = await submitTx(live.sui, tx, live.keypair);
        if (!result.ok) {
          log.warn('svx.signal.live_failed', {
            digest: result.digest,
            error: result.error,
            status: result.status,
          });
          // Demote to a 'failed' signal record by reinserting; original signal
          // is already in the ledger.
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
    state.lastPruneAtMs = Date.now();
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
export async function reconcilePolySettlements(
  poly: PolymarketClient,
  polyExec: PolymarketExecClient,
  ledger: LedgerStore,
  hlExec?: HyperliquidExecClient,
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
            // Funding paid is not yet wired — leave as 0 for v1 (sub-day
            // expiries make it negligible). Track via a follow-up if it
            // becomes material at scale.
            ledger.closeHlLeg(trade.id, {
              closePrice: closePx,
              pnlUsdc: hlPnl,
              fundingPaidUsdc: 0,
              closedAtMs: Date.now(),
            });
            log.info('svx.hl.closed', {
              tradeId: trade.id,
              side: trade.hlSide,
              size: trade.hlSize,
              openPx: trade.hlOpenPrice,
              closePx,
              pnlUsdc: hlPnl.toFixed(4),
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
    // "no balance". Mark as pending-manual instead of failing — the
    // operator clicks "Claim" on polymarket.com to redeem. Auto-redeem
    // via Safe.execTransaction is follow-up work.
    if (polyExec.signatureMode !== 'EOA') {
      for (const w of winners) ledger.markPolyRedeemed(w.id, null, 'failed');
      log.warn('svx.poly.redeem.skipped_safe_mode', {
        conditionId: conditionId.slice(0, 10),
        winnerCount: winners.length,
        totalShares,
        hint:
          'Operator: click "Claim" on the resolved market at polymarket.com to redeem shares.',
      });
      continue;
    }

    try {
      const txHash = await polyExec.redeemPolyWinnings({
        conditionId,
        negRisk: resolution.negRisk,
        winningOutcome: resolution.winningOutcome,
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
      log.warn('svx.poly.redeem.failed', {
        conditionId: conditionId.slice(0, 10),
        winnerCount: winners.length,
        err,
      });
    }
  }
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
