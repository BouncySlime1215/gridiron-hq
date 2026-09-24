/**
 * E2 price accuracy: offers priced AT the clone's predicted "yes" point
 * (indifference price) should be accepted at about the rate the model predicted
 * there; offers priced BELOW it should mostly be declined.
 *
 * Source: none yet (see NO_SOURCE_REASON below; FIX-09 builds it). Contract, one row per sent
 * offer: model_p_accept (at the price sent), price_band ('below' | 'at' |
 * 'above' the predicted yes point, decided by the producer that priced it),
 * status (trade_outcomes vocabulary), proposed_at. Only this app's offers can
 * feed E2: another manager's offer has no predicted yes point to be priced
 * against, so the league-wide widening E1 gets does not apply here. Sleeper
 * counter/accept pairs cannot feed it either: Sleeper records no declines.
 *
 * JUDGEMENT — no fixed n, the same instruments as E1:
 *   - observed minus predicted on 'at' offers, per offer (y - p, in [-1, 1]),
 *     with a 95% anytime-valid confidence sequence (sequential.js), in
 *     proposal order;
 *   - the 'below' accept rate with its own CS;
 *   - per-manager partial pooling of the 'at' offsets (hier-calibration.js,
 *     slope pinned at 1: 'at' predictions barely vary, so only the offsets are
 *     asked about), reported, not gating.
 *
 *   failing          the 'at' CS excludes 0, or the 'below' CS lies wholly
 *                    above 50% (the price model is too stingy).
 *   passing          the 'at' CS contains 0 and is no wider than 0.30, and
 *                    the 'below' accept rate (if any) is under 50%.
 *   not_enough_data  anything else, with the evidence so far.
 */
import { STATUS, result, ciExcludesZero } from './common.js';
import { hierCalibration } from './hier-calibration.js';
import { confidenceSequence, minDecisiveN } from './sequential.js';
import { mean, moreNeeded, round } from './stats.js';

export const CHECK = 'E2';
export const NAME = 'Price accuracy';
export const ALPHA = 0.05;
export const MAX_WIDTH = 0.30;
const PASS_BAR = "accept rate at the predicted yes point within an anytime-valid 95% CS of predicted (CS width <= 0.30); offers below it < 50% accepted";
const OUTCOME = { accepted: 1, declined: 0, countered: 0, expired: 0 };

let floorAt = null;
/** Fewest 'at' offers that could possibly decide (every one maximally off). */
export function minOffersToDecide() {
  floorAt ??= minDecisiveN({ lo: -1, hi: 1, alpha: ALPHA, ref: 0 });
  return floorAt;
}

const byTime = xs => xs.map((o, i) => ({ o, i }))
  .sort((a, b) => (Date.parse(a.o.at ?? '') || 0) - (Date.parse(b.o.at ?? '') || 0) || a.i - b.i)
  .map(({ o }) => o);

export function grade(rawOffers, { reason = null } = {}) {
  const offers = byTime(rawOffers
    .filter(o => o.model_p_accept != null && Object.hasOwn(OUTCOME, o.status))
    .map(o => ({ band: o.price_band, p: Number(o.model_p_accept), y: OUTCOME[o.status], cp: `${o.league_id}:${o.counterparty_team_id}`, at: o.proposed_at ?? null })));
  const at = offers.filter(o => o.band === 'at');
  const below = offers.filter(o => o.band === 'below');
  const common = { check: CHECK, name: NAME, metricName: 'accept_rate_minus_predicted_at_yes_point', passBar: PASS_BAR };
  const floor = minOffersToDecide();
  const baseDetail = { at_yes_point: at.length, below_yes_point: below.length, rule: { alpha: ALPHA, max_width: MAX_WIDTH, min_offers_to_decide: floor },
    ...(reason ? { reason } : {}) };
  if (!at.length) {
    return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, n: 0, needsN: floor, needsUnit: 'offers', detail: baseDetail,
      needsText: `needs ${floor} more offers${reason ? ` (${reason})` : ''}` });
  }
  const cs = confidenceSequence(at.map(o => o.y - o.p), { lo: -1, hi: 1, alpha: ALPHA, ref: 0 });
  const ci = [cs.lower, cs.upper];
  const belowCS = below.length ? confidenceSequence(below.map(o => o.y), { lo: 0, hi: 1, alpha: ALPHA, ref: 0.5 }) : null;
  const pooled = hierCalibration(at.map(o => o.p), at.map(o => o.y), at.map(o => o.cp), { fixSlope: true });
  const detail = {
    ...baseDetail,
    observed_at: mean(at.map(o => o.y)), predicted_at: mean(at.map(o => o.p)),
    e_value_above_prediction: round(cs.e_above, 3), e_value_below_prediction: round(cs.e_below, 3),
    below_accept_rate: belowCS ? belowCS.mean : null, below_accept_ci: belowCS ? [belowCS.lower, belowCS.upper] : null,
    pooled_offsets: pooled && { intercept: round(pooled.intercept), intercept_se: round(pooled.intercept_se), tau: pooled.tau,
      managers: pooled.managers.slice(0, 5).map(m => ({ ...m, offset: round(m.offset), observed: round(m.observed), predicted: round(m.predicted) })) },
  };
  const belowFails = belowCS && belowCS.lower > 0.5;
  if (ciExcludesZero(ci) || belowFails) {
    return result({ ...common, status: STATUS.FAILING, metric: cs.mean, ci, n: at.length, detail: {
      ...detail, why: [ciExcludesZero(ci) && 'accept rate at the yes point is off the prediction', belowFails && 'offers below the yes point are mostly accepted'].filter(Boolean) } });
  }
  const width = cs.upper - cs.lower;
  if (width <= MAX_WIDTH && (!belowCS || belowCS.mean < 0.5)) {
    return result({ ...common, status: STATUS.PASSING, metric: cs.mean, ci, n: at.length, detail });
  }
  const needs = Math.max(moreNeeded(at.length, width, MAX_WIDTH), floor - at.length, 1);
  return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, metric: cs.mean, ci, n: at.length, needsN: needs, needsUnit: 'offers', detail });
}

// No source yet. The planned OFFER-01 `offer_log` has no writer anywhere in the repo
// (INTEGRATION-AUDIT-0923 section 5), so reading it only ever graded an empty table.
// Sent offers get a price band with FIX-09: `trade_outcomes.price_band` + `move_id`
// (migration 083), written by the War Room "I sent it" path; E2 then reads
// trade_outcomes rows that have `sent_at`. Until then E2 says what it is waiting for.
export const NO_SOURCE_REASON = 'no writer records a sent offer\'s price band yet '
  + '(FIX-09 adds trade_outcomes.price_band, migration 083)';

export function load(_database) {
  return { rows: [], reason: NO_SOURCE_REASON };
}

export function run(database) {
  const { rows, reason } = load(database);
  return grade(rows, { reason });
}
