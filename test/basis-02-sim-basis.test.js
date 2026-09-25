/**
 * BASIS-02: the title sim prices every rostered player on the finder's rate
 * (server/services/sim-basis.js; ONE-PLAN s5 night 2; docs/tdd/2026-09-25-basis-02.tdd.md).
 *
 * Fixture: RL-17-3's (four teams over three NFL games, real copula, a sampler whose
 * mean is mu x the volume multiplier) plus two rostered players with no last-season
 * projection (rookies), and the SIM-CALIB as-of flag on with an as-of rate that is
 * deliberately scrambled against the finder's ros_ppg: the two gaps BASIS-02 closes.
 *
 * M1: Spearman of the sim's per-game rate vs ros_ppg over every rostered player
 *     (unsimulated = 0): flag on >= 0.95 with everyone simulated; control off < 0.9.
 * M2: the audit's row A reads the served world: ok on, broken off.
 * M3: flag unset and '0' identical; a replay of an earlier week is untouched; fast
 *     rescore equals the two full runs under the flag; worldPoolFor draws the world's pool.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-basis02-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';

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

const { random, withRandomSeed } = await import('../server/services/stats-util.js');
const realTradeEngine = await import('../server/services/trade-engine.js');
const realProjections = await import('../server/services/projections.js');
const realGamescript = await import('../server/services/gamescript.js');
const realContingency = await import('../server/services/contingency.js');
const realAsof = await import('../server/services/projection-asof.js');

const NFL_TEAMS = NFL.flat();
const LAYOUT = ['QB', 'RB', 'RB', 'WR', 'WR'];
const assets = new Map();
const projMap = new Map();
const asofRates = new Map();
const teamPlayers = new Map();
// ros: the finder's rate. last: last season's ppg (null = never projected). asof: the as-of model's rate.
function addPlayer(id, position, nflTeam, ros, last, asof) {
  assets.set(id, { id, name: `P${id}`, position, team_abbr: nflTeam, espn_id: 9000 + id,
    available: true, current_week_ppg: ros, adj_ppg: ros, ppg: last, ros_ppg: ros });
  if (last != null) projMap.set(id, { position, ppg: last, params: { pid: id, position, mu: last }, volume: { target_share: null } });
  asofRates.set(id, { ppg: asof, games: 1, source: 'in_season' });
}
let pid = 100, k = 0;
for (let t = 1; t <= 4; t++) {
  const ids = [];
  LAYOUT.forEach((pos, i) => {
    const id = pid++;
    const ros = (pos === 'QB' ? 17 : 8) + ((k * 7) % 11) * 0.9;
    const last = Math.max(1, ros + [5, -4, 1, -5, 3, -2, 4, 0, -3, 2][k % 10]);
    // The second ROS producer disagrees with the served one: a different scramble.
    const asof = Math.max(1, ros + [-5, 4, -3, 5, -1, 3, -4, 2, 4, -2][k % 10]);
    k++;
    addPlayer(id, pos, NFL_TEAMS[(t + i * 2) % 6], ros, last, asof);
    ids.push(id);
  });
  teamPlayers.set(t, ids);
}
// Two rostered rookies: no last-season projection, rated high by the finder.
const ROOKIE_WR = 990, ROOKIE_RB = 991;
addPlayer(ROOKIE_WR, 'WR', NFL_TEAMS[0], 16.5, null, 16.5);
addPlayer(ROOKIE_RB, 'RB', NFL_TEAMS[3], 15.2, null, 15.2);
teamPlayers.get(1).push(ROOKIE_WR);
teamPlayers.get(3).push(ROOKIE_RB);
const ROSTERED = [...teamPlayers.values()].flat();

mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
});
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: () => projMap,
    sampleWeeks: (params, n, _scoring, mult = 1) => {
      const m = typeof mult === 'object' ? mult.pass : mult;
      return Array.from({ length: n }, () => params.mu * m * (0.2 + 1.6 * random()));
    }
  }
});
mock.module('../server/services/gamescript.js', {
  namedExports: { ...realGamescript, gameScriptFor: () => ({ pass_mult: 1, rush_mult: 1, line: null }) }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});
mock.module('../server/services/projection-asof.js', {
  namedExports: { ...realAsof, projectionAsOf: () => asofRates }
});
const { tradeImpact, tradeImpactWorld, simulateSeason, worldPoolFor, simStartWeek } =
  await import('../server/services/season-sim.js?basis02');
const { BASIS_02_ENV, basis02Flag, simPlayerRates, templateDonor, applyBasis02 } =
  await import('../server/services/sim-basis.js');
const { projectionBasisSnapshot, evaluateSnapshot, spearman } = await import('../server/services/number-audit.js');

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
     payload, current_week, payload_season, fetched_at) VALUES (1732, 'espn', 'basis02', 2026, 'B02', '1', 4, 1, ?, ?, 2, 2026, '2026-09-25T03:00:00Z')`,
JSON.stringify(['QB', 'RB', 'WR', 'FLEX']), JSON.stringify(payload()));
const league = () => db.prepare('SELECT * FROM leagues WHERE id = 1732').get();

const RUNS = 200;
const withEnv = (vars, fn) => {
  const prior = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  const set = (key, v) => { if (v == null) delete process.env[key]; else process.env[key] = v; };
  for (const [key, v] of Object.entries(vars)) set(key, v);
  try { return fn(); } finally { for (const [key, v] of Object.entries(prior)) set(key, v); }
};
// The as-of basis is on in both arms (it is on under preview on the Mac today).
const arm = (value, fn) => withEnv({ [BASIS_02_ENV]: value, GRIDIRON_SIM_ASOF_PROJ: '1',
  GRIDIRON_RL17_3_ENABLED: null, GRIDIRON_PREVIEW_UNCONFIRMED: null }, fn);

function simVsFinder(world) {
  const rates = simPlayerRates(world);
  const xs = ROSTERED.map(id => rates.get(id) ?? 0), ys = ROSTERED.map(id => assets.get(id).ros_ppg);
  return { rho: spearman(xs, ys), rates, unsimulated: ROSTERED.filter(id => !rates.has(id)) };
}

test('BASIS-02 M1: every rostered player simulated at the finder\'s rate (Spearman >= 0.95; off < 0.9)', t => {
  const off = arm(null, () => tradeImpactWorld(league(), { runs: RUNS, seed: 7 }));
  const on = arm('1', () => tradeImpactWorld(league(), { runs: RUNS, seed: 7 }));
  assert.ifError(off.fail?.error);
  assert.ifError(on.fail?.error);
  const a = simVsFinder(off), b = simVsFinder(on);
  t.diagnostic(`Spearman sim rate vs finder ros_ppg (n ${ROSTERED.length}): off ${a.rho.toFixed(3)} `
    + `(${a.unsimulated.length} unsimulated), on ${b.rho.toFixed(3)} (${b.unsimulated.length} unsimulated)`);
  assert.deepEqual(a.unsimulated.sort(), [ROOKIE_WR, ROOKIE_RB].sort(), 'control: the rookies are not simulated today');
  assert.ok(a.rho < 0.9, `control reproduces the gap (off rho ${a.rho.toFixed(3)})`);
  assert.deepEqual(b.unsimulated, [], 'flag on: every rostered player is simulated');
  assert.ok(b.rho >= 0.95, `flag on: rho ${b.rho.toFixed(3)} (off ${a.rho.toFixed(3)})`);
  for (const id of ROSTERED) {
    const ros = assets.get(id).ros_ppg;
    assert.ok(Math.abs(b.rates.get(id) - ros) / ros < 0.08, `P${id}: sim ${b.rates.get(id).toFixed(2)} vs ros ${ros.toFixed(2)}`);
  }
  assert.equal(on.prep.basisFields.basis_02, true);
  assert.equal(on.prep.basisFields.ros_template, 2);
  assert.equal(on.prep.basisFields.ros_finder_level, ROSTERED.length - 2);
});

test('BASIS-02 M2: the audit\'s row A reads the served world (ok on, broken off)', () => {
  const lg = league();
  const rostered = ROSTERED.map(id => assets.get(id));
  const rowFor = world => {
    const snap = { projection_basis: projectionBasisSnapshot({ rates: simPlayerRates(world), rostered, lastSeason: projMap }) };
    return { snap, row: evaluateSnapshot(snap).find(r => r.check_id === 'projection_basis') };
  };
  const off = rowFor(arm(null, () => tradeImpactWorld(lg, { runs: RUNS, seed: 7 })));
  const on = rowFor(arm('1', () => tradeImpactWorld(lg, { runs: RUNS, seed: 7 })));
  assert.equal(off.row.status, 'broken');
  assert.match(off.row.detail, /2 of them are not in the title simulator at all/);
  assert.equal(off.snap.projection_basis.unsimulated, 2);
  assert.equal(on.row.status, 'ok', on.row.detail);
  assert.equal(on.snap.projection_basis.n, ROSTERED.length);
  // The old pair is kept beside it and is the same number in both arms: it never saw the sim.
  assert.equal(on.snap.projection_basis.last_season_rank_corr, off.snap.projection_basis.last_season_rank_corr);
});

test('BASIS-02 M3: off by default, not on under preview, vetoed by the ROS kill switch', () => {
  const lg = league();
  const base = arm(null, () => withRandomSeed(5, () => simulateSeason(lg, { runs: RUNS })));
  const zero = arm('0', () => withRandomSeed(5, () => simulateSeason(lg, { runs: RUNS })));
  assert.deepEqual(zero, base, 'unset and 0 are the same season, same seed');
  assert.equal(base.basis_02, undefined);
  const preview = withEnv({ [BASIS_02_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => basis02Flag());
  assert.equal(preview.on, false, 'moves title odds: not on under preview until measured');
  const vetoed = withEnv({ [BASIS_02_ENV]: '1', GRIDIRON_RL17_3_ENABLED: '0' }, () => basis02Flag());
  assert.equal(vetoed.on, false);
  const on = arm('1', () => withRandomSeed(5, () => simulateSeason(lg, { runs: RUNS })));
  assert.equal(on.basis_02, true);
});

test('BASIS-02 M3: a replay of an earlier week keeps the as-of level and borrows no pools', () => {
  assert.ok(simStartWeek(league()) >= 2, 'fixture: the league is at week 2');
  const off = arm(null, () => tradeImpactWorld(league(), { runs: RUNS, seed: 7, fromWeek: 1 }));
  const on = arm('1', () => tradeImpactWorld(league(), { runs: RUNS, seed: 7, fromWeek: 1 }));
  assert.deepEqual(on.base, off.base, 'week-1 replay: same season with the flag on');
  assert.equal(on.prep.basisFields.ros_template, 0);
  assert.equal(on.prep.basisFields.ros_finder_level, 0);
});

const P = (t, i) => teamPlayers.get(t)[i];
const DEALS = [
  { myTeamId: 1, theirTeamId: 3, iGive: [P(1, 5)], iGet: [P(3, 5)] },
  { myTeamId: 1, theirTeamId: 2, iGive: [P(1, 1), P(1, 3)], iGet: [P(2, 4)] }
];

test('BASIS-02 M3: under the flag the fast rescore still equals the two full runs', () => {
  for (const seed of [3, 17]) {
    for (const deal of DEALS) {
      const args = { ...deal, runs: RUNS, seed };
      const full = arm('1', () => withEnv({ GRIDIRON_FAST_RESCORE: '0' }, () => tradeImpact(league(), args)));
      const fast = arm('1', () => withEnv({ GRIDIRON_FAST_RESCORE: null }, () => tradeImpact(league(), args)));
      assert.ifError(full.error);
      assert.deepEqual(fast, full, `seed ${seed}, give ${deal.iGive} get ${deal.iGet}`);
    }
  }
});

test('BASIS-02: worldPoolFor draws a rookie\'s world pool (flag on) and nothing (off)', () => {
  const rookie = assets.get(ROOKIE_WR);
  const world = arm('1', () => tradeImpactWorld(league(), { runs: RUNS, seed: 7 }));
  const week = world.prep.simWeeks.find(w => world.prep.weekData.get(w).pools.has(ROOKIE_WR));
  const inWorld = world.prep.weekData.get(week).pools.get(ROOKIE_WR);
  const drawn = arm('1', () => worldPoolFor(rookie, week, { scoring: undefined, proj: projMap, world: world.prep.world,
    activeChance: new Map() }));
  assert.deepEqual(drawn, inWorld, 'same address, same borrowed shape, same scale');
  const off = arm(null, () => worldPoolFor(rookie, week, { proj: projMap, world: world.prep.world, activeChance: new Map() }));
  assert.equal(off, null);
});

test('BASIS-02: the donor is the closest ppg at the same position; a replay basis is unchanged', () => {
  assert.equal(templateDonor(projMap, 'WR', 16.5).pr.position, 'WR');
  const wrs = [...projMap].filter(([, pr]) => pr.position === 'WR');
  const best = Math.min(...wrs.map(([, pr]) => Math.abs(pr.ppg - 16.5)));
  assert.equal(Math.abs(templateDonor(projMap, 'WR', 16.5).pr.ppg - 16.5), best);
  assert.equal(templateDonor(projMap, 'K', 8), null, 'nobody to borrow from');
  const basis = { scale: new Map([[100, 1.1]]), fields: { projection_basis: 'ros' } };
  const replay = applyBasis02(basis, [...assets.values()], projMap, { atCurrentWeek: false });
  assert.deepEqual([...replay.scale], [[100, 1.1]]);
  assert.equal(replay.template.size, 0);
});
