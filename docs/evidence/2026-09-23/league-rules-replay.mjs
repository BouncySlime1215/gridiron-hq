/**
 * CE-05 replay: do league-rules.js#seedStandings seeds equal the real stored seeds?
 *
 * Usage (local copy, never production):
 *   GRIDIRON_DB_PATH=$(mktemp -d)/scratch.sqlite SCHEDULER_DISABLED=1 \
 *     node docs/evidence/2026-09-23/league-rules-replay.mjs .local-db/data.sqlite
 *
 * Reads `leagues.payload` (rules; never espn_s2/swid) and `league_season_teams`
 * (writer saveTeams, server/services/league-history.js:143). Prints counts only:
 * no league, team or manager names.
 *
 * Rules for past seasons come from the league's CURRENT (2026) payload, and so do
 * division memberships: the 2023-2025 settings were fetched by the history
 * backfill but not stored. That is an assumption (a guess) per past season; a
 * mismatch would show up as unequal seeds.
 */
import { DatabaseSync } from 'node:sqlite';
import { leagueRules, seedStandings } from '../../../server/services/league-rules.js';

const src = new DatabaseSync(process.argv[2], { readOnly: true });
const leagues = src.prepare('SELECT id, platform, ppr, payload FROM leagues ORDER BY id').all();
const out = [];
for (const lg of leagues) {
  const rules = leagueRules(lg);
  const seasons = src.prepare(`SELECT season, COUNT(*) n, SUM(playoff_seed IS NOT NULL) seeded
    FROM league_season_teams WHERE league_id = ? GROUP BY season ORDER BY season`).all(lg.id);
  for (const { season, n, seeded } of seasons) {
    if (seeded !== n) { out.push({ league: lg.id, season, teams: n, skipped: 'not every team has a stored seed' }); continue; }
    const rows = src.prepare(`SELECT roster_id, wins, ties, points_for, playoff_seed FROM league_season_teams
      WHERE league_id = ? AND season = ?`).all(lg.id, season);
    const standings = rows.map(r => ({ id: String(r.roster_id), w: (r.wins ?? 0) + 0.5 * (r.ties ?? 0), pf: r.points_for ?? 0 }));
    // Division map for this season's teams: 2026 payload membership (guess for past seasons).
    const divRules = rules.seeding.division_winners_first
      ? { ...rules, seeding: { ...rules.seeding, team_division: Object.fromEntries(rows.map(r =>
        [String(r.roster_id), rules.seeding.team_division?.[String(r.roster_id)] ?? null])) } }
      : rules;
    let order;
    try { order = seedStandings(standings, divRules); } catch (e) { out.push({ league: lg.id, season, teams: n, error: e.message }); continue; }
    const real = new Map(rows.map(r => [String(r.roster_id), r.playoff_seed]));
    const equal = order.filter((id, i) => real.get(id) === i + 1).length;
    const plain = seedStandings(standings, { ...rules, seeding: { ...rules.seeding, division_winners_first: false } });
    const plainEqual = plain.filter((id, i) => real.get(id) === i + 1).length;
    const k = rules.schedule.playoff_teams;
    const fieldEqual = new Set(order.slice(0, k)).size === k
      && order.slice(0, k).every(id => real.get(id) <= k);
    out.push({ league: lg.id, season, teams: n, seeds_equal: equal, plain_w_pf_equal: plainEqual,
      divisions: rules.seeding.divisions?.length ?? null, playoff_teams_rule_2026: k, playoff_field_equal: fieldEqual });
  }
  // 2026 so far: the payload's own current seeds (teams[].playoffSeed) against its records.
  const p = JSON.parse(lg.payload);
  const st = p.teams.map(t => ({ id: String(t.id),
    w: (t.record?.overall?.wins ?? 0) + 0.5 * (t.record?.overall?.ties ?? 0), pf: t.record?.overall?.pointsFor ?? 0 }));
  const cur = seedStandings(st, rules);
  const realCur = new Map(p.teams.map(t => [String(t.id), t.playoffSeed]));
  out.push({ league: lg.id, season: '2026 (payload, in progress)', teams: st.length,
    seeds_equal: cur.filter((id, i) => realCur.get(id) === i + 1).length, divisions: rules.seeding.divisions?.length ?? null });
}
for (const r of out) console.log(JSON.stringify(r));
