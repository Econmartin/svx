'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useApiClient, useNetwork } from '@/lib/network-context';
import { formatPct, formatTime, formatUsdc, type TradeRecord } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { StatRow } from '@/components/StatRow';

type View = 'open' | 'closed';

export default function PositionsPage() {
  const client = useApiClient();
  const { network } = useNetwork();
  const isMainnet = network === 'mainnet';
  const [view, setView] = useState<View>('open');

  const { data: open } = usePolling(
    useCallback(() => client.positionsOpen(), [client]),
    10_000,
  );
  const { data: closed } = usePolling(
    useCallback(() => client.positionsClosed(500), [client]),
    30_000,
  );
  const { data: closedPoly } = usePolling(
    useCallback(
      () => (isMainnet ? client.positionsClosedPoly(500) : Promise.resolve([])),
      [client, isMainnet],
    ),
    30_000,
  );

  const closedAll = isMainnet ? closedPoly ?? [] : closed ?? [];
  const openAll = open ?? [];

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Positions</h1>
          <p className="text-muted text-sm mt-1">
            {isMainnet
              ? 'Polymarket fills + Hyperliquid hedges, per trade.'
              : 'Sui-side dUSDC binaries, per trade.'}
          </p>
        </div>
        <Tabs value={view} onValueChange={(v) => setView(v as View)}>
          <TabsList>
            <TabsTrigger value="open">
              Open ({openAll.length})
            </TabsTrigger>
            <TabsTrigger value="closed">
              Closed ({closedAll.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <SummaryCards closed={closedAll} isMainnet={isMainnet} />

      {view === 'closed' && closedAll.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>PnL distribution</CardTitle>
            <p className="text-xs text-muted mt-0.5">
              Per-trade {isMainnet ? 'combined (poly + hl)' : 'realized'} PnL,
              bucketed. Tighter distributions = lower per-trade variance =
              safer to scale.
            </p>
          </CardHeader>
          <CardContent>
            <PnlHistogram closed={closedAll} isMainnet={isMainnet} />
          </CardContent>
        </Card>
      )}

      {view === 'open' && (
        <Card>
          <CardHeader>
            <CardTitle>Open positions</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <OpenTable open={openAll} isMainnet={isMainnet} />
          </CardContent>
        </Card>
      )}

      {view === 'closed' && (
        <Card>
          <CardHeader>
            <CardTitle>Closed positions</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ClosedTable closed={closedAll} isMainnet={isMainnet} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function combinedPnl(t: TradeRecord, isMainnet: boolean): number {
  if (isMainnet) return (t.polyPnlUsdc ?? 0) + (t.hlPnlUsdc ?? 0);
  return t.pnlUsdc ?? 0;
}

function SummaryCards({
  closed,
  isMainnet,
}: {
  closed: TradeRecord[];
  isMainnet: boolean;
}) {
  const pnls = closed.map((t) => combinedPnl(t, isMainnet));
  const total = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const winRate = pnls.length > 0 ? wins.length / pnls.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  return (
    <StatRow
      cols={5}
      stats={[
        {
          label: 'Total realized',
          value: formatUsdc(total),
          tone: total >= 0 ? 'win' : 'loss',
          hint: `${closed.length} closed trades`,
        },
        {
          label: 'Win rate',
          value: formatPct(winRate, 0),
          hint: `${wins.length}/${closed.length}`,
        },
        {
          label: 'Avg win',
          value: formatUsdc(avgWin),
          tone: 'win',
          hint: `${wins.length} wins`,
        },
        {
          label: 'Avg loss',
          value: formatUsdc(avgLoss),
          tone: 'loss',
          hint: `${losses.length} losses`,
        },
        {
          label: 'Expectancy',
          value: formatUsdc(
            winRate * avgWin + (1 - winRate) * avgLoss,
          ),
          tone: winRate * avgWin + (1 - winRate) * avgLoss >= 0 ? 'win' : 'loss',
          hint: 'win·avgWin + lose·avgLoss',
        },
      ]}
    />
  );
}

function PnlHistogram({
  closed,
  isMainnet,
}: {
  closed: TradeRecord[];
  isMainnet: boolean;
}) {
  const buckets = useMemo(() => bucketPnls(closed.map((t) => combinedPnl(t, isMainnet))), [closed, isMainnet]);
  if (buckets.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-muted text-sm">
        Not enough trades to plot.
      </div>
    );
  }
  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={buckets} margin={{ top: 5, right: 16, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1c2230" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: '#8c93a3' }}
            interval={0}
          />
          <YAxis tick={{ fontSize: 11, fill: '#8c93a3' }} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              background: '#11141b',
              border: '1px solid #1c2230',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelFormatter={(label, payload) =>
              payload?.[0]
                ? `Range: ${payload[0].payload.range}`
                : label
            }
            formatter={(v: number) => [v, 'trades']}
          />
          <Bar dataKey="count">
            {buckets.map((b, i) => (
              <Cell key={i} fill={b.center >= 0 ? '#10b981' : '#ef4444'} fillOpacity={0.85} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function bucketPnls(pnls: number[]): Array<{ label: string; range: string; center: number; count: number }> {
  if (pnls.length === 0) return [];
  const min = Math.min(...pnls);
  const max = Math.max(...pnls);
  const bins = 8;
  const span = max - min;
  if (span === 0) return [{ label: pnls[0]!.toFixed(2), range: pnls[0]!.toFixed(2), center: pnls[0]!, count: pnls.length }];
  const width = span / bins;
  const buckets = Array.from({ length: bins }, (_, i) => ({
    lo: min + i * width,
    hi: min + (i + 1) * width,
    count: 0,
  }));
  for (const p of pnls) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((p - min) / width)));
    buckets[idx]!.count++;
  }
  return buckets.map((b) => ({
    label: `${b.lo.toFixed(2)}`,
    range: `${b.lo.toFixed(2)} → ${b.hi.toFixed(2)}`,
    center: (b.lo + b.hi) / 2,
    count: b.count,
  }));
}

function OpenTable({
  open,
  isMainnet,
}: {
  open: TradeRecord[];
  isMainnet: boolean;
}) {
  const rows = isMainnet ? open.filter((t) => !!t.polyStatus) : open;
  if (rows.length === 0) {
    return <div className="text-muted text-sm py-8 text-center">No open positions.</div>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Mode</TableHead>
          <TableHead>Strike</TableHead>
          <TableHead>{isMainnet ? 'Outcome' : 'Direction'}</TableHead>
          <TableHead>{isMainnet ? 'Shares' : 'Qty'}</TableHead>
          <TableHead>{isMainnet ? 'Cost (pUSD)' : 'Cost'}</TableHead>
          {isMainnet && <TableHead>HL hedge</TableHead>}
          <TableHead>Expiry</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((t) => (
          <TableRow key={t.id}>
            <TableCell className="text-muted text-xs">{formatTime(t.timestampMs)}</TableCell>
            <TableCell className="text-xs">
              <Badge variant={t.mode === 'live' ? 'live' : 'outline'}>{t.mode}</Badge>
            </TableCell>
            <TableCell>${t.strike.toFixed(0)}</TableCell>
            <TableCell>
              {isMainnet ? t.polyOutcome?.toUpperCase() ?? '—' : t.direction}
            </TableCell>
            <TableCell>
              {isMainnet
                ? t.polyFilledShares?.toFixed(2) ?? '—'
                : formatUsdc(t.quantityDusdc)}
            </TableCell>
            <TableCell>
              {isMainnet ? formatUsdc(t.polyCostUsdc) : formatUsdc(t.costUsdc)}
            </TableCell>
            {isMainnet && (
              <TableCell>
                {t.hlStatus === 'open' && t.hlSize != null ? (
                  <span className="text-warn text-xs font-mono">
                    {t.hlSide?.toUpperCase()} {t.hlSize.toFixed(5)} @ $
                    {t.hlOpenPrice?.toFixed(0)}
                  </span>
                ) : (
                  <span className="text-muted text-xs">none</span>
                )}
              </TableCell>
            )}
            <TableCell className="text-muted text-xs">{formatTime(t.expiryMs)}</TableCell>
          </TableRow>
        ))}
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
    return <div className="text-muted text-sm py-8 text-center">No closed positions yet.</div>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Settled</TableHead>
          <TableHead>Strike</TableHead>
          <TableHead>{isMainnet ? 'Bet' : 'Dir'}</TableHead>
          <TableHead>Cost</TableHead>
          <TableHead>Payout</TableHead>
          {isMainnet && <TableHead>Poly PnL</TableHead>}
          {isMainnet && <TableHead>HL PnL</TableHead>}
          <TableHead>{isMainnet ? 'Combined' : 'PnL'}</TableHead>
          {isMainnet && <TableHead>Redeem</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {closed.map((t) => {
          const combined = combinedPnl(t, isMainnet);
          return (
            <TableRow
              key={t.id}
              className={combined >= 0 ? 'text-win' : 'text-loss'}
            >
              <TableCell className="text-muted text-xs">
                {formatTime(isMainnet ? t.polySettledAtMs ?? t.timestampMs : t.timestampMs)}
              </TableCell>
              <TableCell>${t.strike.toFixed(0)}</TableCell>
              <TableCell>
                {isMainnet ? t.polyOutcome?.toUpperCase() ?? '—' : t.direction}
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
                <TableCell className="text-xs">
                  {t.polyRedeemTxHash ? (
                    <a
                      href={`https://polygonscan.com/tx/${t.polyRedeemTxHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:text-accent"
                    >
                      tx
                    </a>
                  ) : (
                    t.polyRedeemStatus ?? '—'
                  )}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
