/**
 * S-03 runner: the walk-forward grade of S-02's decision, and the served-number checks.
 * Pre-registration: docs/evidence/2026-09-22/weekly-construction-walk-forward-preregistration.md
 * Library: scripts/weekly-construction-walk-forward-lib.mjs (plus S-02's library for the arms).
 *
 * Run it on a COPY of the app database, never the original:
 *
 *   sqlite3 ~/gridiron-local/data.sqlite ".backup '<worktree>/.local-db/data.sqlite'"
 *   GRIDIRON_DB_PATH=<worktree>/.local-db/data.sqlite SCHEDULER_DISABLED=1 NFL_SEASON=2026 \
 *     node --max-old-space-size=3072 scripts/weekly-construction-walk-forward.mjs <mode> [--out file.json]
 *
 * Modes:
 *   --smoke           plumbing only: fits on 2022, 2023 week 6, every stop condition, row
 *                     counts. Prints no metric.
 *   --walk-forward    2023 and 2024 (weeks 2-17, fits ending before each), the 2026 forward
 *                     weeks through the served code with the stored fit to be promoted, and
 *                     the per-window decisions. Refuses unless the pre-registration is
 *                     committed and unchanged. Never reads a 2025 row.
 *   --forward-only    the 2026 weeks only (re-run after week 4 and later weeks): the stored fit
 *                     to be promoted, or the promoted one, through the served code.
 *   --served-identity [--week N]  after a promotion: the copy's served week-N numbers (default
 *                     5) through assetUniverse, Start/Sit and weeklyProjectionFor, checked
 *                     against arm S1 player by player. Week N has no actuals; not a grade.
 *
 * Output: aggregates only (no player rows, no league or manager data), labelled
 * "local copy, not production".
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREREG = 'docs/evidence/2026-09-22/weekly-construction-walk-forward-preregistration.md';
const S02_OUTPUT = 'docs/evidence/2026-09-22/weekly-construction-grade-output.json';
const DEFAULT_OUT = 'docs/evidence/2026-09-22/weekly-construction-walk-forward-output.json';
const ORIGINAL_DB = path.join(process.env.HOME ?? '', 'gridiron-local', 'data.sqlite');
const FIT_FROM = 2022;
const SEASONS = [2023, 2024];
const FORWARD = 2026;
const WINDOWS = ['2-4', '5-17'];
const SYNTHETIC_PPR_LEAGUE = Object.freeze({ id: 0, platform: 'sleeper', ppr: 1, team_count: 12, league_type: 'redraft' });

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function preregState() {
  if (!git('ls-files', PREREG)) throw new Error(`${PREREG} is not committed; pre-register before any number is run`);
  if (git('status', '--porcelain', '--', PREREG)) throw new Error(`${PREREG} has uncommitted changes`);
  return { path: PREREG, commit: git('log', '-1', '--format=%H', '--', PREREG), blob: git('rev-parse', `HEAD:${PREREG}`) };
}

async function main() {
  const mode = ['--smoke', '--walk-forward', '--forward-only', '--served-identity'].find(m => process.argv.includes(m));
  if (!mode) throw new Error('choose one mode: --smoke, --walk-forward, --forward-only or --served-identity');
  if (!process.env.GRIDIRON_DB_PATH) throw new Error('set GRIDIRON_DB_PATH to a COPY of the app database');
  if (path.resolve(process.env.GRIDIRON_DB_PATH) === path.resolve(ORIGINAL_DB)) {
    throw new Error(`refusing to run on ${ORIGINAL_DB}; make a .backup copy first`);
  }
  process.env.SCHEDULER_DISABLED = '1';
  const prereg = mode === '--walk-forward' ? preregState() : null;

  const { dbPath, rows: dbRows } = await import('../server/db/index.js');
  const { PPR } = await import('../server/services/scoring.js');
  const { actuals } = await import('../server/services/backtest.js');
  const { buildPlayerWeekEngine, clearPlayerWeekEngineCache } = await import('../server/services/player-week-engine.js');
  const { activeKVectorFor } = await import('../server/services/shrinkage-fit.js');
  const { WEEKLY_ROLE_RECENCY } = await import('../server/services/weekly-ensemble.js');
  const { activeWeeklyWeightSet } = await import('../server/services/weekly-weight-store.js');
  const coordinator = await import('../server/services/fantasy-coordinator.js');
  const { vegasLift } = await import('../server/services/waiver-brain.js');
  const s02 = await import('./weekly-construction-grade-lib.mjs');
  const wf = await import('./weekly-construction-walk-forward-lib.mjs');

  const t0 = Date.now();
  const log = (...a) => console.log(`[s-03 ${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
  const report = {
    unit: 'S-03', mode, label: 'local copy, not production',
    tree: { head: git('rev-parse', 'HEAD'), write_tree: git('write-tree') },
    database: { path_basename: path.basename(dbPath) }, prereg,
    configuration: {
      engine: 'buildPlayerWeekEngine (the live path), roleRecency WEEKLY_ROLE_RECENCY hardcoded, kOverride omitted',
      scoring: 'PPR',
      arms: "S-02's constructArms with the lift multiplier from gameScriptLift (the served vegasLift is switched off)",
      availability: 'none: the arms and S1 are the construction before thisGame.mult x active_probability (prereg §8)',
      population: 'weekly-backtest.js rules (S-02 prereg §4)',
      bootstrap: 'pairedBootstrapDiff, groups = player_id, 2000 iterations, seed 1, 90% CI'
    },
    started_at: new Date().toISOString()
  };
  const out = arg('--out') ?? (mode === '--walk-forward' ? DEFAULT_OUT : null);
  const write = () => { if (out) fs.writeFileSync(path.resolve(ROOT, out), `${JSON.stringify(report, null, 2)}\n`); };

  if (mode === '--served-identity') {
    report.served_identity = await servedIdentity({ coordinator, s02, wf, PPR, buildPlayerWeekEngine, week: Number(arg('--week') ?? 5), log });
    report.finished_at = new Date().toISOString();
    write();
    log('served identity', JSON.stringify(report.served_identity, null, 1));
    return;
  }

  // ---- Stop condition 1: the k control (rule 3).
  const kSeasons = mode === '--forward-only' ? [FORWARD] : mode === '--smoke' ? [2023] : [...SEASONS, FORWARD];
  report.k_control = Object.fromEntries(kSeasons.map(s =>
    [s, s02.assertKControl(activeKVectorFor(WEEKLY_ROLE_RECENCY, { predictingSeason: s }), s)]));
  report.weight_sets = Object.fromEntries([[2023, 6], [2024, 3], [2024, 6], [FORWARD, 2], [FORWARD, 6]]
    .map(([s, w]) => [`${s}-W${w}`, activeWeeklyWeightSet({ season: s, week: w }).id]));
  log('k control', report.k_control, 'weight sets', report.weight_sets);

  // ---- One season's graded rows, with the parity stop on every row.
  const counts = { parity_rows: 0, coordinator_applied: 0, no_coordinator_inputs: 0, dumb_missing: 0 };
  const gradeSeason = (season, weeks, ctxFor) => {
    const truth = actuals(season, PPR);
    const all = [];
    for (const week of weeks) {
      const engine = buildPlayerWeekEngine({ season, week, scoring: PPR });
      const ctx = ctxFor(week);
      for (const row of s02.eligibleRows(week, engine, truth)) {
        const arms = s02.constructArms(row.proj, { season, week, scoring: PPR, ...ctx }, wf.LIFT_DEPS);
        const served = coordinator.servedWeekConstruction(row.proj, { fit: ctx.fitS, season, week, scoring: PPR, windows: wf.BOTH_ON });
        const liftServed = vegasLift({ team_abbr: row.proj.team, position: row.position }, season, week);
        // ---- Stop condition 3: the served code is arm S1 (or A with no inputs); the lift is off.
        const { coordinated } = wf.servedParity(arms, served, liftServed);
        counts.parity_rows++;
        if (coordinated) counts.coordinator_applied++; else counts.no_coordinator_inputs++;
        const dumb = wf.seasonAverageToDate(truth.get(row.player_id), week);
        if (dumb == null) counts.dumb_missing++;
        all.push({ player_id: row.player_id, week, position: row.position, played: row.played, decision: row.decision,
          actual: row.actual, lift: arms.lift, lift_applied: arms.lift_applied,
          preds: { A: arms.A, B: arms.B, C: arms.C, D: arms.D, S1: arms.S1, S2: arms.S2, S3: arms.S3, DUMB: dumb } });
      }
      log(`${season} W${week}: ${all.filter(r => r.week === week).length} rows`);
    }
    clearPlayerWeekEngineCache();
    return all;
  };
  const inWindow = (list, w) => list.filter(r => s02.weekWindow(r.week) === w);
  const weekCounts = list => Object.fromEntries([...new Set(list.map(r => r.week))].sort((a, b) => a - b)
    .map(w => [w, { played: list.filter(r => r.week === w && r.played).length, decision: list.filter(r => r.week === w && r.decision).length }]));

  // ---- The stored fit S-03 promotes: the newest ready, structural-target fit through FORWARD - 1.
  const candidate = () => {
    const found = dbRows(`SELECT id, through_season, created_at, fit_json FROM fantasy_coordinator_fits
                          WHERE version = ? AND through_season = ? ORDER BY id DESC`,
    coordinator.FANTASY_COORDINATOR_VERSION, FORWARD - 1)
      .map(r => ({ row: r, fit: JSON.parse(r.fit_json) }))
      .find(c => c.fit?.ready === true && coordinator.fitTargetOf(c.fit) === 'structural');
    if (!found) throw new Error(`no ready structural-target fit through ${FORWARD - 1} is stored on this copy`);
    return { fit: found.fit, meta: { id: found.row.id, through_season: found.row.through_season, created_at: found.row.created_at,
      intercept: found.fit.coefficients?.[0] ?? null,
      shrinkage: Object.fromEntries(Object.entries(found.fit.shrinkage ?? {}).map(([k, v]) => [k, v.k])) } };
  };
  const forwardRun = () => {
    const weeks = dbRows('SELECT DISTINCT week FROM player_week_usage WHERE season = ? AND week BETWEEN 2 AND 17 ORDER BY week', FORWARD)
      .map(r => r.week);
    const c = candidate();
    const block = { season: FORWARD, weeks, fit: c.meta };
    if (!weeks.length) return { block, rows: [] };
    const before = counts.parity_rows;
    // S2 needs a <= 2025 ensemble-residual refit, which this unit does not build: its forward
    // column carries the S1 fit and is not reported.
    const rows = gradeSeason(FORWARD, weeks, () => ({ fitS: c.fit, fitE: c.fit, fitSThrough: FORWARD - 1, fitEThrough: FORWARD - 1, lambda: 1 }));
    block.rows = weekCounts(rows);
    block.parity_rows = counts.parity_rows - before;
    for (const w of WINDOWS) block[w] = wf.forwardSummary(rows, { window: w, weeks });
    return { block, rows };
  };

  if (mode === '--forward-only') {
    const { block } = forwardRun();
    report.forward = block;
    report.counts = counts;
    report.finished_at = new Date().toISOString();
    write();
    log('forward', JSON.stringify(block, null, 1));
    return;
  }

  // ---- Fits (prereg §3): one served example build, each season's fits a subset of it.
  const examples = await s02.SERVED.buildFantasyCoordinatorExamples({ fromSeason: FIT_FROM, throughSeason: mode === '--smoke' ? 2022 : 2023 });
  const perSeason = {};
  for (const e of examples) { perSeason[e.season] ??= { rows: 0, weeks: new Set() }; perSeason[e.season].rows++; perSeason[e.season].weeks.add(e.week); }
  report.examples = Object.fromEntries(Object.entries(perSeason).map(([s, c]) => [s, { rows: c.rows, weeks: c.weeks.size }]));
  const fits = wf.walkForwardFits(examples, mode === '--smoke' ? [2023] : SEASONS, { fitFrom: FIT_FROM });
  // ---- Stop condition 2 at the build: no fit's examples reach its graded season.
  for (const [season, f] of Object.entries(fits)) s02.assertFitCutoff(examples.filter(e => e.season <= f.through), Number(season) - 1, `fit for ${season}`);
  report.fits = Object.fromEntries(Object.entries(fits).map(([season, f]) => [season, {
    through: f.through, rows: f.rows, ensemble_residual_rows_dropped: f.dropped,
    structural: { intercept: f.fitS.coefficients[0], target: f.fitS.safeguards.target,
      shrinkage: Object.fromEntries(Object.entries(f.fitS.shrinkage).map(([k, v]) => [k, v.k])) },
    ensemble: { intercept: f.fitE.coefficients[0], target: f.fitE.safeguards.target,
      shrinkage: Object.fromEntries(Object.entries(f.fitE.shrinkage).map(([k, v]) => [k, v.k])) }
  }]));
  clearPlayerWeekEngineCache();
  log('examples', report.examples, 'fits', Object.keys(fits));
  write();

  if (mode === '--smoke') {
    const rows = gradeSeason(2023, [6], () => wf.walkForwardContext(2023, fits));
    // ---- Stop condition 4: known-nonzero control.
    if (!rows.some(r => r.played) || !rows.some(r => r.decision)) throw new Error('smoke: 2023 W6 produced no graded rows');
    report.smoke = { rows_2023_w6: weekCounts(rows), counts, lift_applied_share: rows.filter(r => r.lift_applied).length / rows.length };
    report.finished_at = new Date().toISOString();
    write();
    log('smoke OK', JSON.stringify(report.smoke));
    return;
  }

  // ---- The walk-forward seasons.
  report.seasons = {};
  for (const season of SEASONS) {
    console.log(`WALK-FORWARD LOOK: grading ${season} weeks 2-17 once, fits through ${season - 1}, against ${prereg.path} @ ${prereg.commit}`);
    const rows = gradeSeason(season, range(2, 17), () => wf.walkForwardContext(season, fits));
    const block = { season, fit_through: season - 1, rows: weekCounts(rows), windows: {} };
    for (const w of WINDOWS) {
      const rowsW = inWindow(rows, w);
      // ---- Stop condition 4 on the graded season itself.
      if (!rowsW.some(r => r.played)) throw new Error(`${season} window ${w} has no played rows`);
      const grade = s02.gradeWindow(rowsW);
      const decisionRows = rowsW.filter(r => r.decision && r.preds.DUMB != null);
      block.windows[w] = {
        ...grade,
        summary: wf.seasonSummary(grade),
        dumb_baseline: Object.fromEntries(['S1', 'A', 'D'].map(arm =>
          [arm, s02.decisionWinRate(decisionRows, arm, 'DUMB', { models: [arm, 'DUMB'] })])),
        squared_error: { S1_vs_A: wf.squaredErrorComparison(rowsW, 'S1', 'A'), C_vs_A: wf.squaredErrorComparison(rowsW, 'C', 'A') },
        level_bands: s02.levelBands(rowsW, ['A', 'S1', 'D'])
      };
      log(`${season} window ${w} graded: S1 ${grade.verdicts.S1.pass ? 'pass' : 'fail'}, C ${grade.verdicts.C.pass ? 'pass' : 'fail'}`);
      write();
    }
    report.seasons[season] = block;
  }

  // ---- Forward, then the decisions (prereg §6).
  const { block: forward } = forwardRun();
  report.forward = forward;
  const s02Output = JSON.parse(fs.readFileSync(path.resolve(ROOT, S02_OUTPUT), 'utf8'));
  report.decisions = {};
  for (const w of WINDOWS) {
    const s02Pass = s02Output.held_out?.windows?.[w]?.verdicts?.S1?.pass;
    if (typeof s02Pass !== 'boolean') throw new Error(`S-02's committed output has no S1 verdict for weeks ${w}`);
    report.decisions[w] = wf.windowDecision({
      window: w,
      seasons: Object.fromEntries(SEASONS.map(s => [s, report.seasons[s].windows[w].summary])),
      s02Pass, forward: forward[w]
    });
  }
  report.counts = counts;
  report.finished_at = new Date().toISOString();
  write();
  log('decisions', JSON.stringify(report.decisions, null, 1));
}

/**
 * The copy's served week-N numbers against arm S1, player by player, through every served
 * producer this unit touches. Stops on the first miss. Reads no leagues row: a synthetic
 * 12-team PPR league object stands in (the per-player week number depends on the league only
 * through its scoring).
 */
async function servedIdentity({ coordinator, s02, wf, PPR, buildPlayerWeekEngine, week, log }) {
  const { assetUniverse } = await import('../server/services/trade-engine.js');
  const { deriveFormat } = await import('../server/services/format.js');
  const { scoringFor } = await import('../server/services/scoring.js');
  const { startSitWeekPoints } = await import('../server/services/lineup-brain.js');
  if (JSON.stringify(scoringFor(SYNTHETIC_PPR_LEAGUE)) !== JSON.stringify(PPR)) throw new Error('the synthetic league does not score PPR');
  const fit = coordinator.activeFantasyCoordinatorFit();
  if (!fit.ready) throw new Error(`no promoted fit on this copy: ${fit.reason}`);
  const target = { season: FORWARD, week };
  const assets = assetUniverse(SYNTHETIC_PPR_LEAGUE, deriveFormat(SYNTHETIC_PPR_LEAGUE).formatKey, target);
  const engine = buildPlayerWeekEngine({ season: FORWARD, week, scoring: PPR });
  const r2 = v => +v.toFixed(2);
  const tally = { checked: 0, coordinated: 0, ensemble_no_inputs: 0, no_game: 0, differs_from_B: 0, abs_S1_minus_B: [],
    corrections: [] };
  for (const [id, asset] of assets) {
    if (!s02.SKILL_POSITIONS.has(asset?.position)) continue;
    const proj = engine.get(id);
    if (!proj) continue;
    const served = coordinator.servedWeekConstruction(proj, { fit, season: FORWARD, week, scoring: PPR });
    const arms = s02.constructArms(proj, { season: FORWARD, week, scoring: PPR, fitS: fit, fitE: fit, lambda: 1 }, wf.LIFT_DEPS);
    const miss = what => { throw new Error(`served identity, week ${week}, player ${id}: ${what}`); };
    if (asset.week_basis !== served.basis) miss(`asset.week_basis ${asset.week_basis} vs ${served.basis}`);
    const expected = asset.matchup ? r2(served.ppg * asset.matchup.mult * asset.active_probability) : 0;
    if (asset.current_week_ppg !== expected) miss(`current_week_ppg ${asset.current_week_ppg} vs construction x mult x p ${expected}`);
    if (served.coordinated) {
      if (served.ppg !== arms.S1) miss(`served ${served.ppg} vs arm S1 ${arms.S1}`);
      if (served.basis !== 'structural+coordinator') miss(`basis ${served.basis}`);
      tally.coordinated++;
      // What the coordinator adds to its base, S1 − structural_ppg (addendum 1 of the result).
      tally.corrections.push(served.coordinated.correction);
      if (arms.B !== arms.S1) { tally.differs_from_B++; tally.abs_S1_minus_B.push(Math.abs(arms.S1 - arms.B)); }
    } else {
      if (served.ppg !== arms.A) miss(`no coordinator inputs, served ${served.ppg} vs arm A ${arms.A}`);
      tally.ensemble_no_inputs++;
    }
    if (!asset.matchup) tally.no_game++;
    const page = startSitWeekPoints(asset, FORWARD, week).week_points;
    if (page !== r2(asset.current_week_ppg)) miss(`Start/Sit ${page} vs current_week_ppg ${asset.current_week_ppg} (the lift should be off)`);
    const wrapper = coordinator.weeklyProjectionFor(id, { season: FORWARD, week });
    if (wrapper && wrapper.corrected_ppg !== served.ppg) miss(`weeklyProjectionFor ${wrapper.corrected_ppg} vs ${served.ppg}`);
    tally.checked++;
  }
  if (!tally.checked) throw new Error(`served identity: no skill asset with an engine projection in week ${week}`);
  const diffs = tally.abs_S1_minus_B.sort((a, b) => a - b);
  log(`served identity week ${week}: ${tally.checked} assets checked`);
  const c = tally.corrections;
  const cMean = c.reduce((s, x) => s + x, 0) / c.length;
  const counts = new Map();
  for (const x of c) counts.set(x, (counts.get(x) ?? 0) + 1);
  const [modal, modalCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return {
    target, league: 'synthetic 12-team PPR (no leagues row read)',
    fit: { id: fit.fit_row.id, through_season: fit.fit_row.through_season, promotion: fit.promotion },
    week_basis_label: assets.context.week_basis.label,
    checked: tally.checked, coordinated: tally.coordinated, ensemble_no_inputs: tally.ensemble_no_inputs, no_game: tally.no_game,
    s1_differs_from_old_B: tally.differs_from_B,
    // The coordinator's correction on its base (S1 − structural_ppg), every coordinated asset.
    correction_s1_minus_structural: c.length ? {
      n: c.length, mean: +cMean.toFixed(4),
      sd: +Math.sqrt(c.reduce((s, x) => s + (x - cMean) ** 2, 0) / c.length).toFixed(4),
      min: Math.min(...c), max: Math.max(...c), most_common: { value: modal, count: modalCount }
    } : null,
    abs_s1_minus_b: diffs.length ? {
      mean: +(diffs.reduce((s, x) => s + x, 0) / diffs.length).toFixed(3),
      median: +diffs[Math.floor(diffs.length / 2)].toFixed(3), max: +diffs[diffs.length - 1].toFixed(3)
    } : null
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
}
