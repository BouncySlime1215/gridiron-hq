/**
 * IS-TITLE: importance-sampled title odds for one long-shot team (shadow only).
 *
 * The contract, in the order it can break:
 *   1. The tilted copula draw is the plain draw when the shift is 0, and its weight
 *      makes a rare event's weighted rate the real model's rate (closed form).
 *   2. theta 0 is plain Monte Carlo exactly: an IS world with no tilt reproduces
 *      tradeImpactWorld's odds for every team, with every weight 1.
 *   3. theta 1.5 visits more of the target's title paths, keeps the mean weight at 1,
 *      and lands on a plain reference.
 *   4. Paired deals: a player for himself is 0, theta 0 equals tradeImpact's delta,
 *      and a player outside the world is a named error.
 *   5. Shadow: the flag is off by default (preview does not turn it on), and the
 *      producer writes only `_run.inputs.is_title`.
 *
 * Fixture: test/fixtures/is-title-league.mjs (made-up eight-team league, team 1 the long shot).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsTitleLeague, TARGET } from './fixtures/is-title-league.mjs';

const { sim, league, teamPlayers, cleanup } = await setupIsTitleLeague({ tag: 'is-title-unit' });
const { correlatedSampler } = await import('../server/services/correlation.js');
const { keyedSeed } = await import('../server/services/stats-util.js');
const isTitle = await import('../server/services/is-title.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { makeAdapter } = await import('./fixtures/campaign-league.mjs');
const { buildPlansFile, isTitleShadow } = await import('../scripts/campaign/produce-plans.mjs');

test.after(cleanup);

const RUNS = 1200;
const P = (t, i) => teamPlayers.get(t)[i];

test('IS-TITLE: a zero shift is the plain draw; the weights give a rare event its real rate', () => {
  // One player whose pool is its own quantile grid, so the outcome IS the uniform.
  const pool = Array.from({ length: 1000 }, (_, i) => i / 1000);
  const sampler = correlatedSampler([{ id: 1, position: 'WR', team: 'AAA', opponent: 'BBB' }], [pool], [keyedSeed('is', 1)]);
  for (const c of [0, 1, 77, 4096]) {
    const t = sampler.tilted(c, Float64Array.of(0));
    assert.deepEqual([...t.vals], [...sampler(c)], `counter ${c}`);
    assert.equal(t.logw, 0);
  }
  // P(u >= 0.99) = 0.01 exactly on this grid.
  const N = 20000, shift = Float64Array.of(2.3);
  const ind = new Float64Array(N), logw = new Float64Array(N), plain = new Float64Array(N);
  for (let c = 0; c < N; c++) {
    const t = sampler.tilted(c, shift);
    ind[c] = t.vals[0] >= 0.99 ? 1 : 0; logw[c] = t.logw;
    plain[c] = sampler(c)[0] >= 0.99 ? 1 : 0;
  }
  const w = isTitle.weightsOf(logw);
  const est = isTitle.weightedRunMean(ind, w);
  const ones = isTitle.weightedRunMean(plain, new Float64Array(N).fill(1));
  assert.ok(Math.abs(est.value - 0.01) < 4 * est.se, `IS ${est.value} +/- ${est.se} vs 0.01`);
  assert.ok(est.se < ones.se / 3, `IS SE ${est.se} is under a third of plain ${ones.se}`);
  const ws = isTitle.weightStats(w);
  assert.ok(Math.abs(ws.mean_weight - 1) < 4 * ws.mean_weight_se, `mean weight ${ws.mean_weight}`);
  assert.throws(() => correlatedSampler([{ id: 1 }], [pool]).tilted(0, shift), /identity keys/);
});

test('IS-TITLE: the shift is spread over the starters only, theta^2 in total', () => {
  const weeks = [
    { week: 2, ids: [1, 2, 3, 4], starters: new Set([1, 3]) },
    { week: 3, ids: [1, 2, 3, 4], starters: new Set([1, 3, 4]) }
  ];
  const t = isTitle.tiltShifts(weeks, 1.5);
  assert.equal(t.tilted, 5);
  let sq = 0;
  for (const [, v] of t.shifts) for (const d of v) sq += d * d;
  assert.ok(Math.abs(sq - 2.25) < 1e-12, `total squared shift ${sq}`);
  assert.deepEqual([...t.shifts.get(2)].map(d => d > 0), [true, false, true, false]);
  assert.equal(isTitle.tiltShifts(weeks, 0).delta, 0);
  assert.equal(isTitle.IS_TITLE_THETA, 1.5, 'the pre-registered theta');
});

test('IS-TITLE: theta 0 is plain Monte Carlo exactly, for every team', () => {
  const plain = sim.tradeImpactWorld(league(), { runs: RUNS, seed: 41 });
  const w = sim.titleWorldIS(league(), { runs: RUNS, seed: 41, theta: 0 });
  assert.ifError(w.fail?.error);
  assert.deepEqual(w.base.teams, plain.base.teams);
  assert.ok([...w.weights].every(x => x === 1));
  const hits = plain.base.per_run.get(TARGET).title.reduce((a, b) => a + b, 0);
  assert.equal(sim.titleOddsIS(w).title_odds, +(hits / RUNS).toFixed(5));
});

test('IS-TITLE: theta 1.5 finds more of the long shot\'s title paths and lands on the plain reference', () => {
  const plain = sim.tradeImpactWorld(league(), { runs: RUNS, seed: 7 });
  const w = sim.titleWorldIS(league(), { runs: RUNS, seed: 7 });
  assert.ifError(w.fail?.error);
  const s = sim.titleOddsIS(w);
  const plainHits = plain.base.per_run.get(TARGET).title.reduce((a, b) => a + b, 0);
  assert.equal(s.status, 'shadow');
  assert.equal(s.theta, 1.5);
  assert.ok(s.tilted_player_weeks > 0);
  assert.ok(s.proposal_title_runs >= 3 * Math.max(1, plainHits),
    `title runs under the proposal ${s.proposal_title_runs} vs plain ${plainHits}`);
  assert.ok(Math.abs(s.mean_weight - 1) < 4 * s.mean_weight_se, `mean weight ${s.mean_weight} +/- ${s.mean_weight_se}`);
  assert.ok(s.se_ratio < 1, `IS SE below plain at the same runs (ratio ${s.se_ratio})`);
  // A 6,000-run plain reference on another seed: the IS estimate sits on it.
  const ref = sim.tradeImpactWorld(league(), { runs: 6000, seed: 99 }).base.teams.find(t => t.roster_id === TARGET).title_odds;
  const refSe = isTitle.binomialSe(ref, 6000);
  assert.ok(ref > 0.001 && ref < 0.01, `control: the target is a long shot (${ref})`);
  assert.ok(Math.abs(s.title_odds - ref) < 4 * Math.hypot(s.title_odds_se, refSe),
    `IS ${s.title_odds} +/- ${s.title_odds_se} vs plain reference ${ref} +/- ${refSe}`);
});

test('IS-TITLE: paired deals off an IS world', () => {
  const lg = league();
  const self = { myTeamId: 1, theirTeamId: 2, iGive: [], iGet: [] };
  const deal = { myTeamId: 1, theirTeamId: 2, iGive: [P(1, 6)], iGet: [P(2, 1)] };
  const w = sim.titleWorldIS(lg, { runs: 600, seed: 13 });
  const zero = sim.tradeImpactIS(w, self);
  assert.equal(zero.status, 'shadow');
  for (const side of [zero.me, zero.them]) { assert.equal(side.title_delta, 0); assert.equal(side.title_delta_se, 0); }
  const moved = sim.tradeImpactIS(w, deal);
  assert.ok(moved.me.title_delta > 0, `control: an upgrade raises the long shot's odds (${moved.me.title_delta})`);
  // theta 0: the paired IS delta is tradeImpact's delta.
  const flat = sim.titleWorldIS(lg, { runs: 600, seed: 13, theta: 0 });
  const plain = sim.tradeImpact(lg, { ...deal, runs: 600, seed: 13 });
  const got = sim.tradeImpactIS(flat, deal);
  // tradeImpact rounds each arm to 4 places before differencing.
  for (const side of ['me', 'them']) {
    assert.equal(+got[side].title_before.toFixed(4), plain[side].title_before, side);
    assert.equal(+got[side].title_after.toFixed(4), plain[side].title_after, side);
  }
  assert.equal(sim.titleWorldIS(lg, { runs: 50, seed: 1, teamId: 'nope' }).fail.error, `team nope is not in league ${lg.id}`);
});

test('IS-TITLE: the flag is off by default and preview mode does not turn it on', () => {
  const prior = { is: process.env[isTitle.IS_TITLE_ENV], pv: process.env[PREVIEW_ENV] };
  try {
    delete process.env[isTitle.IS_TITLE_ENV];
    process.env[PREVIEW_ENV] = '1';
    assert.equal(isTitle.isTitleFlag().on, false);
    process.env[isTitle.IS_TITLE_ENV] = '1';
    assert.equal(isTitle.isTitleFlag().on, true);
  } finally {
    for (const [k, v] of [[isTitle.IS_TITLE_ENV, prior.is], [PREVIEW_ENV, prior.pv]]) {
      if (v == null) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('IS-TITLE: the producer adds only _run.inputs.is_title, and only with the flag on', async () => {
  const shadow = { roster_id: '1', status: 'shadow', title_odds: 0.004, title_odds_se: 0.0008 };
  const produce = async flag => {
    const prior = process.env[isTitle.IS_TITLE_ENV];
    if (flag) process.env[isTitle.IS_TITLE_ENV] = '1'; else delete process.env[isTitle.IS_TITLE_ENV];
    try {
      const a = makeAdapter();
      a.isTitle = () => shadow;
      return (await buildPlansFile([{ id: 99, load: async () => ({ adapter: a }) }],
        { generated_at: '2026-09-24T00:00:00.000Z', clock: () => 0 })).leagues[0];
    } finally {
      if (prior == null) delete process.env[isTitle.IS_TITLE_ENV]; else process.env[isTitle.IS_TITLE_ENV] = prior;
    }
  };
  const off = await produce(false), on = await produce(true);
  assert.ifError(off.error); assert.ifError(on.error);
  assert.equal(off._run.inputs.is_title, undefined);
  assert.deepEqual(on._run.inputs.is_title, { ...shadow, served_title_now: on._run.inputs.is_title.served_title_now, runtime_ms: 0 });
  assert.equal(typeof on._run.inputs.is_title.served_title_now, 'number');
  const strip = e => { const c = structuredClone(e); delete c._run.inputs.is_title; return c; };
  assert.deepEqual(strip(on), off, 'nothing but the shadow row differs');
  // A throwing reader is recorded, not swallowed; an adapter without one says so.
  assert.deepEqual(isTitleShadow({ isTitle: () => { throw new Error('boom'); } }, null, () => 0),
    { status: 'error', error: 'boom', runtime_ms: 0 });
  assert.equal(isTitleShadow({}, null).status, 'not_available');
});
