/**
 * Tests for the ensemble component-rank diagnostic.
 *
 * A diagnostic whose only output is a number nobody can check is worse than no
 * diagnostic: it launders an assumption into a measurement. So the linear
 * algebra here is pinned against cases whose answer is known by construction —
 * a matrix built from exactly K latent factors must report an effective rank
 * near K, a duplicated column must report redundancy 1, an orthogonal set must
 * report rank equal to its width — and the end-to-end run is exercised on the
 * deterministic fixture whose latent factor count this file chooses.
 *
 * The fixture run proves the PIPELINE works. It says nothing about real
 * football, and the assertions below are careful never to imply otherwise.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-ensemble-rank-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'fixture.sqlite');
process.env.SCHEDULER_DISABLED = '1';
const { db, run, dbPath } = await import('../server/db/index.js');
assert.equal(dbPath, process.env.GRIDIRON_DB_PATH,
  'a diagnostic test must never be able to reach the real database');
await (await import('../server/db/migrate.js')).runMigrations();
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const rank = await import('../server/services/nfl-ensemble-rank.js');
const { symmetricEigen, spectrumMetrics, correlationMatrix, redundancy,
  multipleR2, buildMatrix, pearson, regress, inverse } = rank;

/* --------------------------------------------------- deterministic generators */

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

/** `p` columns built from `k` shared latent factors plus per-column noise. */
function latentColumns({ p, k, n, noise, seed }) {
  const rand = mulberry32(seed);
  const loadings = Array.from({ length: p }, () => Array.from({ length: k }, () => normal(rand)));
  const factors = Array.from({ length: n }, () => Array.from({ length: k }, () => normal(rand)));
  return Array.from({ length: p }, (_, j) =>
    Array.from({ length: n }, (_, i) => {
      let v = 0;
      for (let f = 0; f < k; f++) v += loadings[j][f] * factors[i][f];
      return v / Math.sqrt(k) + noise * normal(rand);
    }));
}

/* ------------------------------------------------------------ linear algebra */

test('the eigensolver reproduces a decomposition that is known by hand', () => {
  // [[2,1],[1,2]] has eigenvalues 3 and 1 with eigenvectors (1,1) and (1,-1).
  const e = symmetricEigen([[2, 1], [1, 2]]);
  assert.ok(Math.abs(e.values[0] - 3) < 1e-9, `${e.values[0]}`);
  assert.ok(Math.abs(e.values[1] - 1) < 1e-9, `${e.values[1]}`);
  const v0 = e.vectors[0];
  assert.ok(Math.abs(Math.abs(v0[0]) - Math.abs(v0[1])) < 1e-9, 'first eigenvector is (1,1)/sqrt2');
  assert.ok(v0[0] * v0[1] > 0, 'and both entries share a sign');
});

test('eigenvalues of a correlation matrix sum to its width, which is what makes the rank metrics comparable', () => {
  const cols = latentColumns({ p: 9, k: 3, n: 600, noise: 0.4, seed: 11 });
  const e = symmetricEigen(correlationMatrix(cols));
  const total = e.values.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - 9) < 1e-6, `trace should be 9, got ${total}`);
  assert.ok(e.values.every((v, i) => i === 0 || v <= e.values[i - 1] + 1e-12), 'sorted descending');
});

test('an orthogonal set reports effective rank equal to its width — the diagnostic does not manufacture redundancy', () => {
  // Independent noise columns: the correlation matrix is the identity in
  // expectation, so every rank metric must land near p.
  const rand = mulberry32(7);
  const cols = Array.from({ length: 8 }, () => Array.from({ length: 4000 }, () => normal(rand)));
  const s = spectrumMetrics(symmetricEigen(correlationMatrix(cols)).values);
  assert.ok(s.participation_ratio > 7.5, `participation ratio ${s.participation_ratio} should be near 8`);
  assert.ok(s.entropy_rank > 7.5, `entropy rank ${s.entropy_rank} should be near 8`);
  assert.ok(s.components_for_95pct >= 7, `${s.components_for_95pct}`);
});

test('a matrix built from exactly three latent factors reports an effective rank near three', () => {
  // The load-bearing case: twenty-four columns, three hidden causes, modest
  // per-column noise. If the diagnostic cannot recover three here it cannot be
  // trusted to recover the real answer anywhere.
  const cols = latentColumns({ p: 24, k: 3, n: 3000, noise: 0.30, seed: 2026 });
  const s = spectrumMetrics(symmetricEigen(correlationMatrix(cols)).values);
  assert.ok(s.participation_ratio > 2.2 && s.participation_ratio < 4.2,
    `participation ratio ${s.participation_ratio} should sit near the 3 latent factors`);
  assert.equal(s.components_for_90pct, 3, 'three PCs carry ninety per cent of the variance');
  assert.ok(s.kaiser_count <= 4, `${s.kaiser_count}`);
});

test('the same twenty-four columns with eight latent factors report a rank near eight, not near three', () => {
  // The previous test would also pass if the code simply always answered "3".
  const cols = latentColumns({ p: 24, k: 8, n: 3000, noise: 0.30, seed: 4711 });
  const s = spectrumMetrics(symmetricEigen(correlationMatrix(cols)).values);
  assert.ok(s.participation_ratio > 5, `participation ratio ${s.participation_ratio} should be well above 3`);
  assert.ok(s.components_for_90pct >= 7, `${s.components_for_90pct} PCs for ninety per cent`);
});

test('participation ratio is stricter than entropy rank when one direction dominates', () => {
  const cols = latentColumns({ p: 12, k: 1, n: 2000, noise: 0.45, seed: 99 });
  const s = spectrumMetrics(symmetricEigen(correlationMatrix(cols)).values);
  assert.ok(s.participation_ratio < s.entropy_rank,
    'a long tail of small directions inflates entropy rank but not the participation ratio');
  assert.ok(s.top_eigenvalue_share > 0.4, `${s.top_eigenvalue_share}`);
});

/* ---------------------------------------------------------------- redundancy */

test('a duplicated component reports essentially no unique variance, and names its twin', () => {
  const base = latentColumns({ p: 4, k: 3, n: 1500, noise: 0.5, seed: 31 });
  const cols = [...base, base[1].map(v => v * 2 + 3)];   // an exact affine copy
  const ids = ['a', 'b', 'c', 'd', 'b_copy'];
  const red = redundancy(ids, correlationMatrix(cols));
  const copy = red.find(r => r.id === 'b_copy');
  assert.ok(copy.r2_vs_all_others > 0.999, `${copy.r2_vs_all_others}`);
  assert.equal(copy.closest_component, 'b');
  assert.ok(Math.abs(copy.closest_correlation - 1) < 1e-6);
});

test('redundancy catches a component that is a combination of three others while correlating only moderately with each', () => {
  // The case pairwise correlation misses entirely, and the reason this uses the
  // variance-inflation identity rather than a max-|r| screen. The three bases
  // are mutually independent, so their sum correlates only ~1/sqrt(3) with any
  // one of them while being perfectly determined by all three together.
  const rand = mulberry32(5);
  const base = Array.from({ length: 3 }, () => Array.from({ length: 2000 }, () => normal(rand)));
  const combo = base[0].map((_, i) => base[0][i] + base[1][i] + base[2][i]);
  const ids = ['x', 'y', 'z', 'sum'];
  const corr = correlationMatrix([...base, combo]);
  const red = redundancy(ids, corr);
  const sum = red.find(r => r.id === 'sum');
  assert.ok(sum.r2_vs_all_others > 0.99, `${sum.r2_vs_all_others} — the sum is fully explained`);
  assert.ok(Math.abs(sum.closest_correlation) < 0.75,
    `its strongest pairwise correlation is only ${sum.closest_correlation}, which a max-|r| screen would clear ` +
    'even though the component carries no information of its own');
});

test('multiple R2 against no predictors is zero, and against a perfect copy is one', () => {
  const cols = latentColumns({ p: 3, k: 2, n: 800, noise: 0.3, seed: 13 });
  const corr = correlationMatrix([...cols, cols[0]]);
  assert.equal(multipleR2(corr, 0, []), 0);
  assert.ok(multipleR2(corr, 0, [3]) > 0.999);
});

test('an independent component keeps most of its variance to itself', () => {
  // Five near-copies of one hidden factor (explicit unit loadings, so no column
  // is accidentally mostly noise) plus one genuine outsider.
  const rand = mulberry32(777);
  const factor = Array.from({ length: 2000 }, () => normal(rand));
  const shared = Array.from({ length: 5 }, () => factor.map(v => v + 0.2 * normal(rand)));
  const loner = Array.from({ length: 2000 }, () => normal(rand));
  const red = redundancy(['a', 'b', 'c', 'd', 'e', 'loner'], correlationMatrix([...shared, loner]));
  const l = red.find(r => r.id === 'loner');
  assert.ok(l.unique_variance > 0.9, `${l.unique_variance}`);
  const a = red.find(r => r.id === 'a');
  assert.ok(a.unique_variance < 0.5, `a correlated member keeps little unique variance, got ${a.unique_variance}`);
});

/* ------------------------------------------------------- matrix construction */

test('listwise deletion is applied and the cost of it is reported rather than hidden', () => {
  const records = Array.from({ length: 500 }, (_, i) => ({
    week_key: `2020|${i % 17 + 1}`,
    values: { always: i, sometimes: i % 2 ? i * 2 : null, never: null }
  }));
  const m = buildMatrix(records, { minRows: 100 });
  assert.deepEqual(m.ids.sort(), ['always', 'sometimes']);
  assert.equal(m.rows_total, 500);
  assert.equal(m.rows_complete, 250, 'rows where a selected column abstained are dropped for everyone');
  assert.ok(m.dropped.some(d => d.id === 'never'), 'and the abstainer is named');
});

test('a constant column is dropped by name rather than poisoning every eigenvalue with a NaN', () => {
  const records = Array.from({ length: 400 }, (_, i) => ({
    week_key: '2020|1', values: { varies: i, flat: 3 }
  }));
  const m = buildMatrix(records, { minRows: 10 });
  assert.deepEqual(m.ids, ['varies']);
  assert.ok(m.dropped.some(d => d.id === 'flat' && /constant/.test(d.reason)));
});

test('pearson and the OLS helper agree with hand-computable cases', () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-12);
  assert.equal(pearson([1, 1, 1, 1], [1, 2, 3, 4]), null, 'no variance means no correlation, not zero');
  const fit = regress([1, 2, 3, 4], [3, 5, 7, 9]);   // y = 2x + 1
  assert.ok(Math.abs(fit.b1 - 2) < 1e-12 && Math.abs(fit.b0 - 1) < 1e-12);
});

test('the inverse helper actually inverts', () => {
  const m = [[4, 1], [1, 3]];
  const inv = inverse(m, 0);
  const product = [[0, 0], [0, 0]];
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    for (let k = 0; k < 2; k++) product[i][j] += m[i][k] * inv[k][j];
  }
  assert.ok(Math.abs(product[0][0] - 1) < 1e-12 && Math.abs(product[0][1]) < 1e-12);
});

/* --------------------------------------------------------------- end to end */

test('the full report runs on the ensemble\'s own walk-forward stream and recovers the fixture\'s latent rank', async () => {
  const { seedEnsembleFixture } = await import('./helpers/seed-ensemble-fixture.js');
  const meta = seedEnsembleFixture({ run }, { latentFactors: 3, noise: 0.35 });
  assert.equal(meta.latent_factors, 3);

  const report = rank.componentRankReport({ beforeSeason: 2024, beforeWeek: 1 });
  assert.ok(!report.error, report.error);
  assert.equal(report.catalog_size, 35,
    '32 as of market_correction_research, plus teamrankings_predictive, nfelo_rating and '
    + 'nfelo_qb_adjustment, added and challenger-gated 2026-09-16');

  const residual = report.spaces.market_residual;
  assert.ok(residual.available, JSON.stringify(residual.reason));
  assert.ok(residual.components_measured >= 15,
    `only ${residual.components_measured} components were measurable on the fixture`);

  // The fixture's features are built from three hidden factors, so the
  // measured spectrum must be in that neighbourhood. This validates the
  // PIPELINE. It is not a measurement of the real ensemble, and the fixture's
  // own docstring says why one cannot be inferred from the other.
  const s = residual.spectrum;
  assert.ok(s.participation_ratio > 1 && s.participation_ratio < 8,
    `participation ratio ${s.participation_ratio} is outside anything the fixture could produce`);
  assert.ok(s.eigenvalues.every(v => v >= -1e-9), 'a correlation matrix has no negative eigenvalues');
  assert.ok(Math.abs(s.eigenvalues.reduce((a, b) => a + b, 0) - residual.components_measured) < 1e-3);

  // Every measured component appears exactly once in each per-component table.
  assert.equal(residual.redundancy.length, residual.components_measured);
  assert.equal(residual.loadings.length, residual.components_measured);
  assert.ok(residual.greedy_independent_basis.length >= 2);
  assert.equal(residual.greedy_independent_basis[0].r2_explained_by_prior, null,
    'the seed of a greedy basis has nothing prior to be explained by');
  for (const step of residual.greedy_independent_basis.slice(1)) {
    assert.ok(step.r2_explained_by_prior >= 0 && step.r2_explained_by_prior <= 1);
  }

  // Both spaces are measured, and both produce a valid correlation structure.
  // Deliberately NOT asserted: that the residual space is less collinear than
  // the raw space. Subtracting one common quantity (the market) from every
  // column removes a shared term but introduces another -- the market's own
  // error, which every residual now carries with the same sign -- so the
  // direction of that comparison is an empirical question about the data, not
  // a property the diagnostic should be built to confirm.
  const raw = report.spaces.raw_margin;
  assert.ok(raw.available);
  assert.ok(raw.correlation.mean_abs_offdiagonal >= 0 && raw.correlation.mean_abs_offdiagonal <= 1);
  assert.ok(residual.correlation.mean_abs_offdiagonal >= 0 && residual.correlation.mean_abs_offdiagonal <= 1);

  // The shrinkage regression the audits quote is computed, not asserted.
  assert.ok(report.market_shrinkage.raw.available);
  assert.ok(Number.isFinite(report.market_shrinkage.raw.slope_on_market));
  assert.equal(report.market_shrinkage.market_residual.available, true);
});

test('a report can be stored and read back without losing its numbers', () => {
  const report = { version: rank.ENSEMBLE_RANK_VERSION, cutoff: { season: 2024, week: 1 }, headline: { measured: true, participation_ratio: 2.5 } };
  rank.saveRankReport(report, { label: 'unit' });
  const back = rank.rankReports({ label: 'unit' });
  assert.equal(back.length, 1);
  assert.equal(back[0].report.headline.participation_ratio, 2.5);
  // Re-storing the same label/version/cutoff replaces rather than duplicating.
  rank.saveRankReport({ ...report, headline: { measured: true, participation_ratio: 3.5 } }, { label: 'unit' });
  assert.equal(rank.rankReports({ label: 'unit' }).length, 1);
  assert.equal(rank.rankReports({ label: 'unit' })[0].report.headline.participation_ratio, 3.5);
});
