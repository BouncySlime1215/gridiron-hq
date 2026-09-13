import test from 'node:test';
import assert from 'node:assert/strict';
import { jointComponentWeights } from '../server/services/nfl-ensemble.js';

/*
 * Direct proof that `jointComponentWeights` -- the ridge-regularised joint
 * regression that replaced `rawWeight`'s exp(-0.7 * standalone RMSE) for the
 * raw blend's DEFAULT ('exponential') weighting -- does something the old
 * per-component formula was structurally unable to do: recognise that two
 * highly correlated components carry roughly ONE unit of information between
 * them, not two, and shrink accordingly.
 *
 * The fixture below is synthetic and proves only the linear algebra, the same
 * way ensemble-massey-ridge.test.js proves massey()'s ridge algebra on a
 * constructed league rather than on real history. No database is needed --
 * `jointComponentWeights` is a pure function over plain rows, exactly like
 * `massey`, `ols` and `constrainedLeastSquares` elsewhere in this repository.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = (rand, sd = 1) => {
  let s = 0;
  for (let i = 0; i < 12; i++) s += rand();
  return (s - 6) * sd;
};

/**
 * `n` rows shaped exactly like the raw-window rows `fitEnsemble` builds:
 * `{ margins: {id: value|null}, actual_margin, week_key }`, laid out into
 * `gamesPerWeek`-sized chronological weeks so `completeWeekSplit` (used
 * internally to choose the ridge strength) has real week boundaries to split
 * on, the same as the real walk-forward stream does.
 *
 * Two independent latent factors drive the true margin. `predictive` sees
 * BOTH factors and is therefore the one component with a genuinely complete,
 * independent view -- it is not merely "lower noise", it has strictly more
 * information than any other column. `redundant_a`/`redundant_b` see only
 * `factor1` plus THE SAME shared noise draw: up to a small jitter they are
 * the same column twice, deliberately built to have standalone RMSE close to
 * `predictive`'s own -- exactly the `market_anchor`/`market_regression`
 * situation the doc comment on `jointComponentWeights` describes, where two
 * components mostly restate one opinion. `noise1`/`noise2` see neither
 * factor at all and exist as an easy sanity check alongside the harder claim.
 */
function redundancyFixture({ n = 1200, gamesPerWeek = 12, seed = 4242 } = {}) {
  const rand = mulberry32(seed);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const week = String(Math.floor(i / gamesPerWeek) + 1);
    const factor1 = normal(rand, 6);
    const factor2 = normal(rand, 2);
    const sharedNoise = normal(rand, 1.5);
    const eps = normal(rand, 1.5);
    rows.push({
      week_key: week,
      actual_margin: factor1 + factor2 + eps,
      margins: {
        predictive: factor1 + factor2 + normal(rand, 1.5),
        redundant_a: factor1 + sharedNoise,
        redundant_b: factor1 + sharedNoise + normal(rand, 0.2),
        noise1: normal(rand, 8),
        noise2: normal(rand, 8)
      }
    });
  }
  return rows;
}

const ids = ['predictive', 'redundant_a', 'redundant_b', 'noise1', 'noise2'];

/** The formula being replaced, reconstructed here so the comparison is direct. */
function oldExponentialWeights(rows, allIds) {
  const rmse = Object.fromEntries(allIds.map(id => {
    const sq = rows.map(r => (r.margins[id] - r.actual_margin) ** 2);
    return [id, Math.sqrt(sq.reduce((s, v) => s + v, 0) / sq.length)];
  }));
  const raw = Object.fromEntries(allIds.map(id => [id, Math.exp(-0.7 * rmse[id])]));
  const sum = Object.values(raw).reduce((s, v) => s + v, 0);
  return { rmse, weights: Object.fromEntries(allIds.map(id => [id, raw[id] / sum])) };
}

test('KNOWN CASE: the joint regression concentrates weight on the genuinely predictive component and drives independent noise toward zero', () => {
  const rows = redundancyFixture();
  const weights = jointComponentWeights(rows, ids, { key: 'margins', actualKey: 'actual_margin' });
  assert.ok(weights, 'the fixture has far more than the minimum rows for a fit');

  const sum = [...weights.values()].reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `weights should sum to 1, got ${sum}`);

  assert.ok(weights.get('predictive') > 0.45,
    `predictive should hold a plurality of the weight, got ${weights.get('predictive')}`);
  assert.ok(weights.get('noise1') < 0.03 && weights.get('noise2') < 0.03,
    `pure noise unrelated to the target should be driven near zero, got ${weights.get('noise1')}/${weights.get('noise2')}`);
});

test('the old per-component RMSE formula double-counts a redundant pair; the joint regression does not', () => {
  const rows = redundancyFixture();
  const { rmse, weights: oldWeights } = oldExponentialWeights(rows, ids);
  const newWeights = jointComponentWeights(rows, ids, { key: 'margins', actualKey: 'actual_margin' });

  const oldPairShare = oldWeights.redundant_a + oldWeights.redundant_b;
  const newPairShare = newWeights.get('redundant_a') + newWeights.get('redundant_b');

  // The fixture is only meaningful as a test of REDUNDANCY, not merely of
  // accuracy, if redundant_a/b are nearly as accurate standalone as
  // predictive -- the whole point is that a per-component formula cannot
  // distinguish "two independently good signals" from "one good signal
  // photocopied twice" when the copies happen to score similarly alone.
  assert.ok(Math.abs(rmse.redundant_a - rmse.predictive) < 1.5,
    `fixture check: redundant_a's standalone RMSE (${rmse.redundant_a}) should be close to predictive's (${rmse.predictive})`);

  // Because the old formula can only ever look at one component's error at a
  // time, it hands the redundant pair a COMBINED share at least as large as
  // predictive's alone -- purely because there happen to be two near-duplicate
  // copies of essentially the same signal, not because the pair carries twice
  // the information.
  assert.ok(oldPairShare >= oldWeights.predictive,
    `fixture check: the old formula should credit the redundant pair at least as much as predictive alone (pair ${oldPairShare}, predictive ${oldWeights.predictive})`);

  // The joint fit sees both columns at once: once one of them is in the
  // model, the other is almost fully explained by it, and OLS/ridge cannot
  // keep paying full price for both. This is exactly what a per-component
  // formula is structurally unable to do, no matter how its one free
  // constant (-0.7) is tuned -- it is the confirmed defect this fix closes.
  assert.ok(newPairShare < oldPairShare * 0.6,
    `the joint fit should give the redundant pair markedly less combined weight than the old formula did (old ${oldPairShare}, new ${newPairShare})`);
  assert.ok(newWeights.get('predictive') > oldWeights.predictive,
    `predictive's own share should rise once the pair's double-counting is corrected (old ${oldWeights.predictive}, new ${newWeights.get('predictive')})`);
});

test('a component that never produces a value for this target is dropped, not imputed with an undefined mean', () => {
  const rows = redundancyFixture({ n: 400 }).map(r => ({ ...r, margins: { ...r.margins, total_only: null } }));
  const weights = jointComponentWeights(rows, [...ids, 'total_only'], { key: 'margins', actualKey: 'actual_margin' });
  assert.ok(weights, 'still enough rows for a fit');
  assert.equal(weights.get('total_only'), 0);
});

test('a component with partial coverage is mean-imputed from the window\'s own values, not listwise-deleted', () => {
  const rand = mulberry32(99);
  const rows = redundancyFixture({ n: 600 }).map((r, i) => ({
    ...r,
    margins: { ...r.margins, partial: i % 2 === 0 ? r.actual_margin + normal(rand, 1) : null }
  }));
  const covered = rows.filter(r => r.margins.partial != null).length;
  assert.ok(covered > 250 && covered < 350, 'the fixture should actually be half-missing');

  const weights = jointComponentWeights(rows, [...ids, 'partial'], { key: 'margins', actualKey: 'actual_margin' });
  assert.ok(weights, 'a window this size still supports a fit');
  // `partial` is nearly a perfect predictor on the half of rows it covers and
  // silent (imputed to its own column mean) on the other half. Listwise
  // deletion would have thrown out 300 of the design's 600 rows just because
  // ONE column was blank on them -- costing every other component's fit too,
  // the exact failure mode `forecast-combination.js`'s own reduction step
  // documents. Mean-imputing instead should let `partial` still earn real
  // weight rather than being discarded outright.
  assert.ok(weights.get('partial') > 0.05,
    `imputation should preserve usable signal from a half-covered component, got ${weights.get('partial')}`);
});

test('too few rows returns null, matching the old formula\'s implicit all-zero cold start', () => {
  const rows = redundancyFixture({ n: 10 });
  assert.equal(jointComponentWeights(rows, ids, { key: 'margins', actualKey: 'actual_margin' }), null);
});

test('an empty component list, or one with no eligible ids, returns an all-zero map rather than throwing', () => {
  const rows = redundancyFixture({ n: 200 });
  const weights = jointComponentWeights(rows, [], { key: 'margins', actualKey: 'actual_margin' });
  assert.equal(weights.size, 0);
});

test('totals are fit through the same mechanism, independently of margins', () => {
  const rand = mulberry32(7);
  const rows = Array.from({ length: 600 }, (_, i) => {
    const week = String(Math.floor(i / 12) + 1);
    const trueTotal = 44 + normal(rand, 6);
    return {
      week_key: week,
      actual_total: trueTotal,
      totals: {
        good_total: trueTotal + normal(rand, 2),
        bad_total: normal(rand, 10)
      }
    };
  });
  const weights = jointComponentWeights(rows, ['good_total', 'bad_total'],
    { key: 'totals', actualKey: 'actual_total' });
  assert.ok(weights.get('good_total') > 0.8,
    `the genuinely predictive total should dominate, got ${weights.get('good_total')}`);
  assert.ok(weights.get('bad_total') < 0.2);
});
