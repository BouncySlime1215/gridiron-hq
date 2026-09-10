import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db, dbPath, migrate, backupBeforeMigration, LEGACY_SCHEMA_MIGRATION } from './index.js';
import { planPreflightRepairs, applyPreflightRepairs } from './preflight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/**
 * Applies every migration under server/migrations/, in filename order, exactly
 * once each — application is tracked in the schema_migrations table by
 * db/index.js's migrate(), so this is safe (a no-op after the first) on every
 * process boot. Each file must default-export { name, up(db) }.
 *
 * This only governs schema added through this mechanism going forward. Most
 * existing tables are still created ad-hoc at import time across ~40 route/
 * service files (see the comment on migrate() in db/index.js) — centralizing
 * those is a separate, higher-risk project this does not attempt.
 *
 * Ahead of the first file, preflight repairs get a look at the database. They
 * exist for the one class of damage a migration cannot fix from inside its own
 * transaction — see server/db/preflight.js — and a migration that cannot start
 * blocks the whole application, so this is the last moment at which anything
 * can be done about it. On a healthy database the check is three catalogue
 * queries and no writes.
 *
 * `database`/`databasePath` default to the process connection; they are
 * parameters so migration behaviour can be exercised against a fixture
 * database built at an older version, which is the only honest way to test
 * what an upgrade does to rows that already exist.
 */
export async function runMigrations(database = db, databasePath = dbPath) {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.+\.js$/.test(f)).sort();
  const pendingCount = files.filter(f => {
    const name = f.replace(/\.js$/, '');
    return !database.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name);
  }).length;
  const repairs = planPreflightRepairs(database);
  // One snapshot, taken before anything at all changes — repairs included.
  if (pendingCount > 0 || repairs.length) {
    backupBeforeMigration(repairs.length ? `preflight repair and ${pendingCount} migration(s)` : 'new migrations',
      database, databasePath);
  }
  applyPreflightRepairs(database, repairs);
  const applied = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href);
    const name = mod.name ?? file.replace(/\.js$/, '');
    if (typeof mod.up !== 'function') throw new Error(`migration ${file} has no up(db) export`);
    let ran = false;
    migrate(name, () => { mod.up(database); ran = true; }, database);
    if (ran) applied.push(name);
  }
  return applied;
}

export async function rollbackMigration(expectedName = null, database = db) {
  // The frozen baseline is never "the latest change": rolling back skips over it.
  const applied = database.prepare('SELECT name FROM schema_migrations WHERE name <> ? ORDER BY rowid DESC LIMIT 1')
    .get(LEGACY_SCHEMA_MIGRATION);
  if (!applied) return null;
  if (expectedName && applied.name !== expectedName) {
    throw new Error(`rollback refused: latest migration is ${applied.name}, not ${expectedName}`);
  }
  const file = fs.readdirSync(MIGRATIONS_DIR).find(f => f.replace(/\.js$/, '') === applied.name);
  if (!file) throw new Error(`rollback module not found for ${applied.name}`);
  const mod = await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href);
  if (typeof mod.down !== 'function') throw new Error(`migration ${applied.name} has no down(db) export`);
  database.exec('BEGIN IMMEDIATE');
  try {
    mod.down(database);
    database.prepare('DELETE FROM schema_migrations WHERE name=?').run(applied.name);
    database.exec('COMMIT');
    return applied.name;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
