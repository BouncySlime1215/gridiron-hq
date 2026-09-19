#!/usr/bin/env node
/**
 * Does the combined Team Outlook model beat every baseline, or not?
 *
 *   node scripts/audit-team-outlook.mjs [--json]
 *
 * The rule this scores against is `docs/tdd/team-outlook.tdd.md`, committed before the fit.
 * This script does not get to decide what passing means; it reports the four pre-registered
 * conditions and their verdict.
 *
 *   G1  held-out Brier below all four baselines, every week 2-8, both test seasons
 *   G2  the advantage over the STRONGEST baseline has a 90% interval excluding zero,
 *       bootstrapped with clusters by league
 *   G3  expected calibration error at most 0.03, every week, both seasons
 *   G4  fitted signs agree with the direction of the world
 *
 * WHY THE BOOTSTRAP IS CLUSTERED BY LEAGUE. Team-seasons inside one league share opponents
 * and a schedule; treating them as independent units would shrink every interval by roughly
 * the square root of the league size and manufacture significance. This is the same reason
 * the availability gate clusters by player.
 */
import { weeklyPanel, varianceComponents, historyStatus, excludedByDataQuality, shrinkToLeague }
  from '../server/services/history-corpus.js';
import { fitOutlook, predictOutlook, signCheck, OUTLOOK_GATE, OUTLOOK_FEATURES, fitThresholds, verdictFor, decompose }
  from '../server/services/team-outlook.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';

const JSON_OUT = process.argv.includes('--json');
const FIT_SEASONS = [2021, 2022, 2023];
const TEST_SEASONS = [2024, 2025];
const WEEKS = OUTLOOK_GATE.weeks;
const BINS = OUTLOOK_GATE.bins;

const c = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };
const PASS = s => c.g(s), FAIL = s => c.r(s);

const status = historyStatus();
if (!status.available) { console.error(status.reason); process.exit(1); }

const fitPanel = weeklyPanel({ seasons: FIT_SEASONS });
const vc = varianceComponents({ panel: fitPanel });
const k = vc.k;
const fit = fitOutlook({ panel: fitPanel, k });
const thresholds = fitThresholds({ fit, panel: fitPanel });

/**
 * Each baseline is a single feature turned into a probability by fit-set equal-count
 * deciles -- identical treatment to the early-signal audit, so a baseline is never
 * handicapped by being given a worse model class than the candidate.
 */
function binnedBaseline(feature, week) {
  const rows = fitPanel.filter(r => r.week === week);
  const valueOf = r => feature === 'points_shrunk'
    ? shrinkToLeague(r.mean_points_z ?? 0, r.games ?? 0, k)
    : (r[feature] ?? 0.5);
  const sorted = [...rows].sort((a, b) => valueOf(a) - valueOf(b));
  const per = Math.max(1, Math.floor(sorted.length / BINS));
  const edges = [], rates = [];
  for (let b = 0; b < BINS; b++) {
    const lo = b * per;
    const hi = b === BINS - 1 ? sorted.length : (b + 1) * per;
    const slice = sorted.slice(lo, hi);
    if (!slice.length) continue;
    edges.push(valueOf(slice[slice.length - 1]));
    rates.push(slice.reduce((s, r) => s + r.made_playoffs, 0) / slice.length);
  }
  return row => {
    const v = valueOf(row);
    for (let b = 0; b < edges.length; b++) if (v <= edges[b]) return rates[b];
    return rates[rates.length - 1];
  };
}

const baseRate = week => {
  // The league's own playoff share. Knows nothing about the team.
  const rows = fitPanel.filter(r => r.week === week);
  const byShare = new Map();
  for (const r of rows) {
    const key = (r.playoff_teams / r.num_teams).toFixed(3);
    const t = byShare.get(key) ?? { n: 0, y: 0 };
    t.n++; t.y += r.made_playoffs; byShare.set(key, t);
  }
  return row => {
    const key = (row.playoff_teams / row.num_teams).toFixed(3);
    const t = byShare.get(key);
    return t ? t.y / t.n : row.playoff_teams / row.num_teams;
  };
};

const brier = (p, y) => (p - y) ** 2;

function ece(pairs) {
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  const per = Math.max(1, Math.floor(sorted.length / BINS));
  let total = 0, n = 0;
  for (let b = 0; b < BINS; b++) {
    const lo = b * per, hi = b === BINS - 1 ? sorted.length : (b + 1) * per;
    const slice = sorted.slice(lo, hi);
    if (!slice.length) continue;
    const meanP = slice.reduce((s, r) => s + r.p, 0) / slice.length;
    const obs = slice.reduce((s, r) => s + r.y, 0) / slice.length;
    total += slice.length * Math.abs(meanP - obs); n += slice.length;
  }
  return n ? total / n : null;
}

const report = { k, exclusions: excludedByDataQuality(), thresholds, seasons: {}, gate: {} };

/**
 * FIT-season calibration, which is what the pre-registered rule keys the isotonic layer on.
 * The document permits a calibration layer only if the RAW model misses 0.03 on the seasons
 * it was fitted on -- never in response to a test season's number, because that is fitting on
 * held-out data. So this has to be measured before any decision about a layer, and it is
 * measured here rather than after seeing the test result.
 */
function fitSeasonEce(week) {
  const rows = fitPanel.filter(r => r.week === week);
  const pairs = rows.map(r => ({ p: predictOutlook(fit, r), y: r.made_playoffs })).filter(x => x.p != null);
  return pairs.length ? ece(pairs) : null;
}
const failures = [];

console.log(c.b(`Team Outlook gate  ${status.leagues} leagues, ${status.team_seasons} team-seasons`));
console.log(`k = ${k}   fit ${FIT_SEASONS.join(', ')}   test ${TEST_SEASONS.join(', ')} separately`);
console.log(c.dim(`thresholds fitted on the fit seasons: watch <= ${thresholds.watch}, act_candidate <= ${thresholds.act_candidate}`));
console.log();

// ---- G4, once per week, on the fit itself.
console.log(c.b('Fit-season calibration  (decides whether a calibration layer is permitted at all)'));
{
  const rowsOut = [];
  let anyOver = false;
  for (const week of WEEKS) {
    const e = fitSeasonEce(week);
    report.gate[`fit_ece_wk${week}`] = e;
    if (e != null && e > OUTLOOK_GATE.calibrationMax) anyOver = true;
    rowsOut.push(`wk${week} ${e == null ? '--' : e.toFixed(4)}`);
  }
  console.log('  ' + rowsOut.join('   '));
  report.gate.fit_ece_over_threshold = anyOver;
  console.log(anyOver
    ? `  Over ${OUTLOOK_GATE.calibrationMax} on the fit seasons, so an isotonic layer fitted on them IS permitted by the rule.`
    : `  Within ${OUTLOOK_GATE.calibrationMax} on the fit seasons, so the rule does NOT permit a calibration layer. The raw model is what is scored.`);
  console.log();
}

console.log(c.b('G4  fitted signs'));
for (const week of WEEKS) {
  const weekFit = fit.byWeek[week];
  if (!weekFit) { failures.push(`G4 week ${week}: no fit`); console.log(`  wk${week}  ${FAIL('no fit')}`); continue; }
  const sc = signCheck(weekFit);
  report.gate[`signs_wk${week}`] = sc;
  if (!sc.pass) failures.push(`G4 week ${week}: ${sc.wrong.map(w => `${w.feature} ${w.got}`).join(', ')}`);
  const shown = OUTLOOK_FEATURES.map(f => `${f} ${sc.coefficients[f] >= 0 ? '+' : ''}${sc.coefficients[f].toFixed(3)}`).join('  ');
  console.log(`  wk${String(week).padStart(2)}  ${sc.pass ? PASS('ok  ') : FAIL('FAIL')}  n=${String(weekFit.n).padStart(5)}  ${c.dim(shown)}`);
}
console.log();

// ---- G1, G2, G3 per test season.
for (const season of TEST_SEASONS) {
  const panel = weeklyPanel({ seasons: [season] });
  console.log(c.b(`${season} held out`));
  console.log(c.dim('  wk      n   combined   base   all_play   shrunk   win_pct  | strongest baseline   advantage  ci90              ece'));
  report.seasons[season] = {};

  for (const week of WEEKS) {
    const rows = panel.filter(r => r.week === week);
    if (!rows.length) { console.log(`  wk${week}  ${FAIL('no rows')}`); failures.push(`week ${week} ${season}: no rows`); continue; }

    const preds = {
      combined: rows.map(r => predictOutlook(fit, r)),
      base_rate: rows.map(baseRate(week)),
      all_play_pct: rows.map(binnedBaseline('all_play_pct', week)),
      points_shrunk: rows.map(binnedBaseline('points_shrunk', week)),
      win_pct: rows.map(binnedBaseline('win_pct', week))
    };
    if (preds.combined.some(p => p == null)) { failures.push(`week ${week} ${season}: no model`); continue; }

    const y = rows.map(r => r.made_playoffs);
    const perRow = name => preds[name].map((p, i) => brier(p, y[i]));
    const meanOf = a => a.reduce((s, v) => s + v, 0) / a.length;
    const scores = Object.fromEntries(Object.keys(preds).map(nm => [nm, meanOf(perRow(nm))]));

    // Strongest baseline: the best any of them managed, which is what must be beaten.
    let strongest = null;
    for (const nm of OUTLOOK_GATE.baselines) if (!strongest || scores[nm] < scores[strongest]) strongest = nm;

    const beatsAll = OUTLOOK_GATE.baselines.every(nm => scores.combined < scores[nm]);
    const boot = pairedBootstrapDiff(perRow(strongest), perRow('combined'), {
      iterations: OUTLOOK_GATE.bootstrapIterations, seed: OUTLOOK_GATE.bootstrapSeed,
      groups: rows.map(r => r.league_id)
    });
    const sig = !boot?.error && boot.ci90[1] < 0;   // combined strictly better across the interval
    const calib = ece(preds.combined.map((p, i) => ({ p, y: y[i] })));
    const calibOk = calib != null && calib <= OUTLOOK_GATE.calibrationMax;

    if (!beatsAll) failures.push(`G1 week ${week} ${season}: ${strongest} at ${scores[strongest].toFixed(4)} vs combined ${scores.combined.toFixed(4)}`);
    if (!sig) failures.push(`G2 week ${week} ${season}: ci90 ${boot?.error ?? `[${boot.ci90[0].toFixed(4)}, ${boot.ci90[1].toFixed(4)}]`}`);
    if (!calibOk) failures.push(`G3 week ${week} ${season}: ece ${calib?.toFixed(4)}`);

    // The FALLBACK's calibration. Not a gate condition -- the pre-registered fallback is "the
    // best single validated signal" and says nothing about its ECE -- but shipping a fallback
    // without knowing whether it is calibrated would be exactly the kind of unexamined
    // substitution the gate exists to prevent.
    const baselineEce = Object.fromEntries(OUTLOOK_GATE.baselines.map(nm =>
      [nm, ece(preds[nm].map((p, i) => ({ p, y: y[i] })))]));

    report.seasons[season][week] = { n: rows.length, scores, strongest, beatsAll, bootstrap: boot, ece: calib, baseline_ece: baselineEce };
    const f = v => v.toFixed(4);
    console.log(`  ${String(week).padStart(2)}  ${String(rows.length).padStart(5)}` +
      `   ${(beatsAll ? PASS(f(scores.combined)) : FAIL(f(scores.combined)))}` +
      `   ${f(scores.base_rate)}  ${f(scores.all_play_pct)}   ${f(scores.points_shrunk)}   ${f(scores.win_pct)}` +
      `  | ${strongest.padEnd(14)} ${(scores[strongest] - scores.combined >= 0 ? '+' : '')}${f(scores[strongest] - scores.combined)}` +
      `  ${boot?.error ? FAIL('n/a') : `${sig ? PASS('') : FAIL('')}[${f(boot.ci90[0])}, ${f(boot.ci90[1])}]`}` +
      `  ${calibOk ? PASS(f(calib)) : FAIL(f(calib))}` +
      `  ${c.dim('all_play ' + f(baselineEce.all_play_pct))}`);
  }
  console.log();
}

// ---- The verdict's own separation, on held-out seasons.
console.log(c.b('Verdict separation, held out  (validated: worse verdicts finish worse)'));
for (const season of TEST_SEASONS) {
  const panel = weeklyPanel({ seasons: [season] });
  for (const week of [3, 6]) {
    const rows = panel.filter(r => r.week === week);
    const groups = { fine: [], watch: [], act_candidate: [] };
    for (const r of rows) {
      const v = verdictFor(predictOutlook(fit, r), thresholds);
      if (v) groups[v].push(r.made_playoffs);
    }
    const line = Object.entries(groups).map(([v, ys]) =>
      `${v} ${ys.length ? (ys.reduce((s, y) => s + y, 0) / ys.length * 100).toFixed(1) : '--'}% (n=${ys.length})`).join('   ');
    console.log(`  ${season} wk${week}   ${line}`);
    report.seasons[season][`verdict_wk${week}`] = Object.fromEntries(Object.entries(groups).map(([v, ys]) =>
      [v, { n: ys.length, playoff_rate: ys.length ? +(ys.reduce((s, y) => s + y, 0) / ys.length).toFixed(4) : null }]));
  }
}
console.log();

// ---- The decomposition identity, checked on real rows rather than asserted.
const sample = weeklyPanel({ seasons: [2025] }).filter(r => r.week === 4).slice(0, 500);
let worst = 0;
for (const r of sample) {
  const d = decompose(fit, r);
  if (d) worst = Math.max(worst, Math.abs(d.luck + d.noise + d.real - d.total));
}
console.log(`Decomposition identity on ${sample.length} real rows: worst |luck+noise+real - total| = ${worst.toExponential(1)}`);
report.decomposition_worst_residual = worst;
console.log();

// ---- Reliability for the worst-calibrated week, so a reader can tell systematic
// over-confidence from a noisy diagonal. This DIAGNOSES the failure; it does not excuse it.
{
  let worstWeek = null, worstSeason = null, worstEce = -1;
  for (const season of TEST_SEASONS) for (const week of WEEKS) {
    const e = report.seasons[season]?.[week]?.ece;
    if (e != null && e > worstEce) { worstEce = e; worstWeek = week; worstSeason = season; }
  }
  if (worstWeek != null) {
    const rows = weeklyPanel({ seasons: [worstSeason] }).filter(r => r.week === worstWeek);
    const pairs = rows.map(r => ({ p: predictOutlook(fit, r), y: r.made_playoffs })).filter(x => x.p != null);
    pairs.sort((a, b) => a.p - b.p);
    const per = Math.max(1, Math.floor(pairs.length / BINS));
    console.log(c.b(`Reliability, ${worstSeason} week ${worstWeek}  (the worst, ece ${worstEce.toFixed(4)})`));
    console.log(c.dim('  decile   predicted   observed   gap      n'));
    for (let b = 0; b < BINS; b++) {
      const lo = b * per, hi = b === BINS - 1 ? pairs.length : (b + 1) * per;
      const slice = pairs.slice(lo, hi);
      if (!slice.length) continue;
      const mp = slice.reduce((s, r) => s + r.p, 0) / slice.length;
      const ob = slice.reduce((s, r) => s + r.y, 0) / slice.length;
      const gap = ob - mp;
      console.log(`  ${String(b + 1).padStart(6)}      ${mp.toFixed(4)}     ${ob.toFixed(4)}   ${(gap >= 0 ? '+' : '')}${gap.toFixed(4)}  ${String(slice.length).padStart(5)}`);
    }
    console.log();
  }
}

report.failures = failures;
report.passed = failures.length === 0;

console.log(c.b('VERDICT'));
if (failures.length === 0) {
  console.log(PASS('  The gate passes. All four conditions hold at every week 2-8 in both held-out seasons.'));
} else {
  console.log(FAIL(`  The gate FAILS on ${failures.length} condition${failures.length === 1 ? '' : 's'}.`));
  for (const f of failures.slice(0, 30)) console.log(FAIL(`    ${f}`));
  if (failures.length > 30) console.log(FAIL(`    ... and ${failures.length - 30} more`));
  console.log();
  console.log('  Per the pre-registered stopping rule, the model that ships instead is the best');
  console.log('  single validated signal, labelled as such. No feature is added and no week is');
  console.log('  dropped from the range.');
}

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
process.exitCode = 0;
