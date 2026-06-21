'use client';

import { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface Stat {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'win' | 'loss' | 'warn';
}

const TONE_VALUE: Record<NonNullable<Stat['tone']>, string> = {
  default: 'text-white',
  win: 'text-win',
  loss: 'text-loss',
  warn: 'text-warn',
};

const TONE_RAIL: Record<NonNullable<Stat['tone']>, string> = {
  default: 'bg-border-strong/60',
  win: 'bg-win/70',
  loss: 'bg-loss/70',
  warn: 'bg-warn/70',
};

export function StatRow({ stats, cols = 4 }: { stats: Stat[]; cols?: 3 | 4 | 5 }) {
  const gridCls =
    cols === 5
      ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'
      : cols === 3
        ? 'grid-cols-2 sm:grid-cols-3'
        : 'grid-cols-2 sm:grid-cols-4';
  return (
    <dl className={cn('grid gap-3', gridCls)}>
      {stats.map((s) => {
        const tone = s.tone ?? 'default';
        return (
          <div
            key={s.label}
            className="group relative overflow-hidden rounded-md border border-border bg-surface/80 px-4 py-3.5 transition-colors hover:border-border-strong hover:bg-surface"
          >
            {/* Tone rail — quietly colors the tile's edge in win/loss/warn
                states so a row of numbers reads at a glance without
                requiring color comprehension on every digit. */}
            <span
              aria-hidden
              className={cn(
                'absolute left-0 top-0 bottom-0 w-px transition-colors',
                TONE_RAIL[tone],
              )}
            />
            <dt className="text-[10.5px] uppercase tracking-[0.12em] text-muted font-medium">
              {s.label}
            </dt>
            <dd
              className={cn(
                'text-[22px] leading-tight font-mono font-medium mt-1.5 tabular-nums',
                TONE_VALUE[tone],
              )}
            >
              {s.value}
            </dd>
            {s.hint && (
              <div className="text-[11px] text-muted/90 mt-1 leading-snug">
                {s.hint}
              </div>
            )}
          </div>
        );
      })}
    </dl>
  );
}
