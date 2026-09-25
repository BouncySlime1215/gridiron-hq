export const name = '103_living_gate';
/**
 * LIVING-01b re-gate (docs/tdd/2026-09-25-living-01b-regate.tdd.md). Additive:
 * one new table.
 *
 * `living_gate_sim_predictions` — per league, week and team, the predicted
 * starting-lineup points for a week that has not started, from the static sim
 * and from the sim with league-mates acting (LIVING-01b), on the same seed and
 * runs. Recorded by eval/living-gate-record.js on the refresh tick; graded by
 * eval/living-gate.js (L01B-SIM) once the week is complete. Write-once: the
 * primary key and INSERT OR IGNORE keep a later tick from replacing a
 * prediction with one made after the week began. Teams are roster ids only.
 *
 * Numbered 103: 100 is taken twice on open branches (BITEMPORAL, SERVE-LOG) and
 * 101-102 are on main.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS living_gate_sim_predictions (
      league_id INTEGER NOT NULL,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      team_id TEXT NOT NULL,
      runs INTEGER NOT NULL,
      seed INTEGER,
      pred_static REAL NOT NULL,
      pred_living REAL NOT NULL,
      model TEXT NOT NULL,
      recorded_period INTEGER NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (league_id, season, week, team_id)
    )`);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS living_gate_sim_predictions');
}
