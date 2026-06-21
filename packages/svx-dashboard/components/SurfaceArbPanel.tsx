'use client';

/**
 * Arbitrage-free diagnostics panel for the /surface page.
 *
 * Three Gatheral-style checks against the live SVI:
 *   1. Butterfly  — implied density g(k) must stay ≥ 0 at every strike.
 *   2. Wing       — Lee's b·(1+|ρ|) ≤ 4/T at the surface's expiry.
 *   3. Calendar   — optional, compared against the next-longest oracle.
 *
 * Each check renders a coloured badge + one-line explainer. When the
 * butterfly check fails we also draw a tiny spark-bar of the per-strike
 * density so the operator can see which wing is breaking.
 *
 * Diagnostics only — never a trading gate. The bot still trades on a
 * red surface; the panel just flags that the operator should look.
 */

import type { SurfaceArbReport, SurfacePoint } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, WarningCircle, XCircle } from '@phosphor-icons/react';

interface Props {
  arb: SurfaceArbReport;
  points: SurfacePoint[];
}

type Tone = 'ok' | 'warn' | 'fail';

export function SurfaceArbPanel({ arb, points }: Props) {
  const calendar = arb.calendar;

  const butterflyTone: Tone = arb.butterfly.ok ? 'ok' : 'fail';
  const wingTone: Tone = arb.wing.ok ? 'ok' : 'fail';
  const calendarTone: Tone | null = calendar
    ? calendar.ok
      ? 'ok'
      : 'fail'
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Arbitrage-free checks
          <OverallBadge
            tones={[butterflyTone, wingTone, ...(calendarTone ? [calendarTone] : [])]}
          />
        </CardTitle>
        <p className="text-xs text-muted mt-0.5 leading-relaxed">
          Gatheral-style validators run against the live SVI parameters every
          time the page polls. Diagnostics only — surface points still render
          regardless; this panel just flags when the surface stops being
          arbitrage-free under standard no-arb conditions.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <CheckRow
          tone={butterflyTone}
          title="Butterfly density"
          summary={
            arb.butterfly.ok
              ? `g(k) ≥ 0 across all ${points.length} strikes — implied density is non-negative.`
              : `Worst g(k) = ${arb.butterfly.worst.toExponential(2)} (negative) — implied density goes negative in the wings.`
          }
          formula="(1 − k·w'/(2w))² − (w'/2)²·(1/w + 1/4) + w''/2  ≥  0"
        >
          {!arb.butterfly.ok && <DensityBars points={points} />}
        </CheckRow>

        <CheckRow
          tone={wingTone}
          title="Wing no-arb (Lee)"
          summary={
            arb.wing.ok
              ? `b·(1+|ρ|) = ${arb.wing.actual.toFixed(4)} ≤ ${arb.wing.bound.toFixed(2)} = 4/T — large-strike butterflies are safe.`
              : `b·(1+|ρ|) = ${arb.wing.actual.toFixed(4)} > ${arb.wing.bound.toFixed(2)} = 4/T — large-strike butterfly arb possible.`
          }
          formula="b · (1 + |ρ|)  ≤  4 / T"
        />

        {calendar ? (
          <CheckRow
            tone={calendarTone!}
            title="Calendar no-arb"
            summary={
              calendar.ok
                ? `Total variance is monotone non-decreasing in T against the next-longest oracle (worst gap = ${calendar.worstDeficit.toFixed(5)} at k=${calendar.worstK.toFixed(3)}).`
                : `Found w(k, T_short) > w(k, T_long) by ${(-calendar.worstDeficit).toFixed(5)} at k=${calendar.worstK.toFixed(3)} — calendar arb possible.`
            }
            formula="w(k, T₂)  ≥  w(k, T₁)   ∀ k, T₂ > T₁"
          />
        ) : (
          <CheckRow
            tone="warn"
            title="Calendar no-arb"
            summary="No longer-expiry oracle currently active — calendar check skipped."
            formula="w(k, T₂)  ≥  w(k, T₁)   ∀ k, T₂ > T₁"
          />
        )}
      </CardContent>
    </Card>
  );
}

function OverallBadge({ tones }: { tones: Tone[] }) {
  const worst: Tone = tones.includes('fail')
    ? 'fail'
    : tones.includes('warn')
      ? 'warn'
      : 'ok';
  const cls =
    worst === 'ok'
      ? 'border-win/40 bg-win/10 text-win'
      : worst === 'warn'
        ? 'border-warn/40 bg-warn/10 text-warn'
        : 'border-loss/40 bg-loss/10 text-loss';
  const label = worst === 'ok' ? 'arb-free' : worst === 'warn' ? 'incomplete' : 'violation';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono ${cls}`}
    >
      {label}
    </span>
  );
}

function CheckRow({
  tone,
  title,
  summary,
  formula,
  children,
}: {
  tone: Tone;
  title: string;
  summary: string;
  formula: string;
  children?: React.ReactNode;
}) {
  const Icon = tone === 'ok' ? CheckCircle : tone === 'warn' ? WarningCircle : XCircle;
  const iconCls = tone === 'ok' ? 'text-win' : tone === 'warn' ? 'text-warn' : 'text-loss';
  return (
    <div className="rounded-lg border border-border/70 bg-surface/40 p-3 space-y-2">
      <div className="flex items-start gap-2.5">
        <Icon className={`h-5 w-5 flex-shrink-0 mt-0.5 ${iconCls}`} weight="fill" />
        <div className="flex-1 space-y-1.5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-medium text-fg text-[14px]">{title}</span>
            <code className="font-mono text-[11px] text-muted">{formula}</code>
          </div>
          <p className="text-[13px] text-muted-strong/95 leading-relaxed">{summary}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

function DensityBars({ points }: { points: SurfacePoint[] }) {
  const valid = points.filter((p): p is SurfacePoint & { density: number } => p.density != null);
  if (valid.length === 0) return null;
  const maxAbs = Math.max(...valid.map((p) => Math.abs(p.density)), 1e-9);
  return (
    <div
      className="mt-2 flex items-end gap-[1px] h-10 w-full bg-surface-elevated/30 rounded px-1 py-0.5"
      aria-label="Per-strike butterfly density spark-bar"
    >
      {valid.map((p, i) => {
        const h = Math.min(100, (Math.abs(p.density) / maxAbs) * 100);
        const neg = p.density < 0;
        return (
          <div
            key={i}
            className={`flex-1 ${neg ? 'bg-loss' : 'bg-win/70'}`}
            style={{
              height: `${Math.max(2, h)}%`,
              alignSelf: neg ? 'flex-end' : 'flex-end',
              opacity: neg ? 1 : 0.7,
            }}
            title={`k=${(p.k ?? 0).toFixed(3)}  g=${p.density.toExponential(2)}`}
          />
        );
      })}
    </div>
  );
}
