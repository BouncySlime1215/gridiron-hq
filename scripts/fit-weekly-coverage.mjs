#!/usr/bin/env node
/**
 * Build Order 1.2, measured week-by-week — make the 80% interval cover 80%, honestly.
 *
 * Fits the weekly parameter-uncertainty draw (see WEEKLY_LEVEL in projections.js)
 * on 2023 + 2024 and validates on 2025, once. Two pre-registered candidates, both
 * on the MEAN-PRESERVING shock, exp(sigma Z) / E[exp(sigma Z)]:
 *   A  one global (sigma, downMult)
 *   B  a sigma per position (QB/RB/WR/TE), downMult fixed at A's
 * Selection on the fit seasons (rule R, see ruleR below): among settings whose 80%
 * coverage is in [0.78, 0.82], the flattest PIT (lowest calibration error), ties
 * within 0.001 to lower CRPS; if none is in the band, the coverage closest to 0.80.
 *
 * Gate on 2025, each candidate against whatever WEEKLY_LEVEL currently ships:
 *   G1  coverage_80 in [0.78, 0.82]
 *   G2  calibration error strictly lower than the shipped setting's
 *   G3  CRPS not worse: NOT (significant AND worse) in a player-clustered paired
 *       bootstrap (backtest-significance.js pairedBootstrapDiff, 90% CI, 4000 draws)
 * Both pass -> B only if its calibration error beats A's and its CRPS is not
 * significantly worse than A's; otherwise A (fewer parameters). Neither -> nothing.
 *
 * Usage: node scripts/fit-weekly-coverage.mjs             fit + the one 2025 validation
 *        node scripts/fit-weekly-coverage.mjs --fit-only  never touches 2025
 *        add --json <path> to write every number printed to a file
 */
process.env.SCHEDULER_DISABLED ??= '1';
const { replaySeasonWeekly } = await import('../server/services/weekly-backtest.js');
const { WEEKLY_ROLE_RECENCY, weeklyEnsemblePrediction } = await import('../server/services/weekly-ensemble.js');
const { activeWeeklyWeightSet } = await import('../server/services/weekly-weight-store.js');
const { WEEKLY_LEVEL, buildProjections, sampleWeeks } = await import('../server/services/projections.js');
const { tradeWeekContext } = await import('../server/services/trade-engine.js');
const { pairedBootstrapDiff } = await import('../server/services/backtest-significance.js');
const { random, withRandomSeed } = await import('../server/services/stats-util.js');
const { PPR } = await import('../server/services/scoring.js');
const { writeFileSync } = await import('node:fs');

/*
 * PRODUCTION CONFIGURATION, and it changes the answer. This script used to call
 * replaySeasonWeekly with no kOverride, no roleRecency and no predictionHead. That
 * is not what production runs: weekly-backtest defaults kOverride to null (which
 * projections.js reads as "suppress activeKVector()", since it only defaults on
 * `undefined`), leaves the role recency off, and — with no head — centres the
 * sampled distribution on the STRUCTURAL head with shift 0, while production
 * centres it on the ensemble. Measured on 2025 at sigma 0.45: as-fitted coverage
 * 0.795; production k + role recency on the structural head 0.765, OUTSIDE the
 * [0.78, 0.82] gate; production k + role recency + ensemble head 0.789. The
 * shipped combination happens to land back inside the gate, but the cited figure
 * was measured on a model the app does not run.
 *
 * The centring head is the LIVE champion — activeWeeklyWeightSet(tradeWeekContext()),
 * the weights production uses this week — on every replayed season. It used to be
 * activeWeeklyWeightSet({ season, week: 5 }) per replayed season. That is cutoff-clean,
 * but the only promoted fit (fit-1) is trained through 2025 W18, so it resolved to the
 * frozen 2023 WEEKLY_ENSEMBLE_WEIGHTS on 2023, 2024 AND 2025: the spread was fitted
 * around a centre production has not run since fit-1 was promoted, and the right
 * spread depends on how accurate the centre is. Cost, stated rather than hidden:
 * fit-1 was trained on 2023-2025, so the centre is mildly in-sample on every replayed
 * season (5 global weights). The spread is the only thing fitted here, on 2023 + 2024.
 */
const LIVE = tradeWeekContext();
const champion = activeWeeklyWeightSet(LIVE);
const production = () => ({
  kOverride: undefined /* cutoff-safe default: shrinkage-fit.js cutoffSafeKVector */, roleRecency: WEEKLY_ROLE_RECENCY,
  predictionHead: ctx => weeklyEnsemblePrediction(ctx, champion.weights),
});

const FIT_SEASONS = [2023, 2024];
const VALIDATION_SEASON = 2025;
const TARGET = 0.80, GATE = [0.78, 0.82];
const RUNS = 300;
const SEED = 20260826;              // replaySeasonWeekly's default seed, so the evaluator below matches it draw for draw
const BOOT = { seed: 20260917, iterations: 4000 };
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const FIT_ONLY = process.argv.includes('--fit-only');
const JSON_OUT = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

// Every grid point is the mean-preserving shock with no per-position override, spelled
// out in full so a setting means the same thing whatever WEEKLY_LEVEL currently ships.
const grid = [];
for (const sigma of [0, 0.10, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.70, 0.80]) {
  for (const downMult of [1.0, 1.3, 1.6]) {
    if (sigma === 0 && downMult !== 1.0) continue;      // downMult is inert at sigma 0
    grid.push({ sigma, downMult, meanPreserving: true, byPosition: null });
  }
}

/*
 * SELECTION — rule R. This used to rank on 10 * |coverage - 0.80| + calibration
 * error. The 10x was hand-picked and it picked the winner (0.45 over 0.35 / 1.6,
 * which had FLATTER PIT), and it did so on the old shock, `exp(z * sigma)`, which is
 * not mean-preserving: it inflated every simulated week ~10% at 0.45 and bought
 * coverage by fattening the right tail while degrading PIT. Now the shock is
 * mean-preserving on every grid point, coverage is a hard band, and PIT flatness
 * decides inside it. CRPS (a proper score) breaks ties and is printed, but is not
 * the criterion: on the fit seasons it is lowest at sigma 0 and rises with sigma,
 * i.e. on its own it would pick an interval covering ~75% — narrower than honest.
 * Sensitivity is printed below: the in-band CRPS argmin and the old score's argmin.
 */
const inBand = cov => cov >= GATE[0] && cov <= GATE[1];
function ruleR(cands) {
  const band = cands.filter(c => inBand(c.cov));
  if (!band.length) return [...cands].sort((a, b) => Math.abs(a.cov - TARGET) - Math.abs(b.cov - TARGET))[0];
  const minCal = Math.min(...band.map(c => c.cal));
  return band.filter(c => c.cal <= minCal + 0.001).sort((a, b) => a.crps - b.crps)[0];
}

/*
 * PER-ROW EVALUATOR. replaySeasonWeekly reports only pooled PIT metrics, and the
 * per-position candidate needs them by position. This mirrors its distribution
 * block exactly — the rows it grades (taken from its own _predictions), the same
 * buildProjections arguments, shift = head - structural, the clamp at 0, randomized
 * PIT, CRPS, and the same seed and draw order — so it reproduces the harness to the
 * last digit (checked on 2024 at three settings: coverage, calibration error, CRPS
 * and all ten PIT bins identical). The validation re-asserts that on 2025.
 */
function seasonRows(season) {
  const r = replaySeasonWeekly(season, { ...production(), distributions: false });
  const byWeek = new Map();
  for (const p of r._predictions) {
    if (!byWeek.has(p.week)) byWeek.set(p.week, []);
    byWeek.get(p.week).push(p);
  }
  const out = [];
  for (const [week, preds] of [...byWeek].sort((a, b) => a[0] - b[0])) {
    const proj = buildProjections({ through: season, throughWeek: week - 1, scoring: PPR,
      kOverride: production().kOverride, roleRecency: WEEKLY_ROLE_RECENCY });
    for (const p of preds) {
      const pr = proj.get(p.player_id);
      if (!pr || Math.abs(pr.ppg - p.structural) > 1e-9) throw new Error(`projection mismatch ${p.player_id} ${season} W${week}`);
      out.push({ player_id: p.player_id, week, position: p.position, prediction: p.prediction,
        structural: p.structural, actual: p.actual, params: pr.params });
    }
  }
  return out;
}
function pitOf(samples, y) {                    // weekly-backtest.js randomizedPit
  let below = 0, equal = 0;
  for (const s of samples) { if (s < y) below++; else if (s === y) equal++; }
  return (below + random() * equal) / samples.length;
}
function crpsOf(samples, y) {                   // weekly-backtest.js crpsRaw
  const n = samples.length, s = [...samples].sort((a, b) => a - b);
  let t1 = 0; for (const x of s) t1 += Math.abs(x - y); t1 /= n;
  let t2 = 0; for (let i = 0; i < n; i++) t2 += s[i] * (2 * i - n + 1);
  return t1 - t2 / (n * n);
}
function scoreRows(rows, level) {
  return withRandomSeed(SEED, () => rows.map(r => {
    const shift = r.prediction - r.structural;
    const s = sampleWeeks(r.params, RUNS, PPR, 1, 1, level).map(v => Math.max(0, v + shift));
    return { pit: pitOf(s, r.actual), crps: crpsOf(s, r.actual), sim_mean: s.reduce((a, b) => a + b, 0) / s.length };
  }));
}
function summarize(scored, idx = null) {
  const pick = idx ? idx.map(i => scored[i]) : scored;
  const n = pick.length;
  if (!n) return null;
  const bins = new Array(10).fill(0);
  for (const x of pick) bins[Math.min(9, Math.floor(x.pit * 10))]++;
  const e = n / 10;
  return { n, coverage_80: pick.filter(x => x.pit >= 0.1 && x.pit <= 0.9).length / n,
    calibration_error: bins.reduce((s, b) => s + Math.abs(b - e), 0) / 10 / e,
    crps: pick.reduce((s, x) => s + x.crps, 0) / n, pit_histogram: bins };
}
const indexWhere = (rows, f) => rows.map((r, i) => (f(r) ? i : -1)).filter(i => i >= 0);
const avg = (xs, f) => xs.reduce((s, x) => s + f(x), 0) / xs.length;
const f3 = x => x.toFixed(3);
const report = { live: LIVE, champion: champion.id, shipped: WEEKLY_LEVEL };

console.log(`Centring head: ${champion.id} = activeWeeklyWeightSet(${LIVE.season} W${LIVE.week}); ` +
  `shipped WEEKLY_LEVEL ${JSON.stringify(WEEKLY_LEVEL)}.`);
console.log(`Sweeping ${grid.length} mean-preserving settings on ${FIT_SEASONS.join(' + ')}.\n`);

const fitRows = Object.fromEntries(FIT_SEASONS.map(s => [s, seasonRows(s)]));
function fitMetrics(level) {
  const per = FIT_SEASONS.map(s => {
    const rows = fitRows[s], scored = scoreRows(rows, level);
    return { all: summarize(scored),
      pos: Object.fromEntries(POSITIONS.map(p => [p, summarize(scored, indexWhere(rows, r => r.position === p))])) };
  });
  const agg = get => ({ cov: avg(per, x => get(x).coverage_80), cal: avg(per, x => get(x).calibration_error), crps: avg(per, x => get(x).crps) });
  return { level, ...agg(x => x.all), pos: Object.fromEntries(POSITIONS.map(p => [p, agg(x => x.pos[p])])) };
}
const results = grid.map(fitMetrics);

console.log('FIT seasons (mean of per-season metrics); per position: coverage/calibration');
console.log('  sigma  down | coverage  calib   crps  | ' + POSITIONS.map(p => p.padEnd(11)).join(' '));
for (const r of results) {
  console.log(`  ${r.level.sigma.toFixed(2)}   ${r.level.downMult.toFixed(1)}  |  ${f3(r.cov)}   ${f3(r.cal)}  ${f3(r.crps)} | ` +
    POSITIONS.map(p => `${f3(r.pos[p].cov)}/${f3(r.pos[p].cal)}`).join(' '));
}

const A = ruleR(results);
const B = Object.fromEntries(POSITIONS.map(p => [p, ruleR(results
  .filter(r => r.level.downMult === A.level.downMult)
  .map(r => ({ level: r.level, ...r.pos[p] })))]));
const levelA = { sigma: A.level.sigma, downMult: A.level.downMult, meanPreserving: true, byPosition: null };
const levelB = { ...levelA, byPosition: Object.fromEntries(POSITIONS.map(p => [p, B[p].level.sigma])) };
const fitB = fitMetrics(levelB);
const crpsArgmin = results.filter(r => inBand(r.cov)).sort((a, b) => a.crps - b.crps)[0];
const oldArgmin = [...results].sort((a, b) =>
  (Math.abs(a.cov - TARGET) * 10 + a.cal) - (Math.abs(b.cov - TARGET) * 10 + b.cal))[0];
console.log(`\nA (rule R, global):        ${JSON.stringify(levelA)}  fit cov ${f3(A.cov)} cal ${f3(A.cal)} crps ${f3(A.crps)}`);
console.log(`B (rule R, per position):  ${JSON.stringify(levelB.byPosition)}  fit cov ${f3(fitB.cov)} cal ${f3(fitB.cal)} crps ${f3(fitB.crps)}`);
console.log(`  sensitivity: in-band CRPS argmin ${JSON.stringify({ sigma: crpsArgmin?.level.sigma, downMult: crpsArgmin?.level.downMult })}, ` +
  `old 10x score argmin ${JSON.stringify({ sigma: oldArgmin.level.sigma, downMult: oldArgmin.level.downMult })}`);
Object.assign(report, { fit: results, A: { level: levelA, fit: A }, B: { level: levelB, fit: fitB, per_position: B },
  sensitivity: { crps_argmin: crpsArgmin?.level, old_score_argmin: oldArgmin.level } });

if (FIT_ONLY) {
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
  console.log('\n--fit-only: 2025 not touched.');
  process.exit(0);
}

console.log(`\n=== VALIDATION on ${VALIDATION_SEASON} (never used to fit; run once) ===`);
const harness = level => replaySeasonWeekly(VALIDATION_SEASON, { ...production(), distributions: true, runs: RUNS, level });
const levels = { shipped: { ...WEEKLY_LEVEL }, A: levelA, B: levelB };
const H = Object.fromEntries(Object.entries(levels).map(([k, level]) => [k, harness(level)]));
const valRows = seasonRows(VALIDATION_SEASON);
const key = r => `${r.player_id}|${r.week}`;
const S = {};
for (const [k, h] of Object.entries(H)) {
  // Same graded rows in the same order in every replay (only the draws differ), and
  // the per-row evaluator must reproduce the harness before its rows are trusted.
  if (h._predictions.length !== valRows.length || h._predictions.some((p, i) => key(p) !== key(valRows[i]))) {
    throw new Error(`graded rows differ for ${k}`);
  }
  S[k] = scoreRows(valRows, levels[k]);
  const e = summarize(S[k]), d = h.distribution;
  if (f3(e.coverage_80) !== f3(d.coverage_80) || f3(e.calibration_error) !== f3(d.calibration_error) ||
      f3(e.crps) !== f3(d.crps) || e.pit_histogram.join() !== d.pit_histogram.join()) {
    throw new Error(`evaluator does not reproduce the harness for ${k}: ${JSON.stringify({ e, d })}`);
  }
}
const groups = valRows.map(r => r.player_id);
function calibrationBootstrap(base, cand) {    // report-only: is the PIT-flatness change bigger than resampling noise?
  const byGroup = new Map();
  groups.forEach((g, i) => { if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(i); });
  const lists = [...byGroup.values()];
  const iters = 2000;
  const diffs = withRandomSeed(BOOT.seed, () => Array.from({ length: iters }, () => {
    const idx = [];
    for (let g = 0; g < lists.length; g++) idx.push(...lists[Math.floor(random() * lists.length)]);
    return summarize(cand, idx).calibration_error - summarize(base, idx).calibration_error;
  })).sort((a, b) => a - b);
  return { mean_diff: summarize(cand).calibration_error - summarize(base).calibration_error,
    ci90: [diffs[Math.floor(0.05 * iters)], diffs[Math.floor(0.95 * iters)]] };
}
function gate(name, baseKey = 'shipped') {
  const d = H[name].distribution, b = H[baseKey].distribution;
  const crpsBoot = pairedBootstrapDiff(H[baseKey]._errors.crps, H[name]._errors.crps, { ...BOOT, groups });
  const g1 = inBand(d.coverage_80), g2 = d.calibration_error < b.calibration_error;
  const g3 = !(crpsBoot.significant && crpsBoot.mean_diff > 0);
  return { name, vs: baseKey, pass: g1 && g2 && g3, g1, g2, g3, crps_boot: crpsBoot, cal_boot: calibrationBootstrap(S[baseKey], S[name]) };
}
const tiers = [['0-4', 0, 4], ['4-8', 4, 8], ['8-12', 8, 12], ['12+', 12, Infinity]];
console.log('  setting  | coverage  calib   crps  | sim mean  (head mean, actual mean) | PIT histogram');
const actualMean = avg(valRows, r => r.actual), headMean = avg(valRows, r => r.prediction);
for (const k of Object.keys(H)) {
  const d = H[k].distribution;
  console.log(`  ${k.padEnd(8)} |  ${f3(d.coverage_80)}   ${f3(d.calibration_error)}  ${f3(d.crps)} |  ${avg(S[k], x => x.sim_mean).toFixed(2)}` +
    `     (${headMean.toFixed(2)}, ${actualMean.toFixed(2)})        | ${d.pit_histogram.join(' ')}`);
}
console.log(`  (n = ${valRows.length} player-weeks; each PIT bin should hold ~${Math.round(valRows.length / 10)})`);
const slices = [...POSITIONS.map(p => [p, indexWhere(valRows, r => r.position === p)]),
  ...tiers.map(([label, lo, hi]) => [`proj ${label}`, indexWhere(valRows, r => r.prediction >= lo && r.prediction < hi)])];
console.log('\n  slice      n    | ' + Object.keys(H).map(k => `${k} cov/cal`.padEnd(16)).join(' '));
const sliceReport = {};
for (const [label, idx] of slices) {
  sliceReport[label] = Object.fromEntries(Object.keys(H).map(k => [k, summarize(S[k], idx)]));
  console.log(`  ${label.padEnd(9)} ${String(idx.length).padStart(5)}  | ` +
    Object.keys(H).map(k => `${f3(sliceReport[label][k].coverage_80)}/${f3(sliceReport[label][k].calibration_error)}`.padEnd(16)).join(' '));
}

const gA = gate('A'), gB = gate('B');
for (const g of [gA, gB]) {
  console.log(`\n  ${g.name} vs ${g.vs}: G1 coverage in band ${g.g1 ? 'PASS' : 'FAIL'} | G2 calibration lower ${g.g2 ? 'PASS' : 'FAIL'} | ` +
    `G3 CRPS not worse ${g.g3 ? 'PASS' : 'FAIL'} (mean diff ${g.crps_boot.mean_diff}, 90% CI ${JSON.stringify(g.crps_boot.ci90)}) => ${g.pass ? 'PASS' : 'FAIL'}`);
  console.log(`     report-only: calibration error change ${f3(g.cal_boot.mean_diff)}, player-clustered 90% CI [${g.cal_boot.ci90.map(f3).join(', ')}]`);
}
let ship = null, bVsA = null;
if (gA.pass && gB.pass) {
  bVsA = gate('B', 'A');
  ship = H.B.distribution.calibration_error < H.A.distribution.calibration_error && bVsA.g3 ? 'B' : 'A';
  console.log(`\n  B vs A: calibration ${f3(H.B.distribution.calibration_error)} vs ${f3(H.A.distribution.calibration_error)}, ` +
    `CRPS diff ${bVsA.crps_boot.mean_diff} (90% CI ${JSON.stringify(bVsA.crps_boot.ci90)})`);
} else if (gA.pass) ship = 'A';
else if (gB.pass) ship = 'B';
const adopt = ship && (ship === 'A' ? { sigma: levelA.sigma, downMult: levelA.downMult, meanPreserving: true } : { ...levelB });
console.log(ship
  ? `\nAdopt ${ship} by setting WEEKLY_LEVEL in projections.js to ${JSON.stringify(adopt)}`
  : '\nDo NOT adopt — neither candidate held up out of sample.');
Object.assign(report, { validation: Object.fromEntries(Object.entries(H).map(([k, h]) => [k, { ...h.distribution, sim_mean: avg(S[k], x => x.sim_mean) }])),
  head_mean: headMean, actual_mean: actualMean, slices: sliceReport, gates: { A: gA, B: gB, B_vs_A: bVsA }, ship, adopt });
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
process.exit(0);
