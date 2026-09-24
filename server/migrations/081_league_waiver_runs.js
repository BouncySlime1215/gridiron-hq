export const name = '081_league_waiver_runs';
/**
 * RL-16-2. Additive only: one new table.
 *
 * `league_waiver_runs` — one row per observed waiver processing instant per league
 * per season. Written by services/waiver-runs.js#recordWaiverRuns on every ESPN
 * sync (routes/leagues.js#syncEspnLeague), from the processDate of EXECUTED WAIVER
 * transactions in the sync response and from status.waiverLastExecutionDate.
 * `leagues.payload` is overwritten on each sync, so without this table a run seen
 * last week is gone. Append-only: INSERT ... ON CONFLICT DO NOTHING.
 * Read by waiver-runs.js#observedWaiverRuns, which feeds waiver-wire.js#nextWaiverRun.
 *
 * Numbered 081: main tops at 073; 071 (#174), 074 (#218), 075 (#216) are claimed.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS league_waiver_runs (
      league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      run_at TEXT NOT NULL,
      source TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (league_id, season, run_at)
    );
  `);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS league_waiver_runs');
}
