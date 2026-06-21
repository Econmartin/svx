'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

interface ToggleGroupContextValue {
  value: string;
  onValueChange: (v: string) => void;
}

const ToggleGroupContext = React.createContext<ToggleGroupContextValue | null>(null);

export function ToggleGroup({
  value,
  onValueChange,
  className,
  children,
}: {
  value: string;
  onValueChange: (v: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <ToggleGroupContext.Provider value={{ value, onValueChange }}>
      <div
        role="group"
        className={cn(
          'inline-flex items-center gap-0.5 rounded-md border border-border bg-surface/70 p-0.5 h-8',
          className,
        )}
      >
        {children}
      </div>
    </ToggleGroupContext.Provider>
  );
}

export function ToggleGroupItem({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ctx = React.useContext(ToggleGroupContext);
  if (!ctx) throw new Error('ToggleGroupItem must be used inside ToggleGroup');
  const active = ctx.value === value;
  return (
    <button
      aria-pressed={active}
      // Network value is hydrated from localStorage in NetworkProvider, so
      // the server's default and the client's first render legitimately
      // differ. The mismatch only ever touches aria-pressed + className on
      // this toggle, never the API call, so silence the dev-mode warning.
      suppressHydrationWarning
      onClick={() => ctx.onValueChange(value)}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 h-7 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50',
        active
          ? 'bg-accent/15 text-accent'
          : 'text-muted hover:text-fg hover:bg-surface-elevated/60',
        className,
      )}
    >
      {children}
    </button>
  );
}
