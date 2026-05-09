/**
 * Pinned testnet addresses for the `predict-testnet-4-16` deployment.
 *
 * Cross-checked 2026-05-09 against:
 *   - https://docs.sui.io/onchain-finance/deepbook-predict/contract-information
 *   - deepbookv3-predict/scripts/config/constants.ts (canonical)
 *   - deepbookv3-predict/packages/predict/README.md
 *
 * Predict is pre-mainnet; the team has said APIs may change. Re-verify before
 * any mainnet flip. All values may be overridden at runtime via env vars of
 * the same name — runtime overrides take precedence so we never have to
 * redeploy bot binaries on a Predict address swap.
 */

export interface PredictAddresses {
  packageId: string;
  /** Shared `Predict` root object — pass into mint/redeem. */
  predictObjectId: string;
  /** Shared admin/config registry — not used for trading flows. */
  registryId: string;
  /** Full canonical type string for dUSDC. */
  dusdcType: string;
  /** Shared `Currency<DUSDC>` object (for supply / quote-asset enable flows). */
  dusdcCurrencyId: string;
  rpcUrl: string;
  predictServerUrl: string;
}

const env = (k: string, fallback: string): string => {
  const v = (typeof process !== 'undefined' && process.env?.[k]) || '';
  return v.length > 0 ? v : fallback;
};

const PREDICT_PACKAGE_ID_TESTNET =
  '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
const PREDICT_OBJECT_ID_TESTNET =
  '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';
const PREDICT_REGISTRY_ID_TESTNET =
  '0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64';
const DUSDC_PACKAGE_ID_TESTNET =
  '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a';
const DUSDC_TYPE_TESTNET = `${DUSDC_PACKAGE_ID_TESTNET}::dusdc::DUSDC`;
const DUSDC_CURRENCY_ID_TESTNET =
  '0xf3000dff421833d4bb8ed58fac146d691a3aaba2785aa1989af65a7089ca3e9c';

export const ADDRESSES: PredictAddresses = {
  packageId: env('PREDICT_PACKAGE_ID', PREDICT_PACKAGE_ID_TESTNET),
  predictObjectId: env('PREDICT_OBJECT_ID', PREDICT_OBJECT_ID_TESTNET),
  registryId: env('PREDICT_REGISTRY_ID', PREDICT_REGISTRY_ID_TESTNET),
  dusdcType: env('DUSDC_TYPE', DUSDC_TYPE_TESTNET),
  dusdcCurrencyId: env('DUSDC_CURRENCY_ID', DUSDC_CURRENCY_ID_TESTNET),
  rpcUrl: env('SUI_RPC_URL', 'https://fullnode.testnet.sui.io:443'),
  predictServerUrl: env('PREDICT_SERVER_URL', 'https://predict-server.testnet.mystenlabs.com'),
};

const PLACEHOLDER_PREFIX = '0x000000000000';

export function isAddressPinned(addr: string): boolean {
  return addr.length > 2 && !addr.startsWith(PLACEHOLDER_PREFIX);
}

export function assertAddressesPinned(a: PredictAddresses = ADDRESSES): void {
  const missing: string[] = [];
  if (!isAddressPinned(a.packageId)) missing.push('PREDICT_PACKAGE_ID');
  if (!isAddressPinned(a.predictObjectId)) missing.push('PREDICT_OBJECT_ID');
  if (!isAddressPinned(a.registryId)) missing.push('PREDICT_REGISTRY_ID');
  if (a.dusdcType.startsWith(PLACEHOLDER_PREFIX)) missing.push('DUSDC_TYPE');
  if (missing.length) {
    throw new Error(
      `SVX cannot submit tx: the following testnet addresses are not pinned: ${missing.join(', ')}.`,
    );
  }
}

/** Predict server REST endpoint paths (axum routes from `crates/predict-server/src/server.rs`). */
export const PREDICT_ENDPOINTS = {
  health: '/health',
  status: '/status',
  config: '/config',
  predictState: (id: string) => `/predicts/${id}/state`,
  predictOracles: (id: string) => `/predicts/${id}/oracles`,
  predictQuoteAssets: (id: string) => `/predicts/${id}/quote-assets`,
  vaultSummary: (id: string) => `/predicts/${id}/vault/summary`,
  vaultPerformance: (id: string) => `/predicts/${id}/vault/performance`,
  oracles: '/oracles',
  oracleState: (oid: string) => `/oracles/${oid}/state`,
  oraclePrices: (oid: string) => `/oracles/${oid}/prices`,
  oracleLatestPrice: (oid: string) => `/oracles/${oid}/prices/latest`,
  oracleSvi: (oid: string) => `/oracles/${oid}/svi`,
  oracleLatestSvi: (oid: string) => `/oracles/${oid}/svi/latest`,
  oracleAskBounds: (oid: string) => `/oracles/${oid}/ask-bounds`,
  trades: (oid: string) => `/trades/${oid}`,
  positionsMinted: '/positions/minted',
  positionsRedeemed: '/positions/redeemed',
  rangesMinted: '/ranges/minted',
  rangesRedeemed: '/ranges/redeemed',
  lpSupplies: '/lp/supplies',
  lpWithdrawals: '/lp/withdrawals',
  managers: '/managers',
  managerSummary: (mid: string) => `/managers/${mid}/summary`,
  managerPositions: (mid: string) => `/managers/${mid}/positions`,
  managerPositionSummary: (mid: string) => `/managers/${mid}/positions/summary`,
  managerRanges: (mid: string) => `/managers/${mid}/ranges`,
  managerPnl: (mid: string) => `/managers/${mid}/pnl`,
} as const;

/** Move event types to subscribe to (all under `${packageId}::oracle`). */
export function oracleEventTypes(packageId: string = ADDRESSES.packageId): string[] {
  return [
    `${packageId}::oracle::OraclePricesUpdated`,
    `${packageId}::oracle::OracleSVIUpdated`,
    `${packageId}::oracle::OracleSettled`,
    `${packageId}::oracle::OracleActivated`,
  ];
}

/** Per-operator object IDs. Persisted to `data/operator.json`. */
export interface OperatorAddresses {
  operatorAddress: string;
  managerId: string;
  dusdcCoinObjectIds?: string[];
}
