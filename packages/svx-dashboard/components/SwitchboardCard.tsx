'use client';

/**
 * Strategy switchboard: every shadow signal at every checkpoint, ON while its
 * profit per $1 contract is green on the scoreboard, OFF while red. The bot
 * trades exactly the ON rows (strategy/switchboard.ts).
 */

import { useCallback, useState } from 'react';
import { useApiClient } from '@/lib/network-context';
import { usePolling } from '@/lib/usePolling';
import { formatRelative } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/cn';

const pretty = (s: string) => s.replace(/_/g, ' ');
const slotLabel = (s: string) =>
  s === 'jump' ? 'any time' : s === 'harvest' ? '45–150s left' : `${s.slice(1)} left`;

export function SwitchboardCard() {
  const client = useApiClient();
  const { data, error } = usePolling(useCallback(() => client.switchboard(), [client]), 30_000);
  const [showAll, setShowAll] = useState(false);
  const on = (data?.strategies ?? []).filter((s) => s.status === 'on');
  const rows = showAll ? (data?.strategies ?? []) : on;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>Switchboard</CardTitle>
          {data && (
            <span
              className={cn(
                'rounded-full px-2.5 h-6 inline-flex items-center text-[12px] font-medium',
                data.paused
                  ? 'bg-loss/[0.12] text-loss'
                  : data.live
                    ? 'bg-win/[0.12] text-win'
                    : 'bg-white/[0.06] text-muted-strong',
              )}
            >
              {data.paused ? 'Paused' : data.live ? 'Trading live' : 'Paper'}
            </span>
          )}
          <span className="text-[13px] text-muted">
            {on.length} on · {(data?.strategies.length ?? 0) - on.length} off
          </span>
        </div>
        <CardDescription>
          Every shadow signal at every checkpoint is a strategy. It switches on once its profit per $1 contract (after fees) is above +2¢, and off when it falls to zero or below; in between it keeps its current state. Every green strategy trades every signal it sees. Limits: ${data?.rules.maxCostUsd ?? 2.5} per trade
          {data?.rules.maxLongshotCostUsd != null &&
            ` ($${data.rules.maxLongshotCostUsd} for long-shots at ${Math.round((data.rules.longshotMaxCostPerContract ?? 0.12) * 100)}¢ or less all-in${data.rules.maxHarvestCostUsd != null ? `, $${data.rules.maxHarvestCostUsd} for harvest v2` : ''})`}
          , and a 24-hour stop after a ${data?.rules.dailyLossLimitUsd ?? 15} loss.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && !data ? (
          <p className="text-[14px] text-muted">Couldn&apos;t reach the bot.</p>
        ) : rows.length === 0 ? (
          <p className="text-[14px] text-muted">Nothing is green right now, so nothing trades.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Strategy</TableHead>
                  <TableHead>Checkpoint</TableHead>
                  <TableHead>Decisions</TableHead>
                  <TableHead>Per $1 contract</TableHead>
                  <TableHead className="text-right">Last 24h · 4h bands</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Since</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.key}>
                    <TableCell className="capitalize">{pretty(s.signal)}</TableCell>
                    <TableCell className="text-muted">{slotLabel(s.slot)}</TableCell>
                    <TableCell className="font-mono">{s.n}</TableCell>
                    <TableCell className={cn('font-mono', s.pnlPerContract > 0 ? 'text-win' : 'text-loss')}>
                      {s.pnlPerContract >= 0 ? '+' : '−'}
                      {Math.abs(s.pnlPerContract * 100).toFixed(1)}¢
                    </TableCell>
                    <TableCell>
                      <RecentForm
                        recent={s.recent ?? []}
                        captured={s.recentCaptured ?? []}
                        bands={s.bands}
                        streak={s.streak ?? 0}
                        recentPnl={s.recentPnl}
                        overall={s.pnlPerContract}
                      />
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          'rounded-full px-2.5 h-6 inline-flex items-center text-[12px] font-medium',
                          s.status === 'on' ? 'bg-win/[0.12] text-win' : 'bg-white/[0.05] text-muted',
                        )}
                      >
                        {s.status === 'on' ? 'On' : 'Off'}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted">{formatRelative(s.sinceMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {(data?.strategies.length ?? 0) > on.length && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="mt-4 text-[13px] text-muted hover:text-fg transition-colors"
          >
            {showAll ? 'Show only strategies that are on' : `Show all ${data?.strategies.length} strategies`}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Last results as dots (oldest → newest), the current streak, and the
 * direction of travel: the last-20 average against the overall average.
 */
function RecentForm({
  recent,
  captured,
  bands,
  streak,
  recentPnl,
  overall,
}: {
  recent: number[];
  /** 1 where we traded that result live: drawn with a ring. */
  captured: number[];
  bands?: Array<{ w: number; l: number; tw: number; tl: number }>;
  streak: number;
  recentPnl?: number;
  overall: number;
}) {
  if (!recent.length) return <span className="text-muted">—</span>;
  const delta = recentPnl != null ? recentPnl - overall : 0;
  const trend =
    recentPnl == null || Math.abs(delta) < 0.01
      ? { glyph: '→', cls: 'text-muted', label: 'steady' }
      : delta > 0
        ? { glyph: '↑', cls: 'text-win', label: 'improving' }
        : { glyph: '↓', cls: 'text-loss', label: 'worsening' };
  const streakLabel =
    streak <= -2 ? `${-streak} losses in a row` : streak >= 2 ? `${streak} wins in a row` : null;
  return (
    <div className="flex items-center gap-2 justify-end">
      {bands ? (
        <Bands bands={bands} />
      ) : (
        <span
          className="inline-flex items-center gap-[4px]"
          aria-label={`last ${recent.length} results, ${captured.filter(Boolean).length} traded live`}
          title={`Ringed: we traded it live (${captured.filter(Boolean).length} of the last ${recent.length})`}
        >
          {recent.map((w, i) => (
            <span
              key={i}
              className={cn(
                'h-2 w-2 rounded-full',
                w ? 'bg-win' : 'bg-loss',
                captured[i] ? 'ring-2 ring-fg ring-offset-1 ring-offset-transparent' : i < recent.length - 5 && 'opacity-60',
              )}
            />
          ))}
        </span>
      )}
      <span className="inline-flex items-center gap-2 w-[124px] shrink-0">
        <span
          className={cn('text-[15px] leading-none font-semibold', trend.cls)}
          title={
            recentPnl != null
              ? `${trend.label}: last 20 ${recentPnl >= 0 ? '+' : '−'}${Math.abs(recentPnl * 100).toFixed(1)}¢ vs overall ${overall >= 0 ? '+' : '−'}${Math.abs(overall * 100).toFixed(1)}¢`
              : undefined
          }
        >
          {trend.glyph}
        </span>
        {streakLabel && (
          <span className={cn('text-[12px] whitespace-nowrap', streak < 0 ? 'text-loss' : 'text-win')}>
            {streakLabel}
          </span>
        )}
      </span>
    </div>
  );
}

const BAND_MS = 4 * 3600_000;
const MAX_DOTS = 8;

/**
 * The last 24h as six 4-hour bands, oldest left. Each band's results:
 * ringed = we traded it live, plain = we did not; green won, red lost.
 * Traded first, so a band with plain dots shows misses at a glance.
 */
function Bands({ bands }: { bands: Array<{ w: number; l: number; tw: number; tl: number }> }) {
  const now = Date.now();
  const hour = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <span className="inline-flex items-stretch shrink-0">
      {bands.map((b, i) => {
        const dots = [
          ...Array<'tw'>(b.tw).fill('tw'),
          ...Array<'tl'>(b.tl).fill('tl'),
          ...Array<'w'>(b.w).fill('w'),
          ...Array<'l'>(b.l).fill('l'),
        ];
        const start = now - (bands.length - i) * BAND_MS;
        const span = `${hour(start)}–${hour(start + BAND_MS)}`;
        return (
          <span
            key={i}
            title={
              dots.length
                ? `${span}: traded ${b.tw + b.tl} (${b.tw}W ${b.tl}L), not traded ${b.w + b.l} (${b.w}W ${b.l}L)`
                : `${span}: no results`
            }
            className={cn(
              'relative grid grid-cols-[repeat(4,6px)] gap-[5px] justify-center content-center w-[50px] min-h-[20px] py-[3px]',
              i > 0 && 'border-l border-white/[0.08]',
            )}
          >
            {dots.length === 0 && <span className="col-span-4 mx-auto h-px w-3 bg-white/[0.12]" />}
            {dots.slice(0, MAX_DOTS).map((d, k) => (
              <span
                key={k}
                className={cn(
                  'h-[6px] w-[6px] rounded-full',
                  d === 'tw' || d === 'w' ? 'bg-win' : 'bg-loss',
                  d === 'tw' || d === 'tl'
                    ? 'ring-[1.5px] ring-fg ring-offset-1 ring-offset-transparent'
                    : 'opacity-70',
                )}
              />
            ))}
            {dots.length > MAX_DOTS && (
              <span className="absolute -bottom-2 right-1 text-[9px] leading-none text-muted">
                +{dots.length - MAX_DOTS}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}
