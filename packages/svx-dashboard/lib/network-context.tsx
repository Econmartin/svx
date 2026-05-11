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

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const bothConfigured = api.enabled && apiMainnet.enabled;
  const [network, setNetworkState] = React.useState<Network>(() => {
    // Default to mainnet if it's the only one configured, otherwise testnet
    // unless localStorage has a prior choice.
    if (typeof window === 'undefined') return 'testnet';
    if (!api.enabled && apiMainnet.enabled) return 'mainnet';
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'mainnet' && apiMainnet.enabled) return 'mainnet';
    if (stored === 'testnet' && api.enabled) return 'testnet';
    return api.enabled ? 'testnet' : 'mainnet';
  });

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
