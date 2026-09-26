/**
 * U6 IS-TITLE: importance sampling for Nick's title odds (docs/tdd/2026-09-25-is-title.tdd.md).
 *
 * The pre-registered bar runs in scripts/rnd/is-title-bench.mjs (10 seeds, 100k direct);
 * these cases pin the pieces: the flag, the defensive mixture's weights, the batch SE
 * and ESS_event, an unbiased rare-event toy, the auto-off check, the inert path and
 * what shadow / on / auto_off do to the served row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-is-title-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const S = await import('../server/services/season-sim.js');
const IS = await import('../server/services/is-title.js');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');
const { keyedSeed, keyedNormal } = await import('../server/services/stats-util.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('flag: off by default, preview does not turn it on, shadow and on are explicit', () => {
  withEnv({ [IS.IS_TITLE_ENV]: null, [PREVIEW_ENV]: null }, () => assert.equal(IS.isTitleMode(), 'off'));
  withEnv({ [IS.IS_TITLE_ENV]: null, [PREVIEW_ENV]: '1' }, () => assert.equal(IS.isTitleMode(), 'off'));
  withEnv({ [IS.IS_TITLE_ENV]: 'shadow' }, () => assert.equal(IS.isTitleMode(), 'shadow'));
  withEnv({ [IS.IS_TITLE_ENV]: '1' }, () => assert.equal(IS.isTitleMode(), 'on'));
  withEnv({ [IS.IS_TITLE_ENV]: '0' }, () => assert.equal(IS.isTitleMode(), 'off'));
});

test('mixture: weights are f/q over the full mixture, bounded by 1/eps, mean 1 under q', () => {
  const mix = IS.mixture({ d: 1, eps: 0.2, comps: [{ pi: 0.6, mu: [2] }, { pi: 0.4, mu: [3] }] });
  // Hand check at z = 1: f/q = 1 / (0.2 + 0.8 (0.6 e^{2-2} + 0.4 e^{3-4.5})).
  const want = 1 / (0.2 + 0.8 * (0.6 * Math.exp(0) + 0.4 * Math.exp(-1.5)));
  assert.ok(Math.abs(mix.weight([1]) - want) < 1e-12);
  let s = 0, max = 0;
  const N = 40000;
  for (let r = 0; r < N; r++) { const w = mix.weight(mix.sample(77, r)); s += w; max = Math.max(max, w); }
  assert.ok(max <= 1 / 0.2 + 1e-12, `max weight ${max}`);
  assert.ok(Math.abs(s / N - 1) < 0.03, `E_q[w] ${s / N}`);
  // No components: q = f, every weight 1, draws are the keyed nominal normal.
  const f = IS.mixture({ d: 1, eps: 0.2, comps: [] });
  assert.equal(f.weight([2.5]), 1);
  assert.equal(f.sample(5, 9)[0], keyedNormal(keyedSeed(5, 'z', 0), 9));
});

test('mixture: eps outside (0, 1] throws instead of producing unbounded weights', () => {
  assert.throws(() => IS.mixture({ d: 1, eps: 0, comps: [] }), /eps/);
});

test('isEstimate: weighted mean, batch SE, ESS_event', () => {
  const v = [1, 0, 0, 1, 0, 0, 1, 0], w = [2, 1, 1, 2, 1, 1, 0.5, 1];
  const e = IS.isEstimate(v, w, 4);
  assert.equal(e.mean, (2 + 2 + 0.5) / 8);
  // ESS_event = (2 + 2 + 0.5)^2 / (4 + 4 + 0.25).
  assert.ok(Math.abs(e.ess_event - 4.5 ** 2 / 8.25) < 1e-12);
  // Batch means 1, 1, 0.25, 0 -> SD / sqrt(4).
  const bm = [1, 1, 0.25, 0], m = 0.5625;
  const sd = Math.sqrt(bm.reduce((s, x) => s + (x - m) ** 2, 0) / 3);
  assert.ok(Math.abs(e.se - sd / 2) < 1e-12);
});

test('rare-event toy: CE pilot + defensive mixture estimate P(Z > 2.5) without bias', () => {
  const truth = 0.0062096653;                                  // 1 - Phi(2.5)
  const evaluate = (mix, start, n) => {
    const zs = [], values = [];
    for (let r = 0; r < n; r++) { const z = mix.sample(11, start + r); zs.push(z); values.push(z[0] > 2.5 ? 1 : 0); }
    return { zs, values };
  };
  const pilot = IS.cePilot({ d: 1, K: 2, eps: 0.2, rounds: 2, runs: 2000, evaluate });
  assert.ok(pilot.mix.comps.length >= 1 && pilot.mix.comps[0].mu[0] > 2, JSON.stringify(pilot.mix.comps));
  const main = evaluate(pilot.mix, IS.RUN_BASE.main, 8000);
  const e = IS.isEstimate(main.values, main.zs.map(z => pilot.mix.weight(z)));
  assert.ok(Math.abs(e.mean - truth) < 3 * e.se, `IS ${e.mean} +/- ${e.se} vs ${truth}`);
  assert.ok(e.ess_event >= 200, `ESS_event ${e.ess_event}`);
  // Plain MC at 10,000 draws has SE ~0.00079; IS must be far tighter on this 1-d event.
  assert.ok(e.se < 0.3 * Math.sqrt(truth * (1 - truth) / 10000), `se ${e.se}`);
});

test('auto-off: disagreement over 2 SE or ESS_event under 200 keeps the direct number', () => {
  const good = { mean: 0.004, se: 0.0002, ess_event: 900 };
  assert.equal(IS.autoOffCheck(good, { mean: 0.0042, se: 0.0003 }).ok, true);
  const far = IS.autoOffCheck(good, { mean: 0.006, se: 0.0003 });
  assert.equal(far.ok, false);
  assert.match(far.reason, /disagrees with the unweighted check/);
  const thin = IS.autoOffCheck({ ...good, ess_event: 150 }, { mean: 0.004, se: 0.0003 });
  assert.equal(thin.ok, false);
  assert.match(thin.reason, /too few effective title runs/);
});

/* ------------------------------------------------ on the season sim */

function synthLeague(world, sd, nickMean = 92) {
  const ids = Array.from({ length: 10 }, (_, i) => String(i + 1));
  const means = { 1: 118, 2: 116, 3: 114, 4: 112, 5: nickMean, 6: 110, 7: 108, 8: 106, 9: 102, 10: 100 };
  const teams = ids.map(id => ({ roster_id: id, owner: `o${id}`, players: [] }));
  const weeks = Array.from({ length: 13 }, (_, i) => i + 1);
  const sched = new Map(weeks.map(w => {
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w) % 9)])];
    return [w, Array.from({ length: 5 }, (_, i) => [rot[i], rot[9 - i]])];
  }));
  const roundWeeks = [[14], [15], [16]];
  return {
    teams,
    prep: {
      lg: { payload: '{}' }, fromWeek: 1, sched, weeks, bracketWeeks: roundWeeks, playoffTeams: 6,
      medianGame: false, world, teamMeanSd: sd, rbTitle: 'off',
      rules: { schedule: { playoff_weeks: roundWeeks, reseed: false }, seeding: { tiebreaker: 'TOTAL_POINTS_SCORED' } }
    },
    points: (t, run, week) => means[t.roster_id] + 25 * keyedNormal(keyedSeed(world, t.roster_id, week), run)
  };
}

const runIs = (lg, opts) => IS.isTitleRun({
  prep: lg.prep, teams: lg.teams, meId: '5', rawPointsFor: lg.points,
  playSeasons: S.__test.playSeasons, teamOffsets: S.__test.teamOffsets, rbMode: 'off', opts
});

test('inert: with the team-mean term off there is no season factor, and it says so', () => {
  const r = runIs(synthLeague(1, 0), { pilotRuns: 50, mainRuns: 100, checkRuns: 0 });
  assert.equal(r.status, 'inert');
  assert.match(r.reason, /team-mean term is off/);
  assert.equal(r.estimate, undefined);
});

test('the default offsets hook leaves playSeasons unchanged', () => {
  const lg = synthLeague(2, 8);
  const a = S.__test.playSeasons(lg.prep, lg.teams, 300, false, lg.points);
  const b = S.__test.playSeasons({ ...lg.prep, offsetsOf: run => S.__test.teamOffsets(lg.prep.world, lg.teams.map(t => t.roster_id), run, 8) },
    lg.teams, 300, false, lg.points);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('season sim: the IS estimate agrees with its unweighted check and tilts Nick upward', () => {
  const r = runIs(synthLeague(3, 8), { pilotRuns: 600, mainRuns: 4000, checkRuns: 6000 });
  assert.ok(['ok', 'auto_off'].includes(r.status));
  assert.ok(r.mixture.every(c => c.mu[0] > 0.5), JSON.stringify(r.mixture));
  assert.ok(r.max_weight <= 5 + 1e-9);
  assert.ok(Math.abs(r.estimate - r.check.estimate) < 3 * Math.hypot(r.se, r.check.se),
    `IS ${r.estimate} +/- ${r.se} vs check ${r.check.estimate} +/- ${r.check.se}`);
  assert.deepEqual(r.runs, { pilot: 1200, main: 4000, check: 6000 });
});

const fakeRes = () => ({ teams: [{ roster_id: '5', title_odds: 0.004, title_odds_95: [0.002, 0.006] }, { roster_id: '1', title_odds: 0.3, title_odds_95: [0.28, 0.32] }] });
const st = status => ({ roster_id: '5', status, reason: status === 'ok' ? null : 'x', estimate: 0.0045, se: 0.0003, ci: [0.0039, 0.0051] });

test('shadow: the served row is unchanged and the IS number sits beside it', () => {
  const out = S.__test.withIsTitle(fakeRes(), 'shadow', st('ok'));
  const me = out.teams.find(t => t.roster_id === '5');
  assert.equal(me.title_odds, 0.004);
  assert.deepEqual(me.title_odds_95, [0.002, 0.006]);
  assert.equal(me.title_odds_is, 0.0045);
  assert.equal(me.title_odds_is_se, 0.0003);
  assert.equal(out.is_title.served, false);
  assert.deepEqual(out.teams.find(t => t.roster_id === '1'), fakeRes().teams[1]);
});

test('on: serves the IS level only when the check passed; auto_off keeps the direct number and says why', () => {
  const on = S.__test.withIsTitle(fakeRes(), 'on', st('ok'));
  const me = on.teams.find(t => t.roster_id === '5');
  assert.equal(me.title_odds, 0.0045);
  assert.deepEqual(me.title_odds_95, [0.0039, 0.0051]);
  assert.equal(me.title_odds_direct, 0.004);
  assert.equal(me.title_estimator, 'importance');
  assert.equal(on.is_title.served, true);

  const off = S.__test.withIsTitle(fakeRes(), 'on', st('auto_off'));
  const me2 = off.teams.find(t => t.roster_id === '5');
  assert.equal(me2.title_odds, 0.004);
  assert.equal(off.is_title.served, false);
  assert.equal(off.is_title.status, 'auto_off');
  assert.equal(off.is_title.reason, 'x');
});
