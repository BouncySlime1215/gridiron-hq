import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db, dbPath, migrate } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

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
 * after it is preceded by one, on the reasoning that a schema change is
 * exactly the moment a bug is most likely to reach a file with real history
 * behind it. Snapshots are not pruned automatically — recovery after a bad
 * migration is worth more than the disk they cost, and this project already
 * leaves manual reset backups in place for the same reason.
 */
function backupBeforeMigration() {
  const priorMigrations = db.prepare('SELECT COUNT(*) n FROM schema_migrations').get()?.n ?? 0;
  if (!priorMigrations || !dbPath || dbPath === ':memory:') return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.pre-migration-${stamp}.bak`;
  const startedAt = Date.now();
  console.log(`[db] backing up ${dbPath} to ${backupPath} before applying new migrations…`);
  db.prepare(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`).run();
  console.log(`[db] backup complete in ${Date.now() - startedAt}ms`);
  return backupPath;
}

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
 */
export async function runMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.+\.js$/.test(f)).sort();
  const pendingCount = files.filter(f => {
    const name = f.replace(/\.js$/, '');
    return !db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name);
  }).length;
  if (pendingCount > 0) backupBeforeMigration();
  const applied = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href);
    const name = mod.name ?? file.replace(/\.js$/, '');
    if (typeof mod.up !== 'function') throw new Error(`migration ${file} has no up(db) export`);
    let ran = false;
    migrate(name, () => { mod.up(db); ran = true; });
    if (ran) applied.push(name);
  }
  return applied;
}

export async function rollbackMigration(expectedName = null) {
  const applied = db.prepare('SELECT name FROM schema_migrations ORDER BY rowid DESC LIMIT 1').get();
  if (!applied) return null;
  if (expectedName && applied.name !== expectedName) {
    throw new Error(`rollback refused: latest migration is ${applied.name}, not ${expectedName}`);
  }
  const file = fs.readdirSync(MIGRATIONS_DIR).find(f => f.replace(/\.js$/, '') === applied.name);
  if (!file) throw new Error(`rollback module not found for ${applied.name}`);
  const mod = await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href);
  if (typeof mod.down !== 'function') throw new Error(`migration ${applied.name} has no down(db) export`);
  db.exec('BEGIN IMMEDIATE');
  try {
    mod.down(db);
    db.prepare('DELETE FROM schema_migrations WHERE name=?').run(applied.name);
    db.exec('COMMIT');
    return applied.name;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
