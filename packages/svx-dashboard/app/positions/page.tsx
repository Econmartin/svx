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
import { PageIntro } from '@/components/PageIntro';

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
  // On mainnet the bot's ledger accumulates unsettled paper-Predict trade
  // rows (Sui side is paper; Predict oracles should settle them eventually
  // but some pile up). Those aren't real open positions — filter to rows
  // that have a CURRENTLY-OPEN leg: either an unsettled Polymarket fill
  // OR an open HL perp.
  const openAll = isMainnet
    ? (open ?? []).filter(
        (t) =>
          (t.polyStatus === 'filled' && !t.polySettled) || t.hlStatus === 'open',
      )
    : open ?? [];

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-[26px] sm:text-[28px] leading-tight font-semibold tracking-tight">
          Positions
        </h1>
        <p className="text-muted text-[13.5px] max-w-3xl leading-relaxed">
          {isMainnet
            ? 'Polymarket fills + Hyperliquid hedges, per trade.'
            : 'Sui-side dUSDC binaries, per trade.'}
        </p>
      </header>

      <PageIntro
        summary={
          isMainnet ? (
            <>
              Each row is one round-trip on Polymarket, optionally paired with a Hyperliquid hedge.
              Open positions show mark-to-market against the latest book; closed positions show
              <strong> realized PnL</strong> after UMA settlement <em>or</em> after the mid-life
              exit watcher captured the spread.
            </>
          ) : (
            <>
              Each row is one Predict mint on Sui testnet. Open rows wait for oracle settlement;
              closed rows show <strong>realized PnL</strong> after auto-redemption via{' '}
              <code className="font-mono text-[10px]">predict::redeem_permissionless</code>.
            </>
          )
        }
        hints={
          isMainnet
            ? [
                <>Mid-life exits show <code className="font-mono text-[10px]">poly_settlement_outcome = early_exit</code> — the spread compressed in our favor and we sold before waiting for UMA.</>,
                <>Combined PnL = Polymarket leg + HL hedge leg, summed. If the hedge worked, total variance is lower than poly-only.</>,
                <>PnL distribution below tells you scale-up safety — tight = predictable, fat tails = risky to size up.</>,
              ]
            : [
                <>Direction is <em>UP</em> if betting BTC ≥ strike at expiry, <em>DOWN</em> otherwise.</>,
                <>Cost = what we paid Predict for the binary share; payout = $1 per share if right, $0 if wrong.</>,
                <>Win/loss ratio depends on whether oracle-settlement spot crossed the strike — see the calibration scatter on Signals.</>,
              ]
        }
      />

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

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <CardTitle>
              {view === 'open' ? 'Open positions' : 'Closed positions'}
            </CardTitle>
            <p className="text-xs text-muted">
              {view === 'open'
                ? `${openAll.length} currently in flight`
                : `${closedAll.length} settled trades`}
            </p>
          </div>
          <Tabs value={view} onValueChange={(v) => setView(v as View)}>
            <TabsList>
              <TabsTrigger value="open">Open ({openAll.length})</TabsTrigger>
              <TabsTrigger value="closed">
                Closed ({closedAll.length})
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="pt-0">
          {view === 'open' ? (
            <OpenTable open={openAll} isMainnet={isMainnet} />
          ) : (
            <ClosedTable closed={closedAll} isMainnet={isMainnet} />
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
  // Pre-filtered upstream — rows here are all genuinely open. On testnet we
  // get every settled=0 row; on mainnet we get rows with an unsettled Poly
  // fill OR an open HL leg.
  if (open.length === 0) {
    return <div className="text-muted text-sm py-8 text-center">No open positions.</div>;
  }
  if (!isMainnet) {
    // Testnet: simple Predict-side view.
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Mode</TableHead>
            <TableHead>Strike</TableHead>
            <TableHead>Direction</TableHead>
            <TableHead>Qty</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>Expiry</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {open.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="text-muted text-xs">{formatTime(t.timestampMs)}</TableCell>
              <TableCell className="text-xs">
                <Badge variant={t.mode === 'live' ? 'live' : 'outline'}>{t.mode}</Badge>
              </TableCell>
              <TableCell>${t.strike.toFixed(0)}</TableCell>
              <TableCell>{t.direction}</TableCell>
              <TableCell>{formatUsdc(t.quantityDusdc)}</TableCell>
              <TableCell>{formatUsdc(t.costUsdc)}</TableCell>
              <TableCell className="text-muted text-xs">{formatTime(t.expiryMs)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  // Mainnet: show Polymarket leg + HL leg + strategy badge side-by-side.
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Opened</TableHead>
          <TableHead>Strategy</TableHead>
          <TableHead>Strike</TableHead>
          <TableHead>Poly leg</TableHead>
          <TableHead>HL leg</TableHead>
          <TableHead>Expiry</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {open.map((t) => {
          const strategy = t.strategy ?? 'poly_arb';
          const hasPoly = t.polyStatus === 'filled' && !t.polySettled;
          const hasHl = t.hlStatus === 'open';
          return (
            <TableRow key={t.id}>
              <TableCell className="text-muted text-xs">
                {formatTime(t.timestampMs)}
              </TableCell>
              <TableCell>
                <Badge variant={strategy === 'vol_arb' ? 'warn' : 'live'}>{strategy}</Badge>
              </TableCell>
              <TableCell>
                {t.strike > 0 ? `$${t.strike.toFixed(0)}` : '—'}
              </TableCell>
              <TableCell className="text-xs">
                {hasPoly ? (
                  <span>
                    <span className="font-mono">
                      {t.polyOutcome?.toUpperCase()} {t.polyFilledShares?.toFixed(2)} @
                      {' '}{t.polyFillPrice ? formatPct(t.polyFillPrice, 2) : '—'}
                    </span>
                    <span className="text-muted ml-1">({formatUsdc(t.polyCostUsdc)} pUSD)</span>
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
                    <span className="text-muted ml-1">
                      ({formatUsdc((t.hlSize ?? 0) * (t.hlOpenPrice ?? 0))} USD)
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
