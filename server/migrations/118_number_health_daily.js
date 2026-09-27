export const name = '118_number_health_daily';
/**
 * DATA QUALITY PANEL (Batch D item 35). Additive only: one new table.
 *
 * `number_health_daily` — one row per league per UTC day: how many number-audit checks were
 * broken, warn and ok after that day's last audit. `number_audit` (077) holds only what is true
 * now, so it cannot show a trend; this is the history, written inside the same transaction as
 * the audit rows (number-audit.js#writeAuditRows) and read by GET /api/data-quality.
 *
 * Bounded by leagues x days (five leagues, one row a day), so it needs no pruning.
 *
 * Numbered 118: main ends at 117 (ai_usage_source).
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS number_health_daily (
      league_id INTEGER NOT NULL,
      day       TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      broken    INTEGER NOT NULL CHECK (broken >= 0),
      warn      INTEGER NOT NULL CHECK (warn >= 0),
      ok        INTEGER NOT NULL CHECK (ok >= 0),
      as_of     TEXT NOT NULL,
      PRIMARY KEY (league_id, day)
    );
  `);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS number_health_daily');
}
