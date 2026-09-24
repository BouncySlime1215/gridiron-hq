/**
 * E1 accept calibration: when the brain says an offer is 40% to be accepted,
 * are about 40% accepted? And does it beat knowing only who is active?
 *
 * Source: `trade_outcomes` app_proposed rows (migration 067 — every sent offer
 * carries the model_p_accept it was sent with), plus the OFFER-01 `offer_log`
 * when that table exists with the columns below. Resolved statuses only:
 * accepted = 1; declined, countered, expired = 0. 'proposed' (no answer yet)
 * and 'ignored' (never answered either way) are not outcomes.
 *
 * Baseline ("activity only"): the counterparty's own prior accept rate, shrunk
 * to the prior all-offer rate, using only offers resolved BEFORE this one — so
 * it is cutoff-safe and knows nothing about the offer's content. A row that
 * carries its own baseline_p_accept (offer_log) uses that instead.
 *
 * Pass bar (EVAL-01): reliability slope 0.8-1.2 AND log-loss gain over the
 * baseline with a 95% CI above 0. Failing only when the evidence is clear: the
 * slope CI lies wholly outside 0.8-1.2, or the gain CI lies wholly below 0.
 */
import { STATUS, result, readSource, waiting } from './common.js';
import { bootstrapCI, calibrationSlope, logLoss, mean, moreNeeded, reliabilityBuckets } from './stats.js';

export const CHECK = 'E1';
export const NAME = 'Accept calibration';
export const MIN_N = 50;
export const MIN_EACH_CLASS = 5;
export const SLOPE_BAND = [0.8, 1.2];
const PASS_BAR = 'reliability slope 0.8-1.2 and log-loss gain vs activity-only CI > 0';
const SHRINK_K = 5;

const OUTCOME = { accepted: 1, declined: 0, countered: 0, expired: 0 };

/** Historical stand-in (BENCHMARKS.md E1 row): not a grade of P(accept) — Sleeper has no declines. */
export const HISTORICAL_STANDIN = Object.freeze({
  target: 'P(pair trades this week), Sleeper 2023 / 2024 held out, fit 2021-22',
  slopes: [0.93, 0.90],
  log_loss_gain: [{ season: 2023, gain: 0.00025, ci: [0.00011, 0.00040] }, { season: 2024, gain: 0.00036, ci: [0.00019, 0.00055] }],
  note: 'all of the gain over activity-only comes from week of season; true P(accept) is untestable on Sleeper',
});

/** Activity-only baseline per offer, from strictly earlier resolved offers. */
export function activityBaseline(offers) {
  const order = offers.map((o, i) => i).sort((a, b) => String(offers[a].proposed_at ?? '').localeCompare(String(offers[b].proposed_at ?? '')) || a - b);
  const byCp = new Map();
  let accAll = 0;
  let nAll = 0;
  const base = new Array(offers.length);
  for (const i of order) {
    const o = offers[i];
    const key = `${o.league_id}:${o.counterparty_team_id}`;
    const cp = byCp.get(key) ?? { acc: 0, n: 0 };
    const g = (accAll + 1) / (nAll + 2);
    base[i] = o.baseline_p_accept != null ? Number(o.baseline_p_accept) : (cp.acc + SHRINK_K * g) / (cp.n + SHRINK_K);
    cp.acc += o.y; cp.n += 1; byCp.set(key, cp);
    accAll += o.y; nAll += 1;
  }
  return base;
}

export function grade(rawOffers, { reason = null } = {}) {
  const offers = rawOffers
    .filter(o => o.model_p_accept != null && Object.hasOwn(OUTCOME, o.status))
    .map(o => ({ ...o, p: Number(o.model_p_accept), y: OUTCOME[o.status] }));
  const n = offers.length;
  const acc = offers.reduce((a, o) => a + o.y, 0);
  const common = { check: CHECK, name: NAME, metricName: 'log_loss_gain_vs_activity', passBar: PASS_BAR };
  const baseDetail = { historical_standin: HISTORICAL_STANDIN, accepted: acc, not_accepted: n - acc };
  if (n < MIN_N || acc < MIN_EACH_CLASS || n - acc < MIN_EACH_CLASS) {
    const minority = Math.min(acc, n - acc);
    const needs = Math.max(MIN_N - n, MIN_EACH_CLASS - minority, 1);
    return waiting({ ...common, minN: n + needs, n, unit: 'offers',
      reason: reason ?? (n >= MIN_N ? `needs at least ${MIN_EACH_CLASS} accepted and ${MIN_EACH_CLASS} not accepted` : null),
      detail: baseDetail });
  }
  const p = offers.map(o => o.p);
  const y = offers.map(o => o.y);
  const b = activityBaseline(offers);
  const gainOf = idx => logLoss(idx.map(i => b[i]), idx.map(i => y[i])) - logLoss(idx.map(i => p[i]), idx.map(i => y[i]));
  const all = offers.map((_, i) => i);
  const gain = gainOf(all);
  const clusters = offers.map(o => `${o.league_id}:${o.counterparty_team_id}`);
  const gainCI = bootstrapCI(n, gainOf, { clusters, reps: 1000, seed: 303 });
  const slope = calibrationSlope(p, y);
  const slopeCI = bootstrapCI(n, idx => calibrationSlope(idx.map(i => p[i]), idx.map(i => y[i])), { clusters, reps: 300, seed: 304 });
  const detail = {
    ...baseDetail,
    log_loss_model: logLoss(p, y), log_loss_activity_only: logLoss(b, y),
    slope, slope_ci: slopeCI, mean_predicted: mean(p), observed_rate: acc / n,
    reliability: reliabilityBuckets(p, y),
  };
  const [lo, hi] = SLOPE_BAND;
  const slopeClearlyOut = slopeCI && (slopeCI[1] < lo || slopeCI[0] > hi);
  const gainClearlyNegative = gainCI && gainCI[1] < 0;
  if (slopeClearlyOut || gainClearlyNegative) {
    return result({ ...common, status: STATUS.FAILING, metric: gain, ci: gainCI, n, detail: {
      ...detail, why: [slopeClearlyOut && 'reliability slope CI outside 0.8-1.2', gainClearlyNegative && 'loses to activity-only on log loss'].filter(Boolean) } });
  }
  if (slope != null && slope >= lo && slope <= hi && gainCI && gainCI[0] > 0) {
    return result({ ...common, status: STATUS.PASSING, metric: gain, ci: gainCI, n, detail });
  }
  const gainTarget = Math.max(Math.abs(gain), 1e-4) * 2;
  const needs = Math.max(
    gainCI ? moreNeeded(n, gainCI[1] - gainCI[0], gainTarget) : MIN_N,
    slopeCI ? moreNeeded(n, slopeCI[1] - slopeCI[0], hi - lo) : 1,
  );
  return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, metric: gain, ci: gainCI, n, needsN: needs, needsUnit: 'offers', detail });
}

const COLS = ['league_id', 'counterparty_team_id', 'proposed_at', 'model_p_accept', 'status', 'idea_id'];

export function load(database) {
  const t = readSource(database, 'trade_outcomes', COLS,
    `SELECT ${COLS.join(', ')} FROM trade_outcomes WHERE source = 'app_proposed' AND model_p_accept IS NOT NULL`);
  if (!t.ok) return { rows: [], reason: t.reason };
  const seen = new Set(t.rows.filter(r => r.idea_id != null).map(r => `${r.league_id}:${r.idea_id}`));
  const log = readSource(database, 'offer_log', COLS);
  const extra = log.ok ? log.rows.filter(r => r.idea_id == null || !seen.has(`${r.league_id}:${r.idea_id}`)) : [];
  return { rows: [...t.rows, ...extra], sources: ['trade_outcomes', ...(log.ok ? ['offer_log'] : [])] };
}

export function run(database) {
  const { rows, reason } = load(database);
  return grade(rows, { reason });
}
