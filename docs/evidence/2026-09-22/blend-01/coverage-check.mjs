// Descriptive coverage check (local copy, not production): per league, how many players the
// served ESPN reader covers for 2026 week 3, rostered in that league vs not (free agents).
// Run from the repo root on a COPY of the app database:
//   GRIDIRON_DB_PATH=.local-db/data.sqlite NFL_SEASON=2026 node docs/evidence/2026-09-22/blend-01/coverage-check.mjs
const ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
process.env.SCHEDULER_DISABLED = '1';
const { rows } = await import(`${ROOT}/server/db/index.js`);
const blend = await import(`${ROOT}/server/services/weekly-blend.js`);
const leagues = rows(`SELECT id, platform, ppr, payload FROM leagues WHERE platform = 'espn' ORDER BY id`);
const keys = new Map(leagues.map(l => [l.id, blend.scoringKey(l)]));
console.log('distinct scoring keys across ESPN leagues:', new Set(keys.values()).size, 'leagues:', leagues.length);
const skill = rows(`SELECT id, espn_id, position FROM players WHERE position IN ('QB','RB','WR','TE') AND espn_id IS NOT NULL AND espn_id != 0`);
for (const lg of leagues) {
  const espn = blend.espnWeekProjections({ league: lg, season: 2026, week: 3 });
  const rostered = new Set(rows(`SELECT espn_player_id FROM league_roster_snapshots WHERE league_id = ? AND season = 2026
                                 AND scoring_period_id = 3 AND on_roster = 1`, lg.id).map(r => String(r.espn_player_id)));
  const covered = skill.filter(p => blend.espnValueFor(espn, p.espn_id) != null);
  const fa = covered.filter(p => !rostered.has(String(p.espn_id)));
  console.log(`league row ${lg.id}: state ${espn.state}, same-scoring leagues ${espn.leagues.length}, ESPN players ${espn.values.size}, conflicting ${espn.conflicting}, rostered here ${rostered.size}, skill players covered ${covered.length}, of them not rostered here ${fa.length}`);
}
