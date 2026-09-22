/**
 * S-02 study library: the pieces of the pre-registered grade of the served weekly
 * construction (docs/evidence/2026-09-22/weekly-construction-grade-preregistration.md).
 *
 * This file produces no served number. Every arm is built by calling the SERVED functions
 * (SERVED below, pinned by identity in test/weekly-construction-grade.test.js), and every
 * metric reuses an existing helper: pairedBootstrapDiff, spearman, startSitPairAccuracy,
 * predictionWeightedMedianRatio. The runner is scripts/weekly-construction-grade.mjs.
 *
 * Sign conventions: signed error = prediction - actual; ΔMAE = MAE(arm) - MAE(reference),
 * negative = arm better; ΔSpearman = ρ(arm) - ρ(reference), positive = arm better;
 * decision win rate - 0.5, positive = the arm's start/sit calls beat m0's.
 */
import {
  weeklyExpertValues, coordinateFantasy, fitFantasyCoordinator, buildFantasyCoordinatorExamples
} from '../server/services/fantasy-coordinator.js';
import { vegasLift } from '../server/services/waiver-brain.js';
import { pairedBootstrapDiff } from '../server/services/backtest-significance.js';
import { spearman } from '../server/services/backtest.js';
import { predictionWeightedMedianRatio } from '../server/services/level-information-decomposition.js';
import { startSitPairAccuracy } from './promote-early-week-weights.mjs';

/** The served functions every arm is built from. Identity-tested, never copied. */
export const SERVED = Object.freeze({
  weeklyExpertValues, coordinateFantasy, vegasLift, fitFantasyCoordinator, buildFantasyCoordinatorExamples
});

export const ARMS = Object.freeze(['A', 'B', 'C', 'D', 'S1', 'S2', 'S3']);
/** Graded against A under the ship rule (prereg §7). */
export const CANDIDATES = Object.freeze(['B', 'C', 'D', 'S1', 'S2', 'S3']);
/** Number of additions over the ensemble, for the tie-break (prereg §7.3). */
export const COMPONENTS = Object.freeze({ A: 0, B: 1, C: 1, S1: 1, S2: 1, S3: 1, D: 2 });
export const LAMBDA_GRID = Object.freeze([0, 0.25, 0.5, 0.75, 1]);
export const SKILL_POSITIONS = Object.freeze(new Set(['QB', 'RB', 'WR', 'TE']));
export const PAIR_THRESHOLD = 4;
/** matchups.js:33-35: "Spearman no worse than -0.002". */
export const SPEARMAN_TOLERANCE = -0.002;
/** One-sided alpha 0.05 (a 90% two-sided CI) plus 80% power: 1.645 + 0.842. */
export const Z_SUM_80 = 2.487;
/** Width of a 90% normal interval in standard errors: 2 x 1.645. */
export const CI90_WIDTH_IN_SE = 3.29;

/** lineup-brain.js:50's r2, so a parity check compares like with like. */
export const round2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/**
 * All seven arms for one player-week (prereg §3), built exactly as served:
 *   A  = proj.ppg                                   trade-engine.js:347
 *   B  = coordinateFantasy(fitS, experts, A)        trade-engine.js:353-355 (base = ensemble)
 *   C  = A x vegasLift                              lineup-brain.js:356-363 on an uncoordinated base
 *   D  = B x vegasLift                              Start/Sit week_points today
 *   S1 = coordinateFantasy(fitS, experts, structural)   the base the fit was gated on
 *   S2 = coordinateFantasy(fitE, experts, A)        fitE = refit on the ensemble residual
 *   S3 = A x multiplier^lambda                      lambda chosen on 2024
 * No availability, bye or matchup term: those multiply every arm alike (prereg §4).
 * The lift reads proj.team, the engine's team at the cutoff (prereg §11).
 */
export function constructArms(proj, { season, week, scoring, fitS, fitE, lambda = 1 }, deps = SERVED) {
  const A = proj.ppg;
  const experts = deps.weeklyExpertValues(proj, season, week, scoring);
  const coordinate = (fit, base) => {
    if (!experts) return base;
    const out = deps.coordinateFantasy(fit, experts, base);
    return out?.ready ? out.corrected_ppg : base;
  };
  const lift = deps.vegasLift({ team_abbr: proj.team, position: proj.position }, season, week);
  const applied = lift?.applied === true;
  const m = applied ? lift.multiplier : 1;
  const B = coordinate(fitS, A);
  return {
    A, B, C: A * m, D: B * m,
    S1: coordinate(fitS, proj.structural_ppg),
    S2: coordinate(fitE, A),
    S3: applied ? A * m ** lambda : A,
    lift: m, lift_applied: applied
  };
}

/** The same examples with the target moved to the ensemble residual (arm S2's fit). */
export function retargetToEnsembleResidual(examples) {
  const kept = examples.filter(e => Number.isFinite(e.experts?.ensemble_shift));
  return {
    examples: kept.map(e => ({ ...e, target: e.target - e.experts.ensemble_shift })),
    dropped: examples.length - kept.length
  };
}

/**
 * Graded rows for one week, weekly-backtest.js's population (prereg §4): a QB/RB/WR/TE with
 * a projection and at least one played week before `week`. `played` rows grade MAE and
 * Spearman; `decision` rows (played week-1) grade DNP-included MAE with actual 0 on a DNP.
 */
export function eligibleRows(week, engine, truth) {
  const out = [];
  for (const [playerId, proj] of engine) {
    if (!SKILL_POSITIONS.has(proj?.position)) continue;
    const t = truth.get(playerId);
    if (!t) continue;
    let prior = 0;
    for (let w = 1; w < week; w++) if (t.weeks.has(w)) prior++;
    if (!prior) continue;
    const played = t.weeks.has(week);
    const decision = t.weeks.has(week - 1);
    if (!played && !decision) continue;
    out.push({ player_id: playerId, week, position: proj.position, played, decision,
      actual: played ? t.weeks.get(week) : 0, proj });
  }
  return out;
}

export function weekWindow(week) {
  if (week >= 2 && week <= 4) return '2-4';
  if (week >= 5 && week <= 17) return '5-17';
  return null;
}

export function mde80(ci90) {
  return Z_SUM_80 * ((ci90[1] - ci90[0]) / CI90_WIDTH_IN_SE);
}

function withMde(result, baselineMae) {
  if (result?.error || !Array.isArray(result?.ci90)) return result;
  const mde = mde80(result.ci90);
  return { ...result, mde80: +mde.toFixed(4),
    mde80_pct_of_baseline_mae: baselineMae ? +(100 * mde / baselineMae).toFixed(2) : null };
}

/** Per-arm level metrics on a row set whose rows carry `preds[arm]`. */
export function armSummary(rows, arm) {
  const played = rows.filter(r => r.played);
  const decision = rows.filter(r => r.decision);
  const err = played.map(r => r.preds[arm] - r.actual);
  return {
    n_played: played.length, n_decision: decision.length,
    mae: mean(err.map(Math.abs)),
    signed_error: mean(err),
    spearman: spearman(played.map(r => ({ pred: r.preds[arm], act: r.actual }))),
    dnp_mae: mean(decision.map(r => Math.abs(r.preds[arm] - r.actual)))
  };
}

/** Arm X against reference R (prereg §6): player-clustered paired bootstrap, 90% CI. */
export function compareArms(rows, x, r, { iterations = 2000, seed = 1 } = {}) {
  const played = rows.filter(row => row.played);
  const decision = rows.filter(row => row.decision);
  const err = (list, arm) => list.map(row => Math.abs(row.preds[arm] - row.actual));
  const baseMae = mean(err(played, r));
  const baseDnp = mean(err(decision, r));
  const dMae = pairedBootstrapDiff(err(played, r), err(played, x),
    { iterations, seed, groups: played.map(row => row.player_id) });
  const dDnp = pairedBootstrapDiff(err(decision, r), err(decision, x),
    { iterations, seed, groups: decision.map(row => row.player_id) });
  const rho = arm => spearman(played.map(row => ({ pred: row.preds[arm], act: row.actual })));
  const rx = rho(x), rr = rho(r);
  return {
    arm: x, reference: r,
    d_mae: withMde(dMae, baseMae), d_dnp: withMde(dDnp, baseDnp),
    d_spearman: rx == null || rr == null ? null : +(rx - rr).toFixed(4)
  };
}

/** matchups.js:33-35. All three must hold. */
export function shipVerdict({ d_mae, d_spearman, d_dnp }) {
  const reasons = [];
  if (d_mae?.error || !Array.isArray(d_mae?.ci90)) reasons.push(`MAE: ${d_mae?.error ?? 'no interval'}`);
  else if (!(d_mae.ci90[1] < 0)) reasons.push(`MAE 90% CI [${d_mae.ci90.join(', ')}] is not entirely below 0`);
  if (!(d_spearman >= SPEARMAN_TOLERANCE)) reasons.push(`Spearman change ${d_spearman} is below ${SPEARMAN_TOLERANCE}`);
  if (!(d_dnp?.mean_diff <= 0)) reasons.push(`DNP-included MAE change ${d_dnp?.mean_diff ?? d_dnp?.error} is worse than 0`);
  return { pass: reasons.length === 0, reasons };
}

function commonPairGroups(rows, models, threshold) {
  const groups = new Map();
  for (const row of rows) {
    if (!models.every(m => row.preds[m] >= threshold)) continue;
    const key = `${row.week}|${row.position}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

/**
 * How often the arm's start/sit call beats "start the higher m0 projection", counted only
 * on the pairs where the two disagree (same week and position; every model in `models`
 * projects both >= threshold, the same common pair set as startSitPairAccuracy). A pair
 * where either projection ties is not a disagreement. Score 1 / 0 / 0.5 on an actual tie.
 * CI on (rate - 0.5), clustered by week|position.
 */
export function decisionWinRate(rows, arm, base, { threshold = PAIR_THRESHOLD, models = [arm, base], iterations = 2000, seed = 1 } = {}) {
  const scores = [], clusters = [];
  let pairs = 0;
  for (const [key, list] of commonPairGroups(rows, models, threshold)) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const x = list[i], y = list[j];
      pairs++;
      const dBase = Math.sign(x.preds[base] - y.preds[base]);
      const dArm = Math.sign(x.preds[arm] - y.preds[arm]);
      if (dBase === 0 || dArm === 0 || dBase === dArm) continue;
      const pick = dArm > 0 ? x : y, other = dArm > 0 ? y : x;
      scores.push(pick.actual > other.actual ? 1 : pick.actual < other.actual ? 0 : 0.5);
      clusters.push(key);
    }
  }
  const winRate = mean(scores);
  const ci = scores.length ? pairedBootstrapDiff(scores.map(() => 0.5), scores, { iterations, seed, groups: clusters }) : { error: 'no disagreements' };
  return { pairs, disagreements: scores.length, win_rate: winRate, minus_half: ci };
}

/** Start/sit pair accuracy for every arm on one common pair set (promote-early-week-weights.mjs:153). */
export function pairAccuracy(rows, models = ARMS, threshold = PAIR_THRESHOLD) {
  return startSitPairAccuracy(rows, [...models], { threshold });
}

/** prereg §7.3: none passing -> A; else the lowest 2025 MAE, exact ties to fewer components. */
export function selectWinner(verdicts, maes) {
  const passing = Object.keys(verdicts).filter(arm => verdicts[arm]?.pass === true);
  if (!passing.length) return 'A';
  passing.sort((a, b) => (maes[a] - maes[b]) || (COMPONENTS[a] - COMPONENTS[b]));
  return passing[0];
}

/** prereg §7.5 (Nick's rule b): a winner other than A ships ON only if it holds forward. */
export function forwardVerdict(winner, forward) {
  if (winner === 'A') return { status: 'off', reason: 'no arm passed: coordinator off, lift off (the ensemble alone)' };
  const f = forward?.[winner];
  const dMae = f?.d_mae?.mean_diff, dDnp = f?.d_dnp?.mean_diff;
  if (!Number.isFinite(dMae) || !Number.isFinite(dDnp)) {
    return { status: 'default-off, unconfirmed forward', reason: 'no forward rows for this arm' };
  }
  return dMae <= 0 && dDnp <= 0
    ? { status: 'on', reason: `forward ΔMAE ${dMae} and ΔDNP-MAE ${dDnp} are both <= 0` }
    : { status: 'default-off, unconfirmed forward', reason: `forward ΔMAE ${dMae}, ΔDNP-MAE ${dDnp}: not both <= 0` };
}

/** MAE of A x multiplier^lambda for each lambda, on played rows `{ played, A, lift, lift_applied, actual }`. */
export function lambdaMaes(rows, grid = LAMBDA_GRID) {
  const played = rows.filter(r => r.played);
  return grid.map(lambda => ({
    lambda,
    mae: mean(played.map(r => Math.abs((r.lift_applied ? r.A * r.lift ** lambda : r.A) - r.actual)))
  }));
}

/** The lambda with the lowest fit-split MAE; ties keep the smaller lambda (grid order). */
export function fitLambda(rows, grid = LAMBDA_GRID) {
  let best = null;
  for (const entry of lambdaMaes(rows, grid)) if (!best || entry.mae < best.mae) best = entry;
  return best.lambda;
}

/** m0 (prereg §8): prediction-weighted median of actual / pred over played rows. */
export function m0For(rows, arm) {
  const played = rows.filter(r => r.played);
  return predictionWeightedMedianRatio(played.map(r => r.preds[arm]), played.map(r => r.actual));
}

/** Multiplicative headroom MAE(X) - MAE(X x m0), diagnostic only. */
export function headroom(rows, arm, m0) {
  const played = rows.filter(r => r.played);
  const raw = mean(played.map(r => Math.abs(r.preds[arm] - r.actual)));
  const scaled = mean(played.map(r => Math.abs(r.preds[arm] * m0 - r.actual)));
  return { raw_mae: raw, scaled_mae: scaled, headroom: raw - scaled };
}

/**
 * Rule 3's k control: the engine must run with the fitted volume k, not the hand-picked
 * K.share = 6 it falls back to when activeKVectorFor returns null or withholds volume k.
 */
export function assertKControl(kVector, season) {
  const share = kVector?.target_share?.ALL;
  if (!kVector || !Number.isFinite(share) || share === 6) {
    throw new Error(`k control failed for predicting ${season}: target_share.ALL = ${share ?? 'missing'}; ` +
      'the engine would run the hand-picked constants. Stopping before any grade.');
  }
  return share;
}

/** A fit used to grade season S may only have seen seasons <= its cutoff. */
export function assertFitCutoff(examples, maxSeason, label) {
  if (!examples?.length) throw new Error(`${label}: no examples (a known-nonzero count is required before fitting)`);
  const latest = examples.reduce((m, e) => Math.max(m, e.season), -Infinity);
  if (latest > maxSeason) throw new Error(`${label}: examples reach ${latest}, past the ${maxSeason} cutoff`);
  return latest;
}

/**
 * Every fit that grades season S must end before S (prereg §5). Checked at the grading
 * call site, on the context the grade actually receives, because the fit-build guard
 * (assertFitCutoff) cannot see which fit a caller later hands to which season.
 */
export function assertContextCutoff(ctx, season) {
  for (const key of ['fitSThrough', 'fitEThrough']) {
    const through = ctx?.[key];
    if (!Number.isInteger(through) || through >= season) {
      throw new Error(`cutoff: ${key} = ${through} may not grade ${season}`);
    }
  }
  return true;
}
