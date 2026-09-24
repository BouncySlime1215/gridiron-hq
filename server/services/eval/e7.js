/**
 * E7 luck vs decision: each finished week split into what the lineup choice
 * cost (decision) and what the dice did (luck).
 *
 *   luck     = actual points - expected points of the lineup that was started
 *   decision = expected points started - expected points of the best lineup (<= 0)
 *
 * Source: `weekly_autopsy` (PROJ-04-a, the Monday Autopsy producer, not built yet).
 * Contract: one row per team-week with season, week, league_id, team_id,
 * actual_points, expected_points, optimal_expected_points, all using the
 * pregame expected points that were served.
 *
 * What makes this a CHECK and not only a display: luck must average about 0.
 * If the "luck" line runs one way week after week, it is not luck — the
 * expected points are biased and the split is hiding a model error.
 *
 * Pass bar: shown for the latest finished week, and mean luck per team-week
 * has a 95% CI (resampling whole weeks) containing 0, over >= 4 weeks.
 * Failing: that CI excludes 0.
 */
import { STATUS, result, readSource, waiting, ciExcludesZero } from './common.js';
import { bootstrapCI, mean } from './stats.js';

export const CHECK = 'E7';
export const NAME = 'Luck vs decision';
export const MIN_WEEKS = 4;
const PASS_BAR = 'weekly split shown; mean luck per team-week CI contains 0 (>= 4 weeks)';

export function grade(rawRows, { reason = null } = {}) {
  const rows = rawRows
    .filter(r => [r.actual_points, r.expected_points, r.optimal_expected_points].every(v => v != null && Number.isFinite(Number(v))))
    .map(r => ({
      week_key: `${r.season}:${String(r.week).padStart(2, '0')}`,
      luck: Number(r.actual_points) - Number(r.expected_points),
      decision: Number(r.expected_points) - Number(r.optimal_expected_points),
    }));
  const weeks = [...new Set(rows.map(r => r.week_key))].sort();
  const common = { check: CHECK, name: NAME, metricName: 'mean_luck_points_per_team_week', passBar: PASS_BAR };
  const latestKey = weeks.at(-1);
  const latestRows = rows.filter(r => r.week_key === latestKey);
  const latest = latestKey ? {
    week: latestKey, teams: latestRows.length,
    mean_luck: mean(latestRows.map(r => r.luck)), mean_decision: mean(latestRows.map(r => r.decision)),
  } : null;
  if (weeks.length < MIN_WEEKS) {
    return waiting({ ...common, minN: MIN_WEEKS, n: weeks.length, unit: 'weeks', reason, detail: { latest_week: latest } });
  }
  const luck = mean(rows.map(r => r.luck));
  const ci = bootstrapCI(rows.length, idx => mean(idx.map(i => rows[i].luck)), { clusters: rows.map(r => r.week_key), seed: 314 });
  const detail = { weeks: weeks.length, team_weeks: rows.length, mean_decision: mean(rows.map(r => r.decision)), latest_week: latest };
  if (ciExcludesZero(ci)) {
    return result({ ...common, status: STATUS.FAILING, metric: luck, ci, n: rows.length, detail: {
      ...detail, why: `luck runs ${luck > 0 ? 'above' : 'below'} 0 across weeks: expected points are biased` } });
  }
  if (ci) return result({ ...common, status: STATUS.PASSING, metric: luck, ci, n: rows.length, detail });
  return result({ ...common, status: STATUS.NOT_ENOUGH_DATA, metric: luck, ci, n: rows.length, needsN: 1, needsUnit: 'weeks', detail });
}

const COLS = ['season', 'week', 'league_id', 'team_id', 'actual_points', 'expected_points', 'optimal_expected_points'];

export function load(database) {
  const s = readSource(database, 'weekly_autopsy', COLS);
  return s.ok ? { rows: s.rows } : { rows: [], reason: `${s.reason}; PROJ-04-a (Monday Autopsy) builds it` };
}

export function run(database) {
  const { rows, reason } = load(database);
  return grade(rows, { reason });
}
