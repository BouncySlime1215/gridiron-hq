import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { db, migrate } from './index.js';

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
 */
export async function runMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.+\.js$/.test(f)).sort();
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
