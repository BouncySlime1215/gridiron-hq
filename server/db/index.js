import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { up as applyLegacySchema } from '../migrations/000_legacy_schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Tests and offline diagnostics can point at an isolated database instead of
// mutating the user's league file. Production keeps the original local path.
const DB_PATH = process.env.GRIDIRON_DB_PATH || path.join(__dirname, '..', 'data.sqlite');

export const dbPath = DB_PATH;
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 15000;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  );
`);

/**
 * Run a one-time, named migration. This is the ONLY way schema changes enter
 * this database now: the ad-hoc `CREATE TABLE IF NOT EXISTS` blocks that used
 * to run at import time across 122 route/service files were lifted into
 * server/db/schema/ and are applied by 000_legacy_schema below, then deleted
 * from those files. `schema_migrations` (above) and `db_health_checks` (below)
 * are the two exceptions that must still be created here, because they
 * bootstrap the mechanism that applies everything else.
 */
export function migrate(name, fn) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** The one migration every real database already has the body of; it never counts as history worth a snapshot on its own. */
export const LEGACY_SCHEMA_MIGRATION = '000_legacy_schema';

/**
 * A pre-migration snapshot, taken only when there is schema history worth
 * protecting and new schema about to be applied to it.
 *
 * `VACUUM INTO` (not a raw file copy) because the live database runs in WAL
 * mode: copying `data.sqlite` alone can miss committed pages still sitting in
 * `data.sqlite-wal`, producing a backup that looks complete but is quietly
 * behind. `VACUUM INTO` asks SQLite itself for a consistent single-file
 * snapshot, the same way it already answers every other query.
 *
 * Skipped on a database that has never had a migration applied — there is
 * nothing there yet that a failed first migration could lose, and it is what
 * keeps every test's fresh temp database from paying for a snapshot of an
 * empty file on every run. Once real schema history exists, every migration
 * after it is preceded by one. Snapshots are not pruned automatically —
 * recovery after a bad migration is worth more than the disk they cost, and
 * this project already leaves manual reset backups in place for the same reason.
 */
export function backupBeforeMigration(reason = 'migrations') {
  const prior = db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE name <> ?')
    .get(LEGACY_SCHEMA_MIGRATION)?.n ?? 0;
  if (!prior || !DB_PATH || DB_PATH === ':memory:') return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${DB_PATH}.pre-migration-${stamp}.bak`;
  const startedAt = Date.now();
  console.log(`[db] backing up ${DB_PATH} to ${backupPath} before ${reason}…`);
  db.prepare(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`).run();
  console.log(`[db] backup complete in ${Date.now() - startedAt}ms`);
  return backupPath;
}

/**
 * Everything that used to be created at import time by 122 service and route
 * files, applied once, here, before any of them can run. On a fresh database
 * this is the whole schema; on an existing one it is an idempotent no-op that
 * only records the marker. Those files no longer carry their own copies —
 * phase 2 deleted them — so importing a service can no longer create, alter
 * or silently redefine a table. scripts/schema-snapshot.mjs is the standing
 * proof: `--mode baseline` (migrations only, zero service imports) and
 * `--mode full` (migrations plus every module) must stay byte-identical.
 * If they ever diverge, some file has started creating schema again.
 */
if (!db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(LEGACY_SCHEMA_MIGRATION)) {
  backupBeforeMigration(LEGACY_SCHEMA_MIGRATION);
  migrate(LEGACY_SCHEMA_MIGRATION, () => applyLegacySchema(db));
}

// A full integrity_check scans the entire database. Once historical NFL evidence
// grew past 2 GB, doing that on every import made each server and worker process
// spend tens of seconds proving the same file healthy. Persist the last result,
// run the lighter quick_check at most daily by default, and retain an explicit
// full mode for maintenance windows.
db.exec(`CREATE TABLE IF NOT EXISTS db_health_checks (
  check_name TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  result TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
)`);
const integrityMode = String(process.env.GRIDIRON_DB_INTEGRITY_CHECK ?? 'quick').toLowerCase();
const integrityIntervalHours = Math.max(1,
  Number(process.env.GRIDIRON_DB_INTEGRITY_INTERVAL_HOURS) || 24);
if (integrityMode !== 'off') {
  const checkName = integrityMode === 'full' ? 'integrity_check' : 'quick_check';
  const lastCheck = db.prepare('SELECT checked_at FROM db_health_checks WHERE check_name=?').get(checkName);
  const lastCheckMs = Date.parse(lastCheck?.checked_at ?? '');
  const due = !Number.isFinite(lastCheckMs)
    || Date.now() - lastCheckMs >= integrityIntervalHours * 60 * 60 * 1000;
  if (due) {
    const startedAt = performance.now();
    try {
      const result = integrityMode === 'full'
        ? db.prepare('PRAGMA integrity_check').get()?.integrity_check
        : db.prepare('PRAGMA quick_check(1)').get()?.quick_check;
      const durationMs = Math.round(performance.now() - startedAt);
      db.prepare(`INSERT INTO db_health_checks(check_name,checked_at,result,duration_ms)
        VALUES (?,datetime('now'),?,?) ON CONFLICT(check_name) DO UPDATE SET
        checked_at=excluded.checked_at,result=excluded.result,duration_ms=excluded.duration_ms`)
        .run(checkName, String(result ?? 'no result'), durationMs);
      if (result !== 'ok') console.error(`[db] ${checkName} reported a problem:`, result);
    } catch (e) {
      console.error(`[db] ${checkName} failed to run:`, e.message);
    }
  }
}

// migrate the old single-league espn_settings row into leagues
const legacy = db.prepare('SELECT * FROM espn_settings WHERE id = 1').get();
if (legacy?.league_id) {
  const exists = db.prepare(`SELECT 1 FROM leagues WHERE platform='espn' AND league_id=? AND season=?`)
    .get(String(legacy.league_id), legacy.season);
  if (!exists) {
    db.prepare(`INSERT INTO leagues (platform, league_id, season, my_team_id, espn_s2, swid)
                VALUES ('espn', ?, ?, ?, ?, ?)`)
      .run(String(legacy.league_id), legacy.season, legacy.team_id != null ? String(legacy.team_id) : null,
        legacy.espn_s2, legacy.swid);
  }
}

export function rows(sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function row(sql, ...params) {
  return db.prepare(sql).get(...params);
}
export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}
