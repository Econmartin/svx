'use client';

/**
 * V2 calibration — the auditor exhibit rebuilt for the 2026-07-26 Predict
 * cutover. The bot samples each market's OWN quoted probabilities (from its
 * on-chain SVI surface — no model of ours) at nine strikes shortly before
 * expiry and resolves every probe against the settlement price. Markets
 * settle every ~3 minutes, so this accrues live all day; the question it
 * answers is whether the favorites edge survived the protocol's roll-down
 * and inventory-skew fixes.
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
const pp = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`;

export function V2CalibrationCard() {
  const client = useApiClient();
  const fetchCalib = useCallback(() => client.calibrationV2(), [client]);
  const { data, error } = usePolling(fetchCalib, 15_000);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Predict V2 calibration
          <Badge variant="live" className="text-[10px]">
            accruing live
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted mt-0.5">
          Predict&apos;s own quoted probability, sampled 15–120s before each market&apos;s
          expiry at 9 strikes, resolved against on-chain settlement. No Polymarket, no model
          of ours in the loop. Markets settle every ~3 minutes; the sample grows all day.{' '}
          <code className="font-mono text-[10px]">GET /calibration-v2</code>
        </p>
      </CardHeader>
      <CardContent>
        {error && <p className="text-loss text-sm">Could not load: {error}</p>}
        {data && data.n === 0 && (
          <p className="text-muted text-sm">
            No settled probes yet — the first rows land within minutes of the recorder
            starting.
          </p>
        )}
        {data && data.n > 0 && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-2 mb-4">
              <div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-muted">
                  Settled probes
                </div>
                <div className="text-xl font-mono font-semibold tabular-nums">{data.n}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-muted">
                  Avg quoted (favored)
                </div>
                <div className="text-xl font-mono font-semibold tabular-nums">
                  {pct(data.avg_quoted)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-muted">
                  Realized
                </div>
                <div className="text-xl font-mono font-semibold tabular-nums">
                  {pct(data.realized)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-muted">Gap</div>
                <div
                  className={`text-xl font-mono font-semibold tabular-nums ${
                    data.realized - data.avg_quoted >= 0 ? 'text-win' : 'text-loss'
                  }`}
                >
                  {pp(data.realized - data.avg_quoted)}
                </div>
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quoted band</TableHead>
                  <TableHead>n</TableHead>
                  <TableHead>Avg quoted</TableHead>
                  <TableHead>Realized</TableHead>
                  <TableHead>Gap</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.buckets.map((b) => (
                  <TableRow key={b.lo}>
                    <TableCell className="font-mono text-xs">
                      {Math.round(b.lo * 100)}–{Math.round(b.hi * 100)}¢
                    </TableCell>
                    <TableCell className="tabular-nums">{b.n}</TableCell>
                    <TableCell className="tabular-nums">{pct(b.avg_quoted)}</TableCell>
                    <TableCell className="tabular-nums">{pct(b.realized)}</TableCell>
                    <TableCell
                      className={`tabular-nums font-mono ${b.gap_pp >= 0 ? 'text-win' : 'text-loss'}`}
                    >
                      {pp(b.gap_pp)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-xs text-muted mt-3">
              Positive gap = the surface is still underconfident on favorites (the V1 edge
              surviving); a gap near zero means the protocol&apos;s roll-down and
              inventory-skew fixes closed it. This number decides whether live V2 minting
              gets enabled.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
