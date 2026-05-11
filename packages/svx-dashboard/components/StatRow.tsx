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
    <div className={cn('grid gap-3', gridCls)}>
      {stats.map((s) => (
        <div
          key={s.label}
          className="group rounded-lg border border-border bg-surface px-4 py-3 transition-colors hover:border-border-strong"
        >
          <div className="text-xs uppercase tracking-wider text-muted font-medium">
            {s.label}
          </div>
          <div
            className={cn(
              'text-2xl font-mono mt-1 tabular-nums',
              TONE_VALUE[s.tone ?? 'default'],
            )}
          >
            {s.value}
          </div>
          {s.hint && <div className="text-xs text-muted mt-1">{s.hint}</div>}
        </div>
      ))}
    </div>
  );
}
