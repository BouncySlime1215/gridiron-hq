/**
 * CHESS-01a — title-odds chess: beam search over trade -> claim -> flip.
 *
 * Two layers:
 *   1. The search itself (chessSearch) on a hand-built scorer: flip labelling,
 *      no send-back, the stop-at-first-refusal EV, the P(accept) floor, the node
 *      budget, determinism.
 *   2. The real engine on a fixture league (RL-19-3's shape: four ESPN teams,
 *      three NFL games, real copula, 1,200 paired runs). Team 1 is weak at BOTH
 *      RB and WR and holds two spares the market overrates; team 2 has a spare
 *      RB and team 3 a spare WR, each a big season upgrade. Any single offer
 *      fixes one hole; only a path fixes both. The test asserts the searched path
 *      beats every single offer by more than 2 paired SE, in the same world.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-chess01a-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';
process.env.NFL_WEEK = '2';
delete process.env.GRIDIRON_CHESS_ENABLED;
delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
delete process.env.GRIDIRON_TITLE_MUTUAL_ENABLED;

const { db, run } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const NFL = [['AAA', 'BBB'], ['CCC', 'DDD'], ['EEE', 'FFF']];
let nflId = 970;
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
const assets = new Map();
const projMap = new Map();
const teamPlayers = new Map();
let pid = 500;
/** adj: the finder's week rate. mu: the season sim's projection. team 0: free agent. */
function addPlayer(team, position, adj, mu, value) {
  const id = pid++;
  const i = teamPlayers.get(team)?.length ?? 0;
  assets.set(id, { id, name: `P${id}`, position, team_abbr: NFL_TEAMS[(team + i * 2) % 6], espn_id: 9000 + id,
    available: true, current_week_ppg: adj, adj_ppg: adj, ppg: adj, ros_ppg: adj, value, proj: adj * 17 });
  projMap.set(id, { params: { pid: id, mu }, volume: { target_share: position === 'WR' ? 0.2 : null } });
  teamPlayers.set(team, [...(teamPlayers.get(team) ?? []), id]);
  return id;
}
addPlayer(1, 'QB', 18, 18, 3000);
addPlayer(1, 'RB', 5, 5, 1000);
addPlayer(1, 'WR', 5, 5, 1000);
const MY_SPARE_RB = addPlayer(1, 'RB', 8, 2, 2000);   // the market likes him; the sim does not
const MY_SPARE_WR = addPlayer(1, 'WR', 8, 2, 2000);
addPlayer(2, 'QB', 18, 18, 3000);
addPlayer(2, 'RB', 13, 13, 2500);
addPlayer(2, 'WR', 11, 11, 2500);
const T2_SPARE_RB = addPlayer(2, 'RB', 4, 14, 2000);   // a big season upgrade at RB
addPlayer(3, 'QB', 18, 18, 3000);
addPlayer(3, 'RB', 11, 11, 2500);
addPlayer(3, 'WR', 13, 13, 2500);
const T3_SPARE_WR = addPlayer(3, 'WR', 4, 14, 2000);   // a big season upgrade at WR
addPlayer(4, 'QB', 18, 18, 3000);
addPlayer(4, 'RB', 12, 12, 2500);
addPlayer(4, 'WR', 12, 12, 2500);
addPlayer(4, 'RB', 6, 6, 1000);
addPlayer(4, 'WR', 6, 6, 1000);
const FREE_WR = addPlayer(0, 'WR', 7, 7, 600);         // on the wire

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
const { default: tradelabRouter, ...realTradelab } = await import('../server/routes/tradelab.js');
const need = (roster_id, short) => ({ roster_id, needs: short.map(position => ({ position })), surplus: [], window: 'contend' });
mock.module('../server/routes/tradelab.js', {
  defaultExport: tradelabRouter,
  namedExports: { ...realTradelab,
    analyzeLeague: () => ({ teams: [need(1, ['RB', 'WR']), need(2, []), need(3, []), need(4, [])] }) }
});
const sim = await import('../server/services/season-sim.js?chess01a');
mock.module('../server/services/season-sim.js', { namedExports: { ...sim } });
const { findTradeSequences, loadRosters } = await import('../server/services/trade-engine.js?chess01a');
const chess = await import('../server/services/title-chess.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function payload() {
  const g = (w, h, a, hp, ap) => ({ matchupPeriodId: w, winner: hp == null ? 'UNDECIDED' : hp > ap ? 'HOME' : 'AWAY',
    home: { teamId: h, totalPoints: hp ?? undefined }, away: { teamId: a, totalPoints: ap ?? undefined } });
  return {
    teams: [1, 2, 3, 4].map(t => ({ id: t, name: `Team ${t}`, divisionId: 0,
      roster: { entries: teamPlayers.get(t).map(id => ({ lineupSlotId: 20,
        playerPoolEntry: { player: { id: 9000 + id, fullName: `P${id}`,
          defaultPositionId: { QB: 1, RB: 2, WR: 3 }[assets.get(id).position] } } })) } })),
    schedule: [g(1, 1, 2, 90, 90.5), g(1, 3, 4, 95, 94), g(2, 1, 3), g(2, 2, 4), g(3, 1, 4), g(3, 2, 3)],
    settings: { scheduleSettings: { matchupPeriodCount: 3, matchupPeriodLength: 1, playoffTeamCount: 2,
      playoffMatchupPeriodLength: 1, playoffReseed: false, playoffSeedingRule: 'TOTAL_POINTS_SCORED',
      divisions: [{ id: 0, size: 4 }] } }
  };
}
run(`INSERT INTO leagues (id, platform, league_id, season, name, my_team_id, team_count, ppr, roster_positions,
     payload, current_week, payload_season, fetched_at) VALUES (1941, 'espn', 'chess01a', 2026, 'TM', '1', 4, 1, ?, ?, 2, 2026, '2026-09-24T09:00:00Z')`,
JSON.stringify(['QB', 'RB', 'WR']), JSON.stringify(payload()));
const league = () => db.prepare('SELECT * FROM leagues WHERE id = 1941').get();

const withEnv = (vars, fn) => {
  const prior = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v == null) delete process.env[k]; else process.env[k] = v;
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prior)) if (v == null) delete process.env[k]; else process.env[k] = v;
  }
};

const SIM = { tradeImpactWorld: sim.tradeImpactWorld, rosterImpact: sim.rosterImpact,
  expectedLineupTotal: sim.expectedLineupTotal, pairedTitleSe: sim.pairedTitleSe };
const runChess = (options = {}) => {
  const lg = league();
  const teams = loadRosters(lg, assets);
  return chess.titleChess(lg, { myTeamId: '1', teams, assets, wire: [assets.get(FREE_WR)],
    mode: { on: true, preview: false }, sim: SIM, options });
};

/* ---------------------------------------------------------- 1. the search */

/** A toy league: my score is the sum of `pts` of my best two players. */
function toyCtx({ p = 0.5, pts = {} } = {}) {
  const info = id => ({ value: 100, position: 'X', pts: pts[id] ?? 0 });
  const today = new Map([['1', [1, 2, 3]], ['2', [21, 22]], ['3', [31, 32]]]);
  const f = ids => ids.map(id => info(id).pts).sort((a, b) => b - a).slice(0, 2).reduce((s, v) => s + v, 0);
  const base = f(today.get('1'));
  const priced = [];
  return {
    priced,
    ctx: {
      myTeamId: '1', today, info, wire: [], excludeIds: new Set(), blockedPartners: new Set(),
      proxy: f,
      score: rosters => {
        const mine = rosters.get('1') ?? today.get('1');
        const d = +((f(mine) - base) / 100).toFixed(4);
        return { title_delta: d, title_delta_se: 0.001, title_delta_clears_noise: Math.abs(d) > 0.002,
          title_runs: null };
      },
      pAccept: m => { priced.push(m); return { p, basis: 'fixture' }; },
      pairedSe: () => null,
    },
  };
}

test('CHESS-01a search: a trade giving an acquired player is a flip, and it never goes back to its source', () => {
  const { ctx } = toyCtx({ pts: { 21: 10, 31: 20 } });
  const node = { rosters: new Map([['1', [21, 2, 3]], ['2', [1, 22]], ['3', [31, 32]]]), source: new Map([[21, '2']]) };
  const moves = chess.generateMoves(node, ctx);
  const withAcquired = moves.filter(m => m.give?.includes(21));
  assert.ok(withAcquired.length > 0, 'control: the acquired player is offered somewhere');
  assert.ok(withAcquired.every(m => m.kind === 'flip'), 'every trade that gives him is a flip');
  assert.ok(withAcquired.every(m => m.partner_id !== '2'), 'never straight back to team 2');
  assert.ok(moves.some(m => m.kind === 'trade' && !m.give.includes(21)), 'control: plain trades still generated');
});

test('CHESS-01a search: a claim fills the spot a 2-for-1 freed, and drops only when the roster is full', () => {
  const { ctx } = toyCtx();
  ctx.wire = [41];
  ctx.info = id => ({ value: id === 3 ? 50 : 100, position: 'X' });
  const freed = { rosters: new Map([['1', [1, 2]], ['2', [21, 22, 3]], ['3', [31, 32]]]), source: new Map() };
  const add = chess.generateMoves(freed, ctx).find(m => m.kind === 'claim');
  assert.deepEqual([add.shape, add.claim, add.drop], ['add', 41, null], 'below today\'s size: no drop');
  const full = { rosters: ctx.today, source: new Map() };
  const swap = chess.generateMoves(full, ctx).find(m => m.kind === 'claim');
  assert.deepEqual([swap.shape, swap.claim, swap.drop], ['add/drop', 41, 3], 'full: my lowest-value player goes');
  const next = chess.applyMove(freed, add, ctx);
  assert.deepEqual(next.rosters.get('1'), [1, 2, 41]);
  assert.equal(next.source.get(41), 'wire');
});

test('CHESS-01a search: EV stops at the first refusal (sum of P(reach k) x step gain)', () => {
  const { ctx } = toyCtx({ p: 0.5, pts: { 21: 10, 31: 20 } });
  const out = chess.chessSearch(ctx, { depth: 2, beamWidth: 4, perNode: 20, nodeBudget: 500, givePool: 3 });
  const two = out.paths.find(pth => pth.moves === 2);
  assert.ok(two, 'a two-move path exists');
  const [s1, s2] = two.steps;
  const ev = s1.p_accept * s1.step_gain + s1.p_accept * s2.p_accept * s2.step_gain;
  assert.ok(Math.abs(two.expected_title_delta - ev) < 1e-4, `${two.expected_title_delta} vs ${ev}`);
  assert.equal(two.p_complete, 0.25);
  assert.equal(two.full_title_delta, s2.title_delta_after);
  assert.equal(two.steps[1].step_gain, +(s2.title_delta_after - s1.title_delta_after).toFixed(4));
});

test('CHESS-01a search: a step under the P(accept) floor is never expanded', () => {
  const low = toyCtx({ p: 0.1, pts: { 21: 10, 31: 20 } });
  const out = chess.chessSearch(low.ctx, { depth: 2, nodeBudget: 500, givePool: 3 });
  assert.ok(low.priced.length > 0, 'control: trades were priced');
  assert.equal(out.paths.length, 0, 'nothing below 0.15 survives');
  assert.ok(out.priced_out > 0);
  const ok = toyCtx({ p: 0.15, pts: { 21: 10, 31: 20 } });
  assert.ok(chess.chessSearch(ok.ctx, { depth: 2, nodeBudget: 500, givePool: 3 }).paths.length > 0,
    'control: at the floor itself the step expands');
});

test('CHESS-01a search: the node budget is respected and reported', () => {
  const { ctx } = toyCtx({ pts: { 21: 10, 31: 20 } });
  const out = chess.chessSearch(ctx, { depth: 3, perNode: 20, nodeBudget: 7, givePool: 3 });
  assert.equal(out.nodes_scored + out.errors, 7);
  assert.equal(out.budget_hit, true);
  const roomy = chess.chessSearch(ctx, { depth: 1, perNode: 3, nodeBudget: 500, givePool: 3 });
  assert.equal(roomy.budget_hit, false, 'control: a search inside its budget does not claim to hit it');
});

/* ---------------------------------------------------- 2. the real engine */

test('CHESS-01a: rosterImpact on a one-trade path equals tradeImpact in the same world', () => {
  const lg = league();
  const world = sim.tradeImpactWorld(lg, {});
  assert.ok(!world.fail, world.fail?.error);
  const teams = loadRosters(lg, assets);
  const ids = t => teams.find(x => x.roster_id === t).players.map(p => p.id);
  const rosters = new Map([
    ['1', [...ids('1').filter(id => id !== MY_SPARE_RB), T2_SPARE_RB]],
    ['2', [...ids('2').filter(id => id !== T2_SPARE_RB), MY_SPARE_RB]],
  ]);
  const r = sim.rosterImpact(world, { myTeamId: '1', rosters });
  assert.ifError(r.error);
  const direct = sim.tradeImpact(lg, { myTeamId: 1, theirTeamId: 2, iGive: [MY_SPARE_RB], iGet: [T2_SPARE_RB], world });
  assert.equal(r.me.title_delta, direct.me.title_delta);
  assert.equal(r.me.title_delta_se, direct.me.title_delta_se);
  assert.equal(r.title_runs.length, world.runs);
  const bad = sim.rosterImpact(world, { myTeamId: '1', rosters: new Map([['1', [...ids('1'), 999999]]]) });
  assert.equal(bad.error, 'player outside the simulated universe', 'an unsimulated player is refused, not scored as 0');
});

test('CHESS-01a: a searched path beats every single offer by more than 2 paired SE', () => {
  const out = runChess();
  assert.equal(out.status, 'on', out.error);
  assert.ok(out.best_single, 'there is a best single offer');
  const best = out.paths[0];
  assert.ok(best.moves >= 2, `the top path is a multi-move path (got ${best.moves})`);
  // Both holes filled: the path holds both spares.
  const got = best.steps.flatMap(s => s.get ?? (s.claim != null ? [s.claim] : []));
  assert.ok(got.includes(T2_SPARE_RB) && got.includes(T3_SPARE_WR),
    `path gets both upgrades: ${JSON.stringify(best.steps.map(s => [s.kind, s.give, s.get, s.claim]))}`);
  // Every single offer the search scored sits below the path on the path's own
  // full delta, and the gap to the best of them is past 2 paired SE.
  const cmp = best.vs_best_single;
  assert.ok(cmp.full_title_delta_se > 0, 'the comparison carries a paired SE');
  assert.ok(cmp.full_title_delta > 2 * cmp.full_title_delta_se,
    `path ${best.full_title_delta} vs single ${out.best_single.full_title_delta}: `
    + `${cmp.full_title_delta} > 2 x ${cmp.full_title_delta_se}`);
  assert.ok(best.expected_title_delta > out.best_single.expected_title_delta, 'and on expected gain (P(accept) priced)');
  for (const s of best.steps) {
    assert.ok(s.p_accept > 0 && s.p_accept <= 1, 'every step carries its probability');
    assert.ok(Number.isFinite(s.title_delta_after) && s.title_delta_se > 0, 'and its title odds after, with SE');
  }
  assert.ok(best.full_clears_noise, 'the path itself clears 2 SE on title odds');
});

test('CHESS-01a: deterministic under one seed', () => {
  const a = runChess(), b = runChess();
  assert.deepEqual(a.paths, b.paths);
  assert.equal(a.seed, b.seed);
});

test('CHESS-01a: the engine budget holds on the real league', () => {
  const out = runChess({ nodeBudget: 5 });
  assert.equal(out.status, 'on');
  assert.ok(out.nodes_scored + out.errors <= 5);
  assert.equal(out.budget_hit, true);
});

test('CHESS-01a: findTradeSequences carries the chess block only when the flag is on', () => {
  const opts = { myTeamId: '1', requireMutual: true, counterparty: false, assetsOverride: assets, playoffOdds: 0.5, playoffOddsSource: 'fixture' };
  const off = withEnv({ GRIDIRON_CHESS_ENABLED: null, GRIDIRON_PREVIEW_UNCONFIRMED: null },
    () => findTradeSequences(league(), opts));
  assert.ifError(off.error);
  assert.deepEqual(off.chess, { status: 'off', paths: [] });
  const on = withEnv({ GRIDIRON_CHESS_ENABLED: '1' }, () => findTradeSequences(league(), opts));
  assert.ifError(on.error);
  assert.equal(on.chess.status, 'on', on.chess.error);
  assert.ok(on.chess.paths.length > 0, JSON.stringify({ ...on.chess, paths: undefined }));
  assert.equal(on.chess.preview, undefined);
  assert.deepEqual(on.chess.wire, [FREE_WR], 'the league\'s free agent is in the world and offered as a claim');
  const preview = withEnv({ GRIDIRON_CHESS_ENABLED: null, GRIDIRON_PREVIEW_UNCONFIRMED: '1' },
    () => findTradeSequences(league(), opts));
  assert.equal(preview.chess.status, 'on');
  assert.equal(preview.chess.preview, true);
});
