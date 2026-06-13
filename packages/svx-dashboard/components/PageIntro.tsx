/**
 * Standard explainer card that sits at the top of each dashboard page.
 *
 * Goal: a first-time visitor (judge, LP, ops) can land on any page and
 * understand "what am I looking at" and "what's healthy" in 15 seconds.
 * Keeps the rest of the page free for live numbers.
 */

import { Card, CardContent } from '@/components/ui/card';
import type { ReactNode } from 'react';

interface PageIntroProps {
  /** Plain-English summary of what this page shows. One or two sentences. */
  summary: ReactNode;
  /** Short bullet hints — how to read the numbers, what's healthy. Optional. */
  hints?: ReactNode[];
  /** Optional contextual right-side detail (e.g. a quick-stat). */
  detail?: ReactNode;
}

export function PageIntro({ summary, hints, detail }: PageIntroProps) {
  return (
    <Card className="border-l-4 border-l-accent/60 bg-surface-elevated/30">
      <CardContent className="py-4 px-5">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
          <div className="flex-1 space-y-2">
            <p className="text-sm leading-relaxed text-fg/90">{summary}</p>
            {hints && hints.length > 0 && (
              <ul className="text-xs text-muted leading-relaxed space-y-1 mt-2">
                {hints.map((h, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-accent/80 flex-shrink-0">→</span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {detail && (
            <div className="md:max-w-xs text-xs text-muted font-mono leading-relaxed">
              {detail}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
