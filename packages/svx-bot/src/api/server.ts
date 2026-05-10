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
    navUsdc: number;
    managerBalanceUsdc?: number;
    lastManagerBalanceAtMs?: number;
    lastBtcSpot?: { value: number; updatedAtMs: number };
    /** Polymarket pUSD wallet balance — populated by main loop when polyExec
     *  is active. Lets the dashboard show poly bankroll alongside Sui NAV. */
    polyBalance?: {
      address: `0x${string}`;
      network: 'amoy' | 'polygon';
      pUsd: number;
      gasPol: number;
      updatedAtMs: number;
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
      // Polymarket leg state (null when polyExec is disabled).
      polyExecutionEnabled: deps.cfg.polyExecutionEnabled,
      polyNetwork: deps.cfg.polyExecutionEnabled ? deps.cfg.polyNetwork : null,
      polyAddress: deps.state.polyBalance?.address ?? null,
      polyPusdBalance: deps.state.polyBalance?.pUsd ?? null,
      polyGasPol: deps.state.polyBalance?.gasPol ?? null,
      polyBalanceAtMs: deps.state.polyBalance?.updatedAtMs ?? null,
    });
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
