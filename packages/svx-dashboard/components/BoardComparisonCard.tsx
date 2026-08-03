'use client';

/**
 * Board vs model vs realized — the three-way exhibit.
 *
 * For every listed market, at every life stage from 31 days out to the final
 * minutes, the bot records two prices at the same strikes: the protocol's own
 * BOARD quote (what a trade would actually pay, skew included) and our
 * surface-derived MODEL price. Both resolve against the same settlement, so
 * the gaps are directly comparable — and the difference between them is the
 * cost of trading rather than a disagreement about probability.
 */

import { useCallback } from 'react';
import { useApiClient } from '@/lib/network-context';
import { usePolling } from '@/lib/usePolling';
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

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const pp = (v: number | null) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`;

/** Human tenor labels for the life-stage slots the recorder writes. */
const SLOT_LABEL: Record<string, string> = {
  t2m: '< 2 min',
  t5m: '2–5 min',
  t15m: '5–15 min',
  t1h: '15–60 min',
  t4h: '1–4 h',
  t1d: '4–24 h',
  t7d: '1–7 d',
  t7d_plus: '> 7 d',
};
const SLOT_ORDER = ['t2m', 't5m', 't15m', 't1h', 't4h', 't1d', 't7d', 't7d_plus'];

export function BoardComparisonCard() {
  const client = useApiClient();
  const fetchCmp = useCallback(() => client.boardComparison(), [client]);
  const { data, error } = usePolling(fetchCmp, 20_000);

  const slots = data
    ? [...data.bySlot].sort(
        (a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot),
      )
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Board vs model vs realized
          <Badge variant="live" className="text-[10px]">
            full market board
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted mt-0.5">
          Read through DeepBook&apos;s own Predict SDK over gRPC — every listed market and
          tenor, from 31-day listings down to the final minutes. At each strike we record the
          protocol&apos;s <strong>board quote</strong> (what a trade pays, skew included) beside
          our <strong>model price</strong> (from the on-chain volatility surface); both settle
          against the same outcome.{' '}
          <code className="font-mono text-[10px]">GET /board-comparison</code>
        </p>
      </CardHeader>
      <CardContent>
        {error && <p className="text-loss text-sm">Could not load: {error}</p>}
        {data && data.n === 0 && (
          <p className="text-muted text-sm">
            No settled probes yet — the ladder fills in as each market expires (minutes for
            the short tenors, days for the long ones).
          </p>
        )}
        {data && data.n > 0 && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 mb-4">
              <Stat label="Settled probes" value={String(data.n)} />
              <Stat label="With board quote" value={String(data.withBoard)} />
              <Stat
                label="Model gap"
                value={pp(data.model.gap_pp)}
                tone={data.model.gap_pp >= 0 ? 'win' : 'loss'}
              />
              <Stat
                label="Board gap"
                value={data.withBoard ? pp(data.board.gap_pp) : '—'}
                tone={data.board.gap_pp >= 0 ? 'win' : 'loss'}
              />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tenor</TableHead>
                  <TableHead>n</TableHead>
                  <TableHead>Model gap</TableHead>
                  <TableHead>Board gap</TableHead>
                  <TableHead>Board − model</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slots.map((s) => (
                  <TableRow key={s.slot}>
                    <TableCell className="font-mono text-xs">
                      {SLOT_LABEL[s.slot] ?? s.slot}
                    </TableCell>
                    <TableCell className="tabular-nums">{s.n}</TableCell>
                    <TableCell
                      className={`tabular-nums font-mono ${s.model_gap_pp >= 0 ? 'text-win' : 'text-loss'}`}
                    >
                      {pp(s.model_gap_pp)}
                    </TableCell>
                    <TableCell
                      className={`tabular-nums font-mono ${
                        s.board_gap_pp == null
                          ? 'text-muted'
                          : s.board_gap_pp >= 0
                            ? 'text-win'
                            : 'text-loss'
                      }`}
                    >
                      {pp(s.board_gap_pp)}
                    </TableCell>
                    <TableCell className="tabular-nums font-mono text-muted">
                      {pp(s.board_minus_model_pp)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-xs text-muted mt-3">
              A positive gap means the price was too low for what actually happened. The{' '}
              <strong>board</strong> column is the one that decides whether a tenor is
              tradeable — it already contains the skew we would pay. Where board and model
              disagree, the difference is the protocol&apos;s spread, not a forecast
              disagreement.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'win' | 'loss';
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-muted">{label}</div>
      <div
        className={`text-xl font-mono font-semibold tabular-nums ${
          tone === 'win' ? 'text-win' : tone === 'loss' ? 'text-loss' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}
