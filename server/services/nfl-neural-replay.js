/**
 * Historical prequential audit for the online spread-residual neural head.
 *
 * Every game in a week is predicted by one unchanged network. Only after the
 * entire week is scored may those labels enter the next update. A ridge-logit
 * decision calibrator is fitted on earlier neural forecasts and turns residual
 * magnitude, price side and season phase into a cover probability. This is an
 * opened research candidate and never changes production authority.
 */
import { db, row, rows, run } from '../db/index.js';
import { ensembleLine } from './nfl-ensemble.js';
import { createNetwork, predictNetwork, spreadFeatureVector, trainBatch } from './nfl-online-neural.js';
import { uncertainty } from './nfl-replay.js';
import { nflKickoffDate } from './date-util.js';

export const NEURAL_REPLAY_VERSION = 'spread-residual-neural-v2-two-sided-cover';
const RIDGE = 32;
const MIN_CALIBRATION = 200;
const EV_BUFFER = 0.02;
const MAX_WEEKLY_PICKS = 3;
const r3 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(3);
const sigmoid = value => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
const phase = week => week <= 6 ? 'early' : week <= 12 ? 'middle' : 'late';
const implied = price => price == null ? null : price > 0 ? 100 / (price + 100)
  : Math.abs(price) / (Math.abs(price) + 100);
const noVig = (selected, opposite) => {
  const a = implied(selected), b = implied(opposite);
  return a == null || b == null || a + b <= 0 ? null : a / (a + b);
};
const unitsFor = item => item.result === 'Push' ? 0 : item.result === 'Lost' ? -1
  : item.american_price > 0 ? item.american_price / 100 : 100 / Math.abs(item.american_price);

db.exec(`CREATE TABLE IF NOT EXISTS nfl_neural_replay_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL,
  created_at TEXT NOT NULL, result_json TEXT NOT NULL
)`);

function vector(item) {
  return [1, Math.max(-3, Math.min(3, item.prediction_residual / 3)),
    item.home_underdog ? 1 : 0, phase(item.week) === 'middle' ? 1 : 0,
    phase(item.week) === 'late' ? 1 : 0,
    Math.min(3, Math.max(0, Number(item.disagreement ?? 0)) / 5)];
}

/** Conservative ridge logistic fit. The penalty shrinks toward market parity. */
export function fitNeuralDecisionCalibrator(examples, ridge = RIDGE) {
  if (examples.length < MIN_CALIBRATION) return null;
  const width = vector(examples[0]).length;
  let weights = Array(width).fill(0);
  for (let iteration = 0; iteration < 40; iteration++) {
    const gradient = Array(width).fill(0);
    const hessian = Array.from({ length: width }, () => Array(width).fill(0));
    for (const item of examples) {
      const x = vector(item), p = sigmoid(x.reduce((sum, value, index) => sum + value * weights[index], 0));
      const y = item.home_cover ? 1 : 0, variance = Math.max(1e-6, p * (1 - p));
      for (let i = 0; i < width; i++) {
        gradient[i] += x[i] * (y - p);
        for (let j = 0; j < width; j++) hessian[i][j] += variance * x[i] * x[j];
      }
    }
    // Do not penalize the intercept; every contextual effect shrinks to zero.
    for (let i = 1; i < width; i++) { gradient[i] -= ridge * weights[i]; hessian[i][i] += ridge; }
    hessian[0][0] += 1e-6;
    const delta = solve(hessian, gradient);
    if (!delta) break;
    weights = weights.map((value, index) => value + delta[index]);
    if (delta.reduce((sum, value) => sum + Math.abs(value), 0) < 1e-7) break;
  }
  return { version: NEURAL_REPLAY_VERSION, ridge, examples: examples.length, weights };
}

function solve(matrix, target) {
  const a = matrix.map((row, index) => [...row, target[index]]), n = target.length;
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (Math.abs(a[pivot][column]) < 1e-10) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const divisor = a[column][column];
    for (let j = column; j <= n; j++) a[column][j] /= divisor;
    for (let row = 0; row < n; row++) if (row !== column) {
      const factor = a[row][column];
      for (let j = column; j <= n; j++) a[row][j] -= factor * a[column][j];
    }
  }
  return a.map(row => row[n]);
}

export function calibratedNeuralProbability(calibrator, item) {
  if (!calibrator) return null;
  const x = vector(item);
  return sigmoid(x.reduce((sum, value, index) => sum + value * calibrator.weights[index], 0));
}

function summarize(items) {
  const wins = items.filter(item => item.result === 'Won').length;
  const losses = items.filter(item => item.result === 'Lost').length;
  const units = items.reduce((sum, item) => sum + item.units, 0);
  return { bets: items.length, wins, losses,
    win_rate: wins + losses ? r3(wins / (wins + losses)) : null,
    units: r3(units), roi: items.length ? r3(units / items.length) : null,
    uncertainty: uncertainty(items) };
}

/** Full historical run. Defaults are frozen before the opened 2021–2025 audit. */
export function runHistoricalNeuralReplay({ trainFrom = 2018, evaluateFrom = 2021,
  throughSeason = 2025 } = {}) {
  const games = rows(`SELECT h.season,h.week,h.team home,h.opponent away,h.gameday,h.gametime,
      h.spread home_spread,h.spread_odds home_price,a.spread_odds away_price,
      h.team_score-h.opp_score actual_margin
    FROM game_lines h LEFT JOIN game_lines a ON a.season=h.season AND a.week=h.week
      AND a.team=h.opponent AND a.home=0
    WHERE h.home=1 AND h.season BETWEEN ? AND ? AND h.team_score IS NOT NULL
      AND h.spread IS NOT NULL ORDER BY h.season,h.week,h.team`, trainFrom, throughSeason);
  const weeks = [...new Set(games.map(game => `${game.season}|${game.week}`))];
  let network = null;
  const replayMemory = [], calibrationMemory = [], allForecasts = [], bets = [], timeline = [];
  for (const weekKey of weeks) {
    const [season, week] = weekKey.split('|').map(Number);
    const forecasts = [];
    for (const game of games.filter(item => item.season === season && item.week === week)) {
      const line = ensembleLine(season, week, game.home, game.away,
        { includeEvidence: false, includeChallengers: true });
      if (line.error) continue;
      const kickoff = game.gameday ? nflKickoffDate(game.gameday, game.gametime || '23:59') : null;
      const cutoff = kickoff?.toISOString() ?? null;
      const features = spreadFeatureVector(line, { before: cutoff });
      if (!features) continue;
      if (!network) network = createNetwork(features.values.length);
      const residual = predictNetwork(network, features.values);
      const grade = game.actual_margin + game.home_spread;
      const pushed = grade === 0;
      forecasts.push({ season, week, home: game.home, away: game.away,
        home_spread: game.home_spread, home_price: game.home_price, away_price: game.away_price,
        home_market_probability: noVig(game.home_price, game.away_price),
        prediction_residual: r3(residual), edge_points: Math.abs(residual),
        disagreement: line.ensemble.model_disagreement_margin,
        home_underdog: game.home_spread > 0, home_cover: grade > 0, pushed,
        target_residual: game.actual_margin - (-game.home_spread),
        input: features.values });
    }
    // One calibrator for the whole week; no result in this week is visible yet.
    const calibrator = fitNeuralDecisionCalibrator(calibrationMemory);
    for (const item of forecasts) {
      const homeProbability = calibratedNeuralProbability(calibrator, item);
      const homeAdvantage = homeProbability == null || item.home_market_probability == null
        ? null : homeProbability - item.home_market_probability;
      const backHome = homeAdvantage != null && homeAdvantage > 0;
      item.side = backHome ? item.home : item.away;
      item.line = backHome ? item.home_spread : -item.home_spread;
      item.american_price = backHome ? item.home_price : item.away_price;
      item.opposite_price = backHome ? item.away_price : item.home_price;
      item.market_probability = backHome ? item.home_market_probability
        : item.home_market_probability == null ? null : 1 - item.home_market_probability;
      item.model_probability = homeProbability == null ? null : r3(backHome ? homeProbability : 1 - homeProbability);
      item.probability_edge = homeAdvantage == null ? null : Math.abs(homeAdvantage);
      item.selected_underdog = item.line > 0;
      item.won = backHome ? item.home_cover : !item.home_cover;
      item.result = item.pushed ? 'Push' : item.won ? 'Won' : 'Lost';
    }
    if (season >= evaluateFrom) {
      const selected = forecasts.filter(item => item.american_price != null
          && item.probability_edge != null && item.probability_edge >= EV_BUFFER)
        .sort((a, b) => b.probability_edge - a.probability_edge || b.edge_points - a.edge_points)
        .slice(0, MAX_WEEKLY_PICKS).map(item => ({ ...item, units: unitsFor(item) }));
      bets.push(...selected);
      timeline.push({ season, week, forecasts: forecasts.length, selected: selected.length,
        calibrator_examples: calibrator?.examples ?? 0 });
    }
    // Outcomes become visible only after every game in the week was forecast.
    for (const item of forecasts) {
      replayMemory.push({ input: item.input, target: item.target_residual });
      // Cover calibration learns direction from the real spread result. Older
      // seasons may lack archived juice, but that does not make the cover label
      // unknowable; price is required later for selection and settlement only.
      if (!item.pushed) calibrationMemory.push(item);
    }
    if (forecasts.length) network = trainBatch(network, replayMemory.slice(-512));
    allForecasts.push(...forecasts);
  }
  const perSeason = [];
  for (let season = evaluateFrom; season <= throughSeason; season++) {
    perSeason.push({ season, ...summarize(bets.filter(item => item.season === season)) });
  }
  const byPhase = ['early', 'middle', 'late'].map(name => ({ phase: name,
    ...summarize(bets.filter(item => phase(item.week) === name)) }));
  const bySide = ['underdog', 'favorite'].map(name => ({ side: name,
    ...summarize(bets.filter(item => name === 'underdog' ? item.selected_underdog : !item.selected_underdog)) }));
  return { version: NEURAL_REPLAY_VERSION,
    evidence_class: 'opened prequential development replay; every weekly prediction precedes that week\'s update',
    config: { train_from: trainFrom, evaluate_from: evaluateFrom, through_season: throughSeason,
      ridge: RIDGE, minimum_calibration_examples: MIN_CALIBRATION,
      probability_edge_buffer: EV_BUFFER, max_weekly_picks: MAX_WEEKLY_PICKS,
      neural_training: 'existing bounded 35→10→1 weekly replay learner' },
    forecasts: allForecasts.length, training_examples: replayMemory.length,
    overall: summarize(bets), per_season: perSeason, by_phase: byPhase, by_side: bySide,
    timeline };
}

export function saveHistoricalNeuralReplay(result) {
  const createdAt = new Date().toISOString();
  const saved = run(`INSERT INTO nfl_neural_replay_audits (version,created_at,result_json)
    VALUES (?,?,?)`, result.version, createdAt, JSON.stringify(result));
  return { id: Number(saved.lastInsertRowid), version: result.version, created_at: createdAt, result };
}

export function latestHistoricalNeuralReplay() {
  const item = row('SELECT * FROM nfl_neural_replay_audits ORDER BY id DESC LIMIT 1');
  if (!item) return null;
  return { id: Number(item.id), version: item.version, created_at: item.created_at,
    result: JSON.parse(item.result_json) };
}
