export const name = '061_league_payload_season';
/**
 * Which season the stored league payload actually came from.
 *
 * `syncEspnLeague` falls back to last season when the current one returns empty
 * rosters, so a pre-draft league can be running on last year's teams. It
 * returned `season_used`/`fell_back` to its caller, but the scheduled path
 * (scheduler.js refreshLeagueRosters) kept only counts and threw them away, so
 * every reader but the one manual-sync message saw a league that looked
 * freshly connected for the current season. Persisting it lets any surface say
 * whose rosters it is actually looking at.
 *
 * NULL means "not recorded yet", which for an existing row is the honest answer
 * until its next sync — not an assertion that the payload is current.
 */
const cols = db => db.prepare('PRAGMA table_info(leagues)').all().map(c => c.name);

export function up(db) {
  if (!cols(db).includes('payload_season')) {
    db.exec('ALTER TABLE leagues ADD COLUMN payload_season INTEGER');
  }
}

export function down(db) {
  if (cols(db).includes('payload_season')) {
    db.exec('ALTER TABLE leagues DROP COLUMN payload_season');
  }
}
