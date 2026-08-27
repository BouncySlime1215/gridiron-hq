/**
 * Shared player-week state estimator.
 *
 * The structural head estimates football events (volume x efficiency). The
 * frozen Stage 1.3 ensemble updates that estimate from fantasy outcomes known
 * before the requested week. Fantasy scoring is a consumer of this state; the
 * props head will consume the same event parameters in Stage 2.2.
 */
import { rows } from '../db/index.js';
import { buildProjections, sampleWeeks } from './projections.js';
import { PPR, scoreLine } from './scoring.js';
import {
  WEEKLY_ROLE_RECENCY,
  weeklyEnsembleContext, weeklyEnsemblePrediction
} from './weekly-ensemble.js';
import { activeWeeklyWeightSet } from './weekly-weight-store.js';
import { roleChangepoints } from './role-changepoint.js';
import { percentiles, withRandomSeed } from './stats-util.js';

export const PLAYER_WEEK_ENGINE_VERSION = 'player-week-v1.1.0';
const engineCache = new Map();
const distributionCache = new Map();
const MAX_ENGINE_CACHE = 32;
const MAX_DISTRIBUTION_CACHE = 1200;

function remember(cache, key, value, limit) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
  return value;
}

export function clearPlayerWeekEngineCache() {
  engineCache.clear();
  distributionCache.clear();
}

function priorScores(season, week, scoring) {
  const out = new Map();
  for (const row of rows(`SELECT * FROM player_week_usage
                          WHERE season = ? AND week < ? ORDER BY week`, season, week)) {
    const list = out.get(row.player_id) ?? [];
    list.push(Number(scoreLine(row, scoring)));
    out.set(row.player_id, list);
  }
  return out;
}

export function buildPlayerWeekEngine({ season, week, scoring = PPR, kOverride, useCache = true } = {}) {
  if (!Number.isInteger(season) || !Number.isInteger(week) || week < 1 || week > 22) {
    throw new Error('player-week engine requires an integer season and week');
  }
  const weightChampion = activeWeeklyWeightSet({ season, week });
  const cacheKey = JSON.stringify({ season, week, scoring, kOverride: kOverride ?? 'active',
    version: PLAYER_WEEK_ENGINE_VERSION, weightFit: weightChampion.id });
  if (useCache && engineCache.has(cacheKey)) return engineCache.get(cacheKey);

  const structural = buildProjections({
    through: season, throughWeek: week - 1, scoring, kOverride,
    roleRecency: WEEKLY_ROLE_RECENCY
  });
  const history = priorScores(season, week, scoring);
  const roleChanges = roleChangepoints(season, week);
  const out = new Map();
  for (const [playerId, projection] of structural) {
    const context = weeklyEnsembleContext({
      structural: projection.ppg,
      priorWeeks: history.get(playerId) ?? [],
      position: projection.position
    });
    const weights = weightChampion.weights[projection.position];
    const ppg = context ? weeklyEnsemblePrediction(context, weightChampion.weights) : projection.ppg;
    const engine = {
      version: PLAYER_WEEK_ENGINE_VERSION,
      season, week,
      cutoff: `${season}-W${Math.max(0, week - 1)}`,
      mode: context ? 'position_ensemble' : 'structural_only_no_current_season_history',
      heads: context,
      weights: context ? weights : null,
      weight_fit: weightChampion.id,
      weight_source: weightChampion.source,
      role_change: roleChanges.get(playerId) ?? null
    };
    out.set(playerId, {
      ...projection,
      ppg: +ppg.toFixed(2),
      structural_ppg: projection.ppg,
      ensemble_shift: +(ppg - projection.ppg).toFixed(4),
      player_week_engine: engine,
      model_reasoning: explainPlayerWeek({ ...projection, ppg, structural_ppg: projection.ppg,
        ensemble_shift: ppg - projection.ppg, player_week_engine: engine })
    });
  }
  return useCache ? remember(engineCache, cacheKey, out, MAX_ENGINE_CACHE) : out;
}

/**
 * Deterministic explanation assembled from model fields, never generated text.
 * Every sentence carries the exact values and cutoff that support it.
 */
export function explainPlayerWeek(projection) {
  const engine = projection.player_week_engine;
  const heads = engine?.heads;
  if (!engine || !heads) return {
    source: 'deterministic_model_evidence',
    cutoff: engine?.cutoff ?? null,
    summary: `Structural projection: ${Number(projection.ppg ?? projection.structural_ppg ?? 0).toFixed(1)} fantasy points. No current-season games are available before this cutoff, so no weekly outcome update was applied.`,
    claims: [{ id: 'structural_ppg', value: projection.structural_ppg ?? projection.ppg, unit: 'fantasy_points' }],
    unsupported_claims_allowed: false
  };
  const shift = projection.ensemble_shift ?? projection.ppg - projection.structural_ppg;
  const direction = Math.abs(shift) < 0.05 ? 'left it effectively unchanged'
    : shift > 0 ? `raised it by ${shift.toFixed(1)}` : `lowered it by ${Math.abs(shift).toFixed(1)}`;
  const change = engine.role_change;
  const changeText = change
    ? ` A ${change.status.replaceAll('_', ' ')} is confirmed: opportunities moved from ${change.prior_opportunities.toFixed(1)} to ${change.recent_opportunities.toFixed(1)} and snap share moved ${change.snap_change_points > 0 ? '+' : ''}${change.snap_change_points.toFixed(1)} points.`
    : '';
  return {
    source: 'deterministic_model_evidence',
    cutoff: engine.cutoff,
    summary: `The structural model projects ${projection.structural_ppg.toFixed(1)} points. ` +
      `The frozen ${projection.position} ensemble ${direction} to ${projection.ppg.toFixed(1)}, using only games completed through ${engine.cutoff}. ` +
      `Season average is ${heads.season_to_date.toFixed(1)}, median ${heads.median.toFixed(1)}, and last game ${heads.last1.toFixed(1)}.` + changeText,
    claims: [
      { id: 'structural_ppg', value: projection.structural_ppg, unit: 'fantasy_points' },
      { id: 'ensemble_ppg', value: projection.ppg, unit: 'fantasy_points' },
      { id: 'season_to_date', value: heads.season_to_date, unit: 'fantasy_points' },
      { id: 'last3', value: heads.last3, unit: 'fantasy_points' },
      { id: 'last1', value: heads.last1, unit: 'fantasy_points' },
      { id: 'median', value: heads.median, unit: 'fantasy_points' }
    ],
    weights: Object.fromEntries(['structural', 'season_to_date', 'last3', 'last1', 'median']
      .map((name, index) => [name, engine.weights[index]])),
    role_change: change,
    unsupported_claims_allowed: false
  };
}

/** Distribution centered on the shared engine's ensemble point estimate. */
export function playerWeekDistribution(projection, {
  runs = 2000, scoring = PPR, mult = 1, activeProbability = 1, useCache = true
} = {}) {
  const cacheKey = JSON.stringify({
    version: PLAYER_WEEK_ENGINE_VERSION, player: projection.player_id,
    season: projection.player_week_engine?.season, week: projection.player_week_engine?.week,
    params: projection.params, shift: projection.ensemble_shift ?? 0,
    runs, scoring, mult, activeProbability
  });
  if (useCache && distributionCache.has(cacheKey)) return distributionCache.get(cacheKey);
  const shift = projection.ensemble_shift ?? 0;
  let seed = 2166136261;
  for (let i = 0; i < cacheKey.length; i++) seed = Math.imul(seed ^ cacheKey.charCodeAt(i), 16777619);
  const samples = withRandomSeed(seed >>> 0, () =>
    sampleWeeks(projection.params, runs, scoring, mult, activeProbability)
      .map(value => Math.max(0, value + shift)));
  const pct = percentiles(samples, [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]);
  const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  const boom = ({ QB: 24, RB: 18, WR: 18, TE: 14 })[projection.position] ?? 18;
  const bust = ({ QB: 14, RB: 8, WR: 8, TE: 6 })[projection.position] ?? 8;
  const result = {
    ...pct,
    mean: +mean.toFixed(2),
    boom_rate: +(samples.filter(value => value >= boom).length / samples.length).toFixed(3),
    bust_rate: +(samples.filter(value => value <= bust).length / samples.length).toFixed(3)
  };
  return useCache ? remember(distributionCache, cacheKey, result, MAX_DISTRIBUTION_CACHE) : result;
}
