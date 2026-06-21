'use client';

/**
 * NetworkContext — single source of truth for "which bot are we looking at".
 *
 * Replaces the old `/` (testnet) vs `/mainnet` route split with a runtime
 * toggle. Every page reads the active API client via `useApiClient()`; the
 * provider persists the choice to localStorage so it survives reloads.
 *
 * The two URLs (`NEXT_PUBLIC_SVX_API`, `NEXT_PUBLIC_SVX_API_MAINNET`) are
 * baked in at build time. If `apiMainnet` isn't configured we degrade to
 * testnet-only and disable the toggle in the header.
 */

import * as React from 'react';
import { api, apiMainnet, type ApiClient } from './api';

export type Network = 'testnet' | 'mainnet';

interface NetworkContextValue {
  network: Network;
  setNetwork: (n: Network) => void;
  client: ApiClient;
  /** True when both clients are configured (toggle is meaningful). */
  bothConfigured: boolean;
}

const NetworkContext = React.createContext<NetworkContextValue | null>(null);

const STORAGE_KEY = 'svx.network';

/** Pick the default network deterministically (no window access). */
function defaultNetwork(): Network {
  if (!api.enabled && apiMainnet.enabled) return 'mainnet';
  return api.enabled ? 'testnet' : 'mainnet';
}

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const bothConfigured = api.enabled && apiMainnet.enabled;
  // Seed with the deterministic default on BOTH server and first client
  // render, then upgrade to the localStorage choice (if any) post-mount.
  // Reading localStorage during initial render produced a server/client
  // mismatch that broke hydration in every component rendering the
  // network label (Hero, StatusTicker, etc.).
  const [network, setNetworkState] = React.useState<Network>(defaultNetwork);

  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'mainnet' && apiMainnet.enabled) setNetworkState('mainnet');
      else if (stored === 'testnet' && api.enabled) setNetworkState('testnet');
    } catch {
      /* private-mode / quota — ignore */
    }
  }, []);

  const setNetwork = React.useCallback((n: Network) => {
    setNetworkState(n);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(STORAGE_KEY, n);
      } catch {
        /* private-mode / quota — ignore */
      }
    }
  }, []);

  const client = network === 'mainnet' ? apiMainnet : api;

  return (
    <NetworkContext.Provider value={{ network, setNetwork, client, bothConfigured }}>
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork(): NetworkContextValue {
  const ctx = React.useContext(NetworkContext);
  if (!ctx) throw new Error('useNetwork must be used inside NetworkProvider');
  return ctx;
}

/** Shortcut: just the active API client. */
export function useApiClient(): ApiClient {
  return useNetwork().client;
}
