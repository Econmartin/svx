'use client';

interface Props {
  paused: boolean;
  reason?: string;
  live: boolean;
}

export function StatusBadge({ paused, reason, live }: Props) {
  if (paused) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-loss/10 text-loss px-3 py-1 text-xs font-mono">
        <span className="w-2 h-2 rounded-full bg-loss" /> paused {reason ? `· ${reason}` : ''}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-win/10 text-win px-3 py-1 text-xs font-mono">
      <span className="w-2 h-2 rounded-full bg-win animate-pulse" /> {live ? 'live' : 'paper'}
    </span>
  );
}
