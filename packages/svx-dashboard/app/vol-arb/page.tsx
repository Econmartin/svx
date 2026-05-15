'use client';

/**
 * /vol-arb — standalone Hyperliquid directional strategy dashboard.
 *
 * Shows live IV vs RV, the current decision, recent decision history,
 * and open/closed vol-arb positions. The strategy is driven by the
 * divergence between Predict's ATM IV (forecast) and HL's realized vol
 * (measured), with direction picked from the SVI surface skew.
 *
 * Independent from the poly-arb dashboard — vol-arb trades only HL, no
 * Polymarket leg.
 */

import { useCallback } from 'react';
import {
  Line,
  LineChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts';
import { useApiClient } from '@/lib/network-context';
import { formatPct, formatUsdc, formatRelative, type VolArbDecisionLog } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatRow } from '@/components/StatRow';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CheckCircle2, AlertTriangle, Activity, Clock } from 'lucide-react';

export default function VolArbPage() {
  const client = useApiClient();
  const fetchState = useCallback(() => client.volArbState(), [client]);
  const { data, error } = usePolling(fetchState, 5_000);

  if (error) {
    return (
      <div className="rounded border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
        Could not reach the bot API: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted text-sm">Loading…</CardContent>
      </Card>
    );
  }

  const s = data.state;
  const lastDecision = s?.lastDecision ?? null;
  const ivSpread = lastDecision?.ivSpread ?? null;
  const hasOpen = data.openPositions.length > 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start gap-4 justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-3">
            Vol-arb strategy
            <Badge variant={data.enabled ? 'live' : 'outline'}>
              {data.enabled ? 'exec on' : 'paper / signals only'}
            </Badge>
          </h1>
          <p className="text-muted text-sm mt-1 max-w-3xl">
            Standalone Hyperliquid directional perp strategy. Trades when
            Predict's ATM IV diverges from HL's realized vol AND the SVI
            surface has a clear directional bias. Independent from the
            Predict×Polymarket arb on the overview page.
          </p>
        </div>
        {lastDecision && (
          <Badge
            variant={
              lastDecision.action.startsWith('open')
                ? 'live'
                : lastDecision.action === 'close'
                  ? 'warn'
                  : 'outline'
            }
            className="text-xs"
          >
            {lastDecision.action}
          </Badge>
        )}
      </header>

      <StatRow
        cols={5}
        stats={[
          {
            label: 'Predict ATM IV',
            value: lastDecision ? `${(lastDecision.predictIv * 100).toFixed(1)}%` : '—',
            hint: 'shortest-expiry oracle, at-spot',
          },
          {
            label: 'HL realized vol',
            value: lastDecision ? `${(lastDecision.realizedVol * 100).toFixed(1)}%` : '—',
            hint: `${s?.midHistory.length ?? 0} samples in buffer`,
          },
          {
            label: 'IV − RV',
            value: ivSpread != null ? `${ivSpread >= 0 ? '+' : ''}${(ivSpread * 100).toFixed(2)}%` : '—',
            tone:
              ivSpread != null && Math.abs(ivSpread) > data.thresholds.openSpread
                ? 'win'
                : 'default',
            hint: `open ≥ ${(data.thresholds.openSpread * 100).toFixed(0)}% · close < ${(data.thresholds.closeSpread * 100).toFixed(0)}%`,
          },
          {
            label: 'Predict P(↑)',
            value: lastDecision ? `${(lastDecision.predictUpAtSpot * 100).toFixed(1)}%` : '—',
            hint: `bias trigger ${(data.thresholds.directionBias * 100).toFixed(0)}% from 50%`,
          },
          {
            label: 'Realized PnL',
            value: formatUsdc(data.realizedPnlUsdc),
            tone: data.realizedPnlUsdc >= 0 ? 'win' : 'loss',
            hint: `24h: ${formatUsdc(data.realizedPnl24hUsdc)} · ${data.closedPositions.length} closed`,
          },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle>IV vs realized vol</CardTitle>
          <p className="text-xs text-muted mt-0.5">
            Live time series across recent decisions. When the green (IV) line
            diverges from the blue (RV) line beyond the threshold AND
            Predict's surface has a directional bias, the bot opens an HL
            perp position in that direction.
          </p>
        </CardHeader>
        <CardContent>
          <IvRvChart decisions={s?.recentDecisions ?? []} threshold={data.thresholds.openSpread} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4" /> Open positions
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {hasOpen ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Opened</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Open px</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.openPositions.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="text-muted text-xs">
                        {formatRelative(t.timestampMs)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={t.hlSide === 'long' ? 'live' : 'warn'}>
                          {t.hlSide?.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell>{t.hlSize?.toFixed(5)}</TableCell>
                      <TableCell>${t.hlOpenPrice?.toFixed(1)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted py-6 text-center">No open positions.</p>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-4 w-4" /> Recent decisions
            </CardTitle>
            <p className="text-xs text-muted mt-0.5">
              Last 15. Green dot = bot fired a trade. Grey = signal evaluated,
              no action.
            </p>
          </CardHeader>
          <CardContent className="pt-0">
            <DecisionList decisions={(s?.recentDecisions ?? []).slice(0, 15)} />
          </CardContent>
        </Card>
      </div>

      {data.closedPositions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Closed positions ({data.closedPositions.length})</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Closed</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Open px</TableHead>
                  <TableHead>Close px</TableHead>
                  <TableHead>PnL</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.closedPositions.map((t) => {
                  const pnl = t.hlPnlUsdc ?? 0;
                  return (
                    <TableRow key={t.id} className={pnl >= 0 ? 'text-win' : 'text-loss'}>
                      <TableCell className="text-muted text-xs">
                        {t.hlClosedAtMs ? formatRelative(t.hlClosedAtMs) : '—'}
                      </TableCell>
                      <TableCell>{t.hlSide?.toUpperCase()}</TableCell>
                      <TableCell>{t.hlSize?.toFixed(5)}</TableCell>
                      <TableCell>${t.hlOpenPrice?.toFixed(1)}</TableCell>
                      <TableCell>${t.hlClosePrice?.toFixed(1)}</TableCell>
                      <TableCell className="font-semibold">{formatUsdc(pnl)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function IvRvChart({
  decisions,
  threshold,
}: {
  decisions: VolArbDecisionLog[];
  threshold: number;
}) {
  if (decisions.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted text-sm">
        Buffer warming up — chart populates as the bot evaluates IV vs RV every 15s.
      </div>
    );
  }
  // Reverse to chronological order for the chart.
  const data = decisions
    .slice()
    .reverse()
    .map((d) => ({
      ts: d.ts,
      iv: d.predictIv,
      rv: d.realizedVol,
      spread: d.ivSpread,
    }));
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 5, right: 16, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1c2230" />
          <XAxis
            dataKey="ts"
            type="number"
            domain={['auto', 'auto']}
            tickFormatter={(v) => new Date(v).toLocaleTimeString()}
            tick={{ fontSize: 11, fill: '#8c93a3' }}
            scale="time"
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#8c93a3' }}
            tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <Tooltip
            contentStyle={{
              background: '#11141b',
              border: '1px solid #1c2230',
              borderRadius: 6,
              fontSize: 12,
            }}
            labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
            formatter={(v: number, name: string) => [`${(v * 100).toFixed(2)}%`, name]}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine y={threshold} stroke="#f59e0b" strokeDasharray="4 4" />
          <ReferenceLine y={-threshold} stroke="#f59e0b" strokeDasharray="4 4" />
          <Line type="monotone" dataKey="iv" name="Predict IV" stroke="#10b981" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="rv" name="HL realized vol" stroke="#7dd3fc" strokeWidth={2} dot={false} />
          <Line
            type="monotone"
            dataKey="spread"
            name="IV − RV"
            stroke="#f59e0b"
            strokeWidth={1}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function DecisionList({ decisions }: { decisions: VolArbDecisionLog[] }) {
  if (decisions.length === 0) {
    return <p className="text-sm text-muted py-6 text-center">No decisions yet.</p>;
  }
  return (
    <div className="space-y-1.5">
      {decisions.map((d, i) => (
        <div
          key={`${d.ts}-${i}`}
          className="flex items-center gap-3 text-xs px-2 py-1.5 rounded hover:bg-surface-elevated transition-colors"
        >
          <span className="text-muted tabular-nums whitespace-nowrap w-16">
            {new Date(d.ts).toLocaleTimeString()}
          </span>
          {d.acted ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-win" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 text-muted/40" />
          )}
          <span
            className={`font-mono ${
              d.action.startsWith('open')
                ? 'text-win'
                : d.action === 'close'
                  ? 'text-warn'
                  : 'text-muted'
            }`}
          >
            {d.action}
          </span>
          <span className="text-muted">·</span>
          <span className="font-mono tabular-nums text-muted">
            IV {formatPct(d.predictIv, 1)} / RV {formatPct(d.realizedVol, 1)}
          </span>
          <span className="text-muted">·</span>
          <span
            className={`font-mono tabular-nums ${
              Math.abs(d.ivSpread) > 0.03 ? '' : 'text-muted/60'
            }`}
          >
            {d.ivSpread >= 0 ? '+' : ''}
            {(d.ivSpread * 100).toFixed(2)}%
          </span>
          <span className="ml-auto text-muted/70 truncate max-w-md">{d.reason}</span>
        </div>
      ))}
    </div>
  );
}
