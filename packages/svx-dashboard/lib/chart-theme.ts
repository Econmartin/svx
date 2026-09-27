import type { CSSProperties } from 'react';

/**
 * Shared chart tooltip styling — the same frosted material as our own
 * Tooltip and Menu (components/ui/popover.tsx), instead of each chart
 * library default. Spread onto a recharts <Tooltip>.
 */
export const chartTooltip: {
  contentStyle: CSSProperties;
  labelStyle: CSSProperties;
  itemStyle: CSSProperties;
  wrapperStyle: CSSProperties;
} = {
  contentStyle: {
    background: 'rgba(44, 44, 46, 0.86)',
    backdropFilter: 'blur(40px) saturate(190%)',
    WebkitBackdropFilter: 'blur(40px) saturate(190%)',
    border: '0.5px solid rgba(255, 255, 255, 0.12)',
    borderRadius: 10,
    boxShadow: '0 24px 64px -16px rgba(0, 0, 0, 0.85)',
    fontSize: 12,
    padding: '8px 10px',
    fontVariantNumeric: 'tabular-nums',
  },
  labelStyle: { color: '#8e8e93', marginBottom: 4, fontSize: 11.5 },
  itemStyle: { color: '#f5f5f7', padding: 0 },
  wrapperStyle: { outline: 'none', zIndex: 50 },
};
