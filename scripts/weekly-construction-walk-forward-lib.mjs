/**
 * S-03 study library: the walk-forward grade of S-02's decision
 * (docs/evidence/2026-09-22/weekly-construction-walk-forward-preregistration.md).
 *
 * Produces no served number. The arms are S-02's constructArms (the served functions, with
 * the lift read from gameScriptLift because the served vegasLift is switched off), the
 * metrics are S-02's (gradeWindow, compareArms, decisionWinRate), and this file adds only
 * what S-03's pre-registration adds: fits per walk-forward season, the served-code parity
 * stop, the season-average dumb baseline, the squared-error diagnostic, and the per-window
 * decision rule. The runner is scripts/weekly-construction-walk-forward.mjs.
 *
 * Sign conventions (S-02's): ΔMAE and ΔMSE = arm − reference, negative = arm better;
 * signed error = prediction − actual, negative = reads low.
 */
import { gameScriptLift } from '../server/services/waiver-brain.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';
import { SERVED, retargetToEnsembleResidual, assertFitCutoff, assertContextCutoff, compareArms } from './weekly-construction-grade-lib.mjs';

/**
 * constructArms' dependencies: the served functions, except the lift multiplier. The served
 * vegasLift is the switch and returns 1 since S-03; the study grades the multiplier it used
 * to apply, gameScriptLift (the same code).
 */
export const LIFT_DEPS = Object.freeze({ ...SERVED, vegasLift: gameScriptLift });

/** Both windows on: a study grading the construction's arithmetic, not a promotion. */
export const BOTH_ON = Object.freeze({ '2-4': 'on', '5-17': 'on' });

const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/**
 * The fits that grade each walk-forward season: the served fitter on the examples of
 * `fitFrom`..s−1, one on the structural residual (its own target) and one on the ensemble
 * residual (labelled so). Stops when a season has no earlier examples or a fit is not ready.
 */
export function walkForwardFits(examples, seasons, { fitFrom = 2022, deps = SERVED } = {}) {
  const out = {};
  for (const season of seasons) {
    const through = season - 1;
    const base = examples.filter(e => e.season >= fitFrom && e.season <= through);
    assertFitCutoff(base, through, `walk-forward fit for ${season}`);
    const retargeted = retargetToEnsembleResidual(base);
    const fitS = deps.fitFantasyCoordinator(base);
    const fitE = deps.fitFantasyCoordinator(retargeted.examples, { target: 'ensemble' });
    if (!fitS.ready || !fitE.ready) {
      throw new Error(`walk-forward fit for ${season} not ready (${fitS.reason ?? ''} ${fitE.reason ?? ''})`.trim());
    }
    out[season] = { fitS, fitE, through, rows: base.length, dropped: retargeted.dropped };
  }
  return out;
}

/** The grading context for one season, cutoff-checked at the point of use (S-02's guard). */
export function walkForwardContext(season, fits) {
  const f = fits?.[season];
  if (!f) throw new Error(`cutoff: no walk-forward fit for ${season}`);
  const ctx = { fitS: f.fitS, fitE: f.fitE, fitSThrough: f.through, fitEThrough: f.through, lambda: 1 };
  assertContextCutoff(ctx, season);
  return ctx;
}

/** Rule (d)'s dumb baseline: his mean PPR points over his played weeks before `week`. */
export function seasonAverageToDate(truth, week) {
  if (!truth?.weeks) return null;
  const prior = [...truth.weeks].filter(([w]) => w < week).map(([, pts]) => pts);
  return prior.length ? mean(prior) : null;
}

/**
 * Stop condition 3 (prereg §7), one row: the served construction equals arm S1 whenever
 * the coordinator applied, equals arm A (the ensemble) when it did not, and the served
 * vegasLift is off. Returns whether the coordinator applied, for the counts.
 */
export function servedParity(arms, served, liftServed) {
  if (liftServed?.applied !== false || liftServed?.multiplier !== 1) {
    throw new Error(`parity: the served lift is not off (applied ${liftServed?.applied}, multiplier ${liftServed?.multiplier})`);
  }
  const coordinated = Boolean(served?.coordinated);
  const expected = coordinated ? arms.S1 : arms.A;
  if (served?.ppg !== expected) {
    throw new Error(`parity: served ${served?.ppg} (${served?.basis}) vs arm ${coordinated ? 'S1' : 'A'} ${expected}`);
  }
  return { coordinated };
}

/** Report-only (prereg §5): MSE of arm and reference on played rows, and the clustered change. */
export function squaredErrorComparison(rows, x, r, { iterations = 2000, seed = 1 } = {}) {
  const played = rows.filter(row => row.played);
  const sq = arm => played.map(row => (row.preds[arm] - row.actual) ** 2);
  return {
    arm: x, reference: r, n: played.length,
    mse_arm: mean(sq(x)), mse_reference: mean(sq(r)),
    d_mse: pairedBootstrapDiff(sq(r), sq(x), { iterations, seed, groups: played.map(row => row.player_id) })
  };
}

/** The two verdicts the decision reads, off one S-02 gradeWindow result. */
export function seasonSummary(grade) {
  const s1 = grade.vs_A.S1.d_mae, c = grade.vs_A.C.d_mae;
  return {
    S1: { pass: grade.verdicts.S1.pass, ci90: s1.ci90, mean_diff: s1.mean_diff, mde80: s1.mde80, reasons: grade.verdicts.S1.reasons },
    C: { pass: grade.verdicts.C.pass, ci90: c.ci90, mde80: c.mde80, reasons: grade.verdicts.C.reasons }
  };
}

/**
 * The forward check's inputs (prereg §6 item 3): S1, B, C and D against A on the 2026
 * rows, point estimates plus S-02's intervals. `proxy` marks the weeks 5-17 decision, which
 * has no 2026 rows of its own before week 5 is played. Null with no rows.
 */
export function forwardSummary(rows, { window, weeks }) {
  if (!rows?.length) return null;
  const out = { weeks, proxy: window === '5-17' && !weeks.some(w => w >= 5), rows: rows.filter(r => r.played).length };
  for (const arm of ['S1', 'B', 'C', 'D']) {
    const c = compareArms(rows, arm, 'A');
    out[arm] = { d_mae: c.d_mae?.mean_diff ?? null, d_mae_ci90: c.d_mae?.ci90 ?? null,
      d_dnp: c.d_dnp?.mean_diff ?? null, d_dnp_ci90: c.d_dnp?.ci90 ?? null, d_spearman: c.d_spearman };
  }
  return out;
}

/**
 * The pre-registered decision for one window (prereg §6):
 *   coordinator on (arm S1) iff S1 passes in >= 2 of {2023, 2024, 2025 (S-02's verdict)},
 *   no walk-forward season has S1 significantly worse than A (ΔMAE CI entirely above 0),
 *   and the forward point estimates of ΔMAE and ΔDNP-MAE are both <= 0.
 * The lift is off whatever the grade says (S-02's rule and Nick's rule b); a lift that passes
 * in both walk-forward seasons is reported as a 2025-specific failure, nothing more.
 */
export function windowDecision({ window, seasons, s02Pass, forward }) {
  const graded = Object.keys(seasons).map(Number).sort((a, b) => a - b);
  const passSeasons = graded.filter(s => seasons[s].S1.pass === true);
  const passes = passSeasons.length + (s02Pass === true ? 1 : 0);
  const vetoes = graded.filter(s => Array.isArray(seasons[s].S1.ci90) && seasons[s].S1.ci90[0] > 0);
  const f = forward?.S1;
  const forwardHolds = Number.isFinite(f?.d_mae) && Number.isFinite(f?.d_dnp) && f.d_mae <= 0 && f.d_dnp <= 0;
  const historical = passes >= 2 && vetoes.length === 0;
  const on = historical && forwardHolds;
  const liftPassSeasons = graded.filter(s => seasons[s].C.pass === true);
  return {
    window, coordinator: on ? 'S1' : 'A',
    status: on ? 'on' : historical ? 'off: unconfirmed forward' : 'off: not confirmed historically',
    passes, pass_seasons: [...passSeasons, ...(s02Pass === true ? [2025] : [])], vetoes,
    forward: forward ? { holds: forwardHolds, proxy: forward.proxy === true, d_mae: f?.d_mae ?? null, d_dnp: f?.d_dnp ?? null } : null,
    lift: 'off',
    lift_pass_seasons: liftPassSeasons,
    lift_note: liftPassSeasons.length === graded.length && graded.length > 0
      ? `the lift passed in every walk-forward season (${graded.join(', ')}): its 2025 failure is 2025-specific in weeks ${window}; a new pre-registration is the follow-up, nothing served changes`
      : 'the lift stays off: it failed its pre-registered rule in 2025 (S-02) and did not pass in every walk-forward season'
  };
}
