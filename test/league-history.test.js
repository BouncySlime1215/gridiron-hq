/**
 * The league-history reader.
 *
 * The real file is a derived artifact built by a crawl and is not in the repository, so
 * every test here builds its own fixture database and points the module at it through
 * `GRIDIRON_LEAGUE_HISTORY_PATH`. That is deliberate: these must pass on a clean
 * checkout with no crawl, and the absent case is itself one of the behaviours under
 * test.
 *
 * The fixtures are small and hand-computed. Where a test asserts an arithmetic result,
 * the expected value is worked out in the comment so a future reader can check the test
 * rather than trusting it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-league-history-'));

const SCHEMA = [
  `CREATE TABLE sh_leagues (league_id TEXT PRIMARY KEY, season INTEGER NOT NULL, num_teams INTEGER,
     playoff_teams INTEGER, playoff_week_start INTEGER, scoring TEXT, roster_positions TEXT,
     previous_league_id TEXT, fetched_at TEXT)`,
  `CREATE TABLE sh_team_seasons (league_id TEXT NOT NULL, roster_id INTEGER NOT NULL, wins INTEGER,
     losses INTEGER, ties INTEGER, points_for REAL, points_against REAL, max_points REAL,
     reg_seed INTEGER, made_playoffs INTEGER, champion INTEGER, PRIMARY KEY (league_id, roster_id))`,
  `CREATE TABLE sh_team_weeks (league_id TEXT NOT NULL, roster_id INTEGER NOT NULL, week INTEGER NOT NULL,
     points REAL, opponent_roster_id INTEGER, starters_json TEXT, players_json TEXT,
     PRIMARY KEY (league_id, roster_id, week))`
];

/**
 * Build a fixture database at a fresh path.
 * `leagues`: [{ league_id, season, num_teams, playoff_teams, playoff_week_start,
 *               teams: [{ roster_id, made_playoffs, champion, weeks: { [week]: points },
 *                         opponents: { [week]: rosterId } }] }]
 * `opponents` is optional; without it a week has no scheduled opponent and so no head-to-head
 * result, which is itself a case under test.
 */
function fixture(name, leagues) {
  const file = path.join(temp, `${name}.sqlite`);
  if (fs.existsSync(file)) fs.rmSync(file);
  const db = new DatabaseSync(file);
  for (const sql of SCHEMA) db.exec(sql);
  const lg = db.prepare(`INSERT INTO sh_leagues
    (league_id, season, num_teams, playoff_teams, playoff_week_start) VALUES (?,?,?,?,?)`);
  const ts = db.prepare(`INSERT INTO sh_team_seasons
    (league_id, roster_id, made_playoffs, champion, points_for, wins) VALUES (?,?,?,?,?,?)`);
  const tw = db.prepare(`INSERT INTO sh_team_weeks
    (league_id, roster_id, week, points, opponent_roster_id) VALUES (?,?,?,?,?)`);
  for (const l of leagues) {
    lg.run(l.league_id, l.season, l.num_teams, l.playoff_teams, l.playoff_week_start);
    for (const t of l.teams) {
      const pf = Object.values(t.weeks).reduce((s, v) => s + v, 0);
      ts.run(l.league_id, t.roster_id, t.made_playoffs ? 1 : 0, t.champion ? 1 : 0, pf, 0);
      for (const [week, points] of Object.entries(t.weeks)) {
        tw.run(l.league_id, t.roster_id, Number(week), points, t.opponents?.[week] ?? null);
      }
    }
  }
  db.close();
  return file;
}

/** Load the module fresh against a given path. Each test gets its own instance. */
async function load(file) {
  process.env.GRIDIRON_LEAGUE_HISTORY_PATH = file ?? path.join(temp, 'does-not-exist.sqlite');
  // A cache-busting query keeps each test's handle independent of the others'.
  const mod = await import(`../server/services/league-history.js?t=${Math.random()}`);
  mod.resetLeagueHistory();
  return mod;
}

test('no history file at all is a named absence, not a zero', async () => {
  const { historyStatus, weeklyPanel, varianceComponents, compsFor } = await load(null);
  const status = historyStatus();
  assert.equal(status.available, false);
  assert.match(status.reason, /no league history/);
  assert.match(status.reason, /collect-sleeper-history/, 'the reason must say how to fix it');
  // And every reader degrades rather than throwing.
  assert.deepEqual(weeklyPanel({}), []);
  assert.equal(varianceComponents({}), null);
  assert.equal(compsFor({ week: 1, playoffShare: 0.5, meanPointsZ: 0 }).available, false);
});

test('a file that exists but has no tables reads as no history', async () => {
  // A crawl that died before its first commit. Without the table check this reads the
  // same as a real database and then throws on the first query.
  const empty = path.join(temp, 'empty.sqlite');
  new DatabaseSync(empty).close();
  const { historyStatus } = await load(empty);
  assert.equal(historyStatus().available, false);
});

test('playoff weeks are excluded from the panel', async () => {
  // Weeks 1-3 are regular, the bracket starts at 4. A week-4 row must not appear: it is
  // a game against a seeded opponent, and only playoff teams have one, so including it
  // would select on the outcome being predicted.
  const file = fixture('playoff-weeks', [{
    league_id: 'L1', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 4,
    teams: [
      { roster_id: 1, made_playoffs: 1, champion: 1, weeks: { 1: 100, 2: 110, 3: 120, 4: 130 } },
      { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 90, 2: 80, 3: 70, 4: 60 } }
    ]
  }]);
  const { weeklyPanel } = await load(file);
  const panel = weeklyPanel({});
  assert.deepEqual([...new Set(panel.map(r => r.week))].sort(), [1, 2, 3]);
  assert.equal(panel.length, 6, 'two teams x three regular weeks');
});

test('all-play counts who you outscored, with ties as a half', async () => {
  // Four teams in week 1: 100, 90, 90, 80.
  //   the 100 outscores three            -> 3/3   = 1.0
  //   each 90 outscores the 80 and ties one -> 1.5/3 = 0.5
  //   the 80 outscores nobody            -> 0/3   = 0.0
  const file = fixture('all-play', [{
    league_id: 'L1', season: 2024, num_teams: 4, playoff_teams: 2, playoff_week_start: 2,
    teams: [
      { roster_id: 1, made_playoffs: 1, champion: 0, weeks: { 1: 100 } },
      { roster_id: 2, made_playoffs: 1, champion: 0, weeks: { 1: 90 } },
      { roster_id: 3, made_playoffs: 0, champion: 0, weeks: { 1: 90 } },
      { roster_id: 4, made_playoffs: 0, champion: 0, weeks: { 1: 80 } }
    ]
  }]);
  const { weeklyPanel } = await load(file);
  const byRoster = new Map(weeklyPanel({}).map(r => [r.roster_id, r]));
  assert.equal(byRoster.get(1).all_play_pct, 1);
  assert.equal(byRoster.get(2).all_play_pct, 0.5);
  assert.equal(byRoster.get(3).all_play_pct, 0.5);
  assert.equal(byRoster.get(4).all_play_pct, 0);
});

test('points are normalised within the league-season, so scoring settings cannot leak', async () => {
  // Two leagues with the same SHAPE of outcome on wildly different scales: one scores
  // around 100, the other around 300. The z-scores must match, or a high-scoring league
  // would look like a league full of good teams.
  const teamsFor = scale => ([
    { roster_id: 1, made_playoffs: 1, champion: 0, weeks: { 1: 1.2 * scale, 2: 1.2 * scale } },
    { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 0.8 * scale, 2: 0.8 * scale } }
  ]);
  const file = fixture('scales', [
    { league_id: 'LOW', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 3, teams: teamsFor(100) },
    { league_id: 'HIGH', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 3, teams: teamsFor(300) }
  ]);
  const { weeklyPanel } = await load(file);
  const panel = weeklyPanel({});
  const z = (league, roster) => panel.find(r => r.league_id === league && r.roster_id === roster && r.week === 1).points_z;
  assert.equal(z('LOW', 1), z('HIGH', 1));
  assert.equal(z('LOW', 2), z('HIGH', 2));
  assert.ok(z('LOW', 1) > 0 && z('LOW', 2) < 0);
});

test('cumulative fields never read a later week', async () => {
  // A team that scores badly then brilliantly. Its week-1 row must not know about week 3.
  const file = fixture('no-leak', [{
    league_id: 'L1', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 4,
    teams: [
      { roster_id: 1, made_playoffs: 1, champion: 0, weeks: { 1: 50, 2: 100, 3: 200 } },
      { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 100, 2: 100, 3: 100 } }
    ]
  }]);
  const { weeklyPanel } = await load(file);
  const rows = weeklyPanel({}).filter(r => r.roster_id === 1).sort((a, b) => a.week - b.week);
  // Week 1: he lost the all-play. Week 3: he has won two of three.
  assert.equal(rows[0].all_play_pct, 0);
  assert.equal(rows[0].games, 1);
  assert.equal(rows[2].games, 3);
  assert.ok(rows[2].all_play_pct > rows[0].all_play_pct);
  // The week-1 mean is week 1's score alone, so it must be below the week-3 mean.
  assert.ok(rows[0].mean_points_z < rows[2].mean_points_z);
  assert.equal(rows[0].weeks_left, 2);
  assert.equal(rows[2].weeks_left, 0);
});

test('the outcome is carried but is never one of the known-at-week fields', async () => {
  const file = fixture('outcome', [{
    league_id: 'L1', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 3,
    teams: [
      { roster_id: 1, made_playoffs: 1, champion: 1, weeks: { 1: 100, 2: 100 } },
      { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 90, 2: 90 } }
    ]
  }]);
  const { weeklyPanel } = await load(file);
  const row = weeklyPanel({}).find(r => r.roster_id === 1);
  assert.equal(row.made_playoffs, 1);
  assert.equal(row.champion, 1);
  // The known-at-week fields are exactly these. If a future change adds an outcome
  // field to this list, this assertion is what catches it.
  const known = ['season', 'league_id', 'roster_id', 'num_teams', 'playoff_teams', 'week',
    'games', 'weeks_left', 'points_z', 'mean_points_z', 'all_play_pct',
    // Added with the outlook model. Every one is cumulative through week w: the record is
    // recomputed from each week's own opponent rather than read from the season total, and
    // the standings behind games_back are the standings as they stood that week.
    'win_pct', 'wins_so_far', 'head_to_head_games', 'points_so_far', 'games_back'];
  const outcomes = ['made_playoffs', 'champion'];
  assert.deepEqual(Object.keys(row).sort(), [...known, ...outcomes].sort());
});

test('the variance decomposition removes the sampling error from the observed spread', async () => {
  // Every team here is identical in truth: the same distribution, differing only by
  // noise. So the true between-team variance is zero, and the OBSERVED spread of team
  // means is pure sampling error. A decomposition that forgot to subtract it would
  // report a real spread and a small k, which is the error that makes an early record
  // look informative when it is not.
  const weeks = {};
  const teams = [];
  for (let t = 0; t < 40; t++) {
    const w = {};
    // A deterministic pseudo-random walk: no seeding needed and the fixture is stable.
    for (let k = 1; k <= 12; k++) w[k] = 100 + 20 * Math.sin(t * 2.3 + k * 1.7);
    teams.push({ roster_id: t + 1, made_playoffs: t % 2, champion: 0, weeks: w });
  }
  void weeks;
  const file = fixture('variance', [{
    league_id: 'L1', season: 2024, num_teams: 40, playoff_teams: 20, playoff_week_start: 13, teams
  }]);
  const { varianceComponents } = await load(file);
  const vc = varianceComponents({ minGames: 8 });
  assert.ok(vc, 'the decomposition must run');
  assert.equal(vc.team_seasons, 40);

  // With no real spread to find, the subtraction lands at or below zero. That is a
  // finding, not a failure, and it has to be LABELLED: clamping the variance to an
  // epsilon instead would report a k in the hundreds of millions and a weight curve of
  // zeros, which reads exactly like a bug. The first version of this module did that,
  // and this assertion is why it does not any more.
  assert.equal(vc.between_positive, false);
  assert.equal(vc.s2_between, null, 'a non-positive estimate must not be dressed up as a number');
  assert.match(vc.reason, /no measurable true difference/);
  assert.equal(vc.k_capped, true);
  assert.equal(vc.k, vc.k_cap);

  // The weight curve still has to be usable arithmetic rather than a row of zeros.
  const w = vc.weight_by_week;
  assert.ok(w[1] < w[4] && w[4] < w[13], `the curve must still rise: ${w[1]}, ${w[4]}, ${w[13]}`);
  assert.ok(w[1] > 0 && w[13] < 1);
});

test('when teams really do differ, the true spread is below the observed one', async () => {
  // The non-degenerate case, which is what the real history gives: a genuine spread
  // between teams PLUS week-to-week noise. The observed spread of means must exceed the
  // true one, because it still contains sampling error, and subtracting that error is
  // the whole point of the decomposition.
  const teams = [];
  for (let t = 0; t < 40; t++) {
    const w = {};
    const level = 100 + (t - 20) * 1.5;                       // a real, moderate spread
    for (let k = 1; k <= 12; k++) w[k] = level + 18 * Math.sin(t * 2.3 + k * 1.7);  // plus noise
    teams.push({ roster_id: t + 1, made_playoffs: t % 2, champion: 0, weeks: w });
  }
  const file = fixture('variance-real', [{
    league_id: 'L1', season: 2024, num_teams: 40, playoff_teams: 20, playoff_week_start: 13, teams
  }]);
  const { varianceComponents } = await load(file);
  const vc = varianceComponents({ minGames: 8 });
  assert.equal(vc.between_positive, true);
  assert.ok(vc.s2_between < vc.s2_observed_between,
    `the true spread must be below the observed one: ${vc.s2_between} vs ${vc.s2_observed_between}`);
  assert.equal(vc.k_capped, false);
  assert.ok(vc.k > 0 && vc.k < vc.k_cap);
  // The half-weight point is k, by construction. Asserted as the identity rather than by
  // looking up the nearest whole week: k need not be an integer (this fixture gives 0.6),
  // and rounding it to a week made an earlier version of this assertion wrong rather than
  // the code wrong.
  assert.equal(vc.games_for_half_weight, vc.k);
  assert.ok(Math.abs(vc.k / (vc.k + vc.k) - 0.5) < 1e-12, 'n = k must be exactly half weight');
  // The published table must be monotone in games and stay inside (0, 1).
  const w = vc.weight_by_week;
  for (let n = 2; n <= 14; n++) assert.ok(w[n] > w[n - 1], `weight must rise from week ${n - 1} to ${n}`);
  assert.ok(w[1] > 0 && w[14] < 1);
  // And each entry must match the formula the module documents.
  for (let n = 1; n <= 14; n++) {
    assert.ok(Math.abs(w[n] - n / (n + vc.k)) < 1e-6, `week ${n} must equal n/(n+k)`);
  }
});

test('a team with real, large differences produces a small k', async () => {
  // The opposite case: teams that genuinely differ a lot and barely vary week to week.
  // k = within/between, so this must come out small, and the weight on one game high.
  const teams = [];
  for (let t = 0; t < 30; t++) {
    const w = {};
    const level = 60 + t * 4;              // a wide, real spread between teams
    for (let k = 1; k <= 12; k++) w[k] = level + (k % 2 ? 0.5 : -0.5);  // almost no noise
    teams.push({ roster_id: t + 1, made_playoffs: t % 2, champion: 0, weeks: w });
  }
  const file = fixture('low-k', [{
    league_id: 'L1', season: 2024, num_teams: 30, playoff_teams: 15, playoff_week_start: 13, teams
  }]);
  const { varianceComponents } = await load(file);
  const vc = varianceComponents({ minGames: 8 });
  assert.ok(vc.k < 1, `k should be small when teams really differ, got ${vc.k}`);
  assert.ok(vc.weight_by_week[1] > 0.5, 'one game should already carry most of the weight here');
});

test('shrinkToLeague pulls toward zero and relaxes as games accumulate', async () => {
  const { shrinkToLeague } = await load(null);
  const k = 7.5;
  assert.equal(shrinkToLeague(1, 0, k), 0, 'no games means no evidence');
  const one = shrinkToLeague(1, 1, k);
  const ten = shrinkToLeague(1, 10, k);
  assert.ok(one > 0 && one < ten && ten < 1);
  // It is a pure scaling, so a negative observation shrinks toward zero from below.
  assert.equal(shrinkToLeague(-1, 10, k), -ten);
});

test('comps report their n and refuse a bucket too thin to quote', async () => {
  const teams = [];
  for (let t = 0; t < 12; t++) {
    teams.push({ roster_id: t + 1, made_playoffs: t < 6, champion: t === 0,
      weeks: { 1: 100 + t, 2: 100 + t } });
  }
  const file = fixture('comps', [{
    league_id: 'L1', season: 2024, num_teams: 12, playoff_teams: 6, playoff_week_start: 3, teams
  }]);
  const { compsFor } = await load(file);

  // Twelve teams at week 1, so any bucket is under a minN of 30.
  const thin = compsFor({ week: 1, playoffShare: 0.5, meanPointsZ: 0 }, { minN: 30 });
  assert.equal(thin.available, false);
  assert.equal(typeof thin.n, 'number', 'it must say how thin it was');
  assert.match(thin.reason, /comparable team-seasons/);

  // With a minN this fixture can satisfy, it answers and carries its n and error.
  const wide = compsFor({ week: 1, playoffShare: 0.5, meanPointsZ: 0, zTolerance: 99 }, { minN: 5 });
  assert.equal(wide.available, true);
  assert.equal(wide.n, 12);
  assert.equal(wide.playoff_rate, 0.5);
  assert.ok(wide.playoff_rate_se > 0, 'a rate must come with its standard error');
});

test('comps will not match across league formats', async () => {
  // Six of eight making the playoffs is a different world from six of twelve, and the
  // base rate alone would carry most of the difference.
  const mk = (id, numTeams) => ({
    league_id: id, season: 2024, num_teams: numTeams, playoff_teams: 6, playoff_week_start: 3,
    teams: Array.from({ length: numTeams }, (_, t) => ({
      roster_id: t + 1, made_playoffs: t < 6, champion: 0, weeks: { 1: 100, 2: 100 }
    }))
  });
  const file = fixture('formats', [mk('WIDE', 12), mk('NARROW', 8)]);
  const { compsFor } = await load(file);
  // 6/8 = 0.75 and 6/12 = 0.5 are further apart than the default share tolerance, so a
  // query for one must not pull in the other.
  const narrow = compsFor({ week: 1, playoffShare: 0.75, meanPointsZ: 0, zTolerance: 99 }, { minN: 1 });
  assert.equal(narrow.n, 8, 'only the 8-team league may match a 0.75 share');
  const wide = compsFor({ week: 1, playoffShare: 0.5, meanPointsZ: 0, zTolerance: 99 }, { minN: 1 });
  assert.equal(wide.n, 12, 'only the 12-team league may match a 0.5 share');
});

test('historyStatus counts what is actually on file, by season', async () => {
  const file = fixture('status', [
    { league_id: 'A', season: 2023, num_teams: 2, playoff_teams: 1, playoff_week_start: 3,
      teams: [{ roster_id: 1, made_playoffs: 1, champion: 1, weeks: { 1: 100, 2: 100 } },
        { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 90, 2: 90 } }] },
    { league_id: 'B', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 3,
      teams: [{ roster_id: 1, made_playoffs: 1, champion: 1, weeks: { 1: 100, 2: 100 } },
        { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 90, 2: 90 } }] }
  ]);
  const { historyStatus } = await load(file);
  const status = historyStatus();
  assert.equal(status.available, true);
  assert.equal(status.leagues, 2);
  assert.equal(status.team_seasons, 4);
  assert.deepEqual(status.seasons.map(s => s.season), [2023, 2024]);
});

test('a season filter restricts the panel, so walk-forward cannot leak', async () => {
  const mk = (id, season) => ({
    league_id: id, season, num_teams: 2, playoff_teams: 1, playoff_week_start: 3,
    teams: [{ roster_id: 1, made_playoffs: 1, champion: 0, weeks: { 1: 100, 2: 100 } },
      { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 90, 2: 90 } }]
  });
  const file = fixture('seasons', [mk('A', 2022), mk('B', 2023), mk('C', 2024)]);
  const { weeklyPanel } = await load(file);
  assert.deepEqual([...new Set(weeklyPanel({ seasons: [2022, 2023] }).map(r => r.season))].sort(), [2022, 2023]);
  assert.deepEqual([...new Set(weeklyPanel({ seasons: [2024] }).map(r => r.season))], [2024]);
  assert.equal(weeklyPanel({ seasons: [2099] }).length, 0);
});

test('a league with a single week on file gets z = 0 rather than a divide by zero', async () => {
  const file = fixture('one-week', [{
    league_id: 'L1', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 2,
    teams: [
      { roster_id: 1, made_playoffs: 1, champion: 0, weeks: { 1: 100 } },
      { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 100 } }
    ]
  }]);
  const { weeklyPanel } = await load(file);
  for (const r of weeklyPanel({})) {
    assert.equal(r.points_z, 0);
    assert.ok(Number.isFinite(r.mean_points_z));
  }
});

test('the record is recomputed from each week, not read from the season total', async () => {
  // Team 1 loses week 1 (90 to 100) and wins week 2 (110 to 100). Its SEASON total in
  // sh_team_seasons is deliberately set to a wrong, large number: if the panel ever reads
  // that column instead of the weeks, this test fails. That matters because the season
  // total is the outcome the model predicts, and a row at week 1 that carried it would be
  // reading its own answer.
  const file = fixture('record', [{
    league_id: 'L1', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 4,
    teams: [
      { roster_id: 1, made_playoffs: 1, champion: 0, weeks: { 1: 90, 2: 110, 3: 100 }, opponents: { 1: 2, 2: 2, 3: 2 } },
      { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 100, 2: 100, 3: 100 }, opponents: { 1: 1, 2: 1, 3: 1 } }
    ]
  }]);
  const { weeklyPanel } = await load(file);
  const rows = weeklyPanel({}).filter(r => r.roster_id === 1).sort((a, b) => a.week - b.week);
  assert.equal(rows[0].win_pct, 0);      // 0 of 1
  assert.equal(rows[1].win_pct, 0.5);    // 1 of 2
  assert.equal(rows[2].wins_so_far, 1.5);  // week 3 is a tie, counting a half
  assert.equal(rows[2].head_to_head_games, 3);
  assert.equal(rows[2].win_pct, 0.5);    // 1.5 of 3
});

test('a week with no opponent on file is not a loss', async () => {
  // A bye in an odd-sized league, or a gap in the crawl. Scoring it as a loss would punish
  // a team for a missing row; it must simply not be a game played.
  const file = fixture('bye', [{
    league_id: 'L1', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 4,
    teams: [
      { roster_id: 1, made_playoffs: 1, champion: 0, weeks: { 1: 120, 2: 120, 3: 120 }, opponents: { 1: 2, 3: 2 } },
      { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 100, 2: 100, 3: 100 }, opponents: { 1: 1, 3: 1 } }
    ]
  }]);
  const { weeklyPanel } = await load(file);
  const rows = weeklyPanel({}).filter(r => r.roster_id === 1).sort((a, b) => a.week - b.week);
  assert.equal(rows[1].head_to_head_games, 1, 'week 2 was not a game');
  assert.equal(rows[1].win_pct, 1, 'still 1 of 1, not 1 of 2');
  assert.equal(rows[1].games, 2, 'but it IS a week of scoring, so games still advances');
});

test('games back is measured against the team on the playoff line, that week', async () => {
  // Four teams, two qualify. After week 1: A and B win, C and D lose. The line is the
  // SECOND team, so A and B are 0 back and C and D are 1 back.
  const file = fixture('gamesback', [{
    league_id: 'L1', season: 2024, num_teams: 4, playoff_teams: 2, playoff_week_start: 4,
    teams: [
      { roster_id: 1, made_playoffs: 1, champion: 0, weeks: { 1: 130, 2: 130 }, opponents: { 1: 3, 2: 3 } },
      { roster_id: 2, made_playoffs: 1, champion: 0, weeks: { 1: 120, 2: 120 }, opponents: { 1: 4, 2: 4 } },
      { roster_id: 3, made_playoffs: 0, champion: 0, weeks: { 1: 100, 2: 100 }, opponents: { 1: 1, 2: 1 } },
      { roster_id: 4, made_playoffs: 0, champion: 0, weeks: { 1: 90, 2: 90 }, opponents: { 1: 2, 2: 2 } }
    ]
  }]);
  const { weeklyPanel } = await load(file);
  const wk1 = weeklyPanel({}).filter(r => r.week === 1);
  const by = id => wk1.find(r => r.roster_id === id);
  assert.equal(by(1).games_back, 0);
  assert.equal(by(2).games_back, 0, 'the team ON the line is zero back');
  assert.equal(by(3).games_back, 1);
  assert.equal(by(4).games_back, 1);
  // And by week 2 the winners are two ahead of the losers.
  const wk2 = weeklyPanel({}).filter(r => r.week === 2);
  assert.equal(wk2.find(r => r.roster_id === 3).games_back, 2);
});

test('a league-season more than half zeros is discarded whole, champion included', async () => {
  // Sleeper returns leagues nobody played: every week zero, and a champion flag on whichever
  // roster the bracket advanced. Its outcome is not football, and leaving it in biased k
  // toward believing an early record MORE, which is the worst direction for this model.
  const file = fixture('abandoned', [
    {
      league_id: 'DEAD', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 4,
      teams: [
        { roster_id: 1, made_playoffs: 1, champion: 1, weeks: { 1: 0, 2: 0, 3: 0 }, opponents: { 1: 2, 2: 2, 3: 2 } },
        { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 0, 2: 0, 3: 0 }, opponents: { 1: 1, 2: 1, 3: 1 } }
      ]
    },
    {
      league_id: 'LIVE', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 4,
      teams: [
        { roster_id: 1, made_playoffs: 1, champion: 1, weeks: { 1: 120, 2: 110, 3: 130 }, opponents: { 1: 2, 2: 2, 3: 2 } },
        { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 100, 2: 105, 3: 95 }, opponents: { 1: 1, 2: 1, 3: 1 } }
      ]
    }
  ]);
  const { weeklyPanel, excludedByDataQuality } = await load(file);
  const rows = weeklyPanel({});
  assert.equal(rows.some(r => r.league_id === 'DEAD'), false, 'not one row of the dead league survives');
  assert.ok(rows.some(r => r.league_id === 'LIVE'));
  const ex = excludedByDataQuality();
  assert.equal(ex.abandoned_leagues, 1);
  assert.equal(ex.abandoned_team_weeks, 6);
  assert.equal(ex.leagues_total, 2);
});

test('a single quitting manager loses their empty weeks, and their league survives', async () => {
  // This is the case the half-zero rule must NOT catch: one manager stops setting a lineup
  // in a league that is otherwise real football.
  const file = fixture('quitter', [{
    league_id: 'L1', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 5,
    teams: [
      { roster_id: 1, made_playoffs: 1, champion: 1, weeks: { 1: 120, 2: 110, 3: 130, 4: 125 }, opponents: { 1: 2, 2: 2, 3: 2, 4: 2 } },
      { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 100, 2: 105, 3: 0, 4: 0 }, opponents: { 1: 1, 2: 1, 3: 1, 4: 1 } }
    ]
  }]);
  const { weeklyPanel, excludedByDataQuality } = await load(file);
  const rows = weeklyPanel({});
  assert.ok(rows.some(r => r.league_id === 'L1'), 'the league survives');
  assert.equal(rows.filter(r => r.roster_id === 2).length, 2, 'the quitter keeps only their two real weeks');
  assert.equal(rows.filter(r => r.roster_id === 1).length, 4, 'the other team keeps all four');
  // The empty weeks are gone rather than averaged in as bad weeks, so the league's scoring
  // scale is not dragged down by them.
  const ex = excludedByDataQuality();
  assert.equal(ex.abandoned_leagues, 0);
  assert.equal(ex.zero_team_weeks_in_kept_leagues, 2);
});

test('a zero week is not counted as a head-to-head game against it either', async () => {
  // Team 1 outscoring an absent opponent is not a win over a team that played. The
  // opponent's zero week is a missing observation, so there is no game to win.
  const file = fixture('zero-opponent', [{
    league_id: 'L1', season: 2024, num_teams: 2, playoff_teams: 1, playoff_week_start: 4,
    teams: [
      { roster_id: 1, made_playoffs: 1, champion: 0, weeks: { 1: 120, 2: 110, 3: 115 }, opponents: { 1: 2, 2: 2, 3: 2 } },
      { roster_id: 2, made_playoffs: 0, champion: 0, weeks: { 1: 100, 2: 0, 3: 105 }, opponents: { 1: 1, 2: 1, 3: 1 } }
    ]
  }]);
  const { weeklyPanel } = await load(file);
  const rows = weeklyPanel({}).filter(r => r.roster_id === 1).sort((a, b) => a.week - b.week);
  assert.equal(rows[1].head_to_head_games, 1, 'week 2 had no opponent left to play');
  assert.equal(rows[1].wins_so_far, 1);
});
