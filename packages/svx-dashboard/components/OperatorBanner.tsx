/**
 * Slim banner shown on per-strategy pages so a first-time visitor knows
 * the dashboard is reading <em>one operator's</em> live activity, not a
 * service they're using themselves. Reinforces the single-operator framing
 * that keeps SVX out of securities-law territory.
 */

import Link from 'next/link';
import { User, GitFork } from '@phosphor-icons/react/dist/ssr';

interface OperatorBannerProps {
  /** Short operator address — display only. */
  address?: string;
  /** What this page is showing. */
  context: string;
}

const SHORT_ADDR = '0x73f4…d53c3';

export function OperatorBanner({ address, context }: OperatorBannerProps) {
  const displayed = address ?? SHORT_ADDR;
  return (
    <div
      className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 rounded-lg border border-border bg-surface/40 px-4 py-2.5 text-[12.5px]"
      role="note"
    >
      <div className="flex items-center gap-2 text-muted-strong">
        <User className="h-4 w-4 text-accent flex-shrink-0" weight="bold" />
        <span>
          <span className="text-muted">Operator:</span>{' '}
          <code className="font-mono text-fg/90">{displayed}</code> · {context}
        </span>
      </div>
      <a
        href="https://github.com/Econmartin/svx"
        target="_blank"
        rel="noreferrer"
        className="sm:ml-auto inline-flex items-center gap-1.5 text-accent hover:underline no-underline"
      >
        <GitFork className="h-3.5 w-3.5" />
        Fork the repo to run your own
      </a>
    </div>
  );
}
