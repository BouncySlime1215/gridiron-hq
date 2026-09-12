export const name = '038_research_trials';

/**
 * Giant Plan Section 8.3: a general-purpose trial registry.
 *
 * audit-registry.js already has its own declare-then-run ledger
 * (`audit_registry`, one row per preregistered hypothesis about THIS
 * codebase's models) and nfl-candidate-findings.js has its own
 * (`nfl_candidate_findings`, one row per segment-bias finding under
 * multi-season holdout). Both are narrow to their own domain. This table is
 * the general shape underneath that pattern -- declare a trial, score it
 * later, never edit the declaration once it exists -- for any future
 * one-shot statistical trial that does not fit either of those two, without
 * inventing a third bespoke ledger per use case.
 *
 * `identity_hash` plays the same role audit-registry.js's `codeHash()` and
 * nfl-candidate-findings.js's `rule_definition_hash` already play: a
 * fingerprint of the exact implementation a trial was declared against, so a
 * caller can tell later whether the code underneath it has drifted.
 *
 * The one hard invariant this migration enforces at the database level,
 * matching this project's standing pattern of putting the invariant in the
 * schema rather than trusting every future caller to remember it
 * (nfl_candidate_finding_seasons' UNIQUE(finding_id, season) is the same
 * idea applied to a different rule): a trial can never be scored before it
 * was declared. `declared_at` is written once, at registration; `scored_at`
 * is written once, when a result comes in. The BEFORE UPDATE trigger below
 * rejects any UPDATE that would leave the row with scored_at earlier than
 * its own declared_at -- not just application discipline, an actual
 * constraint the database enforces regardless of which code path writes the
 * row.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_trials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      identity_hash TEXT NOT NULL,
      declared_at TEXT NOT NULL DEFAULT (datetime('now')),
      scored_at TEXT,
      metric TEXT,
      value REAL,
      status TEXT NOT NULL DEFAULT 'declared'
        CHECK(status IN ('declared','scored','void','error'))
    );
    CREATE INDEX IF NOT EXISTS idx_research_trials_kind ON research_trials(kind);
    CREATE INDEX IF NOT EXISTS idx_research_trials_identity ON research_trials(identity_hash);

    -- scored_at >= declared_at, enforced on every UPDATE (not just at
    -- insert time, since declared_at is written first and scored_at is
    -- filled in by a later, separate write).
    CREATE TRIGGER IF NOT EXISTS trg_research_trials_scored_after_declared
    BEFORE UPDATE ON research_trials
    FOR EACH ROW
    WHEN NEW.scored_at IS NOT NULL AND NEW.scored_at < NEW.declared_at
    BEGIN
      SELECT RAISE(ABORT, 'research_trials.scored_at must be >= declared_at');
    END;
  `);
}

export function down(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_research_trials_scored_after_declared;
    DROP INDEX IF EXISTS idx_research_trials_identity;
    DROP INDEX IF EXISTS idx_research_trials_kind;
    DROP TABLE IF EXISTS research_trials;
  `);
}
