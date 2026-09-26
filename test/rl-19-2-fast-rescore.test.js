/**
 * RL-19-2 — title-odds trade scoring rescores two lineups instead of re-running the league.
 *
 * tradeImpact used to simulate the whole league twice per deal (~4-6 s on the
 * synced leagues). The fast path builds the world once (tradeImpactWorld: pools,
 * copula draws, every team's per-run lineups, the unchanged league's result) and
 * a deal re-solves only the two changed lineups. The contract is the same
 * numbers, not close numbers: every field equal to the old path
 * (GRIDIRON_FAST_RESCORE=0), deal by deal and seed by seed.
 *
 * Fixture: RL-6-3's (four teams over three NFL games, real copula, outcome pools
 * drawn from the real global stream), with buildProjections/sampleWeeks counted.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rl192-'));
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
let lastScoring = null;
const calls = { projections: 0, samples: 0 };                 // the scoring tradeImpact built projections with
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
    buildProjections: (opts = {}) => { calls.projections++; lastScoring = opts.scoring ?? null; return projMap; },
    // Outcomes come off the real global stream, so WHO consumes which draw matters.
    sampleWeeks: (params, n) => (calls.samples++, Array.from({ length: n }, () => Math.max(0, params.mu * (0.2 + 1.6 * random()))))
  }
});
mock.module('../server/services/gamescript.js', {
  namedExports: { ...realGamescript, gameScriptFor: () => ({ pass_mult: 1, rush_mult: 1, line: null }) }
});
mock.module('../server/services/contingency.js', {
  namedExports: { ...realContingency, weeklyAvailability: () => new Map() }
});
const simModule = await import('../server/services/season-sim.js?rl192');
const { tradeImpact, tradeImpactWorld } = simModule;
// trade-engine.js imports season-sim.js, so the plain season-sim instance was
// loaded (unmocked) by the `realTradeEngine` import above. Point the Title-impact
// tab at the mocked instance, or its deals are simulated on empty projections
// (every team scores 0, team 1 wins every run, every delta and SE is 0).
mock.module('../server/services/season-sim.js', { namedExports: { ...simModule } });
const { titleOddsTrades } = await import('../server/services/title-odds-trades.js?rl192');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** Week 1 played; weeks 2-3 regular season; a 2-team final in week 4. */
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
     payload, current_week, payload_season, fetched_at) VALUES (1921, 'espn', 'rl192', 2026, 'FRS', '1', 4, 1, ?, ?, 2, 2026, '2026-09-23T08:00:00Z')`,
JSON.stringify(['QB', 'RB', 'WR', 'FLEX']), JSON.stringify(payload()));
const league = () => db.prepare('SELECT * FROM leagues WHERE id = 1921').get();

const RUNS = 300;
const withFlag = (value, fn) => {
  const prior = process.env.GRIDIRON_FAST_RESCORE;
  if (value == null) delete process.env.GRIDIRON_FAST_RESCORE; else process.env.GRIDIRON_FAST_RESCORE = value;
  try { return fn(); } finally {
    if (prior == null) delete process.env.GRIDIRON_FAST_RESCORE; else process.env.GRIDIRON_FAST_RESCORE = prior;
  }
};
const old = args => withFlag('0', () => tradeImpact(league(), args));
const fast = args => withFlag(null, () => tradeImpact(league(), args));
const P = (t, i) => teamPlayers.get(t)[i];
// 1-for-1, 2-for-1, 1-for-2, a player for himself, a pure QB swap, and claims of
// both free agents (the high id and the one that sorts before every rostered player).
const DEALS = [
  { myTeamId: 1, theirTeamId: 2, iGive: [P(1, 1)], iGet: [P(2, 2)] },
  { myTeamId: 1, theirTeamId: 3, iGive: [P(1, 1), P(1, 3)], iGet: [P(3, 4)] },
  { myTeamId: 2, theirTeamId: 4, iGive: [P(2, 0)], iGet: [P(4, 1), P(4, 2)] },
  { myTeamId: 3, theirTeamId: 1, iGive: [P(3, 0)], iGet: [P(1, 0)] },
  { myTeamId: 1, theirTeamId: 2, iGive: [P(1, 2)], iGet: [P(1, 2)] },
  { myTeamId: 4, theirTeamId: 2, iGive: [], iGet: [FA] },
  { myTeamId: 4, theirTeamId: 2, iGive: [P(4, 3)], iGet: [FA_LOW] }
];

test('RL-19-2: the fast rescore gives exactly the old two-run numbers, deal by deal and seed by seed', () => {
  let moved = 0;
  for (const seed of [3, 17, 91]) {
    for (const deal of DEALS) {
      const args = { ...deal, runs: RUNS, seed };
      const a = old(args), b = fast(args);
      assert.ifError(a.error);
      assert.deepEqual(b, a, `seed ${seed}, ${deal.myTeamId}<->${deal.theirTeamId} give ${deal.iGive} get ${deal.iGet}`);
      if (a.me.title_delta !== 0 || a.them.title_delta !== 0) moved++;
    }
  }
  assert.ok(moved >= 6, `control: real deals move the odds (${moved} of ${3 * DEALS.length} did)`);
});

test('RL-19-2: one shared world scores every deal the same as its own full runs, without resampling', () => {
  const world = tradeImpactWorld(league(), { runs: RUNS, seed: 17 });
  assert.ifError(world.fail?.error);
  for (const deal of DEALS) {
    const args = { ...deal, runs: RUNS, seed: 17 };
    const ref = old(args);
    const before = { ...calls };
    const got = fast({ ...args, world });
    assert.deepEqual(got, ref, `shared world, give ${deal.iGive} get ${deal.iGet}`);
    const named = [...deal.iGive, ...deal.iGet];
    if (named.includes(FA) || named.includes(FA_LOW)) {
      // A free agent outside the world's copula gets his own world (same numbers).
      assert.ok(calls.samples > before.samples, 'a deal naming an unsimulated player rebuilds the world');
    } else {
      assert.equal(calls.samples, before.samples, 'a rostered-player deal draws no new outcome pools');
      assert.equal(calls.projections, before.projections, 'a rostered-player deal builds no projections');
    }
  }
});

test('RL-19-2: a world from another seed, run count or sync is not reused', () => {
  const world = tradeImpactWorld(league(), { runs: RUNS, seed: 17 });
  const deal = { ...DEALS[1], runs: RUNS };
  assert.deepEqual(fast({ ...deal, seed: 18, world }), old({ ...deal, seed: 18 }), 'other seed');
  assert.deepEqual(fast({ ...deal, seed: 17, runs: 200, world }), old({ ...deal, seed: 17, runs: 200 }), 'other run count');
  const resynced = { ...league(), fetched_at: '2026-09-23T09:00:00Z' };
  const args = { ...deal, seed: 17 };
  assert.deepEqual(
    withFlag(null, () => tradeImpact(resynced, { ...args, world })),
    withFlag('0', () => tradeImpact(resynced, args)), 'other sync');
  // Control: the same seed and runs do reuse it.
  const before = calls.samples;
  fast({ ...deal, seed: 17, world });
  assert.equal(calls.samples, before, 'control: a matching world is reused');
});

test('RL-19-2: a player for himself is 0 for both teams, and a benched claim leaves everyone at 0', () => {
  const self = fast({ ...DEALS[4], runs: RUNS, seed: 5 });
  for (const side of [self.me, self.them]) {
    assert.equal(side.title_delta, 0); assert.equal(side.playoff_delta, 0); assert.equal(side.title_delta_se, 0);
  }
  const claim = fast({ ...DEALS[5], runs: RUNS, seed: 5 });
  for (const side of [claim.me, claim.them]) { assert.equal(side.title_delta, 0); assert.equal(side.playoff_delta, 0); }
});

test('RL-19-2: the Title-impact tab (shared world) shows the old path\'s numbers', () => {
  const on = withFlag(null, () => titleOddsTrades(1921, { teamId: '1', shortlist: 1, runs: RUNS }));
  const off = withFlag('0', () => titleOddsTrades(1921, { teamId: '1', shortlist: 2, runs: RUNS }));
  assert.ifError(on.error);
  assert.ok(on.deals.length === 1, 'control: the fixture deal was simulated');
  assert.deepEqual(on.deals, off.deals);
});

test('RB-TITLE: fast rescore equals the old path under shadow and on; shadow leaves served numbers alone', () => {
  const withRb = (value, fn) => {
    const prior = process.env.GRIDIRON_RB_TITLE;
    if (value == null) delete process.env.GRIDIRON_RB_TITLE; else process.env.GRIDIRON_RB_TITLE = value;
    try { return fn(); } finally {
      if (prior == null) delete process.env.GRIDIRON_RB_TITLE; else process.env.GRIDIRON_RB_TITLE = prior;
    }
  };
  const args = { ...DEALS[1], runs: RUNS, seed: 17 };
  const off = withRb(null, () => fast(args));
  for (const mode of ['shadow', '1']) {
    assert.deepEqual(withRb(mode, () => fast(args)), withRb(mode, () => old(args)), `mode ${mode}`);
  }
  const shadow = withRb('shadow', () => fast(args));
  for (const side of ['me', 'them']) {
    const { title_delta_rb, title_delta_rb_se, title_delta_plain, title_delta_plain_se, ...served } = shadow[side];
    assert.equal(title_delta_plain, served.title_delta, `${side}: shadow logs the plain delta it serves`);
    assert.equal(title_delta_plain_se, served.title_delta_se);
    assert.deepEqual(served, off[side], `${side}: shadow does not move a served field`);
    assert.equal(typeof title_delta_rb, 'number');
    assert.equal(typeof title_delta_rb_se, 'number');
  }
  // A world built with the flag off is not reused once it is on (the base odds differ).
  const world = withRb(null, () => tradeImpactWorld(league(), { runs: RUNS, seed: 17 }));
  assert.deepEqual(withRb('1', () => fast({ ...args, world })), withRb('1', () => old(args)));
});

test('U1: every side carries each arm\'s title SE and the estimator; on, they are the conditional estimate\'s', () => {
  const withRb = (value, fn) => {
    const prior = process.env.GRIDIRON_RB_TITLE;
    if (value == null) delete process.env.GRIDIRON_RB_TITLE; else process.env.GRIDIRON_RB_TITLE = value;
    try { return fn(); } finally {
      if (prior == null) delete process.env.GRIDIRON_RB_TITLE; else process.env.GRIDIRON_RB_TITLE = prior;
    }
  };
  const args = { ...DEALS[0], runs: RUNS, seed: 17 };
  const off = withRb(null, () => fast(args));
  const on = withRb('1', () => fast(args));
  assert.equal(off.title_estimator, 'indicator');
  assert.equal(on.title_estimator, 'conditional');
  for (const side of ['me', 'them']) {
    for (const r of [off, on]) {
      assert.equal(typeof r[side].title_before_se, 'number', side);
      assert.equal(typeof r[side].title_after_se, 'number', side);
    }
    // Off: an indicator's SE is the binomial one, sqrt(p(1-p)/(n-1)).
    const p = off[side].title_before;
    assert.ok(Math.abs(off[side].title_before_se - Math.sqrt(p * (1 - p) / (RUNS - 1))) < 1e-4, side);
  }
  // The conditional estimate is less noisy for at least one side, on the level and on the paired delta.
  assert.ok(['me', 'them'].some(s => on[s].title_before_se < off[s].title_before_se), 'level SE drops');
  assert.ok(['me', 'them'].some(s => on[s].title_delta_se < off[s].title_delta_se), 'paired delta SE drops');
  // Preview mode never turns it on.
  const prev = process.env.GRIDIRON_PREVIEW_UNCONFIRMED;
  process.env.GRIDIRON_PREVIEW_UNCONFIRMED = '1';
  try { assert.equal(withRb(null, () => fast(args)).title_estimator, 'indicator'); }
  finally { if (prev == null) delete process.env.GRIDIRON_PREVIEW_UNCONFIRMED; else process.env.GRIDIRON_PREVIEW_UNCONFIRMED = prev; }
});

test('RB-DELTAS: deltas serves the conditional delta and SE; levels stay the plain ones; both logged', () => {
  const withRb = (value, fn) => {
    const prior = process.env.GRIDIRON_RB_TITLE;
    if (value == null) delete process.env.GRIDIRON_RB_TITLE; else process.env.GRIDIRON_RB_TITLE = value;
    try { return fn(); } finally {
      if (prior == null) delete process.env.GRIDIRON_RB_TITLE; else process.env.GRIDIRON_RB_TITLE = prior;
    }
  };
  const args = { ...DEALS[1], runs: RUNS, seed: 17 };
  const shadow = withRb('shadow', () => fast(args));
  const deltas = withRb('deltas', () => fast(args));
  assert.deepEqual(withRb('deltas', () => fast(args)), withRb('deltas', () => old(args)), 'fast = old path under deltas');
  assert.equal(deltas.delta_estimator, 'conditional');
  assert.equal(deltas.title_estimator, 'indicator');
  assert.equal(shadow.delta_estimator, 'indicator');
  for (const side of ['me', 'them']) {
    const s = shadow[side], d = deltas[side];
    assert.equal(d.title_before, s.title_before, `${side}: served level is plain`);
    assert.equal(d.title_after, s.title_after);
    assert.equal(d.title_delta, s.title_delta_rb, `${side}: served delta is RB`);
    assert.equal(d.title_delta_se, s.title_delta_rb_se);
    assert.equal(d.title_delta_plain, s.title_delta);
    assert.equal(d.title_delta_clears_noise, Math.abs(d.title_delta) > 2 * d.title_delta_se);
  }
});
