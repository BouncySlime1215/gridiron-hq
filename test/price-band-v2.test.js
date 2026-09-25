/**
 * PRICE-BAND-01: the clone's accept band as a fitted split-conformal band, behind
 * GRIDIRON_PRICE_BAND_V2 (read with preview-mode.js#previewUnconfirmed).
 *
 * Fixture: test/fixtures/price-band-trades.csv, 1,000 synthetic trades (250 per season
 * 2021-2024, 25 fake league keys per season), log r ~ N(-0.1, 0.4) drawn with a seeded
 * PRNG. No real Sleeper rows are committed; the real run is the LOCAL command in the PR.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(REPO, 'test/fixtures/price-band-trades.csv');
const CLI = path.join(REPO, 'scripts/price-band-calibrate.mjs');

const pb = await import('../server/services/price-band.js');
const cal = await import('../scripts/price-band-calibrate.mjs');
const { PREVIEW_ENV } = await import('../server/services/preview-mode.js');

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/* ------------------------------------------------------------------- flag */

test('flag: off by default; "1" on; preview mode turns it on labelled; "0" vetoes preview', () => {
  const E = pb.PRICE_BAND_V2_ENV;
  assert.equal(E, 'GRIDIRON_PRICE_BAND_V2');
  withEnv({ [E]: undefined, [PREVIEW_ENV]: undefined }, () => {
    assert.deepEqual(pb.priceBandV2Flag(), { on: false, preview: false });
    assert.equal(pb.servedAcceptBand(), pb.LEGACY_BAND);
  });
  withEnv({ [E]: '1', [PREVIEW_ENV]: undefined }, () => {
    assert.deepEqual(pb.priceBandV2Flag(), { on: true, preview: false });
    assert.equal(pb.servedAcceptBand(), pb.V2_BAND);
  });
  withEnv({ [E]: undefined, [PREVIEW_ENV]: '1' }, () => {
    assert.deepEqual(pb.priceBandV2Flag(), { on: true, preview: true });
    const b = pb.servedAcceptBand();
    assert.equal(b.lo, pb.V2_BAND.lo);
    assert.equal(b.preview, true);
    assert.equal(b.preview_reason, pb.PRICE_BAND_V2_REASON);
  });
  withEnv({ [E]: '0', [PREVIEW_ENV]: '1' }, () => {
    assert.deepEqual(pb.priceBandV2Flag(), { on: false, preview: false });
    assert.equal(pb.servedAcceptBand(), pb.LEGACY_BAND);
  });
  for (const v of ['true', 'yes', '']) {
    withEnv({ [E]: v, [PREVIEW_ENV]: undefined }, () => assert.equal(pb.priceBandV2Flag().on, false, JSON.stringify(v)));
  }
});

test('legacy band is exactly the served numbers before PRICE-BAND-01', () => {
  assert.deepEqual(
    { lo: pb.LEGACY_BAND.window_lo, hi: pb.LEGACY_BAND.window_hi, yes: pb.LEGACY_BAND.yes_point },
    { lo: 0.70, hi: 1.65, yes: 1.00 });
  assert.equal(pb.LEGACY_BAND.lo, 1.00);
  assert.equal(pb.LEGACY_BAND.hi, 1.65);
});

test('trade-engine reads the band from price-band.js: no hand-set 0.70 / 1.65 / 1.0 price literals left in the ladders', () => {
  const src = fs.readFileSync(path.join(REPO, 'server/services/trade-engine.js'), 'utf8');
  assert.equal((src.match(/ratio < shapeBand\.window_lo \|\| ratio > shapeBand\.window_hi/g) ?? []).length, 2);
  assert.equal((src.match(/const shapeBand = bandForShape\(band, give\.length, /g) ?? []).length, 2);
  assert.equal((src.match(/p\.ratio >= band\.yes_point/g) ?? []).length, 2);
  assert.doesNotMatch(src, /ratio < 0\.70 \|\| ratio > 1\.65/);
  assert.doesNotMatch(src, /p\.ratio >= 1\.0\b/);
});

/* ------------------------------------------------------------- V2 numbers */

test('V2 band is derived from the fitted constants and is re-centred below the legacy yes point', () => {
  const b = pb.V2_BAND;
  assert.equal(b.lo, +Math.exp(pb.FITTED_BAND.log_center - pb.FITTED_BAND.half_width).toFixed(3));
  assert.equal(b.hi, +Math.exp(pb.FITTED_BAND.log_center + pb.FITTED_BAND.half_width).toFixed(3));
  // FIX-303-2: the fitted band is the window, never the yes point; the yes point stays legacy.
  assert.equal(b.yes_point, pb.LEGACY_BAND.yes_point);
  assert.equal(pb.priceSaysYes(0.6, b), false, 'a package at r = 0.6 is not acceptable on price alone with V2 on');
  assert.equal(b.window_lo, b.lo);
  assert.equal(b.window_hi, b.hi);
  assert.equal(b.nominal, 0.8);
  assert.ok(b.lo < b.center && b.center < b.hi);
  // The C2-BASE finding: real prices clear near r ~ 0.90, below the legacy yes point 1.00.
  assert.ok(b.center < pb.LEGACY_BAND.yes_point, `centre ${b.center}`);
  assert.deepEqual(pb.FITTED_BAND.fit_seasons, [2021]);
  assert.deepEqual(pb.FITTED_BAND.cal_seasons, [2022]);
  assert.ok(Object.isFrozen(pb.V2_BAND) && Object.isFrozen(pb.LEGACY_BAND));
});

test('priceSaysYes is inclusive at both edges and false outside', () => {
  const b = { yes_point: 0.5, hi: 1.5 };
  assert.equal(pb.priceSaysYes(0.5, b), true);
  assert.equal(pb.priceSaysYes(1.5, b), true);
  assert.equal(pb.priceSaysYes(0.49, b), false);
  assert.equal(pb.priceSaysYes(1.51, b), false);
});

/* ------------------------------------------------------------ calibration */

test('fitConformalBand: centre from the fit split, width from the calibration split, finite-sample rank', () => {
  // Fit split centred on r = 1 (log 0). Calibration scores |log r| = 0.1..1.0.
  const fit = [0.5, 1, 2];
  const calR = Array.from({ length: 10 }, (_, i) => Math.exp((i + 1) / 10));
  const f = pb.fitConformalBand(fit, calR, 0.2);
  assert.equal(f.log_center, 0);
  // k = ceil(11 * 0.8) = 9 -> 9th smallest score = 0.9 (not the naive 8th = 0.8).
  assert.equal(f.half_width, 0.9);
  assert.equal(f.fit_n, 3);
  assert.equal(f.cal_n, 10);
  // Too few calibration points for the level: the honest band is unbounded.
  assert.equal(pb.fitConformalBand(fit, [1.1, 1.2], 0.2).half_width, Infinity);
  // Garbage is dropped, not silently counted.
  assert.equal(pb.fitConformalBand([1, NaN, -1, 0], [1.1, 1.2, 1.3, 1.4, 1.5], 0.5).fit_n, 1);
  assert.throws(() => pb.fitConformalBand([], [1]), /empty/);
  assert.throws(() => pb.fitConformalBand([1], [1], 1), /alpha/);
});

test('bandCoverage splits inside / below / above and ignores non-finite prices', () => {
  const c = pb.bandCoverage([0.4, 0.6, 1.0, 1.5, 2.0, NaN], { lo: 0.5, hi: 1.5 });
  assert.deepEqual(c, { n: 5, inside: 3 / 5, below: 1 / 5, above: 1 / 5 });
  assert.deepEqual(pb.bandCoverage([], { lo: 0, hi: 1 }), { n: 0, inside: null, below: null, above: null });
});

test('clusteredShareCI is deterministic, brackets the estimate, and resamples leagues not trades', () => {
  const rows = [];
  for (let k = 0; k < 30; k++) for (let i = 0; i < 5; i++) rows.push({ key: `L${k}`, hit: (k + i) % 3 ? 1 : 0 });
  const a = pb.clusteredShareCI(rows, { reps: 500, seed: 1 });
  const b = pb.clusteredShareCI(rows, { reps: 500, seed: 1 });
  assert.deepEqual(a, b);
  assert.ok(a.lo <= a.est && a.est <= a.hi);
  // One league holding every row: the league bootstrap has nothing to vary.
  const one = pb.clusteredShareCI(rows.map(r => ({ ...r, key: 'X' })), { reps: 200 });
  assert.equal(one.lo, one.hi);
});

test('parseTrades refuses any 2025+ row and missing columns', () => {
  const head = 'season,league_key,week,r,r_ros,n_get,n_give';
  assert.equal(cal.parseTrades(`${head}\n2024,a,3,0.9,,1,1\n`).length, 1);
  assert.ok(Number.isNaN(cal.parseTrades(`${head}\n2024,a,3,0.9,,1,1\n`)[0].r_ros));
  assert.throws(() => cal.parseTrades(`${head}\n2025,a,3,0.9,1,1,1\n`), /2025/);
  assert.throws(() => cal.parseTrades('season,r\n2021,1\n'), /missing column league_key/);
});

test('calibrate on the fixture: fits on 2021 / 2022 only and lands 2023-24 held-out coverage near 80%', () => {
  const trades = cal.parseTrades(fs.readFileSync(FIXTURE, 'utf8'));
  const out = cal.calibrate(trades);
  assert.equal(out.fit.fit_n, 250, 'fit split is 2021 only');
  assert.equal(out.fit.cal_n, 250, 'calibration split is 2022 only');
  const pooled = out.splits['2023-24 pooled (HEADLINE)'];
  assert.equal(pooled.v2.n, 500);
  assert.ok(Math.abs(pooled.v2.inside[0] - 0.8) <= 0.05, `held-out coverage ${pooled.v2.inside[0]}`);
  assert.ok(pooled.v2.inside[1] <= pooled.v2.inside[0] && pooled.v2.inside[0] <= pooled.v2.inside[2]);
  // Shares add to 1 on each band.
  for (const k of ['legacy', 'v2']) {
    const s = pooled[k];
    assert.ok(Math.abs(s.inside[0] + s.below[0] + s.above[0] - 1) < 0.002, k);
  }
  // Fixture centre is log r = -0.1, so the legacy band misses mostly below its yes point.
  assert.ok(pooled.legacy.below[0] > 0.5);
  assert.equal(out.target.met, true);
  // The fixture is not the real data, so the served constants must NOT match it.
  assert.equal(out.matches_served_constants, false);
});

test('calibrate is unaffected by grade-season prices (no leakage from 2023-24 into the fit)', () => {
  const trades = cal.parseTrades(fs.readFileSync(FIXTURE, 'utf8'));
  const shifted = trades.map(t => (t.season >= 2023 ? { ...t, r: t.r * 3 } : t));
  assert.deepEqual(cal.calibrate(shifted).fit, cal.calibrate(trades).fit);
  assert.deepEqual(cal.calibrate(shifted).shape_fit, cal.calibrate(trades).shape_fit, 'PRICE-BAND-02 shape fits too');
  // And the grade does move, which is the known-nonzero control for the line above.
  assert.notEqual(cal.calibrate(shifted).target.pooled_v2, cal.calibrate(trades).target.pooled_v2);
});

test('CLI --check exits 1 when the refit does not match the served constants, 2 without --trades', () => {
  const bad = spawnSync(process.execPath, [CLI, '--trades', FIXTURE, '--check'], { encoding: 'utf8' });
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /served constants match refit=false/);
  const usage = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  const emit = spawnSync(process.execPath, [CLI, '--trades', FIXTURE, '--emit'], { encoding: 'utf8' });
  assert.equal(emit.status, 0, emit.stderr);
  assert.match(emit.stdout, /export const FITTED_BAND = Object\.freeze/);
});

/* ---------------------------------------------- PRICE-BAND-02: bands per trade shape */

test('tradeShape partitions every count pair, read from the target owner\'s side', () => {
  assert.equal(pb.tradeShape(1, 1), '1for1');
  assert.equal(pb.tradeShape(2, 1), '2for1');
  for (const [g, v] of [[3, 1], [3, 2], [4, 2], [4, 3]]) assert.equal(pb.tradeShape(g, v), '3for2plus', `${g}x${v}`);
  for (const n of [2, 3, 4]) assert.equal(pb.tradeShape(n, n), 'even');
  for (const [g, v] of [[1, 2], [1, 3], [2, 3]]) assert.equal(pb.tradeShape(g, v), 'fewer_for_more', `${g}x${v}`);
  assert.throws(() => pb.tradeShape(0, 1), /bad counts/);
  assert.throws(() => pb.tradeShape(1.5, 1), /bad counts/);
});

test('bandForShape: legacy is one band for every shape; V2 serves the shape band', () => {
  for (const [g, v] of [[1, 1], [2, 1], [3, 1], [2, 2], [1, 2]]) assert.equal(pb.bandForShape(pb.LEGACY_BAND, g, v), pb.LEGACY_BAND);
  const b21 = pb.bandForShape(pb.V2_BAND, 2, 1);
  assert.equal(b21.shape, '2for1');
  assert.equal(b21.lo, pb.V2_BAND.by_shape['2for1'].lo);
  assert.equal(b21.yes_point, pb.LEGACY_BAND.yes_point, 'FIX-303-2: yes point stays legacy per shape too');
  assert.ok(!('by_shape' in b21));
  // The C2 finding the shapes fix: 2-for-1s clear above 1-for-1s.
  assert.ok(pb.V2_BAND.by_shape['2for1'].center > pb.V2_BAND.by_shape['1for1'].center);
  // Preview labels ride on the served object; the shape band is looked up from it.
  const prev = { ...pb.V2_BAND, preview: true };
  assert.equal(pb.bandForShape(prev, 3, 2).shape, '3for2plus');
  // A shape with no fit falls back to the pooled band, labelled with the shape.
  const holey = { ...pb.V2_BAND, by_shape: { ...pb.V2_BAND.by_shape, even: null } };
  const fb = pb.bandForShape(holey, 2, 2);
  assert.deepEqual([fb.lo, fb.hi, fb.shape, 'by_shape' in fb], [pb.V2_BAND.lo, pb.V2_BAND.hi, 'even', false]);
});

test('windowSpan is the outer hull of the package-size bands, and exactly legacy with the flag off', () => {
  assert.deepEqual(pb.windowSpan(pb.LEGACY_BAND, [1, 2, 3], 1), { lo: 0.70, hi: 1.65 });
  const s = pb.windowSpan(pb.V2_BAND, [1, 2, 3], 1);
  const bs = [[1, 1], [2, 1], [3, 1]].map(([g, v]) => pb.bandForShape(pb.V2_BAND, g, v));
  assert.equal(s.lo, Math.min(...bs.map(b => b.lo)));
  assert.equal(s.hi, Math.max(...bs.map(b => b.hi)));
});

test('the 1-for-1 band is direction-free around even value and contains the legacy yes point', () => {
  const f = pb.FITTED_SHAPE_BANDS['1for1'];
  assert.equal(f.log_center, 0);
  assert.equal(f.direction_free, true);
  const b = pb.V2_BAND.by_shape['1for1'];
  assert.ok(Math.abs(b.lo * b.hi - 1) < 0.01, `lo ${b.lo} x hi ${b.hi} should be ~1`);
  assert.ok(b.lo < 1 && b.hi > 1);
  assert.equal(pb.priceSaysYes(1.0, b), true);
});

test('fitEqualTailedBand: one conformal rank per tail at alpha/2', () => {
  // Centre log 0; 19 calibration points at log r = -0.9..0.9 step 0.1.
  const calR = Array.from({ length: 19 }, (_, i) => Math.exp((i - 9) / 10));
  const f = pb.fitEqualTailedBand([1], calR, 0.2);
  // k = ceil(20 * 0.9) = 18 -> 18th smallest of each one-sided score list.
  // Lower scores -log r = -0.9..0.9, 18th smallest = 0.8; same above.
  assert.equal(f.log_center, 0);
  assert.equal(f.width_lo, 0.8);
  assert.equal(f.width_hi, 0.8);
  // Skewed calibration moves only the side it is skewed on.
  const skew = pb.fitEqualTailedBand([1], calR.map(r => (r > 1 ? r * r : r)), 0.2);
  assert.equal(skew.width_lo, 0.8);
  assert.equal(skew.width_hi, 1.6);
  const b = pb.bandFromFit({ ...skew, version: 't' });
  assert.equal(b.lo, +Math.exp(-0.8).toFixed(3));
  assert.equal(b.hi, +Math.exp(1.6).toFixed(3));
  assert.equal(pb.fitEqualTailedBand([1], [1, 2], 0.2).width_hi, Infinity);
  assert.throws(() => pb.fitEqualTailedBand([], [1]), /empty/);
});

test('fitShapeBands: fits per shape, leaves thin shapes unfitted, and never mixes shapes', () => {
  const mk = (n, g, v, r) => Array.from({ length: n }, (_, i) => ({ n_get: g, n_give: v, r: r * Math.exp((i % 7 - 3) / 20) }));
  const fit = [...mk(40, 1, 1, 0.8), ...mk(40, 2, 1, 1.4), ...mk(5, 2, 2, 0.9)];
  const cal = [...mk(40, 1, 1, 0.8), ...mk(40, 2, 1, 1.4), ...mk(40, 2, 2, 0.9)];
  const out = pb.fitShapeBands(fit, cal, 0.2);
  assert.deepEqual(Object.keys(out), [...pb.TRADE_SHAPES]);
  assert.equal(out.even, null, 'only 5 fit rows');
  assert.equal(out['3for2plus'], null);
  assert.equal(out['2for1'].fit_n, 40);
  assert.ok(Math.abs(Math.exp(out['2for1'].log_center) - 1.4) < 0.01);
  assert.equal(out['1for1'].log_center, 0, '1-for-1 is direction-free');
  assert.equal(out['1for1'].direction_free, true);
});

test('calibrate reports per-shape coverage and gates the three ladder shapes', () => {
  const out = cal.calibrate(cal.parseTrades(fs.readFileSync(FIXTURE, 'utf8')));
  assert.deepEqual(cal.GATED_SHAPES, ['1for1', '2for1', '3for2plus']);
  assert.deepEqual(Object.keys(out.shape_target), cal.GATED_SHAPES);
  // Fixture has only 1x1 and 2x1 trades: the other shapes are unfitted and fall back.
  assert.equal(out.shape_bands['3for2plus'].pooled_fallback, true);
  assert.equal(out.shape_bands['2for1'].pooled_fallback, false);
  const s = out.by_shape_2023_24;
  assert.equal(s['1for1'].shape_v2.n + s['2for1'].shape_v2.n, s.all.shape_v2.n);
  assert.equal(s['2for1'].shape_v2.n, s.uneven_counts.shape_v2.n);
  assert.equal(out.matches_served_shape_constants, false, 'fixture is not the real data');
});

test('CLI --emit prints the FITTED_SHAPE_BANDS literal', () => {
  const emit = spawnSync(process.execPath, [CLI, '--trades', FIXTURE, '--emit'], { encoding: 'utf8' });
  assert.equal(emit.status, 0, emit.stderr);
  assert.match(emit.stdout, /export const FITTED_SHAPE_BANDS = Object\.freeze/);
  assert.match(emit.stdout, /2for1: Object\.freeze\(\{ alpha: 0\.2, log_center: [-\d.]+, width_lo: /);
});
