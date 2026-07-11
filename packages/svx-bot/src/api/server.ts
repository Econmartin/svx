/**
 * Read-only HTTP API for the SVX dashboard.
 *
 * Port and host are env-configurable (`SVX_API_PORT`, `SVX_API_HOST`).
 * All routes return JSON. Errors return `{error: string}` with a 4xx/5xx code.
 */

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import type { LedgerStore } from '../ledger/store.js';
import type { SvxConfig } from '../config.js';
import type { PredictAddresses } from 'svx-shared/addresses';
import type { PredictClient } from '../pricing/predict.js';
import {
  butterflyDensity,
  calendarCheck,
  scanButterfly,
  wingNoArb,
} from '../pricing/svi-arb.js';
import type { MarginLeverState } from '../strategy/margin-lever.js';
import { computeBacktest, computeCalibration, type BacktestSide } from '../ops/backtest.js';
import { computeRangeSim } from '../ops/range-sim.js';
import { computePlpSim } from '../ops/plp-sim.js';
import { computeMarginLoopSim } from '../ops/margin-loop-sim.js';
import { log } from '../util/log.js';

interface ApiDeps {
  ledger: LedgerStore;
  cfg: SvxConfig;
  state: {
    startedAtMs: number;
    suiAddress?: string;
    managerId?: string;
    navUsdc: number;
    managerBalanceUsdc?: number;
    lastManagerBalanceAtMs?: number;
    lastBtcSpot?: { value: number; updatedAtMs: number };
    /** Polymarket pUSD wallet balance — populated by main loop when polyExec
     *  is active. `address` is the FUNDER (Safe or EOA depending on
     *  signature mode); pUSD balance is read from this address. */
    polyBalance?: {
      address: `0x${string}`;
      network: 'amoy' | 'polygon';
      pUsd: number;
      gasPol: number;
      signerAddress?: `0x${string}`;
      signatureMode?: 'EOA' | 'POLY_PROXY' | 'POLY_GNOSIS_SAFE' | 'POLY_1271';
      updatedAtMs: number;
    };
    /** Hyperliquid perp margin balance — populated by the HL_BALANCE_REFRESH
     *  loop when hlExec is configured. Drives the dashboard health panel. */
    hlBalance?: {
      address: `0x${string}`;
      network: 'mainnet' | 'testnet';
      accountValueUsdc: number;
      withdrawableUsdc: number;
      updatedAtMs: number;
    };
    /** HL on-chain open positions snapshot (truth-from-chain). */
    hlPositions?: Array<{
      asset: string;
      side: 'long' | 'short';
      szi: number;
      entryPx: number;
      unrealizedPnlUsd: number;
      cumFundingUsdc: number;
    }>;
    /** Wallet-vs-ledger reconciliation snapshot — see index.ts BotState. */
    polyReconcile?: {
      baselineUsdc: number;
      baselineSetAtMs: number;
      driftUsdc: number;
      thresholdUsdc: number;
      unredeemedPayoutUsdc: number;
      checkedAtMs: number;
    };
    /** When the bot last ATTEMPTED a Polymarket order (success or fail). */
    lastPolyAttemptAtMs?: number;
    /** When the bot last ATTEMPTED an HL hedge (success or fail). */
    lastHlAttemptAtMs?: number;
    /** Vol-arb strategy state snapshot — surfaces IV/RV/decisions to the
     *  dashboard's /vol-arb page. */
    volArb?: {
      midHistory: Array<{ ts: number; price: number }>;
      lastPredictIv: number | null;
      lastRealizedVol: number | null;
      lastDecision: unknown;
      recentDecisions: unknown[];
    };
    /** Margin-Lever (paper) strategy state — see strategy/margin-lever.ts. */
    marginLever?: MarginLeverState;
  };
  predict: PredictClient;
  addresses: PredictAddresses;
}

export function startApiServer(deps: ApiDeps): { app: Express; stop: () => void } {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, uptimeSec: Math.round((Date.now() - deps.state.startedAtMs) / 1000) });
  });

  app.get('/status', (_req, res) => {
    const since24h = Date.now() - 24 * 3600_000;
    const open = deps.ledger.openTrades();
    // All-time realized PnL — survives bot restarts. Falls back to 0 if the
    // ledger is empty.
    const realizedAllTime = deps.ledger.realizedPnlSince(0);
    const realized24h = deps.ledger.realizedPnlSince(since24h);
    // Polymarket-leg PnL — separate stream because the cost asset is pUSD,
    // not dUSDC. Populated by the settlement-poll loop as UMA resolves.
    const realizedPolyAllTime = deps.ledger.realizedPolyPnlSince(0);
    const realizedPoly24h = deps.ledger.realizedPolyPnlSince(since24h);
    // Hyperliquid hedge leg — net of the perp position PnL on each closed trade.
    const realizedHlAllTime = deps.ledger.realizedHlPnlSince(0);
    const realizedHl24h = deps.ledger.realizedHlPnlSince(since24h);
    // HL trading costs (fees + funding) surfaced separately so the dashboard
    // can show drag-vs-gross. realizedHlPnl already nets these out.
    const hlCosts = deps.ledger.hlCostsSince(0);
    const openHlExposureUsdc = deps.ledger.openHlExposureUsdc();
    const pause = deps.ledger.getPause();
    res.json({
      startedAtMs: deps.state.startedAtMs,
      paused: pause.paused,
      pauseReason: pause.reason,
      liveTradingEnabled: !deps.cfg.paperTrading,
      navUsdc: deps.state.navUsdc,
      managerBalanceUsdc: deps.state.managerBalanceUsdc ?? 0,
      managerBalanceAtMs: deps.state.lastManagerBalanceAtMs ?? null,
      totalBalanceUsdc: deps.state.navUsdc + (deps.state.managerBalanceUsdc ?? 0),
      realizedPnlUsdc: realizedAllTime,
      realizedPnl24hUsdc: realized24h,
      unrealizedPnlUsdc: 0,
      openPositionCount: open.length,
      signalsLast24h: deps.ledger.countSignalsSince(since24h),
      tradesLast24h: deps.ledger.countTradesSince(since24h),
      spotBtc: deps.state.lastBtcSpot?.value ?? null,
      spotBtcAtMs: deps.state.lastBtcSpot?.updatedAtMs ?? null,
      predictPackageId: deps.addresses.packageId,
      /** Optional instance label ("testnet", "mainnet", etc.) — null when
       *  unset. Dashboard uses it to render a header badge so two parallel
       *  deployments are visually distinguishable. */
      instanceLabel: deps.cfg.instanceLabel || null,
      // Polymarket leg state.
      // - executionEnabled: gate for whether the bot will SUBMIT orders.
      // - polyAddress / pUSD / gas: surfaced whenever a Poly wallet is
      //   configured (independent of the execution gate), so the dashboard
      //   can show "you have $X pUSD ready" before flipping the switch.
      polyExecutionEnabled: deps.cfg.polyExecutionEnabled,
      polyNetwork: deps.state.polyBalance?.network ?? null,
      polyAddress: deps.state.polyBalance?.address ?? null,
      polySignerAddress: deps.state.polyBalance?.signerAddress ?? null,
      polySignatureMode: deps.state.polyBalance?.signatureMode ?? null,
      polyPusdBalance: deps.state.polyBalance?.pUsd ?? null,
      polyGasPol: deps.state.polyBalance?.gasPol ?? null,
      polyBalanceAtMs: deps.state.polyBalance?.updatedAtMs ?? null,
      // Polymarket realized PnL (pUSD), separate from dUSDC. Populated as
      // markets resolve on UMA. Daily-loss limit fires when 24h ≤ -dailyPolyLossLimitUsdc.
      realizedPolyPnlUsdc: realizedPolyAllTime,
      realizedPolyPnl24hUsdc: realizedPoly24h,
      dailyPolyLossLimitUsdc: deps.cfg.dailyPolyLossLimitUsdc,
      // Winnings the ledger counts as realized but the wallet hasn't received
      // (redeem failed / pending manual claim in Safe mode). Non-zero for
      // long = stranded money; the redeem retry queue works this down.
      unredeemedPolyPayoutUsdc: deps.ledger.unredeemedPolyPayoutUsdc(),
      // Wallet-vs-ledger reconciliation invariant. driftUsdc near 0 = ledger
      // truthful; |drift| > threshold auto-pauses the bot. Null until the
      // first poly balance refresh after boot.
      polyReconcile: deps.state.polyReconcile ?? null,
      // Hyperliquid hedge state.
      hlExecutionEnabled: deps.cfg.hlExecutionEnabled,
      hlNetwork: deps.cfg.hlNetwork,
      hlHedgeAsset: deps.cfg.hlHedgeAsset,
      hlAddress: deps.state.hlBalance?.address ?? null,
      hlAccountValueUsdc: deps.state.hlBalance?.accountValueUsdc ?? null,
      hlWithdrawableUsdc: deps.state.hlBalance?.withdrawableUsdc ?? null,
      hlBalanceAtMs: deps.state.hlBalance?.updatedAtMs ?? null,
      maxHlPerTradeUsdc: deps.cfg.maxHlPerTradeUsdc,
      maxHlOpenUsdc: deps.cfg.maxHlOpenUsdc,
      hlRequiredForPoly: deps.cfg.hlRequiredForPoly,
      openHlExposureUsdc,
      realizedHlPnlUsdc: realizedHlAllTime,
      realizedHlPnl24hUsdc: realizedHl24h,
      hlFeesUsdc: hlCosts.feesUsdc,
      hlFundingUsdc: hlCosts.fundingUsdc,
      dailyHlLossLimitUsdc: deps.cfg.dailyHlLossLimitUsdc,
      // Last attempt timestamps — null if bot has never tried this leg since
      // boot. Lets the health panel distinguish "configured but no chance
      // yet" vs "tried recently".
      lastPolyAttemptAtMs: deps.state.lastPolyAttemptAtMs ?? null,
      lastHlAttemptAtMs: deps.state.lastHlAttemptAtMs ?? null,
      // Risk thresholds + recent activity gates (for the dashboard's
      // "filter reasons" section, future use).
      maxPolyPositionUsdc: deps.cfg.maxPolyPositionUsdc,
      maxOpenPolyPositions: deps.cfg.maxOpenPolyPositions,
      polyMinBookDepthShares: deps.cfg.polyMinBookDepthShares,
      spreadThreshold: deps.cfg.spreadThreshold,
      // Combined cross-venue PnL — what the demo headline should reference.
      // Poly PnL is pUSD, HL PnL is USDC; both stable-pegged → safe to add.
      // Combined PnL is NET — realizedHlPnlUsdc already has fees + funding
      // subtracted via the SUM in realizedHlPnlSince.
      realizedCombinedPnlUsdc: realizedPolyAllTime + realizedHlAllTime,
      realizedCombinedPnl24hUsdc: realizedPoly24h + realizedHl24h,
    });
  });

  /** Open Hyperliquid hedges — for the dashboard's HL section. */
  app.get('/positions/hl-open', (_req, res) => {
    res.json(deps.ledger.openHlHedges());
  });

  /**
   * Vol-arb strategy state. Returns the IV/RV time series + last decision +
   * recent decision log + open/closed positions in one payload — the
   * dashboard's /vol-arb page renders all of it.
   */
  app.get('/strategy/vol-arb/state', (_req, res) => {
    const since24h = Date.now() - 24 * 3600_000;
    const open = deps.ledger.openVolArbTrades();
    const closed = deps.ledger.closedVolArbTrades(100);
    const pnl24h = deps.ledger.realizedVolArbPnlSince(since24h);
    const pnlAll = deps.ledger.realizedVolArbPnlSince(0);
    res.json({
      enabled: deps.cfg.volArbEnabled,
      thresholds: {
        openSpread: deps.cfg.volArbIvSpreadOpenThreshold,
        closeSpread: deps.cfg.volArbIvSpreadCloseThreshold,
        directionBias: deps.cfg.volArbDirectionBiasThreshold,
        timeStopMinutes: deps.cfg.volArbTimeStopMinutes,
        minSamples: deps.cfg.volArbMinSamples,
      },
      caps: {
        perTradeUsdc: deps.cfg.maxVolArbPerTradeUsdc,
        totalUsdc: deps.cfg.maxVolArbOpenUsdc,
        dailyLossUsdc: deps.cfg.dailyVolArbLossLimitUsdc,
      },
      state: deps.state.volArb ?? null,
      openPositions: open,
      closedPositions: closed,
      openExposureUsdc: deps.ledger.openVolArbExposureUsdc(),
      realizedPnl24hUsdc: pnl24h,
      realizedPnlUsdc: pnlAll,
    });
  });

  /**
   * Truth-from-chain wallets snapshot. Aggregates the three operator
   * wallets so the dashboard's /wallets page can render them on one
   * pull. Each block is independently null if the bot isn't configured
   * for that venue (e.g. no HL key set).
   */
  app.get('/wallets', (_req, res) => {
    const open = deps.ledger.openTrades();
    // Polymarket: ledger's view of currently-open outcome share positions.
    // We can't easily query the ERC1155 balances per token-id without a
    // batch contract call, but the ledger should track every position
    // the bot opened. Cross-reference for orphans by comparing to
    // wallet history on polygonscan when needed.
    const polyOpen = open
      .filter((t) => t.polyStatus === 'filled')
      .map((t) => ({
        tradeId: t.id,
        conditionId: t.polyConditionId,
        outcome: t.polyOutcome,
        tokenId: t.polyTokenId,
        shares: t.polyFilledShares,
        fillPrice: t.polyFillPrice,
        costUsdc: t.polyCostUsdc,
        openedAtMs: t.timestampMs,
        polyTxHash: t.polyTxHash,
      }));
    // HL: ledger view of expected hedges, plus the on-chain snapshot.
    const hlLedgerOpen = deps.ledger.openHlHedges().map((t) => ({
      tradeId: t.id,
      asset: t.hlAsset,
      side: t.hlSide,
      size: t.hlSize,
      openPrice: t.hlOpenPrice,
      orderId: t.hlOrderId,
      openedAtMs: t.timestampMs,
    }));
    const hlOnChain = deps.state.hlPositions ?? null;
    res.json({
      // Sui — populated whenever a keypair is configured (live mode + paper
      // mode with real wallet reading enabled). Null only when no operator
      // key exists.
      sui: deps.state.suiAddress
        ? {
            address: deps.state.suiAddress,
            managerId: deps.state.managerId ?? null,
            navUsdc: deps.state.navUsdc,
            managerBalanceUsdc: deps.state.managerBalanceUsdc ?? 0,
            managerBalanceAtMs: deps.state.lastManagerBalanceAtMs ?? null,
            predictPackageId: deps.addresses.packageId,
            // Open positions inside the PredictManager — inferred from the
            // local ledger (on-chain has the source of truth via dynamic-
            // fields lookup; ledger should match unless something went
            // wrong, in which case the dashboard flags it).
            openPositions: open
              .filter((t) => t.mode === 'live' && !t.settled)
              .map((t) => ({
                tradeId: t.id,
                oracleId: t.oracleId,
                strike: t.strike,
                direction: t.direction,
                quantity: t.quantityDusdc,
                cost: t.costUsdc,
                txDigest: t.txDigest,
              })),
            paperTrading: deps.cfg.paperTrading,
          }
        : null,
      // Polymarket — pUSD wallet + open outcome share positions.
      // `address` is the funder (Safe in POLY_GNOSIS_SAFE mode), where
      // pUSD + outcome shares actually live. `signerAddress` is the EOA
      // that signs orders + holds POL gas.
      polygon: deps.state.polyBalance
        ? {
            address: deps.state.polyBalance.address,
            signerAddress: deps.state.polyBalance.signerAddress,
            signatureMode: deps.state.polyBalance.signatureMode,
            network: deps.state.polyBalance.network,
            pUsdBalance: deps.state.polyBalance.pUsd,
            polBalance: deps.state.polyBalance.gasPol,
            balanceAtMs: deps.state.polyBalance.updatedAtMs,
            openPositions: polyOpen,
            executionEnabled: deps.cfg.polyExecutionEnabled,
          }
        : null,
      // Hyperliquid — perp margin + open positions (both ledger AND chain).
      hyperliquid: deps.state.hlBalance
        ? {
            address: deps.state.hlBalance.address,
            network: deps.state.hlBalance.network,
            accountValueUsdc: deps.state.hlBalance.accountValueUsdc,
            withdrawableUsdc: deps.state.hlBalance.withdrawableUsdc,
            balanceAtMs: deps.state.hlBalance.updatedAtMs,
            // Ledger says these hedges should be open.
            ledgerHedges: hlLedgerOpen,
            // On-chain says THESE positions are open. Cross-reference
            // for orphan/missing detection on the dashboard.
            chainPositions: hlOnChain,
            executionEnabled: deps.cfg.hlExecutionEnabled,
          }
        : null,
    });
  });

  /** Closed Polymarket positions — both winners (redeemed) and losers. */
  app.get('/positions/closed-poly', (req, res) => {
    const limit = clampInt(req.query.limit, 1, 5000, 500);
    res.json(deps.ledger.closedPolyTrades(limit));
  });

  app.get('/signals', (req, res) => {
    const limit = clampInt(req.query.limit, 1, 1000, 100);
    res.json(deps.ledger.recentSignals(limit));
  });

  /**
   * Replay the recorded signal stream against recorded oracle settlements —
   * the same engine as scripts/backtest.ts, run server-side against the
   * deployed bot's OWN ledger so nobody has to pull the sqlite file off the
   * box. Read-only; the data window is bounded by signal retention (check
   * `data_window` in the response before trusting the stats).
   *
   *   GET /backtest?threshold=0.08&side=favored&dedupe=true&fee=0.02
   *
   * side=predict|flip|favored (favored = the regime-stable divergence-mint
   * formulation; flip=true is accepted as a legacy alias for side=flip).
   */
  app.get('/backtest', (req, res) => {
    const threshold = clampFloat(req.query.threshold, 0, 1, 0.08);
    // Band bounds — maxThreshold/maxCost let a strategy's exact band be
    // replayed (calibration harvest: threshold=0&maxThreshold=0.08&maxCost=0.9).
    const maxThreshold =
      req.query.maxThreshold != null ? clampFloat(req.query.maxThreshold, 0, 1, 1) : undefined;
    const maxCostPrice =
      req.query.maxCost != null ? clampFloat(req.query.maxCost, 0, 1, 1) : undefined;
    const fee = clampFloat(req.query.fee, 0, 0.2, 0);
    const side: BacktestSide =
      req.query.side === 'flip' || req.query.side === 'favored'
        ? req.query.side
        : req.query.flip === 'true' || req.query.flip === '1'
          ? 'flip'
          : 'predict';
    const dedupe = req.query.dedupe === 'true' || req.query.dedupe === '1';
    const { summary } = computeBacktest(
      deps.ledger.backtestSignals(),
      deps.ledger.allSettlements(),
      { threshold, maxThreshold, maxCostPrice, side, dedupe, fee, notional: 1 },
    );
    res.json(summary);
  });

  /**
   * Quoted-vs-realized calibration of Predict's SVI surface against recorded
   * oracle settlements — the "live stress test of the SVI feeder" from the
   * track brief. Deduped to one observation per (oracle, strike, direction).
   *
   *   GET /calibration?threshold=0.08
   */
  app.get('/calibration', (req, res) => {
    const threshold = clampFloat(req.query.threshold, 0, 1, 0.08);
    res.json(
      computeCalibration(deps.ledger.backtestSignals(), deps.ledger.allSettlements(), {
        divergenceThreshold: threshold,
      }),
    );
  });

  /**
   * Range-ladder vault SIMULATION — the "proper simulation result" the track
   * brief requires. Replays: for every settled oracle, the ladder the vault
   * would have minted at first sight of its surface, priced off that surface
   * (+fee), settled against what actually happened.
   *
   *   GET /range-sim?policy=sigma&rungs=5&width=1&fee=0.02&notional=5
   *   GET /range-sim?policy=fixed_bps&rungs=5&width=25
   */
  app.get('/range-sim', (req, res) => {
    const policy = req.query.policy === 'fixed_bps' ? 'fixed_bps' : 'sigma';
    const rungs = clampInt(req.query.rungs, 1, 21, 5);
    const width = clampFloat(req.query.width, 0.01, 10_000, policy === 'sigma' ? 1 : 25);
    res.json(
      computeRangeSim(deps.ledger.rangeSimRows(), {
        policy,
        rungs,
        widthZ: policy === 'sigma' ? width : 1,
        widthBps: policy === 'fixed_bps' ? width : 25,
        fee: clampFloat(req.query.fee, 0, 0.2, 0.02),
        notionalPerRung: clampFloat(req.query.notional, 0.1, 1000, 5),
        minRungPrice: clampFloat(req.query.minPrice, 0, 1, 0.02),
        maxRungPrice: clampFloat(req.query.maxPrice, 0, 1, 0.98),
      }),
    );
  });

  /**
   * PLP + tail-hedge simulation — realized PLP share-price APY (from
   * on-chain supply/withdraw events) minus crash insurance priced off every
   * recorded surface, settled against what actually happened.
   *
   *   GET /plp-sim?z=2&coverage=0.5&fee=0.02
   */
  app.get('/plp-sim', async (req, res) => {
    try {
      const [supplies, withdrawals] = await Promise.all([
        deps.predict.lpSupplies(),
        deps.predict.lpWithdrawals(),
      ]);
      res.json(
        computePlpSim(supplies, withdrawals, deps.ledger.rangeSimRows(), {
          hedgeZ: clampFloat(req.query.z, 0.5, 10, 2),
          coverageFrac: clampFloat(req.query.coverage, 0, 1, 0.5),
          fee: clampFloat(req.query.fee, 0, 0.2, 0.02),
        }),
      );
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * Three-protocol margin-loop SIMULATION (idea bank #4): borrow on
   * deepbook_margin, deploy into the favored-side Predict strategies, repay
   * from settlements. Strategy leg = this bot's real settled trades; borrow
   * APR is an explicit assumption (no public rate feed yet).
   *
   *   GET /margin-loop?collateral=100&ltv=0.5&borrowApr=0.1
   */
  app.get('/margin-loop', (req, res) => {
    res.json(
      computeMarginLoopSim(deps.ledger.settledFavoredTrades(), {
        collateralUsdc: clampFloat(req.query.collateral, 1, 1_000_000, 100),
        ltv: clampFloat(req.query.ltv, 0, 0.9, 0.5),
        borrowApr: clampFloat(req.query.borrowApr, 0, 1, 0.1),
      }),
    );
  });

  /**
   * Butterfly-harvester telemetry — digital-monotonicity violations found on
   * the fitted SVI surface ("the surface's own arbitrage violations").
   * Telemetry only; execution is gated on this count being nonzero.
   */
  app.get('/butterfly', (req, res) => {
    const limit = clampInt(req.query.limit, 1, 500, 50);
    res.json({
      stats: deps.ledger.butterflyStats(),
      recent: deps.ledger.recentButterflyEvents(limit),
    });
  });

  app.get('/positions/open', (_req, res) => {
    res.json(deps.ledger.openTrades());
  });

  app.get('/positions/closed', (req, res) => {
    const limit = clampInt(req.query.limit, 1, 5000, 500);
    res.json(deps.ledger.closedTrades(limit));
  });

  app.get('/trades', (_req, res) => {
    res.json(deps.ledger.allTrades());
  });

  app.get('/surface/:oracleId', async (req: Request, res: Response) => {
    try {
      const oracleId = req.params.oracleId!;
      const snap = await deps.predict.snapshotOracle(oracleId);
      if (!snap) return res.status(404).json({ error: 'oracle not found' });
      // Generate a strike grid covering ±20% of forward.
      const F = snap.forward;
      const tickPct = 0.005;
      const ks: number[] = [];
      const points: Array<{
        strike: number;
        k: number;
        iv: number;
        up: number;
        density: number;
        butterflyOk: boolean;
      }> = [];
      const T = Math.max(1e-6, (snap.expiryMs - Date.now()) / (365.25 * 24 * 3600 * 1000));
      for (let pct = -0.2; pct <= 0.2; pct += tickPct) {
        const strike = F * (1 + pct);
        const k = Math.log(strike / F);
        const w = sviTotalVar(k, snap.svi);
        const iv = Math.sqrt(w / T);
        const d2 = -(k + w / 2) / Math.sqrt(w);
        const up = 0.5 * (1 + erf(d2 / Math.sqrt(2)));
        const density = butterflyDensity(k, snap.svi);
        ks.push(k);
        points.push({ strike, k, iv, up, density, butterflyOk: density >= 0 });
      }
      const butterfly = scanButterfly(ks, snap.svi);
      const wing = wingNoArb(snap.svi, T);
      // Optional calendar check vs the next-longest active oracle (if any).
      let calendar:
        | { ok: boolean; worstDeficit: number; worstK: number; longerOracleId: string; longerTYears: number }
        | undefined;
      try {
        const oracles = await deps.predict.listActiveOracles(snap.underlyingAsset);
        const longer = oracles
          .filter((o) => o.oracleId !== oracleId && o.expiryMs > snap.expiryMs)
          .sort((a, b) => a.expiryMs - b.expiryMs)[0];
        if (longer) {
          const longerSnap = await deps.predict.snapshotOracle(longer.oracleId);
          if (longerSnap) {
            const longerT = Math.max(
              1e-6,
              (longerSnap.expiryMs - Date.now()) / (365.25 * 24 * 3600 * 1000),
            );
            const cal = calendarCheck(snap.svi, longerSnap.svi, ks);
            calendar = {
              ok: cal.ok,
              worstDeficit: cal.worstDeficit,
              worstK: cal.worstK,
              longerOracleId: longerSnap.oracleId,
              longerTYears: longerT,
            };
          }
        }
      } catch (e) {
        log.warn('api.surface.calendar.skip', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
      res.json({
        oracleId: snap.oracleId,
        forward: snap.forward,
        spot: snap.spot,
        expiryMs: snap.expiryMs,
        timestampMs: snap.timestampMs,
        tYears: T,
        svi: snap.svi,
        points,
        arb: {
          butterfly: { ok: butterfly.ok, worst: butterfly.worst, worstIndex: butterfly.worstIndex },
          wing,
          calendar,
        },
      });
    } catch (e) {
      log.warn('api.surface.error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'failed to compute surface' });
    }
  });

  app.get('/strategy/margin-lever/state', (_req, res) => {
    const ml = deps.state.marginLever;
    res.json({
      enabled: deps.cfg.marginLeverEnabled,
      mode: 'paper',
      thresholds: {
        openBias: deps.cfg.marginLeverOpenBias,
        closeBias: deps.cfg.marginLeverCloseBias,
        maxHoldMinutes: deps.cfg.marginLeverMaxHoldMinutes,
      },
      caps: {
        perTradeNotionalUsdc: deps.cfg.marginLeverPerTradeNotionalUsdc,
        maxBorrowNotionalUsdc: deps.cfg.marginLeverMaxBorrowNotionalUsdc,
        dailyLossLimitUsdc: deps.cfg.marginLeverDailyLossLimitUsdc,
      },
      open: ml?.open ?? null,
      closed: ml?.closed ?? [],
      recentDecisions: ml?.recentDecisions ?? [],
      lastDecision: ml?.lastDecision ?? null,
      simulatedPnlUsdc: (ml?.closed ?? []).reduce((a, c) => a + c.pnlUsdc, 0),
      simulatedPnl24hUsdc: (ml?.closed ?? [])
        .filter((c) => c.closedAtMs >= Date.now() - 24 * 3600_000)
        .reduce((a, c) => a + c.pnlUsdc, 0),
    });
  });

  app.get('/surface/:oracleId/history', (req: Request, res: Response) => {
    try {
      const oracleId = req.params.oracleId!;
      const limit = clampInt(req.query.limit, 1, 1000, 200);
      const snaps = deps.ledger.recentSviSnapshotsForOracle(oracleId, limit);
      // Reverse so the dashboard chart reads oldest → newest along the x-axis.
      const points = snaps
        .slice()
        .reverse()
        .map((s) => ({
          tsMs: s.timestampMs,
          spot: s.spot,
          forward: s.forward,
          a: s.svi.a,
          b: s.svi.b,
          rho: s.svi.rho,
          m: s.svi.m,
          sigma: s.svi.sigma,
        }));
      res.json({ oracleId, points });
    } catch (e) {
      log.warn('api.surface.history.error', {
        err: e instanceof Error ? e.message : String(e),
      });
      res.status(500).json({ error: 'failed to load surface history' });
    }
  });

  app.get('/oracles', async (_req, res) => {
    try {
      const list = await deps.predict.listActiveOracles('BTC');
      res.json(list);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  const server = app.listen(deps.cfg.apiPort, deps.cfg.apiHost, () => {
    log.info('svx.api.listening', { url: `http://${deps.cfg.apiHost}:${deps.cfg.apiPort}` });
  });
  const stop = () => {
    server.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { app, stop };
}

function clampInt(v: unknown, lo: number, hi: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function clampFloat(v: unknown, lo: number, hi: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

// Tiny erf duplicate to avoid pulling bs.ts into the API surface explicitly.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function sviTotalVar(k: number, p: { a: number; b: number; rho: number; m: number; sigma: number }): number {
  const km = k - p.m;
  return p.a + p.b * (p.rho * km + Math.sqrt(km * km + p.sigma * p.sigma));
}
