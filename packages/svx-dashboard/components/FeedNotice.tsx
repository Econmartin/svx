'use client';

/**
 * Site-wide dismissible notice: a compact bottom-right card that never
 * covers the reading column. Dismissal persists in localStorage; bump the
 * KEY suffix if the message materially changes and should re-show.
 */

import { useEffect, useState } from 'react';

const KEY = 'svx-feed-notice-dismissed-v10';

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

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* ignore */
    }
    setVisible(false);
  };

  return (
    <div
      role="status"
      className="fixed bottom-12 right-5 z-50 w-[min(340px,calc(100vw-2.5rem))] rounded-2xl border border-white/[0.09] bg-[#0d1211]/85 backdrop-blur-2xl backdrop-saturate-150 px-4 py-3.5 shadow-pop animate-fade-in"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-[5px] inline-block h-2 w-2 flex-shrink-0 rounded-full bg-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-fg tracking-[-0.01em]">
            Predict is live on Sui mainnet
          </p>
          <p className="mt-1 text-[12.5px] leading-[1.5] text-muted">
            SVX reads it through DeepBook&apos;s own SDK, fees included. Fade spike trades live
            with small, capped clips; everything else stays in paper while the shadow tracker
            scores it.
          </p>
        </div>
        <button
          aria-label="Dismiss notice"
          className="-mr-1 -mt-1 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/[0.08] hover:text-fg"
          onClick={dismiss}
        >
          <span aria-hidden className="text-[15px] leading-none">×</span>
        </button>
      </div>
    </div>
  );
}
