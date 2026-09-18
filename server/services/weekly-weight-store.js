/** Versioned champion weights for the weekly ensemble. */
import { rows, run } from '../db/index.js';
import {
  WEEKLY_ENSEMBLE_WEIGHTS, WEEKLY_ENSEMBLE_HEADS, EARLY_WEEK_MAX_PRIOR_WEEKS, weeklyWeightSetForWeek
} from './weekly-ensemble.js';
import { activeLearningEpoch } from './nfl-engine-registry.js';

export const weeklyFitDataHash = hash => `e${activeLearningEpoch()?.id ?? 1}:${hash}`;

/**
 * The champion weights that were LEGITIMATELY available for predicting (season, week):
 * the newest promoted fit whose training data ends strictly before it.
 *
 * The cutoff is mandatory, and a non-integer season or week throws. It used to be
 * optional: anything that failed `Number.isInteger` — a string week from a query
 * string, a null, or no argument at all — silently fell through to a second query
 * with NO cutoff clause and got the newest fit regardless of what it was trained on.
 * Probed against the shipped DB, `{season: 2025, week: '10'}` returned fit-1, which
 * was trained on 2025 weeks 5-18, for a 2025 week-10 prediction. That is leakage
 * that never throws. The only production caller that relied on it was the weekly
 * retrain in weekly-learning.js, which used the unbounded result as the CHAMPION it
 * grades a candidate against — so the champion could have seen the validation rows,
 * look artificially strong, and cause the gate to refuse good candidates.
 *
 * A caller that genuinely wants "whatever is newest, for display" must say so by
 * calling latestWeeklyWeightSet(), which is named for what it is.
 */
export function activeWeeklyWeightSet({ season, week } = {}) {
  if (!Number.isInteger(season) || !Number.isInteger(week)) {
    throw new Error(`activeWeeklyWeightSet requires an integer season and week (got ${JSON.stringify({ season, week })}); ` +
      'use latestWeeklyWeightSet() for an uncut display read');
  }
  const epochId = activeLearningEpoch()?.id ?? 1;
  const fit = rows(`SELECT * FROM weekly_ensemble_fits WHERE promoted=1 AND epoch_id=?
            AND (through_season < ? OR (through_season = ? AND through_week < ?))
            ORDER BY through_season DESC, through_week DESC, id DESC LIMIT 1`, epochId, season, season, week)[0];
  // `early` (weeks 2-4 buckets) is served only inside its stored week window, so a
  // week-1 or week-5+ caller gets exactly the per-position vectors it always got.
  return weightSetFrom(fit, week);
}

/**
 * The newest promoted fit with NO cutoff. For status and display only: it may have
 * been trained on the very weeks a caller is about to predict or grade, so never
 * predict or grade with it.
 */
export function latestWeeklyWeightSet() {
  const epochId = activeLearningEpoch()?.id ?? 1;
  const fit = rows(`SELECT * FROM weekly_ensemble_fits WHERE promoted=1 AND epoch_id=?
            ORDER BY through_season DESC, through_week DESC, id DESC LIMIT 1`, epochId)[0];
  return weightSetFrom(fit);
}

function weightSetFrom(fit, week = null) {
  if (!fit) return { id: 'frozen-2023', weights: WEEKLY_ENSEMBLE_WEIGHTS, source: 'frozen' };
  const weights = JSON.parse(fit.weights_json);
  return { id: `fit-${fit.id}`, weights: week == null ? weights : weeklyWeightSetForWeek(weights, week), source: 'adaptive', fit };
}

const EARLY_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

/**
 * Refuse an early-week block that weeklyEnsemblePrediction() would silently skip or
 * misread: a week window that is not [lo, hi] with 2 <= lo <= hi (week 1's single
 * "prior week" is a prior-season average, not a game), a bucket that is not a
 * prior-game count in 1-3, or any bucket/position that is not a convex 5-vector.
 * A missing position would quietly fall back to the live vector; a bare array would
 * never be read. Both are refused here rather than discovered in production.
 */
export function validateEarlyWeights(early) {
  const fail = why => { throw new Error(`refusing to store weightSet.early: ${why}`); };
  if (!early || typeof early !== 'object' || Array.isArray(early)) fail('it is not an object');
  const weeks = early.weeks;
  if (!Array.isArray(weeks) || weeks.length !== 2 || !weeks.every(Number.isInteger) || weeks[0] < 2 || weeks[1] < weeks[0]) {
    fail(`week window ${JSON.stringify(weeks)} must be [lo, hi] with 2 <= lo <= hi`);
  }
  const keys = Object.keys(early.buckets ?? {});
  if (!keys.length || Array.isArray(early.buckets)) fail('it has no prior-game buckets');
  for (const key of keys) {
    const n = Number(key);
    if (!Number.isInteger(n) || n < 1 || n > EARLY_WEEK_MAX_PRIOR_WEEKS) {
      fail(`bucket "${key}" is not a prior-game count in 1-${EARLY_WEEK_MAX_PRIOR_WEEKS}`);
    }
    for (const position of EARLY_POSITIONS) {
      const w = early.buckets[key]?.[position];
      const convex = Array.isArray(w) && w.length === WEEKLY_ENSEMBLE_HEADS.length
        && w.every(x => Number.isFinite(x) && x >= 0 && x <= 1)
        && Math.abs(w.reduce((a, b) => a + b, 0) - 1) <= 1e-9;
      if (!convex) fail(`bucket ${key} ${position} is not a convex ${WEEKLY_ENSEMBLE_HEADS.length}-vector: ${JSON.stringify(w)}`);
    }
  }
  return true;
}

/**
 * Re-promoting the weeks 5-18 vector must not silently drop the early-week buckets.
 * Returns `next` with `previous.early` attached when `next` has none of its own.
 */
export function carryEarlyWeights(next, previous) {
  if (next?.early || !previous?.early) return next;
  return { ...next, early: previous.early };
}

export function saveWeeklyFit(fit) {
  const epochId = activeLearningEpoch()?.id ?? 1;
  if (fit.weights?.early !== undefined) validateEarlyWeights(fit.weights.early);
  const storedHash = weeklyFitDataHash(fit.data_hash);
  const result = run(`INSERT INTO weekly_ensemble_fits
    (data_hash,through_season,through_week,weights_json,sample_size,validation_size,
     candidate_mae,champion_mae,candidate_spearman,champion_spearman,coverage_80,promoted,rejection_reason,epoch_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(data_hash) DO NOTHING`,
  storedHash, fit.through_season, fit.through_week, JSON.stringify(fit.weights),
  fit.sample_size, fit.validation_size, fit.candidate_mae, fit.champion_mae,
  fit.candidate_spearman, fit.champion_spearman, fit.coverage_80,
  fit.promoted ? 1 : 0, fit.rejection_reason ?? null, epochId);
  return { inserted: result.changes > 0, ...fit, stored_data_hash: storedHash, epoch_id: epochId };
}

export function weeklyFitHistory(limit = 20) {
  return rows('SELECT * FROM weekly_ensemble_fits ORDER BY id DESC LIMIT ?', limit)
    .map(fit => ({ ...fit, weights: JSON.parse(fit.weights_json) }));
}
