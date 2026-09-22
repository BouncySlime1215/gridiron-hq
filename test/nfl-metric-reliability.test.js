import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Data & techniques R&D's RELIABILITY-SPEC.md (2026-09-22), step two of three:
// persist fitK's icc/k reading of a metric into the new nfl_metric_reliability
// table (migration 063). Step one (fitK gaining icc) is 9e2f079. Step three
// (a fitting job over real nflverse-sourced data, and a shrink-vs-no-shrink
// ablation gate) is separate, larger work, not started here.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gridiron-metric-reliability-'));
process.env.GRIDIRON_DB_PATH = path.join(temp, 'test.sqlite');

const { db } = await import('../server/db/index.js');
const { runMigrations } = await import('../server/db/migrate.js');
await runMigrations();

const { fitK, saveMetricReliability, loadMetricReliability, allMetricReliability } =
  await import('../server/services/shrinkage-fit.js');

test.after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

/** A fitK result with enough between-group separation to fit cleanly. */
function realFit() {
  const obs = [];
  [0, 10, 20, 30, 40, 50, 60, 70].forEach((center, i) => {
    for (const v of [center - 1, center, center + 1]) obs.push({ group: `p${i}`, weight: 1, value: v });
  });
  return fitK(obs);
}

test('nfl_metric_reliability table exists after migrations and starts empty', () => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM nfl_metric_reliability').get().n;
  assert.equal(count, 0);
});

test('saveMetricReliability requires population, metric and weightingScheme -- no anonymous row', () => {
  // Matched on the specific message, not just "something threw": the
  // NOT NULL columns would also throw on a missing field, and a bare
  // assert.throws can't tell that apart from this function's own guard
  // actually firing.
  const fit = realFit();
  const msg = /requires population, metric and weightingScheme/;
  assert.throws(() => saveMetricReliability({ metric: 'target_share', weightingScheme: 'flat_per_player_week', fit }), msg);
  assert.throws(() => saveMetricReliability({ population: 'pbp', weightingScheme: 'flat_per_player_week', fit }), msg);
  assert.throws(() => saveMetricReliability({ population: 'pbp', metric: 'target_share', fit }), msg);
});

test('saveMetricReliability requires a real fitK() shape -- rejects a malformed fit before it ever reaches the database', () => {
  const msg = /requires a fitK\(\) result with a finite icc/;
  assert.throws(() => saveMetricReliability({ population: 'pbp', metric: 'x', weightingScheme: 'flat', fit: null }), msg);
  assert.throws(() => saveMetricReliability({ population: 'pbp', metric: 'x', weightingScheme: 'flat', fit: { k: 1 } }), msg);
  assert.throws(() => saveMetricReliability({ population: 'pbp', metric: 'x', weightingScheme: 'flat', fit: { icc: 0.5, k: NaN } }), msg);
});

test('saveMetricReliability persists a real fitK result and loadMetricReliability reads it back exactly', () => {
  const fit = realFit();
  saveMetricReliability({
    population: 'pbp', metric: 'target_share', weightingScheme: 'flat_per_player_week',
    fit, nPlayers: 8, seasons: '2022-2025'
  });
  const stored = loadMetricReliability('pbp', 'target_share', 'flat_per_player_week');
  assert.ok(stored);
  assert.equal(stored.icc, fit.icc);
  assert.equal(stored.k, fit.k);
  assert.equal(stored.sigma2_within, fit.sigma2_within);
  assert.equal(stored.sigma2_between, fit.sigma2_between);
  assert.equal(stored.n_players, 8);
  assert.equal(stored.n_obs, fit.n_obs);
  assert.equal(stored.seasons, '2022-2025');
  assert.ok(stored.fitted_at);
});

test('the same (population, metric, weighting_scheme) upserts -- refitting REPLACES the stored values, it does not just avoid duplicating the row', () => {
  // Distinct from a bare COUNT(*) check: ON CONFLICT DO NOTHING would also
  // keep the count at 1, but would silently keep serving the FIRST fit's
  // stale numbers forever. The second fit here is built to have a visibly
  // different icc/k from the first, so a stale row is caught, not just an
  // extra one.
  const stableFit = fitK(Array.from({ length: 8 }, (_, i) =>
    [1, 2, 3].map(v => ({ group: `g${i}`, weight: 1, value: v }))).flat());
  const separatedFit = realFit();
  assert.notEqual(stableFit.icc, separatedFit.icc);

  saveMetricReliability({ population: 'pbp', metric: 'carry_share', weightingScheme: 'flat_per_player_week', fit: stableFit });
  saveMetricReliability({ population: 'pbp', metric: 'carry_share', weightingScheme: 'flat_per_player_week', fit: separatedFit });

  const count = db.prepare(`SELECT COUNT(*) AS n FROM nfl_metric_reliability
    WHERE population='pbp' AND metric='carry_share' AND weighting_scheme='flat_per_player_week'`).get().n;
  assert.equal(count, 1, 'still one row, not two');

  const stored = loadMetricReliability('pbp', 'carry_share', 'flat_per_player_week');
  assert.equal(stored.icc, separatedFit.icc, 'the SECOND fit\'s numbers, not the first\'s');
});

test('the same metric under a DIFFERENT weighting scheme is a separate row, and loadMetricReliability returns the one actually asked for', () => {
  // Distinct from a raw row-count check: dropping weighting_scheme from
  // loadMetricReliability's WHERE clause would still leave two rows in the
  // table, but .get() would return whichever one SQLite happens to pick
  // first regardless of which scheme was requested. Two fits with visibly
  // different icc catch that.
  const flatFit = realFit();
  const otherFit = fitK(Array.from({ length: 8 }, (_, i) =>
    [1, 2, 3].map(v => ({ group: `g${i}`, weight: 1, value: v }))).flat());
  assert.notEqual(flatFit.icc, otherFit.icc);

  saveMetricReliability({ population: 'pbp', metric: 'target_share', weightingScheme: 'flat_per_player_week', fit: flatFit });
  saveMetricReliability({ population: 'pbp', metric: 'target_share', weightingScheme: 'weighted_by_team_attempts', fit: otherFit });

  const rowCount = db.prepare(`SELECT COUNT(*) AS n FROM nfl_metric_reliability WHERE population='pbp' AND metric='target_share'`).get().n;
  assert.equal(rowCount, 2);

  assert.equal(loadMetricReliability('pbp', 'target_share', 'flat_per_player_week').icc, flatFit.icc);
  assert.equal(loadMetricReliability('pbp', 'target_share', 'weighted_by_team_attempts').icc, otherFit.icc);
});

test('a k of Infinity (no detectable signal) round-trips through storage, not dropped or coerced', () => {
  // Same lesson as shrinkage_k's own comment in this file: k=Infinity is the
  // fit's strongest statement (trust the prior completely), not a failure to
  // be silently dropped.
  const flatFit = fitK(Array.from({ length: 8 }, (_, i) => [1, 2, 3]).flatMap((vals, i) =>
    vals.map(v => ({ group: `g${i}`, weight: 1, value: v }))));
  assert.equal(flatFit.k, Infinity);
  saveMetricReliability({ population: 'ngs_receiving', metric: 'cushion', weightingScheme: 'flat_per_player_week', fit: flatFit });
  const stored = loadMetricReliability('ngs_receiving', 'cushion', 'flat_per_player_week');
  assert.equal(stored.k, Infinity);
});

test('loadMetricReliability returns null, not undefined or a throw, for a metric never fitted', () => {
  assert.equal(loadMetricReliability('pbp', 'never_fitted_metric', 'flat_per_player_week'), null);
});

test('allMetricReliability lists every stored row, most recently fitted first', () => {
  const fit = realFit();
  saveMetricReliability({ population: 'pbp', metric: 'targets', weightingScheme: 'flat_per_player_week', fit });
  const all = allMetricReliability();
  assert.ok(all.length >= 1);
  assert.ok(all.every(r => r.population && r.metric && r.weighting_scheme));
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].fitted_at >= all[i].fitted_at);
});
