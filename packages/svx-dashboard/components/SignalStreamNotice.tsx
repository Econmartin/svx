'use client';

/**
 * Dated idle banner for the cross-venue signal stream.
 *
 * The signals exhibit renders whatever the ledger holds — which froze on
 * 2026-07-24 when the V1 feed died, and stays sparse on V2 because most of
 * its markets cycle in minutes and have no Polymarket twin. Without a date
 * on the page, week-old rows read as live output (the exact complaint that
 * prompted this: "signals still 10 days old"). This banner states the last
 * signal's age whenever the stream has been quiet for over 6 hours, and
 * points at the exhibit that IS live.
 */

import { formatRelative } from '@/lib/api';

const IDLE_AFTER_MS = 6 * 3600_000;

export function SignalStreamNotice({
  latestSignalMs,
}: {
  /** Timestamp of the newest signal row, or undefined while loading / empty. */
  latestSignalMs: number | undefined;
}) {
  if (latestSignalMs == null) return null;
  const idleMs = Date.now() - latestSignalMs;
  if (idleMs < IDLE_AFTER_MS) return null;
  const idleDays = Math.floor(idleMs / (24 * 3600_000));
  return (
    <div className="rounded border border-warn/40 bg-warn/10 px-4 py-3 text-[13px] text-warn leading-relaxed">
      <strong>Stream idle — newest signal is {formatRelative(latestSignalMs)}</strong>
      {idleDays >= 1 && ` (${idleDays} day${idleDays === 1 ? '' : 's'})`}. Cross-venue
      signals need a Predict market with a Polymarket twin; the rows below are the
      historical audit trail, not live output. The live measurement stream is the{' '}
      <strong>Board vs model vs realized</strong> card on Overview.
    </div>
  );
}
