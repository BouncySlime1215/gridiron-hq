/**
 * E5 step value, live: each executed campaign step's predicted title-odds
 * gain vs the realized change (paired-seed rescoring after the fact).
 *
 * Source: `campaign_steps` (083). The campaign producer writes one row per
 * executed step with predicted_title_odds_gain when it consumes the
 * offer.sent event, and realized_title_odds_gain once the step settles
 * accepted and is rescored; league_id for clustering. Steps not yet realized
 * are counted (detail.awaiting_realized), not graded.
 *
 * Pass bar: mean realized gain CI > 0 AND the realized-minus-predicted CI
 * contains 0. Failing: realized CI wholly below 0, or realized-minus-predicted
 * CI excludes 0 (the plan's promises are off in one direction).
 */
import { STATUS, result, readSource, waiting, ciExcludesZero } from './common.js';
import { bootstrapCI, mean, moreNeeded } from './stats.js';

export const CHECK = 'E5';
export const NAME = 'Step value, live';
export const MIN_N = 15;
const PASS_BAR = 'mean realized title-odds gain CI > 0 and within CI of predicted';

export function grade(rawSteps, { reason = null } = {}) {
  const awaiting = rawSteps.filter(s => s.predicted_title_odds_gain != null && s.realized_title_odds_gain == null).length;
  const steps = rawSteps.filter(s => s.predicted_title_odds_gain != null && s.realized_title_odds_gain != null)
    .map(s => ({ pred: Number(s.predicted_title_odds_gain), real: Number(s.realized_title_odds_gain), league: s.league_id }));
  const n = steps.length;
  const common = { check: CHECK, name: NAME, metricName: 'mean_realized_title_odds_gain', passBar: PASS_BAR };
  if (n < MIN_N) return waiting({ ...common, minN: MIN_N, n, unit: 'steps', reason, detail: { awaiting_realized: awaiting } });
  const clusters = steps.map(s => s.league);
  const realized = mean(steps.map(s => s.real));
  const ci = bootstrapCI(n, idx => mean(idx.map(i => steps[i].real)), { clusters, seed: 310 });
  const gapCI = bootstrapCI(n, idx => mean(idx.map(i => steps[i].real - steps[i].pred)), { clusters, seed: 311 });
  const detail = { awaiting_realized: awaiting, mean_predicted: mean(steps.map(s => s.pred)), realized_minus_predicted: mean(steps.map(s => s.real - s.pred)), gap_ci: gapCI };
  if ((ci && ci[1] < 0) || ciExcludesZero(gapCI)) {
    return result({ ...common, status: STATUS.FAILING, metric: realized, ci, n, detail: { ...detail,
      why: [ci && ci[1] < 0 && 'executed steps lose title odds', ciExcludesZero(gapCI) && 'realized gain is off the predicted gain'].filter(Boolean) } });
  }
  if (ci && ci[0] > 0) return result({ ...common, status: STATUS.PASSING, metric: realized, ci, n, detail });
  const needs = ci ? moreNeeded(n, ci[1] - ci[0], Math.max(Math.abs(realized), 1e-3) * 2) : MIN_N;
  return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, metric: realized, ci, n, needsN: needs, needsUnit: 'steps', detail });
}

const COLS = ['league_id', 'predicted_title_odds_gain', 'realized_title_odds_gain'];

export function load(database) {
  const s = readSource(database, 'campaign_steps', COLS);
  return s.ok ? { rows: s.rows } : { rows: [], reason: `${s.reason}; migration 083 builds it` };
}

export function run(database) {
  const { rows, reason } = load(database);
  return grade(rows, { reason });
}
