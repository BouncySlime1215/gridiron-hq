export const name = '041_nfl_replay_run_spec';

/**
 * Giant Plan 8.9/8.11, audit-consolidation stage 5.
 *
 * `nfl-replay.js`'s `replaySeason` never told `ensembleLine` which blend mode
 * to use, so every replay silently inherited `nfl-ensemble.js`'s own default
 * ('raw') while the live production path (`nfl-auto-picks.js`) forces
 * 'market_residual'. A backtest run this way was not measuring the policy
 * production actually runs.
 *
 * `blendMode` is now a required parameter of `replaySeason` (it throws if
 * omitted) — see the comment on that function. This migration adds the
 * column pair that makes the choice a first-class, queryable fact about a
 * saved run rather than something buried inside `nfl_replay_runs.config`'s
 * free-form JSON blob (whose shape is not guaranteed stable release to
 * release, and was never meant to be grouped or filtered on):
 *
 *   spec_json  - `{ blendMode, modelOptions }` for the run, verbatim.
 *   spec_hash  - sha256 hex digest of spec_json, so two runs can be compared
 *                for "same blend spec" without a JSON-aware query.
 *
 * Write-only: existing rows predate the blendMode requirement and get NULL
 * in both columns rather than a guessed value. Every one of them was in fact
 * run against the 'raw' blend (replaySeason's only behavior before this
 * change), but asserting that into spec_hash would fabricate a hash the
 * historical row was never actually computed under — the same reasoning
 * migration 032 used for `nfl_quote_batches.received_at`. A NULL here reads
 * honestly as "recorded before this run tracked its blend spec"; a backfilled
 * hash would read, wrongly, as evidence the run declared it.
 */
function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

export function up(db) {
  const existing = columns(db, 'nfl_replay_runs');
  if (!existing.length) return; // fresh install; the schema module creates the table directly

  if (!existing.includes('spec_json')) {
    db.exec(`ALTER TABLE nfl_replay_runs ADD COLUMN spec_json TEXT`);
  }
  if (!existing.includes('spec_hash')) {
    db.exec(`ALTER TABLE nfl_replay_runs ADD COLUMN spec_hash TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_nfl_replay_runs_spec_hash ON nfl_replay_runs(spec_hash)`);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_nfl_replay_runs_spec_hash;`);
  // Additive nullable columns recording metadata, not evidence — safe to drop.
  db.exec(`ALTER TABLE nfl_replay_runs DROP COLUMN spec_hash;`);
  db.exec(`ALTER TABLE nfl_replay_runs DROP COLUMN spec_json;`);
}
