/**
 * CE-05 — the season simulator plays the bracket in the league's format.
 *
 * test/league-rules.test.js pins playBracket directly; this file pins the call
 * site: simulateSeason must hand playBracket the league's own reseed flag. The
 * mutation sweep's M10 (sim passes `reseed: true`) survived that file, because
 * with no projections every playoff game is a 0-0 tie and the better seed
 * always advances, so a fixed and a re-seeded bracket crown the same teams.
 *
 * Here every team has one QB whose every draw is a fixed number, so scores are
 * deterministic: T1 100, T6 90, T2 80, T3 70, T4 60, T5 50. Weeks 1-2 are
 * carried in so the seeds are T1..T6 in order (T6, the second-best scorer, is
 * seeded 6th). Fixed bracket: T6 beats T3, then T2 in round 2, and meets T1
 * in the final. Re-seeded: T1 takes T6 in round 2, so T2 reaches the final.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ce05-bracket-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '3';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (911, 'HOM', 'Home Team', 'AFC', 'East'), (912, 'AWY', 'Away Team', 'NFC', 'West')`);
// NFL games only in weeks 1-6: a bracket played on any other week scores 0-0.
for (let w = 1; w <= 6; w++) {
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 911, ?, 'AWY', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 912, ?, 'HOM', 0)`, w);
}

const realTradeEngine = await import('../server/services/trade-engine.js');
const realProjections = await import('../server/services/projections.js');
const realGamescript = await import('../server/services/gamescript.js');
const realCorrelation = await import('../server/services/correlation.js');
const realContingency = await import('../server/services/contingency.js');

const STRENGTH = { 1: 100, 2: 80, 3: 70, 4: 60, 5: 50, 6: 90 };
const assets = new Map();
const projMap = new Map();
for (let t = 1; t <= 6; t++) {
  const id = 500 + t;
  assets.set(id, { id, name: `QB ${t}`, position: 'QB', team_abbr: t % 2 ? 'HOM' : 'AWY', espn_id: 8000 + t,
    available: true, current_week_ppg: 10, adj_ppg: 10, ppg: 10, ros_ppg: 10 });
  projMap.set(id, { params: { pid: id, strength: STRENGTH[t] }, volume: { target_share: null } });
}

mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
});
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: () => projMap,
    sampleWeeks: (params, n) => Array.from({ length: n }, () => params.strength)
  }
});
mock.module('../server/services/gamescript.js', {
  namedExports: { ...realGamescript, gameScriptFor: () => ({ pass_mult: 1, rush_mult: 1, line: null }) }
});
mock.module('../server/services/correlation.js', {
  namedExports: { ...realCorrelation, correlatedSampler: (_p, samples) => () => samples.map(s => s[0]) }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});
// Loaded under a fresh URL so its own imports resolve to the mocks (see
// decision-leftovers-home-away.test.js for why).
const { simulateSeason } = await import('../server/services/season-sim.js?ce05-bracket');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** Weeks 1-2 carried in (seeds T1..T6), week 3 simulated, playoffs weeks 4-6. */
function payload(reseed) {
  // After week 2: T1 2-0, T2 2-0, T3 1-1, T4 1-1, T5 0-2 (200 pts), T6 0-2 (40 pts).
  const played = { 1: [[1, 5, 150, 100], [2, 6, 140, 20], [3, 4, 120, 100]],
    2: [[1, 6, 150, 20], [2, 5, 140, 100], [4, 3, 110, 90]] };
  const schedule = [];
  for (const [w, games] of Object.entries(played)) {
    for (const [h, a, hp, ap] of games) {
      schedule.push({ matchupPeriodId: Number(w), winner: hp > ap ? 'HOME' : 'AWAY',
        home: { teamId: h, totalPoints: hp }, away: { teamId: a, totalPoints: ap } });
    }
  }
  for (const [h, a] of [[1, 6], [2, 5], [3, 4]]) {
    schedule.push({ matchupPeriodId: 3, winner: 'UNDECIDED', home: { teamId: h }, away: { teamId: a } });
  }
  return {
    teams: [1, 2, 3, 4, 5, 6].map(t => ({ id: t, divisionId: 0,
      roster: { entries: [{ lineupSlotId: 0,
        playerPoolEntry: { player: { id: 8000 + t, fullName: `QB ${t}`, defaultPositionId: 1 } } }] } })),
    schedule,
    settings: { scheduleSettings: { matchupPeriodCount: 3, matchupPeriodLength: 1, playoffTeamCount: 6,
      playoffMatchupPeriodLength: 1, playoffReseed: reseed, playoffSeedingRule: 'TOTAL_POINTS_SCORED',
      divisions: [{ id: 0, size: 6 }] } },
  };
}

function insert(id, reseed) {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions,
       payload, current_week, payload_season) VALUES (?, 'espn', ?, 2026, 'Bracket', '1', 6, 1, ?, ?, 3, 2026)`,
  id, `bracket-${id}`, JSON.stringify(['QB']), JSON.stringify(payload(reseed)));
  return db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
}

const odds = (sim, id, key) => sim.teams.find(t => String(t.roster_id) === id)[key];

test('CE-05: a fixed bracket (playoffReseed false) sends the 6 seed through the 2 seed to the final', () => {
  const sim = simulateSeason(insert(811, false), { runs: 3, fromWeek: 3 });
  assert.ifError(sim.error);
  assert.deepEqual(sim.playoff_weeks, [[4], [5], [6]]);
  assert.equal(odds(sim, '1', 'title_odds'), 1, 'control: the best scorer wins the title');
  assert.equal(odds(sim, '6', 'finals_odds'), 1, 'T6 (seed 6) reaches the final in a fixed bracket');
  assert.equal(odds(sim, '2', 'finals_odds'), 0, 'T2 (seed 2) meets T6 in round 2 and loses');
});

test('CE-05: control, the same league re-seeded sends the 2 seed to the final instead', () => {
  const sim = simulateSeason(insert(812, true), { runs: 3, fromWeek: 3 });
  assert.ifError(sim.error);
  assert.equal(odds(sim, '2', 'finals_odds'), 1);
  assert.equal(odds(sim, '6', 'finals_odds'), 0);
});

/*
 * The points-for tiebreaker at the call site (skeptic mutant MB1: the sim passes
 * `pf: 0` to seedStandings, which drops TOTAL_POINTS_SCORED from every simulated
 * season and seeds wins-ties by input order). 4 playoff teams, weeks 1-2
 * carried in, week 3 simulated: [1 v 5] [6 v 4] [2 v 3], won by T1, T6, T2.
 * Final wins: T1 3, T2 2, T6 2, T3 1, T4 1, T5 0, so T3 and T4 are level on wins
 * for the 4th and last spot and only points-for separates them. Week 3 adds
 * T3 70 and T4 60. Input order is T3 before T4, so under the mutant T3 always
 * takes the spot; the case where T4 has more points is the one that kills it.
 */
function pfPayload(t3Leads) {
  // [home, away, homePts, awayPts]. T3 and T4 carried points: 200 v 150 when T3
  // leads (270 v 210 after week 3), 150 v 250 when T4 leads (220 v 310).
  const [t3w1, t4w1, t3w2, t4w2] = t3Leads ? [110, 100, 90, 50] : [80, 70, 70, 180];
  const played = {
    1: [[1, 5, 150, 100], [2, 6, 140, 100], [3, 4, t3w1, t4w1]],
    2: [[1, 2, 150, 100], [6, 3, 120, t3w2], [4, 5, t4w2, 40]],
  };
  const schedule = [];
  for (const [w, games] of Object.entries(played)) {
    for (const [h, a, hp, ap] of games) {
      schedule.push({ matchupPeriodId: Number(w), winner: hp > ap ? 'HOME' : 'AWAY',
        home: { teamId: h, totalPoints: hp }, away: { teamId: a, totalPoints: ap } });
    }
  }
  for (const [h, a] of [[1, 5], [6, 4], [2, 3]]) {
    schedule.push({ matchupPeriodId: 3, winner: 'UNDECIDED', home: { teamId: h }, away: { teamId: a } });
  }
  const base = payload(false);
  base.schedule = schedule;
  base.settings.scheduleSettings.playoffTeamCount = 4;
  return base;
}

function insertPf(id, t3Leads) {
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions,
       payload, current_week, payload_season) VALUES (?, 'espn', ?, 2026, 'Tiebreak', '1', 6, 1, ?, ?, 3, 2026)`,
  id, `tiebreak-${id}`, JSON.stringify(['QB']), JSON.stringify(pfPayload(t3Leads)));
  return db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
}

test('CE-05: level on wins for the last playoff spot, the team with more points-for gets it (T4 leads)', () => {
  const sim = simulateSeason(insertPf(813, false), { runs: 3, fromWeek: 3 });
  assert.ifError(sim.error);
  assert.equal(sim.playoff_teams, 4);
  assert.equal(sim.seeding_rule, 'TOTAL_POINTS_SCORED');
  assert.equal(odds(sim, '3', 'expected_wins'), odds(sim, '4', 'expected_wins'), 'T3 and T4 finish level on wins');
  assert.ok(odds(sim, '4', 'expected_points') > odds(sim, '3', 'expected_points'), 'T4 has more points-for');
  assert.equal(odds(sim, '4', 'playoff_odds'), 1, 'T4 wins the tiebreaker and makes the field');
  assert.equal(odds(sim, '3', 'playoff_odds'), 0, 'T3 loses the tiebreaker');
  assert.equal(odds(sim, '5', 'playoff_odds'), 0, 'control: the 0-win team misses');
});

test('CE-05: control, points-for reversed, T3 gets the last playoff spot instead', () => {
  const sim = simulateSeason(insertPf(814, true), { runs: 3, fromWeek: 3 });
  assert.ifError(sim.error);
  assert.equal(odds(sim, '3', 'expected_wins'), odds(sim, '4', 'expected_wins'));
  assert.ok(odds(sim, '3', 'expected_points') > odds(sim, '4', 'expected_points'));
  assert.equal(odds(sim, '3', 'playoff_odds'), 1);
  assert.equal(odds(sim, '4', 'playoff_odds'), 0);
});
