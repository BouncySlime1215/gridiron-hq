export const name = '039_candidate_finding_rule_version';

/**
 * Giant Plan Section 8.12: UNIQUE(segment_key) on nfl_candidate_findings
 * permanently blocks a segment once anything has ever been recorded for
 * it -- even after assertRuleUnchanged (nfl-candidate-findings.js) proves
 * the predicate implementation behind that segment_key has since changed.
 * A changed predicate is not the same finding under test any more; it
 * should be able to restart at zero evidence under a new row, instead of
 * permanently inheriting (or being blocked by) whatever an earlier, now-
 * provably-different definition already recorded.
 *
 * `rule_version` makes that a real, database-checked thing:
 * UNIQUE(segment_key, rule_version) allows a second row for the same
 * segment_key once its rule_version increments, while still forbidding two
 * simultaneous live rows at the same version -- the actual duplicate the
 * original constraint existed to prevent. SQLite has no
 * ALTER TABLE ... DROP CONSTRAINT / ALTER COLUMN, so the only way to change
 * an inline UNIQUE is to rebuild the table.
 *
 * This migration deliberately changes SCHEMA ONLY. Nothing in
 * nfl-candidate-findings.js is wired to bump rule_version yet, or to look a
 * finding up by (segment_key, rule_version) instead of segment_key alone --
 * findingByKey/segmentKeyFor in that file are unchanged. Every existing (and
 * every future, until that wiring lands) row keeps rule_version=1, so the
 * new constraint is behaviorally identical to the old one until a caller
 * actually starts incrementing it.
 *
 * *** KNOWN RISK, NOT ADDRESSED HERE (see server/db/preflight.js) ***
 * nfl_candidate_finding_seasons declares
 * `finding_id INTEGER NOT NULL REFERENCES nfl_candidate_findings(id) ON
 * DELETE CASCADE`. With foreign keys enabled, `DROP TABLE
 * nfl_candidate_findings` performs an implicit DELETE of every row first,
 * and each of those deletes cascades into nfl_candidate_finding_seasons --
 * silently destroying every finding's recorded discovery/holdout season
 * history on any database where either table already holds rows. On a
 * brand-new database (nothing has run `runCandidateFindingsForSeasonEnd` or
 * `registerManuallyObservedFinding` yet -- true for every fresh install and
 * every test fixture, since this migration runs immediately after 024
 * creates the table in the same initial migration pass) both tables are
 * still empty here, so the rebuild below is safe as written.
 *
 * It is NOT safe to run this migration, unmodified, against the real
 * server/data.sqlite once it has ever recorded a candidate finding.
 * server/db/preflight.js documents the exact same hazard for
 * nfl_execution_opportunities / nfl_execution_lifecycle_events (see
 * OPPORTUNITY_CASCADE_REPAIR) and fixes it with a preflight repair that
 * rebuilds the parent with foreign keys suspended BEFORE the numbered
 * migration runner starts (PRAGMA foreign_keys is silently ignored inside
 * migrate()'s BEGIN IMMEDIATE transaction, so it cannot be suspended from
 * inside this file). Before this migration is ever applied to a database
 * that already has candidate-finding rows, add the equivalent repair --
 * inspectCandidateFindingsRuleVersion / rebuildCandidateFindingsParent
 * mirroring inspectOpportunityCascade / rebuildOpportunityParent -- to
 * preflight.js's REPAIRS list. That repair is intentionally NOT included in
 * this change: writing and verifying it needs the same scrutiny 027's
 * preflight repair got, and this migration is not being run against any
 * real or populated database right now.
 */
export function up(db) {
  const cols = db.prepare(`PRAGMA table_info(nfl_candidate_findings)`).all().map(c => c.name);
  if (cols.includes('rule_version')) return; // already rebuilt (e.g. by a future preflight repair)

  db.exec(`
    CREATE TABLE nfl_candidate_findings_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_key TEXT NOT NULL,
      rule_version INTEGER NOT NULL DEFAULT 1,
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
      data_hash TEXT,
      discovery_note TEXT,
      UNIQUE(segment_key, rule_version)
    );
    INSERT INTO nfl_candidate_findings_new
      (id, segment_key, rule_version, dimension, segment, direction, rule_definition_hash, state,
       discovery_seasons_json, first_flagged_at, confirmed_at, validated_at, flagged_at, resolved_at,
       resolved_by, resolution_note, code_hash, data_hash, discovery_note)
    SELECT id, segment_key, 1, dimension, segment, direction, rule_definition_hash, state,
       discovery_seasons_json, first_flagged_at, confirmed_at, validated_at, flagged_at, resolved_at,
       resolved_by, resolution_note, code_hash, data_hash, discovery_note
    FROM nfl_candidate_findings;
    DROP TABLE nfl_candidate_findings;
    ALTER TABLE nfl_candidate_findings_new RENAME TO nfl_candidate_findings;
    CREATE INDEX IF NOT EXISTS idx_candidate_findings_state ON nfl_candidate_findings(state);
  `);

  const violations = db.prepare(`PRAGMA foreign_key_check(nfl_candidate_finding_seasons)`).all();
  if (violations.length) {
    throw new Error(`nfl_candidate_finding_seasons lost its link to nfl_candidate_findings during the rebuild: `
      + `${violations.length} orphaned row(s)`);
  }
}

export function down(db) {
  // Best-effort revert. A row with a genuinely non-default rule_version (the
  // entire feature this migration adds) cannot be losslessly represented
  // under the old single-column UNIQUE(segment_key), so rolling back after
  // that has actually happened is refused rather than silently colliding.
  const nonDefault = db.prepare(`SELECT COUNT(*) n FROM nfl_candidate_findings WHERE rule_version <> 1`).get();
  if (nonDefault.n > 0) {
    throw new Error('cannot roll back 039_candidate_finding_rule_version: row(s) exist with rule_version <> 1, '
      + 'which would collide or lose data under the old UNIQUE(segment_key) constraint');
  }
  db.exec(`
    CREATE TABLE nfl_candidate_findings_old (
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
      data_hash TEXT,
      discovery_note TEXT
    );
    INSERT INTO nfl_candidate_findings_old
      (id, segment_key, dimension, segment, direction, rule_definition_hash, state,
       discovery_seasons_json, first_flagged_at, confirmed_at, validated_at, flagged_at, resolved_at,
       resolved_by, resolution_note, code_hash, data_hash, discovery_note)
    SELECT id, segment_key, dimension, segment, direction, rule_definition_hash, state,
       discovery_seasons_json, first_flagged_at, confirmed_at, validated_at, flagged_at, resolved_at,
       resolved_by, resolution_note, code_hash, data_hash, discovery_note
    FROM nfl_candidate_findings;
    DROP TABLE nfl_candidate_findings;
    ALTER TABLE nfl_candidate_findings_old RENAME TO nfl_candidate_findings;
    CREATE INDEX IF NOT EXISTS idx_candidate_findings_state ON nfl_candidate_findings(state);
  `);
}
