/**
 * Robust market-residual coordinator trained only on prior audited weeks.
 *
 * The market remains the zero-residual prior. Specialist forecasts are small
 * corrections, fitted with week-balanced Huber ridge, coefficient caps and an
 * explicit missingness mask. This prevents a duplicated family of models or a
 * single blowout week from taking over the answer.
 */
import { rows } from '../db/index.js';
import { NFL_EXPERTS } from './nfl-expert-council.js';

export const EXPERT_COORDINATOR_VERSION = 'robust-contextual-week-balanced-residual-v4-shrink-families';
// The role list is the council's registry, read lazily: the council imports
// this module, so reading NFL_EXPERTS at module load would hit the import
// cycle before the registry exists. A role added to the registry (the four
// Priority 4 matchup candidates) is coordinated automatically; a hard-coded
// list here silently left them out.
const IDS = new Proxy([], { get(_target, prop) {
  const list = NFL_EXPERTS.map(expert => expert.id);
  const value = list[prop];
  return typeof value === 'function' ? value.bind(list) : value;
} });
const MIN_GAMES = 128;
const MIN_WEEKS = 8;
const RIDGE = 36;
const HUBER_DELTA = 10;
const MAX_WEIGHT = 0.35;
const MAX_TOTAL_INFLUENCE = 0.8;
const MIN_REGIME_GAMES = 96;
const MIN_REGIME_WEEKS = 6;
// Stage A: per-role walk-forward shrinkage. A role enters at the scale its
// past forecasts have earned (cov/var on prior settled games, capped 0..1),
// and at zero when it has no walk-forward gain. Stage B: roles whose shrunk
// forecasts correlate above the threshold form a family that gets ONE
// coefficient, so a duplicated opinion is counted once. Audit 2026-09-02:
// four roles correlated 0.74-0.92 all added error at full scale.
const SHRINK_RIDGE = 4;
const SHRINK_MIN_GAMES = 60;
const FAMILY_CORRELATION = 0.6;
const FAMILY_MIN_OVERLAP = 50;

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

/** Stage A: what each role's forecast has earned on these settled games. */
function shrinkageScales(games) {
  const out = {};
  for (const id of IDS) {
    const pairs = games.map(game => [game.experts.get(id), game.target]).filter(([f]) => Number.isFinite(f));
    if (pairs.length < SHRINK_MIN_GAMES) { out[id] = { k: 0, gain: null, n: pairs.length, reason: `fewer than ${SHRINK_MIN_GAMES} settled forecasts` }; continue; }
    const scaleOf = list => {
      const mf = mean(list.map(([f]) => f)), my = mean(list.map(([, y]) => y));
      const cov = mean(list.map(([f, y]) => (f - mf) * (y - my))), vf = mean(list.map(([f]) => (f - mf) ** 2));
      return { k: clamp(cov / (vf + SHRINK_RIDGE), 0, 1), mf, my, cov, vf };
    };
    const gainOf = (list, k, mf) => Math.sqrt(mean(list.map(([, y]) => y * y))) - Math.sqrt(mean(list.map(([f, y]) => (y - k * (f - mf)) ** 2)));
    const all = scaleOf(pairs);
    // A least-squares scale always "gains" in sample. Two guards make the gain
    // walk-forward: the correlation must be a real one (t > 2) and the scale
    // fitted on one half of the games must still reduce error on the other.
    const vy = mean(pairs.map(([, y]) => (y - all.my) ** 2));
    const r = all.vf && vy ? all.cov / Math.sqrt(all.vf * vy) : 0;
    const t = Math.abs(r) * Math.sqrt(Math.max(1, pairs.length - 2)) / Math.sqrt(Math.max(1e-9, 1 - r * r));
    const a = pairs.filter((_, i) => i % 2 === 0), b = pairs.filter((_, i) => i % 2 === 1);
    const crossGain = mean([gainOf(b, scaleOf(a).k, scaleOf(a).mf), gainOf(a, scaleOf(b).k, scaleOf(b).mf)]);
    const k = all.k;
    out[id] = t > 2 && crossGain > 0 && k > 0
      ? { k: r3(k), gain: r3(crossGain), t: r3(t), n: pairs.length, reason: null }
      : { k: 0, gain: r3(crossGain), t: r3(t), n: pairs.length, reason: 'shrunk to zero: no walk-forward gain' };
  }
  return out;
}

/** Stage B: families of roles whose forecasts say the same thing (single linkage on correlation). */
function familiesOf(games) {
  const ids = [...IDS];
  const parent = Object.fromEntries(ids.map(id => [id, id]));
  const find = id => (parent[id] === id ? id : (parent[id] = find(parent[id])));
  const correlations = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const pairs = games.map(game => [game.experts.get(ids[i]), game.experts.get(ids[j])]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    if (pairs.length < FAMILY_MIN_OVERLAP) continue;
    const ma = mean(pairs.map(([a]) => a)), mb = mean(pairs.map(([, b]) => b));
    const cov = pairs.reduce((sum, [a, b]) => sum + (a - ma) * (b - mb), 0);
    const va = pairs.reduce((sum, [a]) => sum + (a - ma) ** 2, 0), vb = pairs.reduce((sum, [, b]) => sum + (b - mb) ** 2, 0);
    const r = va && vb ? cov / Math.sqrt(va * vb) : 0;
    if (r >= FAMILY_CORRELATION) { parent[find(ids[i])] = find(ids[j]); correlations.push({ a: ids[i], b: ids[j], r: r3(r), n: pairs.length }); }
  }
  const groups = new Map();
  for (const id of ids) { const root = find(id); const list = groups.get(root) ?? []; list.push(id); groups.set(root, list); }
  const families = [...groups.values()].filter(list => list.length > 1).map((members, index) => ({ id: `family_${index + 1}`, members }));
  return { families, correlations };
}

/**
 * The v4 design: one column per family (mean of its members' shrunk,
 * standardised forecasts), one per singleton, then a missingness flag per
 * role. `columns` records what each column is so the trace can explain it.
 */
function designV4(game, fit) {
  const values = [1];
  for (const column of fit.columns) {
    const parts = column.members.map(id => {
      const value = game.experts.get(id);
      const k = fit.shrinkage[id]?.k ?? 0;
      return Number.isFinite(value) ? k * clamp((value - fit.centers[id]) / fit.scales[id], -4, 4) : null;
    }).filter(Number.isFinite);
    values.push(parts.length ? mean(parts) : 0);
  }
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
  const shrinkage = shrinkageScales(games);
  const { families, correlations } = familiesOf(games);
  const inFamily = new Set(families.flatMap(f => f.members));
  const columns = [...families, ...IDS.filter(id => !inFamily.has(id)).map(id => ({ id, members: [id] }))];
  const proto = { centers, scales, shrinkage, columns };
  const X = games.map(game => designV4(game, proto)), y = games.map(game => game.target);
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
  const nColumns = columns.length;
  for (let j = 1; j <= nColumns; j++) coefficients[j] = clamp(coefficients[j], -MAX_WEIGHT, MAX_WEIGHT);
  const total = coefficients.slice(1, nColumns + 1).reduce((sum, value) => sum + Math.abs(value), 0);
  if (total > MAX_TOTAL_INFLUENCE) {
    const shrink = MAX_TOTAL_INFLUENCE / total;
    for (let j = 1; j <= nColumns; j++) coefficients[j] *= shrink;
  }
  const fitted = X.map(row => row.reduce((sum, value, j) => sum + value * coefficients[j], 0));
  const errors = fitted.map((value, index) => y[index] - value);
  const errorCenter = median(errors), robustSigma = Math.max(6, median(errors.map(error => Math.abs(error - errorCenter))) * 1.4826);
  return { coefficients, centers, scales, robustSigma, shrinkage, families, family_correlations: correlations, columns };
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
      walk_forward_shrinkage: { ridge: SHRINK_RIDGE, min_games: SHRINK_MIN_GAMES, rule: 'k = cov/var capped 0..1; zero without walk-forward gain' },
      families: { correlation: FAMILY_CORRELATION, min_overlap: FAMILY_MIN_OVERLAP, found: fit.families.map(f => f.members) },
      deduplicated_by_game_and_expert: true, max_expert_weight: MAX_WEIGHT,
      max_total_expert_influence: MAX_TOTAL_INFLUENCE, contextual_regimes: true,
      min_regime_games: MIN_REGIME_GAMES, min_regime_weeks: MIN_REGIME_WEEKS } };
}

/** A fit without columns/shrinkage (hand-built or pre-v4) is treated as singletons at full scale. */
function normaliseFit(fit) {
  if (fit.columns && fit.shrinkage) return fit;
  return { ...fit, columns: fit.columns ?? IDS.map(id => ({ id, members: [id] })),
    shrinkage: fit.shrinkage ?? Object.fromEntries(IDS.map(id => [id, { k: 1, reason: 'legacy fit: unshrunk' }])) };
}

function coordinateWith(rawFit, experts) {
  const fit = normaliseFit(rawFit);
  const game = { experts: new Map(experts.map(expert => [expert.id,
    expert.observed && Number.isFinite(expert.forecast_residual) ? expert.forecast_residual : null])) };
  const x = designV4(game, fit);
  const nColumns = fit.columns.length;
  // A member's learned weight is its family's coefficient divided by the
  // members that are present, so the trace still reads per role.
  const columnOf = new Map();
  fit.columns.forEach((column, index) => column.members.forEach(id => columnOf.set(id, index)));
  const present = column => column.members.filter(id => Number.isFinite(game.experts.get(id))).length;
  const memberWeight = id => { const index = columnOf.get(id); const column = fit.columns[index];
    const n = present(column); return n ? fit.coefficients[index + 1] / n : 0; };
  const activeWeight = IDS.reduce((sum, id) => Number.isFinite(game.experts.get(id)) ? sum + Math.abs(memberWeight(id)) : sum, 0);
  const contributions = IDS.map((id, index) => {
    const raw = game.experts.get(id), learnedWeight = memberWeight(id), columnIndex = columnOf.get(id), column = fit.columns[columnIndex];
    const k = fit.shrinkage[id]?.k ?? 0;
    const shrunk = Number.isFinite(raw) ? k * clamp((raw - fit.centers[id]) / fit.scales[id], -4, 4) : null;
    return { id, raw, shrink: k, shrink_reason: fit.shrinkage[id]?.reason ?? null,
      family: column.members.length > 1 ? column.id : null, family_members: column.members.length > 1 ? column.members : undefined,
      learned_weight: r3(learnedWeight),
      normalized_weight: Number.isFinite(raw) && activeWeight > 0 ? r3(learnedWeight / activeWeight) : 0,
      missingness_weight: r3(fit.coefficients[1 + nColumns + index]),
      value: Number.isFinite(shrunk) ? r3(shrunk * learnedWeight) : 0 };
  }).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const missingOffset = IDS.reduce((sum, _id, index) => sum + x[1 + nColumns + index] * fit.coefficients[1 + nColumns + index], 0);
  const forecast = fit.coefficients[0] + contributions.reduce((sum, item) => sum + item.value, 0) + missingOffset;
  const disagreement = Math.sqrt(mean(experts.filter(expert => Number.isFinite(expert.forecast_residual))
    .map(expert => (expert.forecast_residual - forecast) ** 2)));
  return { forecast_residual: r3(clamp(forecast, -10, 10)),
    uncertainty: r3(Math.sqrt(fit.robustSigma ** 2 + disagreement ** 2)), training_games: fit.games, training_weeks: fit.weeks,
    disagreement: r3(disagreement), active_weight_l1: r3(activeWeight),
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

export const __test = { pivotRows, fitRows, design, designV4, regimeLabels, coordinateWith, shrinkageScales, familiesOf };
