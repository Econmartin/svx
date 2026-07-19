'use client';

/**
 * /vaults — the two vault-strategy simulations the track brief calls for
 * (idea bank #1 range ladder, #2 PLP + hedge), each replayed live from the
 * bot's own recorded data on every page load:
 *
 *   - Range ladder: GET /range-sim — the strike-width policy question
 *     answered by data (σ/2 wins; ATM rung carries the edge).
 *   - PLP + tail hedge: GET /plp-sim — realized PLP APY from on-chain LP
 *     events minus surface-priced crash insurance. Verdict: NO, with the
 *     numbers that say so.
 */

import { useCallback } from 'react';
import { useApiClient } from '@/lib/network-context';
import { usePolling } from '@/lib/usePolling';
import { type MarginLoopSummary, type PlpSimSummary, type RangeSimSummary } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PageIntro } from '@/components/PageIntro';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface PageData {
  ladders: Array<{ label: string; sim: RangeSimSummary | null }>;
  plp: PlpSimSummary | null;
  plpNear: PlpSimSummary | null;
  plpFar: PlpSimSummary | null;
  marginLoop: MarginLoopSummary | null;
}

export default function VaultsPage() {
  const client = useApiClient();
  const fetcher = useCallback(async (): Promise<PageData> => {
    const grab = <T,>(p: Promise<T>) => p.catch(() => null);
    const [s05, s10, b25, plpNear, plp, plpFar, marginLoop] = await Promise.all([
      grab(client.rangeSim({ policy: 'sigma', width: 0.5 })),
      grab(client.rangeSim({ policy: 'sigma', width: 1 })),
      grab(client.rangeSim({ policy: 'fixed_bps', width: 25 })),
      grab(client.plpSim(1.5)),
      grab(client.plpSim(2)),
      grab(client.plpSim(3)),
      grab(client.marginLoop({ collateral: 100, ltv: 0.5, borrowApr: 0.1 })),
    ]);
    return {
      ladders: [
        { label: 'σ/2 rungs', sim: s05 },
        { label: '1σ rungs', sim: s10 },
        { label: '25 bps rungs', sim: b25 },
      ],
      plp,
      plpNear,
      plpFar,
      marginLoop,
    };
  }, [client]);
  const { data, error } = usePolling(fetcher, 60_000);

  const title = (
    <h1 className="text-[26px] sm:text-[28px] leading-tight font-semibold tracking-tight">
      Vault strategies — simulated on real data
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

  const winner = data?.ladders[0]?.sim ?? null;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {title}
          <Badge variant="outline" className="text-[10px]">
            idea bank #1 + #2 · live replays
          </Badge>
        </div>
        <p className="text-muted text-[13.5px] max-w-3xl leading-relaxed">
          The track brief requires "proper simulation results" for vault strategies. Both
          simulations below are recomputed from this bot&apos;s own recorded surfaces, on-chain LP
          events, and oracle settlements on every page load — same engine the judges can curl.
        </p>
      </header>

      <PageIntro
        summary={
          <>
            One method, two verdicts. The <strong>range ladder</strong> (auto-mint N adjacent
            bands around ATM each expiry) is <strong>viable</strong> — but only at the right
            width, and the data picks it: σ/2 rungs. The <strong>PLP + hedge</strong> vault
            (supply the house side, buy crash insurance) is <strong>not viable</strong> on
            today&apos;s surface — PLP is the counterparty to the very miscalibration our other
            strategies harvest, and near-tail insurance costs ~2× its realized payout. Publishing
            the NO with its numbers is the point: it&apos;s the same smile-shape diagnosis, seen
            from the house&apos;s side of the table.
          </>
        }
        hints={[
          <>
            <strong>Execution exists for both:</strong>{' '}
            <code className="font-mono text-[10px]">svx mint-ladder</code> mints the winning σ/2
            ladder live via <code className="font-mono text-[10px]">predict::mint_range</code>;{' '}
            <code className="font-mono text-[10px]">svx supply-plp</code> takes a house-side
            position via <code className="font-mono text-[10px]">predict::supply</code>.
          </>,
          <>
            <strong>Range caveat:</strong> ranges have no permissionless redeem — the operator
            key redeems after settlement (<code className="font-mono text-[10px]">redeem_range</code>).
          </>,
          <>
            <strong>Why σ/2 wins:</strong> the calibration exhibit (landing page) shows the
            surface underprices the center of the distribution. Narrow ladders concentrate
            capital exactly there; wide ladders donate it back through overpriced wings.
          </>,
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle>Range ladder — strike-width policy shoot-out</CardTitle>
          <p className="text-xs text-muted mt-0.5">
            5 rungs around ATM per settled oracle, priced off the surface the vault would have
            seen, 2% fee. <code className="font-mono text-[10px]">GET /range-sim</code>.
          </p>
          <p className="text-xs text-warn mt-1.5">
            <strong>Live replay window:</strong> this table recomputes on the settled oracles the
            running bot still retains full surface data for — few since the feed froze July 12.
            The research verdict (half-sigma rungs, <span className="font-mono">+10.1%</span>) is
            the archived <strong>104-oracle replay</strong> in the repo&apos;s backtest report;
            this card exists to show the method runs live, not to restate that result.
          </p>
        </CardHeader>
        <CardContent>
          {data ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Policy</TableHead>
                    <TableHead>Oracles</TableHead>
                    <TableHead>Rungs</TableHead>
                    <TableHead>Hit rate</TableHead>
                    <TableHead>ROI after fee</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.ladders.map(({ label, sim }) => (
                    <TableRow key={label}>
                      <TableCell className="font-mono text-xs">{label}</TableCell>
                      <TableCell>{sim?.oracles_simulated ?? '—'}</TableCell>
                      <TableCell>{sim?.rungs_minted ?? '—'}</TableCell>
                      <TableCell>
                        {sim?.ladder_hit_rate != null ? `${(sim.ladder_hit_rate * 100).toFixed(0)}%` : '—'}
                      </TableCell>
                      <TableCell
                        className={
                          sim?.roi == null ? '' : sim.roi >= 0 ? 'text-win font-mono' : 'text-loss font-mono'
                        }
                      >
                        {sim?.roi != null ? `${sim.roi >= 0 ? '+' : ''}${(sim.roi * 100).toFixed(1)}%` : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {winner && winner.by_offset.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs text-muted mb-2">
                    σ/2 ladder, per rung (offset 0 = the band containing ATM):
                  </p>
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs font-mono tabular-nums">
                    {winner.by_offset.map((b) => (
                      <span key={b.offset}>
                        [{b.offset >= 0 ? '+' : ''}
                        {b.offset}] hit {b.hit_rate != null ? `${(b.hit_rate * 100).toFixed(0)}%` : '—'} · roi{' '}
                        <span className={b.roi != null && b.roi >= 0 ? 'text-win' : 'text-loss'}>
                          {b.roi != null ? `${b.roi >= 0 ? '+' : ''}${(b.roi * 100).toFixed(0)}%` : '—'}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-muted text-sm py-6 text-center">Loading…</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            PLP + tail hedge
            <Badge variant="outline" className="text-[10px]">verdict: not viable — here&apos;s why</Badge>
          </CardTitle>
          <p className="text-xs text-muted mt-0.5">
            PLP APY realized from on-chain supply/withdraw events; crash insurance priced per
            oracle cycle off recorded surfaces, netted against realized crash payouts.{' '}
            <code className="font-mono text-[10px]">GET /plp-sim</code>.
          </p>
        </CardHeader>
        <CardContent>
          {data?.plp ? (
            <>
              <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm font-mono tabular-nums mb-4">
                <span>
                  <span className="text-muted text-xs uppercase tracking-wider">PLP realized APY</span>{' '}
                  {data.plp.plp.realized_apy != null
                    ? `${(data.plp.plp.realized_apy * 100).toFixed(2)}%`
                    : '—'}
                </span>
                <span>
                  <span className="text-muted text-xs uppercase tracking-wider">share price</span>{' '}
                  {data.plp.plp.share_price_first} → {data.plp.plp.share_price_last}
                </span>
                <span>
                  <span className="text-muted text-xs uppercase tracking-wider">window</span>{' '}
                  {data.plp.plp.window_days}d · {data.plp.plp.events} events
                </span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Crash strike</TableHead>
                    <TableHead>Premium / cycle</TableHead>
                    <TableHead>Realized crash rate</TableHead>
                    <TableHead>Verdict</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[
                    { label: '1.5σ', sim: data.plpNear, verdict: 'near tails overpriced ~2×' },
                    { label: '2σ', sim: data.plp, verdict: 'roughly fair' },
                    { label: '3σ', sim: data.plpFar, verdict: 'far tails underpriced (thin n)' },
                  ].map(({ label, sim, verdict }) => (
                    <TableRow key={label}>
                      <TableCell className="font-mono text-xs">{label}</TableCell>
                      <TableCell>
                        {sim?.hedge.avg_premium_frac != null
                          ? `${(sim.hedge.avg_premium_frac * 100).toFixed(2)}%`
                          : '—'}
                      </TableCell>
                      <TableCell>
                        {sim?.hedge.crash_hit_rate != null
                          ? `${(sim.hedge.crash_hit_rate * 100).toFixed(2)}%`
                          : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-muted">{verdict}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-xs text-muted mt-3 leading-relaxed max-w-3xl">
                The vault side barely earns because it is the counterparty to the calibration
                edge, and sensible insurance costs more than the yield — net APY is negative at
                any coverage. Together with the center-calibration exhibit this completes the
                smile-shape diagnosis: center underpriced, near wings overpriced, far wings
                underpriced.
              </p>
            </>
          ) : (
            <div className="text-muted text-sm py-6 text-center">Loading…</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Three-protocol margin loop
            <Badge variant="outline" className="text-[10px]">simulated · live when Predict ships mainnet</Badge>
          </CardTitle>
          <p className="text-xs text-muted mt-0.5">
            Borrow dUSDC on <code className="font-mono text-[10px]">deepbook_margin</code> against
            an <code className="font-mono text-[10px]">iron_bank</code> USDsui share, deploy into
            the favored-side strategies, repay from settlements. Strategy leg = this bot&apos;s
            real settled trades; borrow APR is an explicit assumption (no public rate feed).{' '}
            <code className="font-mono text-[10px]">GET /margin-loop</code>.
          </p>
        </CardHeader>
        <CardContent>
          {data?.marginLoop && data.marginLoop.strategy.trades > 0 ? (
            <>
              <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm font-mono tabular-nums">
                <span>
                  <span className="text-muted text-xs uppercase tracking-wider">strategy leg</span>{' '}
                  {data.marginLoop.strategy.trades} trades ·{' '}
                  {data.marginLoop.strategy.win_rate != null
                    ? `${(data.marginLoop.strategy.win_rate * 100).toFixed(0)}% win`
                    : '—'}{' '}
                  · {data.marginLoop.strategy.roi_per_trade != null
                    ? `${(data.marginLoop.strategy.roi_per_trade * 100).toFixed(1)}%/trade`
                    : '—'}
                </span>
                <span>
                  <span className="text-muted text-xs uppercase tracking-wider">borrow</span>{' '}
                  ${data.marginLoop.loop.borrowed_usdc} @ {(data.marginLoop.loop.borrow_apr_assumed * 100).toFixed(0)}% (assumed)
                </span>
                <span>
                  <span className="text-muted text-xs uppercase tracking-wider">utilization</span>{' '}
                  {data.marginLoop.loop.utilization != null
                    ? `${(data.marginLoop.loop.utilization * 100).toFixed(0)}%`
                    : '—'}
                </span>
                <span>
                  <span className="text-muted text-xs uppercase tracking-wider">levered net APY</span>{' '}
                  <span
                    className={
                      (data.marginLoop.loop.levered_net_apy ?? 0) >= 0 ? 'text-win' : 'text-loss'
                    }
                  >
                    {data.marginLoop.loop.levered_net_apy != null
                      ? `${(data.marginLoop.loop.levered_net_apy * 100).toFixed(1)}%`
                      : '—'}
                  </span>
                </span>
              </div>
              <p className="text-xs text-muted mt-3 leading-relaxed max-w-3xl">
                The honest number to watch is <strong>utilization</strong>: a borrow only earns
                where the signal flow can deploy it. At small clip sizes most of the borrow idles
                and interest dominates — the loop starts making sense when clip sizes grow into
                the borrow, which is a post-mainnet scaling decision, not a hackathon one. The
                execution path (intent builders for all three protocols) already exists from the
                margin-lever build.
              </p>
            </>
          ) : (
            <div className="text-muted text-sm py-6 text-center">
              Fills in as favored-side trades settle on this bot.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
