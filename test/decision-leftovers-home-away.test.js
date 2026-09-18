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
      return Array.from({ length: n }, (_, i) => (i % 25) + (params.pid % 7));
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

const { ceilingLineup } = await import('../server/services/ceiling-lineup.js');
const { simulateSeason } = await import('../server/services/season-sim.js');

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
  settings: { scheduleSettings: { matchupPeriodCount: 3, playoffTeamCount: 2 } }
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
  const out = ceilingLineup(801, { week: 2, trials: 50 });
  assert.ifError(out.error);
  const { home, away } = byVenue();
  for (const c of [...home, ...away]) {
    assert.ok(close(c.mult.pass, 1.1) && close(c.mult.rush, 0.9),
      `${c.team} player drawn at pass ${c.mult.pass} / rush ${c.mult.rush}; expected the game script alone (1.1 / 0.9)`);
  }
});

test('J4 ceiling-lineup: the matchup factor is matchups.js#gameMultiplier, not a local literal', () => {
  calls.length = 0; gmOverride = (_opp, home) => (home ? 1.5 : 0.5);
  try { ceilingLineup(801, { week: 2, trials: 50 }); } finally { gmOverride = null; }
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
