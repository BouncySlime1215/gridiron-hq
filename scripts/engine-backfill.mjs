#!/usr/bin/env node
/**
 * ENGINE-00a backfill: copy the existing streams (ESPN transactions, lineups, news,
 * game lines, injuries, trade outcomes, chat counts/rates) into `engine_events`, then
 * record `engine.ingest`. Idempotent: a second run appends nothing new.
 *
 * Off-server by design: never run inside the web server process.
 *
 * Usage:
 *   GRIDIRON_DB_PATH=/path/to/copy.sqlite node scripts/engine-backfill.mjs
 *
 * The database must already carry migration 075 (start the server once, or run the
 * migrations); this script does not migrate, so it never takes the pre-migration
 * snapshot on its own. Prints one JSON object with per-stream counts.
 */
import { db, dbPath } from '../server/db/index.js';
import { backfillAll } from '../server/services/engine/backfill.js';

const has = t => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
if (!has('engine_events') || !has('engine_state')) {
  console.error(`engine tables missing on ${dbPath}: apply migration 075_engine_spine first`);
  process.exit(2);
}
const started = Date.now();
// No onEvent handlers are registered in this process, so dispatch is a no-op here;
// it stays on so a later daemon that imports this path gets its learners called.
const out = backfillAll();
console.log(JSON.stringify({
  db: dbPath, as_of: out.as_of, ms: Date.now() - started,
  streams: out.streams.map(s => ({ stream: s.stream, table: s.table, table_state: s.table_state,
    source_rows: s.source_rows, inserted: s.inserted, skipped: s.skipped, no_timestamp: s.no_timestamp })),
  total_events: db.prepare('SELECT COUNT(*) AS n FROM engine_events').get().n,
}, null, 2));
db.close();
