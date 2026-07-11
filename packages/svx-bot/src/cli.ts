/**
 * SVX CLI entry point. Subcommands:
 *
 *   svx start        — run the bot (paper mode by default; --live to enable
 *                      live execution, requires PAPER_TRADING=false)
 *   svx start --once — run a single loop iteration and exit (useful in CI /
 *                      smoke testing)
 *   svx pause        — set the manual kill flag
 *   svx resume       — clear the manual kill flag
 *   svx status       — print bot status from the local ledger
 *   svx report       — print PnL summary
 */

import path from 'node:path';
import fs from 'node:fs';
import { SuiClient } from '@mysten/sui/client';
import { ADDRESSES } from 'svx-shared/addresses';
import { loadConfig } from './config.js';
import { LedgerStore } from './ledger/store.js';
import { runBot } from './index.js';
import { setKillFlag, clearKillFlag, isKilled } from './ops/kill.js';
import { loadOperatorKey } from './exec/keypair.js';
import { buildMintRangeTx, buildSupplyPlpTx } from './exec/ptb.js';
import { submitTx } from './exec/submit.js';
import { PredictClient } from './pricing/predict.js';
import { buildLadder } from './strategy/range-ladder.js';
import { log } from './util/log.js';

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case 'start':
      return runBot({ onceOnly: rest.includes('--once') });
    case 'pause':
      setKillFlag();
      console.log('paused — kill flag at /tmp/svx-paused');
      return;
    case 'resume':
      return resume();
    case 'rebaseline':
      return rebaseline();
    case 'status':
      return printStatus();
    case 'report':
      return printReport();
    case 'mint-ladder':
      return mintLadder(rest);
    case 'supply-plp':
      return supplyPlp(rest);
    default:
      printHelp();
      process.exit(cmd ? 1 : 0);
  }
}

/**
 * One-shot live demo: build a σ/2-width 5-rung ladder around ATM on the
 * soonest active oracle and mint it on-chain via `predict::mint_range`.
 * The σ/2 policy is the simulation winner (+10.1% ROI over 104 oracles on
 * the May archive — see docs/backtest-report.md and GET /range-sim).
 *
 *   svx mint-ladder [--notional 2] [--rungs 5] [--width-z 0.5] [--dry]
 */
async function mintLadder(rest: string[]): Promise<void> {
  const cfg = loadConfig();
  const arg = (name: string, def: number) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] ? Number(rest[i + 1]) : def;
  };
  const notional = arg('--notional', 2);
  const rungCount = Math.round(arg('--rungs', 5));
  const widthZ = arg('--width-z', 0.5);
  const dry = rest.includes('--dry');

  const predict = new PredictClient();
  const oracles = await predict.listActiveOracles('BTC');
  const soonest = oracles
    .filter((o) => o.expiryMs > Date.now() + 3 * 60_000) // ≥3min TTM
    .sort((a, b) => a.expiryMs - b.expiryMs)[0];
  if (!soonest) throw new Error('no active BTC oracle with ≥3min to expiry');
  const snap = await predict.snapshotOracle(soonest.oracleId);
  if (!snap) throw new Error(`could not snapshot oracle ${soonest.oracleId}`);

  const tYears = (snap.expiryMs - Date.now()) / (365.25 * 24 * 3600 * 1000);
  const ladder = buildLadder({
    forward: snap.forward,
    svi: snap.svi,
    tYears,
    cfg: {
      policy: 'sigma',
      rungs: rungCount,
      widthZ,
      widthBps: 25,
      minRungPrice: 0.03,
      maxRungPrice: 0.97,
    },
  });
  if (ladder.length === 0) throw new Error('ladder empty (all rungs outside the price band)');

  console.log(
    JSON.stringify(
      {
        msg: 'svx.mint_ladder.plan',
        oracleId: snap.oracleId,
        expiryIso: new Date(snap.expiryMs).toISOString(),
        forward: snap.forward,
        rungs: ladder.map((r) => ({
          band: `(${Math.round(r.lowerStrike)}, ${Math.round(r.higherStrike)}]`,
          fair: Number(r.fairPrice.toFixed(4)),
          offset: r.offset,
        })),
        notionalPerRung: notional,
        estCostUsdc: Number(
          (ladder.reduce((a, r) => a + r.fairPrice, 0) * notional).toFixed(4),
        ),
      },
      null,
      2,
    ),
  );
  if (dry) return;

  // Live context — same sources as runBot's live mode.
  const operatorFile = path.join(path.resolve(cfg.dataDir), 'operator.json');
  const op: { operatorAddress: string; managerId: string } = process.env.OPERATOR_JSON
    ? JSON.parse(process.env.OPERATOR_JSON)
    : JSON.parse(fs.readFileSync(operatorFile, 'utf8'));
  const { keypair } = loadOperatorKey();
  const sui = new SuiClient({ url: ADDRESSES.rpcUrl });

  for (const rung of ladder) {
    const tx = buildMintRangeTx({
      oracleId: snap.oracleId,
      expiryMs: snap.expiryMs,
      lowerStrike: rung.lowerStrike,
      higherStrike: rung.higherStrike,
      quantityDusdc: notional,
      managerId: op.managerId,
    });
    const result = await submitTx(sui, tx, keypair);
    console.log(
      JSON.stringify({
        msg: result.ok ? 'svx.mint_ladder.rung_ok' : 'svx.mint_ladder.rung_failed',
        band: `(${Math.round(rung.lowerStrike)}, ${Math.round(rung.higherStrike)}]`,
        digest: result.digest,
        ...(result.ok ? {} : { error: result.error, status: result.status }),
      }),
    );
  }
  console.log(
    JSON.stringify({
      msg: 'svx.mint_ladder.done',
      note: 'ranges have NO permissionless redeem — redeem with the operator key after settlement (predict::redeem_range)',
    }),
  );
}

/**
 * Full resume — clears every layer the bot uses to detect "paused":
 *  1. The filesystem kill flag (`/tmp/svx-paused`).
 *  2. The ledger's persisted pause state (set by daily-loss / circuit-breaker
 *     auto-pause). Without this, restarting the bot wouldn't unstick a
 *     circuit-breaker pause.
 */
function resume(): void {
  const cfg = loadConfig();
  const ledger = new LedgerStore(path.join(path.resolve(cfg.dataDir), 'svx.sqlite'));
  const before = ledger.getPause();
  clearKillFlag();
  ledger.setPause(false);
  // Bump the streak watermark — same semantics as RiskGate.resume(). Without
  // this the breaker re-trips off the identical prior streak on the next
  // risk check, and the old "bump CIRCUIT_BREAKER_LOSSES" hint papered over
  // the asymmetry between this path and the in-process one.
  ledger.resetCircuitBreaker(Date.now());
  console.log(
    JSON.stringify({
      msg: 'svx.resume',
      killFlagCleared: true,
      ledgerWasPaused: before.paused,
      ledgerPauseReason: before.reason,
      circuitBreakerWatermarkReset: true,
    }),
  );
  ledger.close();
}

/**
 * Reset the wallet-vs-ledger reconciliation baseline. Run this after
 * depositing/withdrawing pUSD — the invariant treats any unexplained wallet
 * move as a booking bug and pauses, so a legitimate funding event needs an
 * explicit acknowledgement. The bot re-snapshots the baseline on its next
 * balance refresh.
 */
function rebaseline(): void {
  const cfg = loadConfig();
  const ledger = new LedgerStore(path.join(path.resolve(cfg.dataDir), 'svx.sqlite'));
  const prior = ledger.getMeta('poly_reconcile_baseline');
  ledger.deleteMeta('poly_reconcile_baseline');
  console.log(
    JSON.stringify({
      msg: 'svx.rebaseline',
      priorBaseline: prior ? JSON.parse(prior) : null,
      hint: 'baseline cleared — the bot snapshots a fresh one on its next poly balance refresh (~60s after start)',
    }),
  );
  ledger.close();
}

/**
 * Supply dUSDC into Predict's PLP vault (the house side). Returns Coin<PLP>
 * share tokens to the operator wallet. See GET /plp-sim for why this is a
 * telemetry/demo position, not a yield product on today's surface.
 *
 *   svx supply-plp --amount 5 [--dry]
 */
async function supplyPlp(rest: string[]): Promise<void> {
  loadConfig();
  const i = rest.indexOf('--amount');
  const amount = i >= 0 && rest[i + 1] ? Number(rest[i + 1]) : 5;
  const dry = rest.includes('--dry');

  const { keypair, address } = loadOperatorKey();
  const sui = new SuiClient({ url: ADDRESSES.rpcUrl });
  const coins = await sui.getCoins({ owner: address, coinType: ADDRESSES.dusdcType });
  const balance = coins.data.reduce((a, c) => a + Number(c.balance), 0) / 1e6;
  console.log(
    JSON.stringify({
      msg: 'svx.supply_plp.plan',
      operator: address,
      walletDusdc: balance,
      supplyDusdc: amount,
      coinObjects: coins.data.length,
    }),
  );
  if (balance < amount) throw new Error(`wallet has ${balance} dUSDC < ${amount} requested`);
  if (dry) return;

  const tx = buildSupplyPlpTx({
    amountDusdc: amount,
    dusdcCoinObjectIds: coins.data.map((c) => c.coinObjectId),
    recipient: address,
  });
  const result = await submitTx(sui, tx, keypair);
  console.log(
    JSON.stringify({
      msg: result.ok ? 'svx.supply_plp.ok' : 'svx.supply_plp.failed',
      digest: result.digest,
      ...(result.ok
        ? { note: 'Coin<PLP> transferred to operator wallet; withdraw via predict::withdraw (rate-limited)' }
        : { error: result.error, status: result.status }),
    }),
  );
}

function printHelp(): void {
  console.log(`Usage: svx <command>

Commands:
  start [--once]    Run the bot scheduler. Paper mode by default; live mode
                    requires PAPER_TRADING=false in env. --once = single tick.
  pause             Set the manual kill flag (/tmp/svx-paused).
  resume            Clear ALL pause sources: kill flag + ledger pause state
                    (the latter is set by the daily-loss / consecutive-loss
                    circuit breakers) + circuit-breaker watermark.
  rebaseline        Reset the wallet-vs-ledger reconciliation baseline. Run
                    after depositing/withdrawing pUSD so the drift alarm
                    doesn't read the funding event as a booking bug.
  status            Print current bot status from the ledger.
  report            Print PnL summary.
  mint-ladder       Mint a range ladder (sigma/2 x 5 rungs, the simulation
                    winner) around ATM on the soonest oracle. --dry to plan
                    only; --notional N dUSDC per rung (default 2).
  supply-plp        Supply dUSDC into the PLP vault (returns Coin<PLP> share
                    tokens). --amount N (default 5); --dry to plan only.
`);
}

function printStatus(): void {
  const cfg = loadConfig();
  const ledger = new LedgerStore(path.join(path.resolve(cfg.dataDir), 'svx.sqlite'));
  const open = ledger.openTrades();
  const closed = ledger.closedTrades(50);
  const pnl = ledger.realizedPnlSince(0);
  const since24 = Date.now() - 24 * 3600_000;
  console.log(JSON.stringify({
    paused: ledger.getPause(),
    killFlagPresent: isKilled(),
    paperTrading: cfg.paperTrading,
    openTrades: open.length,
    recentClosed: closed.length,
    realizedPnlUsdc: pnl,
    signalsLast24h: ledger.countSignalsSince(since24),
    tradesLast24h: ledger.countTradesSince(since24),
    consecutiveLosses: ledger.consecutiveLosses(),
  }, null, 2));
  ledger.close();
}

function printReport(): void {
  const cfg = loadConfig();
  const ledger = new LedgerStore(path.join(path.resolve(cfg.dataDir), 'svx.sqlite'));
  const closed = ledger.closedTrades(10_000);
  const wins = closed.filter((t) => (t.pnlUsdc ?? 0) > 0).length;
  const totalPnl = closed.reduce((acc, t) => acc + (t.pnlUsdc ?? 0), 0);
  const totalCost = closed.reduce((acc, t) => acc + t.costUsdc, 0);
  console.log(JSON.stringify({
    closedTrades: closed.length,
    wins,
    losses: closed.length - wins,
    winRate: closed.length ? wins / closed.length : 0,
    totalPnlUsdc: totalPnl,
    totalCostUsdc: totalCost,
    roi: totalCost > 0 ? totalPnl / totalCost : 0,
  }, null, 2));
  ledger.close();
}

main().catch((e) => {
  log.error('svx.cli.error', { err: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
