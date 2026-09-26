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

export function StatRow({ stats, cols = 4 }: { stats: Stat[]; cols?: 3 | 4 | 5 }) {
  const gridCls =
    cols === 5
      ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5'
      : cols === 3
        ? 'grid-cols-2 sm:grid-cols-3'
        : 'grid-cols-2 sm:grid-cols-4';
  return (
    <dl className={cn('grid gap-3 sm:gap-4', gridCls)}>
      {stats.map((s) => {
        const tone = s.tone ?? 'default';
        return (
          <div
            key={s.label}
            className="group relative overflow-hidden rounded-2xl border border-border bg-surface/75 px-5 py-4 shadow-card backdrop-blur-xl transition-[background-color,border-color] duration-200 hover:border-border-strong hover:bg-surface"
          >
            <dt className="text-[13px] text-muted font-medium tracking-[-0.005em]">
              {s.label}
            </dt>
            <dd
              className={cn(
                'text-[28px] leading-[1.15] font-semibold tracking-[-0.025em] mt-1 tabular-nums',
                TONE_VALUE[tone],
              )}
            >
              {s.value}
            </dd>
            {s.hint && (
              <div className="text-[12px] text-muted/90 mt-1.5 leading-snug">{s.hint}</div>
            )}
          </div>
        );
      })}
    </dl>
  );
}
