'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Segmented control (HIG): a recessed track with one raised thumb that
 * slides to the selected segment. Keyboard: arrow keys move the selection,
 * the way a native NSSegmentedControl / UISegmentedControl does.
 */
interface ToggleGroupContextValue {
  value: string;
  onValueChange: (v: string) => void;
  register: (value: string, el: HTMLButtonElement | null) => void;
}

const ToggleGroupContext = React.createContext<ToggleGroupContextValue | null>(null);

export function ToggleGroup({
  value,
  onValueChange,
  className,
  children,
  'aria-label': ariaLabel,
}: {
  value: string;
  onValueChange: (v: string) => void;
  className?: string;
  children: React.ReactNode;
  'aria-label'?: string;
}) {
  const items = React.useRef(new Map<string, HTMLButtonElement>());
  const [thumb, setThumb] = React.useState<{ x: number; w: number } | null>(null);

  const measure = React.useCallback(() => {
    const el = items.current.get(value);
    if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
  }, [value]);

  React.useLayoutEffect(measure, [measure]);
  React.useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const register = React.useCallback((v: string, el: HTMLButtonElement | null) => {
    if (el) items.current.set(v, el);
    else items.current.delete(v);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const values = [...items.current.keys()];
    const i = values.indexOf(value);
    const next = values[(i + (e.key === 'ArrowRight' ? 1 : values.length - 1)) % values.length];
    if (next) {
      onValueChange(next);
      items.current.get(next)?.focus();
    }
    e.preventDefault();
  };

  return (
    <ToggleGroupContext.Provider value={{ value, onValueChange, register }}>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className={cn(
          'relative inline-flex items-center rounded-[10px] bg-white/[0.07] p-[2px] h-8 shadow-[inset_0_0.5px_0_rgba(0,0,0,0.4)]',
          className,
        )}
      >
        {thumb && (
          <span
            aria-hidden
            className="absolute top-[2px] bottom-[2px] left-0 rounded-[8px] bg-[#636366] shadow-[0_1px_2px_rgba(0,0,0,0.45),inset_0_0.5px_0_rgba(255,255,255,0.18)] transition-[transform,width] duration-300 ease-[cubic-bezier(0.3,1.2,0.4,1)]"
            style={{ transform: `translateX(${thumb.x - 2}px)`, width: thumb.w, marginLeft: 2 }}
          />
        )}
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
  const { register } = ctx;
  const ref = React.useCallback((el: HTMLButtonElement | null) => register(value, el), [register, value]);
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={active}
      tabIndex={active ? 0 : -1}
      // Network value is hydrated from localStorage in NetworkProvider, so
      // the server's default and the client's first render legitimately
      // differ. The mismatch only ever touches aria-checked + className on
      // this control, never the API call, so silence the dev-mode warning.
      suppressHydrationWarning
      onClick={() => ctx.onValueChange(value)}
      className={cn(
        'relative z-[1] inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] px-3 h-7 text-[13px] font-medium capitalize transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info/70 disabled:pointer-events-none disabled:opacity-50',
        active ? 'text-fg' : 'text-muted hover:text-muted-strong',
        className,
      )}
    >
      {children}
    </button>
  );
}
