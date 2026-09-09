export const name = '024_candidate_findings';

/**
 * Phase 3 of the 2026-09-09 learning-pipeline plan: a place for a
 * segment-bias finding (nfl-replay.js's analyzeErrors) to accumulate
 * independent evidence over multiple seasons before anything acts on it,
 * mirroring model-governance.js's model_registry/model_gate_audits pattern
 * at segment-finding grain instead of whole-model grain.
 *
 * The lifecycle: pending_confirmation -> discovered -> validating ->
 * validated -> flagged_for_review -> promoted/rejected. Every transition
 * through flagged_for_review is driven automatically by real evidence and
 * changes nothing live -- it only ever records a fact. flagged_for_review ->
 * promoted is the one transition a person makes explicitly
 * (promoteFindingToShrink in nfl-candidate-findings.js), the same split
 * model-governance.js already draws between recordGateAudit (automatic) and
 * promoteEligibleAudit (a distinct, explicitly-invoked function).
 *
 * `nfl_candidate_finding_seasons` is the enforcement mechanism for "a season
 * can never change role": every season a finding has ever touched, in
 * whichever role it was first used in, is a permanent row here. Before
 * either a new discovery flag or a new holdout test uses a season, the code
 * checks this table and refuses if that season already has a DIFFERENT role
 * recorded for this finding -- a database constraint (not just application
 * logic) makes this the actual source of truth.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfl_candidate_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_key TEXT NOT NULL UNIQUE,
      dimension TEXT NOT NULL,
      segment TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('weak','strong')),
      rule_definition_hash TEXT,
      state TEXT NOT NULL DEFAULT 'pending_confirmation'
        CHECK(state IN ('pending_confirmation','discovered','validating','validated','flagged_for_review','promoted','rejected')),
      discovery_seasons_json TEXT,
      first_flagged_at TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_at TEXT,
      validated_at TEXT,
      flagged_at TEXT,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT,
      code_hash TEXT,
      data_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_candidate_findings_state ON nfl_candidate_findings(state);

    -- One row per (finding, season) the finding has ever touched, in
    -- whichever role first used it. UNIQUE(finding_id, season) is the actual
    -- enforcement of "a season can never change role" -- a second attempt to
    -- insert a different role for the same (finding, season) violates this
    -- constraint at the database level, not just in application code.
    CREATE TABLE IF NOT EXISTS nfl_candidate_finding_seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      finding_id INTEGER NOT NULL REFERENCES nfl_candidate_findings(id) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('discovery','holdout')),
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      holdout_passed INTEGER CHECK(holdout_passed IN (0,1)),
      holdout_result_json TEXT,
      UNIQUE(finding_id, season)
    );
    CREATE INDEX IF NOT EXISTS idx_candidate_finding_seasons_finding ON nfl_candidate_finding_seasons(finding_id);
  `);
}

export function down(db) {
  db.exec(`
    DROP INDEX IF EXISTS idx_candidate_finding_seasons_finding;
    DROP TABLE IF EXISTS nfl_candidate_finding_seasons;
    DROP INDEX IF EXISTS idx_candidate_findings_state;
    DROP TABLE IF EXISTS nfl_candidate_findings;
  `);
}
