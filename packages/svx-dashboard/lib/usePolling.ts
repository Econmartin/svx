'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Poll `fetcher` every `intervalMs`. When the fetcher changes (e.g. the
 * network toggle swaps the API client) the previous fetcher's in-flight
 * responses are discarded and the old data is cleared — otherwise a slow
 * testnet response landing after the mainnet one would overwrite it and the
 * page would show the wrong network's data under the mainnet toggle.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(fetcher);
  current.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      const d = await fetcher();
      if (current.current !== fetcher) return; // superseded while in flight
      setData(d);
      setError(null);
    } catch (e) {
      if (current.current !== fetcher) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [fetcher]);

  const first = useRef(true);
  useEffect(() => {
    // A new fetcher means a new source: don't keep showing the old one's data.
    if (!first.current) {
      setData(null);
      setError(null);
    }
    first.current = false;
    let cancelled = false;
    refresh();
    const id = setInterval(() => {
      if (!cancelled) refresh();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refresh, intervalMs]);

  return { data, error, refresh };
}
