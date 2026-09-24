/**
 * E2 price accuracy: offers priced AT the clone's predicted "yes" point
 * (indifference price) should be accepted at about the rate the model predicted
 * there; offers priced BELOW it should mostly be declined.
 *
 * Source: the OFFER-01 `offer_log` (not built yet). Contract, one row per sent
 * offer: model_p_accept (at the price sent), price_band ('below' | 'at' |
 * 'above' the predicted yes point, decided by the producer that priced it),
 * status (trade_outcomes vocabulary). Sleeper counter/accept pairs cannot feed
 * this: Sleeper records no declines (BENCHMARKS.md E1 row).
 *
 * Metric: observed minus mean predicted accept rate on 'at' offers.
 * Pass bar: that difference's 95% CI contains 0 and is no wider than
 * +/-0.15, and (once >= 10 'below' offers exist) the 'below' accept rate is
 * under 50%. Failing: the CI excludes 0, or the 'below' accept rate's CI lies
 * wholly above 50% (offers under the yes point are getting accepted — the
 * price model is too stingy).
 */
import { STATUS, result, readSource, waiting, ciExcludesZero } from './common.js';
import { bootstrapCI, mean, moreNeeded } from './stats.js';

export const CHECK = 'E2';
export const NAME = 'Price accuracy';
export const MIN_AT = 30;
export const MIN_BELOW = 10;
export const MAX_HALF_WIDTH = 0.15;
const PASS_BAR = "accept rate at the predicted yes point within CI of predicted (CI width <= 0.30); offers below it < 50% accepted";
const OUTCOME = { accepted: 1, declined: 0, countered: 0, expired: 0 };

export function grade(rawOffers, { reason = null } = {}) {
  const offers = rawOffers
    .filter(o => o.model_p_accept != null && Object.hasOwn(OUTCOME, o.status))
    .map(o => ({ band: o.price_band, p: Number(o.model_p_accept), y: OUTCOME[o.status], cp: `${o.league_id}:${o.counterparty_team_id}` }));
  const at = offers.filter(o => o.band === 'at');
  const below = offers.filter(o => o.band === 'below');
  const common = { check: CHECK, name: NAME, metricName: 'accept_rate_minus_predicted_at_yes_point', passBar: PASS_BAR };
  if (at.length < MIN_AT) {
    return waiting({ ...common, minN: MIN_AT, n: at.length, unit: 'offers', reason,
      detail: { at_yes_point: at.length, below_yes_point: below.length } });
  }
  const diffOf = idx => mean(idx.map(i => at[i].y)) - mean(idx.map(i => at[i].p));
  const diff = diffOf(at.map((_, i) => i));
  const ci = bootstrapCI(at.length, diffOf, { clusters: at.map(o => o.cp), seed: 305 });
  let belowRate = null;
  let belowCI = null;
  if (below.length >= MIN_BELOW) {
    belowRate = mean(below.map(o => o.y));
    belowCI = bootstrapCI(below.length, idx => mean(idx.map(i => below[i].y)), { clusters: below.map(o => o.cp), seed: 306 });
  }
  const detail = {
    at_yes_point: at.length, below_yes_point: below.length,
    observed_at: mean(at.map(o => o.y)), predicted_at: mean(at.map(o => o.p)),
    below_accept_rate: belowRate, below_accept_ci: belowCI,
  };
  const belowFails = belowCI && belowCI[0] > 0.5;
  if (ciExcludesZero(ci) || belowFails) {
    return result({ ...common, status: STATUS.FAILING, metric: diff, ci, n: at.length, detail: {
      ...detail, why: [ciExcludesZero(ci) && 'accept rate at the yes point is off the prediction', belowFails && 'offers below the yes point are mostly accepted'].filter(Boolean) } });
  }
  const width = ci ? ci[1] - ci[0] : Infinity;
  if (ci && width <= 2 * MAX_HALF_WIDTH && (belowRate == null || belowRate < 0.5)) {
    return result({ ...common, status: STATUS.PASSING, metric: diff, ci, n: at.length, detail });
  }
  const needs = Math.max(ci ? moreNeeded(at.length, width, 2 * MAX_HALF_WIDTH) : 1, below.length < MIN_BELOW ? MIN_BELOW - below.length : 1);
  return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, metric: diff, ci, n: at.length, needsN: needs, needsUnit: 'offers', detail });
}

const COLS = ['league_id', 'counterparty_team_id', 'model_p_accept', 'price_band', 'status'];

export function load(database) {
  const s = readSource(database, 'offer_log', COLS);
  return s.ok ? { rows: s.rows } : { rows: [], reason: `${s.reason}; OFFER-01 builds it` };
}

export function run(database) {
  const { rows, reason } = load(database);
  return grade(rows, { reason });
}
