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
  if (!fit) {
    const orphan = orphanedPromotedFit(epochId, season, week);
    if (orphan) return orphanedFallback(orphan, epochId);
    return { ...weightSetFrom(null, week), frozen_reason: whyFrozen(epochId, season, week) };
  }
  // `early` (weeks 2-4 buckets) is served only inside its stored week window, so a
  // week-1 or week-5+ caller gets exactly the per-position vectors it always got.
  return weightSetFrom(fit, week);
}

/**
 * A promoted fit this caller WOULD have been served but for the epoch filter.
 *
 * Same cutoff as above, epoch clause dropped. That difference is the whole point:
 * a fit excluded by the cutoff is the leakage guard doing its job, and reporting it
 * would cry wolf; a fit excluded only by `epoch_id` means the champion was promoted,
 * an epoch was rolled after it, and nothing else changed.
 *
 * Runs only when the epoch-filtered lookup found nothing, so the common path pays
 * for no extra query.
 */
function orphanedPromotedFit(epochId, season, week) {
  return rows(`SELECT id, epoch_id FROM weekly_ensemble_fits WHERE promoted=1 AND epoch_id<>?
            AND (through_season < ? OR (through_season = ? AND through_week < ?))
            ORDER BY through_season DESC, through_week DESC, id DESC LIMIT 1`,
  epochId, season, season, week)[0];
}

/**
 * Why the frozen constants are being served, for a surface to repeat verbatim.
 *
 * `source` stays 'frozen' for both cases below: model-integrity.js pins that
 * contract for the cutoff case, and widening the vocabulary would make every
 * consumer re-learn it to gain nothing. The account goes here instead.
 *
 * The distinction is not cosmetic. "Nothing has ever been promoted" means the
 * weekly learning loop has never completed a promotion and someone should look at
 * the loop; "everything promoted is trained through this week or later" means the
 * loop works and the leakage guard is doing its job. Reported as one string, those
 * two send whoever is debugging to opposite ends of the system.
 */
function whyFrozen(epochId, season, week) {
  const promotedAtAll = rows(`SELECT id, through_season, through_week FROM weekly_ensemble_fits
            WHERE promoted=1 AND epoch_id=?
            ORDER BY through_season DESC, through_week DESC, id DESC LIMIT 1`, epochId)[0];
  if (!promotedAtAll) {
    return `a weekly ensemble fit has never been promoted in epoch ${epochId}; ` +
      'serving the frozen 2023 constants. The weekly learning loop has not completed a promotion.';
  }
  return `every promoted fit in epoch ${epochId} is trained through ` +
    `${promotedAtAll.through_season} week ${promotedAtAll.through_week} or later, which the ` +
    `leakage cutoff excludes for ${season} week ${week}; serving the frozen 2023 constants.`;
}

// One line per (fit, active epoch), not per player-week: activeWeeklyWeightSet runs
// once per projected player, and a warning that repeats ten thousand times a pass is
// noise nobody reads. The condition cannot change without one of these two changing.
const announcedOrphans = new Set();

/**
 * The frozen fallback, saying what it is.
 *
 * Rolling a learning epoch (startLearningEpoch, behind
 * POST /api/nfl-betting/engine/learning-epoch) leaves the previous epoch's promoted
 * fit in place and invisible: activeWeeklyWeightSet stops matching it and the
 * frozen-2023 constants are served instead. Before this, that was silent and shaped
 * exactly like a genuine cold start -- the layer went inert and said nothing, which
 * is the one thing this project does not allow.
 *
 * The NUMBERS are deliberately unchanged: the same frozen vectors, under the same
 * `frozen-2023` id. Only the account of them changes, via `source` and
 * `orphaned_fit`, so a surface that reports the served weight set (see
 * player-week-engine.js `weight_source`) can say the champion is orphaned rather
 * than absent. Re-promote into the active epoch to clear it.
 */
function orphanedFallback(orphan, activeEpochId) {
  const key = `${orphan.id}:${activeEpochId}`;
  if (!announcedOrphans.has(key)) {
    announcedOrphans.add(key);
    console.warn(`[weights] serving frozen-2023: promoted fit ${orphan.id} is in epoch ` +
      `${orphan.epoch_id} but the active learning epoch is ${activeEpochId}, so it is ` +
      'invisible to activeWeeklyWeightSet. Re-promote into the active epoch.');
  }
  return {
    id: 'frozen-2023',
    weights: WEEKLY_ENSEMBLE_WEIGHTS,
    source: 'frozen-orphaned-epoch',
    orphaned_fit: { fit_id: orphan.id, fit_epoch_id: orphan.epoch_id, active_epoch_id: activeEpochId }
  };
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

/**
 * One stored fit by its numeric id, whatever is promoted now. For gate scripts, whose
 * baseline is pre-registered by id: looking it up with activeWeeklyWeightSet() at run
 * time grades a different baseline as soon as a new fit is promoted, and the recorded
 * result can no longer be reproduced. `week` applies the early-week window exactly as
 * activeWeeklyWeightSet does. `data_hash` identifies the fit in a result file.
 */
export function weeklyWeightSetById(id, { week = null } = {}) {
  if (!Number.isInteger(id)) throw new Error(`weeklyWeightSetById needs an integer fit id (got ${JSON.stringify(id)})`);
  const fit = rows('SELECT * FROM weekly_ensemble_fits WHERE id = ?', id)[0];
  if (!fit) throw new Error(`weekly ensemble fit ${id} is not stored in this database`);
  return { ...weightSetFrom(fit, week), source: 'pinned', data_hash: fit.data_hash };
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

/**
 * The early-week block of the newest promoted fit (this epoch) that has one, or null.
 * Read uncut: the block carries its own week window, and callers need that window.
 */
export function storedEarlyWeights() {
  const epochId = activeLearningEpoch()?.id ?? 1;
  const fits = rows(`SELECT weights_json FROM weekly_ensemble_fits WHERE promoted=1 AND epoch_id=?
            ORDER BY through_season DESC, through_week DESC, id DESC`, epochId);
  for (const fit of fits) {
    const early = JSON.parse(fit.weights_json)?.early;
    if (early) return early;
  }
  return null;
}

/**
 * A promoted fit without `early` inherits the stored early block. The invariant lives
 * here, not in each caller, because the scheduled retrain (weekly-learning.js) fits the
 * per-position vectors only: saved as-is, the newest promoted fit had no `early`, and
 * weeks 2-4 silently went back to the blend that was proved worse there. A rejected
 * fit is ledger-only and is stored exactly as evaluated.
 */
export function saveWeeklyFit(input) {
  const epochId = activeLearningEpoch()?.id ?? 1;
  const fit = input.promoted
    ? { ...input, weights: carryEarlyWeights(input.weights, { early: storedEarlyWeights() }) }
    : input;
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

/**
 * Promote a fit and keep it live only if the caller's read-back checks pass.
 *
 * `verify(saved)` runs against the stored, promoted row (it may read the store through
 * activeWeeklyWeightSet) and returns a list of failures; a throw is a failure. On any
 * failure the fit is demoted (promoted = 0, rejection_reason = the failures), and the
 * demotion is itself checked: the fit must no longer be served for the weeks it was
 * legal for, or this throws. The promotion scripts used to save promoted = 1, run the
 * same checks, and on a failure print "Demote by hand" and exit 1, which left the
 * failed fit serving every request (review-fixes-2, finding 4).
 *
 * The checks are not run inside one transaction on purpose: a harness replay holds
 * the write lock for longer than the server's 15 s busy_timeout.
 *
 * @returns {{ ok: boolean, saved: object, failures: string[], demoted: boolean }}
 */
export function promoteWeeklyFitChecked(input, verify) {
  const saved = saveWeeklyFit({ ...input, promoted: 1 });
  let failures;
  try {
    failures = [...(verify(saved) ?? [])].map(String);
  } catch (error) {
    failures = [`the read-back check threw: ${error?.message ?? error}`];
  }
  if (!failures.length) return { ok: true, saved, failures, demoted: false };

  run(`UPDATE weekly_ensemble_fits SET promoted = 0, rejection_reason = ? WHERE data_hash = ?`,
    `rolled back after promotion: ${failures.join('; ')}`.slice(0, 1000), saved.stored_data_hash);
  const after = rows('SELECT id, promoted FROM weekly_ensemble_fits WHERE data_hash = ?', saved.stored_data_hash)[0];
  const next = saved.through_week >= 18
    ? { season: saved.through_season + 1, week: 1 }
    : { season: saved.through_season, week: saved.through_week + 1 };
  const stillServed = [next, { season: next.season, week: Math.max(next.week, 3) }]
    .some(at => activeWeeklyWeightSet(at).fit?.data_hash === saved.stored_data_hash);
  if (after?.promoted || stillServed) {
    throw new Error(`fit ${saved.stored_data_hash} failed its read-back check (${failures.join('; ')}) ` +
      'and could not be demoted; it is still served');
  }
  return { ok: false, saved, failures, demoted: true };
}

export function weeklyFitHistory(limit = 20) {
  return rows('SELECT * FROM weekly_ensemble_fits ORDER BY id DESC LIMIT ?', limit)
    .map(fit => ({ ...fit, weights: JSON.parse(fit.weights_json) }));
}
