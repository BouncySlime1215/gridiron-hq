/**
 * RL-17-3 — the Title tab and the trade finder price players on the same rate.
 *
 * season-sim.js built every outcome pool from buildProjections({ through: SEASON - 1 }):
 * LAST season's rate. The finder prices the same players on ros_ppg (ros-projection.js
 * #buildRosProjections, served on trade-engine.js's asset universe). The two orders
 * agreed at Spearman 0.796 on the synced leagues, so the Title tab disagreed with the
 * finder's own picks (BROKEN-NUMBERS row A).
 *
 * Contract: with GRIDIRON_RL17_3_ENABLED on, the sim's per-player means rank the
 * players the way the finder's ros_ppg does, Spearman >= 0.95. Off, nothing changes.
 * The RL-19-2 fast rescore still equals the two full runs under the new basis.
 *
 * Fixture: RL-19-2's (four teams over three NFL games, real copula), with each
 * player's last-season ppg deliberately reordered against his ros_ppg, and a
 * sampler whose mean is ppg x the volume multiplier (the linearity the scaling uses).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rl173-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const NFL = [['AAA', 'BBB'], ['CCC', 'DDD'], ['EEE', 'FFF']];
let nflId = 940;
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

const NFL_TEAMS = NFL.flat();
const LAYOUT = ['QB', 'RB', 'RB', 'WR', 'WR'];
const assets = new Map();
const projMap = new Map();
const teamPlayers = new Map();
// ros: the finder's rest-of-season rate. last: last season's ppg, the old basis.
function addPlayer(id, position, nflTeam, ros, last) {
  assets.set(id, { id, name: `P${id}`, position, team_abbr: nflTeam, espn_id: 9000 + id,
    available: true, current_week_ppg: ros, adj_ppg: ros, ppg: last, ros_ppg: ros });
  if (last != null) projMap.set(id, { ppg: last, params: { pid: id, mu: last }, volume: { target_share: null } });
}
let pid = 100, k = 0;
for (let t = 1; t <= 4; t++) {
  const ids = [];
  LAYOUT.forEach((pos, i) => {
    const id = pid++;
    const ros = (pos === 'QB' ? 17 : 8) + ((k * 7) % 11) * 0.9;
    // Last season disagrees: a fixed, rank-scrambling tilt of up to +-5 points.
    const last = Math.max(1, ros + [5, -4, 1, -5, 3, -2, 4, 0, -3, 2][k % 10]);
    k++;
    addPlayer(id, pos, NFL_TEAMS[(t + i * 2) % 6], ros, last);
    ids.push(id);
  });
  teamPlayers.set(t, ids);
}
// A player the finder rates but the old projections never built: no pool shape to scale.
const NO_PROJ = 998;
addPlayer(NO_PROJ, 'WR', NFL_TEAMS[0], 11, null);

mock.module('../server/services/trade-engine.js', {
  namedExports: { ...realTradeEngine, assetUniverse: () => assets }
});
mock.module('../server/services/projections.js', {
  namedExports: {
    ...realProjections,
    buildProjections: () => projMap,
    // Mean = mu x volume multiplier, as the real sampler's expected points are.
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
const { tradeImpact, tradeImpactWorld, simulateSeason, simPlayerMeans, RL17_3_ENV } =
  await import('../server/services/season-sim.js?rl173');

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
     payload, current_week, payload_season, fetched_at) VALUES (1731, 'espn', 'rl173', 2026, 'ROS', '1', 4, 1, ?, ?, 2, 2026, '2026-09-24T08:00:00Z')`,
JSON.stringify(['QB', 'RB', 'WR', 'FLEX']), JSON.stringify(payload()));
const league = () => db.prepare('SELECT * FROM leagues WHERE id = 1731').get();

const RUNS = 200;
const withEnv = (vars, fn) => {
  const prior = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  const set = (key, v) => { if (v == null) delete process.env[key]; else process.env[key] = v; };
  for (const [key, v] of Object.entries(vars)) set(key, v);
  try { return fn(); } finally { for (const [key, v] of Object.entries(prior)) set(key, v); }
};
const flag = (value, fn) => withEnv({ [RL17_3_ENV]: value, GRIDIRON_PREVIEW_UNCONFIRMED: null }, fn);

const ranks = xs => {
  const order = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let q = i; q <= j; q++) r[order[q][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
};
function spearman(xs, ys) {
  const a = ranks(xs), b = ranks(ys), n = xs.length, ma = (n - 1) / 2;
  let num = 0, da = 0, db2 = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - ma); da += (a[i] - ma) ** 2; db2 += (b[i] - ma) ** 2; }
  return num / Math.sqrt(da * db2);
}
/** Spearman of the sim's per-player means against the finder's ros_ppg, rostered + projected players. */
function simVsFinder(world) {
  const means = simPlayerMeans(world);
  const ids = [...teamPlayers.values()].flat().filter(id => means.has(id));
  return { rho: spearman(ids.map(id => means.get(id)), ids.map(id => assets.get(id).ros_ppg)), n: ids.length, means };
}

test('RL-17-3 RED: the sim\'s per-player means rank players like the finder\'s ros_ppg (Spearman >= 0.95)', t => {
  const off = flag('0', () => tradeImpactWorld(league(), { runs: RUNS, seed: 7 }));
  const on = flag('1', () => tradeImpactWorld(league(), { runs: RUNS, seed: 7 }));
  assert.ifError(off.fail?.error);
  assert.ifError(on.fail?.error);
  const a = simVsFinder(off), b = simVsFinder(on);
  assert.equal(b.n, 20, 'every rostered player is simulated');
  t.diagnostic(`Spearman sim means vs finder ros_ppg: old basis ${a.rho.toFixed(3)}, ROS basis ${b.rho.toFixed(3)} (n ${b.n})`);
  // Control: the fixture reproduces the row-A gap under the old basis.
  assert.ok(a.rho < 0.95, `old basis should disagree with the finder (rho ${a.rho.toFixed(3)})`);
  assert.ok(b.rho >= 0.95, `sim means vs finder ros_ppg: Spearman ${b.rho.toFixed(3)} (old basis ${a.rho.toFixed(3)})`);
  // And on the finder's scale, not just its order: pool noise only (600 draws, 1-5 weeks).
  for (const id of [...teamPlayers.values()].flat()) {
    const ros = assets.get(id).ros_ppg;
    assert.ok(Math.abs(b.means.get(id) - ros) / ros < 0.08, `P${id}: sim ${b.means.get(id).toFixed(2)} vs ros ${ros.toFixed(2)}`);
  }
});

test('RL-17-3: off by default; on under preview with the preview label; an explicit 0 wins over preview', () => {
  const lg = league();
  const base = flag(null, () => withRandomSeed(5, () => simulateSeason(lg, { runs: RUNS })));
  assert.equal(base.projection_basis, undefined, 'default off: the result has no new field');
  const explicitOff = flag('0', () => withRandomSeed(5, () => simulateSeason(lg, { runs: RUNS })));
  assert.deepEqual(explicitOff, base, 'unset and 0 are the same season, same seed');
  const preview = withEnv({ [RL17_3_ENV]: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => simulateSeason(lg, { runs: RUNS }));
  assert.equal(preview.projection_basis, 'ros');
  assert.equal(preview.preview, true);
  assert.match(preview.preview_reason, /RL-17-3/);
  const vetoed = withEnv({ [RL17_3_ENV]: '0', GRIDIRON_PREVIEW_UNCONFIRMED: '1' }, () => simulateSeason(lg, { runs: RUNS }));
  assert.equal(vetoed.projection_basis, undefined);
  const shipped = flag('1', () => simulateSeason(lg, { runs: RUNS }));
  assert.equal(shipped.projection_basis, 'ros');
  assert.equal(shipped.preview, undefined, 'on by its own flag: not labelled a preview');
  assert.equal(shipped.ros_scaled, 20);
});

test('RL-17-3: a player last season never projected stays out of the sim and out of both counts (known limit)', () => {
  const lg = league();
  const res = flag('1', () => tradeImpactWorld(lg, { runs: RUNS, seed: 7, universe: [NO_PROJ] }));
  assert.equal(simPlayerMeans(res).has(NO_PROJ), false, 'no params to sample: still not simulated (known limit)');
  // Only players with a projection are counted as unscaled; one without is neither.
  assert.equal(res.prep.basisFields.ros_scaled, 20);
  assert.equal(res.prep.basisFields.ros_unscaled, 0);
});

const P = (t, i) => teamPlayers.get(t)[i];
const DEALS = [
  { myTeamId: 1, theirTeamId: 2, iGive: [P(1, 1)], iGet: [P(2, 2)] },
  { myTeamId: 1, theirTeamId: 3, iGive: [P(1, 1), P(1, 3)], iGet: [P(3, 4)] },
  { myTeamId: 2, theirTeamId: 4, iGive: [P(2, 0)], iGet: [P(4, 1), P(4, 2)] }
];

test('RL-17-3 + RL-19-2: under the ROS basis the fast rescore still equals the two full runs', () => {
  for (const seed of [3, 17]) {
    for (const deal of DEALS) {
      const args = { ...deal, runs: RUNS, seed };
      const oldPath = withEnv({ [RL17_3_ENV]: '1', GRIDIRON_FAST_RESCORE: '0' }, () => tradeImpact(league(), args));
      const fast = withEnv({ [RL17_3_ENV]: '1', GRIDIRON_FAST_RESCORE: null }, () => tradeImpact(league(), args));
      assert.ifError(oldPath.error);
      assert.equal(fast.projection_basis, 'ros');
      assert.deepEqual(fast, oldPath, `seed ${seed}, give ${deal.iGive} get ${deal.iGet}`);
    }
  }
});

test('RL-17-3: a world built under one basis is not reused under the other', () => {
  const world = flag('0', () => tradeImpactWorld(league(), { runs: RUNS, seed: 17 }));
  const args = { ...DEALS[0], runs: RUNS, seed: 17 };
  const reused = flag('1', () => tradeImpact(league(), { ...args, world }));
  const fresh = flag('1', () => tradeImpact(league(), args));
  assert.deepEqual(reused, fresh);
  assert.equal(reused.projection_basis, 'ros');
});
