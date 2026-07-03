'use client';

/**
 * /margin-lever — Strategy 3: borrow dUSDC on deepbook_margin against an
 * iron_bank USDsui share, take a directional BTC spot position driven by
 * Predict's SVI bias, close on signal flip or time-stop.
 *
 * Paper-mode only in v1. The page renders the simulated PnL, open/closed
 * paper positions, thresholds + caps, and the live decision log.
 */

import { useCallback } from 'react';
import { useApiClient } from '@/lib/network-context';
import { usePolling } from '@/lib/usePolling';
import { formatUsdc, type MarginLeverDecision } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatRow } from '@/components/StatRow';
import { PageIntro } from '@/components/PageIntro';
import { OperatorBanner } from '@/components/OperatorBanner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default function MarginLeverPage() {
  const client = useApiClient();
  const fetcher = useCallback(() => client.marginLeverState(), [client]);
  const { data, error } = usePolling(fetcher, 10_000);

  if (error) {
    return (
      <div className="space-y-4">
        <h1 className="text-[26px] sm:text-[28px] leading-tight font-semibold tracking-tight">
          Margin-Lever
        </h1>
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
        <h1 className="text-[26px] sm:text-[28px] leading-tight font-semibold tracking-tight">
          Margin-Lever
        </h1>
        <Card>
          <CardContent className="py-12 text-center text-muted text-sm">
            Loading…
          </CardContent>
        </Card>
      </div>
    );
  }

  const lastDecision = data.lastDecision;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-[26px] sm:text-[28px] leading-tight font-semibold tracking-tight">
            Margin-Lever strategy
          </h1>
          <Badge variant="outline" className="text-[10px]">paper · v1</Badge>
          <Badge variant={data.enabled ? 'live' : 'outline'}>
            {data.enabled ? 'ticker on' : 'ticker off'}
          </Badge>
          {lastDecision && (
            <Badge
              variant={
                lastDecision.action.startsWith('open')
                  ? 'live'
                  : lastDecision.action === 'close'
                    ? 'warn'
                    : 'outline'
              }
              className="sm:ml-auto text-xs"
            >
              {lastDecision.action}
            </Badge>
          )}
        </div>
        <p className="text-muted text-[13.5px] max-w-3xl leading-relaxed">
          Borrow dUSDC on <code className="font-mono text-[10px]">deepbook_margin</code> against an{' '}
          <code className="font-mono text-[10px]">iron_bank</code> USDsui share, deploy into a
          directional BTC spot view driven by Predict's SVI bias, close on
          signal flip or time-stop. Lives on Sui mainnet rails (vs Predict
          testnet for the pricing brain).
        </p>
      </header>

      <OperatorBanner context="paper simulation — no PTBs submitted in v1" />

      <PageIntro
        summary={
          <>
            Three-protocol composition on Sui mainnet. The strategy reads
            Predict's <code className="font-mono text-[10px]">P(↑)</code>{' '}
            from the shortest-expiry BTC oracle, opens a paper long/short
            when{' '}
            <code className="font-mono text-[10px]">|P(↑) − 50%|</code>{' '}
            exceeds the open threshold, and closes on bias decay or
            time-stop. PTBs for both{' '}
            <code className="font-mono text-[10px]">deepbook_margin::*</code>{' '}
            and{' '}
            <code className="font-mono text-[10px]">iron_bank::*</code>{' '}
            are constructed and ledgered, never submitted — flipping to
            live requires the operator to fund USDsui collateral first.
          </>
        }
        hints={[
          <>
            <strong>Why a third strategy?</strong> The existing arbs don't
            deploy Sui-mainnet capital — Predict is testnet, vol-arb is HL.
            A Sui-mainnet strategy gives the three-protocol composition
            story the Sui Overflow brief calls for.
          </>,
          <>
            <strong>Why paper?</strong> Live execution needs USDsui
            collateral funded on iron_bank — that's a future operator
            step. Paper mode exercises the real PTB construction (snapshot
            tests prove it) and reports simulated PnL.
          </>,
          <>
            The strategy never touches the <strong>poly-arb</strong> 15s
            loop or the <strong>IV-RV</strong> 2s ticker. Independent
            risk gates, independent state, independent kill switch.
          </>,
          <>
            <strong>2026-07 audit verdict: kept OFF.</strong> The signal
            decomposes to ln(F/S)/√w — a forward-basis z-score whose gain
            diverges as the shortest oracle nears expiry, so it fires on
            bps-scale noise from a testnet feed, and paper PnL is marked on
            the same feed that generated the signal. It stays disabled until
            the signal is redesigned; the page remains for transparency.
          </>,
        ]}
      />

      <StatRow
        cols={4}
        stats={[
          {
            label: 'Simulated PnL (all)',
            value: formatUsdc(data.simulatedPnlUsdc),
            tone: data.simulatedPnlUsdc >= 0 ? 'win' : 'loss',
            hint: `${data.closed.length} closed`,
          },
          {
            label: 'Simulated PnL 24h',
            value: formatUsdc(data.simulatedPnl24hUsdc),
            tone: data.simulatedPnl24hUsdc >= 0 ? 'win' : 'loss',
            hint: `limit −${formatUsdc(data.caps.dailyLossLimitUsdc)}`,
          },
          {
            label: 'Current bias',
            value: lastDecision
              ? `${(lastDecision.biasMagnitude * 100).toFixed(1)}%`
              : '—',
            tone: 'default',
            hint: lastDecision
              ? `P↑ ${(lastDecision.predictUpAtSpot * 100).toFixed(1)}%`
              : 'awaiting first decision',
          },
          {
            label: 'In flight',
            value: data.open ? '1 position' : '0',
            tone: 'default',
            hint: data.open
              ? `${data.open.side.toUpperCase()} ${formatUsdc(data.open.notionalUsdc)}`
              : `cap ${formatUsdc(data.caps.perTradeNotionalUsdc)} / borrow ${formatUsdc(data.caps.maxBorrowNotionalUsdc)}`,
          },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Thresholds &amp; caps</CardTitle>
            <p className="text-xs text-muted mt-0.5">
              All non-secret knobs live in{' '}
              <code className="font-mono text-[10px]">tunables.ts</code>{' '}
              under the <code className="font-mono text-[10px]">marginLever*</code> namespace.
            </p>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              <Stat label="Open bias" value={`${(data.thresholds.openBias * 100).toFixed(1)}%`} />
              <Stat label="Close bias" value={`${(data.thresholds.closeBias * 100).toFixed(1)}%`} />
              <Stat label="Time-stop" value={`${data.thresholds.maxHoldMinutes}m`} />
              <Stat label="Per-trade notional" value={formatUsdc(data.caps.perTradeNotionalUsdc)} />
              <Stat label="Max borrow notional" value={formatUsdc(data.caps.maxBorrowNotionalUsdc)} />
              <Stat label="Daily loss limit" value={formatUsdc(data.caps.dailyLossLimitUsdc)} />
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Open paper position</CardTitle>
            <p className="text-xs text-muted mt-0.5">
              Single-position regime in v1 — strategy holds until close.
            </p>
          </CardHeader>
          <CardContent>
            {data.open ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <Stat label="Side" value={data.open.side.toUpperCase()} />
                <Stat label="Notional" value={formatUsdc(data.open.notionalUsdc)} />
                <Stat label="Entry" value={`$${data.open.entryPrice.toFixed(0)}`} />
                <Stat
                  label="Held"
                  value={`${((Date.now() - data.open.openedAtMs) / 60_000).toFixed(1)}m`}
                />
                <Stat
                  label="P(↑) at open"
                  value={`${(data.open.openPredictUp * 100).toFixed(1)}%`}
                />
                <Stat label="Oracle" value={short(data.open.oracleId)} />
              </dl>
            ) : (
              <div className="text-muted text-sm py-6 text-center">
                No open position.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Recent decisions</span>
            <span className="text-xs text-muted normal-case">
              last {Math.min(data.recentDecisions.length, 25)}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <DecisionTable decisions={data.recentDecisions.slice(0, 25)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Closed paper positions</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {data.closed.length === 0 ? (
            <div className="text-muted text-sm py-6 text-center">
              No closed positions yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Closed</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Notional</TableHead>
                  <TableHead>Entry → Exit</TableHead>
                  <TableHead>PnL</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.closed.slice(0, 50).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-muted text-xs">
                      {new Date(c.closedAtMs).toLocaleTimeString()}
                    </TableCell>
                    <TableCell>{c.side.toUpperCase()}</TableCell>
                    <TableCell>{formatUsdc(c.notionalUsdc)}</TableCell>
                    <TableCell className="font-mono tabular-nums">
                      ${c.entryPrice.toFixed(0)} → ${c.exitPrice.toFixed(0)}
                    </TableCell>
                    <TableCell className={c.pnlUsdc >= 0 ? 'text-win' : 'text-loss'}>
                      {formatUsdc(c.pnlUsdc)}
                    </TableCell>
                    <TableCell className="text-xs text-muted truncate max-w-[14rem]">
                      {c.closeReason}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
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

function short(s: string): string {
  if (s.length < 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

function DecisionTable({ decisions }: { decisions: MarginLeverDecision[] }) {
  if (decisions.length === 0) {
    return (
      <div className="text-muted text-sm py-6 text-center">
        No decisions yet — strategy boots cold; first tick lands within{' '}
        <code className="font-mono text-[10px]">marginLeverTickMs</code>.
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>P(↑)</TableHead>
          <TableHead>|bias|</TableHead>
          <TableHead>Spot</TableHead>
          <TableHead>Reason</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {decisions.map((d, i) => (
          <TableRow key={`${d.ts}-${i}`}>
            <TableCell className="text-muted text-xs">
              {new Date(d.ts).toLocaleTimeString()}
            </TableCell>
            <TableCell>
              <Badge
                variant={
                  d.action.startsWith('open')
                    ? 'live'
                    : d.action === 'close'
                      ? 'warn'
                      : 'outline'
                }
                className="text-[10px]"
              >
                {d.action}
              </Badge>
            </TableCell>
            <TableCell>{(d.predictUpAtSpot * 100).toFixed(1)}%</TableCell>
            <TableCell>{(d.biasMagnitude * 100).toFixed(2)}%</TableCell>
            <TableCell>${d.spot.toFixed(0)}</TableCell>
            <TableCell className="text-xs text-muted truncate max-w-[18rem]">
              {d.reason}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
