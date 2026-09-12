export const name = '037_nfl_clv_grades';

/**
 * Giant Plan section 8.10/8.1, audit-consolidation stage 1.
 *
 * CLV (closing-line value) grading is how a decision is judged against the
 * market's own final answer: did the price this system took beat the price
 * the market closed at. That grade is itself a claim that needs the same
 * treatment as every other piece of evidence in this schema — recorded once,
 * against a stated close and a stated book set, and never quietly rewritten
 * later because a different close source or a later re-grade produced a
 * different number.
 *
 * `nfl_clv_grades` follows the append-only pattern `nfl_decision_events` and
 * `nfl_decision_runs` established in migration 027: a BEFORE UPDATE/DELETE
 * trigger on the row, so a re-grade is a NEW row (a new `grading_version`)
 * rather than an edit that erases what an earlier grade said. Re-grading
 * against a different close source, or after a bug fix to the grading logic,
 * is common and expected — overwriting the earlier grade in place is not,
 * because it would make "what did we think the CLV was on 2026-09-14" an
 * unanswerable question the moment anyone re-ran the grader.
 *
 * `decision_event_id` and `opportunity_id` are both nullable and neither is a
 * foreign key: a grade may be computed against either the immutable decision
 * tape (migration 027's `nfl_decision_events`) or the execution ledger's
 * opportunity row (migration 023/027's `nfl_execution_opportunities`)
 * depending on which pipeline produced the priced side being graded, and a
 * hard foreign key on both would force every grader to populate a column it
 * has no source for. At least one of the two is expected to be non-null in
 * practice; that expectation is documented, not enforced by a CHECK, because
 * enforcing it here would block a future third linkage this migration cannot
 * anticipate.
 *
 * `quote_ids` is a JSON array (TEXT), not a normalized join table: a CLV grade
 * is computed from potentially several close quotes across a `book_set`
 * (e.g. a consensus close across multiple books), and the set of ids used is
 * part of the grade's own evidence — retained the same way
 * `feature_lineage.values` is retained on the forecast packet, per the same
 * "a hash without retained content cannot reconstruct a decision" principle.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfl_clv_grades (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decision_event_id INTEGER,
      opportunity_id TEXT,
      grading_version TEXT NOT NULL,
      book_set TEXT NOT NULL,
      quote_ids TEXT NOT NULL,
      point_clv REAL,
      price_clv_probability REAL,
      close_source TEXT NOT NULL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_clv_grades_decision_event ON nfl_clv_grades(decision_event_id);
    CREATE INDEX IF NOT EXISTS idx_clv_grades_opportunity ON nfl_clv_grades(opportunity_id);
    CREATE INDEX IF NOT EXISTS idx_clv_grades_version ON nfl_clv_grades(grading_version);

    CREATE TRIGGER IF NOT EXISTS nfl_clv_grades_no_update
      BEFORE UPDATE ON nfl_clv_grades
      BEGIN SELECT RAISE(ABORT, 'CLV grades are append-only — record a new grading_version instead'); END;
    CREATE TRIGGER IF NOT EXISTS nfl_clv_grades_no_delete
      BEFORE DELETE ON nfl_clv_grades
      BEGIN SELECT RAISE(ABORT, 'CLV grades are append-only — record a new grading_version instead'); END;
  `);
}

export function down(db) {
  const graded = db.prepare(`SELECT COUNT(*) n FROM nfl_clv_grades`).get()?.n ?? 0;
  if (graded) {
    throw new Error(
      `037_nfl_clv_grades: refusing to downgrade — ${graded} CLV grade(s) are recorded. Dropping the table ` +
      'would erase the only record of how each priced decision was judged against the market close.');
  }
  db.exec(`
    DROP TRIGGER IF EXISTS nfl_clv_grades_no_update;
    DROP TRIGGER IF EXISTS nfl_clv_grades_no_delete;
    DROP TABLE IF EXISTS nfl_clv_grades;
  `);
}
