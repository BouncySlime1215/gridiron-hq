/**
 * Regression coverage for the missing `weekly_prediction_snapshots.mode`
 * column (see server/migrations/051_weekly_prediction_snapshot_mode.js).
 *
 * Commit 2ceefef (2026-09-12) taught weekly-learning.js's
 * captureWeeklyPredictions() to write a `mode` column ('position_ensemble' vs
 * 'cold_start_structural_only') and added the column via an ALTER guard
 * inside server/db/schema/mlb-model-misc.js's alters() -- one of the
 * fragments 000_legacy_schema.js runs. But db/index.js only ever calls that
 * fragment's up() when `000_legacy_schema` has never been recorded in
 * schema_migrations, and every real installation (including the live one,
 * which recorded it days before that commit) already has that row. The
 * fragment edit was therefore a silent no-op everywhere it mattered: the
 * live database's weekly_prediction_snapshots table had no `mode` column,
 * and the very first real capture would have thrown
 * `SQLITE_ERROR: table weekly_prediction_snapshots has no column named mode`
 * instead of recording anything -- defeating the cold-start fix the same
 * commit shipped, on every database that already existed.
 *
 * The first test below reproduces the exact schema state every pre-existing
 * database was left in (everything through migration 050, no `mode`) and
 * proves the new numbered migration repairs it. The second test drives the
 * real capture path end to end and proves it no longer throws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-weekly-mode-migration-'));
const MIGRATIONS_DIR = path.join(process.cwd(), 'server', 'migrations');
const open = [];

test.after(() => {
  for (const database of open) { try { database.close(); } catch { /* already closed */ } }
  fs.rmSync(temp, { recursive: true, force: true });
});

/** Every migration file up to and including `through`, in filename order. */
async function migrationsThrough(through) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.+\.js$/.test(f)).sort()
    .filter(f => f.replace(/\.js$/, '') <= through);
  const loaded = [];
  for (const file of files) loaded.push(await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href));
  return loaded;
}

function columnsOf(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

test('C: a database at migration 050 (every real database before this fix) has no `mode` column -- reproduces the live defect', async () => {
  const file = path.join(temp, `at-050-${Math.random().toString(36).slice(2)}.sqlite`);
  const database = new DatabaseSync(file);
  open.push(database);
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  for (const mod of await migrationsThrough('050_feature_revisions_entity_season_week')) {
    mod.up(database);
    database.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(mod.name);
  }
  assert.ok(!columnsOf(database, 'weekly_prediction_snapshots').includes('mode'),
    'this reproduces the live database: through migration 050, weekly_prediction_snapshots has no mode column');
});

test('C: migration 051 adds the missing `mode` column, and is idempotent', async () => {
  const file = path.join(temp, `at-050-then-051-${Math.random().toString(36).slice(2)}.sqlite`);
  const database = new DatabaseSync(file);
  open.push(database);
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  for (const mod of await migrationsThrough('050_feature_revisions_entity_season_week')) mod.up(database);
  const [m051] = await migrationsThrough('051_weekly_prediction_snapshot_mode').then(mods => mods.slice(-1));
  assert.equal(m051.name, '051_weekly_prediction_snapshot_mode');

  m051.up(database);
  assert.ok(columnsOf(database, 'weekly_prediction_snapshots').includes('mode'),
    'migration 051 must add the mode column');

  // Guarded like every other ALTER-add-column migration in this repo — a
  // second run (e.g. a stray direct call, or a future fixture built through
  // 051 twice) must not raise "duplicate column name".
  assert.doesNotThrow(() => m051.up(database));
  // down() is a documented no-op (purely additive, nullable column) — must
  // not throw either.
  assert.doesNotThrow(() => m051.down(database));
});

test('C: captureWeeklyPredictions no longer throws on a real pregame capture (end-to-end, through the real migration pipeline)', async () => {
  const dbFile = path.join(temp, 'e2e.sqlite');
  process.env.GRIDIRON_DB_PATH = dbFile;
  process.env.SCHEDULER_DISABLED = '1';

  const { db, run, rows } = await import('../server/db/index.js');
  const { runMigrations } = await import('../server/db/migrate.js');
  await runMigrations();
  const { captureWeeklyPredictions } = await import('../server/services/weekly-learning.js');
  test.after(() => { try { db.close(); } catch { /* already closed */ } });

  // A player with real prior-season usage (2090), so buildPlayerWeekEngine
  // has something to project from — the same minimal shape used by
  // test/qbr-projection-signal.test.js.
  run(`INSERT INTO players (id, name, position, espn_id, fantasy_relevant) VALUES (1,'Test RB','RB',9101,1)`);
  for (let w = 1; w <= 8; w++) {
    run(`INSERT INTO player_week_usage
      (player_id, season, week, team, opponent, position, carries, rushing_yards, rushing_tds,
       targets, receptions, receiving_yards, receiving_tds)
      VALUES (1,2090,?, 'AAA','OPP','RB', 14, 60, 0.4, 2, 1.5, 12, 0.05)`, w);
  }
  // A far-future week-1 slate that has not kicked off, so the capture is not
  // blocked by the "slate already started" guard — this is the ordinary,
  // once-a-week window the real scheduler runs in.
  run(`INSERT INTO game_lines (season,week,team,opponent,home,gameday,gametime,source,fetched_at)
       VALUES (2091,1,'AAA','BBB',1,'2091-09-10','13:00','test',datetime('now'))`);

  const result = captureWeeklyPredictions(2091, 1);
  assert.ok(!result.blocked, `capture should not be blocked: ${JSON.stringify(result)}`);
  assert.ok(result.captured >= 1, `expected at least one captured row, got ${JSON.stringify(result)}`);

  const stored = rows(`SELECT mode FROM weekly_prediction_snapshots WHERE season=2091 AND week=1 AND player_id=1`)[0];
  assert.ok(stored, 'the row must actually be persisted');
  assert.ok(['position_ensemble', 'cold_start_structural_only'].includes(stored.mode),
    `mode should be a recognized value, got ${stored.mode}`);
});
