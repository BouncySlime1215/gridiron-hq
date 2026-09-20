/**
 * A paired comparison between pooled model arms that cover different rows.
 *
 * THE DEFECT THIS FILE IS ABOUT. `offseason-model.js` grades several arms on the
 * same held-out seasons, pools each arm's per-row errors across seasons, and
 * compares each against a baseline with
 * `pairedBootstrapDiff(base.errs, arm.errs, { groups: arm.groups })`.
 *
 * That is a PAIRED test, so it needs `base.errs[i]` and `arm.errs[i]` to be the
 * same row. They are, until one arm is short: the GBM challenger is fitted
 * inside a `try` and omitted from a season's predictions when the fit throws, so
 * one throw on one season of three leaves the GBM arm holding seasons 2 and 3
 * while the baseline holds 1, 2 and 3.
 *
 * Nothing notices. `n = min(base, arm)` is the SHORTER arm, `groups` was built
 * in lockstep with that same shorter arm, so `groups.length === n` holds, the
 * clustered path is taken, and the GBM's season-2-and-3 rows are paired against
 * the baseline's season-1-and-2 rows. The interval comes back tight, clean and
 * significant on a comparison of nothing. The exact-length guard in
 * backtest-significance.js is the MIRROR of this case -- it catches a `groups`
 * array sized to the LONGER arm -- and cannot see this one, because both arrays
 * it is handed really are the same length as each other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { poolArm, comparePooledArms, armCoverage, clusteredDiff, MIN_PAIRED_ROWS } =
  await import('../server/services/pooled-arms.js');
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');

/**
 * One season of one arm, with a per-row error that depends on the SEASON, so a
 * comparison that pairs the wrong seasons gives a different answer from one that
 * pairs the right ones. A fixture whose errors were season-independent could not
 * tell the two apart, which is the trap this file exists to avoid.
 */
function season(name, yr, { rows = 40, err = 1 } = {}) {
  const keys = [], errs = [], groups = [], preds = [], truth = [];
  for (let i = 0; i < rows; i++) {
    keys.push(`${yr}|T${i % 8}|p${i}`);
    groups.push(`${yr}|T${i % 8}`);
    errs.push(err + (i % 5) * 0.01);
    preds.push(err); truth.push(0);
  }
  return { name, arm: { errs, preds, truth, groups, keys } };
}

const poolSeasons = (pooled, name, seasons) => {
  for (const s of seasons) poolArm(pooled, name, s.arm);
  return pooled;
};

test('an arm missing a whole season is compared on the rows it shares, not by index', () => {
  const pooled = {};
  // The baseline covers three seasons. The challenger threw on 2023, so it holds
  // 2024 and 2025 only -- and it is BETTER than the baseline on both.
  poolSeasons(pooled, 'no_change', [
    season('no_change', 2023, { err: 1.0 }),
    season('no_change', 2024, { err: 2.0 }),
    season('no_change', 2025, { err: 3.0 })
  ]);
  poolSeasons(pooled, 'gbm', [
    season('gbm', 2024, { err: 1.5 }),
    season('gbm', 2025, { err: 2.5 })
  ]);

  const out = comparePooledArms('no_change', pooled.no_change, 'gbm', pooled.gbm,
    { iterations: 500, seed: 3 });

  assert.equal(out.comparison_basis.compared, 80, 'the 2024 and 2025 rows, and only those');
  assert.equal(out.comparison_basis.rows.no_change, 120);
  assert.equal(out.comparison_basis.rows.gbm, 80);
  assert.equal(out.comparison_basis.aligned, false);
  assert.match(out.comparison_basis.reason, /covers 80 of 120 rows/);
  assert.equal(out.clustered, true, 'the shared rows carry their own groups');
  // On the rows they share the challenger is better by exactly 0.5 every row.
  assert.ok(Math.abs(out.mean_diff + 0.5) < 0.05, `expected about -0.5, got ${out.mean_diff}`);
});

test('the same comparison done by index reports a different number, which is the bug', () => {
  // This is what the call site did before: hand both arms' pooled errors straight
  // to the bootstrap with the SHORTER arm's groups. It is not a weaker version of
  // the test above -- it is the measurement that proves the two disagree, so the
  // alignment is load-bearing rather than decorative.
  const pooled = {};
  poolSeasons(pooled, 'no_change', [
    season('no_change', 2023, { err: 1.0 }),
    season('no_change', 2024, { err: 2.0 }),
    season('no_change', 2025, { err: 3.0 })
  ]);
  poolSeasons(pooled, 'gbm', [
    season('gbm', 2024, { err: 1.5 }),
    season('gbm', 2025, { err: 2.5 })
  ]);

  const byIndex = pairedBootstrapDiff(pooled.no_change.errs, pooled.gbm.errs,
    { iterations: 500, seed: 3, groups: pooled.gbm.groups });
  const aligned = comparePooledArms('no_change', pooled.no_change, 'gbm', pooled.gbm,
    { iterations: 500, seed: 3 });

  assert.equal(byIndex.clustered, true,
    'the old guard passes: groups is exactly as long as the shorter arm');
  assert.equal(byIndex.n, 80);
  // IT DOES NOT JUST GET THE SIZE WRONG, IT GETS THE SIGN WRONG. By index the
  // challenger's 2024/2025 rows (mean error 2.0) are paired against the
  // baseline's 2023/2024 rows (mean 1.5), so the challenger reads as 0.5 WORSE.
  // Aligned on the rows they actually share it is 0.5 BETTER. Same two arms,
  // same seed, opposite verdicts -- and the wrong one is the one that comes with
  // a clustered interval and a significance flag.
  assert.ok(Math.abs(byIndex.mean_diff - 0.5) < 0.05,
    `by index the challenger reads 0.5 worse: got ${byIndex.mean_diff}`);
  assert.ok(Math.abs(aligned.mean_diff + 0.5) < 0.05,
    `aligned it is 0.5 better: got ${aligned.mean_diff}`);
  assert.ok(byIndex.mean_diff > 0 && aligned.mean_diff < 0,
    'the index pairing does not blur the answer, it reverses it');
  assert.equal(byIndex.comparison_basis, undefined,
    'and it reports nothing at all about which rows it used');
});

test('two arms sharing too few rows are refused, and the refusal is served', () => {
  const pooled = {};
  poolSeasons(pooled, 'base', [season('base', 2023, { rows: 40 })]);
  poolSeasons(pooled, 'thin', [season('thin', 2025, { rows: 40 })]);

  const out = comparePooledArms('base', pooled.base, 'thin', pooled.thin, { iterations: 200 });
  assert.equal(out.comparison_basis.compared, 0, 'no season in common');
  assert.ok(out.error, 'a comparison of nothing must not return an interval');
  assert.equal(out.mean_diff, undefined);
  assert.match(out.error, /share only 0 rows/);
  assert.match(out.error, /40 against 40/, 'and it says how big each arm was');
  assert.equal(out.comparison_basis.reason, out.error, 'served on the basis too, not only thrown');
});

test('the basis is served even when the arms line up perfectly', () => {
  // The point of a served field is that a reader never has to infer it from its
  // absence. If it only appeared on the broken case, a table with no basis would
  // be ambiguous between "aligned" and "written before this existed".
  const pooled = {};
  poolSeasons(pooled, 'base', [season('base', 2024), season('base', 2025)]);
  poolSeasons(pooled, 'cand', [season('cand', 2024, { err: 0.5 }), season('cand', 2025, { err: 0.5 })]);

  const out = comparePooledArms('base', pooled.base, 'cand', pooled.cand, { iterations: 300 });
  assert.equal(out.comparison_basis.aligned, true);
  assert.equal(out.comparison_basis.dropped, 0);
  assert.equal(out.comparison_basis.reason, null, 'nothing to warn about, so nothing invented');
  assert.equal(out.comparison_basis.compared, 80);
  assert.deepEqual(out.comparison_basis.arms, ['base', 'cand']);
  assert.equal(out.clustered, true);
});

test('pooling without row keys throws instead of pooling something unalignable', () => {
  // The old shape appended errs/preds/truth/groups and no keys. Accepting that
  // silently would leave the alignment above believing an arm covers nothing.
  assert.throws(() => poolArm({}, 'x', { errs: [1], preds: [1], truth: [0], groups: ['g'] }),
    /no row keys/);
  assert.throws(() => poolArm({}, 'x',
    { errs: [1, 2], preds: [1, 2], truth: [0, 0], groups: ['g', 'g'], keys: ['k'] }),
    /errs has 2 rows against 1 keys/);
});

test('a key that repeats is refused, because it pairs several rows against one', () => {
  // The mutation that found this: dropping the player from the call site's key,
  // leaving `season|team`. Alignment reads the FIRST index a key appears at, so
  // every one of the baseline's eight rows for a team would have been paired
  // against the challenger's first row for that team -- the by-index defect
  // again, arriving through a key specific enough to look deliberate. The
  // compared COUNT stays plausible, so nothing downstream can see it.
  const pooled = {};
  const s2024 = season('base', 2024);
  const collapsed = { ...s2024.arm, keys: s2024.arm.groups.slice() };  // season|team only
  assert.throws(() => poolArm(pooled, 'base', collapsed),
    /row key 2024\|T0 appears twice, so it does not identify a row/);

  // And across seasons, where the duplicate arrives on a later call rather than
  // inside one batch.
  const fresh = {};
  poolArm(fresh, 'base', s2024.arm);
  assert.throws(() => poolArm(fresh, 'base', s2024.arm), /appears twice/);
});

test('clusteredDiff throws rather than return an unclustered interval as a clustered one', () => {
  // The other half of the queued clustered-flag item. The fallback is honest but
  // narrower than the truth on correlated rows, and the returned interval is
  // indistinguishable from a clustered one, so a caller that asked for clustering
  // and did not get it would publish a tighter result than it measured. These are
  // offline grading paths, so failing the audit beats publishing the number.
  const n = 40;
  const a = Array.from({ length: n }, (_, i) => 1 + (i % 5) * 0.01);
  const b = Array.from({ length: n }, (_, i) => 0.5 + (i % 5) * 0.01);
  const groups = Array.from({ length: n }, (_, i) => `g${i % 8}`);

  assert.equal(clusteredDiff(a, b, { iterations: 200, groups }).clustered, true);
  assert.throws(() => clusteredDiff(a, b, { iterations: 200, groups: groups.slice(0, 10) }),
    /clustering was requested and declined/);
  assert.throws(() => clusteredDiff(a, b.slice(0, 20), { iterations: 200, groups }),
    /clustering was requested and declined/);
  assert.throws(() => clusteredDiff(a, b, { iterations: 200 }),
    /requires groups/, 'and it is not a silent pass-through for a caller with no groups');
  // A refusal for too few rows is not a declined clustering, so it comes back as
  // the refusal rather than a throw: the caller gets to report "too thin".
  const thin = clusteredDiff(a.slice(0, 4), b.slice(0, 4), { iterations: 200, groups: groups.slice(0, 4) });
  assert.match(thin.error, /too few paired observations/);
});

test('coverage names which arms are short and which seasons they are missing', () => {
  const pooled = {};
  poolSeasons(pooled, 'no_change', [
    season('no_change', 2023), season('no_change', 2024), season('no_change', 2025)]);
  poolSeasons(pooled, 'gbm', [season('gbm', 2024), season('gbm', 2025)]);

  const cov = armCoverage(pooled);
  assert.deepEqual(cov.all_seasons, ['2023', '2024', '2025']);
  assert.deepEqual(cov.by_arm.gbm, ['2024', '2025']);
  assert.equal(cov.incomplete.length, 1);
  assert.deepEqual(cov.incomplete[0], { arm: 'gbm', covers: ['2024', '2025'], missing: ['2023'] });
});

test('a caller that asks for clustering is told when it did not get it', () => {
  // The other half of the same problem: pairedBootstrapDiff falls back to an
  // unclustered resample whenever groups does not line up, and the interval it
  // returns looks identical either way. A caller cannot assert what it cannot see.
  const n = 40;
  const a = Array.from({ length: n }, (_, i) => 1 + (i % 5) * 0.01);
  const b = Array.from({ length: n }, (_, i) => 0.5 + (i % 5) * 0.01);
  const groups = Array.from({ length: n }, (_, i) => `g${i % 8}`);

  assert.equal(pairedBootstrapDiff(a, b, { iterations: 200, groups }).clustered, true);
  assert.equal(pairedBootstrapDiff(a, b, { iterations: 200 }).clustered, false,
    'no groups asked for, none used');
  assert.equal(pairedBootstrapDiff(a, b, { iterations: 200, groups: groups.slice(0, 10) }).clustered,
    false, 'groups too short: the fallback is honest, and now it is visible');
  assert.equal(pairedBootstrapDiff(a, b.slice(0, 20), { iterations: 200, groups }).clustered,
    false, 'groups sized to the longer arm: the mirror case the guard already caught');
  assert.equal(pairedBootstrapDiff(a.slice(0, 4), b.slice(0, 4), { iterations: 200 }).clustered,
    false, 'and the too-few-rows refusal carries the field as well');
  assert.equal(MIN_PAIRED_ROWS, 10);
});
