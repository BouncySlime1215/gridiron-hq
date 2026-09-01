/**
 * Orthogonal specialist residual engine.
 *
 * Specialists are not twelve votes on the same game. In a fixed, declared
 * order each family learns only the error left by the market and earlier
 * families. A later chronological validation block determines shrinkage;
 * negative incremental value remains visible but contributes zero.
 */
import crypto from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { getFrozenTeamCard, TEAM_CARD_VERSION } from './nfl-team-card.js';

export const ORTHOGONAL_SPECIALIST_VERSION = 'nfl-orthogonal-specialists-v2-reconciled-depth';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_orthogonal_specialist_artifacts (
    artifact_id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    through_season INTEGER NOT NULL,
    through_week INTEGER NOT NULL,
    data_hash TEXT NOT NULL,
    training_games INTEGER NOT NULL,
    validation_games INTEGER NOT NULL,
    artifact_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS nfl_orthogonal_artifacts_no_update
    BEFORE UPDATE ON nfl_orthogonal_specialist_artifacts
    BEGIN SELECT RAISE(ABORT, 'orthogonal specialist artifacts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_orthogonal_artifacts_no_delete
    BEFORE DELETE ON nfl_orthogonal_specialist_artifacts
    BEGIN SELECT RAISE(ABORT, 'orthogonal specialist artifacts are immutable'); END;
`);

const FAMILY_SPEC = Object.freeze([
  { id: 'roster', fields: ['roster_score', 'starter_score', 'depth_score', 'fragility',
    'offense_score', 'defense_score'] },
  { id: 'efficiency', fields: ['off_epa_per_play', 'off_success_rate', 'off_explosive_play_rate',
    'off_turnover_rate', 'off_sack_rate', 'def_epa_per_play', 'def_success_rate',
    'def_explosive_play_rate', 'def_turnover_rate', 'def_sack_rate'] },
  { id: 'pace_script', fields: ['off_neutral_pass_rate', 'off_proe', 'off_no_huddle_rate',
    'off_plays_per_drive', 'off_seconds_per_drive', 'off_drive_td_rate',
    'off_three_and_out_rate', 'off_third_down_rate', 'off_red_zone_td_rate'] },
  { id: 'availability', fields: ['injury_burden', 'news_unavailable_burden', 'news_role_pressure',
    'roster_status_changes', 'roster_team_changes'] },
  { id: 'environment', fields: ['rest_days', 'temperature_f', 'wind_mph', 'divisional',
    'surface_grass', 'roof_outdoors'] },
  { id: 'market_shape', fields: ['market_margin', 'market_total', 'open_move', 'total_move',
    'book_count'] }
]);

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const mse = (actual, predicted) => actual.length
  ? mean(actual.map((value, index) => (value - predicted[index]) ** 2)) : null;
const r4 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(4);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
};
const sha = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function solve(matrix, target) {
  const n = target.length, a = matrix.map((row, i) => [...row, target[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = Math.abs(a[col][col]) < 1e-10 ? 1e-10 : a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map(row => row[n]);
}

function fitRidge(X, y, { ridge = 8, huber = 4 } = {}) {
  if (!X.length) return null;
  const width = X[0].length;
  const mu = Array.from({ length: width }, (_, j) => mean(X.map(row => row[j])));
  const scale = Array.from({ length: width }, (_, j) => {
    const spread = Math.sqrt(mean(X.map(row => (row[j] - mu[j]) ** 2)));
    return spread > 1e-8 ? spread : 1;
  });
  const Z = X.map(row => [1, ...row.map((value, j) => (value - mu[j]) / scale[j])]);
  let weights = Array(Z[0].length).fill(1), beta = Array(Z[0].length).fill(0);
  for (let iteration = 0; iteration < 5; iteration++) {
    const p = Z[0].length;
    const xtx = Array.from({ length: p }, () => Array(p).fill(0)), xty = Array(p).fill(0);
    for (let i = 0; i < Z.length; i++) for (let j = 0; j < p; j++) {
      xty[j] += weights[i] * Z[i][j] * y[i];
      for (let k = 0; k < p; k++) xtx[j][k] += weights[i] * Z[i][j] * Z[i][k];
    }
    for (let j = 1; j < p; j++) xtx[j][j] += ridge;
    beta = solve(xtx, xty);
    const residuals = Z.map((row, i) => y[i] - row.reduce((sum, value, j) => sum + value * beta[j], 0));
    weights = residuals.map(error => Math.abs(error) <= huber ? 1 : huber / Math.abs(error));
  }
  return { beta, mu, scale, predict: row => beta[0] + row.reduce((sum, value, j) =>
    sum + beta[j + 1] * (value - mu[j]) / scale[j], 0) };
}

function n(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }

function cardValues(card) {
  const roster = card.roster ?? {}, tendency = card.tendencies?.values ?? {};
  const environment = card.schedule ?? {}, events = card.verified_event_state ?? {};
  const news = card.verified_news ?? {}, market = card.market ?? {};
  return {
    roster_score: n(roster.roster_score), starter_score: n(roster.starter_score),
    depth_score: n(roster.depth_score), fragility: n(roster.fragility),
    offense_score: n(roster.unit_scores?.offense), defense_score: n(roster.unit_scores?.defense),
    ...Object.fromEntries(Object.entries(tendency).map(([key, value]) => [key, n(value)])),
    injury_burden: n(events.injury_burden), news_unavailable_burden: n(news.unavailable_burden),
    news_role_pressure: n(news.role_pressure), roster_status_changes: n(events.roster_status_changes),
    roster_team_changes: n(events.roster_team_changes), rest_days: n(environment.rest_days, 7),
    temperature_f: n(environment.temperature_f, 60), wind_mph: n(environment.wind_mph),
    divisional: environment.divisional ? 1 : 0,
    surface_grass: /grass/i.test(environment.surface ?? '') ? 1 : 0,
    roof_outdoors: /out|open/i.test(environment.roof ?? '') ? 1 : 0,
    market_margin: -n(market.spread), market_total: n(market.total, 44),
    open_move: n(market.spread) - n(market.open_spread, n(market.spread)),
    total_move: n(market.total) - n(market.open_total, n(market.total)),
    book_count: n(market.book_count)
  };
}

function familyVector(home, away, family) {
  const h = cardValues(home), a = cardValues(away);
  return family.fields.map(field => field === 'market_total' || field === 'book_count'
    ? (h[field] + a[field]) / 2 : h[field] - a[field]);
}

function examplesBefore(season, week) {
  const cards = rows(`SELECT season,week,team,opponent,evidence_hash,card_json FROM nfl_team_cards
    WHERE version=? AND horizon='pregame'
      AND (season<? OR (season=? AND week<?)) ORDER BY season,week,team`, TEAM_CARD_VERSION, season, season, week);
  const map = new Map(cards.map(item => [`${item.season}|${item.week}|${item.team}`,
    { ...item, card: JSON.parse(item.card_json) }]));
  const games = rows(`SELECT season,week,team home,opponent away,spread,team_score,opp_score
    FROM game_lines WHERE home=1 AND team_score IS NOT NULL AND spread IS NOT NULL
      AND (season<? OR (season=? AND week<?)) ORDER BY season,week,team`, season, season, week);
  return games.flatMap(game => {
    const home = map.get(`${game.season}|${game.week}|${game.home}`);
    const away = map.get(`${game.season}|${game.week}|${game.away}`);
    if (!home || !away) return [];
    const marketMargin = -game.spread, actualMargin = game.team_score - game.opp_score;
    return [{ season: game.season, week: game.week, home: game.home, away: game.away,
      target: actualMargin - marketMargin, homeCard: home.card, awayCard: away.card,
      evidence: [home.evidence_hash, away.evidence_hash] }];
  });
}

function chronologicalSplit(examples) {
  const weeks = [...new Set(examples.map(item => `${item.season}|${item.week}`))];
  const validationWeeks = new Set(weeks.slice(Math.max(0, Math.floor(weeks.length * 0.8))));
  return { train: examples.filter(item => !validationWeeks.has(`${item.season}|${item.week}`)),
    validation: examples.filter(item => validationWeeks.has(`${item.season}|${item.week}`)) };
}

function fitArtifact(season, week) {
  const examples = examplesBefore(season, week);
  if (examples.length < 320) return { error: `only ${examples.length} frozen-card games; 320 required` };
  const { train, validation } = chronologicalSplit(examples);
  if (validation.length < 64) return { error: `only ${validation.length} chronological validation games` };
  let trainRemaining = train.map(item => item.target), validationRemaining = validation.map(item => item.target);
  const families = [];
  for (const family of FAMILY_SPEC) {
    const trainX = train.map(item => familyVector(item.homeCard, item.awayCard, family));
    const validationX = validation.map(item => familyVector(item.homeCard, item.awayCard, family));
    const model = fitRidge(trainX, trainRemaining, { ridge: Math.max(8, family.fields.length * 2), huber: 4 });
    const trainRaw = trainX.map(model.predict), validationRaw = validationX.map(model.predict);
    const validationBefore = [...validationRemaining];
    const baselineMse = mse(validationBefore, validation.map(() => 0));
    const rawMse = mse(validationBefore, validationRaw);
    const gain = baselineMse - rawMse;
    const gainFraction = baselineMse > 0 ? gain / baselineMse : 0;
    const sampleShrink = train.length / (train.length + 256);
    const influence = clamp(gainFraction * 6, 0, 1) * sampleShrink;
    const trainContribution = trainRaw.map(value => value * influence);
    const validationContribution = validationRaw.map(value => value * influence);
    trainRemaining = trainRemaining.map((value, i) => value - trainContribution[i]);
    validationRemaining = validationRemaining.map((value, i) => value - validationContribution[i]);
    families.push({ id: family.id, fields: family.fields, beta: model.beta, mu: model.mu,
      scale: model.scale, validation_baseline_mse: r4(baselineMse), validation_raw_mse: r4(rawMse),
      incremental_mse_gain: r4(gain), incremental_gain_fraction: r4(gainFraction),
      influence: r4(influence), validation_direction_rate: r4(mean(validationRaw.map((value, i) =>
        Math.sign(value) === Math.sign(validationBefore[i]) ? 1 : 0))) });
  }
  const dataHash = sha(examples.map(item => ({ season: item.season, week: item.week,
    home: item.home, evidence: item.evidence, target: item.target })));
  return { version: ORTHOGONAL_SPECIALIST_VERSION, through: { season, week }, data_hash: dataHash,
    training_games: train.length, validation_games: validation.length,
    baseline_validation_mse: r4(mse(validation.map(item => item.target), validation.map(() => 0))),
    final_validation_mse: r4(mse(validation.map(item => item.target), validation.map((item, i) => item.target - validationRemaining[i]))),
    families };
}

const cache = new Map();
function persistArtifact(result, season, week) {
  run(`INSERT OR IGNORE INTO nfl_orthogonal_specialist_artifacts
    (artifact_id,version,through_season,through_week,data_hash,training_games,validation_games,
     artifact_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`, result.artifact_id,
  ORTHOGONAL_SPECIALIST_VERSION, season, week, result.data_hash, result.training_games,
  result.validation_games, JSON.stringify(result), new Date().toISOString());
}

export function fitOrthogonalSpecialists(season, week, { persist = true } = {}) {
  const key = `${season}|${week}`;
  let result = cache.get(key);
  if (!result) {
    const artifact = fitArtifact(season, week);
    if (artifact.error) return artifact;
    const artifactId = sha({ version: ORTHOGONAL_SPECIALIST_VERSION, season, week, data: artifact.data_hash });
    result = { ...artifact, artifact_id: artifactId };
    cache.set(key, result);
  }
  if (persist) persistArtifact(result, season, week);
  return result;
}

function predictFamily(family, vector) {
  return family.beta[0] + vector.reduce((sum, value, index) =>
    sum + family.beta[index + 1] * (value - family.mu[index]) / family.scale[index], 0);
}

export function orthogonalSpecialistPrediction(season, week, home, away, { persistFit = true } = {}) {
  const homeItem = getFrozenTeamCard(season, week, home), awayItem = getFrozenTeamCard(season, week, away);
  if (!homeItem || !awayItem) return { error: 'both frozen team cards are required' };
  const fit = fitOrthogonalSpecialists(season, week, { persist: persistFit });
  if (fit.error) return fit;
  const specialists = fit.families.map((family, index) => {
    const spec = FAMILY_SPEC[index], vector = familyVector(homeItem.card, awayItem.card, spec);
    const raw = predictFamily(family, vector), contribution = raw * family.influence;
    return { id: family.id, raw_residual: r4(raw), influence: family.influence,
      contribution: r4(contribution), active: family.influence > 0,
      incremental_mse_gain: family.incremental_mse_gain, fields: spec.fields, vector };
  });
  return { version: ORTHOGONAL_SPECIALIST_VERSION, artifact_id: fit.artifact_id,
    evidence_hash: sha({ home: homeItem.evidence_hash, away: awayItem.evidence_hash,
      artifact: fit.artifact_id }), forecast_residual: r4(specialists.reduce((sum, item) => sum + item.contribution, 0)),
    specialists, training_games: fit.training_games, validation_games: fit.validation_games,
    validation: { baseline_mse: fit.baseline_validation_mse, final_mse: fit.final_validation_mse },
    policy: 'Every family reports raw input. Only chronological incremental error reduction earns nonzero influence.' };
}

export function orthogonalSpecialistStatus() {
  const artifacts = rows(`SELECT through_season,through_week,training_games,validation_games,created_at
    FROM nfl_orthogonal_specialist_artifacts ORDER BY through_season DESC,through_week DESC LIMIT 12`);
  return { version: ORTHOGONAL_SPECIALIST_VERSION, family_order: FAMILY_SPEC, artifacts };
}

export const __test = { fitRidge, familyVector, chronologicalSplit, persistArtifact };
