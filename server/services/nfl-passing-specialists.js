/** Twenty component-level passing challengers with chronological promotion gates. */
import { rows } from '../db/index.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import { propReplayRows } from './nfl-props.js';

const LAMBDAS = [10, 50, 200, 800];
const FAMILIES = ['team_plays', 'pass_intent', 'attempt_conversion', 'qb_participation', 'efficiency'];
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sd = values => {
  if (values.length < 2) return 0;
  const m = mean(values); return Math.sqrt(mean(values.map(value => (value - m) ** 2)));
};
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const r4 = value => Number.isFinite(value) ? +value.toFixed(4) : null;
const parse = value => { try { return JSON.parse(value); } catch { return {}; } };
let auditCache = null;

function solve(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    if (Math.abs(M[pivot][col]) < 1e-10) return new Array(n).fill(0);
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
    }
  }
  return M.map(row => row[n]);
}

function fitRidge(samples, lambda) {
  const p = samples[0]?.x.length ?? 0;
  const mu = new Array(p).fill(0), scale = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    const col = samples.map(sample => sample.x[j]);
    mu[j] = mean(col); scale[j] = Math.max(1e-6, sd(col));
  }
  const X = samples.map(sample => [1, ...sample.x.map((value, j) => (value - mu[j]) / scale[j])]);
  const A = Array.from({ length: p + 1 }, () => new Array(p + 1).fill(0));
  const b = new Array(p + 1).fill(0);
  for (let i = 0; i < X.length; i++) for (let j = 0; j <= p; j++) {
    b[j] += X[i][j] * samples[i].y;
    for (let k = 0; k <= p; k++) A[j][k] += X[i][j] * X[i][k];
  }
  for (let j = 1; j <= p; j++) A[j][j] += lambda;
  const weights = solve(A, b);
  const predict = x => weights.reduce((sum, weight, j) => sum + weight * (j === 0 ? 1 : (x[j - 1] - mu[j - 1]) / scale[j - 1]), 0);
  const residuals = samples.map(sample => sample.y - predict(sample.x));
  return { predict, residualSd: sd(residuals), weights, mu, scale };
}

function teamFormIndex() {
  const index = new Map();
  for (const row of rows(`SELECT season,week,team,features FROM nfl_team_week_features ORDER BY season,week`)) {
    const key = `${row.season}|${row.team}`, list = index.get(key) ?? [];
    list.push({ week: row.week, features: parse(row.features) }); index.set(key, list);
  }
  return index;
}

function playerFeatureIndex() {
  const index = new Map();
  for (const row of rows(`SELECT season,week,player_id,features FROM nfl_player_week_features
                          WHERE position='QB' ORDER BY season,week`)) {
    const key = `${row.season}|${row.player_id}`, list = index.get(key) ?? [];
    list.push({ week: row.week, features: parse(row.features) }); index.set(key, list);
  }
  return index;
}

function averageForm(index, season, week, team, keys, fallback = 0) {
  const current = (index.get(`${season}|${team}`) ?? []).filter(row => row.week < week).slice(-6);
  const prior = current.length >= 2 ? current
    : (index.get(`${season - 1}|${team}`) ?? []).slice(-6).concat(current);
  return keys.map(key => {
    const values = prior.map(row => row.features[key]).filter(Number.isFinite);
    return values.length ? mean(values) : fallback;
  });
}

function averagePlayer(index, season, week, playerId, keys, fallback = 0) {
  const current = (index.get(`${season}|${playerId}`) ?? []).filter(row => row.week < week).slice(-8);
  const prior = current.length >= 2 ? current
    : (index.get(`${season - 1}|${playerId}`) ?? []).slice(-8).concat(current);
  return keys.map(key => {
    const values = prior.map(row => row.features[key]).filter(Number.isFinite);
    return values.length ? mean(values) : fallback;
  });
}

function featureRows(seasons) {
  const replay = propReplayRows(seasons, { useCache: true }).rows;
  const teamIndex = teamFormIndex(), playerIndex = playerFeatureIndex();
  const gameIndex = new Map(rows(`SELECT season,week,team,opponent,spread,total FROM game_lines`)
    .map(game => [`${game.season}|${game.week}|${game.team}`, game]));
  const playerHistory = new Map(), out = [];
  for (const row of replay) {
    if (!row.eligibility?.markets?.player_pass_yds) continue;
    const attempts = row.broad.pass_attempts, yards = row.broad.pass_yds;
    const actualAttempts = row.actual.pass_attempts, actualYards = row.actual.pass_yds;
    if (![attempts, yards, actualAttempts, actualYards].every(Number.isFinite) || attempts < 5) continue;
    const ypa = yards / attempts, actualYpa = actualAttempts > 0 ? actualYards / actualAttempts : null;
    if (!Number.isFinite(actualYpa)) continue;
    const game = gameIndex.get(`${row.season}|${row.week}|${row.team}`) ?? {};
    const own = keys => averageForm(teamIndex, row.season, row.week, row.team, keys);
    const opp = keys => averageForm(teamIndex, row.season, row.week, game.opponent, keys);
    const qb = keys => averagePlayer(playerIndex, row.season, row.week, row.player_id, keys);
    const historyKey = `${row.season}|${row.player_id}`, history = playerHistory.get(historyKey) ?? [];
    const priorAttempts = history.map(item => item.attempts), last3 = priorAttempts.slice(-3);
    const trend = last3.length >= 2 ? last3.at(-1) - last3[0] : 0;
    const features = {
      team_plays: [attempts, ...own(['off_plays']), ...opp(['def_plays']), game.total ?? 45],
      pass_intent: [attempts, ...own(['off_pass_rate', 'off_proe', 'off_neutral_pass_rate',
        'off_early_down_pass_rate', 'off_shotgun_rate', 'off_no_huddle_rate']), game.spread ?? 0, game.total ?? 45],
      attempt_conversion: [attempts, ...own(['off_sack_rate', 'off_scramble_rate', 'off_qb_hit_rate']),
        ...opp(['def_sack_rate', 'def_qb_hit_rate']), ...qb(['sack_rate', 'scrambles', 'dropbacks'])],
      qb_participation: [attempts, mean(priorAttempts) ?? attempts, mean(last3) ?? attempts,
        sd(priorAttempts), trend, Math.min(12, history.length)],
      efficiency: [ypa, ...qb(['yards_per_attempt', 'cpoe', 'adot', 'pass_epa_per_att']),
        ...own(['off_yards_per_attempt', 'off_cpoe', 'off_adot']),
        ...opp(['def_pass_epa_per_play', 'def_completion_pct', 'def_cpoe']), game.total ?? 45]
    };
    out.push({ season: row.season, week: row.week, playerId: row.player_id,
      actualYards, actualAttempts, actualYpa, modelYards: yards, modelAttempts: attempts,
      modelYpa: ypa, features });
    if (actualAttempts > 10) {
      history.push({ attempts: actualAttempts, yards: actualYards }); playerHistory.set(historyKey, history);
    }
  }
  return out;
}

function ranks(values) {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array(values.length);
  for (let i = 0; i < sorted.length;) {
    let j = i + 1; while (j < sorted.length && sorted[j].value === sorted[i].value) j++;
    const rank = (i + j - 1) / 2; for (let k = i; k < j; k++) out[sorted[k].index] = rank; i = j;
  }
  return out;
}

function correlation(a, b) {
  if (a.length < 2) return null;
  const am = mean(a), bm = mean(b); let num = 0, av = 0, bv = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - am, y = b[i] - bm; num += x * y; av += x * x; bv += y * y; }
  return av > 0 && bv > 0 ? num / Math.sqrt(av * bv) : null;
}

function grade(rowsToGrade, predictions, residualSd, seed) {
  const championErrors = rowsToGrade.map(row => Math.abs(row.modelYards - row.actualYards));
  const candidateErrors = rowsToGrade.map((row, i) => Math.abs(predictions[i] - row.actualYards));
  const actual = rowsToGrade.map(row => row.actualYards);
  const intervalHalf = 1.2816 * residualSd;
  const coverage = predictions.filter((prediction, i) => Math.abs(actual[i] - prediction) <= intervalHalf).length / predictions.length;
  return {
    n: rowsToGrade.length,
    champion_mae: r4(mean(championErrors)), candidate_mae: r4(mean(candidateErrors)),
    delta_mae: r4(mean(candidateErrors) - mean(championErrors)),
    champion_spearman: r4(correlation(ranks(rowsToGrade.map(row => row.modelYards)), ranks(actual))),
    candidate_spearman: r4(correlation(ranks(predictions), ranks(actual))),
    coverage_80: r4(coverage), residual_sd: r4(residualSd),
    bootstrap: pairedBootstrapDiff(championErrors, candidateErrors, { iterations: 2000, seed })
  };
}

function predictCandidate(model, family, row) {
  const correction = model.predict(row.features[family]);
  if (family === 'efficiency') {
    const adjustedYpa = clamp(row.modelYpa + correction, row.modelYpa - 1.5, row.modelYpa + 1.5);
    return row.modelAttempts * adjustedYpa;
  }
  const adjustedAttempts = clamp(row.modelAttempts + correction,
    row.modelAttempts * 0.75, row.modelAttempts * 1.25);
  return adjustedAttempts * row.modelYpa;
}

function holm(results, alpha = 0.05) {
  const ordered = [...results].sort((a, b) => a.p_value - b.p_value);
  let open = true;
  ordered.forEach((result, index) => {
    const threshold = alpha / (ordered.length - index);
    result.holm_threshold = r4(threshold);
    result.holm_passed = open && result.p_value <= threshold;
    if (!result.holm_passed) open = false;
  });
}

export function passingSpecialistAudit({ seasons = [2022, 2023, 2024, 2025], useCache = true } = {}) {
  const cacheKey = seasons.join(',');
  if (useCache && auditCache?.key === cacheKey) return auditCache.value;
  const data = featureRows(seasons);
  const discoveryTrain = data.filter(row => row.season === 2022);
  const discoveryTest = data.filter(row => row.season === 2023);
  const validationTrain = data.filter(row => row.season <= 2023);
  const validationTest = data.filter(row => row.season >= 2024);
  const candidates = [];
  for (const family of FAMILIES) for (const lambda of LAMBDAS) {
    const target = family === 'efficiency'
      ? row => row.actualYpa - row.modelYpa : row => row.actualAttempts - row.modelAttempts;
    const fit = (source, value) => fitRidge(source.map(row => ({ x: row.features[family], y: value(row) })), lambda);
    const discoveryModel = fit(discoveryTrain, target);
    const discoveryPredictions = discoveryTest.map(row => predictCandidate(discoveryModel, family, row));
    const discovery = grade(discoveryTest, discoveryPredictions,
      family === 'efficiency' ? discoveryModel.residualSd * mean(discoveryTest.map(row => row.modelAttempts)) : discoveryModel.residualSd * mean(discoveryTest.map(row => row.modelYpa)),
      20260000 + lambda + FAMILIES.indexOf(family));
    const validationModel = fit(validationTrain, target);
    const validationPredictions = validationTest.map(row => predictCandidate(validationModel, family, row));
    const yardResidualSd = family === 'efficiency'
      ? validationModel.residualSd * mean(validationTest.map(row => row.modelAttempts))
      : validationModel.residualSd * mean(validationTest.map(row => row.modelYpa));
    const validation = grade(validationTest, validationPredictions, yardResidualSd,
      20261000 + lambda + FAMILIES.indexOf(family));
    candidates.push({ id: `${family}_ridge_${lambda}`, family, lambda, discovery, validation,
      p_value: r4(1 - (validation.bootstrap.p_b_better ?? 0)), production_authority: 0 });
  }
  holm(candidates);
  for (const candidate of candidates) {
    candidate.gates = {
      discovery_mae: candidate.discovery.delta_mae < 0,
      validation_mae: candidate.validation.delta_mae < 0,
      multiplicity: candidate.holm_passed,
      rank: candidate.validation.candidate_spearman >= candidate.validation.champion_spearman - 0.005,
      coverage: candidate.validation.coverage_80 >= 0.76 && candidate.validation.coverage_80 <= 0.84
    };
    candidate.promotion_eligible = Object.values(candidate.gates).every(Boolean);
  }
  candidates.sort((a, b) => a.validation.delta_mae - b.validation.delta_mae);
  const promoted = candidates.filter(candidate => candidate.promotion_eligible);
  const result = {
    generated_at: new Date().toISOString(), seasons, rows: data.length,
    candidates_tested: candidates.length, families: FAMILIES, lambdas: LAMBDAS,
    discovery: { train: 2022, test: 2023 }, validation: { train_through: 2023, test: [2024, 2025] },
    promoted: promoted.map(candidate => candidate.id), candidates,
    verdict: promoted.length
      ? `${promoted.length} component challenger(s) cleared every historical gate; they remain shadow-only pending 2026 forward replication.`
      : 'No passing component challenger cleared MAE, multiplicity, rank and coverage together. The active engine remains unchanged.',
    policy: 'Twenty candidates were declared before validation. Historical success can earn forward shadow status, never production authority.'
  };
  if (useCache) auditCache = { key: cacheKey, value: result };
  return result;
}
