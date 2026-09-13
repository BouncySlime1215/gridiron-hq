export const name = '051_weekly_prediction_snapshot_mode';

/**
 * weekly-learning.js's `captureWeeklyPredictions()` writes a `mode` column
 * (commit 2ceefef, 2026-09-12: "cold_start_structural_only" vs
 * "position_ensemble", the fix for silently dropping a player from the
 * weekly capture when they had no prior-week evidence anywhere). That commit
 * added the column via an `ALTER TABLE ... ADD COLUMN` guard inside
 * server/db/schema/mlb-model-misc.js's `alters()` -- one of the fragments
 * `000_legacy_schema.js` runs. But 000_legacy_schema.js says, verbatim:
 *
 *   "FROZEN. Do not add to the fragments; write a new numbered migration.
 *   A fragment edited after the fact does nothing on any database that has
 *   already recorded this migration -- which is every database that
 *   matters."
 *
 * db/index.js only ever calls that fragment's up() when `000_legacy_schema`
 * has NEVER been recorded in schema_migrations (see the guard right above
 * the call). Every real database -- including the live one, which recorded
 * `000_legacy_schema` on 2026-09-08, four days before the `mode` column was
 * added to the frozen fragment -- already has that row, so the edit is a
 * silent no-op there. Confirmed live and by direct reproduction: the live
 * database's weekly_prediction_snapshots table has no `mode` column, and
 * calling captureWeeklyPredictions() against a full copy of it throws
 * `SQLITE_ERROR: table weekly_prediction_snapshots has no column named
 * mode` the moment it reaches a real INSERT (every attempt so far has been
 * short-circuited earlier by an unrelated "slate already started" guard, so
 * the break has not yet surfaced as a scheduler error -- but the next
 * capture window, week 2 of the 2026 season before its kickoff, would hit it
 * squarely and defeat the exact cold-start fix that shipped four days ago).
 *
 * This migration is the "new numbered migration" the frozen file's own
 * comment calls for: guarded and idempotent like every other migration here,
 * so it is a no-op on a fresh database that already has the column (from the
 * unmodified legacy fragment, on databases where that fragment still ran) and
 * a real, tracked schema change everywhere else.
 */
export function up(db) {
  const cols = db.prepare(`PRAGMA table_info(weekly_prediction_snapshots)`).all().map(c => c.name);
  if (!cols.includes('mode')) db.exec(`ALTER TABLE weekly_prediction_snapshots ADD COLUMN mode TEXT`);
}

export function down() {
  // Purely additive and nullable; nothing that predates this migration reads
  // it. SQLite's DROP COLUMN needs a full table rebuild for no real benefit
  // here, same reasoning as migration 050's down().
}
