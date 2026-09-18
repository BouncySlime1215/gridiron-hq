export const name = '056_league_current_week';
/**
 * `leagues.current_week` — ESPN's `status.currentMatchupPeriod` captured at each
 * league sync. Pages that need "this week" read it through
 * services/league-week.js instead of defaulting to 1, so the app progresses
 * week by week with ESPN (2026-09-17: ceiling-lineup and postmortem opened on
 * week 1 all season, and the ESPN sync itself was pinned to scoringPeriodId=1).
 */
export function up(db) {
  const cols = db.prepare('PRAGMA table_info(leagues)').all().map(c => c.name);
  if (!cols.includes('current_week')) db.exec('ALTER TABLE leagues ADD COLUMN current_week INTEGER');
}

export function down(db) {
  // Additive column only; dropping it returns the table to its 055 shape.
  const cols = db.prepare('PRAGMA table_info(leagues)').all().map(c => c.name);
  if (cols.includes('current_week')) db.exec('ALTER TABLE leagues DROP COLUMN current_week');
}
