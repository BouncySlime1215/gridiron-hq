#!/usr/bin/env node
/**
 * Build Order 1.3 (and the point-estimate half of 1.2) — fitted week-by-week.
 *
 * The gates were originally specified on season totals, but the model runs
 * weekly in production, so that is how this measures them. Weekly replay also
 * fixes the statistical problem that made the 1.1 fit inconclusive: ~4,300
 * graded player-weeks per season instead of ~380 player-seasons, with no
 * survivorship filter, so a real 2% effect is separable from noise.
 *
 * What is fitted: how fast evidence goes stale (`seasonDecay` across seasons,
 * `weekHalfLife` within the current season). The diagnosis pointing here: the
 * model's compression and its under-prediction of good players both worsened
 * monotonically with history depth, which is what stale evidence looks like.
 *
 * Protocol: fit on 2023 + 2024, validate on 2025 (the frozen-baseline holdout,
 * never used to choose parameters), then a paired bootstrap over player-weeks
 * to confirm the validation-season win is not noise.
 *
 * Usage: node scripts/fit-weekly.mjs
 */
import { replaySeasonWeekly } from '../server/services/weekly-backtest.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';

const FIT_SEASONS = [2023, 2024];
const VALIDATION_SEASON = 2025;
const START_WEEK = 5, END_WEEK = 18;

const grid = [];
for (const seasonDecay of [null, 0.55, 0.35, 0.20, 0.10]) {
  for (const weekHalfLife of [null, 8, 5, 3, 2]) {
    grid.push({ seasonDecay, weekHalfLife });
  }
}

const label = r => `seasonDecay=${r.seasonDecay ?? 'legacy'} weekHalfLife=${r.weekHalfLife ?? 'off'}`;

console.log(`Sweeping ${grid.length} recency settings on ${FIT_SEASONS.join(' + ')} ` +
  `(weeks ${START_WEEK}-${END_WEEK}), validating on ${VALIDATION_SEASON}.\n`);

const results = [];
for (const recency of grid) {
  const per = FIT_SEASONS.map(s =>
    replaySeasonWeekly(s, { startWeek: START_WEEK, endWeek: END_WEEK, recency, distributions: false }));
  const mae = per.reduce((s, r) => s + r.point.model.mae, 0) / per.length;
  const sp = per.reduce((s, r) => s + r.point.model.spearman, 0) / per.length;
  // The baselines don't depend on recency, but report them so the margin is visible.
  const stdMae = per.reduce((s, r) => s + r.point.season_to_date.mae, 0) / per.length;
  results.push({ recency, mae, spearman: sp, stdMae });
}
results.sort((a, b) => a.mae - b.mae);

console.log('Top 10 on the FIT seasons (lower MAE better; baseline = season-to-date avg):');
console.log('  MAE     Spearman   vs baseline   setting');
for (const r of results.slice(0, 10)) {
  const delta = r.mae - r.stdMae;
  console.log(`  ${r.mae.toFixed(4)}  ${r.spearman.toFixed(4)}   ` +
    `${delta > 0 ? '+' : ''}${delta.toFixed(4)}     ${label(r.recency)}`);
}

const best = results[0];
console.log(`\nBest on fit seasons: ${label(best.recency)}`);

console.log(`\n=== VALIDATION on ${VALIDATION_SEASON} (never used to fit) ===`);
const baseline = replaySeasonWeekly(VALIDATION_SEASON,
  { startWeek: START_WEEK, endWeek: END_WEEK, recency: undefined, distributions: false });
const fitted = replaySeasonWeekly(VALIDATION_SEASON,
  { startWeek: START_WEEK, endWeek: END_WEEK, recency: best.recency, distributions: false });

const show = (name, r) => console.log(
  `  ${name.padEnd(22)} MAE ${r.point.model.mae.toFixed(4)}  Spearman ${r.point.model.spearman.toFixed(4)}  ` +
  `| incl-DNP MAE ${r.decision_including_dnp.model.mae.toFixed(4)}`);
show('current (shipped)', baseline);
show('fitted recency', fitted);
console.log(`  ${'season-to-date baseline'.padEnd(22)} MAE ${baseline.point.season_to_date.mae.toFixed(4)}  ` +
  `Spearman ${baseline.point.season_to_date.spearman.toFixed(4)}  ` +
  `| incl-DNP MAE ${baseline.decision_including_dnp.season_to_date.mae.toFixed(4)}`);
console.log(`  ${'blend 60/40 baseline'.padEnd(22)} MAE ${baseline.point.blend.mae.toFixed(4)}  ` +
  `Spearman ${baseline.point.blend.spearman.toFixed(4)}  ` +
  `| incl-DNP MAE ${baseline.decision_including_dnp.blend.mae.toFixed(4)}`);

// Significance of the change itself, and of the model-vs-blend gap that is the actual gate.
const vsShipped = pairedBootstrapDiff(baseline._errors.model, fitted._errors.model, { seed: 7 });
const vsBlend = pairedBootstrapDiff(fitted._errors.blend, fitted._errors.model, { seed: 7 });

console.log('\nPaired bootstrap over player-weeks (90% CI):');
console.log(`  fitted - shipped : ${vsShipped.mean_diff}  CI ${JSON.stringify(vsShipped.ci90)}  ` +
  `${vsShipped.significant ? 'SIGNIFICANT' : 'not distinguishable from noise'}`);
console.log(`  fitted - blend   : ${vsBlend.mean_diff}  CI ${JSON.stringify(vsBlend.ci90)}  ` +
  `${vsBlend.significant ? 'SIGNIFICANT' : 'not distinguishable from noise'}`);

const beatsBlend = vsBlend.mean_diff < 0 && vsBlend.significant;
console.log(`\nGate 1.3 (weekly): model beats the blend on MAE, significantly: ${beatsBlend ? 'PASS' : 'FAIL'}`);
console.log(beatsBlend
  ? `\nAdopt by setting RECENCY in projections.js to ${JSON.stringify(best.recency)}`
  : '\nNot adopting on this evidence alone — see the printed margins for where it stands.');
