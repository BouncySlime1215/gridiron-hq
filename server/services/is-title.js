/**
 * IS-TITLE: importance sampling for one team's title paths.
 *
 * Nick's title odds sit at 0.1-0.5% (league 4, 2026-09-24). At the 1,200 runs every
 * title number is simulated at (trade-verify.js SENSE_CHECK_SIM_RUNS) that is 1-6
 * championships, so the served `title_now` moves in steps of 0.08 pp and its
 * binomial SE is as large as the estimate. Plain Monte Carlo cannot resolve it
 * without ~100k runs.
 *
 * The proposal: every copula draw of the target team's expected starters is pushed
 * up by a small shift on its independent normal (correlation.js#correlatedSampler
 * .tilted), so the proposal visits the seasons where that team gets hot more
 * often. Each run carries the log likelihood ratio of all its shifted draws, and
 * the estimate weights each run's title indicator by it:
 *
 *   p_IS = (1/N) sum_r w_r 1[title_r],  w_r = exp(sum over the run's shifted draws)
 *
 * which is unbiased for the real model's title odds. Every team's odds from the
 * same runs are unbiased too; the shift only makes the target's estimate tighter.
 *
 * SHADOW ONLY. Nothing here moves a served number: the producer writes the result
 * to `_run.inputs.is_title` (bookkeeping no consumer reads) beside the plain
 * estimate it would replace. Flag GRIDIRON_IS_TITLE: '1' on, anything else off. It
 * is not switched on by preview mode, because it costs a second world build.
 *
 * ============================ IS-TITLE PRE-REGISTRATION ============================
 * Written 2026-09-24, before the estimator was run on anything.
 *
 * Tilt. theta = IS_TITLE_THETA = 1.5, fixed, no sweep. The shift is spread evenly
 * over the target's expected starters in every simulated week (regular season and
 * bracket): delta = theta / sqrt(n) per player-week, so the total squared shift is
 * theta^2 = 2.25 whatever n is, and the weights' second moment on a run is bounded
 * by exp(theta^2) = 9.5. Why 1.5: for a one-dimensional Gaussian tail P(Z > a) the
 * variance-optimal mean shift is ~a, and a 0.1-0.5% event is a = 2.6-3.1; a title is
 * not a single threshold on season points (the bracket weeks matter more than the
 * rest), so an even spread over-pays for the regular season. 1.5 is the
 * conservative half of that range.
 *
 * Metrics (offline fixture league, test/fixtures/is-title-league.mjs; target team's
 * plain title odds tuned into 0.1-1% with plain Monte Carlo only, before any IS run):
 *   M1 levels: over K = 20 seeds at N = 1,200 runs, SE ratio = SD over seeds of the
 *      IS title odds / SD over seeds of the plain title odds. PASS <= 0.5.
 *   M2 bias: |mean over seeds of IS odds - plain reference at 100,000 runs|
 *      <= 3 x sqrt(SD_IS^2 / K + SE_ref^2). PASS.
 *   M3 weights: mean weight within 3 of its own SEs of 1 on every seed. PASS.
 *   M4 paired delta (one fixed deal): SE ratio of the paired title delta, same K and
 *      N, IS vs plain. PASS <= 0.6; bias as M2 against a 100,000-run paired reference.
 *   M5 served numbers: with the flag off the plans entry is byte-identical; with it
 *      on, only `_run.inputs.is_title` is added.
 * What fails it: any of M1-M5 outside its bar. A failure is reported, not tuned away:
 * a different theta is a new registration with its own date.
 * ===================================================================================
 */

export const IS_TITLE_ENV = 'GRIDIRON_IS_TITLE';
/** The pre-registered total tilt, in standard deviations of the target's summed latent draws. */
export const IS_TITLE_THETA = 1.5;

/** { on }: read per call, so a test or a run can flip it. Shadow: never on by preview. */
export function isTitleFlag() {
  return { on: process.env[IS_TITLE_ENV] === '1' };
}

/**
 * Per-week shift vectors for the target team, aligned to each week's copula ids.
 *
 * @param weeks   [{ week, ids: player id per copula row, starters: Set of the target's
 *                expected starters that week }]
 * @returns { shifts: Map<week, Float64Array>, delta, tilted } — `tilted` is the number
 *          of player-weeks shifted; 0 means no shift at all (plain Monte Carlo).
 */
export function tiltShifts(weeks, theta = IS_TITLE_THETA) {
  const n = weeks.reduce((s, w) => s + w.ids.filter(id => w.starters.has(id)).length, 0);
  const delta = n > 0 && theta > 0 ? theta / Math.sqrt(n) : 0;
  const shifts = new Map(weeks.map(w =>
    [w.week, Float64Array.from(w.ids, id => (w.starters.has(id) ? delta : 0))]));
  return { shifts, delta, tilted: n };
}

/** exp of each run's log weight. */
export function weightsOf(logw) {
  return Float64Array.from(logw, Math.exp);
}

/**
 * Weighted mean and its SE of per-run values `x` (an indicator, or a paired
 * difference of indicators) under weights `w`: the plain IS estimator, not the
 * self-normalised one, so it is unbiased at any N.
 */
export function weightedRunMean(x, w) {
  const n = x.length;
  if (n < 2) return { value: null, se: null };
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const y = w[i] * x[i]; s += y; s2 += y * y; }
  const mean = s / n;
  const variance = Math.max(0, (s2 - n * mean * mean) / (n - 1));
  return { value: mean, se: Math.sqrt(variance / n) };
}

/** Weight diagnostics: the mean weight (1 in expectation) with its SE, and Kish's effective sample size. */
export function weightStats(w) {
  const n = w.length;
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { s += w[i]; s2 += w[i] * w[i]; }
  const mean = s / n;
  const sd = Math.sqrt(Math.max(0, (s2 - n * mean * mean) / Math.max(1, n - 1)));
  return { mean_weight: mean, mean_weight_se: sd / Math.sqrt(n), ess: s2 > 0 ? (s * s) / s2 : 0 };
}

/** The SE plain Monte Carlo would have at `n` runs for a probability `p`. */
export function binomialSe(p, n) {
  return p == null || !n ? null : Math.sqrt(Math.max(0, p * (1 - p)) / n);
}

const r = (v, d = 5) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

/**
 * The shadow summary for one team's title odds from an IS world: the IS estimate
 * and SE, the SE plain Monte Carlo would have at the same run count, their ratio,
 * how many runs the target actually won under the proposal, and the weight checks.
 */
export function isTitleSummary({ titleRuns, w, runs, theta, delta, tilted, plain = null }) {
  const est = weightedRunMean(titleRuns, w);
  const plainSe = binomialSe(est.value, runs);
  let hits = 0;
  for (let i = 0; i < titleRuns.length; i++) hits += titleRuns[i];
  const ws = weightStats(w);
  return {
    status: 'shadow',
    title_odds: r(est.value), title_odds_se: r(est.se),
    plain_se_same_runs: r(plainSe),
    se_ratio: plainSe > 0 && est.se != null ? r(est.se / plainSe, 3) : null,
    proposal_title_runs: hits, runs, theta, delta_per_player_week: r(delta, 4), tilted_player_weeks: tilted,
    mean_weight: r(ws.mean_weight, 4), mean_weight_se: r(ws.mean_weight_se, 4), ess: Math.round(ws.ess),
    ...(plain ? { served_title_odds: plain.title_odds } : {}),
    note: 'shadow: importance-sampled title odds; the served title_now is still the plain estimate'
  };
}
