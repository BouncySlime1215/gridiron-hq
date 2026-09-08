export const name = '021_quote_tape_batch_index';

/**
 * The dataset builder (nfl-evidence-dataset.js) walks nfl_quote_batches and
 * runs one SELECT per batch filtered by batch_id. nfl_quote_tape's only
 * indexes lead with provider_event_id and home_team/away_team — neither
 * helps a batch_id lookup, so every one of those per-batch queries was a
 * full table scan. At 624 batches over 752,954 rows that's ~470 million row
 * scans for one dataset build, discovered when a real run against a live-DB
 * copy took 15+ minutes instead of the few seconds the row count justifies.
 */
export function up(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_nfl_quote_tape_batch ON nfl_quote_tape(batch_id)`);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_nfl_quote_tape_batch`);
}
