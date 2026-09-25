/**
 * BITEMPORAL (#399 review note 2): a BEHAVIOURAL test of the standings check inside
 * the real season sim, replacing the source-text regex. Fixture: GAME-SHOCKS' copy of
 * RL-6-3's (four teams, week 1 played, real copula and sim). simulateSeason must:
 *  - flag unset: carry no standings_check field;
 *  - GRIDIRON_STANDINGS_RECONCILE=1: report status 'match' when ESPN's official
 *    record equals the carried-in one, and 'mismatch' naming the roster id when not;
 *  - move no number either way (shadow only): odds identical under one seed.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-bitemporal-sim-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

// Three NFL games every week 1-6: AAA-BBB, CCC-DDD, EEE-FFF.
const NFL = [['AAA', 'BBB'], ['CCC', 'DDD'], ['EEE', 'FFF']];
let nflId = 930;
for (const [h, a] of NFL) {
  const hid = nflId++, aid = nflId++;
  run(`INSERT INTO nfl_teams (id, abbr, name, conference, division) VALUES (?, ?, ?, 'AFC', 'East'), (?, ?, ?, 'NFC', 'West')`,
    hid, h, `${h} team`, aid, a, `${a} team`);
  for (let w = 1; w <= 6; w++) {
    run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, ?, ?, ?, 1)`, hid, w, a);
    run(`INSERT INTO schedule_games (season, team_id, week, opponent_abbr, home) VALUES (2026, ?, ?, ?, 0)`, aid, w, h);
  }
}

const { random } = await import('../server/services/stats-util.js');
const realTradeEngine = await import('../server/services/trade-engine.js');
const realProjections = await import('../server/services/projections.js');
const realGamescript = await import('../server/services/gamescript.js');
const realContingency = await import('../server/services/contingency.js');

const NFL_TEAMS = NFL.flat();
let lastScoring = null;                 // the scoring tradeImpact built projections with
const LAYOUT = ['QB', 'RB', 'RB', 'WR', 'WR'];
const assets = new Map();
const projMap = new Map();
const teamPlayers = new Map();          // fantasy team -> asset ids, in payload order
function addPlayer(id, position, nflTeam, mu) {
  assets.set(id, { id, name: `P${id}`, position, team_abbr: nflTeam, espn_id: 9000 + id,
    available: true, current_week_ppg: mu, adj_ppg: mu, ppg: mu, ros_ppg: mu });
  projMap.set(id, { params: { pid: id, mu }, volume: { target_share: position === 'WR' ? 0.2 : null } });
}
let pid = 100;
for (let t = 1; t <= 4; t++) {
  const ids = [];
  LAYOUT.forEach((pos, i) => {
    const id = pid++;
    // Spread each team over the three games so same-game copula blocks mix teams.
    addPlayer(id, pos, NFL_TEAMS[(t + i * 2) % 6], pos === 'QB' ? 18 : (i % 2 ? 12 : 9) + t * 0.3);
    ids.push(id);
  });
  teamPlayers.set(t, ids);
}
// Free agents who never start (project ~0), in the busiest game: the claim case
// CE-09's odds ladder needs to be paired. FA has the highest id; FA_LOW sorts
// BEFORE every rostered player, so without a shared player universe he would
// shift the copula rows of everyone in his game (skeptic's case, 2026-09-23).
const FA = 999, FA_LOW = 50;
addPlayer(FA, 'RB', NFL_TEAMS[(1 + 1 * 2) % 6], 0.01);
addPlayer(FA_LOW, 'RB', NFL_TEAMS[(1 + 1 * 2) % 6], 0.01);

mock.module('../server/services/trade-engine.js', {
  namedExports: {
    ...realTradeEngine,
    assetUniverse: () => assets,
    // The Title-impact tab's shortlist: one fixed deal, team 1's RB for team 2's WR.
    findTrades: () => ({ deals: [{ partner: 'T2', partner_id: '2', fairness: 'fair', me: { ppg_delta: 1 },
      i_give: [{ id: teamPlayers.get(1)[1], name: 'G', position: 'RB', value: 1 }],
      i_get: [{ id: teamPlayers.get(2)[2], name: 'R', position: 'WR', value: 1 }] }] })
  }
});
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: (opts = {}) => { lastScoring = opts.scoring ?? null; return projMap; },
    // Outcomes come off the real global stream, so WHO consumes which draw matters.
    sampleWeeks: (params, n) => Array.from({ length: n }, () => Math.max(0, params.mu * (0.2 + 1.6 * random())))
  }
});
mock.module('../server/services/gamescript.js', {
  namedExports: { ...realGamescript, gameScriptFor: () => ({ pass_mult: 1, rush_mult: 1, line: null }) }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});
const simModule = await import('../server/services/season-sim.js?bitemporal');
const { simulateSeason } = simModule;
// trade-engine.js imports season-sim.js, so the plain season-sim instance was
// loaded (unmocked) by the `realTradeEngine` import above. Point the Title-impact
// tab at the mocked instance, or its deals are simulated on empty projections
// (every team scores 0, team 1 wins every run, every delta and SE is 0).
mock.module('../server/services/season-sim.js', { namedExports: { ...simModule } });
const { withRandomSeed } = await import('../server/services/stats-util.js');
const { STANDINGS_RECONCILE_ENV } = await import('../server/services/standings-reconcile.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** Week 1 played; weeks 2-3 regular season; a 2-team final in week 4. */
const OFFICIAL = { 1: [1, 0, 100], 2: [0, 1, 90], 3: [0, 1, 95], 4: [1, 0, 99] };
function payload(official = OFFICIAL) {
  const g = (w, h, a, hp, ap) => ({ matchupPeriodId: w, winner: hp == null ? 'UNDECIDED' : hp > ap ? 'HOME' : 'AWAY',
    home: { teamId: h, totalPoints: hp ?? undefined }, away: { teamId: a, totalPoints: ap ?? undefined } });
  return {
    teams: [1, 2, 3, 4].map(t => ({ id: t, divisionId: 0,
      record: { overall: { wins: official[t][0], losses: official[t][1], ties: 0, pointsFor: official[t][2] } },
      roster: { entries: teamPlayers.get(t).map(id => ({ lineupSlotId: 20,
        playerPoolEntry: { player: { id: 9000 + id, fullName: `P${id}`,
          defaultPositionId: { QB: 1, RB: 2, WR: 3 }[assets.get(id).position] } } })) } })),
    schedule: [g(1, 1, 2, 100, 90), g(1, 3, 4, 95, 99), g(2, 1, 3), g(2, 2, 4), g(3, 1, 4), g(3, 2, 3)],
    settings: { scheduleSettings: { matchupPeriodCount: 3, matchupPeriodLength: 1, playoffTeamCount: 2,
      playoffMatchupPeriodLength: 1, playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED',
      divisions: [{ id: 0, size: 4 }] } }
  };
}
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions,
     payload, current_week, payload_season, fetched_at) VALUES (631, 'espn', 'rl63', 2026, 'CRN', '1', 4, 1, ?, ?, 2, 2026, '2026-09-23T08:00:00Z')`,
JSON.stringify(['QB', 'RB', 'WR', 'FLEX']), JSON.stringify(payload()));
const league = () => db.prepare('SELECT * FROM leagues WHERE id = 631').get();

const RUNS = 200;
const shape = s => s.teams.map(t => [t.roster_id, t.title_odds, t.playoff_odds, t.expected_wins, t.expected_points])
  .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
function withFlag(v, fn) {
  const saved = process.env[STANDINGS_RECONCILE_ENV];
  if (v == null) delete process.env[STANDINGS_RECONCILE_ENV]; else process.env[STANDINGS_RECONCILE_ENV] = v;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[STANDINGS_RECONCILE_ENV]; else process.env[STANDINGS_RECONCILE_ENV] = saved;
  }
}
const simAt = () => withRandomSeed(11, () => simulateSeason(league(), { runs: RUNS }));

test('flag unset: simulateSeason carries no standings_check', () => {
  const off = withFlag(null, simAt);
  assert.ifError(off.error);
  assert.equal(off.from_week, 2);
  assert.equal('standings_check' in off, false);
});

test('flag on: simulateSeason reports match against ESPN\'s official record, and moves no number', () => {
  const off = withFlag(null, simAt);
  const on = withFlag('1', simAt);
  assert.ifError(on.error);
  assert.equal(on.standings_check.status, 'match');
  assert.equal(on.standings_check.shadow, true);
  assert.equal(on.standings_check.teams_checked, 4);
  assert.deepEqual(shape(on), shape(off), 'shadow only: every served number identical');
});

test('flag on: an official record that disagrees is named by roster id', () => {
  run('UPDATE leagues SET payload = ? WHERE id = 631',
    JSON.stringify(payload({ ...OFFICIAL, 1: [0, 1, 100] })));
  try {
    const on = withFlag('1', simAt);
    assert.equal(on.standings_check.status, 'mismatch');
    assert.deepEqual(on.standings_check.mismatches.map(m => m.roster_id), ['1']);
  } finally {
    run('UPDATE leagues SET payload = ? WHERE id = 631', JSON.stringify(payload()));
  }
});
