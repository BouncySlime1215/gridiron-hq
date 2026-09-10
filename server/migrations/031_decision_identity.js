export const name = '031_decision_identity';

/**
 * Codex corrections C01 and C02 (2026-09-10): the decision tape could not tell
 * two different decisions apart, and could be left half-written.
 *
 * Migration 027 built the tape with a single `board_hash TEXT NOT NULL UNIQUE`
 * standing for the whole identity of a run. That conflated two questions that
 * the plan is explicit are separate:
 *
 *   - WHAT was decided (the content), and
 *   - WHICH declared observation decided it.
 *
 * With one UNIQUE column covering both, a genuinely distinct observation --
 * say the scheduled T-60 run for a later game, or a second declared capture of
 * the same game -- could not be recorded at all if its numbers happened to
 * match an earlier one. The plan's words: "a retry of one observation is
 * idempotent, but a distinct declared observation must survive even if all
 * numbers are equal."
 *
 * This migration adds the observation identity alongside the content identity
 * and gives each its own rule. Note what it deliberately does NOT do: it does
 * not rebuild `nfl_decision_runs`. Dropping and recreating that parent would
 * cascade into `nfl_decision_events`, whose append-only DELETE trigger would
 * abort the transaction -- which is precisely the failure correction C03
 * describes in migration 027's own execution-table rebuild. Repeating that
 * mistake here to remove a UNIQUE constraint would be indefensible, so the
 * existing UNIQUE column is repurposed instead:
 *
 *   `board_hash`   now holds the RUN identity, sha256(observation || content).
 *                  That is the value that genuinely must be unique -- one
 *                  observation with one answer -- so the constraint 027
 *                  already created becomes correct rather than removed.
 *   `content_hash` holds the canonical content address on its own, NOT unique,
 *                  so identical numbers under different observations coexist.
 *   `observation_key` is uniquely indexed: one declared observation records at
 *                  most one run. A second, differing answer from the same
 *                  observation is an integrity error the service refuses by
 *                  name rather than a silent second row.
 *
 * The added forecast columns on `nfl_decision_events` exist because the old
 * fingerprint hashed `d.edge` -- a field the board never emits -- and omitted
 * the forecast entirely. Every persisted `edge` was NULL, and changing the
 * model, the probability or the projected margin did not change the run.
 *
 * `nfl_decision_run_invalidations` is C02's "append invalidation/replacement
 * events for incomplete legacy records rather than quietly rewriting them": a
 * run that turns out to be untrustworthy stays byte-identical and gains a
 * separate, later judgement rather than being edited.
 *
 * Finally, 027 created no DELETE trigger on `nfl_decision_runs`. A populated
 * run was protected only accidentally -- the cascade into its events tripped
 * THEIR delete trigger -- while an EMPTY run header could be deleted freely,
 * despite the immutability the tape claims. The trigger below closes that.
 */

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function addColumn(db, table, column, type) {
  if (!columns(db, table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export function up(db) {
  // ---- Run header: observation identity, computation state, real identities.
  for (const [column, type] of [
    ['content_hash', 'TEXT'],
    ['observation_key', 'TEXT'],
    ['experiment_id', 'TEXT'],
    ['horizon', 'TEXT'],
    ['cutoff_at', 'TEXT'],
    ['job_id', 'TEXT'],
    ['observation_id', 'TEXT'],
    ['attempt', 'INTEGER'],
    // 'complete' | 'partial' | 'unavailable'. An `unavailable` row is how a
    // missed capture stays in the denominator instead of vanishing from
    // coverage, and how a healthy all-abstention run is distinguished from a
    // run that never computed anything.
    ['computation_status', 'TEXT'],
    // 'frozen_packet' | 'unfrozen_live_tables' | 'unavailable'. Until C11's
    // frozen packet exists, decisions read mutable tables; recording that as a
    // permanent status means this evidence never has to be re-interpreted
    // later as stronger than it was.
    ['data_identity_status', 'TEXT'],
    ['schedule_version', 'TEXT'],
    // The module-closure manifest the code hash was computed from, so a stored
    // identity can be re-derived and checked rather than merely trusted.
    ['code_manifest_json', 'TEXT'],
    ['computation_started_at', 'TEXT'],
    ['computation_ended_at', 'TEXT'],
    ['tape_version', 'TEXT']
  ]) addColumn(db, 'nfl_decision_runs', column, type);

  // ---- Decision events: the forecast that was missing from the fingerprint.
  for (const [column, type] of [
    ['home_team', 'TEXT'],
    ['away_team', 'TEXT'],
    ['side', 'TEXT'],
    ['edge_points', 'REAL'],
    ['projected_margin', 'REAL'],
    ['market_margin', 'REAL'],
    ['model_probability', 'REAL'],
    ['implied_probability', 'REAL'],
    ['probability_difference', 'REAL'],
    ['forecast_identity', 'TEXT'],
    ['cover_calibration', 'TEXT'],
    ['calibration_eligible', 'INTEGER'],
    ['calibration_status', 'TEXT'],
    ['promoted_finding_veto_json', 'TEXT']
  ]) addColumn(db, 'nfl_decision_events', column, type);

  // ---- Backfill any run written by the previous tape version.
  //
  // Legacy rows genuinely predate the observation contract; inventing an
  // experiment or a cutoff for them would be fabrication. They are marked as
  // what they are -- a legacy observation, keyed off the run id so each stays
  // distinct -- and their content hash is set to the board hash they were
  // actually addressed by, which is the true content address under the old
  // (weaker) definition. `data_identity_status` is `unfrozen_live_tables`
  // because that is unambiguously how they were computed.
  // Migration 027 installed `nfl_decision_runs_no_update`, which aborts ANY
  // update to this table. The backfill below is an update, so on a database
  // holding even one decision run it raised
  //
  //     decision runs are immutable — a changed board is a new run
  //
  // and took the whole migration with it. `runMigrations()` is awaited before
  // any route module imports, so that is not a bad row — it is an application
  // that cannot start, and cannot start again on the next boot either. It was
  // invisible only because the live database happens to hold zero decision
  // runs; any installation that recorded one, and any restore from a snapshot
  // taken after the pipeline ran, would have been bricked by it.
  //
  // The trigger is therefore lifted for the backfill and put back immediately,
  // inside the same transaction the migration runner already holds. Nothing
  // else can observe the gap: SQLite gives this connection the write lock for
  // the duration, and a failure anywhere in between rolls back both the data
  // and the dropped trigger together.
  //
  // Lifting it is legitimate here in a way it would never be at runtime. These
  // rows predate the observation contract; the backfill assigns them the
  // identity columns that contract requires and changes no decision, no
  // number, and no hash that was ever used to address one. Immutability
  // protects recorded evidence from being rewritten, and this rewrites none.
  db.exec(`DROP TRIGGER IF EXISTS nfl_decision_runs_no_update`);
  db.exec(`
    UPDATE nfl_decision_runs SET
      content_hash = COALESCE(content_hash, board_hash),
      observation_key = COALESCE(observation_key, 'legacy:' || id),
      experiment_id = COALESCE(experiment_id, 'legacy-pre-observation-contract'),
      horizon = COALESCE(horizon, 'unspecified_legacy'),
      cutoff_at = COALESCE(cutoff_at, decided_at),
      job_id = COALESCE(job_id, 'legacy'),
      observation_id = COALESCE(observation_id, id),
      attempt = COALESCE(attempt, 1),
      computation_status = COALESCE(computation_status, 'complete'),
      data_identity_status = COALESCE(data_identity_status, 'unfrozen_live_tables'),
      tape_version = COALESCE(tape_version, 'nfl-decision-tape-v1-legacy')
    WHERE content_hash IS NULL OR observation_key IS NULL;
  `);
  // Restored immediately, with 027's exact definition. A migration that lifts a
  // protection and forgets to replace it is worse than one that never had it,
  // because everything afterwards looks protected and is not.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS nfl_decision_runs_no_update
      BEFORE UPDATE ON nfl_decision_runs
      BEGIN SELECT RAISE(ABORT, 'decision runs are immutable — a changed board is a new run'); END;
  `);

  // A legacy run whose events do not match its header count was written by the
  // non-atomic v1 path and is not trustworthy evidence. It is NOT rewritten --
  // an invalidation is appended against it, which is the whole point of the
  // table. The run itself stays exactly as it was.
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfl_decision_run_invalidations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES nfl_decision_runs(id),
      reason TEXT NOT NULL,
      actor TEXT,
      replaced_by_run_id TEXT REFERENCES nfl_decision_runs(id),
      occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_decision_invalidations_run
      ON nfl_decision_run_invalidations(run_id, id);
    CREATE TRIGGER IF NOT EXISTS nfl_decision_run_invalidations_no_update
      BEFORE UPDATE ON nfl_decision_run_invalidations
      BEGIN SELECT RAISE(ABORT, 'invalidations are append-only — record another one instead'); END;
    CREATE TRIGGER IF NOT EXISTS nfl_decision_run_invalidations_no_delete
      BEFORE DELETE ON nfl_decision_run_invalidations
      BEGIN SELECT RAISE(ABORT, 'invalidations are append-only — record another one instead'); END;
  `);

  db.exec(`
    INSERT INTO nfl_decision_run_invalidations (run_id, reason, actor, occurred_at)
    SELECT r.id,
           'incomplete legacy run — header claims ' || r.decision_count ||
           ' decisions, ' || (SELECT COUNT(*) FROM nfl_decision_events e WHERE e.run_id = r.id) ||
           ' events present. Written by the non-atomic v1 tape (Codex C02).',
           '031_decision_identity',
           datetime('now')
      FROM nfl_decision_runs r
     WHERE r.decision_count <> (SELECT COUNT(*) FROM nfl_decision_events e WHERE e.run_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM nfl_decision_run_invalidations i WHERE i.run_id = r.id);
  `);

  // ---- Constraints and the missing delete protection.
  //
  // `board_hash` keeps 027's UNIQUE index and now means the run identity.
  // Legacy rows already satisfy it: each had a distinct board hash, and each
  // now has a distinct 'legacy:<id>' observation key alongside it.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_runs_observation
      ON nfl_decision_runs(observation_key);
    CREATE INDEX IF NOT EXISTS idx_decision_runs_content
      ON nfl_decision_runs(content_hash);
    CREATE INDEX IF NOT EXISTS idx_decision_runs_cutoff
      ON nfl_decision_runs(cutoff_at);

    -- 027 protected runs against UPDATE but not DELETE. A populated run was
    -- protected only by accident, through its events' own delete trigger; an
    -- empty run header could simply be removed, which is exactly the evidence
    -- an all-abstention observation consists of.
    CREATE TRIGGER IF NOT EXISTS nfl_decision_runs_no_delete
      BEFORE DELETE ON nfl_decision_runs
      BEGIN SELECT RAISE(ABORT, 'decision runs are immutable — an empty run is evidence too'); END;
  `);
}

export function down(db) {
  // Refuse rather than lose evidence. Everything this migration added is
  // either identity that the older schema cannot represent, or a judgement
  // recorded about a run. Dropping the columns would silently collapse
  // distinct observations back into a single content address, and dropping the
  // invalidations would delete the only record that some run is untrustworthy.
  //
  // Added columns are the reversible part and are left in place deliberately:
  // an unused column costs nothing, while a destroyed distinction cannot be
  // recovered. Only the delete protection is lifted, so that a genuine
  // recovery procedure can still operate after an explicit, deliberate
  // downgrade.
  const invalidations = db.prepare(
    `SELECT COUNT(*) n FROM nfl_decision_run_invalidations`).get()?.n ?? 0;
  const observed = db.prepare(
    `SELECT COUNT(*) n FROM nfl_decision_runs WHERE observation_key NOT LIKE 'legacy:%'`).get()?.n ?? 0;
  if (invalidations || observed) {
    throw new Error(
      `031_decision_identity: refusing to downgrade — ${observed} run(s) carry an observation identity ` +
      `and ${invalidations} invalidation(s) are recorded, neither of which the earlier schema can hold. ` +
      'Export this evidence deliberately before attempting a downgrade.');
  }
  db.exec(`
    DROP TRIGGER IF EXISTS nfl_decision_runs_no_delete;
    DROP INDEX IF EXISTS idx_decision_runs_observation;
    DROP INDEX IF EXISTS idx_decision_runs_content;
    DROP INDEX IF EXISTS idx_decision_runs_cutoff;
  `);
}
