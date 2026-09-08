#!/usr/bin/env node
/**
 * Prove two ways of building the database produce the same schema.
 *
 * The legacy path creates ~225 tables at import time, scattered across 122
 * service/route files, and only then runs the numbered migrations. The
 * centralized path applies server/migrations/000_legacy_schema.js at open and
 * never relies on a service import for DDL. "Centralizing" is only correct if
 * a fresh database built each way is indistinguishable — every table, column,
 * index and trigger, with the same stored SQL. This script builds a fresh
 * database one way and dumps a normalized snapshot; diff two snapshots to
 * check.
 *
 *   node scripts/schema-snapshot.mjs --mode legacy   --out golden.json
 *   node scripts/schema-snapshot.mjs --mode baseline --out after.json
 *   node scripts/schema-snapshot.mjs --mode full     --out after-full.json
 *
 *   legacy    import every DDL-bearing module (production import order first),
 *             then runMigrations() — what the app did before centralization.
 *   baseline  open the database (which applies 000_legacy_schema), then
 *             runMigrations(); import NO services. Equal to legacy only if the
 *             baseline is complete and every definition is identical.
 *   full      baseline, then import every module — proves the modules' own
 *             leftover DDL (if any) is a no-op and nothing throws at import.
 *
 * Always runs against a throwaway database in a temp directory; never the
 * real one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const [k, v] = a.slice(2).split('=');
  args[k] = v ?? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true);
}
const mode = args.mode ?? 'legacy';
const out = args.out ? path.resolve(args.out) : null;

const temp = fs.mkdtempSync(path.join(os.tmpdir(), `gridiron-schema-${mode}-`));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'snapshot.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';

/** Production import order first (server/index.js), then every other DDL-bearing file. */
function moduleList() {
  const indexSrc = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  const fromIndex = [...indexSrc.matchAll(/await import\('(\.\/[^']+)'\)/g)].map(m => 'server/' + m[1].slice(2));
  const listed = fs.existsSync(path.join(root, 'scripts/schema-files.txt'))
    ? fs.readFileSync(path.join(root, 'scripts/schema-files.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
    : [];
  const seen = new Set();
  return [...fromIndex, ...listed].filter(f => f.endsWith('.js') && !seen.has(f) && seen.add(f));
}

async function importAll() {
  const failures = [];
  for (const rel of moduleList()) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    try { await import(pathToFileURL(file).href); }
    catch (error) { failures.push({ module: rel, error: error.message.split('\n')[0] }); }
  }
  return failures;
}

const normalize = sql => sql == null ? null : sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();

function dump(db, failures) {
  const master = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all()
    .map(r => ({ ...r, sql: normalize(r.sql) }));
  const columns = {};
  for (const t of master.filter(r => r.type === 'table')) {
    columns[t.name] = db.prepare(`PRAGMA table_info("${t.name}")`).all()
      .map(c => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk }));
  }
  const migrations = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map(r => r.name);
  return { mode, counts: { tables: master.filter(r => r.type === 'table').length,
    indexes: master.filter(r => r.type === 'index').length,
    triggers: master.filter(r => r.type === 'trigger').length, views: master.filter(r => r.type === 'view').length },
  import_failures: failures, migrations, master, columns };
}

const { db } = await import(pathToFileURL(path.join(root, 'server/db/index.js')).href);
const { runMigrations } = await import(pathToFileURL(path.join(root, 'server/db/migrate.js')).href);
let failures = [];
if (mode === 'legacy') { failures = await importAll(); await runMigrations(); }
else if (mode === 'baseline') { await runMigrations(); }
else if (mode === 'full') { await runMigrations(); failures = await importAll(); }
else { console.error(`unknown mode ${mode}`); process.exit(2); }

const snapshot = dump(db, failures);
const text = JSON.stringify(snapshot, null, 2);
if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
console.error(`[${mode}] ${snapshot.counts.tables} tables, ${snapshot.counts.indexes} indexes, `
  + `${snapshot.counts.triggers} triggers, ${failures.length} import failures${out ? ` -> ${out}` : ''}`);
for (const f of failures) console.error(`  import failed: ${f.module}: ${f.error}`);
db.close();
fs.rmSync(temp, { recursive: true, force: true });
// Imported modules may have started timers; the snapshot is written, so exit.
process.exit(0);
