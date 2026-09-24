export const name = '077_number_audit';
/**
 * BROKEN-01a. Additive only: one new table.
 *
 * `number_audit` — the current verdict of each number-health check per league,
 * written by the off-server refresh loop (scripts/refresh-live-data.mjs ->
 * server/services/number-audit.js#runNumberAudit) and read, never computed, by
 * GET /api/number-audit (server/routes/number-audit.js) for the Settings
 * "Number health" card and the nav dot.
 *
 * One row per (league_id, check_id), upserted each audit: the table holds what
 * is true now, not a history, so it cannot grow with the loop. `first_seen_at`
 * keeps the time a check entered its current status, so the card can say how
 * long a number has been broken.
 *
 * Numbered 077: 071 (#174, #184), 072 (#164, #166), 074 (#218), 075 (#216,
 * #220) and 076 (#230) are claimed by open PRs, 078 by the EVAL graders; main
 * ends at 073.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS number_audit (
      league_id INTEGER NOT NULL,
      check_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok', 'warn', 'broken')),
      inventory_row TEXT,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      cause TEXT,
      trust TEXT,
      pages_affected TEXT NOT NULL DEFAULT '[]',
      values_json TEXT NOT NULL DEFAULT '{}',
      as_of TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY (league_id, check_id)
    );
    CREATE INDEX IF NOT EXISTS idx_number_audit_status ON number_audit(league_id, status);
  `);
}

export function down(db) {
  db.exec('DROP INDEX IF EXISTS idx_number_audit_status');
  db.exec('DROP TABLE IF EXISTS number_audit');
}
