/**
 * Claim settled Predict positions into the account.
 *
 * Mainnet does not auto-deliver our settled winners (the pre-launch testnet
 * keeper did; on mainnet our positions stayed open after settlement), so
 * the bot claims them itself. Every sweep:
 *
 *   1. lists the account's open positions on-chain (read.positions),
 *   2. for each market that has settled, decodes the order's range and
 *      quantity to know the payout (winners pay the quantity, losers 0),
 *   3. submits claimSettled — winners first; losers too, which pays nothing
 *      but clears the position (gas only),
 *   4. marks the matching ledger rows redeemed with the REAL tx digest.
 *
 * A ledger row is only ever marked paid after its claim executes on-chain,
 * so realized PnL can no longer run ahead of the account balance.
 */

import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { LedgerStore } from '../ledger/store.js';
import { buildClaimSettledTx, openPositions, settledOrderPayout } from '../pricing/predict-sdk.js';
import { log } from '../util/log.js';
import type { SuiChainClient } from './sui-client.js';
import { submitTx } from './submit.js';

export interface UnclaimedSummary {
  checkedAtMs: number;
  /** Payout owed by settled winners not yet claimed (USD). */
  unclaimedUsdc: number;
  /** Positions still open whose market has not settled. */
  openUnsettled: number;
}

let summary: UnclaimedSummary | null = null;
export function unclaimedSummary(): UnclaimedSummary | null {
  return summary;
}

export async function claimSettledPositions(deps: {
  sui: SuiChainClient;
  keypair: Ed25519Keypair;
  owner: string;
  ledger: LedgerStore;
  /** Dry run: compute what is owed without submitting. */
  dry?: boolean;
}): Promise<{ claimed: number; paidUsdc: number; unclaimedUsdc: number }> {
  const { sui, owner, ledger } = deps;
  const positions = await openPositions(owner);
  const settled: Array<{
    marketId: string;
    orderId: bigint;
    expiryMs: number;
    payout: number;
    quantity: number;
  }> = [];
  let openUnsettled = 0;
  for (const p of positions) {
    const res = await sui
      .getObject({ objectId: p.marketId, include: { json: true } })
      .catch(() => null);
    const j = res?.object?.json as Record<string, unknown> | undefined;
    const se = j?.strike_exposure as Record<string, unknown> | undefined;
    const raw = se?.settlement_price ?? j?.settlement_price;
    if (!j || !se || raw == null) {
      openUnsettled++;
      continue;
    }
    const { payout, quantity } = settledOrderPayout(
      p.orderId,
      BigInt(String(se.tick_size)),
      Number(raw) / 1e9,
    );
    settled.push({ marketId: p.marketId, orderId: p.orderId, expiryMs: Number(j.expiry), payout, quantity });
  }
  settled.sort((a, b) => b.payout - a.payout); // winners first

  let claimed = 0;
  let paidUsdc = 0;
  let unclaimedUsdc = settled.reduce((a, s) => a + s.payout, 0);
  if (!deps.dry) {
    for (const s of settled) {
      const tx = await buildClaimSettledTx(owner, s, s.orderId);
      const result = await submitTx(sui, tx, deps.keypair);
      if (!result.ok) {
        log.warn('svx.claim.failed', {
          marketId: s.marketId,
          orderId: String(s.orderId),
          payoutUsdc: s.payout,
          error: result.error,
        });
        continue;
      }
      claimed++;
      paidUsdc += s.payout;
      unclaimedUsdc -= s.payout;
      // Mark the ledger row(s) for this position paid, with the real digest.
      for (const t of ledger.openOrUnredeemedLiveTradesFor(s.marketId)) {
        if (Math.abs(t.quantityDusdc - s.quantity) < 0.006) ledger.markRedeemed(t.id, result.digest);
      }
      log.info('svx.claim.ok', {
        marketId: s.marketId,
        orderId: String(s.orderId),
        payoutUsdc: s.payout,
        digest: result.digest,
      });
    }
  }
  summary = { checkedAtMs: Date.now(), unclaimedUsdc: Math.max(0, unclaimedUsdc), openUnsettled };
  return { claimed, paidUsdc, unclaimedUsdc: Math.max(0, unclaimedUsdc) };
}
