import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerStore } from '../src/ledger/store.js';

/**
 * Regression: opening a database created BEFORE the board_prob/slot columns
 * existed must migrate in place, not throw.
 *
 * The first cut of this migration put `CREATE INDEX ... (market_id, slot)` in
 * the schema block, which runs before the ALTER that adds `slot` — so every
 * pre-existing deployment crash-looped on "no such column: slot" at boot.
 */
function preMigrationDb(): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'svx-probe-mig-')),
    'svx.sqlite',
  );
  const db = new Database(file);
  db.exec(
    'CREATE TABLE v2_calibration_probes (id TEXT PRIMARY KEY, market_id TEXT NOT NULL,' +
      ' underlying TEXT NOT NULL, expiry_ms INTEGER NOT NULL, strike REAL NOT NULL,' +
      ' prob_up REAL NOT NULL, spot REAL NOT NULL, ttm_ms INTEGER NOT NULL,' +
      ' recorded_at_ms INTEGER NOT NULL, settlement_price REAL, outcome_up INTEGER,' +
      ' settled_at_ms INTEGER);' +
      ' CREATE INDEX ix_v2probe_market ON v2_calibration_probes(market_id);',
  );
  db.prepare(
    'INSERT INTO v2_calibration_probes VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run('legacy-1', 'mkt', 'BTC', 1, 64000, 0.8, 63000, 60000, 1, null, null, null);
  db.close();
  return file;
}

describe('v2 probe column migration', () => {
  it('migrates a pre-board_prob database in place, preserving rows', () => {
    const file = preMigrationDb();
    const store = new LedgerStore(file);
    const db = (store as unknown as { db: Database.Database }).db;
    const cols = (
      db.prepare('PRAGMA table_info(v2_calibration_probes)').all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(cols).toContain('board_prob');
    expect(cols).toContain('slot');
    const { c } = db.prepare('SELECT COUNT(*) c FROM v2_calibration_probes').get() as {
      c: number;
    };
    expect(c).toBe(1); // legacy row survives
  });

  it('is idempotent across restarts and supports slot dedupe', () => {
    const file = preMigrationDb();
    const store = new LedgerStore(file);
    store.insertV2CalibrationProbe({
      marketId: 'm2',
      underlying: 'BTC',
      expiryMs: 2,
      strike: 64000,
      probUp: 0.7,
      spot: 63000,
      ttmMs: 60_000,
      recordedAtMs: 2,
      boardProbUp: 0.66,
      slot: 't2m',
    });
    expect(store.hasV2ProbeSlot('m2', 't2m')).toBe(true);
    expect(store.hasV2ProbeSlot('m2', 't1h')).toBe(false);
    // Reopening the same file must not throw (index + columns already present).
    expect(() => new LedgerStore(file)).not.toThrow();
  });
});
