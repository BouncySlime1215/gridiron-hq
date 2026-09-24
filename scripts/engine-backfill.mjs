#!/usr/bin/env node
/**
 * ENGINE-00a / EA-00 backfill: copy the existing streams (ESPN transactions, lineups, news,
 * game lines, injuries, trade outcomes, manager signals, collector coverage) into
 * `engine_events` as provenance 'reconstructed', then record `engine.ingest`, then print
 * the bytes per row of the engine tables (dbstat). Idempotent: a second run appends only
 * what changed in the sources (compare-latest by natural key).
 *
 * Off-server by design: role `script`, never inside the web server process.
 *
 * Usage:
 *   GRIDIRON_DB_PATH=/path/to/copy.sqlite node scripts/engine-backfill.mjs
 *
 * The database must already carry migration 075 (start the server once, or run the
 * migrations); this script does not migrate, so it never takes the pre-migration snapshot
 * on its own. Prints one JSON object with per-stream counts and bytes per row.
 */
// Before any import that reaches the engine: this process is a script (a writer role).
process.env.GRIDIRON_PROCESS_ROLE = 'script';
process.env.SCHEDULER_DISABLED ??= '1';

const { db, dbPath } = await import('../server/db/index.js');
const { backfillAll, measureEngineBytes } = await import('../server/services/engine/backfill.js');

const has = t => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
const hasLane = () => db.prepare('PRAGMA table_info(engine_state)').all().some(c => c.name === 'lane');
if (!has('engine_events') || !has('engine_state') || !has('engine_fields') || !hasLane()) {
  console.error(`engine tables (schema v2) missing on ${dbPath}: apply migration 075_engine_spine first`);
  process.exit(2);
}
const started = Date.now();
const out = backfillAll();
const ms = Date.now() - started;
console.log(JSON.stringify({
  db: dbPath, as_of: out.as_of, ms,
  streams: out.streams.map(s => ({ stream: s.stream, table: s.table, table_state: s.table_state,
    source_rows: s.source_rows, inserted: s.inserted, skipped: s.skipped, no_timestamp: s.no_timestamp })),
  total_events: db.prepare('SELECT COUNT(*) AS n FROM engine_events').get().n,
  total_entities: db.prepare('SELECT COUNT(*) AS n FROM engine_event_entities').get().n,
  as_of_quality: db.prepare('SELECT as_of_quality, COUNT(*) AS n FROM engine_events GROUP BY 1 ORDER BY 1').all(),
  bytes: measureEngineBytes(db),
}, null, 2));
db.close();
