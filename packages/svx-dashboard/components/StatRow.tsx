'use client';

import { ReactNode } from 'react';

interface Stat {
  label: string;
  value: ReactNode;
  hint?: string;
}

export function StatRow({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
      {stats.map((s) => (
        <div key={s.label} className="rounded border border-border bg-surface px-4 py-3">
          <div className="text-xs uppercase tracking-wider text-muted">{s.label}</div>
          <div className="text-xl font-mono mt-1 tabular-nums">{s.value}</div>
          {s.hint && <div className="text-xs text-muted mt-0.5">{s.hint}</div>}
        </div>
      ))}
    </div>
  );
}
