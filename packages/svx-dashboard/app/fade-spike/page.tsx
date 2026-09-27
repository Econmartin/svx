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

/** Ledger tags of every strategy the switchboard can trade. */
const SWITCHBOARD_TAGS = ['fade_spike', 'auto_shadow', 'edge_jump', 'edge_vol'];
/** Every Predict strategy that runs today, including the paper-only harvest. */
const CURRENT_TAGS = [...SWITCHBOARD_TAGS, 'calibration_harvest', 'divergence_mint'];
const TAG_NAMES: Record<string, string> = {
  fade_spike: 'fade spike',
  auto_shadow: 'shadow signals',
  edge_jump: 'Binance jump',
  edge_vol: 'vol model',
  calibration_harvest: 'harvest v2',
  divergence_mint: 'divergence',
};
const SHADOW = [
  'fade_spike',
  'fade_spike_cheap',
  'fade_spike_stalled',
  'longshot_12c',
  'fade_spike_any_time',
  'fade_spike_40',
  'cheap_far_side',
];
const SHADOW_LABEL: Record<string, string> = {
  fade_spike: 'Fade spike (≥ $20 move)',
  fade_spike_any_time: 'Timing study: same rule, any checkpoint',
  fade_spike_40: 'Fade spike (≥ $40 move)',
  fade_spike_cheap: 'Fade spike, far side ≤ 12¢ all-in',
  fade_spike_stalled: 'Fade spike ≤ 12¢, spike stalled (last 5s flat)',
  longshot_12c: 'Any long-shot ≤ 12¢ all-in',
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
    return {
      // Headline totals: every current Predict strategy — the switchboard's
      // (fade spike, green shadow signals, edge trackers) plus the paper-only
      // harvest v2 / divergence mint.
      rows: (status.strategyPnl ?? []).filter((r) => CURRENT_TAGS.includes(r.strategy)),
      // The trade log shows every trade we have made, whatever opened it.
      open,
      closed,
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
  // Win rate and 24h activity follow the headline mode, so a busy paper
  // strategy (harvest v2) can't blur the live numbers.
  const head = mode === 'live' ? live : paper;
  const paperBreakdown = (data?.rows ?? [])
    .filter((r) => r.mode === 'paper' && r.trades > 0)
    .sort((a, b) => b.trades - a.trades)
    .map((r) => `${TAG_NAMES[r.strategy] ?? r.strategy} ${formatUsdc(r.pnlUsdc)} (${r.settled})`)
    .join(' · ');
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
          'What trades is decided by the switchboard below: a strategy switches on above +2¢ per contract on the shadow scoreboard and off at zero or below.',
          'Limits: $2.50 per trade ($4 for long-shots at 12¢ or less all-in) and a 24-hour stand-down after a $15 loss; no cap on how many strategies or trades run.',
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
            hint: paper ? paperBreakdown || `${paper.settled} settled · ${paper.wins} won` : 'no paper trades yet',
          },
          {
            label: mode === 'live' ? 'Live trades, last 24h' : 'Trades, last 24h',
            value: String(head?.trades24h ?? 0),
            hint: `24h PnL ${formatUsdc(head?.pnl24hUsdc ?? 0)}`,
          },
          {
            label: mode === 'live' ? 'Live win rate' : 'Win rate',
            value: (() => {
              const s = head?.settled ?? 0;
              const w = head?.wins ?? 0;
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
                      <TableCell className="font-mono">
                        {t.direction === 'range' && t.rangeUpper != null
                          ? `$${t.strike.toFixed(0)}–$${t.rangeUpper.toFixed(0)}`
                          : `$${t.strike.toFixed(2)}`}
                      </TableCell>
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
