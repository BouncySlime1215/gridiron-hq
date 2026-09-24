/**
 * RB-TITLE: the conditional (Rao-Blackwellised) title event.
 *
 * Plain Monte Carlo counts a title as 1 in the one run whose bracket a team won and 0
 * elsewhere. The conditional estimator keeps each run's regular season (its field,
 * seeds and team offsets) and replaces the bracket's coin with the exact probability
 * of winning it, from every run's playoff-week scores. Same expectation, less noise.
 *
 * Pre-registered gate (r50, 2026-09-24): on a synthetic league, median SE ratio
 * (conditional / plain, across replicate seeds) <= 0.5 for title levels and <= 0.45
 * for paired title deltas, with no bias: |mean(conditional) - mean(plain)| inside
 * 3 standard errors of that difference for every team.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-rb-title-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.GRIDIRON_DB_INTEGRITY_CHECK = 'off';
process.env.SCHEDULER_DISABLED = '1';

const { db } = await import('../server/db/index.js');
const S = await import('../server/services/season-sim.js');
const RB = await import('../server/services/rb-title.js');
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
  withEnv({ [RB.RB_TITLE_ENV]: null, [PREVIEW_ENV]: null }, () => assert.equal(RB.rbTitleMode(), 'off'));
  withEnv({ [RB.RB_TITLE_ENV]: null, [PREVIEW_ENV]: '1' }, () => assert.equal(RB.rbTitleMode(), 'off'));
  withEnv({ [RB.RB_TITLE_ENV]: 'shadow' }, () => assert.equal(RB.rbTitleMode(), 'shadow'));
  withEnv({ [RB.RB_TITLE_ENV]: '1' }, () => assert.equal(RB.rbTitleMode(), 'on'));
  withEnv({ [RB.RB_TITLE_ENV]: '0' }, () => assert.equal(RB.rbTitleMode(), 'off'));
});

test('bracket probabilities: a hand-worked 4-team fixed bracket', () => {
  // Two runs. Round 1 (week 5): seeds 1v4 and 2v3. Final (week 6).
  // Round 1: A (seed 1) beats D in both runs; B vs C split 1-1 on same-run differences.
  // Final: A-B differences {+5, -5} -> 0.5; A-C {+5, +5} -> 1.
  const pts = {
    A: { 5: [110, 110], 6: [105, 95] },
    B: { 5: [120, 80], 6: [100, 100] },
    C: { 5: [100, 100], 6: [100, 90] },
    D: { 5: [90, 90], 6: [0, 0] }
  };
  const ct = RB.conditionalTitle({
    ids: ['A', 'B', 'C', 'D'], runs: 2, roundWeeks: [[5], [6]], reseed: false,
    rawPoints: (id, week, k) => pts[id][week][k]
  });
  const p = ct.probs(['A', 'B', 'C', 'D'], null);
  assert.ok(Math.abs(p.get('A') - 0.75) < 1e-12, `A ${p.get('A')}`);  // 1 x (0.5 x 0.5 + 0.5 x 1)
  assert.ok(Math.abs(p.get('B') - 0.25) < 1e-12, `B ${p.get('B')}`);  // 0.5 x 0.5
  assert.equal(p.get('C'), 0);                                         // A-C final always A
  assert.equal(p.get('D'), 0);
  const sum = [...p.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
});

test('bracket probabilities: a tie goes to the better seed, byes pass through, offsets shift the odds', () => {
  const pts = { A: { 5: [100], 6: [100] }, B: { 5: [100], 6: [100] }, C: { 5: [100], 6: [100] } };
  const ct = RB.conditionalTitle({
    ids: ['A', 'B', 'C'], runs: 1, roundWeeks: [[5], [6]], reseed: false,
    rawPoints: (id, week, k) => pts[id][week][k]
  });
  // 3-team field: seed 1 has a bye, 2 v 3 tie -> seed 2; final tie -> seed 1.
  assert.equal(ct.probs(['C', 'A', 'B'], null).get('C'), 1);
  // Offset +1 per week to seed 3 flips every game it plays.
  const off = new Map([['A', 0], ['B', 1], ['C', 0]]);
  const p = ct.probs(['C', 'A', 'B'], off);
  assert.equal(p.get('B'), 1);
});

test('reseed: later rounds pair the best remaining seed with the worst', () => {
  // 6-team field, byes for seeds 1-2. Week 5: 5 upsets 4, 6 upsets 3.
  // Reseeded week 6: 1 v 6 (1 wins), 2 v 5 (5 wins); final 1 v 5 -> 5.
  // Fixed week 6: 1 v 5 (5 wins), 2 v 6 (2 wins); final 5 v 2 -> 2.
  const pts = {
    s1: { 5: [0], 6: [100], 7: [50] }, s2: { 5: [0], 6: [100], 7: [200] },
    s3: { 5: [90], 6: [0], 7: [0] }, s4: { 5: [90], 6: [0], 7: [0] },
    s5: { 5: [100], 6: [105], 7: [60] }, s6: { 5: [100], 6: [95], 7: [0] }
  };
  const field = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const build = reseed => RB.conditionalTitle({
    ids: field, runs: 1, roundWeeks: [[5], [6], [7]], reseed, rawPoints: (id, week, k) => pts[id][week][k]
  });
  assert.equal(build(true).probs(field, null).get('s5'), 1);
  assert.equal(build(false).probs(field, null).get('s2'), 1);
});

test('off: playSeasons output is exactly the pre-RB-TITLE output', () => {
  const lg = synthLeague(3);
  const run = mode => S.__test.playSeasons({ ...lg.prep, rbTitle: mode }, lg.teams, 300, true, lg.points(null));
  const a = run('off');
  const b = withEnv({ [RB.RB_TITLE_ENV]: null }, () => S.__test.playSeasons(lg.prep, lg.teams, 300, true, lg.points(null)));
  const strip = o => JSON.stringify({ ...o, per_run: undefined });
  assert.equal(strip(a), strip(b));
  assert.equal(a.title_estimator, undefined);
  assert.ok(a.per_run.get('1').title instanceof Uint8Array);
});

test('shadow: served title odds unchanged, conditional odds carried beside them', () => {
  const lg = synthLeague(4);
  const off = S.__test.playSeasons({ ...lg.prep, rbTitle: 'off' }, lg.teams, 300, true, lg.points(null));
  const sh = S.__test.playSeasons({ ...lg.prep, rbTitle: 'shadow' }, lg.teams, 300, true, lg.points(null));
  for (const t of off.teams) {
    const s = sh.teams.find(x => x.roster_id === t.roster_id);
    assert.equal(s.title_odds, t.title_odds);
    assert.deepEqual(s.title_odds_95, t.title_odds_95);
    assert.equal(typeof s.title_odds_rb, 'number');
    assert.equal(typeof s.title_odds_rb_se, 'number');
  }
  assert.equal(sh.title_estimator, 'indicator');
  assert.equal(sh.rb_title, 'shadow');
  const sum = sh.teams.reduce((s, t) => s + t.title_odds_rb, 0);
  assert.ok(Math.abs(sum - 1) < 2e-3, `sum ${sum}`);
});

test('on: title odds are the conditional estimate and sum to 1; per-run values are probabilities', () => {
  const lg = synthLeague(5);
  const on = S.__test.playSeasons({ ...lg.prep, rbTitle: 'on' }, lg.teams, 300, true, lg.points(null));
  assert.equal(on.title_estimator, 'conditional');
  const sum = on.teams.reduce((s, t) => s + t.title_odds, 0);
  assert.ok(Math.abs(sum - 1) < 2e-3, `sum ${sum}`);
  const pr = on.per_run.get('1').title;
  assert.ok(pr instanceof Float64Array);
  for (const v of pr) assert.ok(v >= 0 && v <= 1);
  for (const t of on.teams) assert.ok(t.title_odds_95[0] <= t.title_odds && t.title_odds <= t.title_odds_95[1]);
});

test('on with team offsets (AVAIL-HORIZON sd 8): still sums to 1', () => {
  const lg = synthLeague(6, 8);
  const on = S.__test.playSeasons({ ...lg.prep, rbTitle: 'on' }, lg.teams, 200, false, lg.points(null));
  const sum = on.teams.reduce((s, t) => s + t.title_odds, 0);
  assert.ok(Math.abs(sum - 1) < 2e-3, `sum ${sum}`);
});

/* ------------------------------------------------ the r50 harness (the gate) */

/**
 * A 10-team, 13-week league with a 6-team fixed bracket (weeks 14-16, league 4's shape).
 * Team i's weekly lineup total is Normal(mean_i, 25), keyed by (seed, team, week, run)
 * so both arms of a paired trade share every draw. Team '5' (Nick's slot) is a longshot.
 */
function synthLeague(seed, sd = 0) {
  const ids = Array.from({ length: 10 }, (_, i) => String(i + 1));
  const means = { 1: 118, 2: 116, 3: 114, 4: 112, 5: 104, 6: 110, 7: 108, 8: 106, 9: 102, 10: 100 };
  const teams = ids.map(id => ({ roster_id: id, owner: `o${id}`, players: [] }));
  const weeks = Array.from({ length: 13 }, (_, i) => i + 1);
  const sched = new Map(weeks.map(w => {
    // Round-robin circle method.
    const rot = [ids[0], ...ids.slice(1).map((_, i) => ids[1 + ((i + w) % 9)])];
    return [w, Array.from({ length: 5 }, (_, i) => [rot[i], rot[9 - i]])];
  }));
  const roundWeeks = [[14], [15], [16]];
  return {
    teams,
    prep: {
      lg: { payload: '{}' }, fromWeek: 1, sched, weeks, bracketWeeks: roundWeeks, playoffTeams: 6,
      medianGame: false, world: seed, teamMeanSd: sd,
      rules: { schedule: { playoff_weeks: roundWeeks, reseed: false }, seeding: { tiebreaker: 'TOTAL_POINTS_SCORED' } }
    },
    // `boost`: [team, points per week] added to one team (the "after" arm of a trade).
    points: boost => (t, run, week) => means[t.roster_id]
      + (boost && boost[0] === t.roster_id ? boost[1] : 0)
      + 25 * keyedNormal(keyedSeed(seed, t.roster_id, week), run)
  };
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sdOf = xs => { const m = xs.reduce((s, v) => s + v, 0) / xs.length; return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1)); };
const meanOf = xs => xs.reduce((s, v) => s + v, 0) / xs.length;

test('r50 gate: SE ratio <= 0.5 on levels, <= 0.45 on paired deltas, no bias', () => {
  const REPS = 40, RUNS = 300;
  const level = { plain: new Map(), rb: new Map() };
  const delta = { plain: [], rb: [] };
  for (let rep = 0; rep < REPS; rep++) {
    const lg = synthLeague(1000 + rep);
    const prep = { ...lg.prep, rbTitle: 'shadow' };
    const before = S.__test.playSeasons(prep, lg.teams, RUNS, true, lg.points(null));
    const after = S.__test.playSeasons(prep, lg.teams, RUNS, true, lg.points(['5', 6]));
    for (const t of before.teams) {
      for (const [k, v] of [['plain', t.title_odds], ['rb', t.title_odds_rb]]) {
        if (!level[k].has(t.roster_id)) level[k].set(t.roster_id, []);
        level[k].get(t.roster_id).push(v);
      }
    }
    const b5 = before.teams.find(t => t.roster_id === '5'), a5 = after.teams.find(t => t.roster_id === '5');
    delta.plain.push(a5.title_odds - b5.title_odds);
    delta.rb.push(a5.title_odds_rb - b5.title_odds_rb);
  }
  const ratios = [...level.plain.keys()].map(id => sdOf(level.rb.get(id)) / sdOf(level.plain.get(id)));
  const levelRatio = median(ratios);
  const deltaRatio = sdOf(delta.rb) / sdOf(delta.plain);
  console.log(`# r50 harness: level SE ratio median ${levelRatio.toFixed(3)} [${Math.min(...ratios).toFixed(3)}, ${Math.max(...ratios).toFixed(3)}], paired delta SE ratio ${deltaRatio.toFixed(3)}`);
  assert.ok(levelRatio <= 0.5, `level SE ratio ${levelRatio}`);
  assert.ok(deltaRatio <= 0.45, `delta SE ratio ${deltaRatio}`);

  // Bias: plain is unbiased by construction; the conditional mean must sit within 3 SE of it.
  let worst = 0;
  for (const id of level.plain.keys()) {
    const diffs = level.rb.get(id).map((v, i) => v - level.plain.get(id)[i]);
    const z = Math.abs(meanOf(diffs)) / (sdOf(diffs) / Math.sqrt(diffs.length) || 1e-9);
    worst = Math.max(worst, z);
  }
  const dd = delta.rb.map((v, i) => v - delta.plain[i]);
  const dz = Math.abs(meanOf(dd)) / (sdOf(dd) / Math.sqrt(dd.length));
  console.log(`# r50 harness: worst team |bias| z ${worst.toFixed(2)}, paired delta |bias| z ${dz.toFixed(2)}`);
  assert.ok(worst < 3, `level bias z ${worst}`);
  assert.ok(dz < 3, `delta bias z ${dz}`);
});
