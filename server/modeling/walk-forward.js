import { assertTimestampedObservation, assertUniqueObservations, configurationHash, FEATURE_SET_VERSION, PIPELINE_VERSION } from './contracts.js';

const period = row => Number(row.season) * 100 + Number(row.week);
const order = (a, b) => period(a) - period(b) || String(a.player_id).localeCompare(String(b.player_id));

export function createWalkForwardSplits(observations, { holdoutSeason, minimumTrainingPeriods = 1 } = {}) {
  const clean = assertUniqueObservations([...observations].sort(order).map(assertTimestampedObservation));
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

function predictAll(model, evaluate) {
  return evaluate.map(row => {
    try {
      const value = model.predict(row.features ?? {}, row);
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
    candidate: candidate.name ?? 'unnamed', options };
  const folds = splitPlan.splits.map(split => {
    const model = candidate.fit(split.train);
    return { cutoff: split.cutoff, training_rows: split.train.length, predictions: predictAll(model, split.evaluate) };
  });
  return {
    run_id: configurationHash({ config, observations: observations.map(x => [x.player_id, x.season, x.week, x.as_of]) }),
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

