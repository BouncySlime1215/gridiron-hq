/**
 * The governed comparison is a decision procedure, so the tests are about what
 * it REFUSES, not only about what it computes. Each gate gets a case built to
 * trip it and a case built to pass it, because a gate that fires on everything
 * is as useless as one that fires on nothing.
 *
 * The two historically expensive failures in this project are reconstructed
 * directly: the ensemble that reported correlated components as independent
 * signals (gate 7), and the CLV sequence that was inspected repeatedly until a
 * fixed-sample p-value looked acceptable (gate 5).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  governedComparison, alignLosses, holmAdjust, GOVERNED_COMPARISON_VERSION
} from '../server/modeling/governed-comparison.js';
import { ModelRegistry, MemoryModelStore } from '../server/modeling/registry.js';

/* A small deterministic generator so every case is reproducible. */
function lcg(seed = 12345) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function normal(rand) {
  const u = Math.max(1e-12, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** n paired losses where the challenger is better by `edge` on average. */
function pairedLosses(n, edge, { seed = 7, noise = 1, weeks = 51 } = {}) {
  const rand = lcg(seed);
  const a = [], b = [], groups = [];
  for (let i = 0; i < n; i++) {
    const shared = normal(rand) * noise;      // common difficulty of the game
    a.push(10 + shared + normal(rand) * 0.5);
    b.push(10 - edge + shared + normal(rand) * 0.5);
    groups.push(`w${i % weeks}`);
  }
  return { a, b, groups };
}

/* ------------------------------------------------------------------ Holm */

test('Holm step-down is monotone and matches the textbook by hand', () => {
  // p = 0.01, 0.02, 0.04 with m = 3:
  //   adjusted = 3*0.01=0.03, 2*0.02=0.04, 1*0.04=0.04, each floored by the previous.
  const out = holmAdjust([{ key: 'a', p: 0.01 }, { key: 'b', p: 0.02 }, { key: 'c', p: 0.04 }], 0.05);
  const by = Object.fromEntries(out.map(o => [o.key, o]));
  assert.equal(by.a.p_adjusted, 0.03);
  assert.equal(by.b.p_adjusted, 0.04);
  assert.equal(by.c.p_adjusted, 0.04);
  assert.ok(by.a.significant_adjusted && by.b.significant_adjusted && by.c.significant_adjusted);
});

test('Holm refuses the borderline winner that only one look in five made significant', () => {
  const out = holmAdjust([
    { key: 'primary', p: 0.04 }, { key: 'b', p: 0.30 }, { key: 'c', p: 0.51 },
    { key: 'd', p: 0.62 }, { key: 'e', p: 0.88 }
  ], 0.05);
  const primary = out.find(o => o.key === 'primary');
  assert.equal(primary.p_adjusted, 0.2);       // 5 * 0.04
  assert.equal(primary.significant_adjusted, false);
});

test('Holm caps at 1 and passes non-numeric p-values through as null', () => {
  const out = holmAdjust([{ key: 'a', p: 0.9 }, { key: 'b', p: 0.95 }, { key: 'c', p: null }], 0.05);
  assert.equal(out.find(o => o.key === 'a').p_adjusted, 1);
  assert.equal(out.find(o => o.key === 'c').p_adjusted, null);
  assert.equal(out.find(o => o.key === 'a').family_size, 2, 'a null p does not enlarge the family');
});

/* ------------------------------------------------------------------ gate 1 */

test('gate 1: without a preregistered primary metric nothing can promote', () => {
  const { a, b, groups } = pairedLosses(400, 1.0);
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, minEffect: { squared: 0.1 }
  });
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.promotable, false);
  assert.equal(r.preregistered, false);
  assert.match(r.reason, /no preregistered primary metric/);
  assert.ok(r.blockers.some(x => x.startsWith('no_primary_metric_declared')));
});

test('a declared metric that is not present is named, not silently ignored', () => {
  const { a, b, groups } = pairedLosses(400, 1.0);
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, primaryMetric: 'crps'
  });
  assert.ok(r.blockers.some(x => x.startsWith('primary_metric_absent')));
  assert.equal(r.promotable, false);
});

/* ------------------------------------------------------------------ promote */

test('a genuinely better challenger with everything declared does promote', () => {
  const { a, b, groups } = pairedLosses(400, 1.0, { seed: 21 });
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, primaryMetric: 'squared',
    minEffect: { squared: 0.2 }, sigma: { squared: 1.5 }
  });
  assert.equal(r.verdict, 'promote', r.reason);
  assert.equal(r.promotable, true);
  assert.ok(r.metrics.squared.improvement > 0.8);
  assert.equal(r.metrics.squared.sequential.anytime_valid, true);
  assert.equal(r.blockers.length, 0);
  assert.equal(r.version, GOVERNED_COMPARISON_VERSION);
});

test('a significantly WORSE challenger is rejected, not merely left unpromoted', () => {
  const { a, b, groups } = pairedLosses(400, -1.0, { seed: 33 });
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, primaryMetric: 'squared', minEffect: { squared: 0.2 }, sigma: { squared: 1.5 }
  });
  assert.equal(r.verdict, 'reject');
  assert.ok(r.metrics.squared.improvement < 0);
});

test('a difference inside sampling noise is inconclusive in BOTH directions', () => {
  const { a, b, groups } = pairedLosses(400, 0.0, { seed: 44 });
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, primaryMetric: 'squared', minEffect: { squared: 0.2 }, sigma: { squared: 1.5 }
  });
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.promotable, false);
});

/* ------------------------------------------------------------------ gate 4 */

test('gate 4: a real but trivial improvement is blocked by the effect floor', () => {
  // A tiny edge on a very large sample: significant, and not worth shipping.
  const { a, b, groups } = pairedLosses(4000, 0.05, { seed: 55, weeks: 200 });
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, primaryMetric: 'squared', minEffect: { squared: 0.5 }, sigma: { squared: 1.5 }
  });
  assert.ok(r.metrics.squared.improvement > 0, 'the improvement is real');
  assert.ok(r.blockers.some(x => x.startsWith('below_effect_floor')), r.blockers.join(' | '));
  assert.equal(r.promotable, false);
});

test('omitting an effect floor is allowed but is recorded as a note', () => {
  const { a, b, groups } = pairedLosses(400, 1.0, { seed: 66 });
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, primaryMetric: 'squared', sigma: { squared: 1.5 }
  });
  assert.ok(r.notes.some(n => n.includes('no minimum effect declared')));
  assert.equal(r.verdict, 'promote');
});

/* ------------------------------------------------------------------ gate 8 */

/** Paired losses whose DIFFERENCE carries the noise (a shared term cancels). */
function diffNoiseLosses(n, effect, noise, seed, weeks = 51) {
  const rand = lcg(seed);
  const a = [], b = [], groups = [];
  for (let i = 0; i < n; i++) {
    const shared = normal(rand) * noise;
    a.push(100 + shared);
    b.push(100 - effect + shared + normal(rand) * noise);
    groups.push(`w${i % weeks}`);
  }
  return { a, b, groups };
}

test('gate 8: tau is left weakly informative and the grid is reported', () => {
  const { a, b, groups } = diffNoiseLosses(400, 6, 30, 9090);
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, primaryMetric: 'squared', sigma: { squared: 30 }, minEffect: { squared: 2 }
  });
  assert.equal(r.metrics.squared.sequential.tau_source, 'weakly_informative_default',
    'the prior scale is not silently set from the minimum effect');
  assert.ok(Array.isArray(r.tau_grid) && r.tau_grid.length >= 3, 'a tau grid is always reported');
  assert.deepEqual(r.tau_grid.map(g => g.label),
    ['minimum_effect', '3x_minimum_effect', 'sigma', '3x_sigma']);
  assert.ok(r.tau_grid.every(g => typeof g.significant === 'boolean'));
  // The raw sequence must not leak into the output: it is working state.
  assert.equal(r.metrics.squared.diffs, undefined);
});

test('gate 8: a verdict that flips across the prior grid is refused', () => {
  // Tuned to sit exactly where the prior scale decides the answer: a modest
  // effect against a wide per-observation spread. Significant at three of the
  // four prior scales and not at the widest, which is the whole point -- an
  // analyst free to pick tau could have had either answer.
  const { a, b, groups } = diffNoiseLosses(400, 6, 30, 5150);
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, primaryMetric: 'squared', sigma: { squared: 30 }, minEffect: { squared: 2 }
  });
  const outcomes = new Set(r.tau_grid.map(g => g.significant));
  assert.equal(outcomes.size, 2, `this case should straddle the grid: ${JSON.stringify(r.tau_grid)}`);
  assert.ok(r.blockers.some(x => x.startsWith('verdict_depends_on_prior_scale')), r.blockers.join(' | '));
  assert.equal(r.promotable, false);
});

test('gate 8 stays quiet when the answer is the same at every prior scale', () => {
  // A large, unambiguous effect: significant everywhere on the grid.
  const { a, b, groups } = diffNoiseLosses(600, 40, 20, 3131);
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, primaryMetric: 'squared', sigma: { squared: 20 }, minEffect: { squared: 2 }
  });
  assert.equal(new Set(r.tau_grid.map(g => g.significant)).size, 1,
    `expected one outcome across the grid, got ${JSON.stringify(r.tau_grid)}`);
  assert.ok(!r.blockers.some(x => x.startsWith('verdict_depends_on_prior_scale')), r.blockers.join(' | '));
  assert.equal(r.verdict, 'promote', r.reason);
});

/* ------------------------------------------------------------------ gate 5 */

test('gate 5: the CLV failure — a second look at a fixed-sample p-value is blocked', () => {
  const { a, b, groups } = pairedLosses(400, 1.0, { seed: 77 });
  const args = {
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, primaryMetric: 'squared', minEffect: { squared: 0.2 }
  };
  const firstLook = governedComparison({ ...args, looks: 1 });
  assert.equal(firstLook.verdict, 'promote', 'one look at a fixed-sample p-value is legitimate');
  assert.equal(firstLook.metrics.squared.sequential.anytime_valid, false);

  const secondLook = governedComparison({ ...args, looks: 2 });
  assert.equal(secondLook.promotable, false);
  assert.ok(secondLook.blockers.some(x => x.startsWith('repeated_look_without_anytime_validity')));

  // Declaring sigma in advance is the fix, and it lifts the block.
  const governed = governedComparison({ ...args, looks: 6, sigma: { squared: 1.5 } });
  assert.equal(governed.metrics.squared.sequential.anytime_valid, true);
  assert.equal(governed.verdict, 'promote', governed.reason);
});

/* ------------------------------------------------------------------ gate 6 */

test('gate 6: 408 rows inside 4 weeks is four pieces of evidence, and is blocked', () => {
  const { a, b } = pairedLosses(408, 1.0, { seed: 88 });
  const groups = a.map((_, i) => `w${i % 4}`);
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, primaryMetric: 'squared', minEffect: { squared: 0.2 }, sigma: { squared: 1.5 }
  });
  assert.equal(r.independent_clusters, 4);
  assert.ok(r.blockers.some(x => x.startsWith('too_few_independent_clusters')));
  assert.equal(r.promotable, false);
});

test('running with no cluster keys at all is permitted but flagged as too narrow', () => {
  const { a, b } = pairedLosses(400, 1.0, { seed: 99 });
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    primaryMetric: 'squared', minEffect: { squared: 0.2 }, sigma: { squared: 1.5 }
  });
  assert.equal(r.independent_clusters, null);
  assert.ok(r.notes.some(n => n.includes('resampled rows independently')));
});

/* ------------------------------------------------------------------ gate 7 */

test('gate 7: the fake-diversity failure — a relabelled incumbent is refused', () => {
  // The ensemble's situation: a "new" component whose per-game losses are the
  // incumbent's plus a whisper. With enough rows this WILL eventually produce a
  // significant p-value, which is exactly why it is caught before one is read.
  const rand = lcg(4242);
  const a = [], b = [], groups = [];
  for (let i = 0; i < 3000; i++) {
    const base = 10 + normal(rand) * 2;
    a.push(base);
    b.push(base - 0.0009 + normal(rand) * 1e-4);
    groups.push(`w${i % 60}`);
  }
  const r = governedComparison({
    incumbent: { label: 'ensemble', losses: { squared: a } },
    challenger: { label: 'ensemble-with-one-more-correlated-component', losses: { squared: b } },
    groups, primaryMetric: 'squared', sigma: { squared: 2 }
  });
  assert.ok(r.metrics.squared.loss_correlation > 0.999);
  assert.ok(r.blockers.some(x => x.startsWith('indistinguishable_from_incumbent')), r.blockers.join(' | '));
  assert.equal(r.promotable, false);
});

test('gate 7 does not fire on a correlated-but-genuinely-different challenger', () => {
  // Correlation is high (both models see the same games) but the effect is real.
  const { a, b, groups } = pairedLosses(1000, 1.0, { seed: 101, noise: 3 });
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: a } },
    challenger: { label: 'chal', losses: { squared: b } },
    groups, primaryMetric: 'squared', minEffect: { squared: 0.2 }, sigma: { squared: 1.5 }
  });
  assert.ok(r.metrics.squared.loss_correlation > 0.9, 'the losses are strongly correlated');
  assert.ok(!r.blockers.some(x => x.startsWith('indistinguishable')), 'but the effect is not a rounding error');
  assert.equal(r.verdict, 'promote', r.reason);
});

/* ------------------------------------------------------------------ gate 3 */

test('gate 3: winning the primary while losing a secondary is a trade-off, not a win', () => {
  const good = pairedLosses(600, 1.2, { seed: 202 });
  const bad = pairedLosses(600, -1.2, { seed: 303 });
  const r = governedComparison({
    incumbent: { label: 'inc', losses: { squared: good.a, crps: bad.a } },
    challenger: { label: 'chal', losses: { squared: good.b, crps: bad.b } },
    groups: good.groups, primaryMetric: 'squared',
    minEffect: { squared: 0.2 }, sigma: { squared: 1.5, crps: 1.5 }
  });
  assert.ok(r.metrics.squared.improvement > 0 && r.metrics.crps.improvement < 0);
  assert.ok(r.blockers.some(x => x.startsWith('contradictory_evidence')), r.blockers.join(' | '));
  assert.equal(r.promotable, false);
});

/* ------------------------------------------------------------------ aligning */

test('alignLosses pairs by key, never by position', () => {
  const inc = [{ g: 'A', e: 1 }, { g: 'B', e: 2 }, { g: 'C', e: 3 }];
  const chal = [{ g: 'C', e: 30 }, { g: 'A', e: 10 }, { g: 'D', e: 40 }];
  const out = alignLosses(inc, chal, {
    key: r => r.g, losses: { err: r => r.e }
  });
  assert.equal(out.matched, 2);
  assert.deepEqual(out.keys, ['A', 'C']);
  assert.deepEqual(out.a.err, [1, 3]);
  assert.deepEqual(out.b.err, [10, 30], 'C pairs with C, not with whatever sat at index 2');
  assert.equal(out.unmatched_a, 1);
});

test('an observation missing one metric is dropped whole, so arrays stay in step', () => {
  const inc = [{ g: 'A', x: 1, y: 1 }, { g: 'B', x: 2, y: null }, { g: 'C', x: 3, y: 3 }];
  const chal = [{ g: 'A', x: 1, y: 1 }, { g: 'B', x: 2, y: 2 }, { g: 'C', x: 3, y: 3 }];
  const out = alignLosses(inc, chal, { key: r => r.g, losses: { x: r => r.x, y: r => r.y } });
  assert.equal(out.matched, 2);
  assert.equal(out.dropped, 1);
  assert.equal(out.a.x.length, out.a.y.length);
  assert.equal(out.b.x.length, out.b.y.length);
});

test('alignLosses orders chronologically when told how, which the sequential test needs', () => {
  const inc = [{ g: 'c', t: 3, e: 3 }, { g: 'a', t: 1, e: 1 }, { g: 'b', t: 2, e: 2 }];
  const chal = [...inc].map(r => ({ ...r, e: r.e * 10 }));
  const out = alignLosses(inc, chal, { key: r => r.g, order: r => r.t, losses: { e: r => r.e } });
  assert.deepEqual(out.a.e, [1, 2, 3]);
  assert.deepEqual(out.keys, ['a', 'b', 'c']);
});

/* ------------------------------------------------------------------ registry */

test('the registry compares with statistics attached instead of a bare fetch loop', () => {
  const registry = new ModelRegistry(new MemoryModelStore());
  const actor = { id: 1, permissions: ['model:train', 'model:promote'] };
  const gates = { schema: true, leakage: true, data_quality: true, baseline_improvement: true, tests: true };
  const { a, b, groups } = pairedLosses(400, 1.0, { seed: 404 });

  const inc = registry.create({ model: 'incumbent' }, actor);
  const chal = registry.create({ model: 'challenger' }, actor);
  registry.transition(inc.id, 'completed', { result: { gates, losses: { squared: a }, groups } });
  registry.transition(chal.id, 'completed', { result: { gates, losses: { squared: b }, groups } });

  const out = registry.compare([inc.id, chal.id], {
    primaryMetric: 'squared', minEffect: { squared: 0.2 }, sigma: { squared: 1.5 }
  });
  assert.equal(out.experiments.length, 2);
  assert.equal(out.comparisons.length, 1);
  assert.equal(out.comparisons[0].verdict, 'promote', out.comparisons[0].reason);
  assert.deepEqual(out.promotable, [chal.id]);
});

test('an experiment with no losses is returned but reported as incomparable', () => {
  const registry = new ModelRegistry(new MemoryModelStore());
  const actor = { id: 1, permissions: ['model:train'] };
  const gates = { schema: true, leakage: true, data_quality: true, baseline_improvement: true, tests: true };
  const { a } = pairedLosses(400, 1.0);
  const inc = registry.create({ model: 'incumbent' }, actor);
  const chal = registry.create({ model: 'no-evidence' }, actor);
  registry.transition(inc.id, 'completed', { result: { gates, losses: { squared: a } } });
  registry.transition(chal.id, 'completed', { result: { gates } });

  const out = registry.compare([inc.id, chal.id], { primaryMetric: 'squared' });
  assert.equal(out.comparisons[0].comparable, false);
  assert.match(out.comparisons[0].reason, /no result.losses/);
  assert.deepEqual(out.promotable, []);
});

test('challenge() derives the baseline_improvement gate rather than trusting it', () => {
  const registry = new ModelRegistry(new MemoryModelStore());
  const actor = { id: 1, permissions: ['model:train', 'model:promote'] };
  // The challenger ARRIVES asserting it beat the baseline. It did not.
  const gates = { schema: true, leakage: true, data_quality: true, baseline_improvement: true, tests: true };
  const { a, b, groups } = pairedLosses(400, -1.0, { seed: 505 });

  const inc = registry.create({ model: 'incumbent' }, actor);
  const chal = registry.create({ model: 'overconfident-challenger' }, actor);
  registry.transition(inc.id, 'completed', { result: { gates, losses: { squared: a }, groups } });
  registry.transition(chal.id, 'completed', { result: { gates, losses: { squared: b }, groups } });

  const comparison = registry.challenge(chal.id, {
    against: inc.id, primaryMetric: 'squared', minEffect: { squared: 0.2 }, sigma: { squared: 1.5 }
  });
  assert.equal(comparison.verdict, 'reject');

  const stored = registry.store.get(chal.id);
  assert.equal(stored.result.gates.baseline_improvement, false,
    'the self-asserted gate was overwritten by the measured verdict');
  assert.throws(() => registry.promote(chal.id, actor), /baseline_improvement gate failed/);
});

test('a governed comparison outranks a hand-set gate at promotion time', () => {
  const registry = new ModelRegistry(new MemoryModelStore());
  const actor = { id: 1, permissions: ['model:train', 'model:promote'] };
  const gates = { schema: true, leakage: true, data_quality: true, baseline_improvement: true, tests: true };
  const experiment = registry.create({ model: 'gate-forger' }, actor);
  // Every gate asserted true, with a comparison beside them that says otherwise.
  registry.transition(experiment.id, 'completed', {
    result: { gates, comparison: { verdict: 'inconclusive', reason: 'the difference is inside sampling noise' } }
  });
  assert.throws(() => registry.promote(experiment.id, actor),
    /governed comparison verdict 'inconclusive'/);
});

test('the same guard applies to rollback, which is a promotion by another name', () => {
  const registry = new ModelRegistry(new MemoryModelStore());
  const actor = { id: 1, permissions: ['model:promote'] };
  const gates = { schema: true, leakage: true, data_quality: true, baseline_improvement: true, tests: true };
  const store = registry.store;
  store.insert({ id: 'old-version', spec: {}, status: 'completed', created_at: 'x', updated_at: 'x',
    result: { gates, comparison: { verdict: 'reject', reason: 'significantly worse on the primary metric' } } });
  assert.throws(() => registry.rollback('old-version', actor), /governed comparison verdict 'reject'/);
});

test('a promotable experiment still promotes, so the guard is not a blanket block', () => {
  const registry = new ModelRegistry(new MemoryModelStore());
  const actor = { id: 1, permissions: ['model:train', 'model:promote'] };
  const gates = { schema: true, leakage: true, data_quality: true, baseline_improvement: true, tests: true };
  const { a, b, groups } = pairedLosses(400, 1.0, { seed: 606 });
  const inc = registry.create({ model: 'incumbent' }, actor);
  const chal = registry.create({ model: 'real-improvement' }, actor);
  registry.transition(inc.id, 'completed', { result: { gates, losses: { squared: a }, groups } });
  registry.transition(chal.id, 'completed', { result: { gates, losses: { squared: b }, groups } });
  const comparison = registry.challenge(chal.id, {
    against: inc.id, primaryMetric: 'squared', minEffect: { squared: 0.2 }, sigma: { squared: 1.5 }
  });
  assert.equal(comparison.verdict, 'promote', comparison.reason);
  assert.equal(registry.promote(chal.id, actor).active, chal.id);
});
