/**
 * The simulate response names which shrinkage constants produced its odds.
 *
 * `projection_basis` says which seasons and weeks fed the projections. It does not say
 * whether those projections used the fitted shrinkage constants or the hand-set ones, and
 * after the fit lands those diverge -- which is the reason a basis label exists at all.
 *
 * This test exists because the field is the kind that can be added, be correct, and then be
 * quietly dropped by a later edit to the response literal with nothing failing. A surface
 * cannot render a field that is absent, and an absent field looks exactly like "no fit".
 *
 * A caller that supplies its own `projections` gets `projection_fit: null` rather than a
 * description of a call this function did not make. That is the case exercised here, and the
 * distinction is the point: null means "we are not telling you", and the response still has
 * to carry the key so a reader knows the question was asked.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-sim-projfit-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.NFL_WEEK = '2';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES
     (901, 'HOM', 'Home Team', 'AFC', 'East'), (902, 'AWY', 'Away Team', 'NFC', 'West')`);
for (let w = 1; w <= 17; w++) {
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 901, ?, 'AWY', 1)`, w);
  run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, 902, ?, 'HOM', 0)`, w);
}

const realTradeEngine = await import('../server/services/trade-engine.js');
const realContingency = await import('../server/services/contingency.js');

let assets = new Map();
const projMap = new Map();
mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});

// `?after-mocks` is load order, not decoration: trade-engine.js imports season-sim.js, so
// importing it above already loaded season-sim holding the real assetUniverse. The copy this
// test drives has to be requested under a URL that has not been loaded yet.
const { simulateSeason } = await import('../server/services/season-sim.js?after-mocks');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4 };
let nextId = 1;
function player(position, team) {
  const id = nextId++;
  projMap.set(id, { params: { pid: id, team, position }, volume: { target_share: 0.1 } });
  return { id, name: `${team} ${position} ${id}`, position, team_abbr: team, espn_id: 7000 + id,
    available: true, current_week_ppg: 10, adj_ppg: 10, ppg: 10, ros_ppg: 10 };
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
     VALUES (802, 'espn', 'proj-fit', 2026, 'Projection fit', '1', 10, 1, ?, ?)`,
JSON.stringify(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX']), JSON.stringify(payload));
const lg = db.prepare('SELECT * FROM leagues WHERE id = 802').get();

test('the response carries every basis field a surface is entitled to render', () => {
  const sim = simulateSeason(lg, { runs: 2, fromWeek: 2, projections: projMap });
  assert.ifError(sim.error);
  // `in`, not a truthiness check: null is a meaningful value for two of these and an absent
  // key is the failure this test is for.
  for (const field of ['playoff_rounds', 'playoff_basis', 'projection_basis', 'projection_fit', 'odds_interval']) {
    assert.ok(field in sim, `the response must carry ${field}`);
  }
});

test('a caller supplying its own projections is told nothing about the fit, rather than a guess', () => {
  const sim = simulateSeason(lg, { runs: 2, fromWeek: 2, projections: projMap });
  assert.equal(sim.projection_fit, null,
    'these projections were not built by this call, so no fit describes them');
});
