'use client';

/**
 * Site-wide dismissible notice about the frozen Predict SVI feed. Styled
 * after the demo-day presenter's corner chip (bottom-right, accent
 * border). Dismissal persists in localStorage; bump the KEY suffix if the
 * message materially changes and should re-show for returning visitors.
 *
 * Remove this component (and its layout mount) once the upstream feeder
 * is live again.
 */

import { useEffect, useState } from 'react';

const KEY = 'svx-feed-notice-dismissed-v1';

export function FeedNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === null) setVisible(true);
    } catch {
      /* private mode etc. — just stay hidden */
    }
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl border border-accent/40 bg-bg/95 backdrop-blur px-4 py-3 shadow-lg text-sm">
      <div className="flex items-center justify-between gap-4 mb-1">
        <span className="font-mono text-accent">Predict feed status</span>
        <button
          aria-label="Dismiss notice"
          className="text-muted hover:text-fg text-base leading-none px-1 cursor-pointer"
          onClick={() => {
            try {
              localStorage.setItem(KEY, '1');
            } catch {
              /* ignore */
            }
            setVisible(false);
          }}
        >
          ×
        </button>
      </div>
      <p className="text-muted leading-snug">
        Predict&apos;s testnet price feed has been frozen since July 12: Sui&apos;s RPC
        deprecation stopped the upstream Block Scholes feeder, and the DeepBook / Mysten team is
        actively replacing it with a signed-oracle pipeline. Until fresh data returns, the bot
        evaluates signals and refuses them all via its staleness kill switch. Trading resumes
        automatically.{' '}
        <a
          className="text-accent hover:underline"
          href="https://github.com/blockscholes/sui-signed-oracle"
          target="_blank"
          rel="noopener noreferrer"
        >
          upstream work →
        </a>
      </p>
    </div>
  );
}
