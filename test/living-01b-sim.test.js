/**
 * LIVING-01b: league-mates act inside season-sim (GRIDIRON_LIVING01B_ENABLED).
 *
 * Contract:
 *   1. flag off: simulateSeason and tradeImpact are byte-identical to the code before
 *      LIVING-01b (a SHA-256 of their seeded output, taken on the base commit);
 *   2. same seed, same living season; the frozen odds it reports are the frozen sim's
 *      own on the same draws (common random numbers);
 *   3. a checked-out manager leaves stale lineups (a dead starter in ~93% of weeks,
 *      LIVING-01a's fitted rate) and makes no claims; an engaged one claims the free
 *      agent and rarely leaves a dead slot;
 *   4. RL-19-2's structure holds: the fast rescore on a shared world equals the two
 *      full runs under the flag.
 *
 * Fixture: RL-19-2's league (four teams over three NFL games, real copula, outcome
 * pools off the real global stream) plus one free agent worth starting.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-living01b-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';
delete process.env.GRIDIRON_LIVING01B_ENABLED;
delete process.env.GRIDIRON_RL17_3_ENABLED;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_FAST_RESCORE;

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const NFL = [['AAA', 'BBB'], ['CCC', 'DDD'], ['EEE', 'FFF']];
let nflId = 960;
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
const LAYOUT = ['QB', 'RB', 'RB', 'WR', 'WR'];
const assets = new Map();
const projMap = new Map();
const teamPlayers = new Map();
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
    addPlayer(id, pos, NFL_TEAMS[(t + i * 2) % 6], pos === 'QB' ? 18 : (i % 2 ? 12 : 9) + t * 0.3);
    ids.push(id);
  });
  teamPlayers.set(t, ids);
}
// Two free agents who never start and one worth claiming (15 ppg RB).
const FA = 999, FA_LOW = 50, FA_GOOD = 998;
addPlayer(FA, 'RB', NFL_TEAMS[3], 0.01);
addPlayer(FA_LOW, 'RB', NFL_TEAMS[3], 0.01);
addPlayer(FA_GOOD, 'RB', NFL_TEAMS[4], 15);

mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
});
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: () => projMap,
    sampleWeeks: (params, n) => Array.from({ length: n }, () => Math.max(0, params.mu * (0.2 + 1.6 * random())))
  }
});
mock.module('../server/services/gamescript.js', {
  namedExports: { ...realGamescript, gameScriptFor: () => ({ pass_mult: 1, rush_mult: 1, line: null }) }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});
const { simulateSeason, tradeImpact, tradeImpactWorld } = await import('../server/services/season-sim.js?living01b');
const { withRandomSeed } = await import('../server/services/stats-util.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function payload() {
  const g = (w, h, a, hp, ap) => ({ matchupPeriodId: w, winner: hp == null ? 'UNDECIDED' : hp > ap ? 'HOME' : 'AWAY',
    home: { teamId: h, totalPoints: hp ?? undefined }, away: { teamId: a, totalPoints: ap ?? undefined } });
  return {
    teams: [1, 2, 3, 4].map(t => ({ id: t, divisionId: 0,
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
     payload, current_week, payload_season, fetched_at) VALUES (1961, 'espn', 'lv01b', 2026, 'LIV', '1', 4, 1, ?, ?, 2, 2026, '2026-09-24T08:00:00Z')`,
JSON.stringify(['QB', 'RB', 'WR', 'FLEX']), JSON.stringify(payload()));
const league = () => db.prepare('SELECT * FROM leagues WHERE id = 1961').get();

const RUNS = 400;
const P = (t, i) => teamPlayers.get(t)[i];
const DEAL = { myTeamId: 1, theirTeamId: 2, iGive: [P(1, 1)], iGet: [P(2, 2)] };
const withEnv = (vars, fn) => {
  const prior = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v == null) delete process.env[k]; else process.env[k] = v;
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prior)) if (v == null) delete process.env[k]; else process.env[k] = v;
  }
};
const ON = { GRIDIRON_LIVING01B_ENABLED: '1' };
const sim = (seed, opts = {}) => withRandomSeed(seed, () => simulateSeason(league(), { runs: RUNS, ...opts }));
const state = (engaged, drifting, checkedOut, adds = 1.25, trades = 0.0446) => ({
  probs: { engaged, drifting, checked_out: checkedOut },
  rates: { adds_per_week: { value: adds }, trades_per_week: { value: trades } }
});
const all = v => new Map(['1', '2', '3', '4'].map(id => [id, v]));
const sha = x => crypto.createHash('sha256').update(JSON.stringify(x, (k, v) =>
  v instanceof Map ? [...v].map(([a, b]) => [a, { title: [...b.title], playoffs: [...b.playoffs] }]) : v)).digest('hex');

// Taken on the base (PR #241 head d748c02) before any LIVING-01b code: the seeded
// outputs of simulateSeason (2 seeds) and tradeImpact (both paths) on this fixture.
const GOLDEN_OFF = '8c80fa4b88d042a7a4bff5bebd6ba9c19af5284e3db6d6fcfa14d1098a60bd45';

function offOutputs() {
  return [
    sim(3), sim(17, { universe: [FA_GOOD] }),
    tradeImpact(league(), { ...DEAL, runs: RUNS, seed: 17 }),
    withEnv({ GRIDIRON_FAST_RESCORE: '0' }, () => tradeImpact(league(), { ...DEAL, runs: RUNS, seed: 17 }))
  ];
}

test('LIVING-01b: flag off, the sim and trade scoring are byte-identical to before', () => {
  for (const flag of [undefined, '0', 'true']) {
    const out = withEnv({ GRIDIRON_LIVING01B_ENABLED: flag }, offOutputs);
    assert.equal(out[0].living, undefined, `flag ${flag}: no living block`);
    assert.equal(sha(out), GOLDEN_OFF, `flag ${flag}: output hash`);
  }
});

test('LIVING-01b: the same seed gives the same living season, and another seed does not', () => {
  const living = all(state(0.6, 0.3, 0.1));
  const a = withEnv(ON, () => sim(11, { living })), b = withEnv(ON, () => sim(11, { living }));
  assert.ifError(a.error);
  assert.ok(a.living, 'flag on: the result carries the living block');
  assert.deepEqual(a, b);
  const c = withEnv(ON, () => sim(12, { living }));
  assert.notDeepEqual(c.teams, a.teams, 'control: another seed is another season');
  assert.equal(a.living.teams_from_activity, 4);
  const pop = withEnv(ON, () => sim(11));
  assert.equal(pop.living.teams_population, 4, 'no activity input: every team is counted as population');
});

test('LIVING-01b: the frozen odds it reports are the frozen sim on the same draws', () => {
  const on = withEnv(ON, () => sim(23, { living: all(state(1, 0, 0)) }));
  // The waiver pool is simulated in both: the flag-off sim with the pool as its universe.
  const off = sim(23, { universe: [FA, FA_LOW, FA_GOOD] });
  const frozen = off.teams.map(t => ({ roster_id: t.roster_id, playoff_odds: t.playoff_odds, title_odds: t.title_odds,
    expected_points: t.expected_points }));
  assert.deepEqual(on.living.frozen, frozen);
  assert.equal(on.living.fa_pool, 3);
});

test('LIVING-01b: a checked-out manager leaves stale lineups and makes no claims', () => {
  const teamWeeks = 4 * 3;   // four teams over weeks 2, 3 and the week-4 final
  const out = withEnv(ON, () => sim(31, { living: all(state(0, 0, 1)) }));
  const share = out.living.lineup_errors_per_run / teamWeeks;
  // LIVING-01a: sigmoid(2.6171) = 0.932 in the checked-out state.
  assert.ok(Math.abs(share - 0.932) < 0.03, `dead-starter share ${share}`);
  assert.ok(out.living.adds_per_run < 0.05, `adds per run ${out.living.adds_per_run}`);
  assert.ok(out.living.checked_out_share > 0.97);
  for (const t of out.teams) {
    const f = out.living.frozen.find(x => x.roster_id === t.roster_id);
    assert.ok(t.expected_points < 0.9 * f.expected_points, `team ${t.roster_id}: stale lineups cost points`);
  }
  // Control: engaged managers rarely leave a dead slot (sigmoid(-2.8666) = 0.054) and do claim.
  const eng = withEnv(ON, () => sim(31, { living: all(state(1, 0, 0)) }));
  assert.ok(eng.living.lineup_errors_per_run / teamWeeks < 0.12, `engaged share ${eng.living.lineup_errors_per_run / teamWeeks}`);
  assert.ok(eng.living.adds_per_run > 0.5, `engaged adds ${eng.living.adds_per_run}`);
});

test('LIVING-01b: one checked-out team loses ground to engaged league-mates', () => {
  const living = all(state(1, 0, 0));
  living.set('3', state(0, 0, 1, 0.1, 0));
  const out = withEnv(ON, () => sim(41, { living }));
  const me = out.teams.find(t => t.roster_id === '3'), frozen = out.living.frozen.find(t => t.roster_id === '3');
  assert.ok(me.playoff_odds < frozen.playoff_odds, `team 3 playoff odds ${me.playoff_odds} vs frozen ${frozen.playoff_odds}`);
});

test('LIVING-01b: the fast rescore on a shared world equals the two full runs under the flag', () => {
  const living = all(state(0.6, 0.3, 0.1));
  withEnv(ON, () => {
    const world = tradeImpactWorld(league(), { runs: RUNS, seed: 17, living });
    assert.ifError(world.fail?.error);
    for (const seed of [17, 5]) {
      const args = { ...DEAL, runs: RUNS, seed, living };
      const old = withEnv({ GRIDIRON_FAST_RESCORE: '0' }, () => tradeImpact(league(), args));
      assert.ifError(old.error);
      assert.equal(old.living_sim, 'living01b-1');
      assert.deepEqual(tradeImpact(league(), { ...args, world }), old, `seed ${seed}`);
    }
    // Other activity inputs do not reuse the world.
    const other = all(state(0, 0, 1));
    assert.deepEqual(tradeImpact(league(), { ...DEAL, runs: RUNS, seed: 17, living: other, world }),
      withEnv({ GRIDIRON_FAST_RESCORE: '0' }, () => tradeImpact(league(), { ...DEAL, runs: RUNS, seed: 17, living: other })));
  });
});
