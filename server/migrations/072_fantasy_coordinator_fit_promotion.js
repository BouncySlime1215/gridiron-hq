export const name = '072_fantasy_coordinator_fit_promotion';
/**
 * S-03: a fantasy-coordinator fit is served only once it is promoted.
 *
 * `fantasy_coordinator_fits` (created by server/db/schema/core-and-fantasy.js, written by
 * fantasy-coordinator.js#saveFantasyCoordinatorFit from the daily heavy refit,
 * scheduler.js#fantasy_coordinator_refit) had no notion of promotion:
 * activeFantasyCoordinatorFit served the newest row, whatever engine state it was fitted
 * on. Two additive columns, mirroring `weekly_ensemble_fits.promoted`:
 *
 *   promoted        0 for every existing and future candidate; promoteFantasyCoordinatorFit
 *                   sets it to 1 on exactly one row.
 *   promotion_json  the windows (weeks 2-4, 5-17) the promotion covers, the committed
 *                   evidence that cleared it, and when. Kept on a demoted row as history.
 *
 * No row is promoted here. On an existing database the coordinator is therefore off (the
 * served number is the ensemble, labelled so) until a fit is promoted by
 * scripts/promote-fantasy-coordinator-fit.mjs, which checks the grade first. Nothing is
 * dropped or rewritten; `down` removes only the two columns this adds.
 */
const COLUMNS = [['promoted', 'INTEGER NOT NULL DEFAULT 0'], ['promotion_json', 'TEXT']];
const cols = db => db.prepare('PRAGMA table_info(fantasy_coordinator_fits)').all().map(c => c.name);

export function up(db) {
  const have = cols(db);
  if (!have.length) return; // table is created by the legacy schema; nothing to extend yet
  for (const [c, t] of COLUMNS) if (!have.includes(c)) db.exec(`ALTER TABLE fantasy_coordinator_fits ADD COLUMN ${c} ${t}`);
}

export function down(db) {
  const have = cols(db);
  for (const [c] of [...COLUMNS].reverse()) if (have.includes(c)) db.exec(`ALTER TABLE fantasy_coordinator_fits DROP COLUMN ${c}`);
}
