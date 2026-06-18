'use client';

import { Badge } from '@/components/ui/badge';
import { Pause, Broadcast, Flask } from '@phosphor-icons/react';

interface Props {
  paused: boolean;
  reason?: string;
  live: boolean;
}

export function StatusBadge({ paused, reason, live }: Props) {
  if (paused) {
    return (
      <Badge variant="paused" className="gap-1.5">
        <Pause className="h-3 w-3" />
        paused
        {reason ? <span className="opacity-70">· {reason}</span> : null}
      </Badge>
    );
  }
  return (
    <Badge variant={live ? 'live' : 'default'} className="gap-1.5">
      {live ? (
        <Broadcast className="h-3 w-3 animate-pulse" />
      ) : (
        <Flask className="h-3 w-3" />
      )}
      {live ? 'live' : 'paper'}
    </Badge>
  );
}
