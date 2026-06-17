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
      const points: Array<{ strike: number; iv: number; up: number }> = [];
      for (let pct = -0.2; pct <= 0.2; pct += tickPct) {
        const strike = F * (1 + pct);
        const k = Math.log(strike / F);
        const w = sviTotalVar(k, snap.svi);
        const T = Math.max(1e-6, (snap.expiryMs - Date.now()) / (365.25 * 24 * 3600 * 1000));
        const iv = Math.sqrt(w / T);
        const d2 = -(k + w / 2) / Math.sqrt(w);
        const up = 0.5 * (1 + erf(d2 / Math.sqrt(2)));
        points.push({ strike, iv, up });
      }
      res.json({
        oracleId: snap.oracleId,
        forward: snap.forward,
        spot: snap.spot,
        expiryMs: snap.expiryMs,
        timestampMs: snap.timestampMs,
        svi: snap.svi,
        points,
      });
    } catch (e) {
      log.warn('api.surface.error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'failed to compute surface' });
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
