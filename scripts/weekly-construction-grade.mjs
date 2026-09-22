/**
 * S-02 runner: the pre-registered grade of the served weekly construction.
 * Pre-registration: docs/evidence/2026-09-22/weekly-construction-grade-preregistration.md
 * Library (arms, metrics, rule): scripts/weekly-construction-grade-lib.mjs
 *
 * Run it on a COPY of the app database, never the original:
 *
 *   sqlite3 ~/gridiron-local/data.sqlite ".backup '<worktree>/.local-db/data.sqlite'"
 *   GRIDIRON_DB_PATH=<worktree>/.local-db/data.sqlite SCHEDULER_DISABLED=1 NFL_SEASON=2026 \
 *     node --max-old-space-size=3072 scripts/weekly-construction-grade.mjs <mode> [--out file.json]
 *
 * Modes:
 *   --smoke           plumbing only: fit on 2022-2023, build 2024 week 6, run every stop
 *                     condition, print row counts. Prints no metric.
 *   --full            the one look at 2025 (weeks 2-4 and 5-17), the 2024 fit split for m0
 *                     and lambda, and the 2026 forward weeks. Refuses to run unless the
 *                     pre-registration is committed and unchanged.
 *   --forward-only    2026 weeks only, for S-03 after week 4: reads lambda from
 *                     --lambda-from <a --full output>, never opens a 2025 grade.
 *
 * Output: aggregates only (no player rows, no league or manager data), labelled
 * "local copy, not production".
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREREG = 'docs/evidence/2026-09-22/weekly-construction-grade-preregistration.md';
const DEFAULT_OUT = 'docs/evidence/2026-09-22/weekly-construction-grade-output.json';
const ORIGINAL_DB = path.join(process.env.HOME ?? '', 'gridiron-local', 'data.sqlite');
const FIT_FROM = 2022;
const HELD_OUT = 2025;
const FIT_SPLIT = 2024;
const FORWARD = 2026;
const WINDOWS = ['2-4', '5-17'];
const PINNED_SENSITIVITY_FIT = 2;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

function preregState() {
  const tracked = git('ls-files', PREREG);
  if (!tracked) throw new Error(`${PREREG} is not committed; pre-register before any number is run`);
  const dirty = git('status', '--porcelain', '--', PREREG);
  if (dirty) throw new Error(`${PREREG} has uncommitted changes; the grade must run against the committed text`);
  return { path: PREREG, commit: git('log', '-1', '--format=%H', '--', PREREG), blob: git('rev-parse', `HEAD:${PREREG}`) };
}

async function main() {
  const mode = ['--smoke', '--full', '--forward-only'].find(m => process.argv.includes(m));
  if (!mode) throw new Error('choose one mode: --smoke, --full or --forward-only');
  if (!process.env.GRIDIRON_DB_PATH) throw new Error('set GRIDIRON_DB_PATH to a COPY of the app database');
  if (path.resolve(process.env.GRIDIRON_DB_PATH) === path.resolve(ORIGINAL_DB)) {
    throw new Error(`refusing to run on ${ORIGINAL_DB}; make a .backup copy first`);
  }
  process.env.SCHEDULER_DISABLED = '1';
  const prereg = mode === '--full' ? preregState() : null;

  const { dbPath, rows: dbRows } = await import('../server/db/index.js');
  const { PPR } = await import('../server/services/scoring.js');
  const { actuals } = await import('../server/services/backtest.js');
  const { buildPlayerWeekEngine, clearPlayerWeekEngineCache } = await import('../server/services/player-week-engine.js');
  const { activeKVectorFor } = await import('../server/services/shrinkage-fit.js');
  const { WEEKLY_ROLE_RECENCY, weeklyEnsemblePrediction } = await import('../server/services/weekly-ensemble.js');
  const { weeklyWeightSetById, activeWeeklyWeightSet } = await import('../server/services/weekly-weight-store.js');
  const { activeFantasyCoordinatorFit, weeklyProjectionFor } = await import('../server/services/fantasy-coordinator.js');
  const { startSitWeekPoints } = await import('../server/services/lineup-brain.js');
  const lib = await import('./weekly-construction-grade-lib.mjs');
  const { SERVED, ARMS, CANDIDATES } = lib;

  const report = {
    unit: 'S-02', mode, label: 'local copy, not production',
    tree: { head: git('rev-parse', 'HEAD'), write_tree: git('write-tree') },
    database: { path_basename: path.basename(dbPath) }, prereg,
    configuration: {
      engine: 'buildPlayerWeekEngine (player-week-engine.js:256), roleRecency WEEKLY_ROLE_RECENCY hardcoded at :273, kOverride omitted',
      scoring: 'PPR', availability: 'none (common factor, graded by S-04)', matchup_mult: 1,
      population: 'weekly-backtest.js rules: QB/RB/WR/TE, >= 1 prior played week; played rows for MAE/Spearman, decision rows (played week-1) for DNP-included MAE',
      bootstrap: 'pairedBootstrapDiff, groups = player_id, 2000 iterations, seed 1, 90% CI'
    },
    started_at: new Date().toISOString()
  };
  const out = arg('--out') ?? (mode === '--full' ? DEFAULT_OUT : null);
  const write = () => { if (out) fs.writeFileSync(path.resolve(ROOT, out), `${JSON.stringify(report, null, 2)}\n`); };
  const log = (...a) => console.log(`[s-02 ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
  const t0 = Date.now();

  // ---- Stop condition 1: the k control (rule 3).
  report.k_control = {};
  for (const season of [FIT_SPLIT, HELD_OUT, FORWARD]) {
    report.k_control[season] = lib.assertKControl(activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason: season }), season);
  }
  report.weight_sets = Object.fromEntries([[FIT_SPLIT, 6], [HELD_OUT, 3], [HELD_OUT, 6], [FORWARD, 2], [FORWARD, 6]]
    .map(([s, w]) => [`${s}-W${w}`, activeWeeklyWeightSet({ season: s, week: w }).id]));
  log('k control', report.k_control, 'weight sets', report.weight_sets);

  // ---- Fits (prereg §3). One served example build; each fit is a season-filtered subset.
  // buildFantasyCoordinatorExamples loops per season (fantasy-coordinator.js:293), so the
  // rows for 2022-2024 are the same whether the call ends at 2024 or 2025.
  const throughExamples = mode === '--smoke' ? 2023 : 2025;
  const examples = await SERVED.buildFantasyCoordinatorExamples({ fromSeason: FIT_FROM, throughSeason: throughExamples });
  const counts = {};
  for (const e of examples) {
    counts[e.season] ??= { rows: 0, weeks: new Set() };
    counts[e.season].rows++; counts[e.season].weeks.add(e.week);
  }
  report.examples = Object.fromEntries(Object.entries(counts).map(([s, c]) => [s, { rows: c.rows, weeks: c.weeks.size }]));
  log('examples', report.examples);
  const upTo = season => examples.filter(e => e.season <= season);
  const fitPair = (season, label) => {
    const base = upTo(season);
    lib.assertFitCutoff(base, season, `${label} structural-residual fit`);
    const retargeted = lib.retargetToEnsembleResidual(base);
    const fitS = SERVED.fitFantasyCoordinator(base);
    const fitE = SERVED.fitFantasyCoordinator(retargeted.examples);
    // ---- Stop condition 2: every grading fit must be ready.
    if (!fitS.ready || !fitE.ready) throw new Error(`${label}: fit not ready (${fitS.reason ?? ''} ${fitE.reason ?? ''})`);
    return { fitS, fitE, dropped: retargeted.dropped, rows: base.length, through: season };
  };
  const summarizeFit = f => ({ rows: f.rows, intercept: f.coefficients?.[0],
    coefficients: f.coefficients, shrinkage: Object.fromEntries(Object.entries(f.shrinkage ?? {}).map(([k, v]) => [k, v.k])),
    families: (f.families ?? []).map(x => x.members), target: f.safeguards?.target });

  const fits = {};
  fits.split = fitPair(mode === '--smoke' ? 2023 : FIT_SPLIT - 1, 'fit-split (<=2023)');
  if (mode !== '--smoke') {
    fits.heldOut = fitPair(HELD_OUT - 1, 'held-out (<=2024)');
    fits.forward = fitPair(HELD_OUT, 'forward (<=2025)');
  }
  const servedFit = activeFantasyCoordinatorFit();
  if (mode !== '--smoke' && !servedFit.ready) throw new Error('served coordinator fit is not ready on this copy');
  // The served fit's own cutoff: fantasy_coordinator_fits.through_season of the row
  // activeFantasyCoordinatorFit() reads (the latest, fantasy-coordinator.js:378-382).
  const servedThrough = dbRows('SELECT through_season FROM fantasy_coordinator_fits ORDER BY id DESC LIMIT 1')[0]?.through_season ?? null;
  fits.served = { fitS: servedFit, through: servedThrough };
  report.fits = Object.fromEntries(Object.entries(fits).filter(([k]) => k !== 'served').map(([k, v]) => [k, { through: v.through,
    structural_residual: summarizeFit(v.fitS), ensemble_residual: summarizeFit(v.fitE), ensemble_residual_rows_dropped: v.dropped }]));
  report.fits.served = { ...summarizeFit(servedFit), through: servedThrough, authority: servedFit.authority,
    fit_row: dbRows('SELECT id, through_season, rows, created_at FROM fantasy_coordinator_fits ORDER BY id DESC LIMIT 1')[0] ?? null };
  if (fits.forward) {
    const a = fits.forward.fitS.coefficients, b = servedFit.coefficients ?? [];
    report.fits.served.reproduction = {
      what: 'the served refit function on 2022-2025 of this copy vs the stored served fit',
      same_length: a.length === b.length,
      max_abs_coefficient_diff: a.length === b.length ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : null
    };
  }
  clearPlayerWeekEngineCache();
  write();

  // ---- One season's graded rows: arms computed while the engine is alive, then stripped.
  let parityChecked = 0;
  const pinnedArmsFor = (proj, season, week, ctx) => {
    const pinned = weeklyWeightSetById(PINNED_SENSITIVITY_FIT, { week });
    const heads = proj.player_week_engine?.heads;
    if (!heads) return null;
    const raw = weeklyEnsemblePrediction(heads, pinned.weights);
    const projPinned = { ...proj, ppg: +raw.toFixed(2), ensemble_shift: +(raw - proj.structural_ppg).toFixed(4) };
    return lib.constructArms(projPinned, { season, week, ...ctx });
  };
  // Every grade receives the whole `fits` registry; lib.gradingContext picks the season's
  // fits and checks their cutoff, so no call site chooses a fit (prereg §3, §10.2).
  const gradeSeason = (season, weeks, lambdaFor, { servedWrapperParity = false, sensitivity = false } = {}) => {
    const truth = actuals(season, PPR);
    const all = [];
    for (const week of weeks) {
      const engine = buildPlayerWeekEngine({ season, week, scoring: PPR });
      // ---- Stop condition 2 at the grade itself: the season's fits end before it.
      const ctx = lib.gradingContext(season, fits, lambdaFor(week));
      for (const row of lib.eligibleRows(week, engine, truth)) {
        const arms = lib.constructArms(row.proj, { season, week, scoring: PPR, ...ctx });
        // ---- Stop condition 3a: D equals Start/Sit's own week_points on the same input.
        const served = startSitWeekPoints({ team_abbr: row.proj.team, position: row.position, current_week_ppg: arms.B }, season, week).week_points;
        if (lib.round2(arms.D) !== served) throw new Error(`parity: ${season} W${week} player ${row.player_id} D ${arms.D} vs startSitWeekPoints ${served}`);
        // ---- Stop condition 3b: on served-fit rows, B equals the served wrapper.
        if (servedWrapperParity) {
          const wrapper = weeklyProjectionFor(row.player_id, { season, week });
          if (wrapper && wrapper.corrected_ppg !== arms.B) {
            throw new Error(`parity: ${season} W${week} player ${row.player_id} B ${arms.B} vs weeklyProjectionFor ${wrapper.corrected_ppg}`);
          }
        }
        parityChecked++;
        const pinned = sensitivity ? pinnedArmsFor(row.proj, season, week, { scoring: PPR, ...ctx }) : null;
        all.push({ player_id: row.player_id, week, position: row.position, played: row.played, decision: row.decision,
          actual: row.actual, lift: arms.lift, lift_applied: arms.lift_applied,
          preds: Object.fromEntries(ARMS.map(a => [a, arms[a]])),
          pinned: pinned ? Object.fromEntries(ARMS.map(a => [a, pinned[a]])) : null });
      }
      log(`${season} W${week}: ${all.filter(r => r.week === week).length} rows`);
    }
    clearPlayerWeekEngineCache();
    return all;
  };
  const inWindow = (list, w) => list.filter(r => lib.weekWindow(r.week) === w);
  const weekCounts = list => Object.fromEntries([...new Set(list.map(r => r.week))].sort((a, b) => a - b)
    .map(w => [w, { played: list.filter(r => r.week === w && r.played).length, decision: list.filter(r => r.week === w && r.decision).length }]));

  if (mode === '--smoke') {
    const rows = gradeSeason(2024, [6], () => 1, { sensitivity: true });
    // ---- Stop condition 4: known-nonzero control.
    if (!rows.some(r => r.played) || !rows.some(r => r.decision)) throw new Error('smoke: 2024 W6 produced no graded rows');
    report.smoke = { rows_2024_w6: weekCounts(rows), parity_rows_checked: parityChecked,
      lift_applied_share: rows.filter(r => r.lift_applied).length / rows.length,
      pinned_rows: rows.filter(r => r.pinned).length };
    log('smoke OK', report.smoke);
    write();
    return;
  }

  // ---- λ for S3 (and m0) on the 2024 fit split; coordinator arms use the <=2023 fits.
  let lambda;
  if (mode === '--full') {
    const split = gradeSeason(FIT_SPLIT, range(2, 17), () => 1);
    lambda = {};
    report.fit_split = { season: FIT_SPLIT, rows: weekCounts(split), lambda: {}, m0: {} };
    for (const w of WINDOWS) {
      const rowsW = inWindow(split, w);
      if (!rowsW.some(r => r.played)) throw new Error(`fit split window ${w} has no played rows`);
      const lambdaRows = rowsW.map(r => ({ played: r.played, A: r.preds.A, lift: r.lift, lift_applied: r.lift_applied, actual: r.actual }));
      lambda[w] = lib.fitLambda(lambdaRows);
      report.fit_split.lambda[w] = { chosen: lambda[w], grid: lib.lambdaMaes(lambdaRows) };
      for (const r of rowsW) r.preds.S3 = r.lift_applied ? r.preds.A * r.lift ** lambda[w] : r.preds.A;
      report.fit_split.m0[w] = Object.fromEntries(ARMS.map(a => [a, lib.m0For(rowsW, a)]));
    }
    log('fit split', report.fit_split.lambda, report.fit_split.m0);
    write();
  } else {
    const from = arg('--lambda-from');
    if (!from) throw new Error('--forward-only needs --lambda-from <a --full output>');
    const prior = JSON.parse(fs.readFileSync(path.resolve(ROOT, from), 'utf8'));
    lambda = Object.fromEntries(WINDOWS.map(w => [w, prior.fit_split.lambda[w].chosen]));
    report.lambda_from = { file: from, lambda };
  }

  // ---- The one look at 2025.
  if (mode === '--full') {
    console.log(`HOLDOUT LOOK: grading ${HELD_OUT} weeks 2-17 once, against ${prereg.path} @ ${prereg.commit}`);
    report.holdout_look = { season: HELD_OUT, at: new Date().toISOString(), prereg_commit: prereg.commit };
    const held = gradeSeason(HELD_OUT, range(2, 17), week => lambda[lib.weekWindow(week)], { sensitivity: true });
    report.held_out = { season: HELD_OUT, rows: weekCounts(held), parity_rows_checked: parityChecked, windows: {} };
    for (const w of [...WINDOWS, '2-17 (report-only)']) {
      const rowsW = w.startsWith('2-17') ? held : inWindow(held, w);
      // ---- Stop condition 4 on the graded season itself.
      if (!rowsW.some(r => r.played)) throw new Error(`held-out window ${w} has no played rows`);
      report.held_out.windows[w] = gradeWindow(lib, rowsW, { ARMS, CANDIDATES, m0: w.startsWith('2-17') ? null : report.fit_split.m0[w] });
      if (w !== '2-17 (report-only)') {
        const pinnedRows = rowsW.filter(r => r.pinned).map(r => ({ ...r, preds: r.pinned }));
        report.held_out.windows[w].sensitivity_pinned_fit2 = {
          label: w === '5-17' ? 'base = fit-2 vector, fit on 2021-2025: IN-SAMPLE for 2025' : 'base = fit-2 early rule (structural head for 1-3 prior games)',
          ...gradeWindow(lib, pinnedRows, { ARMS, CANDIDATES, m0: null, light: true })
        };
      }
      log(`2025 window ${w} graded`);
      write();
    }
  }

  // ---- Forward: every 2026 week already played with at least one prior 2026 week.
  const forwardWeeks = dbRows('SELECT DISTINCT week FROM player_week_usage WHERE season = ? AND week BETWEEN 2 AND 17 ORDER BY week', FORWARD).map(r => r.week);
  report.forward = { season: FORWARD, weeks: forwardWeeks, coordinator_fit: 'served (activeFantasyCoordinatorFit) for B, D, S1; <=2025 ensemble-residual refit for S2' };
  if (forwardWeeks.length) {
    const before = parityChecked;
    const fwd = gradeSeason(FORWARD, forwardWeeks, week => lambda[lib.weekWindow(week)], { servedWrapperParity: true });
    report.forward.rows = weekCounts(fwd);
    report.forward.parity_rows_checked = parityChecked - before;
    report.forward.all = gradeWindow(lib, fwd, { ARMS, CANDIDATES, m0: null, light: true });
  }

  // ---- Decisions (prereg §7).
  if (mode === '--full') {
    report.decisions = {};
    for (const w of WINDOWS) {
      const g = report.held_out.windows[w];
      const winner = lib.selectWinner(g.verdicts, Object.fromEntries(ARMS.map(a => [a, g.arms[a].mae])));
      report.decisions[w] = { winner, pass_set: CANDIDATES.filter(a => g.verdicts[a].pass),
        forward: lib.forwardVerdict(winner, report.forward.all?.vs_A ?? {}),
        forward_note: w === '5-17' ? 'no 2026 week 5-17 rows exist yet; the forward check uses the 2026 weeks 2-4 rows as a proxy' : null };
    }
  }
  report.finished_at = new Date().toISOString();
  write();
  log('done', JSON.stringify(report.decisions ?? report.forward?.all?.vs_A ?? {}, null, 1));
}

function range(a, b) { return Array.from({ length: b - a + 1 }, (_, i) => a + i); }

/** Every metric for one window (prereg §6-7). `light` skips pair metrics and per-position splits. */
function gradeWindow(lib, rows, { ARMS, CANDIDATES, m0, light = false }) {
  const arms = Object.fromEntries(ARMS.map(a => [a, lib.armSummary(rows, a)]));
  const vsA = Object.fromEntries(CANDIDATES.map(a => [a, lib.compareArms(rows, a, 'A')]));
  const verdicts = Object.fromEntries(CANDIDATES.map(a => [a, lib.shipVerdict(vsA[a])]));
  const result = { arms, vs_A: vsA, verdicts };
  if (light) return result;
  result.marginal = { lift_given_coordinator: lib.compareArms(rows, 'D', 'B'), coordinator_given_lift: lib.compareArms(rows, 'D', 'C') };
  const decisionRows = rows.filter(r => r.decision);
  result.pair_accuracy = lib.pairAccuracy(decisionRows, ARMS);
  result.decision_win_rate_vs_A = Object.fromEntries(CANDIDATES.map(a => [a, lib.decisionWinRate(decisionRows, a, 'A', { models: [...ARMS] })]));
  result.by_position = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const rp = rows.filter(r => r.position === pos);
    result.by_position[pos] = Object.fromEntries(['B', 'C', 'D'].map(a => [a, lib.compareArms(rp, a, 'A').d_mae]));
  }
  if (m0) {
    result.m0_headroom = Object.fromEntries(ARMS.map(a => [a, { m0_from_2024: m0[a], ...lib.headroom(rows, a, m0[a]) }]));
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
}
