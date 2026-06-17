'use client';

import { useCallback } from 'react';
import { useApiClient, useNetwork } from '@/lib/network-context';
import { formatPct, formatUsdc, formatRelative, type TradeRecord } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { StatRow } from '@/components/StatRow';
import { StatusBadge } from '@/components/StatusBadge';
import { HealthPanel } from '@/components/HealthPanel';
import { PageIntro } from '@/components/PageIntro';
import { PnlChart } from '@/components/PnlChart';
import { StrategyStats } from '@/components/StrategyStats';
import { EdgeCaptureChart } from '@/components/EdgeCaptureChart';
import { CalibrationChart } from '@/components/CalibrationChart';
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

      <PageIntro
        summary={
          isMainnet
            ? 'Live mainnet snapshot — real money on Polymarket (Polygon CLOB) with a delta-sized Hyperliquid perp hedge on every fill. The Predict leg stays paper-only until Predict ships on Sui mainnet; we use its SVI surface as our pricing brain.'
            : "Testnet snapshot — the bot mints binary positions on DeepBook Predict with dUSDC, paired with paper Polymarket signals. Useful for watching the full end-to-end loop without spending real money."
        }
        hints={[
          <>The <strong>health panel</strong> below is the at-a-glance state: paused / live, wallet balances, last fill, NAV.</>,
          <>Realized PnL on the chart is locked-in only — it excludes any open mark-to-market position.</>,
          <>Use the network toggle in the header to flip between this view and the {isMainnet ? 'testnet' : 'mainnet'} bot.</>,
        ]}
      />

      <HealthPanel status={status} showAllLegs={isMainnet} />

      <OverviewStats status={status} isMainnet={isMainnet} closedCount={closedForChart.length} winRate={winRate} wins={wins} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Cumulative realized PnL</CardTitle>
            <p className="text-xs text-muted mt-0.5">
              {isMainnet ? (
                <>
                  Combined (Polymarket + Hyperliquid hedge) = pure-vol PnL.{' '}
                  <span className="text-fg/80">Net of HL taker fees + funding</span> —
                  drag is broken out below.
                </>
              ) : (
                'Sui-side dUSDC realized PnL on Predict.'
              )}
            </p>
          </div>
        </CardHeader>
        <CardContent>
          <PnlChart closed={closedForChart} showLegs={isMainnet} />
        </CardContent>
      </Card>

      {closedForChart.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Strategy stats</CardTitle>
            <p className="text-xs text-muted mt-0.5">
              Derived from the closed-trade tape. Distribution shape, downside,
              throughput — the metrics that say <em>"is this working consistently?"</em>
              beyond top-line PnL.
            </p>
          </CardHeader>
          <CardContent>
            <StrategyStats closed={closedForChart} isMainnet={isMainnet} />
            {isMainnet && (status?.hlFeesUsdc || status?.hlFundingUsdc) ? (
              <div className="mt-3 rounded border border-border bg-surface-elevated/50 px-4 py-2.5 text-xs leading-relaxed">
                <span className="text-muted uppercase tracking-wider text-[10px] mr-2">
                  HL cost drag
                </span>
                <span className="font-mono tabular-nums">
                  fees{' '}
                  <span className="text-loss">
                    −${(status.hlFeesUsdc ?? 0).toFixed(4)}
                  </span>
                  {' · '}
                  funding{' '}
                  <span
                    className={
                      (status.hlFundingUsdc ?? 0) > 0 ? 'text-loss' : 'text-win'
                    }
                  >
                    {(status.hlFundingUsdc ?? 0) > 0 ? '−' : '+'}$
                    {Math.abs(status.hlFundingUsdc ?? 0).toFixed(4)}
                  </span>
                  {' · '}
                  total{' '}
                  <span className="text-loss">
                    −${((status.hlFeesUsdc ?? 0) + Math.max(0, status.hlFundingUsdc ?? 0)).toFixed(4)}
                  </span>
                </span>
                <span className="text-muted ml-2">
                  — already subtracted from chart + stats above. <em>This is what would have been "missing" if we only counted price PnL.</em>
                </span>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      {closedForChart.length > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {isMainnet && (
            <Card>
              <CardHeader>
                <CardTitle>Edge captured — math validation</CardTitle>
                <p className="text-xs text-muted mt-0.5 leading-relaxed">
                  For each closed trade: <strong>entry edge</strong> (the
                  Predict − Polymarket probability gap the bot saw when it pulled
                  the trigger) vs <strong>realized return on cost</strong>. If the
                  math is right, the least-squares fit line tilts up to the right —
                  deeper edges identified deliver larger realized returns. A flat
                  or down-sloped fit means the bot is trading noise.
                </p>
              </CardHeader>
              <CardContent>
                <EdgeCaptureChart
                  closed={closedForChart}
                  spreadThreshold={status?.spreadThreshold ?? 0.03}
                />
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Calibration — SVI feeder stress test</CardTitle>
              <p className="text-xs text-muted mt-0.5 leading-relaxed">
                For each closed trade we bin by <strong>predicted win
                probability</strong> (Predict's SVI surface, evaluated at the
                trade's strike) and compute the <strong>actual hit rate</strong>{' '}
                in that bin. Points sitting on the dashed <em>y = x</em> diagonal
                mean Predict's probabilities are well-calibrated — when it says
                "70%," 70% of those trades win. The spec called vol-arb{' '}
                <em>"a live stress test of the SVI feeder"</em>; this is the result.
              </p>
            </CardHeader>
            <CardContent>
              <CalibrationChart closed={closedForChart} isMainnet={isMainnet} />
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
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
            polyExecutionEnabled={status?.polyExecutionEnabled ?? false}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Recent signals</span>
            <span className="text-xs text-muted normal-case">last 15</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <RecentSignals signals={recentSignals ?? []} />
        </CardContent>
      </Card>

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
  polyExecutionEnabled,
}: {
  open: TradeRecord[];
  spot: number | null;
  isMainnet: boolean;
  polyExecutionEnabled: boolean;
}) {
  // Mainnet view: show all open trades, distinguish those with a real Poly
  // leg from those that are paper-only (Sui-side paper signal, no Poly
  // execution because POLY_EXECUTION_ENABLED was false).
  const rows = open;
  if (rows.length === 0) {
    return (
      <div className="space-y-3 py-4">
        <div className="text-muted text-sm text-center">No open positions.</div>
        {isMainnet && !polyExecutionEnabled && (
          <div className="text-xs text-warn text-center max-w-md mx-auto">
            Signals are evaluating but POLY_EXECUTION_ENABLED is off — no
            Polymarket orders are being placed. Set
            <code className="px-1 mx-1 bg-bg rounded font-mono">MAINNET_POLY_EXECUTION_ENABLED=true</code>
            in Coolify to start firing.
          </div>
        )}
      </div>
    );
  }
  const paperOnlyCount = isMainnet
    ? rows.filter((t) => !t.polyStatus).length
    : 0;
  return (
    <div className="space-y-3">
      {isMainnet && paperOnlyCount > 0 && !polyExecutionEnabled && (
        <div className="text-xs text-warn px-3 py-2 rounded bg-warn/10 border border-warn/30">
          <strong>{paperOnlyCount}</strong> of these are <em>Sui-paper</em> rows
          — signals that would have executed if MAINNET_POLY_EXECUTION_ENABLED
          were true. No real money in flight.
        </div>
      )}
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
              const hasPoly = !!t.polyStatus;
              return (
                <TableRow key={t.id} className={!hasPoly ? 'opacity-60' : ''}>
                  <TableCell className="text-muted text-xs">
                    {new Date(t.timestampMs).toLocaleTimeString()}
                  </TableCell>
                  <TableCell>${t.strike.toFixed(0)}</TableCell>
                  <TableCell>{t.polyOutcome?.toUpperCase() ?? t.direction.toUpperCase()}</TableCell>
                  <TableCell>
                    {hasPoly ? t.polyFilledShares?.toFixed(2) ?? '—' : '—'}
                  </TableCell>
                  <TableCell>
                    {t.polyFillPrice != null ? formatPct(t.polyFillPrice, 2) : '—'}
                  </TableCell>
                  <TableCell>
                    {t.hlStatus === 'open' && t.hlSize != null ? (
                      <span className="text-warn text-xs">
                        {t.hlSide?.toUpperCase()} {t.hlSize.toFixed(5)}
                      </span>
                    ) : (
                      <span className="text-muted text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {hasPoly ? (
                      <Badge variant={t.polyStatus === 'filled' ? 'live' : 'default'}>
                        {t.polyStatus}
                      </Badge>
                    ) : (
                      <Badge variant="outline">sui-paper</Badge>
                    )}
                  </TableCell>
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
    </div>
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
