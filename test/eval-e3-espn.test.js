/**
 * E3-ESPN grader (server/services/eval/e3-espn.js): week-7 replay of past ESPN
 * league-seasons. Synthetic leagues only; no real league data here.
 *   - leakage: points after week 7 (regular season and playoffs) cannot move a prediction;
 *   - held out: 2025+ is never replayed and never loaded;
 *   - control: when team strength is real, the sim beats standings-only;
 *   - the row is always not_enough_data (a low-power sanity check), even when the
 *     sample contradicts Sleeper;
 *   - load() runs end to end on an in-memory database and writes through brain_report's shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as E from '../server/services/eval/e3-espn.js';
import { rng } from '../server/services/eval/stats.js';
import { up as brainReportUp } from '../server/migrations/078_brain_report.js';
import { writeReport, latestReport } from '../server/services/eval/index.js';

const RULES = {
  schedule: { playoff_teams: 4, playoff_weeks: [[15, 16], [17, 18]], reseed: false },
  seeding: { tiebreaker: 'TOTAL_POINTS_SCORED', division_winners_first: false, team_division: null },
  median_game: false,
};

/** A round-robin league-season: `strength` per team, 14 regular weeks, playoffs 15-16. */
function synthLeague({ teams = 8, seed = 1, spread = 25, sd = 20 } = {}) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const ids = Array.from({ length: teams }, (_, i) => String(i + 1));
  const mu = new Map(ids.map(id => [id, 110 + spread * gauss()]));
  const rows = [];
  // circle-method round robin
  const rot = [...ids];
  for (let w = 1; w <= 16; w += 1) {
    const playoff = w > 14;
    for (let i = 0; i < teams / 2; i += 1) {
      const a = rot[i], b = rot[teams - 1 - i];
      rows.push({ week: w, roster_id: a, opponent_roster_id: b, points: mu.get(a) + sd * gauss(), is_playoff: playoff ? 1 : 0 });
      rows.push({ week: w, roster_id: b, opponent_roster_id: a, points: mu.get(b) + sd * gauss(), is_playoff: playoff ? 1 : 0 });
    }
    rot.splice(1, 0, rot.pop());
  }
  // Real outcome: real regular season, real seeds, real bracket (1-week rounds).
  const rec = new Map(ids.map(id => [id, { w: 0, pf: 0 }]));
  for (const r of rows.filter(x => !x.is_playoff)) {
    const o = rows.find(x => x.week === r.week && x.roster_id === r.opponent_roster_id);
    rec.get(r.roster_id).pf += r.points;
    if (r.points > o.points) rec.get(r.roster_id).w += 1;
  }
  const order = ids.slice().sort((a, b) => rec.get(b).w - rec.get(a).w || rec.get(b).pf - rec.get(a).pf);
  const pts = (id, w) => rows.find(x => x.week === w && x.roster_id === id).points;
  const semi = [[order[0], order[3]], [order[1], order[2]]].map(([a, b]) => (pts(a, 15) >= pts(b, 15) ? a : b));
  const champ = pts(semi[0], 16) >= pts(semi[1], 16) ? semi[0] : semi[1];
  const teamsRows = ids.map(id => ({ roster_id: id, playoff_seed: order.indexOf(id) + 1, final_rank: id === champ ? 1 : 2 }));
  return { weekRows: rows, teams: teamsRows };
}

test('as-of: points after week 7 are stripped before the state is built', () => {
  const { weekRows } = synthLeague({ seed: 3 });
  const known = E.asOfWeek(weekRows);
  assert.ok(known.filter(r => r.week > 7).every(r => r.points === null));
  assert.ok(known.filter(r => r.week <= 7).every(r => Number.isFinite(r.points)));
  const st = E.leagueSeasonState(weekRows);
  assert.deepEqual(st.played, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...st.fixtures.keys()], [8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(st.playoffWeeks, [15, 16]);
});

test('leakage: rewriting every week-8+ score (regular and playoff) leaves every prediction unchanged', () => {
  const lg = synthLeague({ seed: 5 });
  const base = E.replayLeagueSeason({ league_id: 1, season: 2023, ...lg, rules: RULES, runs: 400 });
  const tampered = lg.weekRows.map(r => (r.week > 7 ? { ...r, points: r.roster_id === '1' ? 999 : 1 } : r));
  const again = E.replayLeagueSeason({ league_id: 1, season: 2023, weekRows: tampered, teams: lg.teams, rules: RULES, runs: 400 });
  const pick = rows => rows.map(r => [r.team_id, r.p_playoffs, r.p_title, r.base_playoffs, r.base_title]);
  assert.deepEqual(pick(again), pick(base));
  // Known-nonzero control: a week <= 7 change does move them.
  const early = lg.weekRows.map(r => (r.week === 3 && r.roster_id === '1' ? { ...r, points: r.points + 200 } : r));
  const moved = E.replayLeagueSeason({ league_id: 1, season: 2023, weekRows: early, teams: lg.teams, rules: RULES, runs: 400 });
  assert.ok(moved.find(r => r.team_id === '1').p_playoffs > base.find(r => r.team_id === '1').p_playoffs);
});

test('held out: a 2025 league-season is refused', () => {
  const lg = synthLeague({ seed: 7 });
  assert.throws(() => E.replayLeagueSeason({ league_id: 1, season: 2025, ...lg, rules: RULES, runs: 50 }), /held out/);
});

test('round lengths come from the season\'s own playoff weeks, else the rules', () => {
  assert.deepEqual(E.pastSeasonSchedule(RULES, [15, 16]).playoff_weeks, [[15], [16]]);
  assert.deepEqual(E.pastSeasonSchedule(RULES, [15, 16, 17, 18]).playoff_weeks, [[15, 16], [17, 18]]);
  const odd = E.pastSeasonSchedule(RULES, [15, 16, 17]);
  assert.equal(odd.round_weeks_source, 'rules_2026');
});

test('control: with real strength spread the sim beats standings-only on playoffs', () => {
  const rows = [];
  for (let s = 0; s < 40; s += 1) {
    rows.push(...E.replayLeagueSeason({ league_id: 100 + s, season: 2023, ...synthLeague({ seed: 1000 + s, spread: 25 }), rules: RULES, runs: 300 }));
  }
  const r = E.grade(rows);
  assert.equal(r.status, 'not_enough_data', 'a sanity check never passes');
  assert.ok(r.metric > 0, `playoff gain ${r.metric}`);
  assert.ok(r.ci_low > 0, JSON.stringify([r.ci_low, r.ci_high]));
  assert.match(r.detail.sanity, /^consistent/);
  // Positive, not inverted. It sits above 1 here: the frozen Sleeper k = 21 shrinks hard, and
  // this synthetic spread is wider than real fantasy strength, so the sim is under-confident.
  assert.ok(r.detail.playoffs.slope > 0.5, `slope ${r.detail.playoffs.slope}`);
  assert.equal(r.detail.format_consistent_league_seasons, 40, 'synthetic brackets replay their own champion');
});

test('fault: inverted odds contradict Sleeper but the row still never reads failing', () => {
  const rows = [];
  for (let s = 0; s < 30; s += 1) {
    rows.push(...E.replayLeagueSeason({ league_id: 200 + s, season: 2024, ...synthLeague({ seed: 2000 + s }), rules: RULES, runs: 200 }));
  }
  const inverted = rows.map(r => ({ ...r, p_playoffs: 1 - r.p_playoffs, p_title: Math.max(0, 0.25 - r.p_title) }));
  const g = E.grade(inverted);
  assert.equal(g.status, 'not_enough_data');
  assert.ok(g.ci_high < 0);
  assert.match(g.detail.sanity, /^contradicts/);
  assert.ok(g.needs_n >= 1 && g.needs_unit === 'league_seasons');
  assert.match(g.detail.low_power, /low power/);
});

test('empty: no replayable seasons says what it needs', () => {
  const g = E.grade([], { reason: 'source table league_week_scores is not built yet' });
  assert.equal(g.status, 'not_enough_data');
  assert.equal(g.needs_n, E.MIN_LEAGUE_SEASONS);
  assert.match(g.needs_text, /not built yet/);
});

function espnPayload() {
  return JSON.stringify({
    settings: {
      scheduleSettings: { matchupPeriodCount: 14, matchupPeriodLength: 1, playoffTeamCount: 4, playoffMatchupPeriodLength: 2,
        playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED', divisions: [{ id: 0, size: 8 }] },
      acquisitionSettings: { acquisitionType: 'WAIVERS', isUsingAcquisitionBudget: false, waiverOrderReset: false },
    },
    teams: Array.from({ length: 8 }, (_, i) => ({ id: i + 1, divisionId: 0 })),
    schedule: [],
  });
}

test('load: replays 2023-24 from the database, never reads 2025 or 2026, never selects credentials', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE leagues (id INTEGER PRIMARY KEY, platform TEXT, payload TEXT, espn_s2 TEXT, swid TEXT);
    CREATE TABLE league_week_scores (league_id INTEGER, season INTEGER, week INTEGER, roster_id TEXT, points REAL,
      opponent_roster_id TEXT, is_playoff INTEGER, captured_at TEXT);
    CREATE TABLE league_season_teams (league_id INTEGER, season INTEGER, roster_id TEXT, playoff_seed INTEGER, final_rank INTEGER);`);
  db.prepare('INSERT INTO leagues VALUES (1, ?, ?, ?, ?)').run('espn', espnPayload(), 'SECRET_S2', 'SECRET_SWID');
  const insW = db.prepare('INSERT INTO league_week_scores VALUES (1, ?, ?, ?, ?, ?, ?, ?)');
  const insT = db.prepare('INSERT INTO league_season_teams VALUES (1, ?, ?, ?, ?)');
  for (const [season, seed] of [[2023, 11], [2024, 12], [2025, 13], [2026, 14]]) {
    const lg = synthLeague({ seed });
    for (const r of lg.weekRows) insW.run(season, r.week, r.roster_id, r.points, r.opponent_roster_id, r.is_playoff, 'x');
    for (const t of lg.teams) insT.run(season, t.roster_id, t.playoff_seed, t.final_rank);
  }
  const { rows, excluded } = E.load(db, { runs: 200 });
  assert.deepEqual([...new Set(rows.map(r => r.season))].sort(), [2023, 2024]);
  assert.equal(rows.length, 16);
  assert.equal(excluded.held_out_2025_plus, 1);
  assert.equal(excluded.error, 0, JSON.stringify(excluded.errors));
  const row = E.run(db, { runs: 200 });
  assert.equal(row.check, 'E3-ESPN');
  assert.equal(row.n, 16);
  assert.equal(row.detail.n_league_seasons, 2);
  assert.ok(!JSON.stringify(row).includes('SECRET'), 'no credential reaches the row');
  // The row satisfies brain_report's constraints (migration 078) and reads back.
  brainReportUp(db);
  writeReport(db, [row], { now: new Date('2026-09-24T12:00:00Z') });
  const back = latestReport(db).checks.find(c => c.check === 'E3-ESPN');
  assert.equal(back.status, 'not_enough_data');
  assert.equal(back.n, 16);
  assert.equal(back.detail.kind, 'historical_replay');
  // Sum of probabilities is the field size / one champion per league-season.
  for (const season of [2023, 2024]) {
    const s = rows.filter(r => r.season === season);
    assert.ok(Math.abs(s.reduce((a, r) => a + r.p_playoffs, 0) - 4) < 1e-9);
    assert.ok(Math.abs(s.reduce((a, r) => a + r.p_title, 0) - 1) < 1e-9);
  }
});
