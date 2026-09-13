import { createHash } from 'node:crypto';

// Shared by fitted artifacts, calibration construction and the serving board.
// This binds algorithm/configuration and information regime. It is not yet a
// frozen T−60 packet or a hash of each historical dataset / learned parameter.
// v9 (2026-09-10, Codex audit finding M05): the residual-skill gate's slope
// is now fit on an earlier chronological block and graded on a later,
// disjoint block, instead of fitting and scoring the same rows -- a real
// methodology change, so no artifact fit under the old (v8 and earlier)
// same-rows formula may ever be reused as if it reflected this one.
//
// v10 (2026-09-10, Codex corrections C04 and C07): two more methodology
// changes, both of which alter what the same input data produces.
//
//   C04 -- opponent EXPOSURE now uses the same season window as the EPA
//          features it adjusts. It previously spanned every game in history
//          while the features spanned two seasons, so a team's 2016 opponents
//          were counted as exposure and then priced with 2024 defensive
//          efficiency. The audit measured the cost directly: adding 2016
//          schedule rows moved the isolated 2024 component from -23.400 to
//          +16.714 with the 2024 features unchanged. The sparse-coverage
//          fallback is now explicit rather than emerging from averaging one
//          game.
//
//   C07 -- the residual fit/score boundary now falls between COMPLETE WEEKS.
//          A row-index split cut a Sunday slate in half roughly six times out
//          of seven, and games in one week share a week of common information,
//          so the score block was not out of fold.
//
// v11 (2026-09-12, model integration branch): the residual-skill GATE changed
// instrument. It read an ad hoc paired t over per-game squared errors and a
// fixed -1.645 cutoff; it now reads a Diebold-Mariano statistic with the
// Harvey-Leybourne-Newbold small-sample correction, clustered by week, against
// a one-sided 5% p-value on t with (weeks - 1) df. That decides which
// components earn residual weight, so the same input data now produces a
// different set of weights -- which is precisely the condition this constant
// exists to detect.
//
// Two further changes on the same merge alter what a component emits for the
// same game: weather_total now applies each offense's own shrunk dome/cold/wind
// response instead of one flat league constant, and predictiveDistribution
// returns a Mondrian split-conformal interval instead of a pooled-SD normal
// widened by an unmeasured disagreement multiplier.
//
// Without this bump a fit artifact persisted under v10 would be loaded and
// served as though it described the current estimator: old weights, chosen by
// the superseded gate, in front of components that no longer produce the same
// numbers. Bumping is the whole mechanism that prevents that.
//
// A weight, slope or calibration fitted under v9 or v10 describes a different
// estimator and may not be reused as though it reflected this one.
export const ENSEMBLE_FIT_VERSION = 'nfl-ensemble-fit-v11-dm-gate-conformal-interval-weather-response';
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
