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
  // Live BTC spot for ITM/OTM badges on open rows. status is already exposed
  // by the bot (same one the overview polls). 15s is plenty; the moneyness
  // call only cares when spot moves through a strike.
  const { data: status } = usePolling(
    useCallback(() => client.status(), [client]),
    15_000,
  );
  const spot = status?.spotBtc ?? null;

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
            <OpenTable open={openAll} isMainnet={isMainnet} spot={spot} />
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
  spot,
}: {
  open: TradeRecord[];
  isMainnet: boolean;
  spot: number | null;
}) {
  // Pre-filtered upstream — rows here are all genuinely open. On testnet we
  // get every settled=0 row; on mainnet we get rows with an unsettled Poly
  // fill OR an open HL leg.
  if (open.length === 0) {
    return <div className="text-muted text-sm py-8 text-center">No open positions.</div>;
  }
  if (!isMainnet) {
    // Testnet Predict view.
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Opened</TableHead>
            <TableHead>Market</TableHead>
            <TableHead>Our bet</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Expires</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {open.map((t) => {
            const m = predictMoneyness(t, spot);
            return (
              <TableRow key={t.id}>
                <TableCell className="text-muted text-xs whitespace-nowrap">
                  {formatTime(t.timestampMs)}
                </TableCell>
                <TableCell className="text-[13px]">
                  <MarketLabel asset={t.underlyingAsset} strike={t.strike} expiryMs={t.expiryMs} />
                </TableCell>
                <TableCell className="text-[13px]">
                  <PredictBetLabel
                    direction={t.direction}
                    quantityDusdc={t.quantityDusdc}
                    costPrice={t.costPrice}
                    mode={t.mode}
                  />
                </TableCell>
                <TableCell className="font-mono text-[12.5px] tabular-nums">
                  {formatUsdc(t.costUsdc)} dUSDC
                </TableCell>
                <TableCell>
                  <MoneynessBadge m={m} />
                </TableCell>
                <TableCell className="text-muted text-xs whitespace-nowrap">
                  <TimeToExpiry ms={t.expiryMs} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }
  // Mainnet: Poly + HL side-by-side, both rendered in plain English.
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Opened</TableHead>
          <TableHead>Market</TableHead>
          <TableHead>Poly leg</TableHead>
          <TableHead>HL hedge</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Expires</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {open.map((t) => {
          const strategy = t.strategy ?? 'poly_arb';
          const hasPoly = t.polyStatus === 'filled' && !t.polySettled;
          const hasHl = t.hlStatus === 'open';
          const m = polyMoneyness(t, spot);
          return (
            <TableRow key={t.id}>
              <TableCell className="text-muted text-xs whitespace-nowrap">
                <div>{formatTime(t.timestampMs)}</div>
                <div className="mt-1">
                  <Badge variant={strategy === 'vol_arb' ? 'warn' : 'live'}>{strategy}</Badge>
                </div>
              </TableCell>
              <TableCell className="text-[13px]">
                {t.strike > 0 ? (
                  <MarketLabel asset={t.underlyingAsset} strike={t.strike} expiryMs={t.expiryMs} />
                ) : (
                  <span className="text-muted">—</span>
                )}
              </TableCell>
              <TableCell className="text-[13px]">
                {hasPoly ? (
                  <PolyBetLabel
                    outcome={t.polyOutcome}
                    shares={t.polyFilledShares}
                    fillPrice={t.polyFillPrice}
                    costUsdc={t.polyCostUsdc}
                    strike={t.strike}
                    asset={t.underlyingAsset}
                  />
                ) : (
                  <span className="text-muted">—</span>
                )}
              </TableCell>
              <TableCell className="text-[13px]">
                {hasHl ? (
                  <HlLegLabel
                    side={t.hlSide}
                    size={t.hlSize}
                    openPrice={t.hlOpenPrice}
                    asset={t.hlAsset ?? 'BTC'}
                  />
                ) : (
                  <span className="text-muted">—</span>
                )}
              </TableCell>
              <TableCell>{hasPoly ? <MoneynessBadge m={m} /> : <span className="text-muted text-xs">—</span>}</TableCell>
              <TableCell className="text-muted text-xs whitespace-nowrap">
                {t.expiryMs > 0 ? <TimeToExpiry ms={t.expiryMs} /> : '—'}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Row helpers — the goal is that a reader who's never seen Polymarket can
// look at any row and answer "what is this market" and "what did we buy".
// ────────────────────────────────────────────────────────────────────────────

function MarketLabel({
  asset,
  strike,
  expiryMs,
}: {
  asset: string;
  strike: number;
  expiryMs: number;
}) {
  const strikeK = strike >= 1000 ? `${(strike / 1000).toFixed(strike >= 10000 ? 0 : 1)}k` : `${strike}`;
  return (
    <div className="leading-tight">
      <div className="font-semibold whitespace-nowrap">
        {asset} ≥ ${strikeK}
      </div>
      <div className="text-[11px] text-muted whitespace-nowrap">
        {expiryMs > 0 ? new Date(expiryMs).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }) : '—'}
      </div>
    </div>
  );
}

function PredictBetLabel({
  direction,
  quantityDusdc,
  costPrice,
  mode,
}: {
  direction: 'up' | 'down';
  quantityDusdc: number;
  costPrice: number;
  mode: 'live' | 'paper';
}) {
  const dirLabel = direction === 'up' ? 'UP' : 'DOWN';
  return (
    <div className="leading-tight">
      <div className="whitespace-nowrap">
        <span className={direction === 'up' ? 'text-win font-semibold' : 'text-loss font-semibold'}>
          {dirLabel}
        </span>
        <span className="text-muted"> · </span>
        <span className="font-mono">{formatUsdc(quantityDusdc)}</span>
        <span className="text-muted"> pays $1 if right</span>
      </div>
      <div className="text-[11px] text-muted">
        entry {formatPct(costPrice, 2)} · <Badge variant={mode === 'live' ? 'live' : 'outline'}>{mode}</Badge>
      </div>
    </div>
  );
}

function PolyBetLabel({
  outcome,
  shares,
  fillPrice,
  costUsdc,
  strike,
  asset,
}: {
  outcome?: 'yes' | 'no';
  shares?: number;
  fillPrice?: number;
  costUsdc?: number;
  strike: number;
  asset: string;
}) {
  if (!outcome) return <span className="text-muted">—</span>;
  const isYes = outcome === 'yes';
  const strikeK = strike >= 1000 ? `${(strike / 1000).toFixed(strike >= 10000 ? 0 : 1)}k` : `${strike}`;
  // Plain-English claim: what would need to be true for this share to pay $1.
  const claim = isYes
    ? `${asset} ≥ $${strikeK} at expiry`
    : `${asset} < $${strikeK} at expiry`;
  return (
    <div className="leading-tight">
      <div className="whitespace-nowrap">
        <span className={isYes ? 'text-win font-semibold' : 'text-loss font-semibold'}>
          {isYes ? 'YES' : 'NO'}
        </span>
        <span className="text-muted"> · </span>
        <span className="font-mono">{shares?.toFixed(2) ?? '—'} sh</span>
        <span className="text-muted"> @ </span>
        <span className="font-mono">${fillPrice?.toFixed(3) ?? '—'}</span>
      </div>
      <div className="text-[11px] text-muted">
        pays $1 if {claim} · cost {formatUsdc(costUsdc)} pUSD
      </div>
    </div>
  );
}

function HlLegLabel({
  side,
  size,
  openPrice,
  asset,
}: {
  side?: 'long' | 'short';
  size?: number;
  openPrice?: number;
  asset: string;
}) {
  if (!side || !size || !openPrice) return <span className="text-muted">—</span>;
  const notional = size * openPrice;
  return (
    <div className="leading-tight">
      <div className="whitespace-nowrap">
        <span className={side === 'long' ? 'text-win font-semibold' : 'text-loss font-semibold'}>
          {side.toUpperCase()}
        </span>
        <span className="text-muted"> · </span>
        <span className="font-mono">{size.toFixed(5)} {asset}</span>
      </div>
      <div className="text-[11px] text-muted">
        entry ${openPrice.toFixed(0)} · ${notional.toFixed(2)} notional
      </div>
    </div>
  );
}

interface Moneyness {
  status: 'itm' | 'otm' | 'unknown';
  label: string;
  delta?: string;
}

/** Predict binary: direction=up → wins if spot > strike; down → wins if spot ≤ strike. */
function predictMoneyness(t: TradeRecord, spot: number | null): Moneyness {
  if (spot == null || t.strike <= 0) return { status: 'unknown', label: 'no spot' };
  const winning = t.direction === 'up' ? spot > t.strike : spot <= t.strike;
  const diff = spot - t.strike;
  const delta = `${diff >= 0 ? '+' : ''}$${Math.abs(diff).toFixed(0)} vs strike`;
  return {
    status: winning ? 'itm' : 'otm',
    label: winning ? 'ITM' : 'OTM',
    delta,
  };
}

/** Polymarket YES binary is "asset ≥ strike at expiry?". YES wins iff spot ≥ strike. */
function polyMoneyness(t: TradeRecord, spot: number | null): Moneyness {
  if (spot == null || t.strike <= 0 || !t.polyOutcome) return { status: 'unknown', label: 'no spot' };
  const yesWins = spot >= t.strike;
  const winning = t.polyOutcome === 'yes' ? yesWins : !yesWins;
  const diff = spot - t.strike;
  const delta = `${diff >= 0 ? '+' : ''}$${Math.abs(diff).toFixed(0)} vs strike`;
  return {
    status: winning ? 'itm' : 'otm',
    label: winning ? 'ITM' : 'OTM',
    delta,
  };
}

function MoneynessBadge({ m }: { m: Moneyness }) {
  if (m.status === 'unknown') {
    return <span className="text-muted text-xs">{m.label}</span>;
  }
  return (
    <div className="leading-tight">
      <Badge variant={m.status === 'itm' ? 'live' : 'warn'}>{m.label}</Badge>
      {m.delta && (
        <div className="text-[11px] text-muted mt-0.5 font-mono tabular-nums">{m.delta}</div>
      )}
    </div>
  );
}

function TimeToExpiry({ ms }: { ms: number }) {
  const remaining = ms - Date.now();
  if (remaining <= 0) {
    return <span className="text-loss">expired</span>;
  }
  const mins = Math.floor(remaining / 60_000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  let label: string;
  if (days > 0) label = `in ${days}d ${hrs % 24}h`;
  else if (hrs > 0) label = `in ${hrs}h ${mins % 60}m`;
  else label = `in ${mins}m`;
  return (
    <div className="leading-tight">
      <div>{label}</div>
      <div className="text-[11px] text-muted">
        {new Date(ms).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </div>
    </div>
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
