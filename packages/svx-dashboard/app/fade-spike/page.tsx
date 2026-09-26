'use client';

/**
 * /fade-spike — the last-minute spike-fade strategy on Predict mainnet.
 *
 * Three layers, most-live first:
 *   1. the strategy's own trades (ledger rows tagged strategy='fade_spike'),
 *      live and paper, with running PnL
 *   2. the shadow scoreboard for the same rule (every qualifying market,
 *      scored on real fees whether or not we traded it)
 *   3. the watched wallets the pattern was learned from
 */

import { useCallback } from 'react';
import { useApiClient } from '@/lib/network-context';
import { usePolling } from '@/lib/usePolling';
import {
  formatPct,
  formatRelative,
  formatUsdc,
  type ShadowSignalScore,
  type StrategyPnlRow,
  type TradeRecord,
  type WatchedWallet,
} from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatRow } from '@/components/StatRow';
import { PageIntro } from '@/components/PageIntro';
import { FadeHuntRadar } from '@/components/FadeHuntRadar';
import { SwitchboardCard } from '@/components/SwitchboardCard';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface PageData {
  rows: StrategyPnlRow[];
  open: TradeRecord[];
  closed: TradeRecord[];
  shadow: ShadowSignalScore[];
  watch: WatchedWallet[];
}

const SHADOW = ['fade_spike', 'fade_spike_any_time', 'fade_spike_40', 'cheap_far_side'];
const SHADOW_LABEL: Record<string, string> = {
  fade_spike: 'Fade spike (≥ $20 move)',
  fade_spike_any_time: 'Timing study: same rule, any checkpoint',
  fade_spike_40: 'Fade spike (≥ $40 move)',
  cheap_far_side: 'Control: cheap far side, no spike',
};

/** 'all' first, then checkpoints from earliest (most time left) to latest. */
const slotOrder = (slot: string) =>
  slot === 'all' ? -1 : -(Number(slot.replace(/\D/g, '')) * (slot.endsWith('m') ? 60 : 1));

const cents = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}¢`;

export default function FadeSpikePage() {
  const client = useApiClient();
  const fetcher = useCallback(async (): Promise<PageData> => {
    const [status, open, closed, shadow, watch] = await Promise.all([
      client.status(),
      client.positionsOpen(),
      client.positionsClosed(1000),
      client.shadowSignals().catch(() => null),
      client.watch().catch(() => null),
    ]);
    // Everything the switchboard trades: fade spike plus any other green signal.
    const isFade = (t: TradeRecord) => t.strategy === 'fade_spike' || t.strategy === 'auto_shadow';
    return {
      rows: (status.strategyPnl ?? []).filter(
        (r) => r.strategy === 'fade_spike' || r.strategy === 'auto_shadow',
      ),
      open: open.filter(isFade),
      closed: closed.filter(isFade),
      shadow: (shadow?.scores ?? []).filter((s) => SHADOW.includes(s.signal)),
      watch: watch?.wallets ?? [],
    };
  }, [client]);
  const { data, error } = usePolling(fetcher, 15_000);

  const sumRows = (mode: 'live' | 'paper') => {
    const rs = (data?.rows ?? []).filter((r) => r.mode === mode);
    if (!rs.length) return undefined;
    return rs.reduce(
      (a, r) => ({
        ...a,
        trades: a.trades + r.trades,
        open: a.open + r.open,
        settled: a.settled + r.settled,
        wins: a.wins + r.wins,
        pnlUsdc: a.pnlUsdc + r.pnlUsdc,
        pnl24hUsdc: a.pnl24hUsdc + r.pnl24hUsdc,
        trades24h: a.trades24h + r.trades24h,
      }),
      { ...rs[0]!, trades: 0, open: 0, settled: 0, wins: 0, pnlUsdc: 0, pnl24hUsdc: 0, trades24h: 0 },
    );
  };
  const live = sumRows('live');
  const paper = sumRows('paper');
  const mode = live && (live.trades > 0 || live.open > 0) ? 'live' : 'paper';
  const recent = [...(data?.open ?? []), ...(data?.closed ?? [])]
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, 40);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[30px] sm:text-[36px] leading-[1.08] font-semibold tracking-[-0.028em]">
          Fade spike
        </h1>
        <Badge variant={mode === 'live' ? 'live' : 'default'}>
          {mode === 'live' ? 'trading live' : 'paper'}
        </Badge>
      </header>

      <FadeHuntRadar />

      <SwitchboardCard />

      <PageIntro
        summary={
          <>
            In the last minute of a Predict up/down window, when BTC has just run $20 or more past
            the strike, the far side gets cheap. This strategy buys it, betting the spike partly
            reverses before settlement: the pattern three mainnet wallets were beating their prices
            with.
          </>
        }
        hints={[
          'Most trades lose: it buys 2–30¢ contracts that win roughly one time in six or seven. Judge it on the running total, not single trades.',
          'It buys at one check per window, about 50 seconds before the end: later checks lost money in testing (fees triple through the final minute and there is less time for the move to reverse).',
          'What trades is decided by the switchboard below: every strategy that is green on the shadow scoreboard trades, red ones stop until they turn green again.',
          'Shared limits: $2.50 per trade, one position per market, 4 open, 80 a day, and a 24-hour stand-down after a $15 loss.',
        ]}
      />

      {error && (
        <Card>
          <CardContent className="pt-6 text-loss text-[14px]">Couldn&apos;t reach the bot: {error}</CardContent>
        </Card>
      )}

      <StatRow
        cols={4}
        stats={[
          {
            label: 'Live PnL',
            value: live ? formatUsdc(live.pnlUsdc) : '—',
            tone: live ? (live.pnlUsdc >= 0 ? 'win' : 'loss') : 'default',
            hint: live
              ? `${live.settled} settled · ${live.wins} won · ${live.open} open`
              : 'no live trades yet',
          },
          {
            label: 'Paper PnL',
            value: paper ? formatUsdc(paper.pnlUsdc) : '—',
            tone: paper ? (paper.pnlUsdc >= 0 ? 'win' : 'loss') : 'default',
            hint: paper ? `${paper.settled} settled · ${paper.wins} won` : 'no paper trades yet',
          },
          {
            label: 'Trades, last 24h',
            value: String((live?.trades24h ?? 0) + (paper?.trades24h ?? 0)),
            hint: `24h PnL ${formatUsdc((live?.pnl24hUsdc ?? 0) + (paper?.pnl24hUsdc ?? 0))}`,
          },
          {
            label: 'Win rate',
            value: (() => {
              const s = (live?.settled ?? 0) + (paper?.settled ?? 0);
              const w = (live?.wins ?? 0) + (paper?.wins ?? 0);
              return s ? formatPct(w / s, 0) : '—';
            })(),
            hint: 'break-even is roughly the average price paid',
          },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle>Trades</CardTitle>
          <CardDescription>Newest first. Open positions settle within a minute of expiry.</CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-[14px] text-muted">
              No trades yet. The signal fires roughly once every ten minutes, only after a sharp
              last-minute move.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Strategy</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Strike</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Payout</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="text-muted">{formatRelative(t.timestampMs)}</TableCell>
                      <TableCell>
                        <Badge variant={t.mode === 'live' ? 'live' : 'default'}>{t.mode}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-strong">
                        {(t.signalId ?? '').replace(/_/g, ' ').replace('@t', ' · ')}
                      </TableCell>
                      <TableCell className="capitalize">{t.direction}</TableCell>
                      <TableCell className="font-mono">${t.strike.toFixed(2)}</TableCell>
                      <TableCell className="font-mono">{(t.costPrice * 100).toFixed(1)}¢</TableCell>
                      <TableCell className="font-mono">${t.quantityDusdc.toFixed(2)}</TableCell>
                      <TableCell className="font-mono">${t.costUsdc.toFixed(2)}</TableCell>
                      <TableCell
                        className={`font-mono ${
                          !t.settled ? 'text-muted' : (t.pnlUsdc ?? 0) >= 0 ? 'text-win' : 'text-loss'
                        }`}
                      >
                        {t.settled ? formatUsdc(t.pnlUsdc) : 'open'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Shadow scoreboard</CardTitle>
          <CardDescription>
            The same rule scored on every qualifying market, traded or not, at real fees. A result
            is only meaningful once the edge is well outside the noise.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(data?.shadow.length ?? 0) === 0 ? (
            <p className="text-[14px] text-muted">No scored decisions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rule</TableHead>
                    <TableHead>Checkpoint</TableHead>
                    <TableHead>Decisions</TableHead>
                    <TableHead>Won</TableHead>
                    <TableHead>Avg cost</TableHead>
                    <TableHead>Per $1 contract</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...(data?.shadow ?? [])]
                    .sort(
                      (a, b) =>
                        SHADOW.indexOf(a.signal) - SHADOW.indexOf(b.signal) ||
                        slotOrder(a.slot) - slotOrder(b.slot),
                    )
                    .map((s) => (
                      <TableRow key={`${s.signal}-${s.slot}`}>
                        <TableCell>{SHADOW_LABEL[s.signal] ?? s.signal}</TableCell>
                        <TableCell className="text-muted">
                          {s.slot === 'all' ? 'All' : s.slot.replace('t', '').replace('s', 's left')}
                        </TableCell>
                        <TableCell className="font-mono">{s.n}</TableCell>
                        <TableCell className="font-mono">
                          {formatPct(s.hitRate, 1)}{' '}
                          <span className="text-muted">±{(s.noise * 100).toFixed(1)}</span>
                        </TableCell>
                        <TableCell className="font-mono">{(s.avgCost * 100).toFixed(1)}¢</TableCell>
                        <TableCell
                          className={`font-mono ${s.pnlPerContract >= 0 ? 'text-win' : 'text-loss'}`}
                        >
                          {cents(s.pnlPerContract)}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Wallets the pattern came from</CardTitle>
          <CardDescription>
            Held positions compared with what their prices implied. A z-score above 2 is unlikely
            to be luck; watch whether it holds.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(data?.watch.length ?? 0) === 0 ? (
            <p className="text-[14px] text-muted">No watched wallets on this network.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Wallet</TableHead>
                    <TableHead>Positions</TableHead>
                    <TableHead>Won vs expected</TableHead>
                    <TableHead>z</TableHead>
                    <TableHead>Profit</TableHead>
                    <TableHead>Last trade</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.watch.map((w) => (
                    <TableRow key={w.owner}>
                      <TableCell>
                        <a
                          className="font-code text-[13px] text-muted-strong hover:text-fg"
                          href={`https://suiscan.xyz/mainnet/account/${w.owner}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {w.owner.slice(0, 6)}…{w.owner.slice(-4)}
                        </a>
                      </TableCell>
                      <TableCell className="font-mono">{w.positions}</TableCell>
                      <TableCell className="font-mono">
                        {w.held.wins} / {w.held.expectedWins.toFixed(1)}
                      </TableCell>
                      <TableCell className="font-mono">{w.held.z?.toFixed(1) ?? '—'}</TableCell>
                      <TableCell className={`font-mono ${w.cashPnl >= 0 ? 'text-win' : 'text-loss'}`}>
                        {formatUsdc(w.cashPnl)}
                      </TableCell>
                      <TableCell className="text-muted">
                        {w.lastTradeMs ? formatRelative(w.lastTradeMs) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
