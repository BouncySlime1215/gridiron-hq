export const name = '029_quote_tape_commence_index';

/**
 * An index on `nfl_quote_tape(commence_time)`.
 *
 * The tape already carries two indexes, but both lead with something a
 * kickoff-time lookup does not have:
 *
 *   idx_nfl_quote_event_time  (provider_event_id, market, snapshot_at)
 *   idx_nfl_quote_match_time  (home_team, away_team, commence_time, snapshot_at)
 *
 * The T-60 evidence packet (`nfl-t60-packet.js`) knows only WHEN a game
 * starts. It cannot use the second index because the tape stores full team
 * names ("Atlanta Falcons") while the schedule stores abbreviations ("ATL"),
 * and no mapping exists at that layer. So every packet scanned all 1.3M rows
 * and joined each one to its batch. Tolerable once from a route; ruinous
 * across a season manifest, which builds one packet per scheduled game.
 *
 * The packet's own predicate was fixed alongside this: it previously wrote
 * `julianday(commence_time) = julianday(?)`, and wrapping a column in a
 * function makes every index on it unusable no matter how many exist. It now
 * uses a one-second range, which both absorbs the two ISO spellings actually
 * present in the column ("...:00Z" and "...:00.000Z") and lets this index do
 * its job.
 *
 * Index-only, additive, and reversible. It changes no row and no behavior.
 */
export function up(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_nfl_quote_commence ON nfl_quote_tape(commence_time);`);
}

export function down(db) {
  db.exec(`DROP INDEX IF EXISTS idx_nfl_quote_commence;`);
}
