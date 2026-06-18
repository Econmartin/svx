'use client';

/**
 * HealthPanel — per-leg readiness indicator for the overview page.
 *
 * Three legs to surface (Predict signals, Polymarket, Hyperliquid). Each
 * resolves to ok (green) / warn (amber) / err (red). On testnet the
 * Polymarket/Hyperliquid cards are hidden (those venues aren't part of
 * the testnet bot's universe).
 *
 * Lets the operator see at a glance "all three legs are ready to fire" before
 * the first trade has fired naturally — answers the common confusion of
 * "is the bot broken or just waiting for a signal?"
 */

import type { BotStatus } from '@/lib/api';
import { formatRelative, formatUsdc } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, Warning, XCircle, Pulse } from '@phosphor-icons/react';

type Level = 'ok' | 'warn' | 'err';

interface Row {
  label: string;
  level: Level;
  primary: string;
  hint?: string;
  detail?: string;
}

const TONE: Record<Level, { border: string; bg: string; text: string; icon: typeof Pulse }> = {
  ok: { border: 'border-win/40', bg: 'bg-win/5', text: 'text-win', icon: CheckCircle },
  warn: {
    border: 'border-warn/40',
    bg: 'bg-warn/5',
    text: 'text-warn',
    icon: Warning,
  },
  err: { border: 'border-loss/40', bg: 'bg-loss/5', text: 'text-loss', icon: XCircle },
};

function predictRow(status: BotStatus): Row {
  if (status.spotBtc == null) {
    return {
      label: 'Predict signals',
      level: 'err',
      primary: 'no oracle data',
      hint: 'predict-server unreachable',
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
      hint: 'set MAINNET_POLY_PRIVATE_KEY',
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
      hint: 'set MAINNET_POLY_EXECUTION_ENABLED=true',
      detail: shortAddr(status.polyAddress),
    };
  }
  return {
    label: 'Polymarket',
    level: 'ok',
    primary: `${formatUsdc(pUsd)} pUSD · live`,
    hint: status.lastPolyAttemptAtMs
      ? `last fill ${formatRelative(status.lastPolyAttemptAtMs)}`
      : 'awaiting first fill',
    detail: shortAddr(status.polyAddress),
  };
}

function hlRow(status: BotStatus): Row {
  if (!status.hlAddress) {
    return {
      label: 'Hyperliquid hedge',
      level: 'err',
      primary: 'HL key not configured',
      hint: 'set MAINNET_HL_PRIVATE_KEY',
    };
  }
  const margin = status.hlAccountValueUsdc ?? 0;
  if (margin <= 0) {
    return {
      label: 'Hyperliquid hedge',
      level: 'err',
      primary: '$0 margin',
      hint: 'bridge USDC from Arbitrum',
      detail: shortAddr(status.hlAddress),
    };
  }
  if (!status.hlExecutionEnabled) {
    return {
      label: 'Hyperliquid hedge',
      level: 'warn',
      primary: `${formatUsdc(margin)} margin · exec OFF`,
      hint: 'set MAINNET_HL_EXECUTION_ENABLED=true',
      detail: shortAddr(status.hlAddress),
    };
  }
  const exposure = status.openHlExposureUsdc ?? 0;
  return {
    label: 'Hyperliquid hedge',
    level: 'ok',
    primary: `${formatUsdc(margin)} margin · ${formatUsdc(exposure)} exposed`,
    hint: status.lastHlAttemptAtMs
      ? `last hedge ${formatRelative(status.lastHlAttemptAtMs)}`
      : 'awaiting first hedge',
    detail: shortAddr(status.hlAddress),
  };
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function HealthCard({ row }: { row: Row }) {
  const tone = TONE[row.level];
  const Icon = tone.icon;
  return (
    <div
      className={cn(
        'rounded-lg border p-3 transition-colors',
        tone.border,
        tone.bg,
      )}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className={cn('text-xs uppercase tracking-wider font-medium', tone.text)}>
          {row.label}
        </span>
        <Icon className={cn('h-4 w-4', tone.text)} />
      </div>
      <div className="font-mono text-sm">{row.primary}</div>
      {row.hint && <div className="text-xs text-muted mt-1">{row.hint}</div>}
      {row.detail && (
        <div className="text-xs text-muted/70 font-mono mt-1">{row.detail}</div>
      )}
    </div>
  );
}

export function HealthPanel({
  status,
  showAllLegs,
}: {
  status: BotStatus | null | undefined;
  showAllLegs: boolean;
}) {
  if (!status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Configuration health</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted text-sm">Loading status…</div>
        </CardContent>
      </Card>
    );
  }
  const rows: Row[] = [predictRow(status)];
  if (showAllLegs) {
    rows.push(polyRow(status), hlRow(status));
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuration health</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            'grid gap-3',
            showAllLegs ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-1',
          )}
        >
          {rows.map((r) => (
            <HealthCard key={r.label} row={r} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
