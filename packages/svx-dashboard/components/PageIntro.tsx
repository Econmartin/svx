/**
 * Standard explainer card that sits at the top of each dashboard page.
 *
 * Goal: a first-time visitor (judge, LP, ops) can land on any page and
 * understand "what am I looking at" and "what's healthy" in 15 seconds.
 * Keeps the rest of the page free for live numbers.
 */

import type { ReactNode } from 'react';

interface PageIntroProps {
  /** Plain-English summary of what this page shows. One or two sentences. */
  summary: ReactNode;
  /** Short bullet hints — how to read the numbers, what's healthy. Optional. */
  hints?: ReactNode[];
  /** Optional contextual right-side detail (e.g. a quick-stat). */
  detail?: ReactNode;
}

/**
 * Editorial intro block — replaces the previous "left-green-bar alert" card
 * which read as a generic shadcn callout. Now sits inline as typographic
 * prose with a clean rule above the hints list, so it visually belongs to
 * the page body instead of looking pasted on top.
 */
export function PageIntro({ summary, hints, detail }: PageIntroProps) {
  return (
    <section
      aria-label="Page overview"
      className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-x-10 gap-y-5 pt-1 pb-2"
    >
      <div className="max-w-[68ch] space-y-4">
        <p className="text-[17px] leading-[1.55] text-fg/80 tracking-[-0.014em]">{summary}</p>
        {hints && hints.length > 0 && (
          <ul className="text-[14px] text-muted-strong/80 leading-relaxed space-y-2 pl-0">
            {hints.map((h, i) => (
              <li key={i} className="flex gap-2.5">
                <span
                  aria-hidden
                  className="mt-[9px] inline-block h-1 w-1 rounded-full bg-muted/70 flex-shrink-0"
                />
                <span>{h}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {detail && (
        <aside className="md:max-w-xs text-[13px] text-muted leading-relaxed">
          {detail}
        </aside>
      )}
    </section>
  );
}
