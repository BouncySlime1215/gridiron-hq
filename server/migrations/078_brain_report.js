export const name = '078_brain_report';
/**
 * EVAL-01 `brain_report` — the brain's report card, E1-E7 (ENGINE-SPECS.md
 * EVAL-01). ADDITIVE ONLY: one new table and two indexes, IF NOT EXISTS
 * throughout; reads nothing, alters nothing, deletes nothing.
 *
 * One row per check per grader run, append-only; a run is all rows sharing
 * `run_id`. Written only by scripts/eval/run-graders.mjs (the refresh loop),
 * read by GET /api/brain-report and by the campaign producer through
 * server/services/eval/brain-rule.js (any 'failing' check -> BALANCED, testing
 * tier off).
 *
 * THE CHECKS ARE THE CONTRACT: a not_enough_data row must say how many more of
 * what it needs ("needs 40 more offers"); passing/failing rows must not. A
 * 'historical_fixed' row (E3's Sleeper replay) is a stored study result, never
 * a live grade, and says so in `source`.
 *
 * Numbered 078: 071 (#174, #184), 072 (#164, #166), 074 (#218), 075 (#216,
 * #220), 076 (#230 warroom_requests) and 077 (BROKEN-01 number_audit) are
 * claimed; 078 was assigned by the coordinator on 2026-09-23.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_report (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT NOT NULL,
      computed_at  TEXT NOT NULL,
      check_id     TEXT NOT NULL,
      name         TEXT,
      status       TEXT NOT NULL CHECK (status IN ('passing', 'not_enough_data', 'failing')),
      metric_name  TEXT NOT NULL,
      metric       REAL,
      ci_low       REAL,
      ci_high      REAL,
      n            INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
      needs_n      INTEGER,
      needs_unit   TEXT,
      needs_text   TEXT,
      pass_bar     TEXT NOT NULL,
      source       TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'historical_fixed')),
      detail_json  TEXT NOT NULL DEFAULT '{}',
      CHECK ((status = 'not_enough_data') = (needs_text IS NOT NULL)),
      CHECK (status <> 'not_enough_data' OR (needs_n >= 1 AND needs_unit IS NOT NULL)),
      CHECK ((ci_low IS NULL) = (ci_high IS NULL)),
      CHECK (ci_low IS NULL OR ci_low <= ci_high)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_brain_report_run_check ON brain_report(run_id, check_id);
    CREATE INDEX IF NOT EXISTS idx_brain_report_check ON brain_report(check_id, computed_at);
  `);
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_brain_report_check;
    DROP INDEX IF EXISTS idx_brain_report_run_check;
    DROP TABLE IF EXISTS brain_report;
  `);
}
