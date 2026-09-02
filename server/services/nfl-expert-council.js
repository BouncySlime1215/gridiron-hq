/**
 * One weekly, auditable contract for every modelling approach in Gridiron HQ.
 *
 * Experts do not vote equally and a missing expert does not become zero. Each
 * expert emits its raw market-residual opinion, coverage, uncertainty and
 * authority separately. The blind audit settles those opinions week by week;
 * only earlier settled rows may become training data for a later week.
 */
import { MATCHUP_ROLES, matchupOpinion } from './nfl-matchup-specialists.js';
import { teamEventVector } from './nfl-event-archive.js';
import crypto from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { ensembleLine } from './nfl-ensemble.js';
import { buildGbmDataset, fitGbm, predictGbm } from './nfl-gbm.js';
import { createNetwork, predictNetwork, spreadFeatureVector, trainBatch } from './nfl-online-neural.js';
import { teamNewsSignals } from './nfl-news-signal.js';
import { gamePlayerAvailability } from './nfl-player-value.js';
import { gameInjuryCarryover } from './nfl-postgame-truth.js';
import { fitExpertCoordinator, coordinateExperts } from './nfl-expert-coordinator.js';
import { simulateMatchup } from './nfl-drive-sim.js';
import { nflKickoffDate } from './date-util.js';
import './line-shopping.js';
import { buildPlayerWeekEngine, teamWeekEventExpectations } from './player-week-engine.js';
import { teamRosterStrength } from './nfl-roster-strength.js';
import { matchupTeamCards } from './nfl-team-card.js';
import { orthogonalSpecialistPrediction } from './nfl-orthogonal-specialists.js';

export const EXPERT_COUNCIL_VERSION = 'nfl-expert-council-v4-shared-weekly-state';

export const NFL_EXPERTS = Object.freeze([
  { id: 'rulebook', name: 'Football rulebook', kind: 'interpretable_prior', lifecycle: 'pregame', score: 'market_residual' },
  { id: 'player_builder', name: 'Player-built team', kind: 'roster_counterfactual', lifecycle: 'pregame', score: 'market_residual' },
  { id: 'game_replay', name: 'Game replay simulator', kind: 'joint_distribution', lifecycle: 'pregame', score: 'score_distribution' },
  { id: 'similar_games', name: 'Similar-game finder', kind: 'distance_weighted_analog', lifecycle: 'pregame', score: 'market_residual' },
  { id: 'boosted_tree', name: 'Boosted decision trees', kind: 'nonlinear_tabular', lifecycle: 'pregame', score: 'market_residual' },
  { id: 'deep_residual', name: 'Online neural residual', kind: 'deep_online', lifecycle: 'pregame', score: 'market_residual' },
  { id: 'specialist_team', name: 'Specialist team', kind: 'family_council', lifecycle: 'pregame', score: 'market_residual' },
  { id: 'line_movement', name: 'Line-movement reader', kind: 'market_microstructure', lifecycle: 'pregame', score: 'market_residual' },
  { id: 'news_reaction', name: 'Verified-news reaction', kind: 'event_evidence', lifecycle: 'pregame', score: 'market_residual' },
  { id: 'live_updater', name: 'Live game updater', kind: 'state_conditioned', lifecycle: 'in_game', score: 'brier_and_calibration' },
  { id: 'price_shopper', name: 'Price shopper', kind: 'execution', lifecycle: 'decision_time', score: 'price_and_clv' },
  { id: 'player_opportunity', name: 'Player opportunity engine', kind: 'reconciled_player_usage', lifecycle: 'pregame', score: 'volume_mae' },
  // Priority 4 matchup and situational candidates (nfl-matchup-specialists.js).
  { id: 'trench_continuity', name: 'Line and QB continuity', kind: 'matchup_candidate', lifecycle: 'pregame', score: 'market_residual' },
  { id: 'tendency_matchup', name: 'Tendency matchup', kind: 'matchup_candidate', lifecycle: 'pregame', score: 'market_residual' },
  { id: 'situational_efficiency', name: 'Situational efficiency', kind: 'matchup_candidate', lifecycle: 'pregame', score: 'market_residual' },
  { id: 'pressure_matchup', name: 'Pressure matchup', kind: 'matchup_candidate', lifecycle: 'pregame', score: 'market_residual' }
]);

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_weekly_expert_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_run_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    home TEXT NOT NULL,
    away TEXT NOT NULL,
    expert_id TEXT NOT NULL,
    council_version TEXT NOT NULL,
    engine_version TEXT,
    evidence_hash TEXT NOT NULL,
    evidence_cutoff TEXT NOT NULL,
    observed INTEGER NOT NULL,
    forecast_residual REAL,
    uncertainty REAL,
    actual_residual REAL,
    directional_correct INTEGER,
    squared_error REAL,
    authority TEXT NOT NULL,
    missing_reason TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(audit_run_id,season,week,home,expert_id)
  );
  CREATE INDEX IF NOT EXISTS idx_nfl_weekly_expert_cutoff
    ON nfl_weekly_expert_examples(season,week,expert_id);
  CREATE TRIGGER IF NOT EXISTS nfl_weekly_expert_examples_no_update
    BEFORE UPDATE ON nfl_weekly_expert_examples BEGIN
      SELECT RAISE(ABORT, 'weekly expert examples are immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS nfl_weekly_expert_examples_no_delete
    BEFORE DELETE ON nfl_weekly_expert_examples BEGIN
      SELECT RAISE(ABORT, 'weekly expert examples are immutable');
    END;
  CREATE TABLE IF NOT EXISTS nfl_expert_forward_predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
    expert_id TEXT NOT NULL, horizon TEXT NOT NULL, council_version TEXT NOT NULL,
    engine_version TEXT, evidence_hash TEXT NOT NULL, evidence_cutoff TEXT NOT NULL,
    captured_at TEXT NOT NULL, market_margin REAL NOT NULL, observed INTEGER NOT NULL,
    forecast_residual REAL, uncertainty REAL, authority TEXT NOT NULL, missing_reason TEXT,
    payload_json TEXT NOT NULL,
    UNIQUE(season,week,home,expert_id,horizon)
  );
  CREATE TABLE IF NOT EXISTS nfl_expert_forward_settlements (
    prediction_id INTEGER PRIMARY KEY,
    settled_at TEXT NOT NULL, actual_margin REAL NOT NULL, actual_residual REAL NOT NULL,
    directional_correct INTEGER, squared_error REAL,
    FOREIGN KEY(prediction_id) REFERENCES nfl_expert_forward_predictions(id) ON DELETE RESTRICT
  );
  CREATE TRIGGER IF NOT EXISTS nfl_expert_forward_predictions_no_update BEFORE UPDATE ON nfl_expert_forward_predictions
    BEGIN SELECT RAISE(ABORT, 'forward expert predictions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_expert_forward_predictions_no_delete BEFORE DELETE ON nfl_expert_forward_predictions
    BEGIN SELECT RAISE(ABORT, 'forward expert predictions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_expert_forward_settlements_no_update BEFORE UPDATE ON nfl_expert_forward_settlements
    BEGIN SELECT RAISE(ABORT, 'forward expert settlements are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS nfl_expert_forward_settlements_no_delete BEFORE DELETE ON nfl_expert_forward_settlements
    BEGIN SELECT RAISE(ABORT, 'forward expert settlements are immutable'); END;
`);

const r3 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(3);
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sd = values => values.length > 1
  ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean(values)) ** 2, 0) / (values.length - 1)) : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const before = (row, season, week) => row.season < season || (row.season === season && row.week < week);

let datasetCache = null;
function dataset() {
  if (!datasetCache) datasetCache = buildGbmDataset({ fromSeason: 2016, throughSeason: 2026 });
  return datasetCache;
}

const gbmCache = new Map();
function treePrediction(season, week, targetX) {
  const data = dataset(), key = `${season}|${week}`;
  let model = gbmCache.get(key);
  if (!model) {
    const indexes = data.meta.map((row, index) => before(row, season, week) ? index : -1).filter(index => index >= 0);
    if (indexes.length < 400) return { error: `only ${indexes.length} prior complete feature rows` };
    model = fitGbm(indexes.map(index => data.X[index]), indexes.map(index => data.y[index]), {
      trees: 48, learningRate: 0.035, maxDepth: 2, minLeaf: 55, featureFraction: 0.65,
      seed: season * 100 + week
    });
    gbmCache.set(key, model);
  }
  return { forecast: predictGbm(model, targetX), training_rows: data.meta.filter(row => before(row, season, week)).length,
    method: '48 depth-2 residual trees; 0.035 shrinkage; 55-game minimum leaf' };
}

function analogPrediction(season, week, target, k = 35) {
  const data = dataset();
  const train = data.meta.map((row, index) => before(row, season, week) ? index : -1).filter(index => index >= 0);
  if (train.length < 200) return { error: `only ${train.length} prior analogs` };
  const mu = target.map((_, j) => mean(train.map(index => data.X[index][j]).filter(Number.isFinite)) ?? 0);
  const scale = target.map((_, j) => {
    const values = train.map(index => data.X[index][j]).filter(Number.isFinite), m = mu[j];
    const spread = Math.sqrt(mean(values.map(value => (value - m) ** 2)) ?? 0);
    return spread > 1e-6 ? spread : 1;
  });
  const neighbours = train.map(index => {
    const comparable = target.reduce((acc, value, j) => Number.isFinite(value) && Number.isFinite(data.X[index][j])
      ? { sum: acc.sum + ((value - data.X[index][j]) / scale[j]) ** 2, n: acc.n + 1 } : acc, { sum: 0, n: 0 });
    const distance = comparable.n ? Math.sqrt(comparable.sum / comparable.n) : Infinity;
    return { index, distance, weight: Number.isFinite(distance) ? 1 / (0.2 + distance) ** 2 : 0 };
  }).sort((a, b) => a.distance - b.distance).slice(0, k);
  const weight = neighbours.reduce((sum, item) => sum + item.weight, 0);
  if (!(weight > 0)) return { error: 'no comparable prior games' };
  const raw = neighbours.reduce((sum, item) => sum + item.weight * data.y[item.index], 0) / weight;
  // Analogs are noisy. Empirical-Bayes shrinkage toward the market prevents a
  // handful of superficially similar games from producing a giant opinion.
  const effectiveN = weight ** 2 / neighbours.reduce((sum, item) => sum + item.weight ** 2, 0);
  const shrink = effectiveN / (effectiveN + 30);
  const forecast = raw * shrink;
  const variance = neighbours.reduce((sum, item) => sum + item.weight * (data.y[item.index] - raw) ** 2, 0) / weight;
  return { forecast, uncertainty: Math.sqrt(Math.max(variance, 0)), effective_n: r3(effectiveN), shrinkage: r3(shrink),
    nearest: neighbours.slice(0, 5).map(item => ({ ...data.meta[item.index], residual: r3(data.y[item.index]), distance: r3(item.distance) })) };
}

function output(id, { forecast = null, uncertainty = null, observed = forecast != null,
  authority = 'research_only', missingReason = null, detail = {} } = {}) {
  return { id, observed: Boolean(observed), forecast_residual: r3(forecast), uncertainty: r3(uncertainty),
    authority, missing_reason: observed ? null : (missingReason ?? 'required evidence unavailable'), detail };
}

function reportingState(registry, row = {}) {
  const examples = Number(row.examples ?? 0);
  const observed = Number(row.observed ?? 0);
  const forecasts = Number(row.forecasts ?? row.directional_calls ?? 0);
  const missing = Math.max(0, examples - observed);
  let state = 'not_run';
  if (examples > 0 && observed === 0) {
    state = registry.lifecycle === 'pregame' ? 'zero_coverage' : 'different_lifecycle';
  } else if (observed > 0 && forecasts === 0) {
    state = registry.score === 'market_residual' ? 'support_only' : 'different_score';
  } else if (forecasts > 0 && forecasts < examples) {
    state = 'partial_forecast';
  } else if (forecasts > 0) {
    state = 'forecasting';
  }
  return { ...registry, ...row, examples, observed, forecasts, missing,
    coverage: examples ? r3(observed / examples) : 0,
    forecast_coverage: examples ? r3(forecasts / examples) : 0,
    reporting_state: state };
}

function matrixCell(registry, row) {
  if (!row) return { id: registry.id, status: 'not_recorded', observed: false,
    forecast_residual: null, missing_reason: 'specialist row was not persisted' };
  const observed = Boolean(row.observed);
  const forecast = Number.isFinite(row.forecast_residual);
  const status = observed
    ? (forecast ? 'forecast' : 'support')
    : (registry.lifecycle === 'pregame' ? 'missing' : 'different_lifecycle');
  return { id: registry.id, status, observed, forecast_residual: forecast ? row.forecast_residual : null,
    uncertainty: row.uncertainty ?? null, authority: row.authority ?? null,
    missing_reason: observed ? null : (row.missing_reason ?? 'required evidence unavailable'),
    directional_correct: row.directional_correct == null ? null : Boolean(row.directional_correct) };
}

function combinedDecisionTrace(game, experts, coordinator) {
  const ready = Boolean(coordinator?.ready);
  const forecastResidual = ready && Number.isFinite(coordinator.forecast_residual)
    ? coordinator.forecast_residual : null;
  const actualResidual = Number.isFinite(game.actual_residual) ? game.actual_residual : null;
  const directionalCorrect = Number.isFinite(forecastResidual) && Number.isFinite(actualResidual)
    && Math.abs(forecastResidual) > 1e-9 && Math.abs(actualResidual) > 1e-9
    ? Math.sign(forecastResidual) === Math.sign(actualResidual) : null;
  return {
    state: ready ? 'candidate_forecast_only' : 'warmup_abstain',
    contributors: experts.map(expert => {
      const learned = coordinator?.contributions?.find(item => item.id === expert.id);
      return { id: expert.id, observed: expert.observed, raw_opinion: expert.forecast_residual,
        learned_weight: learned?.learned_weight ?? null,
        normalized_weight: learned?.normalized_weight ?? null,
        contribution: learned?.value ?? null,
        missing_reason: expert.missing_reason ?? null };
    }),
    disagreement: coordinator?.disagreement ?? null,
    final_prediction: { market_margin: game.market_margin,
      forecast_residual: forecastResidual,
      projected_home_margin: Number.isFinite(forecastResidual) && Number.isFinite(game.market_margin)
        ? r3(game.market_margin + forecastResidual) : null },
    selection: { side: null, price: null, stake_units: 0,
      reason: ready ? 'candidate coordinator has no staking authority' : coordinator?.reason ?? 'coordinator warmup incomplete' },
    settlement: { actual_margin: game.actual_margin ?? null, actual_residual: actualResidual,
      directional_correct: directionalCorrect },
    authority: coordinator?.authority ?? 'warmup_abstain'
  };
}

function familyCouncil(line, marketMargin) {
  const groups = new Map();
  for (const model of line.models ?? []) {
    if (!Number.isFinite(model.margin)) continue;
    const list = groups.get(model.family) ?? [];
    list.push(model.margin - marketMargin); groups.set(model.family, list);
  }
  const families = [...groups].map(([family, values]) => ({ family, forecast: r3(median(values)), members: values.length }));
  const forecasts = families.map(item => item.forecast).filter(Number.isFinite);
  return { forecast: median(forecasts), uncertainty: sd(forecasts), families };
}

function movementFor(season, week, home, storedSpread) {
  const game = rows(`SELECT open_spread,spread FROM game_lines WHERE season=? AND week=? AND team=? AND home=1 LIMIT 1`, season, week, home)[0];
  if (!Number.isFinite(game?.open_spread) || !Number.isFinite(game?.spread)) return null;
  const training = rows(`SELECT season,week,open_spread,spread,team_score,opp_score FROM game_lines
    WHERE home=1 AND open_spread IS NOT NULL AND spread IS NOT NULL AND team_score IS NOT NULL AND opp_score IS NOT NULL
      AND (season<? OR (season=? AND week<?)) ORDER BY season,week`, season, season, week)
    .map(row => ({ x: (-row.spread) - (-row.open_spread), y: (row.team_score - row.opp_score) - (-row.spread) }))
    .filter(row => Number.isFinite(row.x) && Number.isFinite(row.y) && Math.abs(row.x) <= 14 && Math.abs(row.y) <= 45);
  const move = (-game.spread) - (-game.open_spread);
  if (training.length < 120) return { opening_spread: game.open_spread, decision_spread: game.spread,
    home_margin_move: r3(move), forecast: null, uncertainty: null, training_rows: training.length,
    missing_reason: `only ${training.length} prior opening-to-decision examples`,
    provenance: 'stored opening and decision lines; earlier settled games only', stored_spread: storedSpread };
  const mx = mean(training.map(row => row.x)), my = mean(training.map(row => row.y));
  const covariance = training.reduce((sum, row) => sum + (row.x - mx) * (row.y - my), 0);
  const variance = training.reduce((sum, row) => sum + (row.x - mx) ** 2, 0);
  const slope = Math.max(-1, Math.min(1, covariance / (variance + 80)));
  const intercept = Math.max(-1, Math.min(1, my - slope * mx));
  const forecast = Math.max(-6, Math.min(6, intercept + slope * move));
  const error = training.map(row => row.y - (intercept + slope * row.x));
  return { opening_spread: game.open_spread, decision_spread: game.spread,
    home_margin_move: r3(move), forecast: r3(forecast), uncertainty: r3(sd(error)),
    coefficient: r3(slope), intercept: r3(intercept), training_rows: training.length,
    provenance: 'ridge-shrunk opening-to-decision residual fit on earlier settled games only', stored_spread: storedSpread };
}

function newsFor(line, beforeIso) {
  const home = teamNewsSignals(line.home, { before: beforeIso }), away = teamNewsSignals(line.away, { before: beforeIso });
  const claims = (home.claims?.length ?? 0) + (away.claims?.length ?? 0);
  const since = Number.isFinite(Date.parse(beforeIso)) ? new Date(Date.parse(beforeIso) - 7 * 86400000).toISOString() : beforeIso;
  const teamIds = rows(`SELECT id,abbr FROM nfl_teams WHERE abbr IN (?,?)`, line.home, line.away);
  const ids = teamIds.map(team => team.id);
  const feedStories = ids.length ? rows(`SELECT COUNT(*) n FROM news_items WHERE published_at<=? AND published_at>=?
    AND team_id IN (${ids.map(() => '?').join(',')})`, beforeIso, since, ...ids)[0]?.n ?? 0 : 0;
  let burdenEdge = r3((away.unavailable_burden ?? 0) - (home.unavailable_burden ?? 0));
  // A raw research opinion, not a hard-coded production weight. Each verified
  // unavailable player contributes probability x source confidence; the
  // weekly coordinator learns whether and how strongly this scale matters.
  let forecast = claims > 0 ? Math.max(-4, Math.min(4, burdenEdge * 0.75)) : feedStories >= 3 ? 0 : null;
  // Before the typed news feed existed (it starts 2026-08) the verified event
  // archive carries the same facts with timestamps: official injury reports,
  // roster status changes and trades, each `available_at` before the cutoff.
  // PROFITABILITY_PLAN Priority 3: "backfill verified, timestamped injury,
  // practice, transaction, roster and role news". Unverified or post-kickoff
  // knowledge never enters: the archive query is bounded by `before`.
  let archive = null;
  if (forecast == null) {
    const homeEvents = teamEventVector(line.home, { before: beforeIso, sinceDays: 10 });
    const awayEvents = teamEventVector(line.away, { before: beforeIso, sinceDays: 10 });
    if ((homeEvents.events + awayEvents.events) > 0) {
      const edge = r3((awayEvents.injury_burden ?? 0) - (homeEvents.injury_burden ?? 0));
      burdenEdge = edge;
      forecast = Math.max(-4, Math.min(4, edge * 0.5));
      archive = { source: 'nfl_verified_events', home_events: homeEvents.events, away_events: awayEvents.events,
        home_injury_burden: r3(homeEvents.injury_burden), away_injury_burden: r3(awayEvents.injury_burden),
        home_active_states: homeEvents.active_player_states.slice(0, 12).map(e => ({ player: e.player_name, status: e.status_after, at: e.available_at, source: e.source })),
        away_active_states: awayEvents.active_player_states.slice(0, 12).map(e => ({ player: e.player_name, status: e.status_after, at: e.available_at, source: e.source })),
        cutoff: beforeIso };
    }
  }
  return { home, away, verified_claims: claims, verified_event_archive: archive,
    feed_stories: Number(feedStories), burden_edge: burdenEdge, forecast: r3(forecast),
    evidence_state: claims > 0 ? 'verified_material_claims' : feedStories >= 3 ? 'observed_no_material_claim' : 'feed_coverage_missing' };
}

function auditedNeuralFor(line, { season, week, cutoff, auditRunId = null }) {
  const current = spreadFeatureVector(line, { before: cutoff });
  if (!current) return { error: 'market spread unavailable for neural residual' };
  const stored = auditRunId == null
    ? rows(`SELECT season,week,home,actual_residual,payload_json,audit_run_id,id
      FROM nfl_weekly_expert_examples WHERE expert_id='deep_residual' AND actual_residual IS NOT NULL
        AND (season<? OR (season=? AND week<?)) ORDER BY season,week,home,audit_run_id,id`, season, season, week)
    : rows(`SELECT season,week,home,actual_residual,payload_json,audit_run_id,id
      FROM nfl_weekly_expert_examples WHERE audit_run_id=? AND expert_id='deep_residual' AND actual_residual IS NOT NULL
        AND (season<? OR (season=? AND week<?)) ORDER BY season,week,home,id`, auditRunId, season, season, week);
  const unique = new Map();
  for (const item of stored) {
    let payload; try { payload = JSON.parse(item.payload_json || '{}'); } catch { continue; }
    const vector = payload.feature_vector;
    if (vector?.schema !== 'nfl-online-neural-features-v2-verified-news'
      || !Array.isArray(vector.values) || vector.values.length !== current.values.length) continue;
    unique.set(`${item.season}|${item.week}|${item.home}`, { ...item, input: vector.values, target: item.actual_residual });
  }
  const examples = [...unique.values()].sort((a, b) => a.season - b.season || a.week - b.week || a.home.localeCompare(b.home));
  let network = createNetwork(current.values.length), replay = [], trainedWeeks = 0;
  for (const key of [...new Set(examples.map(item => `${item.season}|${item.week}`))]) {
    const [trainSeason, trainWeek] = key.split('|').map(Number);
    const batch = examples.filter(item => item.season === trainSeason && item.week === trainWeek)
      .map(item => ({ input: item.input, target: item.target }));
    replay.push(...batch);
    network = trainBatch(network, replay.slice(-512)); trainedWeeks++;
  }
  const residual = predictNetwork(network, current.values);
  return { head: 'spread_residual', version: 'audited-weekly-neural-v1',
    schema_version: 'nfl-online-neural-features-v2-verified-news', residual: r3(residual),
    predicted_margin: r3(current.market_margin + residual), market_margin: current.market_margin,
    metrics: { examples: examples.length, weeks: trainedWeeks, production_eligible: false },
    authority: 'historical_candidate_only', learning_source: 'immutable deduplicated expert rows from strictly earlier weeks',
    feature_vector: { schema: 'nfl-online-neural-features-v2-verified-news', names: current.names, values: current.values } };
}

/**
 * The live updater's historical record: the possession-by-possession win
 * probabilities the ledger reconstructed for this game, settled against the
 * final. Scored by Brier, never by margin residual, and marked
 * `historical_reconstruction` forever — it is what the live model WOULD have
 * said at each possession, not a forward prediction.
 */
function liveLedgerFor(season, week, home) {
  const settled = rows(`SELECT p.possession_index,p.sequence,s.home_probability,s.brier,s.home_won,p.classification,p.state_json
    FROM nfl_live_possession_predictions p JOIN nfl_live_possession_settlements s ON s.prediction_id=p.prediction_id
    WHERE p.season=? AND p.week=? AND p.home_team=? ORDER BY p.sequence`, season, week, home);
  if (!settled.length) return null;
  const briers = settled.map(row => row.brier).filter(Number.isFinite);
  const half = settled.find(row => { try { return JSON.parse(row.state_json).period >= 3; } catch { return false; } }) ?? null;
  return { classification: settled[0].classification, possessions: settled.length,
    mean_brier: r3(mean(briers)), opening_home_probability: r3(settled[0].home_probability),
    second_half_home_probability: half ? r3(half.home_probability) : null,
    final_home_won: Boolean(settled[0].home_won), score_target: 'brier_and_calibration',
    note: 'possession-level reconstruction settled against the final; not a pregame opinion and never a forward call' };
}

function shoppingFor(home, away, cutoff) {
  const normalize = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const teams = rows(`SELECT abbr,name FROM nfl_teams WHERE abbr IN (?,?)`, home, away);
  const aliases = new Map(teams.map(team => [team.abbr, [normalize(team.abbr), normalize(team.name)]]));
  const snapshots = rows(`SELECT * FROM nfl_line_snapshots WHERE captured_at<=? AND market='spreads'
    AND (commence_time IS NULL OR commence_time>?) ORDER BY captured_at DESC`, cutoff, cutoff)
    .filter(row => {
      const h = normalize(row.home_team), a = normalize(row.away_team);
      const homeAliases = aliases.get(home) ?? [normalize(home)], awayAliases = aliases.get(away) ?? [normalize(away)];
      return homeAliases.some(alias => alias && h.includes(alias)) && awayAliases.some(alias => alias && a.includes(alias));
    });
  if (!snapshots.length) return null;
  const latestAt = snapshots[0].captured_at;
  const latest = snapshots.filter(row => row.captured_at === latestAt);
  const sides = [];
  for (const team of [home, away]) {
    const teamAliases = aliases.get(team) ?? [normalize(team)];
    const quotes = latest.filter(row => teamAliases.some(alias => alias && normalize(row.side).includes(alias))
      && Number.isFinite(row.line) && Number.isFinite(row.price));
    if (quotes.length < 2) continue;
    const ordered = [...quotes].sort((a, b) => b.line - a.line || b.price - a.price);
    const best = ordered[0], worst = ordered.at(-1);
    sides.push({ team, books: quotes.length, best: { book: best.book, line: best.line, price: best.price },
      worst: { book: worst.book, line: worst.line, price: worst.price },
      line_advantage: r3(best.line - worst.line), price_advantage: best.line === worst.line ? best.price - worst.price : null });
  }
  return sides.length ? { captured_at: latestAt, cutoff, sides, score_target: 'execution_clv',
    best_line_gain: Math.max(...sides.map(side => side.line_advantage ?? 0)),
    note: 'Execution model is scored by price and closing-line value, not by game-margin residual.' } : null;
}

function opportunityFor(season, week, home, away) {
  let engine;
  try { engine = buildPlayerWeekEngine({ season, week }); }
  catch (error) { return { error: error.message, teams: [] }; }
  const summarize = team => {
    const expectations = teamWeekEventExpectations(engine, team, { reconciliationStrength: 1, conditionalPrimary: true });
    const players = [...expectations.values()].map(events => ({ player: engine.get(events.player_id), events }))
      .filter(item => item.player && item.events);
    const top = [...players].sort((a, b) => ((b.events.volume.targets ?? 0) + (b.events.volume.carries ?? 0))
      - ((a.events.volume.targets ?? 0) + (a.events.volume.carries ?? 0))).slice(0, 8);
    const playerPredictions = players.map(item => ({
      player_id: item.player.gsis_id ?? null,
      player: item.player.name,
      position: item.player.position,
      attempts: r3(item.events.volume.attempts),
      carries: r3(item.events.volume.carries),
      targets: r3(item.events.volume.targets)
    }));
    return { team, players: players.length,
      attempts: r3(players.reduce((sum, item) => sum + (item.events.volume.attempts ?? 0), 0)),
      carries: r3(players.reduce((sum, item) => sum + (item.events.volume.carries ?? 0), 0)),
      targets: r3(players.reduce((sum, item) => sum + (item.events.volume.targets ?? 0), 0)),
      top_roles: top.map(item => ({ player_id: item.player.gsis_id ?? null,
        player: item.player.name, position: item.player.position,
        carries: r3(item.events.volume.carries), targets: r3(item.events.volume.targets), attempts: r3(item.events.volume.attempts) })),
      player_predictions: playerPredictions };
  };
  const teams = [summarize(home), summarize(away)];
  return { engine_version: teams.some(team => team.players) ? 'shared-player-week-engine' : null, teams,
    score_target: 'next-week attempts/carries/targets MAE and role calibration',
    evidence_cutoff: `${season}-W${Math.max(0, week - 1)}` };
}

function settleOpportunity(season, week, opportunity) {
  const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
  const actualRows = rows(`SELECT player_id,player_name,team,position,features FROM nfl_player_week_features
    WHERE season=? AND week=? AND team IN (${opportunity.teams.map(() => '?').join(',')})`,
  season, week, ...opportunity.teams.map(team => team.team));
  if (!actualRows.length) return { status: 'pending', reason: 'target-week player play-by-play has not been ingested' };
  const actualByTeam = new Map();
  for (const row of actualRows) {
    const features = parse(row.features);
    const list = actualByTeam.get(row.team) ?? [];
    list.push({ player_id: row.player_id, player: row.player_name, position: row.position,
      attempts: Number(features.pass_attempts ?? 0), carries: Number(features.carries ?? 0),
      targets: Number(features.targets ?? 0) });
    actualByTeam.set(row.team, list);
  }
  const teamResults = opportunity.teams.map(predicted => {
    const actualPlayers = actualByTeam.get(predicted.team) ?? [];
    const actual = {
      attempts: actualPlayers.reduce((sum, player) => sum + player.attempts, 0),
      carries: actualPlayers.reduce((sum, player) => sum + player.carries, 0),
      targets: actualPlayers.reduce((sum, player) => sum + player.targets, 0)
    };
    const errors = ['attempts', 'carries', 'targets'].map(metric => Math.abs((predicted[metric] ?? 0) - actual[metric]));
    const actualById = new Map(actualPlayers.map(player => [player.player_id, player]));
    const playerErrors = (predicted.player_predictions ?? []).flatMap(player => {
      if (!player.player_id || !actualById.has(player.player_id)) return [];
      const truth = actualById.get(player.player_id);
      const metrics = player.position === 'QB' ? ['attempts', 'carries']
        : player.position === 'RB' ? ['carries', 'targets']
          : ['WR', 'TE'].includes(player.position) ? ['targets'] : [];
      return metrics.map(metric => ({ player_id: player.player_id,
        player: player.player, metric, predicted: player[metric], actual: truth[metric],
        absolute_error: r3(Math.abs((player[metric] ?? 0) - truth[metric])) }));
    });
    return { team: predicted.team, predicted: { attempts: predicted.attempts, carries: predicted.carries, targets: predicted.targets },
      actual, team_volume_mae: r3(mean(errors)), matched_players: new Set(playerErrors.map(error => error.player_id)).size,
      player_volume_mae: r3(mean(playerErrors.map(error => error.absolute_error))), player_errors: playerErrors };
  });
  return { status: 'settled', teams: teamResults,
    team_volume_mae: r3(mean(teamResults.map(team => team.team_volume_mae).filter(Number.isFinite))),
    player_volume_mae: r3(mean(teamResults.map(team => team.player_volume_mae).filter(Number.isFinite))),
    score_target: 'team volume plus role-relevant player volume: QB attempts/carries, RB carries/targets, WR/TE targets' };
}

function kickoffFor(season, week, home) {
  const game = rows(`SELECT gameday,gametime FROM game_lines WHERE season=? AND week=? AND team=? AND home=1 LIMIT 1`, season, week, home)[0];
  if (!game?.gameday) return `${season}-W${week}-pregame`;
  return nflKickoffDate(game.gameday, game.gametime || '23:59')?.toISOString() ?? `${season}-W${week}-pregame`;
}

function gameExperts(season, week, targetIndex, data = dataset(), { auditRunId = null } = {}) {
  const game = data.meta[targetIndex], targetX = data.X[targetIndex];
  const line = ensembleLine(season, week, game.home, game.away,
    // This is the exact packet the historical betting replay has already
    // frozen and cached. Expert adapters must not trigger a second fit with a
    // subtly different input universe.
    { blendMode: 'raw', includeEvidence: false, includeChallengers: false });
  if (line.error) return { game, error: line.error, experts: [] };
  const marketMargin = Number.isFinite(line.ensemble.market_spread) ? -line.ensemble.market_spread : game.marketMargin;
  const cutoff = kickoffFor(season, week, game.home);
  const modelResiduals = (line.models ?? []).filter(model => Number.isFinite(model.margin))
    .map(model => model.margin - marketMargin);
  const simpleIds = new Set(['elo', 'melo', 'point_diff', 'pythagorean', 'recent_form', 'rest_travel']);
  const simple = line.models.filter(model => simpleIds.has(model.id) && Number.isFinite(model.margin))
    .map(model => model.margin - marketMargin);
  const availability = gamePlayerAvailability(season, week, game.home, game.away);
  const injuryCarryover = gameInjuryCarryover(season, week, game.home, game.away);
  const tree = treePrediction(season, week, targetX);
  const analog = analogPrediction(season, week, targetX);
  const neural = auditedNeuralFor(line, { season, week, cutoff, auditRunId });
  const simulation = simulateMatchup({ home: game.home, away: game.away, season, week, trials: 160,
    spread: line.ensemble.market_spread, total: line.ensemble.market_total,
    targetMargin: line.ensemble.projected_margin, targetTotal: line.ensemble.projected_total,
    seed: crypto.createHash('sha256').update(`${EXPERT_COUNCIL_VERSION}|${season}|${week}|${game.home}`)
      .digest().readUInt32BE(0) });
  const council = familyCouncil(line, marketMargin);
  const movement = movementFor(season, week, game.home, line.ensemble.market_spread);
  const news = newsFor(line, cutoff);
  const shopping = shoppingFor(game.home, game.away, cutoff);
  const liveLedger = liveLedgerFor(season, week, game.home);
  const opportunity = opportunityFor(season, week, game.home, game.away);
  const opportunitySettlement = opportunity.teams?.length ? settleOpportunity(season, week, opportunity)
    : { status: 'pending', reason: opportunity.error ?? 'player opportunity packet unavailable' };
  const sharedCards = matchupTeamCards(season, week, game.home, game.away);
  const homeRoster = sharedCards.error ? teamRosterStrength(season, week, game.home) : sharedCards.home.roster;
  const awayRoster = sharedCards.error ? teamRosterStrength(season, week, game.away) : sharedCards.away.roster;
  const orthogonal = sharedCards.error ? { error: sharedCards.error }
    : orthogonalSpecialistPrediction(season, week, game.home, game.away, { persistFit: false });
  const structuralMargin = homeRoster.available && awayRoster.available
    ? 1.5 + (homeRoster.roster_score - awayRoster.roster_score) * 0.32 : null;
  const availabilityResidual = Number.isFinite(availability?.shadow_margin_adjustment)
    && availability?.home?.evidence_state !== 'availability_unknown'
    && availability?.away?.evidence_state !== 'availability_unknown'
    ? availability.shadow_margin_adjustment + (injuryCarryover.incremental_margin_adjustment ?? 0) : null;
  const rosterResidual = Number.isFinite(structuralMargin)
    ? structuralMargin - marketMargin + (availabilityResidual ?? 0) : availabilityResidual;
  const rosterObserved = Number.isFinite(rosterResidual);
  const rosterSummary = roster => ({ available: roster.available, roster_score: roster.roster_score,
    starter_score: roster.starter_score, depth_score: roster.depth_score, fragility: roster.fragility,
    unit_scores: roster.unit_scores, coverage: roster.coverage, preseason_context: roster.preseason_context,
    cutoff_policy: roster.cutoff_policy, reason: roster.reason });
  const unitEdges = availability?.unit_edges ?? null;
  const playerOpportunity = unitEdges ? (unitEdges.offense ?? 0) * 0.55 + (unitEdges.defense ?? 0) * 0.35
    + (unitEdges.special_teams ?? 0) * 0.1 : null;
  const experts = [
    output('rulebook', { forecast: median(simple), uncertainty: sd(simple), observed: simple.length > 0,
      missingReason: 'no cutoff-safe simple football priors', detail: { components: simple.length } }),
    output('player_builder', { forecast: rosterObserved ? rosterResidual : null, observed: rosterObserved,
      missingReason: availability?.reason ?? 'cutoff-safe depth and replacement data unavailable',
      uncertainty: rosterObserved ? 4 + ((homeRoster.fragility ?? 50) + (awayRoster.fragility ?? 50)) / 50 : null,
      detail: { full_roster: { home: rosterSummary(homeRoster), away: rosterSummary(awayRoster), structural_margin: r3(structuralMargin),
        market_residual_before_availability: r3(Number.isFinite(structuralMargin) ? structuralMargin - marketMargin : null) },
        roster_availability: availability ?? {}, availability_residual: r3(availabilityResidual),
        postgame_injury_carryover: injuryCarryover,
        method: 'full roster/depth prior plus replacement-value availability; coordinator learns final influence on earlier weeks' } }),
    output('game_replay', { forecast: simulation.error ? null : simulation.projection.margin - marketMargin,
      uncertainty: simulation.error ? null : simulation.projection.margin_sd, observed: !simulation.error,
      missingReason: simulation.error, detail: simulation.error ? {} : { trials: simulation.trials,
        projection: simulation.projection, distribution: simulation.distribution, key_numbers: simulation.key_numbers,
        reconciliation: simulation.reconciliation, play_model: simulation.play_model,
        settlement: Number.isFinite(game.actualMargin) ? {
          actual_margin: r3(game.actualMargin), actual_total: r3(game.actualTotal),
          margin_absolute_error: r3(Math.abs(simulation.projection.margin - game.actualMargin)),
          total_absolute_error: Number.isFinite(game.actualTotal)
            ? r3(Math.abs(simulation.projection.total - game.actualTotal)) : null,
          margin_80_interval_hit: Number.isFinite(simulation.distribution?.margin?.p10)
            && Number.isFinite(simulation.distribution?.margin?.p90)
            ? game.actualMargin >= simulation.distribution.margin.p10 && game.actualMargin <= simulation.distribution.margin.p90 : null,
          score_target: 'joint margin and total distribution' } : { status: 'pending' } } }),
    output('similar_games', { forecast: analog.forecast, uncertainty: analog.uncertainty, observed: !analog.error,
      missingReason: analog.error, detail: analog }),
    output('boosted_tree', { forecast: tree.forecast, observed: !tree.error, missingReason: tree.error, detail: tree }),
    output('deep_residual', { forecast: neural.metrics?.examples > 0 ? neural.residual : null,
      observed: !neural.error && neural.metrics?.examples > 0,
      missingReason: neural.error ?? 'online neural has no prior settled weekly examples',
      authority: neural.authority ?? 'shadow_only', detail: neural }),
    output('specialist_team', {
      forecast: Number.isFinite(orthogonal.forecast_residual) ? orthogonal.forecast_residual : council.forecast,
      uncertainty: council.uncertainty,
      observed: Number.isFinite(orthogonal.forecast_residual) || Number.isFinite(council.forecast),
      missingReason: orthogonal.error && !Number.isFinite(council.forecast) ? orthogonal.error : null,
      detail: { orthogonal, legacy_family_fallback: council,
        method: 'Each specialist learns only the chronological residual left by earlier families; raw opinions remain visible.' } }),
    output('line_movement', { forecast: movement?.forecast, uncertainty: movement?.uncertainty,
      observed: Number.isFinite(movement?.forecast), missingReason: movement?.missing_reason ?? 'no valid stored open-to-decision pair',
      detail: movement ?? {}, authority: 'historical_candidate_only' }),
    output('news_reaction', { forecast: news.forecast, observed: Number.isFinite(news.forecast),
      missingReason: news.evidence_state === 'feed_coverage_missing' ? 'verified news feed coverage missing before kickoff' : null,
      detail: news, authority: 'historical_candidate_only' }),
    output('live_updater', { observed: Boolean(liveLedger), forecast: null,
      missingReason: 'no possession ledger for this game (pregame audit has no live game state)',
      authority: liveLedger ? 'historical_reconstruction' : 'different_lifecycle',
      detail: liveLedger ?? { required: ['clock', 'score', 'possession', 'field_position', 'timeouts'] } }),
    output('price_shopper', { observed: Boolean(shopping), missingReason: 'historical multi-book decision quotes unavailable for this game',
      authority: 'execution_only', detail: shopping ?? { market_spread: line.ensemble.market_spread,
        active_lifecycle: 'collecting multi-book snapshots for execution scoring' } }),
    output('player_opportunity', { observed: opportunity.teams?.some(team => team.players > 0),
      missingReason: 'reconciled player opportunity packet unavailable', detail: { unit_edges: unitEdges,
        player_opportunity: opportunity, settlement: opportunitySettlement } }),
    ...MATCHUP_ROLES.map(role => {
      const opinion = matchupOpinion(role, season, week, game.home, game.away);
      return output(role, { forecast: opinion.forecast, uncertainty: opinion.uncertainty,
        missingReason: opinion.missing_reason, detail: opinion, authority: 'historical_candidate_only' });
    })
  ];
  const actualResidual = data.y[targetIndex];
  return {
    game: { season, week, home: game.home, away: game.away, market_margin: r3(marketMargin),
      market_total: r3(line.ensemble.market_total),
      actual_margin: r3(game.actualMargin), actual_residual: r3(actualResidual), evidence_cutoff: cutoff,
      engine_version: line.engine_version },
    evidence_hash: hash({ cutoff, engine: line.engine_version, models: line.models, marketMargin, availability,
      injuryCarryover, shared_team_cards: sharedCards.evidence_hash ?? sharedCards.error,
      roster: { home: rosterSummary(homeRoster), away: rosterSummary(awayRoster) } }),
    component_forecasts: modelResiduals.length,
    experts: experts.map(expert => ({ ...expert,
      directional_correct: Number.isFinite(actualResidual) && Number.isFinite(expert.forecast_residual)
        && Math.abs(expert.forecast_residual) > 1e-9 && Math.abs(actualResidual) > 1e-9
        ? Math.sign(expert.forecast_residual) === Math.sign(actualResidual) : null,
      squared_error: Number.isFinite(actualResidual) && Number.isFinite(expert.forecast_residual)
        ? r3((expert.forecast_residual - actualResidual) ** 2) : null
    }))
  };
}

export function weeklyExpertAudit(season, week, { auditRunId = null } = {}) {
  const data = dataset();
  const targets = data.meta.map((row, index) => row.season === season && row.week === week ? index : -1).filter(index => index >= 0);
  const coordinatorFit = fitExpertCoordinator(season, week, { auditRunId });
  const games = targets.map(index => {
    const result = gameExperts(season, week, index, data, { auditRunId });
    const coordinator = coordinateExperts(coordinatorFit, result.experts, result.game);
    return { ...result, coordinator, combined_decision: combinedDecisionTrace(result.game, result.experts, coordinator) };
  });
  const expertSummary = NFL_EXPERTS.map(registry => {
    const observed = games.map(game => game.experts.find(expert => expert.id === registry.id)).filter(expert => expert?.observed);
    const directional = observed.filter(expert => expert.directional_correct != null);
    const opportunityMae = registry.score === 'volume_mae' ? observed
      .map(expert => expert.detail?.settlement?.player_volume_mae).filter(Number.isFinite) : [];
    const marginMae = registry.score === 'score_distribution' ? observed
      .map(expert => expert.detail?.settlement?.margin_absolute_error).filter(Number.isFinite) : [];
    const totalMae = registry.score === 'score_distribution' ? observed
      .map(expert => expert.detail?.settlement?.total_absolute_error).filter(Number.isFinite) : [];
    const intervalHits = registry.score === 'score_distribution' ? observed
      .map(expert => expert.detail?.settlement?.margin_80_interval_hit).filter(value => value != null) : [];
    const lifecycleScored = registry.score === 'volume_mae' ? opportunityMae.length
      : registry.score === 'score_distribution' ? marginMae.length : directional.length;
    return { ...registry, games: games.length, observed: observed.length, coverage: games.length ? r3(observed.length / games.length) : 0,
      scored: lifecycleScored, directional_rate: directional.length
        ? r3(directional.filter(expert => expert.directional_correct).length / directional.length) : null,
      mean_squared_error: registry.score === 'market_residual' && observed.length
        ? r3(mean(observed.map(expert => expert.squared_error).filter(Number.isFinite))) : null,
      player_volume_mae: opportunityMae.length ? r3(mean(opportunityMae)) : null,
      margin_mae: marginMae.length ? r3(mean(marginMae)) : null,
      total_mae: totalMae.length ? r3(mean(totalMae)) : null,
      margin_80_interval_coverage: intervalHits.length ? r3(intervalHits.filter(Boolean).length / intervalHits.length) : null };
  });
  return { version: EXPERT_COUNCIL_VERSION, season, week, games, experts: expertSummary,
    coordinator: { version: coordinatorFit.version, ready: coordinatorFit.ready, training_games: coordinatorFit.games,
      training_weeks: coordinatorFit.weeks, reason: coordinatorFit.reason ?? null, safeguards: coordinatorFit.safeguards ?? null },
    contract: ['observed', 'forecast_residual', 'uncertainty', 'authority', 'missing_reason', 'evidence_hash', 'evidence_cutoff', 'settled_error'],
    learning_rule: 'Only immutable examples from strictly earlier settled weeks may train a later candidate. Abstentions remain in the dataset.' };
}

/** Freeze the forward council before kickoff. Settlement is a separate append. */
export function captureForwardExpertWeek(season, week, { horizon = 'manual' } = {}) {
  const data = buildGbmDataset({ fromSeason: 2016, throughSeason: season, includeUnsettled: true });
  const targets = data.meta.map((row, index) => row.season === season && row.week === week
    && row.actualMargin == null ? index : -1).filter(index => index >= 0);
  const coordinatorFit = fitExpertCoordinator(season, week);
  const capturedAt = new Date().toISOString();
  let inserted = 0, existing = 0, skipped = 0;
  const errors = [];
  for (const index of targets) {
    const target = data.meta[index];
    const already = rows(`SELECT COUNT(*) n FROM nfl_expert_forward_predictions
      WHERE season=? AND week=? AND home=? AND horizon=?`, season, week, target.home, String(horizon))[0]?.n ?? 0;
    // Twelve experts plus the coordinator. Comparing against twelve alone froze
    // out the coordinator row forever once a warm-up capture had run.
    if (Number(already) >= NFL_EXPERTS.length + 1) { existing += Number(already); continue; }
    const item = gameExperts(season, week, index, data);
    if (item.error) {
      // A game the ensemble cannot price is a recorded failure, not a silent
      // "games: 16, inserted: 0" that looks like success.
      errors.push({ home: target.home, away: target.away, error: item.error });
      continue;
    }
    const kickoff = Date.parse(item.game.evidence_cutoff);
    if (Number.isFinite(kickoff) && kickoff <= Date.now()) { skipped++; continue; }
    const coordinator = coordinateExperts(coordinatorFit, item.experts, item.game);
    const outputs = [...item.experts, ...(coordinator.ready ? [{ id: 'coordinator', observed: true,
      forecast_residual: coordinator.forecast_residual, uncertainty: coordinator.uncertainty,
      authority: coordinator.authority, missing_reason: null, detail: coordinator }] : [])];
    // The combined decision is its own frozen row: every contributor's raw
    // opinion, learned and normalized weight, the disagreement, the final
    // number, the side and price the production policy actually selected (or
    // its abstention reason), and — after settlement — the result. Without it
    // the per-expert rows had to be reassembled by hand to answer "what did the
    // council decide", and the selected price was not recorded anywhere.
    const trace = combinedDecisionTrace(item.game, item.experts, coordinator);
    const decision = rows(`SELECT selection,market,line,american_price,book,quote_at,eligible,abstention_reason,policy_rank
      FROM nfl_pick_decisions WHERE season=? AND week=? AND matchup=? ORDER BY recorded_at DESC LIMIT 1`,
    season, week, `${item.game.away} at ${item.game.home}`)[0] ?? null;
    trace.selection = {
      side: decision?.eligible ? decision.selection : null,
      market: decision?.market ?? null, line: decision?.line ?? null, price: decision?.american_price ?? null,
      book: decision?.book ?? null, quote_at: decision?.quote_at ?? null,
      stake_units: 0, eligible: decision ? Boolean(decision.eligible) : null,
      abstention_reason: decision?.abstention_reason ?? null, policy_rank: decision?.policy_rank ?? null,
      reason: !decision ? 'no production decision recorded for this game yet'
        : decision.eligible ? 'production policy selection (zero units: shadow ledger)' : decision.abstention_reason
    };
    outputs.push({ id: 'combined_decision', observed: coordinator.ready,
      forecast_residual: trace.final_prediction.forecast_residual, uncertainty: coordinator.uncertainty ?? null,
      authority: trace.authority, missing_reason: coordinator.ready ? null : (coordinator.reason ?? 'coordinator warmup incomplete'),
      detail: trace });
    for (const expert of outputs) {
      const result = run(`INSERT OR IGNORE INTO nfl_expert_forward_predictions
        (season,week,home,away,expert_id,horizon,council_version,engine_version,evidence_hash,evidence_cutoff,
         captured_at,market_margin,observed,forecast_residual,uncertainty,authority,missing_reason,payload_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, season, week, item.game.home, item.game.away, expert.id,
      String(horizon), EXPERT_COUNCIL_VERSION, item.game.engine_version, item.evidence_hash, item.game.evidence_cutoff,
      capturedAt, item.game.market_margin, expert.observed ? 1 : 0, expert.forecast_residual, expert.uncertainty,
      expert.authority, expert.missing_reason, JSON.stringify(expert.detail ?? {}));
      if (result.changes) inserted++; else existing++;
    }
  }
  return { version: EXPERT_COUNCIL_VERSION, season, week, horizon, games: targets.length, inserted, existing, skipped,
    errors: errors.length ? errors : undefined,
    coordinator_ready: coordinatorFit.ready,
    rule: 'Predictions are append-only and settlement cannot overwrite their evidence, timestamp or number.' };
}

export function settleForwardExpertPredictions() {
  const pending = rows(`SELECT p.*,g.team_score,g.opp_score FROM nfl_expert_forward_predictions p
    JOIN game_lines g ON g.season=p.season AND g.week=p.week AND g.team=p.home AND g.home=1
    LEFT JOIN nfl_expert_forward_settlements s ON s.prediction_id=p.id
    WHERE s.prediction_id IS NULL AND g.team_score IS NOT NULL AND g.opp_score IS NOT NULL`);
  let settled = 0;
  for (const prediction of pending) {
    const actualMargin = prediction.team_score - prediction.opp_score;
    const actualResidual = actualMargin - prediction.market_margin;
    const directional = Number.isFinite(prediction.forecast_residual) && Math.abs(prediction.forecast_residual) > 1e-9
      && Math.abs(actualResidual) > 1e-9 ? Math.sign(prediction.forecast_residual) === Math.sign(actualResidual) : null;
    run(`INSERT OR IGNORE INTO nfl_expert_forward_settlements
      (prediction_id,settled_at,actual_margin,actual_residual,directional_correct,squared_error)
      VALUES (?,datetime('now'),?,?,?,?)`, prediction.id, actualMargin, actualResidual,
    directional == null ? null : (directional ? 1 : 0), Number.isFinite(prediction.forecast_residual)
      ? r3((prediction.forecast_residual - actualResidual) ** 2) : null);
    settled++;
  }
  return { pending: pending.length, settled };
}

export function persistWeeklyExpertAudit(auditRunId, audit) {
  let inserted = 0;
  const now = new Date().toISOString();
  for (const item of audit.games) for (const expert of item.experts) {
    const result = run(`INSERT OR IGNORE INTO nfl_weekly_expert_examples
      (audit_run_id,season,week,home,away,expert_id,council_version,engine_version,evidence_hash,evidence_cutoff,
       observed,forecast_residual,uncertainty,actual_residual,directional_correct,squared_error,authority,missing_reason,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, auditRunId, audit.season, audit.week, item.game.home, item.game.away,
    expert.id, audit.version, item.game.engine_version, item.evidence_hash, item.game.evidence_cutoff, expert.observed ? 1 : 0,
    expert.forecast_residual, expert.uncertainty, item.game.actual_residual, expert.directional_correct == null ? null : (expert.directional_correct ? 1 : 0),
    expert.squared_error, expert.authority, expert.missing_reason, JSON.stringify(expert.detail ?? {}), now);
    inserted += result.changes;
  }
  for (const item of audit.games) {
    const coordinator = item.coordinator;
    const actual = item.game.actual_residual, forecast = coordinator.forecast_residual;
    const ready = Boolean(coordinator?.ready) && Number.isFinite(forecast);
    const directional = ready && Math.abs(forecast) > 1e-9 && Math.abs(actual) > 1e-9
      ? Math.sign(forecast) === Math.sign(actual) : null;
    const result = run(`INSERT OR IGNORE INTO nfl_weekly_expert_examples
      (audit_run_id,season,week,home,away,expert_id,council_version,engine_version,evidence_hash,evidence_cutoff,
       observed,forecast_residual,uncertainty,actual_residual,directional_correct,squared_error,authority,missing_reason,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, auditRunId, audit.season, audit.week, item.game.home, item.game.away,
    'coordinator', audit.version, item.game.engine_version, item.evidence_hash, item.game.evidence_cutoff, ready ? 1 : 0,
    ready ? forecast : null, ready ? coordinator.uncertainty : null, actual, directional == null ? null : (directional ? 1 : 0),
    ready ? r3((forecast - actual) ** 2) : null, coordinator?.authority ?? 'warmup_abstain',
    ready ? null : (coordinator?.reason ?? 'coordinator warmup incomplete'),
    JSON.stringify({ ...coordinator, decision_trace: item.combined_decision }), now);
    inserted += result.changes;
  }
  return { inserted };
}

export function expertLearningRows({ beforeSeason, beforeWeek } = {}) {
  if (!Number.isInteger(beforeSeason) || !Number.isInteger(beforeWeek)) throw new Error('training cutoff season and week are required');
  return rows(`SELECT * FROM nfl_weekly_expert_examples
    WHERE actual_residual IS NOT NULL AND (season<? OR (season=? AND week<?)) ORDER BY season,week,home,expert_id`,
  beforeSeason, beforeSeason, beforeWeek).map(row => ({ ...row, payload: JSON.parse(row.payload_json), payload_json: undefined }));
}

export function expertCouncilStatus() {
  const totals = rows(`SELECT COUNT(*) examples,COUNT(DISTINCT season||'-'||week) weeks,COUNT(DISTINCT home||'-'||season||'-'||week) games,
    MAX(created_at) latest FROM nfl_weekly_expert_examples`)[0];
  const aggregateRows = rows(`SELECT expert_id,COUNT(*) examples,SUM(observed) observed,
    SUM(CASE WHEN forecast_residual IS NOT NULL THEN 1 ELSE 0 END) forecasts,
    SUM(CASE WHEN observed=0 THEN 1 ELSE 0 END) missing,
    AVG(CASE WHEN directional_correct IS NOT NULL THEN directional_correct END) directional_rate,
    AVG(squared_error) mean_squared_error FROM nfl_weekly_expert_examples GROUP BY expert_id ORDER BY expert_id`);
  const aggregateById = new Map(aggregateRows.map(item => [item.expert_id, item]));
  const experts = NFL_EXPERTS.map(registry => reportingState(registry, aggregateById.get(registry.id)));
  const lifecycleRows = rows(`SELECT expert_id,payload_json FROM nfl_weekly_expert_examples
    WHERE observed=1 AND expert_id IN ('game_replay','player_opportunity')`);
  const lifecycle = new Map();
  for (const item of lifecycleRows) {
    let payload; try { payload = JSON.parse(item.payload_json || '{}'); } catch { continue; }
    const metric = item.expert_id === 'game_replay'
      ? { margin_mae: payload.settlement?.margin_absolute_error,
        total_mae: payload.settlement?.total_absolute_error,
        interval_hit: payload.settlement?.margin_80_interval_hit }
      : { player_volume_mae: payload.settlement?.player_volume_mae,
        team_volume_mae: payload.settlement?.team_volume_mae };
    const list = lifecycle.get(item.expert_id) ?? []; list.push(metric); lifecycle.set(item.expert_id, list);
  }
  for (const expert of experts) {
    const metrics = lifecycle.get(expert.expert_id) ?? [];
    if (expert.expert_id === 'game_replay') {
      expert.margin_mae = r3(mean(metrics.map(item => item.margin_mae).filter(Number.isFinite)));
      expert.total_mae = r3(mean(metrics.map(item => item.total_mae).filter(Number.isFinite)));
      const intervals = metrics.map(item => item.interval_hit).filter(value => value != null);
      expert.margin_80_interval_coverage = intervals.length ? r3(intervals.filter(Boolean).length / intervals.length) : null;
      expert.lifecycle_scored = metrics.filter(item => Number.isFinite(item.margin_mae)).length;
    } else if (expert.expert_id === 'player_opportunity') {
      expert.player_volume_mae = r3(mean(metrics.map(item => item.player_volume_mae).filter(Number.isFinite)));
      expert.team_volume_mae = r3(mean(metrics.map(item => item.team_volume_mae).filter(Number.isFinite)));
      expert.lifecycle_scored = metrics.filter(item => Number.isFinite(item.player_volume_mae)).length;
    }
  }
  const forward = rows(`SELECT COUNT(*) predictions,COUNT(DISTINCT season||'-'||week||'-'||home) games,
    SUM(CASE WHEN s.prediction_id IS NOT NULL THEN 1 ELSE 0 END) settled
    FROM nfl_expert_forward_predictions p LEFT JOIN nfl_expert_forward_settlements s ON s.prediction_id=p.id`)[0];
  const latestAuditRunId = rows('SELECT MAX(audit_run_id) id FROM nfl_weekly_expert_examples')[0]?.id ?? null;
  const recentRows = latestAuditRunId == null ? [] : rows(`SELECT season,week,home,away,expert_id,observed,
    forecast_residual,uncertainty,authority,missing_reason,directional_correct
    FROM nfl_weekly_expert_examples WHERE audit_run_id=?
      AND (season||'|'||week||'|'||home) IN (
        SELECT season||'|'||week||'|'||home FROM nfl_weekly_expert_examples
        WHERE audit_run_id=? GROUP BY season,week,home ORDER BY season DESC,week DESC,home LIMIT 16
      )
    ORDER BY season DESC,week DESC,home,expert_id`, latestAuditRunId, latestAuditRunId);
  const gameMap = new Map();
  for (const item of recentRows) {
    const key = `${item.season}|${item.week}|${item.home}`;
    const game = gameMap.get(key) ?? { season: item.season, week: item.week, home: item.home,
      away: item.away, rows: new Map() };
    game.rows.set(item.expert_id, item); gameMap.set(key, game);
  }
  const matrixGames = [...gameMap.values()].map(game => ({ season: game.season, week: game.week,
    home: game.home, away: game.away,
    specialists: NFL_EXPERTS.map(registry => matrixCell(registry, game.rows.get(registry.id))) }));
  const reporting = { specialists: NFL_EXPERTS.length,
    observed_outputs: experts.filter(item => item.observed > 0).length,
    forecasting: experts.filter(item => item.forecasts > 0).length,
    not_run: experts.filter(item => item.reporting_state === 'not_run').length,
    zero_coverage: experts.filter(item => item.reporting_state === 'zero_coverage').length,
    different_lifecycle_or_score: experts.filter(item => ['different_lifecycle', 'different_score', 'support_only']
      .includes(item.reporting_state)).length,
    rule: 'Observed support, numeric forecasts, execution outputs, lifecycle differences and missing rows are counted separately.' };
  return { version: EXPERT_COUNCIL_VERSION, registry: NFL_EXPERTS, examples: Number(totals?.examples ?? 0),
    weeks: Number(totals?.weeks ?? 0), games: Number(totals?.games ?? 0), latest: totals?.latest ?? null, experts,
    reporting, matrix: { audit_run_id: latestAuditRunId, games: matrixGames },
    forward: { predictions: Number(forward?.predictions ?? 0), games: Number(forward?.games ?? 0), settled: Number(forward?.settled ?? 0) },
    connection: 'blind audit → immutable weekly expert rows → cutoff-filtered learning dataset → candidate evaluation' };
}

export function expertCouncilGame(season, week, home) {
  const predictions = rows(`SELECT p.*,s.actual_residual,s.directional_correct,s.squared_error
    FROM nfl_expert_forward_predictions p
    LEFT JOIN nfl_expert_forward_settlements s ON s.prediction_id=p.id
    WHERE p.season=? AND p.week=? AND p.home=?
      AND p.captured_at=(SELECT MAX(q.captured_at) FROM nfl_expert_forward_predictions q
        WHERE q.season=p.season AND q.week=p.week AND q.home=p.home AND q.expert_id=p.expert_id)
    ORDER BY p.expert_id`, season, week, String(home).toUpperCase());
  if (!predictions.length) return { available: false, season, week, home,
    reason: 'No pre-kickoff council horizon has been frozen for this game.' };
  const combinedRow = predictions.find(row => row.expert_id === 'combined_decision') ?? null;
  let combined = null;
  if (combinedRow) {
    try { combined = JSON.parse(combinedRow.payload_json || 'null'); } catch { combined = null; }
    if (combined) combined.settlement = { ...(combined.settlement ?? {}),
      actual_residual: combinedRow.actual_residual ?? combined.settlement?.actual_residual ?? null,
      directional_correct: combinedRow.directional_correct == null ? (combined.settlement?.directional_correct ?? null)
        : Boolean(combinedRow.directional_correct),
      squared_error: combinedRow.squared_error ?? null };
  }
  return { available: true, version: EXPERT_COUNCIL_VERSION, season, week, home,
    captured_at: predictions.reduce((latest, row) => !latest || row.captured_at > latest ? row.captured_at : latest, null),
    combined_decision: combined ?? { state: 'not_recorded',
      reason: 'captured before combined-decision rows existed; the next horizon capture records one' },
    experts: predictions.filter(row => row.expert_id !== 'combined_decision').map(row => ({ id: row.expert_id, horizon: row.horizon, observed: Boolean(row.observed),
      forecast_residual: row.forecast_residual, uncertainty: row.uncertainty, authority: row.authority,
      missing_reason: row.missing_reason, actual_residual: row.actual_residual,
      directional_correct: row.directional_correct == null ? null : Boolean(row.directional_correct) })),
    authority: 'candidate evidence only; the production number and staking policy are unchanged' };
}

export const __test = { analogPrediction, output, reportingState, matrixCell, combinedDecisionTrace,
  movementFor, newsFor, shoppingFor, opportunityFor };
