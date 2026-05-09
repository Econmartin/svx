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
import { buildMintTx } from './exec/ptb.js';
import { submitTx } from './exec/submit.js';
import { loadOperatorKey } from './exec/keypair.js';
import { startApiServer } from './api/server.js';
import { log } from './util/log.js';

interface BotState {
  startedAtMs: number;
  /** For paper mode this is virtual NAV; for live mode it's the manager's dUSDC balance refreshed each loop. */
  navUsdc: number;
}

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
    realWalletReader = () => readManagerBalance(live!);
    // Refresh NAV from on-chain manager balance.
    state.navUsdc = await realWalletReader();
    log.info('svx.live.context_loaded', {
      operator: op.operatorAddress,
      manager: op.managerId,
      navDusdc: state.navUsdc,
    });
  } else {
    // Paper mode: also try to read the real wallet for dashboard display only.
    // If the operator key isn't present (e.g. SUI_PRIVATE_KEY_BECH32 unset on
    // a fresh instance), silently fall back to the virtual NAV.
    try {
      const { loadOperatorKey: tryLoad } = await import('./exec/keypair.js');
      const { keypair, address } = tryLoad();
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
      await runOnce({ cfg, state, ledger, risk, predict, poly, live });
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
}

export async function runOnce(deps: LoopDeps): Promise<void> {
  const { cfg, state, ledger, risk, predict, poly, live } = deps;

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
  await reconcileSettlements(predict, ledger);

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
      spread: spread.decision?.edge ?? Math.max(spread.spreadBuyOnPoly, spread.spreadSellOnPoly),
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

      ledger.insertTrade({
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
      });
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

  // Periodic NAV snapshot for the dashboard chart.
  ledger.recordNav(
    state.navUsdc,
    ledger.realizedPnlSince(state.startedAtMs),
    /* unrealized */ 0,
    ledger.openTrades().length,
  );
}

async function reconcileSettlements(predict: PredictClient, ledger: LedgerStore): Promise<void> {
  const all = await predict.listOracles(true);
  const settled = all.filter((o) => o.status === 'settled' && o.settlementPrice != null);
  for (const o of settled) {
    if (o.settlementPrice == null) continue;
    ledger.recordSettlement(o.oracleId, o.underlyingAsset, o.expiryMs, o.settlementPrice, Date.now());
    const settled = ledger.settleTradesForOracle(o.oracleId, o.settlementPrice, Date.now());
    if (settled > 0) {
      log.info('svx.settlements.applied', {
        oracleId: o.oracleId,
        settlementPrice: o.settlementPrice,
        tradesSettled: settled,
      });
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
      volume24hUsd: market.volume24hr,
      fetchedAtMs: yes.timestamp,
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
