'use client';

/**
 * Bank gauge: what live trading booked since it began vs what the switched-on
 * strategies' scores said those same trades were worth, with the band a
 * normal run of luck stays inside — so a drop from +$110 to +$20 can be read
 * as "bad run" or "something's wrong". Plus a check that the account balance
 * moves with the ledger. Source: GET /strategy/bank-gauge.
 */

import { useCallback } from 'react';
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from 'recharts';
import { useApiClient } from '@/lib/network-context';
import { usePolling } from '@/lib/usePolling';
import { formatRelative, type BankGauge } from '@/lib/api';
import { chartTooltip } from '@/lib/chart-theme';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/cn';

const usd = (x: number) => `${x >= 0 ? '+' : '−'}$${Math.abs(x).toFixed(2)}`;

function verdict(g: BankGauge): { text: string; tone: 'win' | 'loss' | 'muted' } {
  const { z, luckUsdc, trades } = g.expected;
  if (!trades || z == null) return { text: 'No settled live trades to judge yet.', tone: 'muted' };
  const a = Math.abs(z);
  const dir = luckUsdc >= 0 ? 'ahead of' : 'behind';
  if (a < 1) return { text: `Normal swing — ${usd(luckUsdc).replace(/^[+−]/, '')} ${dir} expectation.`, tone: 'muted' };
  if (a < 2)
    return luckUsdc < 0
      ? { text: 'Cold run, still inside normal swing. Nothing says the strategies broke.', tone: 'muted' }
      : { text: 'Hot run, inside normal swing. Expect some of it to give back.', tone: 'win' };
  return luckUsdc < 0
    ? { text: 'Further behind than bad luck usually explains — worth a look at the strategies.', tone: 'loss' }
    : { text: 'Well ahead of what the scores predict — lucky, or the edge is bigger than scored.', tone: 'win' };
}

export function BankGaugeCard() {
  const client = useApiClient();
  const { data: g, error } = usePolling(useCallback(() => client.bankGauge(), [client]), 60_000);

  if (!g) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Ahead or behind</CardTitle>
          <CardDescription>{error ? "Couldn't reach the bot." : 'Loading…'}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const v = verdict(g);
  const chart = [
    { i: 0, actual: 0, expected: 0, band: [0, 0] as [number, number] },
    ...g.series.map((p, idx) => ({
      i: idx + 1,
      actual: p.actual,
      expected: p.expected,
      band: [p.expected - 2 * p.sigma, p.expected + 2 * p.sigma] as [number, number],
    })),
  ];
  const drift = g.bank.driftUsdc;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ahead or behind</CardTitle>
        <CardDescription>
          Live trades since {g.liveStartMs ? formatRelative(g.liveStartMs) : '—'}, against what each strategy&apos;s
          score said they were worth when placed. The shaded band is ±2σ — where normal luck keeps you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <p
          className={cn(
            'text-[15px] font-medium',
            v.tone === 'win' ? 'text-win' : v.tone === 'loss' ? 'text-loss' : 'text-fg',
          )}
        >
          {v.text}
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat
            label="Booked"
            value={usd(g.ledger.pnlUsdc)}
            tone={g.ledger.pnlUsdc >= 0 ? 'win' : 'loss'}
            hint={`${g.ledger.settled} settled · ${g.ledger.open} open ($${g.ledger.openCostUsdc.toFixed(2)} out)`}
          />
          <Stat
            label="Strategies expected"
            value={usd(g.expected.pnlUsdc)}
            hint={`over the ${g.expected.trades} scored trades`}
          />
          <Stat
            label="Luck"
            value={usd(g.expected.luckUsdc)}
            tone={g.expected.luckUsdc >= 0 ? 'win' : 'loss'}
            hint={
              g.expected.z != null
                ? `${g.expected.z >= 0 ? '+' : '−'}${Math.abs(g.expected.z).toFixed(1)}σ · 1σ = $${g.expected.sigmaUsdc.toFixed(2)}`
                : '—'
            }
          />
          <Stat
            label="Bank vs ledger"
            value={drift == null ? '—' : Math.abs(drift) < 0.5 ? 'Matches' : `${usd(drift)} off`}
            tone={drift == null ? undefined : Math.abs(drift) < 0.5 ? 'win' : 'loss'}
            hint={
              g.bank.baselineAtMs
                ? `checked since ${formatRelative(g.bank.baselineAtMs)}${g.bank.balanceUsdc != null ? ` · $${g.bank.balanceUsdc.toFixed(2)} now` : ''}`
                : 'starts at the next balance read'
            }
          />
        </div>

        {g.series.length > 1 && (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chart} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="i"
                  minTickGap={40}
                  tick={{ fontSize: 11, fill: '#8e8e93' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tickFormatter={(x: number) => `${x < 0 ? '−' : ''}$${Math.abs(x)}`}
                  tick={{ fontSize: 11, fill: '#8e8e93' }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                />
                <ReferenceLine y={0} stroke="rgba(142,142,147,0.4)" />
                <Area dataKey="band" stroke="none" fill="#8e8e93" fillOpacity={0.15} isAnimationActive={false} />
                <Line
                  dataKey="expected"
                  stroke="#8e8e93"
                  strokeDasharray="4 4"
                  dot={false}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
                <Line dataKey="actual" stroke="#30d158" dot={false} strokeWidth={2} isAnimationActive={false} />
                <Tooltip
                  {...chartTooltip}
                  labelFormatter={(i) => `After trade ${i}`}
                  formatter={(val, name) =>
                    name === 'band'
                      ? [`${usd((val as number[])[0]!)} to ${usd((val as number[])[1]!)}`, 'normal range']
                      : [usd(val as number), name === 'actual' ? 'booked' : 'expected']
                  }
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        {g.unscored.trades > 0 && (
          <p className="text-[13px] text-muted">
            Also {g.unscored.trades} live trade{g.unscored.trades === 1 ? '' : 's'} from strategies off the
            switchboard ({usd(g.unscored.pnlUsdc)}), counted in Booked but not in the comparison.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: 'win' | 'loss' }) {
  return (
    <div>
      <div className="text-[12px] text-muted">{label}</div>
      <div
        className={cn(
          'font-mono text-[20px] font-semibold',
          tone === 'win' ? 'text-win' : tone === 'loss' ? 'text-loss' : 'text-fg',
        )}
      >
        {value}
      </div>
      <div className="text-[12px] text-muted">{hint}</div>
    </div>
  );
}
