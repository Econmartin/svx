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
          'inline-flex items-center gap-0.5 rounded-full bg-white/[0.06] p-[3px] h-9',
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
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2.5 sm:px-3 h-[30px] text-[13px] font-medium capitalize transition-[background-color,color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:pointer-events-none disabled:opacity-50',
        active
          ? 'bg-white/[0.12] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_3px_rgba(0,0,0,0.4)]'
          : 'text-muted hover:text-fg',
        className,
      )}
    >
      {children}
    </button>
  );
}
