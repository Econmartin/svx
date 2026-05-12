'use client';

/**
 * /wallets — truth-from-chain view of all three operator wallets.
 *
 * Cross-references the bot's ledger view against on-chain state for HL
 * (the only venue where we can cheaply query open positions directly).
 * For Polymarket we rely on the ledger + polygonscan link. For Sui we
 * show wallet + manager balances and the live positions from the ledger.
 *
 * The orphan-detection banner appears when on-chain HL positions exist
 * that the ledger doesn't know about, OR when the ledger expects HL
 * positions that aren't on chain. Most operator-meaningful state lives
 * here for hackathon demo purposes.
 */

import { useCallback } from 'react';
import { useApiClient, useNetwork } from '@/lib/network-context';
import { formatPct, formatRelative, formatUsdc, type WalletsSnapshot } from '@/lib/api';
import { usePolling } from '@/lib/usePolling';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Separator } from '@/components/ui/separator';
import { ExternalLink, AlertTriangle, CheckCircle2 } from 'lucide-react';

export default function WalletsPage() {
  const client = useApiClient();
  const { network } = useNetwork();
  const isMainnet = network === 'mainnet';
  const { data, error } = usePolling(useCallback(() => client.wallets(), [client]), 15_000);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Wallets</h1>
        <p className="text-muted text-sm mt-1">
          On-chain truth for each operator wallet — what's actually there, not
          what the bot's ledger thinks. Cross-referenced with the ledger view
          to spot orphan fills.
        </p>
      </header>

      {error && (
        <div className="rounded border border-loss/40 bg-loss/10 px-4 py-3 text-sm text-loss">
          {error}
        </div>
      )}

      {data ? (
        <>
          <SuiCard sui={data.sui} />
          <PolygonCard polygon={data.polygon} isMainnet={isMainnet} />
          <HyperliquidCard hl={data.hyperliquid} />
        </>
      ) : (
        <Card>
          <CardContent className="py-12 text-center text-muted text-sm">
            Loading wallet snapshot…
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SuiCard({ sui }: { sui: WalletsSnapshot['sui'] }) {
  if (!sui) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Sui — Predict operator</span>
            <Badge variant="outline">not configured</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted">No Sui keypair configured for this bot instance.</p>
        </CardContent>
      </Card>
    );
  }
  const total = sui.navUsdc + sui.managerBalanceUsdc;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between flex-wrap gap-2">
          <span>Sui — Predict operator</span>
          <div className="flex items-center gap-2">
            <Badge variant={sui.paperTrading ? 'outline' : 'live'}>
              {sui.paperTrading ? 'paper' : 'live'}
            </Badge>
            <a
              href={`https://suiscan.xyz/testnet/account/${sui.address}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted hover:text-accent inline-flex items-center gap-1 font-mono"
            >
              {shortAddr(sui.address)} <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KeyValue label="Wallet dUSDC" value={formatUsdc(sui.navUsdc)} />
          <KeyValue label="In manager" value={formatUsdc(sui.managerBalanceUsdc)} />
          <KeyValue label="Total" value={formatUsdc(total)} tone={total > 0 ? 'win' : 'default'} />
          <KeyValue
            label="Synced"
            value={sui.managerBalanceAtMs ? formatRelative(sui.managerBalanceAtMs) : '—'}
            small
          />
        </div>
        {sui.managerId && (
          <KeyValue
            label="PredictManager"
            value={
              <a
                href={`https://suiscan.xyz/testnet/object/${sui.managerId}`}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline inline-flex items-center gap-1 font-mono text-xs"
              >
                {sui.managerId.slice(0, 18)}… <ExternalLink className="h-3 w-3" />
              </a>
            }
          />
        )}
        <Separator />
        <div>
          <div className="text-xs uppercase tracking-wider text-muted mb-2">
            Open positions ({sui.openPositions.length})
          </div>
          {sui.openPositions.length === 0 ? (
            <p className="text-sm text-muted">No live positions.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Oracle</TableHead>
                  <TableHead>Strike</TableHead>
                  <TableHead>Direction</TableHead>
                  <TableHead>Quantity</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Tx</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sui.openPositions.map((p) => (
                  <TableRow key={p.tradeId}>
                    <TableCell className="text-muted text-xs">
                      {p.oracleId.slice(0, 10)}…
                    </TableCell>
                    <TableCell>${p.strike.toFixed(0)}</TableCell>
                    <TableCell>{p.direction.toUpperCase()}</TableCell>
                    <TableCell>{formatUsdc(p.quantity)}</TableCell>
                    <TableCell>{formatUsdc(p.cost)}</TableCell>
                    <TableCell className="text-xs">
                      {p.txDigest ? (
                        <a
                          href={`https://suiscan.xyz/testnet/tx/${p.txDigest}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline inline-flex items-center gap-1"
                        >
                          tx <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PolygonCard({
  polygon,
  isMainnet,
}: {
  polygon: WalletsSnapshot['polygon'];
  isMainnet: boolean;
}) {
  if (!polygon) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Polygon — Polymarket operator</span>
            <Badge variant="outline">not configured</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted">
            No Polymarket keypair configured. Set <code className="code">POLY_PRIVATE_KEY</code>.
          </p>
        </CardContent>
      </Card>
    );
  }
  const gasOk = polygon.polBalance > 0.1;
  const fundedOk = polygon.pUsdBalance > 0;
  const usingSafe = polygon.signatureMode && polygon.signatureMode !== 'EOA';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between flex-wrap gap-2">
          <span>Polygon — Polymarket operator</span>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={polygon.executionEnabled ? 'live' : 'warn'}>
              {polygon.executionEnabled ? 'exec on' : 'exec off'}
            </Badge>
            {polygon.signatureMode && (
              <Badge variant="outline" title="Signature mode used for CLOB orders">
                {polygon.signatureMode}
              </Badge>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <AddressRow
            label={usingSafe ? 'Funder (Safe proxy)' : 'Funder (EOA)'}
            address={polygon.address}
            sublabel="holds pUSD + outcome shares"
          />
          {usingSafe && polygon.signerAddress && (
            <AddressRow
              label="Signer (EOA)"
              address={polygon.signerAddress}
              sublabel="signs CLOB orders, holds POL gas"
            />
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KeyValue
            label={`pUSD (${polygon.network})`}
            value={formatUsdc(polygon.pUsdBalance)}
            tone={fundedOk ? 'win' : 'loss'}
          />
          <KeyValue
            label="POL (gas)"
            value={polygon.polBalance.toFixed(4)}
            tone={gasOk ? 'win' : 'warn'}
          />
          <KeyValue
            label="Synced"
            value={polygon.balanceAtMs ? formatRelative(polygon.balanceAtMs) : '—'}
            small
          />
          <KeyValue
            label="Audit"
            value={
              <a
                href={`https://polygonscan.com/address/${polygon.address}#tokentxns`}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline inline-flex items-center gap-1 text-sm"
              >
                tokentxns <ExternalLink className="h-3.5 w-3.5" />
              </a>
            }
            small
          />
        </div>

        {isMainnet && !polygon.executionEnabled && (
          <div className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
            Execution is off — bot won't submit Polymarket orders. Set
            <code className="code mx-1">MAINNET_POLY_EXECUTION_ENABLED=true</code>
            in Coolify to enable.
          </div>
        )}

        <Separator />
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs uppercase tracking-wider text-muted">
              Open outcome share positions ({polygon.openPositions.length})
            </div>
            <span className="text-xs text-muted">
              cross-ref with{' '}
              <a
                href={`https://polygonscan.com/address/${polygon.address}#tokentxns`}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-accent"
              >
                token transfers
              </a>{' '}
              to spot orphans
            </span>
          </div>
          {polygon.openPositions.length === 0 ? (
            <p className="text-sm text-muted">No open positions tracked by the ledger.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Opened</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Shares</TableHead>
                  <TableHead>Fill</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Condition</TableHead>
                  <TableHead>Tx</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {polygon.openPositions.map((p) => (
                  <TableRow key={p.tradeId}>
                    <TableCell className="text-muted text-xs">
                      {new Date(p.openedAtMs).toLocaleString()}
                    </TableCell>
                    <TableCell>{p.outcome?.toUpperCase() ?? '—'}</TableCell>
                    <TableCell>{p.shares?.toFixed(2) ?? '—'}</TableCell>
                    <TableCell>{p.fillPrice ? formatPct(p.fillPrice, 2) : '—'}</TableCell>
                    <TableCell>{formatUsdc(p.costUsdc)}</TableCell>
                    <TableCell className="text-xs text-muted">
                      {p.conditionId?.slice(0, 10) ?? '—'}…
                    </TableCell>
                    <TableCell className="text-xs">
                      {p.polyTxHash ? (
                        <a
                          href={`https://polygonscan.com/tx/${p.polyTxHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline inline-flex items-center gap-1"
                        >
                          tx <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function HyperliquidCard({ hl }: { hl: WalletsSnapshot['hyperliquid'] }) {
  if (!hl) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Hyperliquid — hedge operator</span>
            <Badge variant="outline">not configured</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted">
            No Hyperliquid keypair configured. Set <code className="code">HL_PRIVATE_KEY</code>.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Orphan detection: compare ledger expectation vs on-chain truth.
  const orphanReport = computeHlOrphans(hl);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between flex-wrap gap-2">
          <span>Hyperliquid — hedge operator</span>
          <div className="flex items-center gap-2">
            <Badge variant={hl.executionEnabled ? 'live' : 'warn'}>
              {hl.executionEnabled ? 'exec on' : 'exec off'}
            </Badge>
            <a
              href={`https://app.hyperliquid.xyz/explorer/address/${hl.address}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted hover:text-accent inline-flex items-center gap-1 font-mono"
            >
              {shortAddr(hl.address)} <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KeyValue
            label={`Margin (${hl.network})`}
            value={formatUsdc(hl.accountValueUsdc)}
            tone={hl.accountValueUsdc > 0 ? 'win' : 'loss'}
          />
          <KeyValue
            label="Withdrawable"
            value={formatUsdc(hl.withdrawableUsdc)}
          />
          <KeyValue
            label="Open positions"
            value={(hl.chainPositions?.length ?? 0).toString()}
          />
          <KeyValue
            label="Synced"
            value={hl.balanceAtMs ? formatRelative(hl.balanceAtMs) : '—'}
            small
          />
        </div>

        {orphanReport.hasDrift && (
          <div className="rounded border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <strong className="block">Ledger ↔ chain drift</strong>
              {orphanReport.onChainOnly > 0 && (
                <div>
                  {orphanReport.onChainOnly} on-chain position(s) not in the ledger — likely manual
                  or force-trade leftovers.
                </div>
              )}
              {orphanReport.ledgerOnly > 0 && (
                <div>
                  {orphanReport.ledgerOnly} ledger hedge(s) not visible on-chain — close may have
                  failed or HL closed it for other reasons.
                </div>
              )}
            </div>
          </div>
        )}

        {!orphanReport.hasDrift && (hl.chainPositions?.length ?? 0) > 0 && (
          <div className="rounded border border-win/40 bg-win/10 px-3 py-2 text-xs text-win flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            Ledger matches on-chain — no drift.
          </div>
        )}

        <Separator />
        <div>
          <div className="text-xs uppercase tracking-wider text-muted mb-2">
            On-chain positions (HL clearinghouse)
          </div>
          {!hl.chainPositions || hl.chainPositions.length === 0 ? (
            <p className="text-sm text-muted">No open positions on chain.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asset</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead>Unrealized PnL</TableHead>
                  <TableHead>Cum. funding</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hl.chainPositions.map((p, i) => (
                  <TableRow key={i}>
                    <TableCell>{p.asset}</TableCell>
                    <TableCell>
                      <Badge variant={p.side === 'long' ? 'live' : 'warn'}>
                        {p.side.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell>{p.szi.toFixed(5)}</TableCell>
                    <TableCell>${p.entryPx.toFixed(1)}</TableCell>
                    <TableCell
                      className={
                        p.unrealizedPnlUsd >= 0 ? 'text-win' : 'text-loss'
                      }
                    >
                      {formatUsdc(p.unrealizedPnlUsd)}
                    </TableCell>
                    <TableCell className="text-muted">
                      {formatUsdc(p.cumFundingUsdc)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {hl.ledgerHedges.length > 0 && (
          <>
            <Separator />
            <div>
              <div className="text-xs uppercase tracking-wider text-muted mb-2">
                Ledger-tracked hedges ({hl.ledgerHedges.length})
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Opened</TableHead>
                    <TableHead>Asset</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Open price</TableHead>
                    <TableHead>Order ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hl.ledgerHedges.map((h) => (
                    <TableRow key={h.tradeId}>
                      <TableCell className="text-muted text-xs">
                        {new Date(h.openedAtMs).toLocaleString()}
                      </TableCell>
                      <TableCell>{h.asset ?? '—'}</TableCell>
                      <TableCell>
                        {h.side ? (
                          <Badge variant={h.side === 'long' ? 'live' : 'warn'}>
                            {h.side.toUpperCase()}
                          </Badge>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>{h.size?.toFixed(5) ?? '—'}</TableCell>
                      <TableCell>
                        {h.openPrice ? `$${h.openPrice.toFixed(1)}` : '—'}
                      </TableCell>
                      <TableCell className="text-muted text-xs">
                        {h.orderId ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Cross-reference ledger vs on-chain HL positions. We can't always pair
 * exactly (HL doesn't return ledger-tradeId), so we compare aggregate
 * counts per (asset, side) — a rough but useful heuristic.
 */
function computeHlOrphans(hl: NonNullable<WalletsSnapshot['hyperliquid']>): {
  hasDrift: boolean;
  onChainOnly: number;
  ledgerOnly: number;
} {
  const chain = hl.chainPositions ?? [];
  const ledger = hl.ledgerHedges;
  // Bucket by (asset|side); add sizes.
  const chainBuckets = new Map<string, number>();
  for (const p of chain) {
    const key = `${p.asset}|${p.side}`;
    chainBuckets.set(key, (chainBuckets.get(key) ?? 0) + p.szi);
  }
  const ledgerBuckets = new Map<string, number>();
  for (const h of ledger) {
    if (!h.asset || !h.side) continue;
    const key = `${h.asset}|${h.side}`;
    ledgerBuckets.set(key, (ledgerBuckets.get(key) ?? 0) + (h.size ?? 0));
  }
  let onChainOnly = 0;
  let ledgerOnly = 0;
  const allKeys = new Set([...chainBuckets.keys(), ...ledgerBuckets.keys()]);
  for (const k of allKeys) {
    const c = chainBuckets.get(k) ?? 0;
    const l = ledgerBuckets.get(k) ?? 0;
    if (Math.abs(c - l) < 0.000001) continue;
    if (c > l) onChainOnly++;
    else ledgerOnly++;
  }
  return { hasDrift: onChainOnly + ledgerOnly > 0, onChainOnly, ledgerOnly };
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function AddressRow({
  label,
  address,
  sublabel,
}: {
  label: string;
  address: string;
  sublabel?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-elevated px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <a
        href={`https://polygonscan.com/address/${address}`}
        target="_blank"
        rel="noreferrer"
        className="mt-0.5 font-mono text-sm text-white hover:text-accent inline-flex items-center gap-1 break-all"
      >
        {address}
        <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
      {sublabel && <div className="text-xs text-muted mt-0.5">{sublabel}</div>}
    </div>
  );
}

function KeyValue({
  label,
  value,
  tone = 'default',
  small,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'win' | 'loss' | 'warn';
  small?: boolean;
}) {
  const toneCls =
    tone === 'win'
      ? 'text-win'
      : tone === 'loss'
        ? 'text-loss'
        : tone === 'warn'
          ? 'text-warn'
          : 'text-white';
  return (
    <div className="rounded-md border border-border bg-surface-elevated px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-muted">{label}</div>
      <div className={`${small ? 'text-sm' : 'text-lg'} font-mono mt-0.5 tabular-nums ${toneCls}`}>
        {value}
      </div>
    </div>
  );
}
