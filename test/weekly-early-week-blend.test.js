/**
 * Early-week blend: weeks 2-4 stop putting 80% of the projection on one game.
 *
 * The live blend (fit-1) was fit and graded on weeks 5-18 and applied from week 2,
 * where season_to_date / last3 / last1 / median all equal the player's single week-1
 * score. The fix stores per-prior-game-count ("bucket") weights under a NEW key,
 * `weightSet.early = { weeks: [2, 4], buckets: { 1: {QB,RB,WR,TE}, 2: ..., 3: ... } }`,
 * read only for 1-3 prior games inside the week window. Everything else — the
 * `weightSet[position]` 5-array contract, weeks 5-18, the week-1 cold start — must be
 * byte-for-byte what it was. These tests pin both halves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-early-week-test-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');
process.env.SCHEDULER_DISABLED = '1';

// Namespace imports, so a missing export fails its own test instead of the whole file.
const E = await import('../server/services/weekly-ensemble.js');
const S = await import('../server/services/weekly-weight-store.js');
const { rows } = await import('../server/db/index.js');
const P = await import('../scripts/promote-early-week-weights.mjs').catch(error => ({ __importError: error }));

const HEADS = ['structural', 'season_to_date', 'last3', 'last1', 'median'];
const LIVE = [0.2, 0.4, 0.15000000000000002, 0.05, 0.2]; // fit-1, exactly as stored
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const perPosition = vector => Object.fromEntries(POSITIONS.map(p => [p, [...vector]]));
const manual = (w, ctx) => HEADS.reduce((sum, h, i) => sum + w[i] * Number(ctx[h]), 0);

function earlySet() {
  return {
    ...perPosition(LIVE),
    early: {
      weeks: [2, 4],
      buckets: {
        1: perPosition([1, 0, 0, 0, 0]),
        2: perPosition([0.5, 0.5, 0, 0, 0]),
        3: { ...perPosition([0.3, 0.2, 0.2, 0.1, 0.2]), QB: [0.6, 0.1, 0.1, 0.1, 0.1] }
      }
    }
  };
}
const ctx = (extra = {}) => ({
  structural: 12, season_to_date: 20, last3: 20, last1: 26, median: 18, position: 'WR', ...extra
});

// ---------------------------------------------------------------- weekly-ensemble.js

test('production context carries prior_weeks for 1-3 prior games and keeps the 4+ shape unchanged', () => {
  assert.equal(E.weeklyEnsembleContext({ structural: 10, priorWeeks: [25], position: 'WR' }).prior_weeks, 1);
  assert.equal(E.weeklyEnsembleContext({ structural: 10, priorWeeks: [25, 3], position: 'WR' }).prior_weeks, 2);
  assert.equal(E.weeklyEnsembleContext({ structural: 10, priorWeeks: [25, 3, 7], position: 'WR' }).prior_weeks, 3);
  // Four or more prior games: exactly the shape the promoted weeks 5-18 path has always had.
  assert.deepEqual(E.weeklyEnsembleContext({ structural: 14, priorWeeks: [8, 12, 20, 4], position: 'RB' }), {
    structural: 14, season_to_date: 11, last3: 12, last1: 4, median: 12, position: 'RB'
  });
  assert.equal(E.weeklyEnsembleContext({ structural: 14, priorWeeks: [], position: 'RB' }), null);
});

test('early bucket weights replace the live vector only for 1-3 prior games inside the week window', () => {
  const set = earlySet();
  // Production contexts carry no week: the window is enforced by activeWeeklyWeightSet.
  assert.equal(E.weeklyEnsemblePrediction(ctx({ prior_weeks: 1 }), set), 12);
  assert.equal(E.weeklyEnsemblePrediction(ctx({ prior_weeks: 2 }), set), 0.5 * 12 + 0.5 * 20);
  assert.equal(E.weeklyEnsemblePrediction(ctx({ prior_weeks: 3, position: 'QB' }), set),
    manual([0.6, 0.1, 0.1, 0.1, 0.1], ctx({ position: 'QB' })));
  // Harness contexts carry the week: outside [2, 4] the live vector runs, whatever prior_weeks says.
  assert.equal(E.weeklyEnsemblePrediction(ctx({ prior_weeks: 2, week: 3 }), set), 0.5 * 12 + 0.5 * 20);
  for (const week of [1, 5, 9, 18]) {
    assert.equal(E.weeklyEnsemblePrediction(ctx({ prior_weeks: 1, week }), set), manual(LIVE, ctx()),
      `week ${week} must use the live vector`);
  }
  // Four or more prior games, or no prior_weeks at all: the live vector.
  assert.equal(E.weeklyEnsemblePrediction(ctx({ prior_weeks: 4, week: 4 }), set), manual(LIVE, ctx()));
  assert.equal(E.weeklyEnsemblePrediction(ctx(), set), manual(LIVE, ctx()));
});

test('a weight set without early predicts exactly as before for every prior_weeks and week', () => {
  const set = perPosition(LIVE);
  for (const prior_weeks of [undefined, 1, 2, 3, 4, 9]) {
    for (const week of [undefined, 1, 2, 3, 4, 5, 12]) {
      const c = ctx({ prior_weeks, week });
      assert.equal(E.weeklyEnsemblePrediction(c, set), manual(LIVE, c));
    }
  }
  // The frozen cold-start fallback is untouched too.
  assert.equal(E.weeklyEnsemblePrediction(ctx({ prior_weeks: 1, position: 'RB' })),
    manual(E.WEEKLY_ENSEMBLE_WEIGHTS.RB, ctx({ position: 'RB' })));
});

test('the position-array contract is kept: a bare array or an unknown position still returns structural', () => {
  assert.equal(E.weeklyEnsemblePrediction(ctx({ prior_weeks: 1 }), [...LIVE]), 12);
  assert.equal(E.weeklyEnsemblePrediction(ctx({ prior_weeks: 1, position: 'K' }), earlySet()), 12);
  assert.equal(E.weeklyEnsemblePrediction(ctx({ prior_weeks: 5, position: 'K' }), earlySet()), 12);
});

test('an early bucket missing a position falls back to that position\'s live vector, never to structural', () => {
  const set = earlySet();
  delete set.early.buckets[2].TE;
  const c = ctx({ prior_weeks: 2, position: 'TE' });
  assert.equal(E.weeklyEnsemblePrediction(c, set), manual(LIVE, c));
});

test('weeklyEnsembleWeightsFor and weeklyEnsembleMode report the vector that actually ran', () => {
  const set = earlySet();
  assert.deepEqual(E.weeklyEnsembleWeightsFor(ctx({ prior_weeks: 2 }), set), [0.5, 0.5, 0, 0, 0]);
  assert.deepEqual(E.weeklyEnsembleWeightsFor(ctx({ prior_weeks: 2, week: 7 }), set), LIVE);
  assert.deepEqual(E.weeklyEnsembleWeightsFor(ctx({ prior_weeks: 6 }), set), LIVE);
  assert.equal(E.weeklyEnsembleWeightsFor(ctx({ position: 'K' }), set), null);
  assert.equal(E.weeklyEnsembleMode(ctx({ prior_weeks: 2 }), set), 'early_week_bucket_2');
  assert.equal(E.weeklyEnsembleMode(ctx({ prior_weeks: 2, week: 6 }), set), 'position_ensemble');
  assert.equal(E.weeklyEnsembleMode(ctx({ prior_weeks: 1, season_to_date: NaN }), set), 'early_week_bucket_1_heads_substituted');
  assert.equal(E.weeklyEnsembleMode(ctx({ prior_weeks: 1, position: 'K' }), set), 'structural_fallback_no_weights_for_position');
  assert.equal(E.weeklyEnsembleMode(null, set), 'structural_only_no_current_season_history');
});

test('weeklyWeightSetForWeek drops early outside its window and never touches the position vectors', () => {
  const set = earlySet();
  for (const week of [2, 3, 4]) assert.deepEqual(E.weeklyWeightSetForWeek(set, week), set);
  for (const week of [1, 5, 18]) {
    const out = E.weeklyWeightSetForWeek(set, week);
    assert.equal(out.early, undefined, `week ${week}`);
    for (const p of POSITIONS) assert.deepEqual(out[p], LIVE);
  }
  assert.ok(set.early, 'the input set is not mutated');
  const plain = perPosition(LIVE);
  assert.equal(E.weeklyWeightSetForWeek(plain, 3), plain);
});

// ---------------------------------------------------------------- weekly-weight-store.js

function fitRecord(hash, weights, extra = {}) {
  return {
    data_hash: hash, through_season: 2040, through_week: 18, weights,
    sample_size: 1000, validation_size: 300, candidate_mae: 4.3, champion_mae: 4.7,
    candidate_spearman: 0.6, champion_spearman: 0.58, coverage_80: null, promoted: true, ...extra
  };
}

test('activeWeeklyWeightSet serves early buckets only inside their week window', () => {
  const saved = S.saveWeeklyFit(fitRecord('early-window-test', earlySet()));
  assert.equal(saved.inserted, true);
  for (const week of [2, 3, 4]) {
    const active = S.activeWeeklyWeightSet({ season: 2041, week });
    assert.equal(active.source, 'adaptive');
    assert.deepEqual(active.weights.early, earlySet().early, `week ${week} carries early`);
  }
  for (const week of [1, 5, 6, 18]) {
    const active = S.activeWeeklyWeightSet({ season: 2041, week });
    assert.equal(active.weights.early, undefined, `week ${week} must not carry early`);
    for (const p of POSITIONS) assert.deepEqual(active.weights[p], LIVE);
  }
  // Display read is uncut and unstripped.
  assert.deepEqual(S.latestWeeklyWeightSet().weights.early, earlySet().early);
});

test('saveWeeklyFit refuses a malformed early block and writes nothing', () => {
  const bad = [
    ['non-convex', set => { set.early.buckets[1].WR = [0.9, 0.9, 0, 0, 0]; }],
    ['missing position', set => { delete set.early.buckets[3].TE; }],
    ['short vector', set => { set.early.buckets[2].QB = [1, 0, 0, 0]; }],
    ['negative weight', set => { set.early.buckets[2].RB = [1.2, -0.2, 0, 0, 0]; }],
    ['window reaches week 1', set => { set.early.weeks = [1, 4]; }],
    ['window backwards', set => { set.early.weeks = [4, 2]; }],
    ['bucket 0', set => { set.early.buckets[0] = perPosition([1, 0, 0, 0, 0]); }],
    ['no buckets', set => { set.early.buckets = {}; }]
  ];
  for (const [name, mutate] of bad) {
    const set = earlySet();
    mutate(set);
    const hash = `early-bad-${name}`;
    assert.throws(() => S.saveWeeklyFit(fitRecord(hash, set)), /early/i, name);
    assert.equal(rows('SELECT COUNT(*) AS n FROM weekly_ensemble_fits WHERE data_hash=?',
      S.weeklyFitDataHash(hash))[0].n, 0, `${name} must not be stored`);
  }
});

test('the stored row reproduces the graded predictions bit for bit', () => {
  // A weight set with awkward floats, graded in memory on a spread of contexts ...
  const set = {
    ...perPosition(LIVE),
    early: {
      weeks: [2, 4],
      buckets: {
        1: perPosition([0.85, 0.15000000000000002, 0, 0, 0]),
        2: { ...perPosition([0.7000000000000001, 0.1, 0.05, 0.05, 0.1]), RB: [0.65, 0.2, 0, 0.05, 0.1] },
        3: perPosition([0.55, 0.25, 0.05, 0.05, 0.1])
      }
    }
  };
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const contexts = [];
  for (let i = 0; i < 400; i++) {
    const week = 2 + (i % 6); // weeks 2-7: early window and the live window
    const prior = Math.min(week - 1, 1 + Math.floor(rnd() * 4));
    contexts.push({
      structural: rnd() * 25, season_to_date: rnd() * 30, last3: rnd() * 30, last1: rnd() * 40, median: rnd() * 30,
      position: POSITIONS[i % 4], prior_weeks: prior, week
    });
  }
  const graded = contexts.map(c => E.weeklyEnsemblePrediction(c, E.weeklyWeightSetForWeek(set, c.week)));
  // ... stored, read back the way production reads it, and re-predicted.
  S.saveWeeklyFit(fitRecord('early-roundtrip-test', set, { through_season: 2050 }));
  const reproduced = contexts.map(c =>
    E.weeklyEnsemblePrediction(c, S.activeWeeklyWeightSet({ season: 2051, week: c.week }).weights));
  assert.deepEqual(reproduced, graded);
  // Weeks 5+ reproduce the live vector exactly.
  for (const [i, c] of contexts.entries()) {
    if (c.week >= 5) assert.equal(reproduced[i], E.weeklyEnsemblePrediction(c, perPosition(LIVE)));
  }
  // And the production context path (no week field) through the week-3 set.
  const prodCtx = E.weeklyEnsembleContext({ structural: 11, priorWeeks: [30], position: 'WR' });
  assert.equal(E.weeklyEnsemblePrediction(prodCtx, S.activeWeeklyWeightSet({ season: 2051, week: 3 }).weights),
    0.85 * 11 + 0.15000000000000002 * 30);
});

test('carryEarlyWeights keeps the early buckets when the late vector is re-promoted', () => {
  const previous = earlySet();
  const next = perPosition([0.25, 0.35, 0.15, 0.05, 0.2]);
  const merged = S.carryEarlyWeights(next, previous);
  assert.deepEqual(merged.early, previous.early);
  for (const p of POSITIONS) assert.deepEqual(merged[p], next[p]);
  const own = { ...next, early: { weeks: [2, 3], buckets: { 1: perPosition([1, 0, 0, 0, 0]) } } };
  assert.equal(S.carryEarlyWeights(own, previous), own, 'a set with its own early is left alone');
  assert.equal(S.carryEarlyWeights(next, perPosition(LIVE)), next, 'nothing to carry');
});

// ---------------------------------------------------------------- scripts/promote-early-week-weights.mjs

test('promotion script imports without running its main', () => {
  assert.equal(P.__importError, undefined, String(P.__importError?.stack ?? ''));
  assert.equal(typeof P.shrinkageVector, 'function');
});

test('shrinkageVector: structural gets k/(n+k), the other heads keep the live proportions', () => {
  const w = P.shrinkageVector(LIVE, 2, 6);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(w[0] - 6 / 8) < 1e-12);
  const share = 2 / 8;
  for (let i = 1; i < 5; i++) assert.ok(Math.abs(w[i] - share * LIVE[i] / 0.8) < 1e-12);
  assert.deepEqual(P.shrinkageVector(LIVE, 3, 0).map(x => +x.toFixed(12)), [0, 0.5, 0.1875, 0.0625, 0.25]);
  assert.ok(P.shrinkageVector(LIVE, 1, 1e9)[0] > 0.999999);
});

function syntheticRows(n, truth, seed0 = 11) {
  let seed = seed0;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = { structural: rnd() * 20, season_to_date: rnd() * 20, last3: rnd() * 20, last1: rnd() * 20,
      median: rnd() * 20, position: POSITIONS[i % 4], prior_weeks: 1 + (i % 3), player_id: i % 97, week: 2 + (i % 3) };
    r.actual = truth(r);
    out.push(r);
  }
  return out;
}

test('convexGridFit recovers noiseless generating weights on the 0.05 grid', () => {
  const data = syntheticRows(600, r => 0.7 * r.structural + 0.3 * r.last1);
  const fit = P.convexGridFit(data);
  assert.deepEqual(fit.weights.map(x => +x.toFixed(10)), [0.7, 0, 0, 0.3, 0]);
  assert.ok(fit.mae < 1e-9);
});

test('fitShrinkageK recovers the k that generated the data', () => {
  const live = perPosition(LIVE);
  const k = 3.5;
  const data = syntheticRows(900, r => manual(P.shrinkageVector(LIVE, r.prior_weeks, k), r));
  const fit = P.fitShrinkageK(data, live);
  assert.ok(Math.abs(fit.k - k) < 1e-9, `fitted ${fit.k}`);
});

test('startSitPairAccuracy scores one common pair set: same week and position, both >= 4 under every model', () => {
  const rowsIn = [
    { week: 2, position: 'WR', actual: 20, preds: { a: 15, b: 10 } },
    { week: 2, position: 'WR', actual: 5, preds: { a: 12, b: 14 } },
    { week: 2, position: 'WR', actual: 0, preds: { a: 9, b: 3 } },  // b < 4: out of the common set
    { week: 2, position: 'RB', actual: 30, preds: { a: 20, b: 20 } }, // alone at RB
    { week: 3, position: 'WR', actual: 7, preds: { a: 8, b: 8 } },
    { week: 3, position: 'WR', actual: 7, preds: { a: 6, b: 9 } }     // actual tie -> 0.5
  ];
  const out = P.startSitPairAccuracy(rowsIn, ['a', 'b']);
  assert.equal(out.pairs, 2);
  assert.equal(out.accuracy.a, (1 + 0.5) / 2);
  assert.equal(out.accuracy.b, (0 + 0.5) / 2);
});

test('earlyGateVerdict passes only when every rule holds in both validation seasons', () => {
  const good = { vs_live: { mean_diff: -0.3, significant: true }, mae: 4.4, mae_structural: 4.45, weeks5_18_mismatches: 0 };
  assert.equal(P.earlyGateVerdict({ 2024: good, 2025: good }).pass, true);
  const cases = [
    ['not significant in 2025', { 2024: good, 2025: { ...good, vs_live: { mean_diff: -0.3, significant: false } } }],
    ['worse than live', { 2024: { ...good, vs_live: { mean_diff: 0.2, significant: true } }, 2025: good }],
    ['bootstrap error', { 2024: { ...good, vs_live: { error: 'too few' } }, 2025: good }],
    ['worse than structural-only', { 2024: good, 2025: { ...good, mae: 4.46 } }],
    ['weeks 5-18 moved', { 2024: { ...good, weeks5_18_mismatches: 1 }, 2025: good }],
    ['a season missing', { 2024: good }]
  ];
  for (const [name, input] of cases) {
    const verdict = P.earlyGateVerdict(input);
    assert.equal(verdict.pass, false, name);
    assert.ok(verdict.reasons.length > 0, name);
  }
});

test('fitBuckets: per-bucket grid fits, structural-only under 200 rows, per-position only where a position has 200', () => {
  let seed = 3;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const row = (prior_weeks, position, truth) => {
    const r = { structural: rnd() * 20, season_to_date: rnd() * 20, last3: rnd() * 20, last1: rnd() * 20,
      median: rnd() * 20, position, prior_weeks };
    r.actual = truth(r);
    return r;
  };
  const data = [];
  for (let i = 0; i < 400; i++) data.push(row(1, POSITIONS[i % 4], r => 0.8 * r.structural + 0.2 * r.season_to_date));
  for (let i = 0; i < 100; i++) data.push(row(2, POSITIONS[i % 4], r => r.last1));                 // too few rows
  for (let i = 0; i < 250; i++) data.push(row(3, 'QB', r => 0.5 * r.structural + 0.5 * r.last1));
  for (const position of ['RB', 'WR']) for (let i = 0; i < 250; i++) data.push(row(3, position, r => 0.9 * r.structural + 0.1 * r.median));
  for (let i = 0; i < 50; i++) data.push(row(3, 'TE', r => 0.9 * r.structural + 0.1 * r.median));   // TE too few
  const round = w => w.map(x => +x.toFixed(10));

  const global = P.fitBuckets(data, false);
  for (const p of POSITIONS) {
    assert.deepEqual(round(global[1][p]), [0.8, 0.2, 0, 0, 0]);
    assert.deepEqual(global[2][p], [1, 0, 0, 0, 0], 'a bucket under 200 rows is structural-only');
  }
  assert.deepEqual(global[3].QB, global[3].TE, 'global architecture: one vector per bucket');

  const byPosition = P.fitBuckets(data, true);
  assert.deepEqual(round(byPosition[3].QB), [0.5, 0, 0, 0.5, 0]);
  assert.deepEqual(round(byPosition[3].RB), [0.9, 0, 0, 0, 0.1]);
  assert.deepEqual(byPosition[3].TE, global[3].TE, 'a position under 200 rows takes the bucket global');
  assert.deepEqual(byPosition[1].WR, global[1].WR, '100 rows per position in bucket 1: all take the global');
  assert.deepEqual(byPosition[2].QB, [1, 0, 0, 0, 0]);
});

test('buildEarlyWeightSet keeps the live position vectors and passes storage validation', () => {
  const live = perPosition(LIVE);
  const buckets = { 1: perPosition([1, 0, 0, 0, 0]), 2: perPosition([0.8, 0.2, 0, 0, 0]), 3: perPosition([0.6, 0.4, 0, 0, 0]) };
  const set = P.buildEarlyWeightSet(live, buckets, { candidate: 'c' });
  for (const p of POSITIONS) assert.deepEqual(set[p], LIVE);
  assert.deepEqual(set.early.weeks, [2, 4]);
  assert.deepEqual(set.early.buckets, buckets);
  assert.equal(set.early.candidate, 'c');
  assert.doesNotThrow(() => S.validateEarlyWeights(set.early));
});
