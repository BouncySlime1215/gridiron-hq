/**
 * Robust market-residual coordinator trained only on prior audited weeks.
 *
 * The market remains the zero-residual prior. Specialist forecasts are small
 * corrections, fitted with week-balanced Huber ridge, coefficient caps and an
 * explicit missingness mask. This prevents a duplicated family of models or a
 * single blowout week from taking over the answer.
 */
import { rows } from '../db/index.js';

export const EXPERT_COORDINATOR_VERSION = 'robust-contextual-week-balanced-residual-v2';
const IDS = ['rulebook', 'player_builder', 'game_replay', 'similar_games', 'boosted_tree',
  'deep_residual', 'specialist_team', 'line_movement', 'news_reaction', 'live_updater',
  'price_shopper', 'player_opportunity'];
const MIN_GAMES = 128;
const MIN_WEEKS = 8;
const RIDGE = 36;
const HUBER_DELTA = 10;
const MAX_WEIGHT = 0.35;
const MAX_TOTAL_INFLUENCE = 0.8;
const MIN_REGIME_GAMES = 96;
const MIN_REGIME_WEEKS = 6;

const r3 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(3);
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const median = values => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function solve(matrix, vector) {
  const n = vector.length, augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    if (Math.abs(augmented[pivot][column]) < 1e-10) continue;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let j = column; j <= n; j++) augmented[column][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let j = column; j <= n; j++) augmented[row][j] -= factor * augmented[column][j];
    }
  }
  return augmented.map((row, index) => Number.isFinite(row[n]) ? row[n] : (index === 0 ? 0 : 0));
}

function pivotRows(raw) {
  const games = new Map();
  for (const row of raw) {
    const key = `${row.season}|${row.week}|${row.home}`;
    const game = games.get(key) ?? { key, season: row.season, week: row.week, home: row.home,
      away: row.away, target: row.actual_residual, experts: new Map() };
    game.experts.set(row.expert_id, row.observed && Number.isFinite(row.forecast_residual) ? row.forecast_residual : null);
    games.set(key, game);
  }
  return [...games.values()].filter(game => Number.isFinite(game.target));
}

function design(game, centers, scales) {
  const values = [1];
  for (const id of IDS) {
    const value = game.experts.get(id);
    values.push(Number.isFinite(value) ? clamp((value - centers[id]) / scales[id], -4, 4) : 0);
  }
  // Missingness is carried separately. It may help abstention and calibration,
  // but the audit reports its coefficients so outcome-leaking coverage is easy
  // to detect and reject.
  for (const id of IDS) values.push(Number.isFinite(game.experts.get(id)) ? 0 : 1);
  return values;
}

function fitRows(games) {
  const centers = {}, scales = {};
  for (const id of IDS) {
    const values = games.map(game => game.experts.get(id)).filter(Number.isFinite);
    centers[id] = median(values);
    const deviations = values.map(value => Math.abs(value - centers[id]));
    scales[id] = Math.max(1, median(deviations) * 1.4826);
  }
  const X = games.map(game => design(game, centers, scales)), y = games.map(game => game.target);
  const weekCounts = new Map();
  for (const game of games) weekCounts.set(`${game.season}|${game.week}`, (weekCounts.get(`${game.season}|${game.week}`) ?? 0) + 1);
  let coefficients = new Array(X[0].length).fill(0);
  for (let iteration = 0; iteration < 6; iteration++) {
    const p = coefficients.length, A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
    for (let i = 0; i < X.length; i++) {
      const residual = y[i] - X[i].reduce((sum, value, j) => sum + value * coefficients[j], 0);
      const robust = Math.abs(residual) <= HUBER_DELTA ? 1 : HUBER_DELTA / Math.abs(residual);
      const cluster = 1 / (weekCounts.get(`${games[i].season}|${games[i].week}`) ?? 1);
      const weight = robust * cluster;
      for (let j = 0; j < p; j++) {
        b[j] += weight * X[i][j] * y[i];
        for (let k = j; k < p; k++) A[j][k] += weight * X[i][j] * X[i][k];
      }
    }
    for (let j = 0; j < A.length; j++) {
      for (let k = 0; k < j; k++) A[j][k] = A[k][j];
      if (j > 0) A[j][j] += RIDGE;
    }
    coefficients = solve(A, b);
  }
  coefficients[0] = clamp(coefficients[0], -1, 1);
  for (let j = 1; j <= IDS.length; j++) coefficients[j] = clamp(coefficients[j], -MAX_WEIGHT, MAX_WEIGHT);
  const total = coefficients.slice(1, IDS.length + 1).reduce((sum, value) => sum + Math.abs(value), 0);
  if (total > MAX_TOTAL_INFLUENCE) {
    const shrink = MAX_TOTAL_INFLUENCE / total;
    for (let j = 1; j <= IDS.length; j++) coefficients[j] *= shrink;
  }
  const fitted = X.map(row => row.reduce((sum, value, j) => sum + value * coefficients[j], 0));
  const errors = fitted.map((value, index) => y[index] - value);
  const errorCenter = median(errors), robustSigma = Math.max(6, median(errors.map(error => Math.abs(error - errorCenter))) * 1.4826);
  return { coefficients, centers, scales, robustSigma };
}

function enrichGameContexts(games) {
  for (const game of games) {
    const line = rows(`SELECT spread,total FROM game_lines
      WHERE season=? AND week=? AND team=? AND home=1 LIMIT 1`, game.season, game.week, game.home)[0];
    game.marketMargin = Number.isFinite(line?.spread) ? -Number(line.spread) : null;
    game.marketTotal = Number.isFinite(line?.total) ? Number(line.total) : null;
  }
  return games;
}

function regimeLabels(game) {
  const forecasts = [...game.experts.values()].filter(Number.isFinite);
  const center = median(forecasts), disagreement = forecasts.length > 1
    ? Math.sqrt(mean(forecasts.map(value => (value - center) ** 2))) : null;
  const coverage = forecasts.length / IDS.length;
  return [
    `phase:${game.week <= 4 ? 'early' : game.week >= 15 ? 'late' : 'middle'}`,
    `spread:${Number.isFinite(game.marketMargin) && Math.abs(game.marketMargin) >= 6.5 ? 'large' : 'competitive'}`,
    `total:${Number.isFinite(game.marketTotal) && game.marketTotal >= 47 ? 'high' : 'ordinary'}`,
    `disagreement:${Number.isFinite(disagreement) && disagreement >= 4 ? 'high' : 'normal'}`,
    `coverage:${coverage < 0.6 ? 'sparse' : 'broad'}`
  ];
}

export function fitExpertCoordinator(beforeSeason, beforeWeek, { auditRunId = null } = {}) {
  const historical = auditRunId == null
    ? rows(`SELECT * FROM nfl_weekly_expert_examples
      WHERE actual_residual IS NOT NULL AND (season<? OR (season=? AND week<?))
      ORDER BY season,week,home,expert_id,audit_run_id,id`, beforeSeason, beforeSeason, beforeWeek)
    : rows(`SELECT * FROM nfl_weekly_expert_examples
      WHERE audit_run_id=? AND actual_residual IS NOT NULL AND (season<? OR (season=? AND week<?))
      ORDER BY season,week,home,expert_id,id`, auditRunId, beforeSeason, beforeSeason, beforeWeek);
  const forward = auditRunId == null ? rows(`SELECT p.*,s.actual_residual,s.directional_correct,s.squared_error
    FROM nfl_expert_forward_predictions p JOIN nfl_expert_forward_settlements s ON s.prediction_id=p.id
    WHERE p.observed=1 AND (p.season<? OR (p.season=? AND p.week<?))
    ORDER BY p.season,p.week,p.home,p.expert_id,p.captured_at,p.id`,
  beforeSeason, beforeSeason, beforeWeek) : [];
  const raw = [...historical, ...forward];
  const games = pivotRows(raw);
  const weeks = new Set(games.map(game => `${game.season}|${game.week}`)).size;
  if (games.length < MIN_GAMES || weeks < MIN_WEEKS) return {
    version: EXPERT_COORDINATOR_VERSION, ready: false, games: games.length, weeks,
    reason: `warmup requires ${MIN_GAMES} games across ${MIN_WEEKS} settled weeks`
  };
  enrichGameContexts(games);
  const fit = fitRows(games);
  const labels = [...new Set(games.flatMap(regimeLabels))], regimes = [];
  for (const label of labels) {
    const subset = games.filter(game => regimeLabels(game).includes(label));
    const regimeWeeks = new Set(subset.map(game => `${game.season}|${game.week}`)).size;
    if (subset.length < MIN_REGIME_GAMES || regimeWeeks < MIN_REGIME_WEEKS) continue;
    regimes.push({ label, games: subset.length, weeks: regimeWeeks,
      shrinkage: subset.length / (subset.length + 192), fit: fitRows(subset) });
  }
  return { version: EXPERT_COORDINATOR_VERSION, ready: true, games: games.length, weeks,
    ...fit, regimes, authority: 'historical_candidate_only',
    safeguards: { target: 'market residual', week_balanced: true, loss: `Huber(${HUBER_DELTA})`, ridge: RIDGE,
      deduplicated_by_game_and_expert: true, max_expert_weight: MAX_WEIGHT,
      max_total_expert_influence: MAX_TOTAL_INFLUENCE, contextual_regimes: true,
      min_regime_games: MIN_REGIME_GAMES, min_regime_weeks: MIN_REGIME_WEEKS } };
}

function coordinateWith(fit, experts) {
  const game = { experts: new Map(experts.map(expert => [expert.id,
    expert.observed && Number.isFinite(expert.forecast_residual) ? expert.forecast_residual : null])) };
  const x = design(game, fit.centers, fit.scales);
  const contributions = IDS.map((id, index) => ({ id, value: r3(x[index + 1] * fit.coefficients[index + 1]),
    raw: game.experts.get(id) })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const missingOffset = IDS.reduce((sum, _id, index) => sum + x[1 + IDS.length + index] * fit.coefficients[1 + IDS.length + index], 0);
  const forecast = fit.coefficients[0] + contributions.reduce((sum, item) => sum + item.value, 0) + missingOffset;
  const disagreement = Math.sqrt(mean(experts.filter(expert => Number.isFinite(expert.forecast_residual))
    .map(expert => (expert.forecast_residual - forecast) ** 2)));
  return { forecast_residual: r3(clamp(forecast, -10, 10)),
    uncertainty: r3(Math.sqrt(fit.robustSigma ** 2 + disagreement ** 2)), training_games: fit.games, training_weeks: fit.weeks,
    contributions, missingness_offset: r3(missingOffset) };
}

export function coordinateExperts(fit, experts, context = {}) {
  if (!fit?.ready) return { version: EXPERT_COORDINATOR_VERSION, ready: false, reason: fit?.reason ?? 'not fitted',
    training_games: fit?.games ?? 0, training_weeks: fit?.weeks ?? 0 };
  const global = coordinateWith(fit, experts);
  const game = { week: Number(context.week) || 1,
    marketMargin: Number.isFinite(context.market_margin) ? context.market_margin : null,
    marketTotal: Number.isFinite(context.market_total) ? context.market_total : null,
    experts: new Map(experts.map(expert => [expert.id,
      expert.observed && Number.isFinite(expert.forecast_residual) ? expert.forecast_residual : null])) };
  const activeLabels = regimeLabels(game), active = (fit.regimes ?? []).filter(regime => activeLabels.includes(regime.label));
  let forecast = global.forecast_residual, totalWeight = 1;
  const regimeContributions = [];
  for (const regime of active) {
    const candidate = coordinateWith({ ...regime.fit, games: regime.games, weeks: regime.weeks }, experts);
    const weight = regime.shrinkage / Math.max(1, active.length);
    forecast += candidate.forecast_residual * weight; totalWeight += weight;
    regimeContributions.push({ label: regime.label, weight: r3(weight), games: regime.games,
      forecast_residual: candidate.forecast_residual });
  }
  forecast /= totalWeight;
  return { version: fit.version, ready: true, ...global, forecast_residual: r3(clamp(forecast, -10, 10)),
    global_forecast_residual: global.forecast_residual, active_regimes: activeLabels,
    contextual_adjustments: regimeContributions, authority: fit.authority,
    note: 'A circumstance-aware candidate correction to the market, not stake permission.' };
}

export const __test = { pivotRows, fitRows, design, regimeLabels };
