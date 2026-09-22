/**
 * Five columns off fields the sync already fetches but discards
 * (docs/wiring/league-ingest-field-contract.md, Fantasy plan, 2026-09-22).
 *
 * `waiver_type`, `faab_budget` and `trade_deadline` are stored RAW off
 * Sleeper's `league.settings` — this migration does not interpret them
 * (e.g. mapping waiver_type's 0/1/2 to a label), because that mapping is
 * documented community knowledge, not something verified against a real
 * payload here. ESPN has no confirmed field path for any of the three
 * (`settings.tradeSettings` is real — trade-tactics.js:375 already reads
 * `vetoVotesRequired` off it — but `deadlineDate` specifically is not),
 * so they stay NULL for ESPN leagues rather than guessing.
 *
 * `playoff_teams`/`playoff_week_start` ARE confirmed on both platforms:
 * season-sim.js:198 and trade-horizon.js's leagueSchedule() already read
 * ESPN's `settings.scheduleSettings.playoffTeamCount` from payload on every
 * call, and sleeper-history.js:37,39,54 already reads Sleeper's
 * `settings.playoff_teams`/`settings.playoff_week_start` the same way. This
 * migration only gives sync a place to store what those call sites already
 * trust, so a caller can read the column instead of re-parsing payload.
 * Populating season-sim.js/trade-horizon.js to read the new column instead
 * is Fantasy plan's change, once this lands (their files, one-editor rule).
 */
export const name = '068_league_ingest_field_contract';

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(leagues)').all().map(c => c.name);
  const add = (col, ddl) => { if (!cols.includes(col)) db.exec(`ALTER TABLE leagues ADD COLUMN ${ddl}`); };
  add('waiver_type', 'waiver_type TEXT');
  add('faab_budget', 'faab_budget INTEGER');
  add('trade_deadline', 'trade_deadline INTEGER');
  add('playoff_teams', 'playoff_teams INTEGER');
  add('playoff_week_start', 'playoff_week_start INTEGER');
}

export function down(db) {
  const cols = db.prepare('PRAGMA table_info(leagues)').all().map(c => c.name);
  for (const col of ['waiver_type', 'faab_budget', 'trade_deadline', 'playoff_teams', 'playoff_week_start']) {
    if (cols.includes(col)) db.exec(`ALTER TABLE leagues DROP COLUMN ${col}`);
  }
}
