#!/usr/bin/env node
/**
 * Does the shipped cascade multiplier predict anything?
 *
 * `contingency.js:cascades()` publishes, for each starter, a list of teammates
 * and a claim about each: when the starter sits, this teammate's opportunity
 * goes from `base_opportunity` to `opportunity_without`, a `multiplier` of `m`.
 * `handcuffValue()` turns that claim into an expected-points figure.
 *
 * Nothing in this repository has ever checked the claim against a season the
 * split was not fitted on. `auditCascadeConservation` in role-scenario-engine.js
 * checks whether the multipliers sum to more than the starter ever used, which
 * is a consistency question, not an accuracy one. This is the accuracy one.
 *
 * READ THIS BEFORE THE NUMBERS. Two tests, both written before the first run,
 * and the bar fixed in the same shape the volume-shrinkage gate uses:
 *
 *   The cascade earns a place on a surviving surface only if it wins in BOTH
 *   graded seasons AND the 90% player-clustered bootstrap interval excludes
 *   zero. A one-season win, or a two-season win whose interval straddles zero,
 *   is a refusal.
 *
 * TEST A, "on its own terms", is the primary. Both predictions come straight
 * out of the cascade — `opportunity_without` against `base_opportunity` — so it
 * isolates the estimator and nothing else.
 *
 * TEST B, "incremental", asks whether the multiplier adds anything on top of
 * the beneficiary's own recent usage. It was written as the primary and is NOT,
 * for a reason found only by running it: for a backup who has already taken
 * over, own-recent-usage ALREADY reflects the starter's absence, so multiplying
 * again double-counts. Test B therefore measures a use error mixed with the
 * estimator, and reading it as a verdict on the estimator would be wrong. It is
 * kept because it is the shape a consumer would most likely reach for, and the
 * double-counting trap is worth showing rather than asserting.
 *
 * Neither test was added after seeing results and neither was dropped. The
 * ranking between them changed, and this comment is the record of that.
 *
 * Walk-forward, no leakage: the cascade graded on season s is built with
 * `through: s - 1`, and `cascades()` reads only `season <= through`. The
 * baseline is built from the graded player's own EARLIER WEEKS of the graded
 * season, which the cascade never saw either.
 *
 * Read-only. Writes nothing to the database.
 *
 *   node scripts/grade-cascade-multipliers.mjs
 *   node scripts/grade-cascade-multipliers.mjs --seasons 2024,2025 --json out.json
 */
import { cascades } from '../server/services/contingency.js';
import {
  buildGradedRows, mae, bias, pairedInterval, CASCADE_GRADE_VERSION
} from '../server/services/cascade-grade.js';

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const GRADED_SEASONS = argOf('--seasons', '2024,2025').split(',').map(Number);
const JSON_OUT = argOf('--json', null);
const ROWS_OUT = argOf('--rows', null);
const DRAWS = Number(argOf('--draws', '2000'));
const MIN_PRIOR_GAMES = Number(argOf('--min-prior', '2'));
const HALF_LIFE = Number(argOf('--half-life', '3'));

const pct = (x, base) => base > 0 ? `${(100 * x / base).toFixed(2)}%` : 'n/a';
const f = (x, d = 3) => x == null ? 'n/a' : x.toFixed(d);
const excludesZero = ci => !!ci && ((ci.lo > 0 && ci.hi > 0) || (ci.lo < 0 && ci.hi < 0));

const allRows = [];
const report = {
  version: CASCADE_GRADE_VERSION, generated_at: new Date().toISOString(),
  half_life: HALF_LIFE, min_prior_games: MIN_PRIOR_GAMES, draws: DRAWS, seasons: []
};

console.log(`Grading the shipped cascade multipliers, walk-forward.  ${CASCADE_GRADE_VERSION}`);
console.log(`Baseline: the beneficiary's own opportunity in earlier weeks of the graded season,`);
console.log(`exponentially weighted, half-life ${HALF_LIFE} weeks, at least ${MIN_PRIOR_GAMES} prior games.\n`);

for (const season of GRADED_SEASONS) {
  const cascadeMap = cascades({ through: season - 1 });
  const r = buildGradedRows({ season, cascadeMap, halfLife: HALF_LIFE, minPriorGames: MIN_PRIOR_GAMES });
  allRows.push(...r.graded);

  console.log(`=== ${season}  (cascade fitted through ${season - 1}) ===`);
  console.log(`  starters with a cascade entry and a roster spot: ${r.starters} of ${cascadeMap.size}`);
  console.log(`  absence weeks found: ${r.absences}`);
  console.log(`  graded rows: ${r.graded.length}   (skipped, beneficiary had no prior history: ${r.skippedNoHistory})`);

  if (r.graded.length < 30) {
    console.log('  too few rows to grade; nothing claimed.\n');
    report.seasons.push({ season, graded_rows: r.graded.length, verdict: 'insufficient' });
    continue;
  }

  const own = x => x.own_recent;
  const scaled = x => x.own_recent * x.multiplier;
  const pubWith = x => x.published_with;
  const pubWithout = x => x.published_without;

  const maeWith = mae(r.graded, pubWith), maeWithout = mae(r.graded, pubWithout);
  const deltaA = maeWith - maeWithout;
  const ciA = pairedInterval(r.graded, pubWithout, pubWith, { draws: DRAWS });

  console.log(`\n  TEST A (primary) — the published claim on its own terms.`);
  console.log(`    published base_opportunity    MAE ${f(maeWith)}   bias ${f(bias(r.graded, pubWith))}`);
  console.log(`    published opportunity_without MAE ${f(maeWithout)}   bias ${f(bias(r.graded, pubWithout))}`);
  console.log(`    improvement ${f(deltaA)}  (${pct(deltaA, maeWith)} of the with-starter MAE)`);
  console.log(`    90% player-clustered interval on (without − with) MAE: [${f(ciA?.lo)}, ${f(ciA?.hi)}]`);
  console.log(`    ${deltaA > 0 ? 'improves' : 'does not improve'}; interval ${excludesZero(ciA) ? 'excludes' : 'straddles'} zero`);

  // The two published numbers bracket the truth: "with" reads low on an absence
  // week and "without" reads high. How much of the published gain actually lands
  // is worth knowing, but this is fitted ON the graded rows — a description of
  // this sample, NOT evidence that any shrunk gain forecasts.
  let num = 0, den = 0;
  for (const x of r.graded) {
    const g = x.published_without - x.published_with;
    num += g * (x.actual - x.published_with); den += g * g;
  }
  const lambda = den > 0 ? num / den : null;
  console.log(`    in-sample only, not evidence: the published gain would need scaling by ${f(lambda, 2)} to fit these weeks.`);

  // Rows whose multiplier was withheld for a thin divisor have no ratio to test,
  // so Test B runs on the supported subset. Test A is unaffected: base_opportunity
  // and opportunity_without are published for every row either way.
  const supported = r.graded.filter(x => x.multiplier != null);
  const withheld = r.graded.length - supported.length;
  const maeOwn = mae(supported, own), maeScaled = mae(supported, scaled);
  const deltaB = maeOwn - maeScaled;
  const ciB = pairedInterval(supported, scaled, own, { draws: DRAWS });

  console.log(`\n  TEST B — does the multiplier add anything to the player's own recent usage?`);
  console.log(`    rows with a published multiplier: ${supported.length} of ${r.graded.length}` +
    (withheld ? `   (${withheld} withheld for a thin divisor)` : ''));
  console.log(`    own recent usage        MAE ${f(maeOwn)}   bias ${f(bias(supported, own))}`);
  console.log(`    own recent × multiplier MAE ${f(maeScaled)}   bias ${f(bias(supported, scaled))}`);
  console.log(`    improvement ${f(deltaB)}  (${pct(deltaB, maeOwn)} of baseline MAE)`);
  console.log(`    90% player-clustered interval on (scaled − own) MAE: [${f(ciB?.lo)}, ${f(ciB?.hi)}]`);
  console.log(`    ${deltaB > 0 ? 'improves' : 'does not improve'}; interval ${excludesZero(ciB) ? 'excludes' : 'straddles'} zero`);
  console.log(`    a backup who has already taken over is counted twice here; read it with that in mind.`);

  // Not a scored test — a sanity scan. A ratio has no upper bound when the
  // with-starter base is small, and `cascades()` skips a pair only when BOTH
  // sides are under 0.5, so a thin denominator can publish an absurd multiplier.
  const mults = supported.map(x => x.multiplier).sort((a, b) => a - b);
  const wild = supported.filter(x => x.multiplier > 3);
  const qbRows = r.graded.filter(x => x.position === 'QB').length;
  console.log(`\n  Sanity scan of the published multipliers on these rows:`);
  console.log(`    median ${f(mults[mults.length >> 1], 2)}   max ${f(mults[mults.length - 1], 2)}   above 3.0: ${wild.length}`);
  for (const x of wild.slice(0, 3)) {
    console.log(`      ${x.player} (${x.position}) behind ${x.starter}: ×${f(x.multiplier, 2)} on a ${f(x.published_with, 2)} base`);
  }
  console.log(`    quarterbacks: ${qbRows} of ${r.graded.length} graded rows`);
  console.log(`    distinct beneficiaries: ${new Set(r.graded.map(x => x.player_id)).size}\n`);

  report.seasons.push({
    season, graded_rows: r.graded.length, absences: r.absences, starters: r.starters,
    distinct_beneficiaries: new Set(r.graded.map(x => x.player_id)).size,
    qb_rows: qbRows, max_multiplier: mults[mults.length - 1], multipliers_above_3: wild.length,
    rows_with_multiplier: supported.length, multipliers_withheld: withheld,
    test_a: { mae_with: maeWith, mae_without: maeWithout, delta: deltaA,
      delta_pct: maeWith > 0 ? deltaA / maeWith : null, interval: ciA,
      interval_excludes_zero: excludesZero(ciA) },
    test_b: { rows: supported.length, mae_own: maeOwn, mae_own_scaled: maeScaled, delta: deltaB,
      delta_pct: maeOwn > 0 ? deltaB / maeOwn : null, interval: ciB,
      interval_excludes_zero: excludesZero(ciB) },
    in_sample_gain_scale: lambda
  });
}

const decided = report.seasons.filter(s => s.test_a?.interval);
const passes = decided.length === GRADED_SEASONS.length
  && decided.every(s => s.test_a.delta > 0 && s.test_a.interval_excludes_zero);
report.verdict = passes ? 'earns a surface' : 'refused';

console.log('=== verdict ===');
console.log(passes
  ? '  PASSES the pre-registered bar on TEST A: better in every graded season, interval excludes zero.'
  : '  REFUSED by the pre-registered bar on TEST A. The published without-starter number does not\n  earn a place on a surviving surface.');
console.log('  This grades accuracy only. It says nothing about whether the split is well constructed —');
console.log('  it is carefully built — and a pass would not be a reason to restore a deleted page.');

if (ROWS_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(ROWS_OUT, JSON.stringify(allRows, null, 1));
  console.log(`\n  wrote ${ROWS_OUT} (${allRows.length} graded rows)`);
}
if (JSON_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  console.log(`  wrote ${JSON_OUT}`);
}
