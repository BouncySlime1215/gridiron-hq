/**
 * S-02 study library: the pieces of the pre-registered grade of the served weekly
 * construction (docs/evidence/2026-09-22/weekly-construction-grade-preregistration.md).
 *
 * This file produces no served number. Every arm is built by calling the SERVED functions
 * (SERVED below, pinned by identity in test/weekly-construction-grade.test.js), and every
 * metric reuses an existing helper: pairedBootstrapDiff, spearman, startSitPairAccuracy,
 * predictionWeightedMedianRatio. The runner is scripts/weekly-construction-grade.mjs.
 * Amendment 1 (weekly-construction-grade-preregistration-amendment-1.md) adds the consumer
 * decomposition and the level-band diagnostics at the end of this file.
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
 *   D  = B x vegasLift                              served construction before availability and the game factor
 *   S1 = coordinateFantasy(fitS, experts, structural)   the base the fit was gated on
 *   S2 = coordinateFantasy(fitE, experts, A)        fitE = refit on the ensemble residual
 *   S3 = A x multiplier^lambda                      lambda chosen on 2024
 * No availability, bye or game factor. The page multiplies B by thisGame.mult x
 * active_probability before the lift (trade-engine.js:359), so these arms are the
 * construction, not the page number (amendment 1 §1; consumerDecomposition checks it).
 * The lift reads proj.team, the engine's team at the cutoff (prereg §11); the page keys it
 * on players.team_abbr.
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

/**
 * Which fits grade which season (prereg §3), in one place. A slot holds a pair built from
 * real examples, `{ fitS, fitE, through }`, so a fit's cutoff travels with it: handing the
 * <=2025 pair to the 2025 grade fails here, whatever the caller meant.
 *   2024 (fit split, m0 and lambda): the <=2023 pair.
 *   2025 (held out):                 the <=2024 pair.
 *   2026 (forward):                  the SERVED fit for B/D/S1, the <=2025 ensemble-residual refit for S2.
 */
export const SEASON_SLOTS = Object.freeze({
  2024: Object.freeze({ S: 'split', E: 'split' }),
  2025: Object.freeze({ S: 'heldOut', E: 'heldOut' }),
  2026: Object.freeze({ S: 'served', E: 'forward' })
});

export function gradingContext(season, fits, lambda) {
  const slots = SEASON_SLOTS[season];
  if (!slots) throw new Error(`cutoff: no fits are registered to grade ${season}`);
  const s = fits?.[slots.S], e = fits?.[slots.E];
  if (!s?.fitS) throw new Error(`cutoff: ${season} needs a fit in slot ${slots.S}`);
  if (!e?.fitE) throw new Error(`cutoff: ${season} needs an ensemble-residual fit in slot ${slots.E}`);
  const ctx = { fitS: s.fitS, fitE: e.fitE, fitSThrough: s.through, fitEThrough: e.through, lambda };
  assertContextCutoff(ctx, season);
  return ctx;
}

/** λ = 1 in both windows: the smoke run and the 2024 fit split, before λ is chosen. */
export const UNIT_LAMBDA = Object.freeze({ '2-4': 1, '5-17': 1 });

/** S3's exponent for one week: its own window's λ (prereg §3). A week outside both windows stops. */
export function lambdaForWeek(lambdaByWindow, week) {
  const window = weekWindow(week);
  const lambda = window ? lambdaByWindow?.[window] : undefined;
  if (!Number.isFinite(lambda)) throw new Error(`lambda: no lambda for week ${week} (window ${window})`);
  return lambda;
}

/**
 * One graded week: the season's registered fits (gradingContext), the week's window λ, and
 * every eligible row's arms. The runner adds the parity checks and strips the engine.
 */
export function gradeWeekRows({ season, week, engine, truth, fits, lambdaByWindow, scoring }, deps = SERVED) {
  const ctx = gradingContext(season, fits, lambdaForWeek(lambdaByWindow, week));
  const rows = eligibleRows(week, engine, truth)
    .map(row => ({ ...row, arms: constructArms(row.proj, { season, week, scoring, ...ctx }, deps) }));
  return { ctx, rows };
}

/**
 * Run-time check that every graded row's S3 was built with its window's λ, read back from
 * the recorded choice rather than from the value the grade was handed.
 */
export function assertS3UsedLambda(rows, lambdaByWindow) {
  for (const row of rows) {
    const lambda = lambdaForWeek(lambdaByWindow, row.week);
    const expected = row.lift_applied ? row.preds.A * row.lift ** lambda : row.preds.A;
    if (!(Math.abs(row.preds.S3 - expected) < 1e-9)) {
      throw new Error(`lambda: W${row.week} S3 ${row.preds.S3} was not built with lambda ${lambda} (expected ${expected})`);
    }
  }
  return rows.length;
}

/**
 * Every metric for one window (prereg §6-7), arm X always against reference A.
 * `light` skips the marginals, pair metrics and per-position splits.
 */
export function gradeWindow(rows, { m0 = null, light = false } = {}) {
  const arms = Object.fromEntries(ARMS.map(a => [a, armSummary(rows, a)]));
  const vsA = Object.fromEntries(CANDIDATES.map(a => [a, compareArms(rows, a, 'A')]));
  const verdicts = Object.fromEntries(CANDIDATES.map(a => [a, shipVerdict(vsA[a])]));
  const result = { arms, vs_A: vsA, verdicts };
  if (light) return result;
  result.marginal = { lift_given_coordinator: compareArms(rows, 'D', 'B'), coordinator_given_lift: compareArms(rows, 'D', 'C') };
  const decisionRows = rows.filter(r => r.decision);
  result.pair_accuracy = pairAccuracy(decisionRows, ARMS);
  result.decision_win_rate_vs_A = Object.fromEntries(CANDIDATES.map(a => [a, decisionWinRate(decisionRows, a, 'A', { models: [...ARMS] })]));
  result.by_position = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const rp = rows.filter(r => r.position === pos);
    result.by_position[pos] = Object.fromEntries(['B', 'C', 'D'].map(a => [a, compareArms(rp, a, 'A').d_mae]));
  }
  if (m0) {
    result.m0_headroom = Object.fromEntries(ARMS.map(a => [a, { m0_from_2024: m0[a], ...headroom(rows, a, m0[a]) }]));
  }
  return result;
}

/* ---------------------------------------------------------------------------------------
 * Amendment 1 diagnostics (report-only, no rule attached).
 * ------------------------------------------------------------------------------------- */

/**
 * The page's number for one asset, laid against the study's arms (amendment 1 §3.1):
 *   current_week_ppg = B × thisGame.mult × active_probability, 0 on a bye   trade-engine.js:359
 *   week_points      = round2(current_week_ppg × lift(players.team_abbr))    lineup-brain.js:356-363
 * The arms stop before thisGame.mult × active_probability, so page / arm D carries p.
 * This is a check on the served output, not a producer: it builds no served number.
 */
export function consumerDecomposition(asset, arms, pageWeekPoints, engineTeam) {
  // Our construction is the week blend's ours input (week_blend.ours, BLEND-01): with the blend
  // on, current_week_ppg and the top-level fantasy_coordinator may describe ESPN's number instead.
  const ours = asset.week_blend?.ours ?? null;
  const servedB = ours?.fantasy_coordinator?.corrected_ppg ?? null;
  const bye = !asset.matchup;
  const mult = bye ? 0 : asset.matchup.mult;
  const p = asset.active_probability;
  const expected = bye ? 0 : +(servedB * mult * p).toFixed(2);
  return {
    b_parity: servedB === arms.B,
    current_week_identity: ours?.ppg === expected,
    expected_current_week_ppg: expected,
    p, mult, bye,
    arm_D: round2(arms.D), page: pageWeekPoints,
    page_over_D: arms.D ? pageWeekPoints / arms.D : null,
    team_differs: (asset.team_abbr ?? null) !== (engineTeam ?? null)
  };
}

/** The weekly starter proxy: QB 12 / RB 30 / WR 36 / TE 12, a 12-team one-flex league. */
export const STARTER_QUOTA = Object.freeze({ QB: 12, RB: 30, WR: 36, TE: 12 });

/** Each week's top N per position by the reference arm's prediction. */
export function starterProxy(rows, ref = 'A', quota = STARTER_QUOTA) {
  const groups = new Map();
  for (const row of rows) {
    if (!quota[row.position]) continue;
    const key = `${row.week}|${row.position}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = [];
  for (const list of groups.values()) {
    out.push(...[...list].sort((a, b) => b.preds[ref] - a.preds[ref]).slice(0, quota[list[0].position]));
  }
  return out;
}

/** Mean signed error (prediction − actual; negative = reads low) with a player-clustered 90% CI. */
export function meanSignedError(rows, arm, { iterations = 2000, seed = 1 } = {}) {
  const errs = rows.map(r => r.preds[arm] - r.actual);
  const boot = pairedBootstrapDiff(errs.map(() => 0), errs, { iterations, seed, groups: rows.map(r => r.player_id) });
  return { n: rows.length, mean: mean(errs), ci90: boot.ci90 ?? null, ...(boot.error ? { error: boot.error } : {}) };
}

/** Amendment 1 §3.2: signed error by projection band and by the weekly starter proxy. */
export function levelBands(rows, arms, { ref = 'A', band = 10, quota = STARTER_QUOTA, iterations = 2000, seed = 1 } = {}) {
  const played = rows.filter(r => r.played);
  const starters = starterProxy(rows, ref, quota);
  const sets = {
    played_all: played,
    [`played_${ref}_ge_${band}`]: played.filter(r => r.preds[ref] >= band),
    [`played_${ref}_lt_${band}`]: played.filter(r => r.preds[ref] < band),
    starters_played: starters.filter(r => r.played),
    starters_decision: starters.filter(r => r.decision)
  };
  return Object.fromEntries(Object.entries(sets).map(([key, list]) => [key, {
    n: list.length,
    arms: Object.fromEntries(arms.map(a => [a, meanSignedError(list, a, { iterations, seed })]))
  }]));
}

/**
 * Amendment 1 §3.2's stop condition: rows dumped from a run must reproduce that run's
 * committed arm table (n_played, n_decision, mae, signed_error) to 4 decimal places.
 */
export function reproductionMismatches(rows, table, arms, tolerance = 5e-5) {
  const out = [];
  for (const arm of arms) {
    const want = table?.[arm];
    if (!want) { out.push({ arm, field: 'missing' }); continue; }
    const got = armSummary(rows, arm);
    for (const field of ['n_played', 'n_decision', 'mae', 'signed_error']) {
      if (!(Math.abs(got[field] - want[field]) < tolerance)) out.push({ arm, field, got: got[field], want: want[field] });
    }
  }
  return out;
}

const quantiles = (xs, qs = [0.1, 0.25, 0.5, 0.75, 0.9]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Object.fromEntries(qs.map(q => [`q${Math.round(q * 100)}`, +s[Math.floor(q * (s.length - 1))].toFixed(3)]));
};

/**
 * Amendment 1 §3.1's aggregates over consumerDecomposition rows (each also carrying
 * `position`, `no_report` and `p_is_durability_prior`). Byes are counted, then left out of
 * the ratios. The starter proxy is the top N per position by arm D.
 */
export function summarizeConsumerParity(checked, quota = STARTER_QUOTA) {
  const playing = checked.filter(c => !c.bye);
  const noReport = playing.filter(c => c.no_report);
  const withPrior = noReport.filter(c => c.p_is_durability_prior != null);
  const starters = starterProxy(playing.map(c => ({ ...c, week: 0, preds: { D: c.arm_D } })), 'D', quota);
  const meanOf = (xs, f) => (xs.length ? +(xs.reduce((s, x) => s + f(x), 0) / xs.length).toFixed(3) : null);
  return {
    n_checked: checked.length,
    b_parity_holds: checked.filter(c => c.b_parity).length,
    current_week_identity_holds: checked.filter(c => c.current_week_identity).length,
    // current_week_ppg is 0 when the player's team has no game this week (a bye) and when
    // he has no team at all (no players.team_id): trade-engine.js:334-337, :348, :359.
    no_game_this_week: {
      total: checked.length - playing.length,
      no_team: checked.filter(c => c.bye && c.no_team).length,
      bye_with_team: checked.filter(c => c.bye && !c.no_team).length
    },
    page_differs_from_arm_D: playing.filter(c => c.page !== c.arm_D).length,
    page_over_arm_D: quantiles(playing.filter(c => c.arm_D > 0).map(c => c.page_over_D)),
    active_probability: {
      all: quantiles(playing.map(c => c.p)),
      no_injury_status: quantiles(noReport.map(c => c.p)),
      no_injury_status_n: noReport.length,
      no_injury_status_share_at_durability_prior: withPrior.length
        ? +(withPrior.filter(c => c.p_is_durability_prior).length / withPrior.length).toFixed(3) : null
    },
    game_mult_values: [...new Set(playing.map(c => c.mult))].sort((a, b) => a - b),
    team_differs_among_playing: playing.filter(c => c.team_differs).length,
    starter_proxy: {
      quota, n: starters.length,
      mean_arm_D: meanOf(starters, c => c.arm_D), mean_page: meanOf(starters, c => c.page),
      median_p: quantiles(starters.map(c => c.p))?.q50 ?? null
    }
  };
}
