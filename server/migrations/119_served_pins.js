export const name = '119_served_pins';
/**
 * SERVE-LOG REPRO (batch D item 31). Additive only: one new table, one index.
 *
 * `served_pins` — one row per served response (per surface), next to that
 * response's `served_numbers` rows and written in the same transaction by
 * server/services/serve-log.js, only while GRIDIRON_SERVE_PIN=1. It pins the
 * numbers to what made them: the running commit (`code_sha`), the sha256 of
 * the league payload (`snapshot_sha256`), the seed, and the full pin JSON
 * (producer arguments, extractor context, seed basis). scripts/eval/repro-card.mjs
 * reads it back to re-run a card.
 *
 * Keyed (request_id, surface): the weekly snapshot shares one request id
 * across its surfaces. Numbered 119: 118 is claimed by #516 (DATA QUALITY).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS served_pins (
      request_id TEXT NOT NULL,
      league_id INTEGER NOT NULL,
      surface TEXT NOT NULL,
      served_at TEXT NOT NULL,
      code_sha TEXT,
      snapshot_sha256 TEXT,
      seed INTEGER,
      pin TEXT NOT NULL,
      PRIMARY KEY (request_id, surface)
    );
    CREATE INDEX IF NOT EXISTS idx_served_pins_league
      ON served_pins(league_id, served_at);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_served_pins_league');
  db.exec('DROP TABLE IF EXISTS served_pins');
}
