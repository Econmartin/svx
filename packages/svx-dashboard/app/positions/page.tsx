'use client';

import { useCallback } from 'react';
import { api, formatPct, formatTime, formatUsdc, type TradeRecord } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';

function polyLegLabel(t: TradeRecord): string {
  if (!t.polyStatus) return '—';
  const out = t.polyOutcome ?? '?';
  const px = t.polyFillPrice != null ? `@${t.polyFillPrice.toFixed(3)}` : '';
  const sh = t.polyFilledShares != null ? `${t.polyFilledShares.toFixed(2)} sh` : '';
  if (t.polyStatus === 'filled') return `${out.toUpperCase()} ${sh} ${px}`.trim();
  if (t.polyStatus === 'partial') return `partial ${out} ${sh} ${px}`.trim();
  if (t.polyStatus === 'failed') return 'failed';
  return t.polyStatus;
}

export default function PositionsPage() {
  const { data: open } = usePolling(useCallback(() => api.positionsOpen(), []), 10_000);
  const { data: closed } = usePolling(useCallback(() => api.positionsClosed(500), []), 30_000);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-semibold mb-3">Open positions</h1>
        <div className="rounded border border-border bg-surface overflow-x-auto">
          <table className="font-mono">
            <thead>
              <tr>
                <th>Time</th>
                <th>Mode</th>
                <th>Strike</th>
                <th>Dir</th>
                <th>Qty</th>
                <th>Cost px</th>
                <th>Cost $</th>
                <th>Poly leg</th>
                <th>Expiry</th>
              </tr>
            </thead>
            <tbody>
              {(open ?? []).map((t) => (
                <tr key={t.id}>
                  <td className="text-muted">{formatTime(t.timestampMs)}</td>
                  <td className="text-xs">{t.mode}</td>
                  <td>${t.strike.toFixed(0)}</td>
                  <td>{t.direction}</td>
                  <td>{formatUsdc(t.quantityDusdc)}</td>
                  <td>{formatPct(t.costPrice, 2)}</td>
                  <td>{formatUsdc(t.costUsdc)}</td>
                  <td className="text-xs">{polyLegLabel(t)}</td>
                  <td className="text-muted text-xs">{formatTime(t.expiryMs)}</td>
                </tr>
              ))}
              {!open?.length && (
                <tr>
                  <td colSpan={9} className="text-center text-muted py-4">
                    No open positions.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-3">Closed positions</h2>
        <div className="rounded border border-border bg-surface overflow-x-auto">
          <table className="font-mono">
            <thead>
              <tr>
                <th>Time</th>
                <th>Strike</th>
                <th>Dir</th>
                <th>Qty</th>
                <th>Cost</th>
                <th>Payout</th>
                <th>PnL</th>
              </tr>
            </thead>
            <tbody>
              {(closed ?? []).map((t) => (
                <tr key={t.id} className={(t.pnlUsdc ?? 0) >= 0 ? 'text-win' : 'text-loss'}>
                  <td className="text-muted">{formatTime(t.timestampMs)}</td>
                  <td>${t.strike.toFixed(0)}</td>
                  <td>{t.direction}</td>
                  <td>{formatUsdc(t.quantityDusdc)}</td>
                  <td>{formatUsdc(t.costUsdc)}</td>
                  <td>{formatUsdc(t.payoutUsdc)}</td>
                  <td>{formatUsdc(t.pnlUsdc)}</td>
                </tr>
              ))}
              {!closed?.length && (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-4">
                    No closed positions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
