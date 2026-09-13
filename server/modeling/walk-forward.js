/**
 * The generic model-lab walk-forward contract: chronological period splits
 * (train on everything before a cutoff, evaluate the cutoff period) plus a
 * sealed final holdout that only `openFinalHoldout({ authorize: true })` may
 * open. Any candidate implementing `.fit(train)` -> model with `.predict()`
 * can be walked through this.
 *
 * Investigated during the stage-2 engine-unification pass as a possible
 * merge target for `server/services/weekly-walkforward.js` (same "walk
 * forward" name, same surface-level idea) and DELIBERATELY left separate:
 *
 *   - Different observation shape. This module requires a timestamped
 *     `player_id`/`season`/`week`/`as_of` observation (assertTimestampedObservation
 *     enforces it); weekly-walkforward.js's rows are per-GAME, with no player
 *     identity and no `as_of` to validate against.
 *   - Different holdout semantics. `createWalkForwardSplits` seals the LATEST
 *     season entirely -- it is never in `splits`, only ever available via the
 *     explicit, authorized `openFinalHoldout`. weekly-walkforward.js's whole
 *     point is to walk and GRADE every season it is given, including the
 *     latest one, to show whether accuracy rises with training size across
 *     the full history. Forcing it through a sealed-holdout contract would
 *     mean either lying about which season is "sealed" or losing the
 *     final-season grade its own report depends on.
 *
 * A shared name is not shared logic. Merging these would have meant an
 * adapter that fabricates the fields this contract needs and gives up the
 * one property (grading every season) the other module exists to provide --
 * a worse outcome than the duplication it would remove. Left as two engines.
 */
import { assertTimestampedObservation, assertUniqueObservations, configurationHash, FEATURE_SET_VERSION, PIPELINE_VERSION } from './contracts.js';

const period = row => Number(row.season) * 100 + Number(row.week);
const order = (a, b) => period(a) - period(b) || String(a.player_id).localeCompare(String(b.player_id));

export function createWalkForwardSplits(observations, { holdoutSeason, minimumTrainingPeriods = 1 } = {}) {
  // Detect duplicate observation keys (player/season/week) before running
  // deep timestamp validation so duplicate-key errors surface predictably.
  const sorted = [...observations].sort(order);
  assertUniqueObservations(sorted.map(r => ({ player_id: r.player_id, season: r.season, week: r.week })));
  const clean = assertUniqueObservations(sorted.map(assertTimestampedObservation));
  const seasons = [...new Set(clean.map(x => Number(x.season)))].sort((a, b) => a - b);
  const finalHoldout = holdoutSeason ?? seasons.at(-1);
  if (!seasons.includes(finalHoldout)) throw new Error('holdout season is absent from observations');
  if (finalHoldout !== seasons.at(-1)) throw new Error('final holdout must be the latest season');

  const evaluationPeriods = [...new Set(clean.filter(x => x.season < finalHoldout).map(period))].sort((a, b) => a - b);
  const splits = evaluationPeriods.map(cutoff => {
    const train = clean.filter(x => period(x) < cutoff);
    const evaluate = clean.filter(x => period(x) === cutoff);
    return { cutoff, train, evaluate };
  }).filter(split => new Set(split.train.map(period)).size >= minimumTrainingPeriods);

  const holdout = clean.filter(x => Number(x.season) === finalHoldout);
  const holdoutTrain = clean.filter(x => Number(x.season) < finalHoldout);
  return { splits, holdout: { season: finalHoldout, state: 'sealed', train: holdoutTrain, evaluate: holdout } };
}

const failurePrediction = (row, error) => ({
  player_id: row.player_id, season: row.season, week: row.week, as_of: row.as_of,
  status: 'failed', prediction: null, lower: null, upper: null,
  active_probability: row.active_probability ?? null, error: error instanceof Error ? error.message : String(error)
});

// Everything a candidate's predict() is allowed to see at prediction time: no
// outcome, no outcome_available_at. predictAll strips those before the call so a
// candidate cannot read the answer off the row it was asked to score.
function predictionTimeRow(row) {
  const { outcome, outcome_available_at, ...safe } = row;
  return safe;
}

function predictAll(model, evaluate) {
  return evaluate.map(row => {
    try {
      const value = model.predict(row.features ?? {}, predictionTimeRow(row));
      if (!value || !Number.isFinite(value.prediction)) throw new Error('model returned no finite prediction');
      return { player_id: row.player_id, season: row.season, week: row.week, as_of: row.as_of,
        status: row.inactive ? 'inactive' : 'predicted', active_probability: row.active_probability ?? null,
        ...value, actual: row.outcome ?? null };
    } catch (error) { return { ...failurePrediction(row, error), actual: row.outcome ?? null }; }
  });
}

export function runWalkForward(observations, candidate, options = {}) {
  if (typeof candidate?.fit !== 'function') throw new Error('candidate.fit is required');
  const splitPlan = createWalkForwardSplits(observations, options);
  const config = { pipeline: PIPELINE_VERSION, feature_set: FEATURE_SET_VERSION,
    candidate: candidate.name ?? 'unnamed', candidate_version: candidate.version ?? null,
    dataset_version: options.datasetVersion ?? null, options };
  const folds = splitPlan.splits.map(split => {
    const model = candidate.fit(split.train);
    return { cutoff: split.cutoff, training_rows: split.train.length, predictions: predictAll(model, split.evaluate) };
  });
  return {
    // Fingerprints the full observation set — feature values and outcomes
    // included, not just identity/timestamp keys — so two materially different
    // datasets can never collide onto the same run_id and silently overwrite
    // each other's stored predictions.
    run_id: configurationHash({ config, observations: observations.map(x => ({
      player_id: x.player_id, season: x.season, week: x.week, as_of: x.as_of,
      features: x.features ?? {}, outcome: x.outcome ?? null, outcome_available_at: x.outcome_available_at ?? null
    })) }),
    config, config_hash: configurationHash(config), folds,
    holdout: { season: splitPlan.holdout.season, state: 'sealed', eligible_rows: splitPlan.holdout.evaluate.length },
    missing_prediction_rate: (() => {
      const all = folds.flatMap(x => x.predictions);
      return all.length ? all.filter(x => x.status === 'failed').length / all.length : null;
    })()
  };
}

export function openFinalHoldout(observations, candidate, audit, { authorize = false } = {}) {
  if (!authorize) throw new Error('opening the final holdout requires explicit authorization');
  if (audit.holdout?.state !== 'sealed') throw new Error('holdout has already been opened');
  const plan = createWalkForwardSplits(observations, { holdoutSeason: audit.holdout.season });
  const model = candidate.fit(plan.holdout.train);
  return { ...audit, holdout: { season: plan.holdout.season, state: 'opened_once',
    predictions: predictAll(model, plan.holdout.evaluate) } };
}

