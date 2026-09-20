/**
 * A playoff round longer than one week is decided on BOTH weeks (2026-09-20).
 *
 * `playoffRounds` is tested as a pure function in season-sim-playoff-shape.test.js, but
 * nothing tested what `simulateSeason` does with a multi-week round. A retroactive
 * mutation sweep found the gap: replacing the sum over a round's weeks with its first
 * week alone left all nine of those tests passing. That mutation is exactly the defect
 * #40 exists to fix — league 4's rounds are two NFL weeks, and playing only the first
 * decides each round on half the points it is really decided on, with the wrong byes.
 *
 * So this test drives the simulator itself rather than the bracket helper.
 *
 * HOW IT CATCHES IT. The two fantasy teams are built on opposite NFL teams, and those
 * NFL teams take their byes in opposite halves of the round: the home side has no game
 * in week 16, the away side none in week 17. Over a two-week round each side scores in
 * exactly one of the two weeks, so the matchup is symmetric and neither can be shut
 * out. Scored on week 16 alone, the home side scores nothing at all and loses every
 * run. Symmetry is the assertion; no seed or point total is pinned.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-sim-multiweek-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '2';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (911, 'HOM', 'Home Team', 'AFC', 'East'), (912, 'AWY', 'Away Team', 'NFC', 'West')`);
// HOM is on bye in week 16, AWY in week 17. Every other week both play.
for (let w = 1; w <= 17; w++) {
  if (w !== 16) run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 911, ?, 'AWY', 1)`, w);
  if (w !== 17) run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 912, ?, 'HOM', 0)`, w);
}

const realTradeEngine = await import('../server/services/trade-engine.js');
const realContingency = await import('../server/services/contingency.js');
const realProjections = await import('../server/services/projections.js');

let assets = new Map();
const projMap = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});
// The sampler is stubbed on purpose. What is under test is which WEEKS a round is
// scored over, and a real params fixture would make the result depend on the scoring
// model as well. Every active player draws from the same spread, so the only thing that
// can make the two sides differ is the schedule.
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    sampleWeeks: (_params, n = 2000) => Array.from({ length: n }, () => 8 + Math.random() * 8)
  }
});

// `?after-mocks` is load order, not decoration: trade-engine.js imports season-sim.js, so
// the copy this test drives has to be requested under a URL not yet loaded.
const { simulateSeason } = await import('../server/services/season-sim.js?after-mocks');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
function player(position, team) {
  const id = nextId++;
  projMap.set(id, { params: { pid: id, team, position }, volume: { target_share: 0.1 } });
  return { id, name: `${team} ${position} ${id}`, position, team_abbr: team, espn_id: 7100 + id,
    available: true, current_week_ppg: 10, adj_ppg: 10, ppg: 10, ros_ppg: 10 };
}
const ROSTER = ['QB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE'];
// Every player on one team plays for the same NFL team, so a bye takes the whole roster.
const mine = ROSTER.map(pos => player(pos, 'HOM'));
const theirs = ROSTER.map(pos => player(pos, 'AWY'));
assets = new Map([...mine, ...theirs].map(a => [a.id, a]));
const entry = a => ({ lineupSlotId: 20,
  playerPoolEntry: { player: { id: a.espn_id, fullName: a.name, defaultPositionId: POS_ID[a.position] } } });

/** 13 regular periods, a 2-team field, and one playoff round spanning NFL weeks 16-17. */
function league(id, playoffPeriods) {
  const payload = {
    teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(entry) } },
      { id: 2, name: 'Theirs', roster: { entries: theirs.map(entry) } }],
    schedule: Array.from({ length: 12 }, (_, i) => i + 2)
      .map(w => ({ matchupPeriodId: w, home: { teamId: 1 }, away: { teamId: 2 } })),
    settings: { scheduleSettings: {
      matchupPeriodCount: 13, playoffTeamCount: 2,
      matchupPeriods: {
        ...Object.fromEntries(Array.from({ length: 13 }, (_, i) => [String(i + 1), [i + 1]])),
        ...playoffPeriods
      }
    } }
  };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (?, 'espn', ?, 2026, 'Multi week round', '1', 2, 1, ?, ?)`,
  id, `mw-${id}`, JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']), JSON.stringify(payload));
  return db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
}

test('the bracket the simulator plays is the league\'s, and it spans both weeks', () => {
  const sim = simulateSeason(league(811, { 14: [16, 17] }), { runs: 200, fromWeek: 2, projections: projMap });
  assert.ifError(sim.error);
  assert.deepEqual(sim.playoff_rounds, [[16, 17]]);
  assert.equal(sim.playoff_basis, 'league_schedule');
});

test('a two-week round is decided on the total, so a week-16 bye is not a lost title', () => {
  const sim = simulateSeason(league(812, { 14: [16, 17] }), { runs: 200, fromWeek: 2, projections: projMap });
  assert.ifError(sim.error);
  const titles = sim.teams.map(t => t.title_odds);
  assert.equal(titles.length, 2);
  // Each side scores in exactly one of the round's two weeks, so the round is symmetric.
  // Scored on week 16 alone the HOM side is on bye and takes 0% of the titles; that is
  // the mutation this test exists to fail.
  for (const share of titles) {
    assert.ok(share > 0.15,
      `both sides must be able to win a round they each score one week of (got ${titles.join(', ')})`);
  }
});

test('a one-week round over the same week really is lopsided, so the symmetry above is the round length', () => {
  // The control. With the round as NFL week 16 alone, the HOM side is on bye and cannot
  // win. If this ever passes with both sides alive, the fixture has stopped biting and
  // the test above proves nothing.
  const sim = simulateSeason(league(813, { 14: [16] }), { runs: 200, fromWeek: 2, projections: projMap });
  assert.ifError(sim.error);
  assert.deepEqual(sim.playoff_rounds, [[16]]);
  const titles = sim.teams.map(t => t.title_odds).sort((a, b) => a - b);
  assert.ok(titles[0] < 0.05, `the side on bye cannot win a single-week round (got ${titles.join(', ')})`);
});
