export const name = '113_manager_clone_fits';
/**
 * CLONE-01b b2, manager clones: one table, additive only.
 *
 *   manager_clone_fits   one row per (league, season, manager): the settled
 *                        replies to offers Nick SENT that manager (y, the
 *                        package's gain for him, when), rewritten whole by
 *                        `refreshCloneFits` after every settle run. The clone's
 *                        prior is not stored: it is built at serve time from the
 *                        counterparty layer, so it moves with his accept rate.
 *                        `n` is decided replies, `k` accepts, `coef_json` the
 *                        replies and the price bound a decline set.
 *
 * Numbered 096 on #288; 106-112 are on main or taken by open batch-D PRs (#429 111, #449 112), so 113 here. The
 * pitch-arm column #288 also added (trade_outcomes.pitch_json) is not carried.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS manager_clone_fits (
      league_id  INTEGER NOT NULL,
      season     INTEGER NOT NULL,
      roster_id  TEXT NOT NULL,
      coef_json  TEXT NOT NULL,
      n          INTEGER NOT NULL CHECK (n >= 0),
      k          INTEGER NOT NULL CHECK (k >= 0 AND k <= n),
      fit_stamp  TEXT NOT NULL,
      PRIMARY KEY (league_id, season, roster_id)
    );
  `);
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS manager_clone_fits');
}
