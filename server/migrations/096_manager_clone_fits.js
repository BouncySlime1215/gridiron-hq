export const name = '096_manager_clone_fits';
/**
 * CLONE-01b b2, manager clones: one table and one column, additive only.
 *
 *   manager_clone_fits   one row per (league, season, manager): the settled
 *                        replies to offers Nick SENT that manager (y, the
 *                        package's gain for him, when), rewritten whole by
 *                        `refreshCloneFits` after every settle run. The clone's
 *                        prior is not stored: it is built at serve time from the
 *                        counterparty layer, so it moves with his accept rate.
 *                        `n` is decided replies, `k` accepts, `coef_json` the
 *                        replies and the price bound a decline set.
 *   trade_outcomes.pitch_json   the pitch arm of a sent offer (screen fairness,
 *                        2-for-1 vs 1-for-1, lead need). b1 (migration 080)
 *                        left it out so that this ADD COLUMN would not collide.
 *
 * Spec numbered this 078, then 086; 096 per the MIGRATIONS.md registry.
 */
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);

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
  const have = cols(db, 'trade_outcomes');
  if (have.length && !have.includes('pitch_json')) db.exec('ALTER TABLE trade_outcomes ADD COLUMN pitch_json TEXT');
}

export function down(db) {
  db.exec('DROP TABLE IF EXISTS manager_clone_fits');
  if (cols(db, 'trade_outcomes').includes('pitch_json')) db.exec('ALTER TABLE trade_outcomes DROP COLUMN pitch_json');
}
