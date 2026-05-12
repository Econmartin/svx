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
import { loadConfig } from './config.js';
import { LedgerStore } from './ledger/store.js';
import { runBot } from './index.js';
import { setKillFlag, clearKillFlag, isKilled } from './ops/kill.js';
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
    case 'status':
      return printStatus();
    case 'report':
      return printReport();
    default:
      printHelp();
      process.exit(cmd ? 1 : 0);
  }
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
  console.log(
    JSON.stringify({
      msg: 'svx.resume',
      killFlagCleared: true,
      ledgerWasPaused: before.paused,
      ledgerPauseReason: before.reason,
      hint:
        'If pause was due to the consecutive-loss circuit breaker, also bump CIRCUIT_BREAKER_LOSSES — the bot will re-pause on the next tick if the current loss streak is still ≥ threshold.',
    }),
  );
  ledger.close();
}

function printHelp(): void {
  console.log(`Usage: svx <command>

Commands:
  start [--once]    Run the bot scheduler. Paper mode by default; live mode
                    requires PAPER_TRADING=false in env. --once = single tick.
  pause             Set the manual kill flag (/tmp/svx-paused).
  resume            Clear ALL pause sources: kill flag + ledger pause state
                    (the latter is set by the daily-loss / consecutive-loss
                    circuit breakers).
  status            Print current bot status from the ledger.
  report            Print PnL summary.
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
