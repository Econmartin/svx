'use client';

import { useCallback } from 'react';
import { useApiClient, useNetwork } from '@/lib/network-context';
import { formatPct, formatUsdc, formatRelative, type TradeRecord } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { StatRow } from '@/components/StatRow';
import { StatusBadge } from '@/components/StatusBadge';
import { HealthPanel } from '@/components/HealthPanel';
import { PnlChart } from '@/components/PnlChart';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ExternalLink } from 'lucide-react';

export default function OverviewPage() {
  const client = useApiClient();
  const { network } = useNetwork();
  const isMainnet = network === 'mainnet';

  const fetchStatus = useCallback(() => client.status(), [client]);
  const fetchClosed = useCallback(() => client.positionsClosed(500), [client]);
  const fetchClosedPoly = useCallback(
    () => (isMainnet ? client.positionsClosedPoly(500) : Promise.resolve([])),
    [client, isMainnet],
  );
  const fetchSignals = useCallback(() => client.signals(15), [client]);
  const fetchOpen = useCallback(() => client.positionsOpen(), [client]);

  const { data: status, error: statusError } = usePolling(fetchStatus, 10_000);
  const { data: closed } = usePolling(fetchClosed, 30_000);
  const { data: closedPoly } = usePolling(fetchClosedPoly, 30_000);
  const { data: recentSignals } = usePolling(fetchSignals, 5_000);
  const { data: open } = usePolling(fetchOpen, 10_000);

  // Pick the right "closed" stream depending on view:
  // - Mainnet: closed Poly trades (mainnet bot is paper-Predict, no Sui PnL)
  // - Testnet: settled Sui trades
  const closedForChart = isMainnet ? closedPoly ?? [] : closed ?? [];

  const wins = closedForChart.filter((t) => combinedPnl(t, isMainnet) > 0).length;
  const winRate = closedForChart.length > 0 ? wins / closedForChart.length : 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start gap-4 justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-3">
            SVX Overview
            <Badge variant={isMainnet ? 'mainnet' : 'testnet'} className="text-[10px]">
              {isMainnet ? 'mainnet · real money' : 'testnet'}
            </Badge>
          </h1>
          <p className="text-muted text-sm mt-1">
            {isMainnet
              ? 'Polymarket execution on Polygon with delta-hedged Hyperliquid perp legs. Predict signals priced from testnet SVI surface.'
              : 'Cross-venue vol-arb on DeepBook Predict testnet, paired with paper Polymarket signals.'}
          </p>
        </div>
        {status && (
          <StatusBadge
            paused={status.paused}
            reason={status.pauseReason}
            live={
              isMainnet
                ? !!status.polyExecutionEnabled
                : !!status.liveTradingEnabled
            }
          />
        )}
      </header>

      {statusError && (
        <Card>
          <CardContent className="p-4 border border-loss/40 bg-loss/10 rounded-lg text-loss text-sm">
            Could not reach the bot API: {statusError}.
          </CardContent>
        </Card>
      )}

      <HealthPanel status={status} showAllLegs={isMainnet} />

      <OverviewStats status={status} isMainnet={isMainnet} closedCount={closedForChart.length} winRate={winRate} wins={wins} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Cumulative realized PnL</CardTitle>
            <p className="text-xs text-muted mt-0.5">
              {isMainnet
                ? 'Combined (Polymarket + Hyperliquid hedge) = pure-vol PnL.'
                : 'Sui-side dUSDC realized PnL on Predict.'}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <PnlChart closed={closedForChart} showLegs={isMainnet} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Open positions{open?.length ? ` (${open.length})` : ''}</span>
              {open?.length ? (
                <span className="text-xs text-muted normal-case">live snapshot</span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <OpenPositionsTable
              open={open ?? []}
              spot={status?.spotBtc ?? null}
              isMainnet={isMainnet}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Last 15 signals</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <RecentSignals signals={recentSignals ?? []} />
          </CardContent>
        </Card>
      </div>

      <footer className="text-xs text-muted font-mono flex items-center gap-2">
        <span>Predict package:</span>
        <a
          className="underline hover:text-accent inline-flex items-center gap-1"
          href={`https://suiscan.xyz/testnet/object/${status?.predictPackageId ?? ''}`}
          target="_blank"
          rel="noreferrer"
        >
          {status?.predictPackageId?.slice(0, 16) ?? '—'}…
          <ExternalLink className="h-3 w-3" />
        </a>
      </footer>
    </div>
  );
}

function combinedPnl(t: TradeRecord, isMainnet: boolean): number {
  if (isMainnet) {
    return (t.polyPnlUsdc ?? 0) + (t.hlPnlUsdc ?? 0);
  }
  return t.pnlUsdc ?? 0;
}

function OverviewStats({
  status,
  isMainnet,
  closedCount,
  winRate,
  wins,
}: {
  status: import('@/lib/api').BotStatus | null;
  isMainnet: boolean;
  closedCount: number;
  winRate: number;
  wins: number;
}) {
  if (isMainnet) {
    const polyAll = status?.realizedPolyPnlUsdc ?? 0;
    const hlAll = status?.realizedHlPnlUsdc ?? 0;
    const combinedAll = status?.realizedCombinedPnlUsdc ?? polyAll + hlAll;
    const combined24h = status?.realizedCombinedPnl24hUsdc ?? 0;
    return (
      <StatRow
        cols={5}
        stats={[
          {
            label: 'BTC spot',
            value: status?.spotBtc != null ? `$${formatUsdc(status.spotBtc, 0)}` : '—',
            hint: status?.spotBtcAtMs ? formatRelative(status.spotBtcAtMs) : 'awaiting oracle',
          },
          {
            label: 'Combined PnL (all)',
            value: formatUsdc(combinedAll),
            tone: combinedAll >= 0 ? 'win' : 'loss',
            hint: `${closedCount} closed · win ${formatPct(winRate, 0)} (${wins}/${closedCount})`,
          },
          {
            label: 'PnL 24h',
            value: formatUsdc(combined24h),
            tone: combined24h >= 0 ? 'win' : 'loss',
            hint: `limit −${formatUsdc(status?.dailyPolyLossLimitUsdc ?? 0)}`,
          },
          {
            label: 'Poly PnL',
            value: formatUsdc(polyAll),
            tone: polyAll >= 0 ? 'win' : 'loss',
            hint: `${formatUsdc(status?.polyPusdBalance ?? 0)} pUSD wallet`,
          },
          {
            label: 'HL exposure',
            value: status?.hlExecutionEnabled
              ? formatUsdc(status.openHlExposureUsdc ?? 0)
              : '—',
            hint: status?.hlExecutionEnabled
              ? `${formatUsdc(status.hlAccountValueUsdc ?? 0)} margin`
              : 'hedging off',
          },
        ]}
      />
    );
  }
  const realized = status?.realizedPnlUsdc ?? 0;
  const realized24h = status?.realizedPnl24hUsdc ?? 0;
  return (
    <StatRow
      cols={5}
      stats={[
        {
          label: 'BTC spot',
          value: status?.spotBtc != null ? `$${formatUsdc(status.spotBtc, 0)}` : '—',
          hint: status?.spotBtcAtMs ? formatRelative(status.spotBtcAtMs) : 'awaiting oracle',
        },
        {
          label: 'PnL (all)',
          value: formatUsdc(realized),
          tone: realized >= 0 ? 'win' : 'loss',
          hint: `${closedCount} closed · win ${formatPct(winRate, 0)} (${wins}/${closedCount})`,
        },
        {
          label: 'PnL 24h',
          value: formatUsdc(realized24h),
          tone: realized24h >= 0 ? 'win' : 'loss',
          hint: `limit −${formatUsdc(0)}`,
        },
        {
          label: 'Bankroll',
          value: formatUsdc(status?.totalBalanceUsdc ?? status?.navUsdc),
          hint: 'wallet + manager',
        },
        {
          label: 'Signals 24h',
          value: status?.signalsLast24h ?? '—',
          hint: `${status?.tradesLast24h ?? 0} executed`,
        },
      ]}
    />
  );
}

function OpenPositionsTable({
  open,
  spot,
  isMainnet,
}: {
  open: TradeRecord[];
  spot: number | null;
  isMainnet: boolean;
}) {
  // Mainnet view: filter to trades with a Poly leg attached.
  const rows = isMainnet ? open.filter((t) => !!t.polyStatus) : open;
  if (rows.length === 0) {
    return <div className="text-muted text-sm py-6 text-center">No open positions.</div>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Opened</TableHead>
          <TableHead>Strike</TableHead>
          {isMainnet ? <TableHead>Outcome</TableHead> : <TableHead>Side</TableHead>}
          <TableHead>{isMainnet ? 'Shares' : 'Stake'}</TableHead>
          {isMainnet ? <TableHead>Fill</TableHead> : <TableHead>Entry</TableHead>}
          {isMainnet && <TableHead>Hedge</TableHead>}
          <TableHead>{isMainnet ? 'Status' : 'Spot'}</TableHead>
          <TableHead>{isMainnet ? '' : 'Status'}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((t) => {
          if (isMainnet) {
            return (
              <TableRow key={t.id}>
                <TableCell className="text-muted text-xs">
                  {new Date(t.timestampMs).toLocaleTimeString()}
                </TableCell>
                <TableCell>${t.strike.toFixed(0)}</TableCell>
                <TableCell>{t.polyOutcome?.toUpperCase() ?? '—'}</TableCell>
                <TableCell>{t.polyFilledShares?.toFixed(2) ?? '—'}</TableCell>
                <TableCell>
                  {t.polyFillPrice != null ? formatPct(t.polyFillPrice, 2) : '—'}
                </TableCell>
                <TableCell>
                  {t.hlStatus === 'open' && t.hlSize != null ? (
                    <span className="text-warn text-xs">
                      {t.hlSide?.toUpperCase()} {t.hlSize.toFixed(5)}
                    </span>
                  ) : (
                    <span className="text-muted text-xs">none</span>
                  )}
                </TableCell>
                <TableCell className="text-xs">{t.polyStatus}</TableCell>
                <TableCell />
              </TableRow>
            );
          }
          const m = moneyness(t, spot);
          return (
            <TableRow key={t.id} className={m.cls}>
              <TableCell className="text-muted text-xs">
                {new Date(t.timestampMs).toLocaleTimeString()}
              </TableCell>
              <TableCell>${t.strike.toFixed(0)}</TableCell>
              <TableCell>{t.direction}</TableCell>
              <TableCell>{formatUsdc(t.costUsdc)}</TableCell>
              <TableCell>{formatPct(t.costPrice)}</TableCell>
              <TableCell>{m.spotLabel}</TableCell>
              <TableCell className="text-xs">{m.statusLabel}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function RecentSignals({ signals }: { signals: import('@/lib/api').SignalRecord[] }) {
  if (signals.length === 0) {
    return <div className="text-muted text-sm py-6 text-center">No signals yet.</div>;
  }
  return (
    <div className="space-y-1.5">
      {signals.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-2 text-xs px-2 py-1.5 rounded hover:bg-surface-elevated transition-colors"
        >
          <span className="text-muted tabular-nums whitespace-nowrap">
            {new Date(s.timestampMs).toLocaleTimeString()}
          </span>
          <span className="font-mono">${s.strike.toFixed(0)}</span>
          <span className="text-muted">·</span>
          <span className="font-mono tabular-nums">
            P {formatPct(s.predictProb, 1)}
          </span>
          <span className="text-muted">/</span>
          <span className="font-mono tabular-nums">
            Y {formatPct(s.polyProb, 1)}
          </span>
          <span
            className={`ml-auto font-mono tabular-nums ${
              Math.abs(s.spread) > 0.03 ? 'text-win' : 'text-muted'
            }`}
          >
            {s.spread >= 0 ? '+' : ''}
            {formatPct(s.spread, 2)}
          </span>
          <SignalActionBadge action={s.action} reason={s.filterReason} />
        </div>
      ))}
    </div>
  );
}

function SignalActionBadge({ action, reason }: { action: string; reason?: string }) {
  if (action === 'paper_executed' || action === 'live_executed') {
    return <Badge variant="live">exec</Badge>;
  }
  if (action === 'sub_threshold') {
    return <Badge variant="outline">sub</Badge>;
  }
  return (
    <Badge variant="default" title={reason}>
      {reason ?? 'filt'}
    </Badge>
  );
}

interface Moneyness {
  cls: string;
  spotLabel: string;
  statusLabel: string;
}

function moneyness(t: TradeRecord, spot: number | null): Moneyness {
  if (spot == null) {
    return { cls: '', spotLabel: '—', statusLabel: 'no spot' };
  }
  const isWinning = t.direction === 'up' ? spot > t.strike : spot <= t.strike;
  return {
    cls: isWinning ? 'text-win' : 'text-loss',
    spotLabel: `$${spot.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    statusLabel: isWinning ? 'ITM' : 'OTM',
  };
}
