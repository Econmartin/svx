'use client';

/**
 * HealthPanel — per-leg readiness indicator for /mainnet.
 *
 * Three legs to surface (Predict signals, Polymarket, Hyperliquid). Each
 * resolves to one of:
 *   - ok    (green): configured, funded, execution-enabled
 *   - warn  (amber): configured but missing something (no balance, exec off,
 *                    or no recent activity)
 *   - err   (red):   missing config / unreachable
 *
 * Lets the operator see at a glance "all three legs are ready to fire" before
 * the first trade has fired naturally — answers the common confusion of
 * "is the bot broken or just waiting for a signal?"
 */

import type { BotStatus } from '@/lib/api';
import { formatRelative, formatUsdc } from '@/lib/api';

type Level = 'ok' | 'warn' | 'err';

interface Row {
  label: string;
  level: Level;
  primary: string;
  hint?: string;
  /** Optional second line — e.g. address (truncated), useful for verification. */
  detail?: string;
}

const COLORS: Record<Level, string> = {
  ok: 'border-win/40 bg-win/5 text-win',
  warn: 'border-yellow-500/40 bg-yellow-500/5 text-yellow-400',
  err: 'border-loss/40 bg-loss/5 text-loss',
};

const DOT: Record<Level, string> = {
  ok: 'bg-win',
  warn: 'bg-yellow-400',
  err: 'bg-loss',
};

function predictRow(status: BotStatus): Row {
  if (status.spotBtc == null) {
    return {
      label: 'Predict signals',
      level: 'err',
      primary: 'no oracle data',
      hint: 'check predict-server.testnet.mystenlabs.com reachable',
    };
  }
  const ageSec = status.spotBtcAtMs ? (Date.now() - status.spotBtcAtMs) / 1000 : Infinity;
  if (ageSec > 300) {
    return {
      label: 'Predict signals',
      level: 'warn',
      primary: 'oracle stale',
      hint: `last update ${formatRelative(status.spotBtcAtMs!)}`,
    };
  }
  return {
    label: 'Predict signals',
    level: 'ok',
    primary: `BTC $${formatUsdc(status.spotBtc, 0)}`,
    hint: `${status.signalsLast24h ?? 0} signals 24h · ${status.tradesLast24h ?? 0} executed`,
  };
}

function polyRow(status: BotStatus): Row {
  if (!status.polyAddress) {
    return {
      label: 'Polymarket',
      level: 'err',
      primary: 'wallet not configured',
      hint: 'set MAINNET_POLY_PRIVATE_KEY in Coolify',
    };
  }
  const pUsd = status.polyPusdBalance ?? 0;
  const gas = status.polyGasPol ?? 0;
  if (pUsd <= 0) {
    return {
      label: 'Polymarket',
      level: 'err',
      primary: '$0 pUSD',
      hint: 'top up via wrap-usdce-to-pusd',
      detail: shortAddr(status.polyAddress),
    };
  }
  if (gas < 0.1) {
    return {
      label: 'Polymarket',
      level: 'warn',
      primary: `${formatUsdc(pUsd)} pUSD · ${gas.toFixed(3)} POL`,
      hint: 'POL low — top up gas',
      detail: shortAddr(status.polyAddress),
    };
  }
  if (!status.polyExecutionEnabled) {
    return {
      label: 'Polymarket',
      level: 'warn',
      primary: `${formatUsdc(pUsd)} pUSD ready · exec OFF`,
      hint: 'set MAINNET_POLY_EXECUTION_ENABLED=true to fire',
      detail: shortAddr(status.polyAddress),
    };
  }
  return {
    label: 'Polymarket',
    level: 'ok',
    primary: `${formatUsdc(pUsd)} pUSD · live`,
    hint: status.lastPolyAttemptAtMs
      ? `last fill attempt ${formatRelative(status.lastPolyAttemptAtMs)}`
      : 'no fills attempted since boot',
    detail: shortAddr(status.polyAddress),
  };
}

function hlRow(status: BotStatus): Row {
  if (!status.hlAddress) {
    return {
      label: 'Hyperliquid',
      level: 'err',
      primary: 'HL key not configured',
      hint: 'set MAINNET_HL_PRIVATE_KEY in Coolify',
    };
  }
  const margin = status.hlAccountValueUsdc ?? 0;
  if (margin <= 0) {
    return {
      label: 'Hyperliquid',
      level: 'err',
      primary: '$0 margin',
      hint: 'bridge USDC from Arbitrum at app.hyperliquid.xyz/bridge',
      detail: shortAddr(status.hlAddress),
    };
  }
  if (!status.hlExecutionEnabled) {
    return {
      label: 'Hyperliquid',
      level: 'warn',
      primary: `${formatUsdc(margin)} margin · exec OFF`,
      hint: 'set MAINNET_HL_EXECUTION_ENABLED=true to hedge',
      detail: shortAddr(status.hlAddress),
    };
  }
  const exposure = status.openHlExposureUsdc ?? 0;
  return {
    label: 'Hyperliquid',
    level: 'ok',
    primary: `${formatUsdc(margin)} margin · ${formatUsdc(exposure)} exposed`,
    hint: status.lastHlAttemptAtMs
      ? `last hedge attempt ${formatRelative(status.lastHlAttemptAtMs)}`
      : 'no hedges attempted since boot',
    detail: shortAddr(status.hlAddress),
  };
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function HealthPanel({ status }: { status: BotStatus | null | undefined }) {
  if (!status) {
    return (
      <section className="rounded border border-border bg-surface p-4">
        <h2 className="text-sm uppercase tracking-wider text-muted mb-3">Configuration health</h2>
        <p className="text-muted text-sm">Loading status…</p>
      </section>
    );
  }
  const rows = [predictRow(status), polyRow(status), hlRow(status)];
  return (
    <section className="rounded border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm uppercase tracking-wider text-muted">Configuration health</h2>
        <span className="text-xs text-muted">
          all three must be green before a Predict signal → Poly fill → HL hedge round-trip can fire
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {rows.map((r) => (
          <div
            key={r.label}
            className={`rounded border px-3 py-2 ${COLORS[r.level]}`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs uppercase tracking-wider opacity-70">{r.label}</span>
              <span className={`w-2 h-2 rounded-full ${DOT[r.level]}`} />
            </div>
            <div className="font-mono text-sm">{r.primary}</div>
            {r.hint && <div className="text-xs opacity-70 mt-1">{r.hint}</div>}
            {r.detail && <div className="text-xs opacity-50 font-mono mt-1">{r.detail}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
