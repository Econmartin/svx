'use client';

/**
 * /divergence-mint — the flagship DeepBook-Predict-mainnet strategy: mint the
 * side Predict prices above 50¢ when Predict's SVI-implied probability and
 * the Polymarket book disagree by ≥ 8pp.
 *
 * The page renders three layers of evidence, most-live first:
 *   1. the strategy's OWN trades (ledger rows tagged strategy='divergence_mint')
 *   2. a live replay of the bot's recorded signal stream (GET /backtest,
 *      side=favored — recomputed against this bot's own ledger on every load)
 *   3. calibration: quoted favorite price vs realized win rate, bucketed.
 */

import { useCallback } from 'react';
import { useApiClient } from '@/lib/network-context';
import { usePolling } from '@/lib/usePolling';
import {
  formatUsdc,
  type BacktestSummary,
  type TradeRecord,
} from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatRow } from '@/components/StatRow';
import { PageIntro } from '@/components/PageIntro';
import { OperatorBanner } from '@/components/OperatorBanner';
import { useNetwork } from '@/lib/network-context';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface PageData {
  open: TradeRecord[];
  closed: TradeRecord[];
  backtest: BacktestSummary | null;
}

const isDivergence = (t: TradeRecord) => t.strategy === 'divergence_mint';

export default function DivergenceMintPage() {
  const client = useApiClient();
  const { network } = useNetwork();
  const fetcher = useCallback(async (): Promise<PageData> => {
    const [open, closed, backtest] = await Promise.all([
      client.positionsOpen(),
      client.positionsClosed(500),
      client.backtest({ threshold: 0.08, side: 'favored', dedupe: true, fee: 0.02 }).catch(() => null),
    ]);
    return {
      open: open.filter(isDivergence),
      closed: closed.filter(isDivergence),
      backtest,
    };
  }, [client]);
  const { data, error } = usePolling(fetcher, 15_000);

  const title = (
    <h1 className="text-[26px] sm:text-[28px] leading-tight font-semibold tracking-tight">
      Divergence-mint strategy
    </h1>
  );

  if (error) {
    return (
      <div className="space-y-4">
        {title}
        <Card>
          <CardContent className="p-4 border border-loss/40 bg-loss/10 rounded-lg text-loss text-sm">
            Could not reach the bot API: {error}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        {title}
        <Card>
          <CardContent className="py-12 text-center text-muted text-sm">Loading…</CardContent>
        </Card>
      </div>
    );
  }

  const settled = data.closed.filter((t) => t.settled && t.pnlUsdc != null);
  const wins = settled.filter((t) => (t.pnlUsdc ?? 0) > 0).length;
  const realizedPnl = settled.reduce((a, t) => a + (t.pnlUsdc ?? 0), 0);
  const openCost = data.open.reduce((a, t) => a + t.costUsdc, 0);
  const bt = data.backtest;
  const isMainnet = network === 'mainnet';

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {title}
          <Badge variant={isMainnet ? 'outline' : 'live'}>
            {isMainnet ? 'paper until Predict Sui mainnet' : 'live · testnet dUSDC'}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            one bet per oracle · 8pp gate
          </Badge>
        </div>
        <p className="text-muted text-[13.5px] max-w-3xl leading-relaxed">
          When Predict&apos;s SVI-implied probability and the Polymarket book disagree by ≥ 8pp on
          the same (strike, expiry), mint the side <strong>Predict prices above 50¢</strong>. At
          large divergences the favorite is directionally right but underconfident — quoted
          ~74–84¢, it realizes 84–94%. Hold to settlement, redeem permissionlessly.
        </p>
      </header>

      <OperatorBanner
        context={
          isMainnet
            ? 'paper mint — flips live with MAINNET_PAPER_TRADING=false when Predict ships Sui mainnet'
            : 'live dUSDC mints on Predict testnet'
        }
      />

      <PageIntro
        summary={
          <>
            The formulation is the finding. Betting the arb&apos;s Predict leg
            (<code className="font-mono text-[10px]">predict_direction</code>) or its mirror both
            flip sign between months — which side that leg points at depends on which venue
            happens to be quoting rich. The favorite is the same economic bet in every regime.
            Validated on two disjoint windows of recorded signals (May 2026: n=50, 94% win,
            +11.9% ROI · July 2026: n=31, 93.5%, +11.5% — deduped, 2% fee haircut), and
            re-checkable below against this bot&apos;s own ledger at any time.
          </>
        }
        hints={[
          <>
            <strong>Why one bet per (oracle, strike)?</strong> The 15s loop re-observes the same
            opportunity dozens of times before it settles. Stacking those is leverage on one coin
            flip, not independent bets — the backtest dedupes the same way.
          </>,
          <>
            <strong>Risk shape:</strong> win ≈ +19–35% of cost per trade; loss = −100% of cost
            when the favorite loses (~6–16% of the time). Fixed 5 dUSDC clips, max 10 open,
            −20 dUSDC/24h standdown, 95¢ price cap.
          </>,
          <>
            <strong>Mainnet-day-one:</strong> settlement, PnL, and{' '}
            <code className="font-mono text-[10px]">redeem_permissionless</code> ride the same
            machinery the arb leg has exercised on testnet since May. The mainnet flip is an
            address swap + config change — no new code path.
          </>,
        ]}
      />

      <StatRow
        cols={4}
        stats={[
          {
            label: 'Settled bets',
            value: String(settled.length),
            tone: 'default',
            hint: settled.length ? `${wins} wins / ${settled.length - wins} losses` : 'awaiting first settlement',
          },
          {
            label: 'Win rate',
            value: settled.length ? `${((wins / settled.length) * 100).toFixed(1)}%` : '—',
            tone: settled.length && wins / settled.length >= 0.8 ? 'win' : 'default',
            hint: 'backtest expectation ~84–94%',
          },
          {
            label: 'Realized PnL',
            value: formatUsdc(realizedPnl),
            tone: realizedPnl >= 0 ? 'win' : 'loss',
            hint: isMainnet ? 'paper dUSDC' : 'dUSDC',
          },
          {
            label: 'In flight',
            value: `${data.open.length} position${data.open.length === 1 ? '' : 's'}`,
            tone: 'default',
            hint: `${formatUsdc(openCost)} at risk · cap 10`,
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Live replay — this bot&apos;s own ledger</CardTitle>
            <p className="text-xs text-muted mt-0.5">
              <code className="font-mono text-[10px]">
                GET /backtest?threshold=0.08&side=favored&dedupe=true&fee=0.02
              </code>{' '}
              — recomputed server-side from every recorded signal, on every page load.
            </p>
          </CardHeader>
          <CardContent>
            {bt ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <Stat label="Independent bets" value={String(bt.would_fire)} />
                <Stat
                  label="Win rate"
                  value={bt.win_rate != null ? `${(bt.win_rate * 100).toFixed(1)}%` : '—'}
                />
                <Stat
                  label="Avg favorite price"
                  value={bt.avg_cost_price != null ? `${(bt.avg_cost_price * 100).toFixed(0)}¢` : '—'}
                />
                <Stat
                  label="ROI after fee"
                  value={bt.roi != null ? `${(bt.roi * 100).toFixed(1)}%` : '—'}
                />
                <Stat
                  label="Signals replayed"
                  value={bt.signals_with_spread.toLocaleString()}
                />
                <Stat
                  label="Data window"
                  value={
                    bt.data_window.firstTsIso
                      ? `${bt.data_window.firstTsIso.slice(5, 10)} → ${bt.data_window.lastTsIso?.slice(5, 10) ?? ''}`
                      : '—'
                  }
                />
              </dl>
            ) : (
              <div className="text-muted text-sm py-6 text-center">
                Backtest endpoint unavailable on this bot version.
              </div>
            )}
            {bt && (
              <p className="text-xs text-muted mt-3 leading-relaxed">
                Signal retention bounds the window (~12 days). The May-2026 archive window
                (n=50, 94% win, +11.9% ROI) is documented with method + caveats in{' '}
                <code className="font-mono text-[10px]">docs/backtest-report.md</code>.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Calibration — quoted vs realized</CardTitle>
            <p className="text-xs text-muted mt-0.5">
              If Predict were perfectly calibrated, each bucket&apos;s realized win rate would
              match its quoted price. The edge is the gap.
            </p>
          </CardHeader>
          <CardContent>
            <CalibrationBuckets settled={settled} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Open positions</span>
            <span className="text-xs text-muted normal-case">{data.open.length}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <TradesTable trades={data.open} showPnl={false} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Settled bets</span>
            <span className="text-xs text-muted normal-case">last {Math.min(settled.length, 50)}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <TradesTable trades={settled.slice(0, 50)} showPnl />
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm tabular-nums truncate">{value}</dd>
    </div>
  );
}

function CalibrationBuckets({ settled }: { settled: TradeRecord[] }) {
  const buckets = [
    { lo: 0.5, hi: 0.7, label: '50–70¢' },
    { lo: 0.7, hi: 0.85, label: '70–85¢' },
    { lo: 0.85, hi: 0.96, label: '85–95¢' },
  ].map((b) => {
    const rows = settled.filter((t) => t.costPrice >= b.lo && t.costPrice < b.hi);
    const w = rows.filter((t) => (t.pnlUsdc ?? 0) > 0).length;
    const avgQuoted = rows.length
      ? rows.reduce((a, t) => a + t.costPrice, 0) / rows.length
      : null;
    return { ...b, n: rows.length, wins: w, avgQuoted };
  });

  if (settled.length === 0) {
    return (
      <div className="text-muted text-sm py-6 text-center">
        Calibration fills in as bets settle — the strategy just went live.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Bucket</TableHead>
          <TableHead>n</TableHead>
          <TableHead>Avg quoted</TableHead>
          <TableHead>Realized</TableHead>
          <TableHead>Edge</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {buckets.map((b) => {
          const realized = b.n ? b.wins / b.n : null;
          const edge =
            realized != null && b.avgQuoted != null ? realized - b.avgQuoted : null;
          return (
            <TableRow key={b.label}>
              <TableCell className="font-mono text-xs">{b.label}</TableCell>
              <TableCell>{b.n}</TableCell>
              <TableCell>
                {b.avgQuoted != null ? `${(b.avgQuoted * 100).toFixed(0)}¢` : '—'}
              </TableCell>
              <TableCell>
                {realized != null ? `${(realized * 100).toFixed(0)}%` : '—'}
              </TableCell>
              <TableCell
                className={
                  edge == null ? '' : edge >= 0 ? 'text-win' : 'text-loss'
                }
              >
                {edge != null ? `${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(0)}pp` : '—'}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function TradesTable({ trades, showPnl }: { trades: TradeRecord[]; showPnl: boolean }) {
  if (trades.length === 0) {
    return (
      <div className="text-muted text-sm py-6 text-center">
        {showPnl
          ? 'No settled bets yet.'
          : 'No open positions — the 8pp gate fires a handful of times a day.'}
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Strike</TableHead>
          <TableHead>Side</TableHead>
          <TableHead>Favorite price</TableHead>
          <TableHead>Divergence</TableHead>
          <TableHead>Cost</TableHead>
          {showPnl && <TableHead>PnL</TableHead>}
          <TableHead>Mode</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {trades.map((t) => (
          <TableRow key={t.id}>
            <TableCell className="text-muted text-xs">
              {new Date(t.timestampMs).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </TableCell>
            <TableCell className="font-mono tabular-nums">
              ${t.strike.toLocaleString()}
            </TableCell>
            <TableCell>
              <Badge variant={t.direction === 'up' ? 'live' : 'warn'} className="text-[10px]">
                {t.direction.toUpperCase()}
              </Badge>
            </TableCell>
            <TableCell className="font-mono tabular-nums">
              {(t.costPrice * 100).toFixed(0)}¢
            </TableCell>
            <TableCell className="font-mono tabular-nums">
              {t.edgeAtExec != null ? `${(t.edgeAtExec * 100).toFixed(1)}pp` : '—'}
            </TableCell>
            <TableCell className="font-mono tabular-nums">{formatUsdc(t.costUsdc)}</TableCell>
            {showPnl && (
              <TableCell
                className={(t.pnlUsdc ?? 0) >= 0 ? 'text-win font-mono' : 'text-loss font-mono'}
              >
                {formatUsdc(t.pnlUsdc ?? 0)}
              </TableCell>
            )}
            <TableCell>
              <Badge variant={t.mode === 'live' ? 'live' : 'outline'} className="text-[10px]">
                {t.mode}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
