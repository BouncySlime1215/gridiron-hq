import { createHash } from 'node:crypto';

// Shared by fitted artifacts, calibration construction and the serving board.
// This binds algorithm/configuration and information regime. It is not yet a
// frozen T−60 packet or a hash of each historical dataset / learned parameter.
// v9 (2026-09-10, Codex audit finding M05): the residual-skill gate's slope
// is now fit on an earlier chronological block and graded on a later,
// disjoint block, instead of fitting and scoring the same rows -- a real
// methodology change, so no artifact fit under the old (v8 and earlier)
// same-rows formula may ever be reused as if it reflected this one.
export const ENSEMBLE_FIT_VERSION = 'nfl-ensemble-fit-v9-residual-oof-split';
const CALIBRATION_VERSION = 'cover-logit-v3-graph-bound';
const sorted = values => [...new Set(values ?? [])].sort();

export function spreadForecastIdentity({ modelOptions = {}, informationRegime,
  neuralVersion = null, reliabilityVersion = null } = {}) {
  if (!['historical_weekly_closing', 'live_weekly_unfrozen'].includes(informationRegime)) {
    throw new TypeError('an implemented forecast information regime is required');
  }
  const blendMode = modelOptions.blendMode ?? 'market_residual';
  const weighting = modelOptions.weighting ?? 'exponential';
  if (!['raw', 'market_residual'].includes(blendMode)) throw new TypeError('unsupported spread blend mode');
  if (!['exponential', 'inverse_mse', 'equal'].includes(weighting)) throw new TypeError('unsupported spread weighting');
  const descriptor = {
    schema_version: 'spread-forecast-identity-v1',
    target: 'full_game_spread_selected_side_nonpush_cover',
    ensemble_fit_version: ENSEMBLE_FIT_VERSION,
    information_regime: informationRegime,
    blend_mode: blendMode, weighting,
    families: sorted(modelOptions.families), excluded_models: sorted(modelOptions.excludeModels),
    include_challengers: modelOptions.includeChallengers === true,
    reliability_version: modelOptions.includeChallengers ? reliabilityVersion : null,
    neural_version: neuralVersion,
    market_probability_method: 'shin-no-vig-v1'
  };
  const id = createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
  return { id, descriptor };
}

export function coverCalibrationVersion(forecastIdentity) {
  if (!forecastIdentity?.id || !forecastIdentity?.descriptor ||
    createHash('sha256').update(JSON.stringify(forecastIdentity.descriptor)).digest('hex') !== forecastIdentity.id) {
    throw new TypeError('valid forecast identity required for cover calibration');
  }
  return `${CALIBRATION_VERSION}:${forecastIdentity.id}`;
}
