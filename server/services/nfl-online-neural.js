/**
 * Persistent, leak-proof online neural challengers.
 *
 * The first active head learns the part of final margin the closing spread did
 * not explain.  The network sees a game only through a feature vector frozen
 * before kickoff, scores an entire completed week with the old weights, and
 * only then updates.  That prequential order is the difference between an
 * online learner and a backtest that accidentally teaches on its own answers.
 *
 * The storage and network code are head-agnostic. Totals, player usage, injury
 * recovery and props can use the same lifecycle once each has an explicit
 * target builder and its own forward promotion gate.
 */
import crypto from 'node:crypto';
import { db, row, rows, run } from '../db/index.js';
import { nflKickoffDate } from './date-util.js';
import { ensembleLine } from './nfl-ensemble.js';

export const ONLINE_NEURAL_SCHEMA = 'nfl-online-neural-features-v1';
export const ONLINE_NEURAL_HEADS = Object.freeze({
  spread_residual: {
    state: 'active_shadow', target: 'actual home margin minus pregame market margin',
    output_bound: 7, promotion_sample: 128, promotion_weeks: 8
  },
  total_residual: { state: 'scaffolded', target: 'actual total minus pregame market total' },
  injury_impact: { state: 'scaffolded', target: 'observed unit drop after availability change' },
  player_usage: { state: 'scaffolded', target: 'next-week opportunity share by player' },
  player_props: { state: 'scaffolded', target: 'market-specific player result residual' }
});

const HEAD = 'spread_residual';
const FAMILIES = ['Roster availability', 'Rating systems', 'Efficiency', 'Context', 'Market'];
const HIDDEN = 10;
const OUTPUT_BOUND = 7;
const r3 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(3);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const parse = (value, fallback = null) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_online_neural_examples (
    season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
    head TEXT NOT NULL, horizon TEXT NOT NULL, captured_at TEXT NOT NULL, kickoff_at TEXT,
    schema_version TEXT NOT NULL, model_version TEXT NOT NULL, feature_hash TEXT NOT NULL,
    features_json TEXT NOT NULL, market_margin REAL NOT NULL, market_total REAL,
    prediction_residual REAL NOT NULL, predicted_margin REAL NOT NULL,
    actual_margin REAL, target_residual REAL, settled_at TEXT, trained_at TEXT,
    selected_for_training INTEGER,
    PRIMARY KEY (season,week,home,head,horizon)
  );
  CREATE INDEX IF NOT EXISTS idx_online_neural_training
    ON nfl_online_neural_examples(head,trained_at,season,week);
  CREATE TABLE IF NOT EXISTS nfl_online_neural_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, head TEXT NOT NULL, version TEXT NOT NULL UNIQUE,
    parent_version TEXT, schema_version TEXT NOT NULL, created_at TEXT NOT NULL,
    trained_through_season INTEGER, trained_through_week INTEGER,
    state_json TEXT NOT NULL, state_hash TEXT NOT NULL, metrics_json TEXT,
    UNIQUE(head,trained_through_season,trained_through_week)
  );
`);

function seeded(seed = 0x51f15e) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

export function createNetwork(inputSize, seed = 0x51f15e) {
  const random = seeded(seed);
  const scale = Math.sqrt(2 / Math.max(1, inputSize));
  return {
    input_size: inputSize, hidden_size: HIDDEN,
    w1: Array.from({ length: HIDDEN }, () => Array.from({ length: inputSize }, () => (random() * 2 - 1) * scale)),
    b1: Array(HIDDEN).fill(0),
    // Zero output is intentional: an untrained residual head exactly equals
    // the market instead of inventing a cold-start betting edge.
    w2: Array(HIDDEN).fill(0), b2: 0, updates: 0, examples_seen: 0
  };
}

function forward(network, input) {
  const hidden = network.w1.map((weights, j) => Math.tanh(
    weights.reduce((sum, weight, i) => sum + weight * (input[i] ?? 0), network.b1[j])));
  const z = network.w2.reduce((sum, weight, j) => sum + weight * hidden[j], network.b2);
  return { hidden, z, output: OUTPUT_BOUND * Math.tanh(z) };
}

export function predictNetwork(network, input) {
  if (!network || input.length !== network.input_size) throw new Error('online neural feature dimension mismatch');
  return forward(network, input).output;
}

/** Full-batch weekly SGD with replay. Every gradient is computed from one
 * unchanged state before an epoch update, so row order cannot leak information. */
export function trainBatch(source, examples, { epochs = 20, learningRate = 0.012, l2 = 0.0005 } = {}) {
  const network = structuredClone(source);
  if (!examples.length) return network;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw1 = network.w1.map(rowWeights => rowWeights.map(() => 0));
    const gb1 = network.b1.map(() => 0), gw2 = network.w2.map(() => 0);
    let gb2 = 0;
    for (const example of examples) {
      const { hidden, z, output } = forward(network, example.input);
      const error = output - clamp(example.target, -OUTPUT_BOUND, OUTPUT_BOUND);
      const huberGradient = Math.abs(error) <= 3 ? error : 3 * Math.sign(error);
      const dz = huberGradient * OUTPUT_BOUND * (1 - Math.tanh(z) ** 2);
      for (let j = 0; j < network.hidden_size; j++) {
        gw2[j] += dz * hidden[j];
        const dh = dz * network.w2[j] * (1 - hidden[j] ** 2);
        gb1[j] += dh;
        for (let i = 0; i < network.input_size; i++) gw1[j][i] += dh * example.input[i];
      }
      gb2 += dz;
    }
    const n = examples.length;
    for (let j = 0; j < network.hidden_size; j++) {
      network.w2[j] -= learningRate * (gw2[j] / n + l2 * network.w2[j]);
      network.b1[j] -= learningRate * gb1[j] / n;
      for (let i = 0; i < network.input_size; i++) {
        network.w1[j][i] -= learningRate * (gw1[j][i] / n + l2 * network.w1[j][i]);
      }
    }
    network.b2 -= learningRate * gb2 / n;
  }
  network.updates += 1;
  network.examples_seen += examples.length;
  return network;
}

const scaled = (value, center, scale, missing = 0) => Number.isFinite(value)
  ? clamp((value - center) / scale, -3, 3) : missing;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const deviation = values => values.length > 1
  ? Math.sqrt(mean(values.map(value => (value - mean(values)) ** 2))) : 0;

export function spreadFeatureVector(line) {
  const ensemble = line.ensemble;
  const marketMargin = ensemble.market_spread == null ? null : -ensemble.market_spread;
  if (!Number.isFinite(marketMargin)) return null;
  const values = [], names = [];
  const add = (name, value) => { names.push(name); values.push(r3(value)); };
  add('market_margin_scaled', scaled(marketMargin, 0, 10));
  add('market_total_scaled', scaled(ensemble.market_total, 44, 14));
  add('ensemble_edge_scaled', scaled(ensemble.projected_margin - marketMargin, 0, 7));
  add('model_disagreement_scaled', scaled(ensemble.model_disagreement_margin, 4, 5));
  for (const family of FAMILIES) {
    const residuals = line.models.filter(model => model.family === family && Number.isFinite(model.margin))
      .map(model => model.margin - marketMargin);
    const slug = family.toLowerCase().replaceAll(' ', '_');
    add(`${slug}_mean_residual`, scaled(mean(residuals), 0, 8));
    add(`${slug}_dispersion`, scaled(deviation(residuals), 0, 6));
    add(`${slug}_coverage`, clamp(residuals.length / 10, 0, 1));
  }
  const availability = ensemble.player_availability;
  add('roster_margin_adjustment', scaled(availability?.shadow_margin_adjustment, 0, 4));
  for (const unit of ['offense', 'defense', 'special_teams']) {
    add(`roster_${unit}_edge`, scaled(availability?.unit_edges?.[unit], 0, unit === 'special_teams' ? 0.8 : 2));
  }
  add('home_snap_coverage', availability?.home?.coverage?.prior_snap_match_rate ?? 0);
  add('away_snap_coverage', availability?.away?.coverage?.prior_snap_match_rate ?? 0);
  add('home_replacement_coverage', availability?.home?.coverage?.replacement_match_rate ?? 0);
  add('away_replacement_coverage', availability?.away?.coverage?.replacement_match_rate ?? 0);
  return { names, values, market_margin: marketMargin, market_total: ensemble.market_total ?? null };
}

function latestArtifact() {
  const artifact = row(`SELECT * FROM nfl_online_neural_artifacts WHERE head=? ORDER BY id DESC LIMIT 1`, HEAD);
  return artifact ? { ...artifact, state: parse(artifact.state_json), metrics: parse(artifact.metrics_json, {}) } : null;
}

function activeNetwork(inputSize) {
  const artifact = latestArtifact();
  if (artifact?.schema_version === ONLINE_NEURAL_SCHEMA && artifact.state?.input_size === inputSize) {
    return { network: artifact.state, version: artifact.version };
  }
  return { network: createNetwork(inputSize), version: 'online-spread-v1-cold-start' };
}

function kickoff(game) {
  return game.gameday ? nflKickoffDate(game.gameday, game.gametime || '23:59') : null;
}

/** Freeze one prediction per requested evidence horizon. Existing rows are
 * immutable; later captures create another horizon rather than rewriting it. */
export function captureOnlineNeuralWeek(season, week, { horizons = ['manual'] } = {}) {
  const games = rows(`SELECT team home,opponent away,gameday,gametime FROM game_lines
    WHERE season=? AND week=? AND home=1 AND team_score IS NULL AND spread IS NOT NULL`, season, week);
  const capturedAt = new Date().toISOString();
  let captured = 0, existing = 0, skipped = 0;
  for (const game of games) {
    const at = kickoff(game);
    if (at && at.getTime() <= Date.now()) { skipped++; continue; }
    const line = ensembleLine(season, week, game.home, game.away, { includeEvidence: true });
    if (line.error) { skipped++; continue; }
    const features = spreadFeatureVector(line);
    if (!features) { skipped++; continue; }
    const active = activeNetwork(features.values.length);
    const residual = predictNetwork(active.network, features.values);
    const payload = { schema: ONLINE_NEURAL_SCHEMA, names: features.names, values: features.values };
    for (const horizon of [...new Set(horizons.map(value => String(value)))]) {
      const result = run(`INSERT OR IGNORE INTO nfl_online_neural_examples
        (season,week,home,away,head,horizon,captured_at,kickoff_at,schema_version,model_version,
         feature_hash,features_json,market_margin,market_total,prediction_residual,predicted_margin)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, season, week, game.home, game.away, HEAD, horizon,
      capturedAt, at?.toISOString() ?? null, ONLINE_NEURAL_SCHEMA, active.version, hash(payload), JSON.stringify(payload),
      features.market_margin, features.market_total, r3(residual), r3(features.market_margin + residual));
      if (result.changes) captured++; else existing++;
    }
  }
  return { head: HEAD, season, week, games: games.length, captured, existing, skipped,
    rule: 'Each horizon is immutable and every prediction uses only the network artifact available before kickoff.' };
}

export function settleOnlineNeuralExamples() {
  const due = rows(`SELECT e.season,e.week,e.home,g.team_score,g.opp_score,e.market_margin
    FROM nfl_online_neural_examples e JOIN game_lines g
      ON g.season=e.season AND g.week=e.week AND g.team=e.home AND g.home=1
    WHERE e.head=? AND e.settled_at IS NULL AND g.team_score IS NOT NULL AND g.opp_score IS NOT NULL`, HEAD);
  const settledAt = new Date().toISOString();
  let settled = 0;
  for (const item of due) {
    const actual = item.team_score - item.opp_score;
    const result = run(`UPDATE nfl_online_neural_examples SET actual_margin=?,target_residual=?,settled_at=?
      WHERE head=? AND season=? AND week=? AND home=? AND settled_at IS NULL`,
    actual, actual - item.market_margin, settledAt, HEAD, item.season, item.week, item.home);
    settled += result.changes;
  }
  return { settled };
}

function selectedExamples(records) {
  const horizonRank = new Map([['close', 6], ['T-15m', 5], ['T-60m', 4], ['T-6h', 3], ['T-24h', 2], ['open', 1], ['manual', 0]]);
  const best = new Map();
  for (const record of records) {
    const key = `${record.season}|${record.week}|${record.home}`;
    const prior = best.get(key);
    if (!prior || record.captured_at > prior.captured_at
      || (record.captured_at === prior.captured_at
        && (horizonRank.get(record.horizon) ?? -1) > (horizonRank.get(prior.horizon) ?? -1))) best.set(key, record);
  }
  return [...best.values()];
}

function completeWeek(season, week) {
  const counts = row(`SELECT COUNT(*) scheduled,SUM(team_score IS NOT NULL AND opp_score IS NOT NULL) final
    FROM game_lines WHERE season=? AND week=? AND home=1`, season, week);
  return Number(counts?.scheduled) > 0 && Number(counts.final) === Number(counts.scheduled);
}

function performanceMetrics() {
  const examples = rows(`SELECT season,week,market_margin,predicted_margin,actual_margin
    FROM nfl_online_neural_examples WHERE head=? AND selected_for_training=1 AND actual_margin IS NOT NULL
    ORDER BY season,week`, HEAD);
  const weekly = new Map();
  for (const item of examples) {
    const marketError = Math.abs(item.actual_margin - item.market_margin);
    const neuralError = Math.abs(item.actual_margin - item.predicted_margin);
    const key = `${item.season}|${item.week}`;
    const bucket = weekly.get(key) ?? [];
    bucket.push(marketError - neuralError); weekly.set(key, bucket);
  }
  const improvements = [...weekly.values()].map(mean);
  const improvement = improvements.length ? mean(improvements) : null;
  const sd = improvements.length > 1 ? Math.sqrt(improvements.reduce((sum, value) => sum + (value - improvement) ** 2, 0) / (improvements.length - 1)) : null;
  const half = sd == null ? null : 1.645 * sd / Math.sqrt(improvements.length);
  const marketMae = examples.length ? mean(examples.map(x => Math.abs(x.actual_margin - x.market_margin))) : null;
  const neuralMae = examples.length ? mean(examples.map(x => Math.abs(x.actual_margin - x.predicted_margin))) : null;
  const interval = half == null ? null : [r3(improvement - half), r3(improvement + half)];
  const eligible = examples.length >= ONLINE_NEURAL_HEADS[HEAD].promotion_sample
    && improvements.length >= ONLINE_NEURAL_HEADS[HEAD].promotion_weeks
    && interval?.[0] > 0;
  return { examples: examples.length, weeks: improvements.length, market_mae: r3(marketMae), neural_mae: r3(neuralMae),
    mae_improvement: r3(improvement), weekly_clustered_improvement_ci90: interval,
    production_eligible: Boolean(eligible) };
}

/** Train complete, settled weeks in chronological order. The latest capture per
 * game is selected; all predictions for that week already came from old state. */
export function trainOnlineNeuralThroughSettled() {
  const pending = rows(`SELECT * FROM nfl_online_neural_examples
    WHERE head=? AND settled_at IS NOT NULL AND trained_at IS NULL ORDER BY season,week,captured_at`, HEAD);
  const weekKeys = [...new Set(pending.map(item => `${item.season}|${item.week}`))];
  const trained = [];
  for (const key of weekKeys) {
    const [season, week] = key.split('|').map(Number);
    if (!completeWeek(season, week)) continue;
    const current = selectedExamples(pending.filter(item => item.season === season && item.week === week));
    if (!current.length) continue;
    const decoded = current.map(item => ({ record: item, payload: parse(item.features_json) }))
      .filter(item => item.payload?.schema === ONLINE_NEURAL_SCHEMA && Array.isArray(item.payload.values));
    if (!decoded.length) continue;
    const active = activeNetwork(decoded[0].payload.values.length);
    // Replay controls forgetting without allowing future examples into this update.
    const replay = rows(`SELECT features_json,target_residual FROM nfl_online_neural_examples
      WHERE head=? AND selected_for_training=1 AND trained_at IS NOT NULL
        AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC LIMIT 512`, HEAD, season, season, week)
      .map(item => ({ payload: parse(item.features_json), target: item.target_residual }))
      .filter(item => item.payload?.schema === ONLINE_NEURAL_SCHEMA);
    const batch = [...replay.map(item => ({ input: item.payload.values, target: item.target })),
      ...decoded.map(item => ({ input: item.payload.values, target: item.record.target_residual }))];
    const next = trainBatch(active.network, batch);
    const createdAt = new Date().toISOString();
    const stateHash = hash(next);
    const version = `online-spread-v1-s${season}w${week}-${stateHash.slice(0, 10)}`;
    const metrics = performanceMetrics();
    run(`INSERT OR IGNORE INTO nfl_online_neural_artifacts
      (head,version,parent_version,schema_version,created_at,trained_through_season,trained_through_week,state_json,state_hash,metrics_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, HEAD, version, active.version, ONLINE_NEURAL_SCHEMA, createdAt,
    season, week, JSON.stringify(next), stateHash, JSON.stringify(metrics));
    for (const record of pending.filter(item => item.season === season && item.week === week)) {
      const chosen = current.some(item => item.home === record.home && item.horizon === record.horizon);
      run(`UPDATE nfl_online_neural_examples SET trained_at=?,selected_for_training=?
        WHERE head=? AND season=? AND week=? AND home=? AND horizon=?`, createdAt, chosen ? 1 : 0,
      HEAD, season, week, record.home, record.horizon);
    }
    trained.push({ season, week, examples: decoded.length, replay: replay.length, version });
  }
  return { head: HEAD, weeks_trained: trained.length, trained, status: nflOnlineNeuralStatus() };
}

export function nflOnlineNeuralStatus() {
  const artifact = latestArtifact();
  const counts = row(`SELECT COUNT(*) captured,SUM(settled_at IS NOT NULL) settled,
    SUM(selected_for_training=1) trained,COUNT(DISTINCT CASE WHEN selected_for_training=1 THEN season||'|'||week END) trained_weeks
    FROM nfl_online_neural_examples WHERE head=?`, HEAD) ?? {};
  const metrics = performanceMetrics();
  return {
    head: HEAD, mode: 'online_prequential_shadow', schema_version: ONLINE_NEURAL_SCHEMA,
    architecture: `27 inputs → ${HIDDEN} tanh units → bounded market-residual output`,
    active_version: artifact?.version ?? 'online-spread-v1-cold-start',
    trained_through: artifact ? { season: artifact.trained_through_season, week: artifact.trained_through_week } : null,
    captured: Number(counts.captured ?? 0), settled: Number(counts.settled ?? 0),
    trained: Number(counts.trained ?? 0), trained_weeks: Number(counts.trained_weeks ?? 0),
    metrics,
    heads: ONLINE_NEURAL_HEADS,
    input_groups: [
      { id: 'market_state', fields: 2, sources: ['game_lines'], purpose: 'spread and total baseline' },
      { id: 'ensemble_residuals', fields: 17, sources: ['team play-by-play', 'ratings', 'weather', 'rest', 'market'], purpose: 'nonlinear disagreement and family interactions' },
      { id: 'roster_units', fields: 4, sources: ['injuries', 'depth charts', 'offense/defense snaps', 'PFR charting', 'Next Gen tracking'], purpose: 'starter-to-replacement loss by unit' },
      { id: 'evidence_coverage', fields: 4, sources: ['pregame snapshots'], purpose: 'teach missingness instead of treating unknown as healthy' }
    ],
    production_eligible: metrics.production_eligible,
    staking_authority: '0 units until the forward weekly-clustered promotion gate passes',
    learning_rule: 'Freeze every pregame vector; score the complete week; update afterward with bounded replay; never train one game before predicting another in the same week.'
  };
}

export const __test = { selectedExamples, performanceMetrics };
