'use client';

import { useNetwork } from '@/lib/network-context';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { FlaskConical, Banknote } from 'lucide-react';

/**
 * Header network toggle — testnet (Predict-live) vs mainnet (Poly+HL-live).
 *
 * Hidden when only one network is configured (avoids confusing the user with
 * a toggle that doesn't actually switch anything).
 */
export function NetworkToggle() {
  const { network, setNetwork, bothConfigured } = useNetwork();
  if (!bothConfigured) return null;
  return (
    <ToggleGroup
      value={network}
      onValueChange={(v) => setNetwork(v as 'testnet' | 'mainnet')}
    >
      <ToggleGroupItem value="testnet">
        <FlaskConical className="h-3.5 w-3.5" />
        testnet
      </ToggleGroupItem>
      <ToggleGroupItem value="mainnet">
        <Banknote className="h-3.5 w-3.5" />
        mainnet
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
