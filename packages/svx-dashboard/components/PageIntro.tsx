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
      className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-x-8 gap-y-4 border-y border-border/70 py-5"
    >
      <div className="max-w-3xl space-y-3">
        <p className="text-[15px] leading-relaxed text-fg/90">{summary}</p>
        {hints && hints.length > 0 && (
          <ul className="text-[12.5px] text-muted-strong/90 leading-relaxed space-y-1.5 pl-0">
            {hints.map((h, i) => (
              <li key={i} className="flex gap-2.5">
                <span
                  aria-hidden
                  className="mt-[7px] inline-block h-1 w-1 rounded-full bg-accent/70 flex-shrink-0"
                />
                <span>{h}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {detail && (
        <aside className="md:max-w-xs text-xs text-muted font-mono leading-relaxed">
          {detail}
        </aside>
      )}
    </section>
  );
}
