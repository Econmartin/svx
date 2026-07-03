'use client';

/**
 * /poly-arb — dedicated dashboard for the cross-venue arbitrage strategy:
 * Polymarket binary fill + delta-sized Hyperliquid perp hedge, priced off
 * Predict's SVI surface.
 *
 * This is the original / profitable strategy. The Overview page already
 * surfaces a lot of it, but the user wanted parity with /vol-arb so the
 * profitable strategy has its own home (focused stats, edge-validation
 * chart, open/closed tables filtered to this strategy only).
 *
 * Network-aware: on mainnet it's real money on Polygon + Hyperliquid; on
 * testnet the same strategy runs in paper mode against the same signals
 * (closed Sui-side dUSDC trades reflect the paper outcome).
 */

import { useCallback, useMemo, useState } from 'react';
import { useApiClient, useNetwork } from '@/lib/network-context';
import {
  formatPct,
  formatRelative,
  formatTime,
  formatUsdc,
  type TradeRecord,
} from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { StatRow } from '@/components/StatRow';
import { StatusBadge } from '@/components/StatusBadge';
import { PageIntro } from '@/components/PageIntro';
import { OperatorBanner } from '@/components/OperatorBanner';
import { EdgeCaptureChart } from '@/components/EdgeCaptureChart';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type View = 'open' | 'closed';

export default function PolyArbPage() {
  const client = useApiClient();
  const { network } = useNetwork();
  const isMainnet = network === 'mainnet';
  const [view, setView] = useState<View>('closed');

  const { data: status, error: statusError } = usePolling(
    useCallback(() => client.status(), [client]),
    10_000,
  );
  const { data: openAll } = usePolling(
    useCallback(() => client.positionsOpen(), [client]),
    10_000,
  );
  const { data: closedAll } = usePolling(
    useCallback(
      () => (isMainnet ? client.positionsClosedPoly(500) : client.positionsClosed(500)),
      [client, isMainnet],
    ),
    30_000,
  );

  // Strategy filter: poly-arb owns every row that ISN'T explicitly tagged
  // vol_arb (legacy rows pre-strategy-tag default to poly_arb).
  const openPoly = (openAll ?? []).filter((t) => (t.strategy ?? 'poly_arb') === 'poly_arb');
  const closedPoly = (closedAll ?? []).filter(
    (t) => (t.strategy ?? 'poly_arb') === 'poly_arb',
  );

  // On mainnet "still open" means the poly leg is filled-but-unsettled OR
  // the HL hedge is still open. On testnet it's any settled=false row.
  const liveOpen = isMainnet
    ? openPoly.filter(
        (t) => (t.polyStatus === 'filled' && !t.polySettled) || t.hlStatus === 'open',
      )
    : openPoly;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-[26px] sm:text-[28px] leading-tight font-semibold tracking-tight">
            Cross-venue arb
          </h1>
          <Badge variant={isMainnet ? 'mainnet' : 'testnet'} className="text-[10px]">
            {isMainnet ? 'mainnet · real money' : 'testnet · paper'}
          </Badge>
          {status && (
            <span className="sm:ml-auto">
              <StatusBadge
                paused={status.paused}
                reason={status.pauseReason}
                live={
                  isMainnet
                    ? !!status.polyExecutionEnabled
                    : !!status.liveTradingEnabled
                }
              />
            </span>
          )}
        </div>
        <p className="text-muted text-[13.5px] max-w-3xl leading-relaxed">
          The cross-venue arbitrage strategy — buy mispriced Polymarket
          binaries when Predict's SVI surface disagrees by &gt; threshold, then
          delta-hedge with a BTC perp on Hyperliquid. Pure-vol PnL after the
          two legs net out. Independent from the standalone HL{' '}
          <a href="/vol-arb" className="underline hover:text-accent">
            IV-RV divergence strategy
          </a>
          .
        </p>
      </header>

      {statusError && (
        <div className="rounded border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
          Could not reach the bot API: {statusError}
        </div>
      )}

      <OperatorBanner
        context={
          isMainnet
            ? 'real money in flight on Polymarket + Hyperliquid'
            : 'paper signals on testnet'
        }
      />

      <PageIntro
        summary={
          isMainnet ? (
            <>
              Every 15s the bot prices each oracle/strike pair on both venues. When the
              probability gap exceeds the threshold (8pp since the 2026-07 overhaul) AND
              the model edge clears the entry ask by ≥5%, it buys the cheap side on
              Polymarket. Positions are small naked binaries bounded by the per-trade
              clip — the HL delta hedge is disabled post-audit (it was sized at the
              wrong expiry). Exits: trailing +20% ratchet lets winners ride to
              resolution; stop-loss cuts losers at −50%.
            </>
          ) : (
            <>
              On testnet the same loop runs in paper mode against live signals — useful
              for watching strategy mechanics without the mainnet wallets in flight.
              For real-money PnL flip the network toggle to <strong>mainnet</strong>.
            </>
          )
        }
        hints={[
          <>
            <strong>Edge captured</strong> chart below is the strategy's report
            card — entry edge identified vs realised return. Positive slope = the
            math finds real edge.
          </>,
          <>
            Mid-life exits (closed trade rows where{' '}
            <code className="font-mono text-[10px]">poly_settlement_outcome = early_exit</code>
            ) sold the spread back before UMA settled — caught compression instead of
            waiting hours.
          </>,
          <>
            The HL hedge strips directional BTC exposure: short when we bought Yes,
            long when we bought No. Total PnL = poly leg + hedge leg + funding.
          </>,
        ]}
      />

      <PolyArbStats
        status={status}
        closed={closedPoly}
        isMainnet={isMainnet}
        liveOpenCount={liveOpen.length}
      />

      <Card>
        <CardHeader>
          <CardTitle>Edge captured — math validation</CardTitle>
          <p className="text-xs text-muted mt-1 leading-relaxed">
            For each closed trade: <strong>entry edge</strong> (Predict − Polymarket
            probability gap at execution) vs <strong>realized return on cost</strong>.
            The yellow line is the least-squares fit — tilting up to the right means
            deeper edges identified deliver larger realized returns.
          </p>
        </CardHeader>
        <CardContent>
          <EdgeCaptureChart
            closed={closedPoly}
            spreadThreshold={status?.spreadThreshold ?? 0.03}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle>
              {view === 'open' ? 'Open positions' : 'Closed positions'}
            </CardTitle>
            <p className="text-xs text-muted">
              {view === 'open'
                ? `${liveOpen.length} currently in flight`
                : `${closedPoly.length} settled trades`}
            </p>
          </div>
          <Tabs value={view} onValueChange={(v) => setView(v as View)}>
            <TabsList>
              <TabsTrigger value="open">Open ({liveOpen.length})</TabsTrigger>
              <TabsTrigger value="closed">Closed ({closedPoly.length})</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="pt-0">
          {view === 'open' ? (
            <OpenTable open={liveOpen} isMainnet={isMainnet} />
          ) : (
            <ClosedTable closed={closedPoly} isMainnet={isMainnet} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function combinedPnl(t: TradeRecord, isMainnet: boolean): number {
  if (isMainnet) return (t.polyPnlUsdc ?? 0) + (t.hlPnlUsdc ?? 0);
  return t.pnlUsdc ?? 0;
}

function PolyArbStats({
  status,
  closed,
  isMainnet,
  liveOpenCount,
}: {
  status: import('@/lib/api').BotStatus | null;
  closed: TradeRecord[];
  isMainnet: boolean;
  liveOpenCount: number;
}) {
  const pnls = closed.map((t) => combinedPnl(t, isMainnet));
  const total = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((p) => p > 0).length;
  const winRate = pnls.length > 0 ? wins / pnls.length : 0;
  const edges = closed
    .map((t) => t.edgeAtExec)
    .filter((e): e is number => e != null && e > 0);
  const avgEdge = edges.length > 0 ? edges.reduce((a, b) => a + b, 0) / edges.length : 0;
  const last24 = status?.realizedCombinedPnl24hUsdc ?? status?.realizedPnl24hUsdc ?? 0;
  return (
    <StatRow
      cols={5}
      stats={[
        {
          label: 'Combined PnL',
          value: formatUsdc(total),
          tone: total >= 0 ? 'win' : 'loss',
          hint: `${closed.length} settled`,
        },
        {
          label: 'PnL 24h',
          value: formatUsdc(last24),
          tone: last24 >= 0 ? 'win' : 'loss',
          hint: isMainnet
            ? `limit −${formatUsdc(status?.dailyPolyLossLimitUsdc ?? 0)}`
            : 'paper-mode 24h',
        },
        {
          label: 'Win rate',
          value: formatPct(winRate, 0),
          hint: `${wins}/${closed.length}`,
        },
        {
          label: 'Avg edge captured',
          value: edges.length > 0 ? `${(avgEdge * 100).toFixed(2)}pp` : '—',
          hint: 'Predict − Polymarket at exec',
        },
        {
          label: 'In flight',
          value: liveOpenCount.toString(),
          hint: isMainnet
            ? `cap ${status?.maxOpenPolyPositions ?? '—'}`
            : 'paper open count',
        },
      ]}
    />
  );
}

function OpenTable({
  open,
  isMainnet,
}: {
  open: TradeRecord[];
  isMainnet: boolean;
}) {
  if (open.length === 0) {
    return (
      <div className="text-muted text-sm py-8 text-center">No open poly-arb positions.</div>
    );
  }
  if (!isMainnet) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Opened</TableHead>
            <TableHead>Mode</TableHead>
            <TableHead>Strike</TableHead>
            <TableHead>Dir</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>Expiry</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {open.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="text-muted text-xs">
                {formatRelative(t.timestampMs)}
              </TableCell>
              <TableCell>
                <Badge variant={t.mode === 'live' ? 'live' : 'outline'} className="text-xs">
                  {t.mode}
                </Badge>
              </TableCell>
              <TableCell>${t.strike.toFixed(0)}</TableCell>
              <TableCell>{t.direction.toUpperCase()}</TableCell>
              <TableCell>{formatUsdc(t.costUsdc)}</TableCell>
              <TableCell className="text-muted text-xs">{formatTime(t.expiryMs)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Opened</TableHead>
          <TableHead>Strike</TableHead>
          <TableHead>Poly leg</TableHead>
          <TableHead>HL hedge</TableHead>
          <TableHead>Expiry</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {open.map((t) => {
          const hasPoly = t.polyStatus === 'filled' && !t.polySettled;
          const hasHl = t.hlStatus === 'open';
          return (
            <TableRow key={t.id}>
              <TableCell className="text-muted text-xs">
                {formatTime(t.timestampMs)}
              </TableCell>
              <TableCell>{t.strike > 0 ? `$${t.strike.toFixed(0)}` : '—'}</TableCell>
              <TableCell className="text-xs">
                {hasPoly ? (
                  <span>
                    <span className="font-mono">
                      {t.polyOutcome?.toUpperCase()} {t.polyFilledShares?.toFixed(2)} @
                      {' '}
                      {t.polyFillPrice ? formatPct(t.polyFillPrice, 2) : '—'}
                    </span>
                    <span className="text-muted ml-1">
                      ({formatUsdc(t.polyCostUsdc)} pUSD)
                    </span>
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </TableCell>
              <TableCell className="text-xs">
                {hasHl ? (
                  <span>
                    <span className="font-mono">
                      {t.hlSide?.toUpperCase()} {t.hlSize?.toFixed(5)} @ $
                      {t.hlOpenPrice?.toFixed(0)}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </TableCell>
              <TableCell className="text-muted text-xs">
                {t.expiryMs > 0 ? formatTime(t.expiryMs) : '—'}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ClosedTable({
  closed,
  isMainnet,
}: {
  closed: TradeRecord[];
  isMainnet: boolean;
}) {
  if (closed.length === 0) {
    return (
      <div className="text-muted text-sm py-8 text-center">
        No closed poly-arb trades yet.
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Settled</TableHead>
          <TableHead>Strike</TableHead>
          <TableHead>{isMainnet ? 'Bet' : 'Dir'}</TableHead>
          <TableHead>Edge</TableHead>
          <TableHead>Cost</TableHead>
          <TableHead>Payout</TableHead>
          {isMainnet && <TableHead>Poly PnL</TableHead>}
          {isMainnet && <TableHead>HL PnL</TableHead>}
          <TableHead>{isMainnet ? 'Combined' : 'PnL'}</TableHead>
          {isMainnet && <TableHead>Exit</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {closed.map((t) => {
          const combined = combinedPnl(t, isMainnet);
          const exit =
            t.polySettlementOutcome === undefined && t.polyRedeemStatus
              ? t.polyRedeemStatus
              : t.polySettled
                ? 'uma'
                : '—';
          return (
            <TableRow key={t.id} className={combined >= 0 ? 'text-win' : 'text-loss'}>
              <TableCell className="text-muted text-xs">
                {formatTime(
                  isMainnet ? t.polySettledAtMs ?? t.timestampMs : t.timestampMs,
                )}
              </TableCell>
              <TableCell>${t.strike.toFixed(0)}</TableCell>
              <TableCell>
                {isMainnet ? t.polyOutcome?.toUpperCase() ?? '—' : t.direction.toUpperCase()}
              </TableCell>
              <TableCell className="text-xs">
                {t.edgeAtExec != null ? `${(t.edgeAtExec * 100).toFixed(2)}pp` : '—'}
              </TableCell>
              <TableCell>
                {isMainnet ? formatUsdc(t.polyCostUsdc) : formatUsdc(t.costUsdc)}
              </TableCell>
              <TableCell>
                {isMainnet ? formatUsdc(t.polyPayoutUsdc) : formatUsdc(t.payoutUsdc)}
              </TableCell>
              {isMainnet && <TableCell>{formatUsdc(t.polyPnlUsdc)}</TableCell>}
              {isMainnet && (
                <TableCell>
                  {t.hlPnlUsdc != null ? formatUsdc(t.hlPnlUsdc) : '—'}
                </TableCell>
              )}
              <TableCell className="font-semibold">{formatUsdc(combined)}</TableCell>
              {isMainnet && (
                <TableCell className="text-muted text-xs">{exit}</TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
