/**
 * E1 accept calibration: when the brain says an offer is 40% to be accepted,
 * are about 40% accepted? And does it beat knowing only who is active?
 *
 * Evidence: EVERY resolved trade offer in each ESPN league, from every
 * manager, each scored as of its proposal time (e1-league.js says how, and
 * what is excluded). Resolved statuses: accepted = 1; declined, countered,
 * expired = 0.
 *
 * Baseline ("activity only"): the responder's own accept rate over offers
 * RESOLVED before this one was proposed, shrunk to the league-wide rate at the
 * same cutoff. It knows nothing about the offer's content. A row that carries
 * its own baseline_p_accept uses that instead.
 *
 * JUDGEMENT — no fixed n. Two instruments, each valid at whatever n the
 * report is read:
 *   1. Log-loss gain over the baseline, per offer, in proposal order, with a
 *      95% anytime-valid confidence sequence (sequential.js). Probabilities are
 *      clipped to [0.02, 0.98] first — the production band never leaves
 *      [0.02, 0.97] — so the per-offer gain lies in a range fixed in advance.
 *   2. Pooled hierarchical calibration (hier-calibration.js): population
 *      reliability slope with per-manager partial pooling.
 *
 *   failing          the gain's CS lies wholly below 0: the model loses to
 *                    activity-only, and that holds at whatever n it is read.
 *                    Only the anytime-valid instrument can fail the check,
 *                    because a failing check drops the risk mode
 *                    (brain-rule.js) and the slope's Laplace interval is not
 *                    valid under repeated looks — at n = 9 it would flag an
 *                    inverted model the CS has not yet convicted. A slope
 *                    whose 99% interval lies outside 0.8-1.2 is reported as
 *                    `slope_warning`, and keeps the check from passing.
 *   passing          the gain's CS lies wholly above 0, the slope is inside
 *                    0.8-1.2 and measured to +/- 0.5 (se <= 0.25).
 *   not_enough_data  anything else, with the evidence so far and an estimate
 *                    of how many more offers would decide it.
 */
import { STATUS, result } from './common.js';
import { hierCalibration } from './hier-calibration.js';
import { loadLeagueOffers, mergeOffers, priorCounts, scoreAsOf } from './e1-league.js';
import { confidenceSequence, minDecisiveN } from './sequential.js';
import { logLoss, mean, moreNeeded, reliabilityBuckets, round } from './stats.js';

export const CHECK = 'E1';
export const NAME = 'Accept calibration';
export const SLOPE_BAND = [0.8, 1.2];
export const ALPHA = 0.05;
export const P_CLIP = 0.02;
export const MAX_SLOPE_SE = 0.25;
/** A log-loss difference smaller than this is coin-flip level: not worth deciding. */
export const MIN_GAIN = 0.01;
const PASS_BAR = 'log-loss gain vs activity-only: 95% anytime-valid CS > 0; pooled reliability slope 0.8-1.2 (se <= 0.25)';
const SHRINK_K = 5;
const GAIN_RANGE = Math.log((1 - P_CLIP) / P_CLIP);

/** Historical stand-in (BENCHMARKS.md E1 row): not a grade of P(accept) — Sleeper has no declines. */
export const HISTORICAL_STANDIN = Object.freeze({
  target: 'P(pair trades this week), Sleeper 2023 / 2024 held out, fit 2021-22',
  slopes: [0.93, 0.90],
  log_loss_gain: [{ season: 2023, gain: 0.00025, ci: [0.00011, 0.00040] }, { season: 2024, gain: 0.00036, ci: [0.00019, 0.00055] }],
  note: 'all of the gain over activity-only comes from week of season; true P(accept) is untestable on Sleeper',
});

const clipP = p => Math.min(1 - P_CLIP, Math.max(P_CLIP, p));
const ll1 = (p, y) => -(y ? Math.log(clipP(p)) : Math.log(1 - clipP(p)));

let decisiveN = null;
/** Fewest offers that could decide the gain, at the most one-sided evidence possible. */
export function minOffersToDecide() {
  decisiveN ??= minDecisiveN({ lo: -GAIN_RANGE, hi: GAIN_RANGE, alpha: ALPHA, ref: 0 });
  return decisiveN;
}

/** Activity-only baseline per offer, from offers resolved before it was proposed. */
export function activityBaseline(offers, priors = priorCounts(offers)) {
  return offers.map((o, i) => {
    if (o.baseline_p_accept != null) return Number(o.baseline_p_accept);
    const { acc, n, accAll, nAll } = priors[i];
    const g = (accAll + 1) / (nAll + 2);
    return (acc + SHRINK_K * g) / (n + SHRINK_K);
  });
}

/**
 * Grade already-read rows (trade_outcomes shaped). `excluded`, `sources` and
 * `appArm` come from the loader when grading a database.
 */
export function grade(rawRows, { reason = null, excluded = null, sources = null, appArm = null, alreadyMerged = false } = {}) {
  const merged = alreadyMerged ? { offers: rawRows, excluded: excluded ?? {} } : mergeOffers({ rows: rawRows });
  const why = { ...(excluded ?? {}), ...merged.excluded };
  const offers = scoreAsOf(merged.offers)
    .map((o, i) => ({ o, i }))
    .sort((a, b) => Date.parse(a.o.proposed_at) - Date.parse(b.o.proposed_at) || a.i - b.i)
    .map(({ o }) => o);
  const n = offers.length;
  const acc = offers.reduce((a, o) => a + o.y, 0);
  const common = { check: CHECK, name: NAME, metricName: 'log_loss_gain_vs_activity', passBar: PASS_BAR };
  const floor = minOffersToDecide();
  const baseDetail = {
    historical_standin: HISTORICAL_STANDIN, accepted: acc, not_accepted: n - acc,
    offers_by_basis: countBy(offers, o => o.basis),
    proposers: new Set(offers.map(o => `${o.league_id}:${o.proposer_team_id ?? 'app'}`)).size,
    leagues: new Set(offers.map(o => o.league_id)).size,
    excluded: why, ...(sources ? { sources } : {}), ...(appArm ? { app_arm: appArm } : {}), ...(reason ? { reason } : {}),
    rule: { alpha: ALPHA, p_clip: P_CLIP, min_gain: MIN_GAIN, min_offers_to_decide: floor },
  };
  if (n === 0) {
    return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, n, needsN: floor, needsUnit: 'offers', detail: baseDetail,
      needsText: `needs ${floor} more offers${reason ? ` (${reason})` : ''}` });
  }

  const p = offers.map(o => o.p);
  const y = offers.map(o => o.y);
  const b = activityBaseline(offers, offers.map(o => o.prior));
  const d = offers.map((o, i) => ll1(b[i], y[i]) - ll1(p[i], y[i]));
  const cs = confidenceSequence(d, { lo: -GAIN_RANGE, hi: GAIN_RANGE, alpha: ALPHA, ref: 0 });
  const gain = cs.mean;
  const ci = [cs.lower, cs.upper];
  const hier = hierCalibration(p, y, offers.map(o => `${o.league_id}:${o.counterparty_team_id}`));
  const slope = hier?.slope ?? null;
  const se = hier?.slope_se ?? null;
  const [lo, hi] = SLOPE_BAND;
  const detail = {
    ...baseDetail,
    log_loss_model: logLoss(p.map(clipP), y), log_loss_activity_only: logLoss(b.map(clipP), y),
    e_value_model_better: round(cs.e_above, 3), e_value_model_worse: round(cs.e_below, 3),
    slope, slope_se: se, slope_ci99: se != null ? [slope - 2.576 * se, slope + 2.576 * se] : null,
    hierarchy: hier && {
      intercept: round(hier.intercept), tau: hier.tau,
      managers: hier.managers.slice(0, 5).map(m => ({ ...m, offset: round(m.offset), observed: round(m.observed), predicted: round(m.predicted) })),
    },
    mean_predicted: mean(p), observed_rate: acc / n,
    reliability: reliabilityBuckets(p, y),
  };

  const slopeOut = se != null && (slope + 2.576 * se < lo || slope - 2.576 * se > hi);
  if (slopeOut) detail.slope_warning = 'pooled reliability slope 99% interval outside 0.8-1.2 (not anytime-valid, so it blocks passing but cannot fail the check)';
  if (cs.upper < 0) {
    return result({ ...common, status: STATUS.FAILING, metric: gain, ci, n, detail: {
      ...detail, why: ['loses to activity-only on log loss (anytime-valid CS below 0)'] } });
  }
  const slopeOk = slope != null && slope >= lo && slope <= hi && se != null && se <= MAX_SLOPE_SE;
  if (cs.lower > 0 && slopeOk) return result({ ...common, status: STATUS.PASSING, metric: gain, ci, n, detail });

  // How many more: the CS half-width shrinks about as 1/sqrt(n); decide once
  // it is below the observed gain (or MIN_GAIN, if the gain is smaller — a
  // coin-flip-level difference is not chased forever).
  const target = Math.max(Math.abs(gain), MIN_GAIN);
  const needs = Math.max(
    cs.lower > 0 ? 1 : moreNeeded(n, cs.upper - cs.lower, 2 * target),
    slopeOk ? 1 : (se != null ? moreNeeded(n, se, MAX_SLOPE_SE) : 1),
    floor - n,
  );
  return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, metric: gain, ci, n, needsN: needs, needsUnit: 'offers', detail: {
    ...detail, coin_flip_level: Math.abs(gain) < MIN_GAIN } });
}

function countBy(xs, f) {
  const out = {};
  for (const x of xs) out[f(x)] = (out[f(x)] ?? 0) + 1;
  return out;
}

export function load(database) {
  return loadLeagueOffers(database);
}

export function run(database) {
  const { offers, excluded, sources, app_arm: appArm, reason } = load(database);
  return grade(offers, { reason, excluded, sources, appArm, alreadyMerged: true });
}
