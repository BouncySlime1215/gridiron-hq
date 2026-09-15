/**
 * Tests for the forecast-combination bake-off.
 *
 * Two kinds of claim are made in this module and they need different proof.
 *
 * The linear algebra claims ("this recovers the weights it was given") are
 * pinned against cases whose answer is known by construction, the way stage 1
 * pinned its eigendecomposition. A combiner that always returns equal weights
 * would pass a single "equal weights work" test, so every recovery test uses a
 * TRUE weight vector that is not equal weights.
 *
 * The comparison claim is different and much more dangerous: a bake-off that
 * quietly mis-states the incumbent produces a flattering number for whatever is
 * being proposed. So the load-bearing test here is the one asserting that
 * `fitIncumbentMarketResidual` reproduces `fitEnsemble`'s own slopes, weights
 * and gate decisions, component for component. If that fails, no other number
 * this module reports means anything.
 *
 * The fixture is synthetic and says nothing about football. It is used here
 * only for claims of the form "these two code paths agree", which are true or
 * false regardless of what data they are fed.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-forecast-combination-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run, rows, dbPath } = await import('../server/db/index.js');
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH,
  'a combination test must never be able to reach the real database');
await (await import('../server/db/migrate.js')).runMigrations();
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const combo = await import('../server/services/forecast-combination.js');
const {
  solveLinear, ols, projectToSimplex, projectToSubSimplex, constrainedLeastSquares,
  componentCoverage, buildBlock, reduceComponents, fitIncumbentMarketResidual,
  coverProbability, scoreForecasts, walkForwardCombination, compareMethods,
  significanceTable, COMBINATION_METHODS
} = combo;

/* ------------------------------------------------------------------ generators */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = rand => {
  let s = 0;
  for (let i = 0; i < 12; i++) s += rand();
  return s - 6;
};

/**
 * Synthetic component records in the shape `componentPredictionStream` yields.
 * `trueWeights` are the weights on the DEPARTURES that actually generate the
 * outcome, so a correct residual-space combiner must recover them.
 */
function syntheticRecords({ n = 900, ids, trueWeights, noise = 8, seed = 7, weeksPerSeason = 17 }) {
  const rand = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const season = 2017 + Math.floor(i / (weeksPerSeason * 8));
    const week = 1 + Math.floor((i % (weeksPerSeason * 8)) / 8);
    const market = normal(rand) * 6;
    const departures = ids.map(() => normal(rand) * 3);
    const signal = departures.reduce((s, d, j) => s + trueWeights[j] * d, 0);
    const actual = market + signal + normal(rand) * noise;
    out.push({
      season, week, week_key: `${season}|${week}`,
      home: `H${i % 16}`, away: `A${i % 16}`,
      market_margin: market, actual_margin: actual,
      margins: Object.fromEntries(ids.map((id, j) => [id, market + departures[j]])),
      totals: {}
    });
  }
  return out;
}

/* ------------------------------------------------------------------ linear algebra */

test('KNOWN CASE: solveLinear reproduces a hand-solvable system', () => {
  const x = solveLinear([[2, 1], [1, 3]], [5, 10]);
  // 2a + b = 5, a + 3b = 10  ->  a = 1, b = 3
  assert.ok(Math.abs(x[0] - 1) < 1e-9, `a was ${x[0]}`);
  assert.ok(Math.abs(x[1] - 3) < 1e-9, `b was ${x[1]}`);
});

test('a singular system returns null rather than a vector of infinities', () => {
  assert.equal(solveLinear([[1, 2], [2, 4]], [3, 6]), null);
});

test('KNOWN CASE: OLS recovers the coefficients that generated noiseless data', () => {
  const rand = mulberry32(11);
  const X = Array.from({ length: 400 }, () => [normal(rand), normal(rand), normal(rand)]);
  const truth = [1.5, -0.75, 0.25], intercept = 2;
  const y = X.map(r => intercept + r[0] * truth[0] + r[1] * truth[1] + r[2] * truth[2]);
  const fit = ols(X, y, { intercept: true });
  assert.ok(Math.abs(fit.intercept - intercept) < 1e-6, `intercept ${fit.intercept}`);
  for (let j = 0; j < truth.length; j++) {
    assert.ok(Math.abs(fit.weights[j] - truth[j]) < 1e-6,
      `weight ${j} was ${fit.weights[j]}, expected ${truth[j]}`);
  }
});

test('KNOWN CASE: simplex projection matches the published worked example', () => {
  // Duchi et al., projection of a point already on the simplex is the identity.
  const onSimplex = [0.2, 0.5, 0.3];
  const same = projectToSimplex(onSimplex);
  for (let j = 0; j < 3; j++) assert.ok(Math.abs(same[j] - onSimplex[j]) < 1e-12);

  // A point off the simplex lands on it: non-negative, sums to one.
  const p = projectToSimplex([3, -1, 0.5]);
  assert.ok(p.every(v => v >= -1e-12), `negative weight in ${JSON.stringify(p)}`);
  assert.ok(Math.abs(p.reduce((s, v) => s + v, 0) - 1) < 1e-12);
  // The largest input must still carry the largest weight.
  assert.equal(p.indexOf(Math.max(...p)), 0);
});

test('the sub-simplex contains the origin, so "stay on the market" stays reachable', () => {
  // This is the property that distinguishes it from the simplex, and the reason
  // the residual-space combiner uses it: a simplex projection of an
  // all-negative vector is forced to sum to 1 and would move the line hard.
  const zero = projectToSubSimplex([-2, -0.5, -3]);
  assert.deepEqual(zero, [0, 0, 0]);
  const onSimplexInstead = projectToSimplex([-2, -0.5, -3]);
  assert.ok(Math.abs(onSimplexInstead.reduce((s, v) => s + v, 0) - 1) < 1e-12);

  // Inside the budget it is a plain clip; outside it, it falls back to the simplex.
  assert.deepEqual(projectToSubSimplex([0.3, -0.1, 0.2]), [0.3, 0, 0.2]);
  const over = projectToSubSimplex([0.9, 0.8, 0.7]);
  assert.ok(Math.abs(over.reduce((s, v) => s + v, 0) - 1) < 1e-9);
});

test('KNOWN CASE: constrained least squares recovers a convex combination it was given', () => {
  const rand = mulberry32(23);
  const truth = [0.6, 0.1, 0.3];   // deliberately NOT equal weights
  const X = Array.from({ length: 1200 }, () => [normal(rand) * 4, normal(rand) * 4, normal(rand) * 4]);
  const y = X.map(r => r.reduce((s, v, j) => s + truth[j] * v, 0) + normal(rand) * 0.4);
  const w = constrainedLeastSquares(X, y);
  assert.ok(Math.abs(w.reduce((s, v) => s + v, 0) - 1) < 1e-6, `weights summed to ${w.reduce((s, v) => s + v, 0)}`);
  assert.ok(w.every(v => v >= -1e-9));
  for (let j = 0; j < truth.length; j++) {
    assert.ok(Math.abs(w[j] - truth[j]) < 0.05,
      `weight ${j} was ${w[j].toFixed(4)}, expected about ${truth[j]}`);
  }
});

/* ------------------------------------------------------------------ block building */

test('listwise deletion drops the row, and says how many', () => {
  const records = [
    { season: 2020, week: 1, week_key: '2020|1', home: 'A', away: 'B', market_margin: 1, actual_margin: 3, margins: { a: 2, b: 4 } },
    { season: 2020, week: 1, week_key: '2020|1', home: 'C', away: 'D', market_margin: 1, actual_margin: 3, margins: { a: 2, b: null } },
    { season: 2020, week: 1, week_key: '2020|1', home: 'E', away: 'F', market_margin: null, actual_margin: 3, margins: { a: 2, b: 4 } }
  ];
  const strict = buildBlock(records, ['a', 'b']);
  assert.equal(strict.rows.length, 1);
  assert.equal(strict.dropped, 2);

  // The missing-tolerant build keeps the partially-observed row, because the
  // incumbent and the all-component average both handle it in production.
  const lenient = buildBlock(records, ['a', 'b'], { allowMissing: true });
  assert.equal(lenient.rows.length, 2);
  assert.equal(lenient.rows[1].forecasts[1], null);
  assert.equal(lenient.rows[1].departures[1], null);
});

test('departures are forecasts measured against the market, and the identity holds', () => {
  const records = [{ season: 2020, week: 1, week_key: '2020|1', home: 'A', away: 'B',
    market_margin: -3.5, actual_margin: 7, margins: { a: 1.5, b: -6 } }];
  const { rows } = buildBlock(records, ['a', 'b']);
  assert.deepEqual(rows[0].departures, [5, -2.5]);
  assert.equal(rows[0].marketResidual, 10.5);
});

test('equal weighting of forecasts IS the market plus the mean departure', () => {
  // Not a tautology worth skipping: it is the reason `market_anchored_combination`
  // is exactly the shrunk version of `equal_weight`, which is how the two are
  // meant to be read against each other in the report.
  const records = syntheticRecords({ n: 40, ids: ['a', 'b', 'c'], trueWeights: [0.3, 0.2, 0.1], seed: 3 });
  const block = buildBlock(records, ['a', 'b', 'c']);
  for (const row of block.rows) {
    const equal = row.forecasts.reduce((s, f) => s + f, 0) / 3;
    const viaDepartures = row.market + row.departures.reduce((s, d) => s + d, 0) / 3;
    assert.ok(Math.abs(equal - viaDepartures) < 1e-9);
  }
});

test('coverage is measured against rows the component could have scored', () => {
  const records = [
    { season: 2020, week: 1, week_key: '2020|1', home: 'A', away: 'B', market_margin: 1, actual_margin: 3, margins: { a: 2, b: 4 } },
    { season: 2020, week: 1, week_key: '2020|1', home: 'C', away: 'D', market_margin: 1, actual_margin: 3, margins: { a: 2, b: null } },
    // No market quote: this row is unscoreable for everyone and must not be
    // counted against `b`'s coverage.
    { season: 2020, week: 1, week_key: '2020|1', home: 'E', away: 'F', market_margin: null, actual_margin: 3, margins: { a: 2, b: null } }
  ];
  const { coverage, rows } = componentCoverage(records, ['a', 'b']);
  assert.equal(rows, 2);
  assert.equal(coverage.get('a'), 1);
  assert.equal(coverage.get('b'), 0.5);
});

/* ------------------------------------------------------------------ recovery */

test('KNOWN CASE: the residual-space combiner recovers weights that are not equal weights', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const truth = [0.5, 0.0, 0.25, 0.0];
  const records = syntheticRecords({ n: 4000, ids, trueWeights: truth, noise: 6, seed: 91 });
  const block = buildBlock(records, ids);
  const fit = COMBINATION_METHODS.residual_ols.fit(block, {});
  for (let j = 0; j < ids.length; j++) {
    assert.ok(Math.abs(fit.weights[j] - truth[j]) < 0.06,
      `weight for ${ids[j]} was ${fit.weights[j].toFixed(4)}, expected about ${truth[j]}`);
  }
  // And a combiner that merely returned equal weights would fail this: the
  // truth here sums to 0.75, not 1, and two of its four entries are zero.
  const equalish = fit.weights.every(w => Math.abs(w - 0.25) < 0.06);
  assert.equal(equalish, false, 'the fit is indistinguishable from equal weights');
});

test('the constrained residual combiner respects its budget and its sign restriction', () => {
  const ids = ['a', 'b', 'c'];
  // A truth that a *simplex* constraint could not represent: it sums to 0.4.
  const records = syntheticRecords({ n: 3000, ids, trueWeights: [0.3, 0.1, 0], noise: 5, seed: 31 });
  const block = buildBlock(records, ids);
  const fit = COMBINATION_METHODS.residual_constrained.fit(block, {});
  assert.ok(fit.weights.every(w => w >= -1e-9), `negative weight in ${JSON.stringify(fit.weights)}`);
  const sum = fit.weights.reduce((s, w) => s + w, 0);
  assert.ok(sum <= 1 + 1e-6, `budget exceeded: ${sum}`);
  assert.ok(Math.abs(sum - 0.4) < 0.1, `total movement ${sum.toFixed(3)}, expected about 0.4`);
});

test('inverse-MSE weighting prefers the component with the lower error, in proportion', () => {
  const ids = ['sharp', 'blunt'];
  const rand = mulberry32(5);
  const records = Array.from({ length: 2000 }, (_, i) => {
    const market = normal(rand) * 5;
    const actual = market + normal(rand) * 3;
    return {
      season: 2017 + Math.floor(i / 800), week: 1 + (i % 17), week_key: `${2017 + Math.floor(i / 800)}|${1 + (i % 17)}`,
      home: `H${i}`, away: `A${i}`, market_margin: market, actual_margin: actual,
      // `sharp` sits 1 point from the outcome, `blunt` sits 2 points away, so
      // their MSEs are about 1 and 4 and the weights should be about 0.8/0.2.
      margins: { sharp: actual + (i % 2 ? 1 : -1), blunt: actual + (i % 2 ? 2 : -2) }
    };
  });
  const block = buildBlock(records, ids);
  const fit = COMBINATION_METHODS.inverse_mse.fit(block, {});
  assert.ok(Math.abs(fit.weights[0] - 0.8) < 0.02, `sharp weight ${fit.weights[0]}`);
  assert.ok(Math.abs(fit.weights[1] - 0.2) < 0.02, `blunt weight ${fit.weights[1]}`);
});

/* ------------------------------------------------------------------ scoring */

test('cover probability reads off the empirical error distribution, ties split', () => {
  const errors = [-2, -1, 0, 1, 2];
  // forecast == market: P(e > 0) = 2/5, plus half the tie at 0 = 0.5.
  assert.equal(coverProbability(errors, 0, 0), 0.5);
  // A forecast 2 points above the market needs e > -2 : 4/5 plus half a tie.
  assert.equal(coverProbability(errors, 2, 0), 0.9);
  assert.equal(coverProbability([], 0, 0), null);
});

test('cover-Brier excludes pushes rather than scoring them as a loss', () => {
  const preds = [
    { forecast: 1, actual: 3, market: 0, cover_outcome: 1, cover_probability: 0.6 },
    { forecast: 1, actual: -3, market: 0, cover_outcome: 0, cover_probability: 0.6 },
    { forecast: 1, actual: 0, market: 0, cover_outcome: null, cover_probability: 0.6 }
  ];
  const s = scoreForecasts(preds);
  assert.equal(s.n, 3);
  assert.equal(s.cover_n, 2, 'the push must not be graded');
  assert.equal(s.cover_brier, +(((0.6 - 1) ** 2 + (0.6 - 0) ** 2) / 2).toFixed(5));
});

/* ------------------------------------------------------------------ leakage */

test('season cadence: making the whole held-out season an oracle changes no fit', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const records = syntheticRecords({ n: 1600, ids, trueWeights: [0.4, 0, 0.2, 0, 0], seed: 77 });
  const testSeason = Math.max(...records.map(r => r.season));
  const opts = { componentIdList: ids, testSeasons: [testSeason], refit: 'season',
    reduction: { maxComponents: 3 } };

  const clean = walkForwardCombination({ records, ...opts });
  // Turn component `e` into a perfect oracle, but ONLY on the held-out season.
  // If any part of the fit could see that season, `e` would be selected and
  // would dominate everything. It must not be.
  const poisoned = records.map(r => (r.season !== testSeason ? r : {
    ...r, margins: { ...r.margins, e: r.actual_margin }
  }));
  const after = walkForwardCombination({ records: poisoned, ...opts });
  assert.deepEqual(after.seasons[0].reduced_ids, clean.seasons[0].reduced_ids,
    'the chosen basis changed when only the HELD-OUT season changed');
  for (const name of clean.methods) {
    assert.deepEqual(clean.seasons[0].methods[name].fit_summary,
      after.seasons[0].methods[name].fit_summary,
      `${name} fitted different parameters when only the held-out season changed`);
  }
});

test('week cadence: an oracle appearing in week 9 cannot improve weeks 1 to 8', () => {
  // The stronger property, and the one the default cadence needs. Weekly refit
  // means earlier weeks of the test season ARE legitimately in the training
  // block for later weeks, so the season-wide check above would rightly fail
  // here. What must hold instead is the causal version: nothing at or after a
  // cutoff may change a forecast made at that cutoff.
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const records = syntheticRecords({ n: 2400, ids, trueWeights: [0.4, 0, 0.2, 0, 0], seed: 78 });
  const testSeason = Math.max(...records.map(r => r.season));
  const FROM_WEEK = 9;
  const opts = { componentIdList: ids, testSeasons: [testSeason], refit: 'week',
    reduction: { maxComponents: 3 } };

  const clean = walkForwardCombination({ records, ...opts });
  const poisoned = records.map(r =>
    (r.season === testSeason && r.week >= FROM_WEEK
      ? { ...r, margins: { ...r.margins, e: r.actual_margin } } : r));
  const after = walkForwardCombination({ records: poisoned, ...opts });

  let checked = 0;
  for (const name of clean.methods) {
    const key = p => `${p.season}|${p.week}|${p.home}|${p.away}`;
    const b = new Map(after.predictions.get(name).map(p => [key(p), p]));
    for (const p of clean.predictions.get(name)) {
      if (p.week >= FROM_WEEK) continue;
      const q = b.get(key(p));
      assert.ok(q, `${name} lost a forecast for ${key(p)}`);
      assert.equal(q.forecast, p.forecast,
        `${name} changed its week-${p.week} forecast after week ${FROM_WEEK} was poisoned`);
      checked++;
    }
  }
  assert.ok(checked > 100, `only ${checked} pre-cutoff forecasts were checked`);
});

test('a season with too little history before it is skipped, not fitted on nothing', () => {
  const ids = ['a', 'b', 'c'];
  const records = syntheticRecords({ n: 300, ids, trueWeights: [0.3, 0.2, 0.1], seed: 13 });
  const first = Math.min(...records.map(r => r.season));
  const out = walkForwardCombination({ records, componentIdList: ids, testSeasons: [first] });
  assert.ok(out.seasons[0].skipped, 'the first season has no prior history and must be skipped');
});

/* ------------------------------------------------------------------ significance */

test('DM gating: an identical forecast is refused, not declared a tie with a p-value', () => {
  const ids = ['a', 'b', 'c'];
  const records = syntheticRecords({ n: 1600, ids, trueWeights: [0.3, 0.2, 0.1], seed: 44 });
  const seasons = [...new Set(records.map(r => r.season))].sort();
  const out = walkForwardCombination({ records, componentIdList: ids, testSeasons: seasons.slice(-1) });
  const self = compareMethods(out.predictions, 'equal_weight', 'equal_weight');
  assert.equal(self.ok, false);
  assert.match(self.dm.reason, /zero variance/);
});

test('the comparison pairs by game, not by position in the array', () => {
  // Two methods can survive listwise deletion on different subsets. A
  // positional pairing would then compare method A on game 5 against method B
  // on game 6 and report a confident, meaningless statistic.
  const mk = (season, week, home, forecast, actual) =>
    ({ season, week, home, away: 'X', forecast, actual });
  const preds = new Map([
    ['a', [mk(2024, 1, 'H1', 1, 3), mk(2024, 1, 'H2', 2, 4), mk(2024, 2, 'H3', 3, 5)]],
    // `b` is missing H2 entirely, and its remaining rows are in a different order.
    ['b', [mk(2024, 2, 'H3', 9, 5), mk(2024, 1, 'H1', 1, 3)]]
  ]);
  const c = compareMethods(preds, 'a', 'b', { cluster: false });
  assert.equal(c.shared_games, 2, 'only the two games both methods scored may be compared');
});

test('significanceTable names the winner and says whether it beat equal weighting', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const records = syntheticRecords({ n: 2400, ids, trueWeights: [0.5, 0, 0.3, 0], noise: 5, seed: 61 });
  const seasons = [...new Set(records.map(r => r.season))].sort().slice(-2);
  const out = walkForwardCombination({ records, componentIdList: ids, testSeasons: seasons });
  const table = significanceTable(out);
  assert.ok(table.ranking.length > 1);
  // Ranked by RMSE ascending.
  for (let i = 1; i < table.ranking.length; i++) {
    assert.ok(table.ranking[i].rmse >= table.ranking[i - 1].rmse);
  }
  assert.equal(table.best_by_rmse, table.ranking[0].method);
  for (const row of table.vs_baseline) {
    assert.equal(row.baseline, 'incumbent_market_residual');
    if (row.dm_statistic != null) {
      // A method cannot be simultaneously better and worse.
      assert.equal(row.significantly_better && row.significantly_worse, false);
    }
  }
});

test('KNOWN CASE: where real signal exists, the bake-off finds it and DM confirms it', () => {
  // The control that makes a null result elsewhere meaningful. Here the market
  // is genuinely beatable by construction, so a correct pipeline MUST report a
  // combination beating the market-only baseline at conventional significance.
  // If this test ever fails, a "nothing beat the market" finding on real data
  // is uninterpretable, because the machinery cannot detect signal at all.
  const ids = ['a', 'b', 'c', 'd'];
  const records = syntheticRecords({ n: 4000, ids, trueWeights: [0.6, 0, 0.4, 0], noise: 4, seed: 101 });
  const seasons = [...new Set(records.map(r => r.season))].sort().slice(-2);
  const out = walkForwardCombination({ records, componentIdList: ids, testSeasons: seasons });
  const c = compareMethods(out.predictions, 'residual_ols', 'market_only');
  assert.ok(c.ok, `DM could not run: ${c.reason ?? c.dm?.reason}`);
  assert.ok(c.dm.statistic < 0, `the combiner should be more accurate, DM* was ${c.dm.statistic}`);
  assert.ok(c.dm.pLess < 0.01, `p was ${c.dm.pLess}`);
  assert.ok(out.pooled.residual_ols.rmse < out.pooled.market_only.rmse);
});

test('KNOWN CASE: where no signal exists, the bake-off does NOT manufacture one', () => {
  // The other half of the control. Every departure is pure noise, so no
  // combination can beat the market and none may be reported as doing so.
  const ids = ['a', 'b', 'c', 'd'];
  const records = syntheticRecords({ n: 4000, ids, trueWeights: [0, 0, 0, 0], noise: 9, seed: 202 });
  const seasons = [...new Set(records.map(r => r.season))].sort().slice(-2);
  const out = walkForwardCombination({ records, componentIdList: ids, testSeasons: seasons });
  for (const name of out.methods) {
    if (name === 'market_only') continue;
    const c = compareMethods(out.predictions, name, 'market_only');
    if (!c.ok) continue;
    assert.ok(c.dm.pLess > 0.01,
      `${name} was reported as beating the market at p=${c.dm.pLess} on pure noise`);
  }
});

/* ---------------------------------------------- the incumbent really is the incumbent */

test('LOAD-BEARING: the replayed incumbent reproduces fitEnsemble exactly', async () => {
  const { seedEnsembleFixture } = await import('./helpers/seed-ensemble-fixture.js');
  seedEnsembleFixture({ run, rows }, { latentFactors: 3, noise: 0.35 });
  const ensemble = await import('../server/services/nfl-ensemble.js');

  const CUTOFF = 2023;   // at or after the 2022 calibration boundary, so the
                         // single replay pass below sees the same calibration
                         // fitEnsemble sees at this cutoff.
  const inputs = ensemble.ensembleReplayInputs({});
  const records = [...ensemble.componentPredictionStream({ ...inputs })];
  const train = records.filter(r => r.season < CUTOFF);
  assert.ok(train.length > 300, `only ${train.length} training rows`);

  const catalog = ensemble.componentIds().map(c => c.id);
  const mine = fitIncumbentMarketResidual(train, catalog);
  const theirs = ensemble.fitEnsemble({ beforeSeason: CUTOFF, beforeWeek: 1, includeChallengers: true });
  assert.ok(!theirs.error, theirs.error);

  let compared = 0;
  for (const m of mine.models) {
    const t = theirs.models.find(x => x.id === m.id);
    assert.ok(t, `fitEnsemble has no component ${m.id}`);
    if (t.residual_n === 0 && m.residual_n === 0) continue;
    compared++;
    assert.equal(m.residual_n, t.residual_n, `${m.id}: out-of-fold row count`);
    assert.equal(m.residual_fit_n, t.residual_fit_n, `${m.id}: fit-block row count`);
    assert.equal(m.residual_slope, t.residual_slope, `${m.id}: slope`);
    assert.equal(m.residual_rmse, t.residual_rmse, `${m.id}: residual RMSE`);
    assert.equal(m.residual_rmse_gain, t.residual_rmse_gain, `${m.id}: RMSE gain`);
    // The superseded statistic, reproduced alongside for audit continuity --
    // never the thing either gate reads.
    assert.equal(m.residual_paired_t, t.residual_paired_t, `${m.id}: legacy paired t`);
    // The statistic the gate ACTUALLY reads post-FIX #2: DM/HLN, clustered by
    // week. Asserting these too is what makes this test load-bearing again --
    // before the 2026-09-15 fix, `gate_passed` was computed from the naive
    // paired t while `fitEnsemble` had already moved to DM, and this test
    // passed only because the two statistics happened to agree on every
    // component in this fixture, not because the code paths matched.
    assert.equal(m.residual_dm_t, t.residual_dm_t, `${m.id}: DM statistic`);
    assert.equal(m.residual_dm_p, t.residual_dm_p, `${m.id}: DM p-value`);
    assert.equal(m.residual_dm_ok, t.residual_dm_ok, `${m.id}: DM computability`);
    assert.equal(m.gate_passed, t.residual_gate_passed, `${m.id}: gate decision`);
    assert.equal(m.residual_weight, t.residual_weight, `${m.id}: blend weight`);
  }
  assert.ok(compared >= 20, `only ${compared} components were actually compared`);
});

test('the incumbent gate reads Diebold-Mariano, not the fixed -1.645 paired-t critical value', () => {
  // A component built so the naive paired t and DM disagree: its departure
  // from the market is CONSTANT (so its point forecast does not itself track
  // anything week-specific), but the outcome it is graded against carries a
  // large shared per-week shock (every game on a slate moving together --
  // shared market state, injury news, weather). That shared shock makes the
  // loss differential nearly identical within a week, so the naive paired t
  // -- which divides by sqrt(GAMES) -- overstates precision exactly the way
  // this file's and forecast-comparison.js's own comments describe. DM
  // -- which divides by sqrt(WEEKS) -- is not fooled by it. If `gate_passed`
  // ever again reads the naive statistic instead of DM, this is the case
  // where it would show.
  const rand = mulberry32(6);
  const ids = ['a'];
  const records = [];
  const TOTAL_WEEKS = 75, GAMES_PER_WEEK = 14, TRUE_EDGE = 0.05, WEEK_EFFECT_MAG = 4, NOISE_SD = 6;
  let season = 2020, week = 1;
  for (let w = 0; w < TOTAL_WEEKS; w++) {
    const weekEffect = (rand() < 0.5 ? -1 : 1) * WEEK_EFFECT_MAG;
    for (let g = 0; g < GAMES_PER_WEEK; g++) {
      const actual = TRUE_EDGE + weekEffect + normal(rand) * NOISE_SD; // market = 0
      records.push({
        season, week, week_key: `${season}|${week}`, home: `H${w}_${g}`, away: `A${w}_${g}`,
        market_margin: 0, actual_margin: actual,
        margins: { a: 1 } // constant departure: the point forecast never sees weekEffect
      });
    }
    week++;
    if (week > 18) { week = 1; season++; }
  }
  const fit = fitIncumbentMarketResidual(records, ids);
  const m = fit.models[0];
  assert.ok(m.residual_n >= 250, `only ${m.residual_n} out-of-fold rows`);
  assert.ok(m.residual_rmse_gain >= 0.03, `RMSE gain too small: ${m.residual_rmse_gain}`);
  assert.ok(m.residual_dm_ok, 'DM should be computable on this fixture');
  // The construction is chosen so the naive paired t clears -1.645 while DM's
  // p-value does not clear 0.05 -- i.e. the superseded rule would have gated
  // this component in, and the corrected rule (correctly) does not.
  assert.ok(m.residual_paired_t <= -1.645,
    `fixture did not produce the intended naive-t pass (got ${m.residual_paired_t})`);
  assert.ok(m.residual_dm_p > 0.05,
    `fixture did not produce the intended DM fail (got p=${m.residual_dm_p})`);
  assert.equal(m.gate_passed, false,
    'gate_passed followed the naive paired t instead of DM');
});

test('when nothing clears the incumbent gate, the incumbent IS the market, and says so', () => {
  const ids = ['a', 'b', 'c'];
  // Pure noise departures: no component can clear a gate that demands a real
  // out-of-fold RMSE gain.
  const records = syntheticRecords({ n: 2000, ids, trueWeights: [0, 0, 0], noise: 9, seed: 303 });
  const fit = fitIncumbentMarketResidual(records, ids);
  assert.equal(fit.collapses_to_market, true);
  const block = buildBlock(records, ids);
  for (const row of block.rows.slice(0, 50)) {
    assert.equal(COMBINATION_METHODS.incumbent_market_residual.predict(fit, row, ids), row.market);
  }
});

test('a component abstaining on one game renormalises the incumbent, not shrinks it', () => {
  // Production drops an abstaining component and renormalises over the rest. If
  // the replay instead treated the missing forecast as a zero departure, the
  // incumbent would be quietly pulled toward the market on exactly the games
  // where a component is missing, and its RMSE here would not be its RMSE.
  const fit = {
    method: 'incumbent_market_residual',
    models: [
      { id: 'a', residual_slope: 0.5, residual_weight: 0.5, gate_passed: true },
      { id: 'b', residual_slope: 0.5, residual_weight: 0.5, gate_passed: true }
    ],
    gated: ['a', 'b'], collapses_to_market: false
  };
  const row = { market: 0, forecasts: [4, null], actual: 0 };
  const predict = COMBINATION_METHODS.incumbent_market_residual.predict;
  // Only `a` is present: 0 + (0.5 * 0.5 * 4) / 0.5 = 2, not 1.
  assert.equal(predict(fit, row, ['a', 'b']), 2);
  assert.equal(predict(fit, { market: 0, forecasts: [4, 4] }, ['a', 'b']), 2);
  assert.equal(predict(fit, { market: 3, forecasts: [null, null] }, ['a', 'b']), 3);
});

test('the skill screen changes which components compete, and is reported', () => {
  const ids = ['useful', 'useless_1', 'useless_2', 'useless_3'];
  // Only `useful` carries signal; the rest are independent noise, which the
  // pure-independence basis will happily select because noise IS independent.
  const records = syntheticRecords({ n: 3000, ids, trueWeights: [0.6, 0, 0, 0], noise: 5, seed: 404 });
  const plain = reduceComponents(records, { candidateIds: ids, maxComponents: 2, skillScreen: 'none' });
  const screened = reduceComponents(records, { candidateIds: ids, maxComponents: 2, skillScreen: 'top_n', skillTopN: 2 });
  assert.equal(plain.skill_screen, null);
  assert.ok(screened.skill_screen, 'the screen must be reported, not applied silently');
  assert.equal(screened.skill_screen.rule, 'top_n');
  assert.ok(screened.skill_screen.top[0].id === 'useful',
    `the screen ranked ${screened.skill_screen.top[0].id} above the only component with signal`);
  assert.ok(screened.selected.includes('useful'));
});
