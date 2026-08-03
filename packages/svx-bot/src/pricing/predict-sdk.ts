/**
 * Thin wrapper over DeepBook's official `@mysten/predict` SDK.
 *
 * The SDK reads Predict state on-chain over gRPC with no server in between —
 * the supported path per the DeepBook team, and the durable one now that Sui
 * has retired JSON-RPC on its own fullnodes. We use it for the things it
 * knows better than we do:
 *
 *   - the FULL market board (every listed tenor, not just the minute-cycles
 *     our event scan surfaced)
 *   - BOARD prices — what a trade would actually pay, inclusive of the
 *     protocol's skew — as opposed to our own SVI-derived fair value
 *
 * Our strategy, risk and ledger layers stay ours; this is a data source.
 */

import { PredictClient } from '@mysten/predict';
import { makeSuiClient } from '../exec/sui-client.js';
import { log } from '../util/log.js';

export interface SdkMarket {
  id: string;
  expiryMs: number;
  tickSize: number;
  mintPaused: boolean;
  referencePrice: number | null;
}

export interface BoardPrice {
  up: number;
  down: number;
}

let client: PredictClient | undefined;

function predict(): PredictClient {
  if (!client) {
    client = new PredictClient({
      network: (process.env.SUI_NETWORK as 'testnet' | 'mainnet') ?? 'testnet',
      // The SDK accepts any Sui core client; ours is the shared gRPC one.
      client: makeSuiClient() as never,
    });
  }
  return client;
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'bigint') return Number(v);
  return NaN;
};

/** Every market the protocol currently lists, across all tenors. */
export async function listSdkMarkets(): Promise<SdkMarket[]> {
  const raw = (await predict().read.markets()) as unknown as Array<Record<string, unknown>>;
  return raw
    .map((m) => ({
      id: String(m.id ?? ''),
      expiryMs: num(m.expiryMs),
      tickSize: num(m.tickSize),
      mintPaused: m.mintPaused === true,
      referencePrice: m.referencePrice == null ? null : num(m.referencePrice),
    }))
    .filter((m) => m.id && Number.isFinite(m.expiryMs));
}

/**
 * Board price for a strike — the protocol's own quote for both sides.
 * `strike: 'reference'` asks for the market's reference strike.
 */
export async function boardPrice(
  underlying: string,
  expiryMs: number,
  strike: number | 'reference',
): Promise<BoardPrice | null> {
  try {
    const p = (await predict().read.price({
      underlying,
      expiryMs,
      strike,
    } as never)) as { up?: unknown; down?: unknown };
    const up = num(p?.up);
    const down = num(p?.down);
    if (!Number.isFinite(up) || !Number.isFinite(down)) return null;
    return { up, down };
  } catch (e) {
    log.warn('svx.sdk.board_price_failed', {
      expiryMs,
      strike: String(strike),
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
