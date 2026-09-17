#!/usr/bin/env node
/**
 * Build a small, throwaway /tmp database that lets `buildPlayerWeekEngine`
 * and `ensembleLine` run against REAL historical data, without ever opening
 * the real `data.sqlite` read-write.
 *
 * Why this exists instead of a plain file copy: the real database is a
 * live-WAL-mode file (~13 GB main + ~3 GB WAL as of this run) being written
 * by a real capture process right now. This project's own `server/db/index.js`
 * opens whatever `GRIDIRON_DB_PATH` points to READ-WRITE and runs schema
 * migrations as a side effect of being imported at all — so it must never be
 * pointed at the real path. Instead:
 *
 *   1. Point GRIDIRON_DB_PATH at a brand-new file that does not exist yet and
 *      import server/db/index.js — this bootstraps the FULL current schema
 *      (via its own `applyLegacySchema` migration) into that new file, which
 *      is safe because it is a file we just created, not the real one.
 *   2. Open the real database SEPARATELY, via node:sqlite's `{readOnly:true}`
 *      (the pattern this worktree's Stage 1 script already established and
 *      the safety protocol explicitly encourages), and copy over only the
 *      real DATA — not a byte-for-byte file copy, a table-by-table logical
 *      copy — for every table under a size threshold. This is a few hundred
 *      thousand rows across ~230 tables (~1.05M rows measured on this run),
 *      not the 29M+ rows sitting in market-quote tables this validation has
 *      no use for, so it finishes in seconds rather than copying 16 GB.
 *
 * The real file is opened read-only and never written. Nothing here ever
 * calls `.run`, `.exec` with a mutating statement, or opens a write handle
 * against any path containing the real project's data.sqlite.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const REAL_DB_PATH = process.env.GRIDIRON_REAL_DB_PATH
  ?? new URL('../server/data.sqlite', import.meta.url).pathname;
const DEST = process.argv[2];
if (!DEST) { console.error('usage: node scripts/_prepare-validation-db.mjs <dest-sqlite-path>'); process.exit(1); }
if (path.resolve(DEST) === path.resolve(REAL_DB_PATH) || DEST.includes('fantasy-football-dashboard/server/data.sqlite')) {
  throw new Error('Refusing: destination must not be the real database.');
}

mkdirSync(path.dirname(DEST), { recursive: true });
if (existsSync(DEST)) rmSync(DEST);
for (const suffix of ['-wal', '-shm']) if (existsSync(DEST + suffix)) rmSync(DEST + suffix);

console.log(`[prep] bootstrapping fresh schema at ${DEST} ...`);
process.env.GRIDIRON_DB_PATH = DEST;
const { db: newDb } = await import('../server/db/index.js');

console.log(`[prep] opening REAL database read-only: ${REAL_DB_PATH}`);
const real = new DatabaseSync(REAL_DB_PATH, { readOnly: true });

const EXCLUDE_PATTERN = /^(mlb_|polymarket_|prediction_market_)/;
// Excluded by name: unrelated sport, or market-quote/mutation-log tables that
// are 1-2 orders of magnitude larger than everything this validation reads,
// and touch no code path buildPlayerWeekEngine/ensembleLine actually calls.
const EXCLUDE_TABLES = new Set([
  'nfl_blind_input_mutations', 'nfl_line_snapshots', 'nfl_quote_tape', 'nfl_odds_archive',
  'nfl_play_by_play', 'nfl_play_charting', 'nfl_play_formations', 'nfl_prop_quote_snapshots',
  'nfl_weekly_expert_examples', 'nfl_verified_events', 'nfl_signal_snapshots'
]);

const tables = real.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).all().map(t => t.name);

let totalRows = 0, tablesCopied = 0;
const started = Date.now();
for (const t of tables) {
  if (EXCLUDE_PATTERN.test(t) || EXCLUDE_TABLES.has(t)) continue;
  let newCols;
  try {
    newCols = newDb.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
  } catch { continue; }
  if (!newCols.length) continue; // table not part of the current schema at all
  const realCols = real.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
  const common = newCols.filter(c => realCols.includes(c));
  if (!common.length) continue;
  const colList = common.map(c => `"${c}"`).join(',');
  const sourceRows = real.prepare(`SELECT ${colList} FROM "${t}"`).all();
  if (!sourceRows.length) continue;
  const placeholders = common.map(() => '?').join(',');
  const insert = newDb.prepare(`INSERT INTO "${t}" (${colList}) VALUES (${placeholders})`);
  newDb.exec('BEGIN');
  try {
    for (const row of sourceRows) insert.run(...common.map(c => row[c]));
    newDb.exec('COMMIT');
  } catch (err) {
    newDb.exec('ROLLBACK');
    console.warn(`[prep] skipped ${t}: ${err.message}`);
    continue;
  }
  totalRows += sourceRows.length;
  tablesCopied++;
}
real.close();
console.log(`[prep] copied ${totalRows} rows across ${tablesCopied} tables in ${Date.now() - started}ms`);
console.log(`[prep] validation database ready at ${DEST} (real file untouched, read-only throughout)`);
