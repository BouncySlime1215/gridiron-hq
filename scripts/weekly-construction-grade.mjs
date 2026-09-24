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
 *   --consumer-parity amendment 1 §3.1: the copy's current 2026 week (no actuals, not a
 *                     grade). Lays the page's number (assetUniverse -> startSitWeekPoints)
 *                     against the study's arms and stops if B or current_week_ppg does not
 *                     decompose as trade-engine.js:359 says. Reads no leagues row.
 *
 * Options:
 *   --out <file.json>  aggregates (default for --full: the committed output file).
 *   --rows-dir <dir>   also write each graded season's row objects to <dir>/rows-<season>.ndjson
 *                      (player ids and fantasy points only; local diagnostics, never commit).
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
  const mode = ['--smoke', '--full', '--forward-only', '--consumer-parity'].find(m => process.argv.includes(m));
  if (!mode) throw new Error('choose one mode: --smoke, --full, --forward-only or --consumer-parity');
  if (!process.env.GRIDIRON_DB_PATH) throw new Error('set GRIDIRON_DB_PATH to a COPY of the app database');
  if (path.resolve(process.env.GRIDIRON_DB_PATH) === path.resolve(ORIGINAL_DB)) {
    throw new Error(`refusing to run on ${ORIGINAL_DB}; make a .backup copy first`);
  }
  process.env.SCHEDULER_DISABLED = '1';
  // S-03 (2026-09-22) switched the served lift off (waiver-brain.js#BETTING_LINE_LIFT) and
  // put the coordinator on its own base. This runner's arms read the served vegasLift and
  // its parity checks describe the served chain BEFORE that, so a re-run would grade the lift
  // as a multiplier of 1 (and --full would reopen 2025). The forward and historical grade is
  // scripts/weekly-construction-walk-forward.mjs now.
  const { BETTING_LINE_LIFT } = await import('../server/services/waiver-brain.js');
  if (!BETTING_LINE_LIFT.on) {
    throw new Error('the served betting-line lift is off since S-03, so this runner no longer describes the served ' +
      'chain; use scripts/weekly-construction-walk-forward.mjs');
  }
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
      scoring: 'PPR',
      availability: 'none: the arms stop before thisGame.mult x active_probability (trade-engine.js:359), so they are the construction, not the page number (amendment 1)',
      matchup_mult: 1,
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

  if (mode === '--consumer-parity') {
    report.consumer_parity = await consumerParity({ lib, PPR, buildPlayerWeekEngine, activeFantasyCoordinatorFit, startSitWeekPoints, log });
    report.finished_at = new Date().toISOString();
    write();
    log('consumer parity', JSON.stringify(report.consumer_parity, null, 1));
    return;
  }

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
  // Every grade receives the whole `fits` registry and the λ-by-window map; the lib picks
  // the season's fits (gradingContext) and each week's λ (lambdaForWeek), so no call site
  // chooses a fit or a λ (prereg §3, §10.2).
  const rowsDir = arg('--rows-dir');
  const dumpRows = (season, list) => {
    if (!rowsDir) return;
    fs.mkdirSync(path.resolve(ROOT, rowsDir), { recursive: true });
    fs.writeFileSync(path.resolve(ROOT, rowsDir, `rows-${season}.ndjson`), list.map(r => JSON.stringify(r)).join('\n') + '\n');
  };
  const gradeSeason = (season, weeks, lambdaByWindow, { servedWrapperParity = false, sensitivity = false } = {}) => {
    const truth = actuals(season, PPR);
    const all = [];
    for (const week of weeks) {
      const engine = buildPlayerWeekEngine({ season, week, scoring: PPR });
      // ---- Stop condition 2 at the grade itself: the season's fits end before it. Checked
      // twice on purpose: inside gradingContext against the season it was asked for, and
      // here against the season this function actually builds and grades, so a wrong
      // season argument cannot fetch later fits past both.
      const { ctx, rows } = lib.gradeWeekRows({ season, week, engine, truth, fits, lambdaByWindow, scoring: PPR });
      lib.assertContextCutoff(ctx, season);
      for (const { arms, ...row } of rows) {
        // ---- Stop condition 3a: the lift step only. D equals startSitWeekPoints on B as
        // current_week_ppg. This is NOT the page number: the page multiplies B by
        // thisGame.mult x active_probability first (amendment 1 §1; --consumer-parity).
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
    const rows = gradeSeason(2024, [6], lib.UNIT_LAMBDA, { sensitivity: true });
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
    const split = gradeSeason(FIT_SPLIT, range(2, 17), lib.UNIT_LAMBDA);
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
    dumpRows(FIT_SPLIT, split);
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
    const held = gradeSeason(HELD_OUT, range(2, 17), lambda, { sensitivity: true });
    // ---- The λ each row used, read back against the λ recorded from the fit split.
    lib.assertS3UsedLambda(held, recordedLambda(report));
    dumpRows(HELD_OUT, held);
    report.held_out = { season: HELD_OUT, rows: weekCounts(held), parity_rows_checked: parityChecked, windows: {} };
    for (const w of [...WINDOWS, '2-17 (report-only)']) {
      const rowsW = w.startsWith('2-17') ? held : inWindow(held, w);
      // ---- Stop condition 4 on the graded season itself.
      if (!rowsW.some(r => r.played)) throw new Error(`held-out window ${w} has no played rows`);
      report.held_out.windows[w] = lib.gradeWindow(rowsW, { m0: w.startsWith('2-17') ? null : report.fit_split.m0[w] });
      if (w !== '2-17 (report-only)') {
        const pinnedRows = rowsW.filter(r => r.pinned).map(r => ({ ...r, preds: r.pinned }));
        report.held_out.windows[w].sensitivity_pinned_fit2 = {
          label: w === '5-17' ? 'base = fit-2 vector, fit on 2021-2025: IN-SAMPLE for 2025' : 'base = fit-2 early rule (structural head for 1-3 prior games)',
          ...lib.gradeWindow(pinnedRows, { m0: null, light: true })
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
    const fwd = gradeSeason(FORWARD, forwardWeeks, lambda, { servedWrapperParity: true });
    lib.assertS3UsedLambda(fwd, recordedLambda(report));
    dumpRows(FORWARD, fwd);
    report.forward.rows = weekCounts(fwd);
    report.forward.parity_rows_checked = parityChecked - before;
    report.forward.all = lib.gradeWindow(fwd, { m0: null, light: true });
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

/** The λ recorded in the report (fit split or --lambda-from), independent of the variable the grade was handed. */
function recordedLambda(report) {
  if (report.fit_split?.lambda) return Object.fromEntries(WINDOWS.map(w => [w, report.fit_split.lambda[w].chosen]));
  if (report.lambda_from?.lambda) return { ...report.lambda_from.lambda };
  throw new Error('lambda: no recorded lambda in the report');
}

/**
 * Amendment 1 §3.1. A synthetic 12-team PPR league object stands in for a league row, so no
 * leagues column (and no cookie column) is read; the per-player week number does not depend
 * on the league beyond its scoring.
 */
// Exported so test/scoring-call-site-followups.test.js can capture what this
// function hands to scoringFor (:350) directly, the way
// test/scoring-call-sites.test.js captures buildProjections/simulateSeason/
// tradeImpact, instead of re-running the whole grading script.
export const SYNTHETIC_PPR_LEAGUE = Object.freeze({ id: 0, platform: 'sleeper', ppr: 1, team_count: 12, league_type: 'redraft' });

export async function consumerParity({ lib, PPR, buildPlayerWeekEngine, activeFantasyCoordinatorFit, startSitWeekPoints, log }) {
  const { assetUniverse, tradeWeekContext } = await import('../server/services/trade-engine.js');
  const { deriveFormat } = await import('../server/services/format.js');
  const { scoringFor } = await import('../server/services/scoring.js');
  const { weeklyAvailability } = await import('../server/services/contingency.js');
  const target = tradeWeekContext();
  if (target.season !== FORWARD) throw new Error(`consumer parity runs on the ${FORWARD} current week only (got ${target.season})`);
  if (JSON.stringify(scoringFor(SYNTHETIC_PPR_LEAGUE)) !== JSON.stringify(PPR)) throw new Error('the synthetic league does not score PPR');
  const servedFit = activeFantasyCoordinatorFit();
  if (!servedFit.ready) throw new Error('served coordinator fit is not ready on this copy');
  const assets = assetUniverse(SYNTHETIC_PPR_LEAGUE, deriveFormat(SYNTHETIC_PPR_LEAGUE).formatKey, target);
  const engine = buildPlayerWeekEngine({ season: target.season, week: target.week, scoring: PPR });
  const avail = weeklyAvailability(target.season, target.week, { through: target.season - 1 });
  const checked = [];
  const skipped = { no_engine_projection: 0, no_coordinator_correction: 0 };
  for (const [id, asset] of assets) {
    if (!lib.SKILL_POSITIONS.has(asset?.position)) continue;
    const proj = engine.get(id);
    if (!proj) { skipped.no_engine_projection++; continue; }
    if (!asset.fantasy_coordinator) { skipped.no_coordinator_correction++; continue; }
    const arms = lib.constructArms(proj, { season: target.season, week: target.week, scoring: PPR, fitS: servedFit, fitE: servedFit, lambda: 1 });
    const page = startSitWeekPoints(asset, target.season, target.week).week_points;
    const d = lib.consumerDecomposition(asset, arms, page, proj.team);
    if (!d.b_parity) throw new Error(`consumer parity: player ${id} served B ${asset.fantasy_coordinator.corrected_ppg} vs study B ${arms.B}`);
    if (!d.current_week_identity) throw new Error(`consumer parity: player ${id} current_week_ppg ${asset.current_week_ppg} vs B x mult x p ${d.expected_current_week_ppg}`);
    const a = avail.get(id);
    checked.push({ ...d, position: asset.position, no_report: !asset.injury_status, no_team: !asset.team_abbr,
      p_is_durability_prior: a ? a.active_probability === a.durability_prior : null });
  }
  log(`consumer parity: ${checked.length} assets checked`);
  return { target, league: 'synthetic 12-team PPR (no leagues row read)',
    availability_basis: assets.context?.availability_basis ?? null, skipped,
    ...lib.summarizeConsumerParity(checked) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
}
