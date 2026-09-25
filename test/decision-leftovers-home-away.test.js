/**
 * The retired home/away factor stays retired in the two simulators.
 *
 * Decision-leftovers item, journey J4 (docs/tdd/decision-leftovers.tdd.md):
 * matchups.js retired the 1.02 home / 0.98 away multiplier after the 2026-09-17 weekly
 * walk-forward test (no arm beat no adjustment; matchups.js MATCHUP_EVIDENCE) and
 * exposes the one multiplier a projection may use, gameMultiplier(), which is exactly 1
 * in that tested state. ceiling-lineup.js and season-sim.js hard-coded
 * `dvpFor(...).mult * (home ? 1.02 : 0.98)` themselves, so both still tilted every
 * sampled week by +/-2%. Here the sampler is replaced by a spy that records the volume
 * multiplier each player-week is drawn with.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-decision-leftovers-home-away-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '2';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

// A two-team NFL: HOM is at home every week, AWY away. matchupModel() reads this slate.
run(`CREATE TABLE IF NOT EXISTS player_gamelog (player_id INTEGER, season INTEGER, week INTEGER,
     opponent TEXT, fantasy_points REAL, PRIMARY KEY (player_id, season, week))`);
run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (901, 'HOM', 'Home Team', 'AFC', 'East'), (902, 'AWY', 'Away Team', 'NFC', 'West')`);
for (let w = 1; w <= 17; w++) {
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 901, ?, 'AWY', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 902, ?, 'HOM', 0)`, w);
}

const realTradeEngine = await import('../server/services/trade-engine.js');
const realProjections = await import('../server/services/projections.js');
const realGamescript = await import('../server/services/gamescript.js');
const realCorrelation = await import('../server/services/correlation.js');
const realContingency = await import('../server/services/contingency.js');
const realMatchups = await import('../server/services/matchups.js');

let assets = new Map();
const projMap = new Map();
const calls = [];
// Extra points per draw for chosen players (J1d makes the IR players the best on paper).
const boost = new Map();
let gmOverride = null;
const GS = { pass_mult: 1.1, rush_mult: 0.9, line: null };

mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
});
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: () => projMap,
    sampleWeeks: (params, n, _scoring, mult) => {
      calls.push({ pid: params.pid, team: params.team, mult });
      return Array.from({ length: n }, (_, i) => (i % 25) + (params.pid % 7) + (boost.get(params.pid) ?? 0));
    }
  }
});
mock.module('../server/services/gamescript.js', {
  namedExports: { ...realGamescript, gameScriptFor: () => GS }
});
mock.module('../server/services/correlation.js', {
  namedExports: {
    ...realCorrelation,
    correlatedSampler: (_players, samples) => () => samples.map(s => s[Math.floor(s.length / 2)])
  }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});
mock.module('../server/services/matchups.js', {
  namedExports: {
    ...realMatchups,
    gameMultiplier: (...a) => (gmOverride ? gmOverride(...a) : realMatchups.gameMultiplier(...a))
  }
});

// `?after-mocks` is load order, not decoration. Since 2026-09-18 trade-engine.js
// imports season-sim.js (tradeIdeas reads this roster's real playoff odds), so
// importing trade-engine above ALSO loaded season-sim — holding a live binding to
// the real assetUniverse, before mock.module() above could replace it. ES module
// mocks only reach modules imported after them, so the copy this test drives has
// to be requested under a URL that has not been loaded yet; its own
// `./trade-engine.js` then resolves to the mock. Without this the spy records
// nothing and both J4 season-sim tests fail on an empty universe.
const simMod = await import('../server/services/season-sim.js?after-mocks');
const { simulateSeason } = simMod;
// WEEKLY-RANGE-ONE: the ceiling lineup scores on the league's one world
// (league-world.js), so it must reach THIS season-sim copy, not the real one the
// trade-engine import loaded: the same re-pointing, one level up (test/ea-07-one-world.test.js).
mock.module('../server/services/season-sim.js', { namedExports: { ...simMod } });
const leagueWorldMod = await import('../server/services/league-world.js?after-mocks');
mock.module('../server/services/league-world.js', { namedExports: { ...leagueWorldMod } });
const { ceilingLineup } = await import('../server/services/ceiling-lineup.js');
// The world is held per league snapshot; each spy test needs its draws made again.
const freshCeiling = (...a) => { leagueWorldMod.clearLeagueWorlds(); return ceilingLineup(...a); };

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
function player(position, team) {
  const id = nextId++;
  const a = { id, name: `${team} ${position} ${id}`, position, team_abbr: team, espn_id: 7000 + id,
    available: true, current_week_ppg: 10, adj_ppg: 10, ppg: 10, ros_ppg: 10 };
  projMap.set(id, { params: { pid: id, team, position }, volume: { target_share: 0.1 } });
  return a;
}
const ROSTER = ['QB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'TE'];
const mine = ROSTER.map((pos, i) => player(pos, i % 2 ? 'AWY' : 'HOM'));
const theirs = ROSTER.map((pos, i) => player(pos, i % 2 ? 'HOM' : 'AWY'));
assets = new Map([...mine, ...theirs].map(a => [a.id, a]));
const entry = a => ({ lineupSlotId: 20,
  playerPoolEntry: { player: { id: a.espn_id, fullName: a.name, defaultPositionId: POS_ID[a.position] } } });
const payload = {
  teams: [{ id: 1, name: 'Mine', roster: { entries: mine.map(entry) } },
    { id: 2, name: 'Theirs', roster: { entries: theirs.map(entry) } }],
  schedule: [2, 3].map(w => ({ matchupPeriodId: w, home: { teamId: 1 }, away: { teamId: 2 } })),
  // CE-05: the simulator refuses a league whose rules are incomplete.
  settings: { scheduleSettings: { matchupPeriodCount: 3, matchupPeriodLength: 1, playoffTeamCount: 2,
    playoffMatchupPeriodLength: 1, playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED',
    divisions: [{ id: 0, size: 2 }] } }
};
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
     VALUES (801, 'espn', 'home-away', 2026, 'Home away', '1', 10, 1, ?, ?)`,
JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']), JSON.stringify(payload));
const lg = db.prepare('SELECT * FROM leagues WHERE id = 801').get();

const close = (a, b) => Math.abs(a - b) < 1e-9;

/** Every recorded player-week multiplier, split by whether his team was at home. */
function byVenue() {
  const home = calls.filter(c => c.team === 'HOM'), away = calls.filter(c => c.team === 'AWY');
  assert.ok(home.length && away.length, `the spy saw ${home.length} home and ${away.length} away draws`);
  return { home, away };
}

test('J4 ceiling-lineup: home and away weeks are drawn with the same multiplier (no signal)', () => {
  calls.length = 0; gmOverride = null;
  const out = freshCeiling(801, { week: 2 });
  assert.ifError(out.error);
  const { home, away } = byVenue();
  for (const c of [...home, ...away]) {
    assert.ok(close(c.mult.pass, 1.1) && close(c.mult.rush, 0.9),
      `${c.team} player drawn at pass ${c.mult.pass} / rush ${c.mult.rush}; expected the game script alone (1.1 / 0.9)`);
  }
});

test('J4 ceiling-lineup: the matchup factor is matchups.js#gameMultiplier, not a local literal', () => {
  calls.length = 0; gmOverride = (_opp, home) => (home ? 1.5 : 0.5);
  try { freshCeiling(801, { week: 2 }); } finally { gmOverride = null; }
  const { home, away } = byVenue();
  assert.ok(home.every(c => close(c.mult.pass, 1.5 * 1.1)), 'home draws follow gameMultiplier');
  assert.ok(away.every(c => close(c.mult.rush, 0.5 * 0.9)), 'away draws follow gameMultiplier');
});

test('J4 season-sim: home and away weeks are drawn with the same multiplier (no signal)', () => {
  calls.length = 0; gmOverride = null;
  const sim = simulateSeason(lg, { runs: 2, fromWeek: 2, projections: projMap });
  assert.ifError(sim.error);
  const { home, away } = byVenue();
  for (const c of [...home, ...away]) {
    assert.ok(close(c.mult.pass, 1.1) && close(c.mult.rush, 0.9),
      `${c.team} player drawn at pass ${c.mult.pass} / rush ${c.mult.rush}; expected the game script alone (1.1 / 0.9)`);
  }
});

test('J4 season-sim: the matchup factor is matchups.js#gameMultiplier, not a local literal', () => {
  calls.length = 0; gmOverride = (_opp, home) => (home ? 1.5 : 0.5);
  try { simulateSeason(lg, { runs: 2, fromWeek: 2, projections: projMap }); } finally { gmOverride = null; }
  const { home, away } = byVenue();
  assert.ok(home.every(c => close(c.mult.pass, 1.5 * 1.1)), 'home draws follow gameMultiplier');
  assert.ok(away.every(c => close(c.mult.rush, 0.5 * 0.9)), 'away draws follow gameMultiplier');
});

test('J1d ceiling-lineup never starts a player on IR (ESPN IR slot or injured reserve)', () => {
  // The same rule as Start/Sit (J1). Found on the live check: after the home/away
  // tilt came out, league 4's ceiling lineup put Zach Charbonnet (ESPN IR slot, OUT)
  // in the FLEX, because ceiling-lineup solved on every rostered player.
  const irSlot = player('WR', 'HOM');
  const reserve = player('RB', 'AWY');
  boost.set(irSlot.id, 40); boost.set(reserve.id, 40);   // the best two on paper by far
  for (const a of [irSlot, reserve]) assets.set(a.id, a);
  const entries = [
    ...mine.map(entry),
    { ...entry(irSlot), lineupSlotId: 21 },
    { lineupSlotId: 20, playerPoolEntry: { player: { ...entry(reserve).playerPoolEntry.player,
      injuryStatus: 'INJURY_RESERVE' } } }
  ];
  const withIr = { ...payload, teams: [{ ...payload.teams[0], roster: { entries } }, payload.teams[1]] };
  run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions, payload)
       VALUES (802, 'espn', 'home-away-ir', 2026, 'Home away IR', '1', 10, 1, ?, ?)`,
  JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']), JSON.stringify(withIr));
  for (const objective of ['ceiling', 'mean']) {
    const out = freshCeiling(802, { week: 2, objective });
    assert.ifError(out.error);
    const names = [...out.lineup.map(x => x.player), ...out.versus_highest_mean.lineup.map(x => x.player)];
    assert.ok(!names.includes(irSlot.name) && !names.includes(reserve.name),
      `${objective}: IR player in the lineup: ${names.join(', ')}`);
    assert.deepEqual((out.on_ir ?? []).map(p => p.name).sort(), [irSlot.name, reserve.name].sort(),
      'IR players are named with the reason');
  }
});
