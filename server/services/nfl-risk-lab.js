/**
 * High-variance research models for the restricted NFL challenger pool.
 *
 * These are intentionally more ambitious than the champion: a deep ensemble,
 * an uncertainty-aware Bayesian online regressor, and a contextual
 * mixture-of-experts over every model family. They receive frozen pregame
 * vectors, score a complete week, then update. None has betting authority.
 */
import crypto from 'node:crypto';
import { db, row, rows, run } from '../db/index.js';
import { activeLearningEpoch } from './nfl-engine-registry.js';

export const RISK_LAB_SCHEMA = 'nfl-risk-lab-v1';
export const RISK_MODELS = Object.freeze({
  deep_ensemble: {
    label: 'Deep residual ensemble', technology: 'five independently initialized 35→24→12→1 networks',
    advantage: 'epistemic disagreement and nonlinear interaction discovery'
  },
  bayesian_online: {
    label: 'Bayesian online residual', technology: 'recursive posterior with predictive uncertainty',
    advantage: 'fast adaptation with explicit uncertainty and shrinkage to the market'
  },
  contextual_moe: {
    label: 'Contextual mixture of experts', technology: 'softmax regime gate over restricted model families',
    advantage: 'learns when a failed standalone family is conditionally useful'
  }
});
const MODEL_IDS = Object.keys(RISK_MODELS);
const OUTPUT_BOUND = 7;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = (value, fallback = null) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const sd = values => values.length > 1
  ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean(values)) ** 2, 0) / values.length) : 0;
const r3 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(3);

function seeded(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296; };
}

function createDeepNetwork(inputSize, seed) {
  const random = seeded(seed), h1 = 24, h2 = 12;
  const matrix = (rowsCount, columns, scale) => Array.from({ length: rowsCount }, () =>
    Array.from({ length: columns }, () => (random() * 2 - 1) * scale));
  return { input_size: inputSize, hidden_1: h1, hidden_2: h2,
    w1: matrix(h1, inputSize, Math.sqrt(2 / inputSize)), b1: Array(h1).fill(0),
    w2: matrix(h2, h1, Math.sqrt(2 / h1)), b2: Array(h2).fill(0),
    w3: Array(h2).fill(0), b3: 0, updates: 0, examples_seen: 0 };
}

function deepForward(network, input) {
  const h1 = network.w1.map((weights, j) => Math.tanh(dot(weights, input) + network.b1[j]));
  const h2 = network.w2.map((weights, j) => Math.tanh(dot(weights, h1) + network.b2[j]));
  const z = dot(network.w3, h2) + network.b3;
  return { h1, h2, z, output: OUTPUT_BOUND * Math.tanh(z) };
}

function trainDeepBatch(source, examples, { epochs = 24, learningRate = 0.008, l2 = 0.0008 } = {}) {
  const network = structuredClone(source);
  if (!examples.length) return network;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gw1 = network.w1.map(weights => weights.map(() => 0));
    const gb1 = network.b1.map(() => 0);
    const gw2 = network.w2.map(weights => weights.map(() => 0));
    const gb2 = network.b2.map(() => 0), gw3 = network.w3.map(() => 0);
    let gb3 = 0;
    for (const example of examples) {
      const { h1, h2, z, output } = deepForward(network, example.payload.values);
      const error = output - clamp(example.target, -OUTPUT_BOUND, OUTPUT_BOUND);
      const dz = (Math.abs(error) <= 3 ? error : 3 * Math.sign(error))
        * OUTPUT_BOUND * (1 - Math.tanh(z) ** 2);
      const dh2 = h2.map((value, j) => dz * network.w3[j] * (1 - value ** 2));
      const dh1 = h1.map((value, k) => network.w2.reduce((sum, weights, j) =>
        sum + dh2[j] * weights[k], 0) * (1 - value ** 2));
      for (let j = 0; j < network.hidden_2; j++) {
        gw3[j] += dz * h2[j]; gb2[j] += dh2[j];
        for (let k = 0; k < network.hidden_1; k++) gw2[j][k] += dh2[j] * h1[k];
      }
      gb3 += dz;
      for (let j = 0; j < network.hidden_1; j++) {
        gb1[j] += dh1[j];
        for (let i = 0; i < network.input_size; i++) gw1[j][i] += dh1[j] * example.payload.values[i];
      }
    }
    const n = examples.length;
    for (let j = 0; j < network.hidden_2; j++) {
      network.w3[j] -= learningRate * (gw3[j] / n + l2 * network.w3[j]);
      network.b2[j] -= learningRate * gb2[j] / n;
      for (let k = 0; k < network.hidden_1; k++) {
        network.w2[j][k] -= learningRate * (gw2[j][k] / n + l2 * network.w2[j][k]);
      }
    }
    network.b3 -= learningRate * gb3 / n;
    for (let j = 0; j < network.hidden_1; j++) {
      network.b1[j] -= learningRate * gb1[j] / n;
      for (let i = 0; i < network.input_size; i++) {
        network.w1[j][i] -= learningRate * (gw1[j][i] / n + l2 * network.w1[j][i]);
      }
    }
  }
  network.updates += 1; network.examples_seen += examples.length;
  return network;
}

db.exec(`CREATE TABLE IF NOT EXISTS nfl_risk_lab_predictions (
  season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
  horizon TEXT NOT NULL, model_id TEXT NOT NULL, epoch_id INTEGER NOT NULL,
  captured_at TEXT NOT NULL, engine_version TEXT, feature_hash TEXT NOT NULL,
  features_json TEXT NOT NULL, market_margin REAL NOT NULL,
  predicted_residual REAL NOT NULL, predicted_uncertainty REAL,
  actual_margin REAL, target_residual REAL, settled_at TEXT, trained_at TEXT,
  selected_for_training INTEGER,
  PRIMARY KEY(season,week,home,horizon,model_id,epoch_id)
);
CREATE INDEX IF NOT EXISTS idx_risk_lab_training
  ON nfl_risk_lab_predictions(epoch_id,model_id,trained_at,season,week);
CREATE TABLE IF NOT EXISTS nfl_risk_lab_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, model_id TEXT NOT NULL, epoch_id INTEGER NOT NULL,
  version TEXT NOT NULL UNIQUE, parent_version TEXT, schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL, trained_through_season INTEGER, trained_through_week INTEGER,
  state_json TEXT NOT NULL, state_hash TEXT NOT NULL, metrics_json TEXT,
  UNIQUE(model_id,epoch_id,trained_through_season,trained_through_week)
);
`);

function coldState(modelId, inputSize) {
  if (modelId === 'deep_ensemble') {
    return { input_size: inputSize, networks: [11, 29, 47, 71, 101].map(seed => createDeepNetwork(inputSize, seed)) };
  }
  if (modelId === 'bayesian_online') {
    return { input_size: inputSize, weights: Array(inputSize).fill(0), precision: Array(inputSize).fill(1),
      noise_variance: 25, updates: 0, examples_seen: 0 };
  }
  return { input_size: inputSize, gate: null, expert_names: null, updates: 0, examples_seen: 0 };
}

function latestArtifact(modelId) {
  const epochId = activeLearningEpoch()?.id ?? 1;
  const artifact = row(`SELECT * FROM nfl_risk_lab_artifacts
    WHERE model_id=? AND epoch_id=? ORDER BY id DESC LIMIT 1`, modelId, epochId);
  return artifact ? { ...artifact, state: parse(artifact.state_json), metrics: parse(artifact.metrics_json, {}) } : null;
}

function activeState(modelId, inputSize) {
  const artifact = latestArtifact(modelId);
  return artifact?.state?.input_size === inputSize
    ? { state: artifact.state, version: artifact.version }
    : { state: coldState(modelId, inputSize), version: `${modelId}-cold-start` };
}

function dot(a, b) { return a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0); }
function softmax(logits) {
  const high = Math.max(...logits), raw = logits.map(value => Math.exp(value - high));
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map(value => value / total);
}

function expertPacket(payload) {
  const index = new Map(payload.names.map((name, i) => [name, i]));
  const familyNames = payload.names.filter(name => name.endsWith('_mean_residual'));
  const experts = [0,
    (payload.values[index.get('ensemble_edge_scaled')] ?? 0) * 7,
    ...familyNames.map(name => (payload.values[index.get(name)] ?? 0) * 8)].map(value => clamp(value, -OUTPUT_BOUND, OUTPUT_BOUND));
  const contextNames = ['bias', 'market_margin_scaled', 'market_total_scaled',
    'model_disagreement_scaled', 'roster_margin_adjustment'];
  const context = [1, ...contextNames.slice(1).map(name => payload.values[index.get(name)] ?? 0)];
  return { experts, context, expert_names: ['market_zero', 'guarded_ensemble', ...familyNames] };
}

export function predictRiskModel(modelId, state, payload) {
  const input = payload.values;
  if (modelId === 'deep_ensemble') {
    const predictions = state.networks.map(network => deepForward(network, input).output);
    return { residual: clamp(mean(predictions), -OUTPUT_BOUND, OUTPUT_BOUND),
      uncertainty: Math.max(1, sd(predictions)), detail: { members: predictions.map(r3) } };
  }
  if (modelId === 'bayesian_online') {
    const residual = clamp(dot(state.weights, input), -OUTPUT_BOUND, OUTPUT_BOUND);
    const variance = state.noise_variance + input.reduce((sum, value, i) =>
      sum + value ** 2 / Math.max(state.precision[i], 1e-6), 0);
    return { residual, uncertainty: Math.sqrt(variance), detail: { posterior: 'diagonal recursive Gaussian' } };
  }
  const packet = expertPacket(payload);
  if (!state.gate || state.gate.length !== packet.experts.length) {
    state = { ...state, gate: packet.experts.map(() => Array(packet.context.length).fill(0)),
      expert_names: packet.expert_names };
  }
  const weights = softmax(state.gate.map(gate => dot(gate, packet.context)));
  const residual = clamp(dot(weights, packet.experts), -OUTPUT_BOUND, OUTPUT_BOUND);
  const uncertainty = Math.sqrt(packet.experts.reduce((sum, value, i) =>
    sum + weights[i] * (value - residual) ** 2, 0));
  return { residual, uncertainty, detail: { expert_names: packet.expert_names, weights: weights.map(r3) } };
}

function trainBayesian(source, examples) {
  const state = structuredClone(source);
  for (const example of examples) {
    const x = example.payload.values, target = clamp(example.target, -OUTPUT_BOUND, OUTPUT_BOUND);
    const prediction = dot(state.weights, x);
    const predictiveVariance = state.noise_variance + x.reduce((sum, value, i) =>
      sum + value ** 2 / Math.max(state.precision[i], 1e-6), 0);
    const error = target - prediction;
    for (let i = 0; i < x.length; i++) {
      const priorVariance = 1 / Math.max(state.precision[i], 1e-6);
      state.weights[i] += priorVariance * x[i] / predictiveVariance * error;
      state.precision[i] += x[i] ** 2 / Math.max(state.noise_variance, 1);
    }
    state.noise_variance = clamp(0.98 * state.noise_variance + 0.02 * error ** 2, 4, 100);
  }
  state.updates += 1; state.examples_seen += examples.length;
  return state;
}

function trainMoe(source, examples, epochs = 25, learningRate = 0.02) {
  let state = structuredClone(source);
  const first = expertPacket(examples[0].payload);
  if (!state.gate || state.gate.length !== first.experts.length) {
    state.gate = first.experts.map(() => Array(first.context.length).fill(0));
    state.expert_names = first.expert_names;
  }
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = state.gate.map(gate => gate.map(() => 0));
    for (const example of examples) {
      const packet = expertPacket(example.payload);
      const weights = softmax(state.gate.map(gate => dot(gate, packet.context)));
      const prediction = dot(weights, packet.experts);
      const error = clamp(prediction - example.target, -4, 4);
      for (let j = 0; j < weights.length; j++) {
        const dLogit = error * weights[j] * (packet.experts[j] - prediction);
        for (let k = 0; k < packet.context.length; k++) gradient[j][k] += dLogit * packet.context[k];
      }
    }
    for (let j = 0; j < state.gate.length; j++) for (let k = 0; k < state.gate[j].length; k++) {
      state.gate[j][k] -= learningRate * gradient[j][k] / examples.length;
    }
  }
  state.updates += 1; state.examples_seen += examples.length;
  return state;
}

export function trainRiskState(modelId, source, examples) {
  if (!examples.length) return structuredClone(source);
  if (modelId === 'deep_ensemble') {
    const state = structuredClone(source);
    state.networks = state.networks.map((network, member) => trainDeepBatch(network,
      examples.filter((_example, index) => (index + member) % 5 !== 0),
      { epochs: 24, learningRate: 0.008, l2: 0.0008 }));
    return state;
  }
  if (modelId === 'bayesian_online') return trainBayesian(source, examples);
  return trainMoe(source, examples);
}

/** Capture challenger predictions from the same immutable vectors as the
 * conservative online head. Call immediately after captureOnlineNeuralWeek. */
export function captureRiskLabWeek(season, week, { horizons = null } = {}) {
  const epochId = activeLearningEpoch()?.id ?? 1;
  const requested = horizons?.length ? new Set(horizons.map(String)) : null;
  const source = rows(`SELECT * FROM nfl_online_neural_examples
    WHERE season=? AND week=? AND epoch_id=? ORDER BY captured_at,horizon`, season, week, epochId)
    .filter(item => !requested || requested.has(item.horizon));
  let captured = 0, existing = 0, skipped = 0;
  for (const item of source) {
    const payload = parse(item.features_json);
    if (!Array.isArray(payload?.values) || !Array.isArray(payload?.names)) { skipped++; continue; }
    for (const modelId of MODEL_IDS) {
      const active = activeState(modelId, payload.values.length);
      const prediction = predictRiskModel(modelId, active.state, payload);
      const result = run(`INSERT OR IGNORE INTO nfl_risk_lab_predictions
        (season,week,home,away,horizon,model_id,epoch_id,captured_at,engine_version,
         feature_hash,features_json,market_margin,predicted_residual,predicted_uncertainty)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, item.season, item.week, item.home, item.away,
      item.horizon, modelId, epochId, item.captured_at, item.engine_version, item.feature_hash,
      item.features_json, item.market_margin, r3(prediction.residual), r3(prediction.uncertainty));
      if (result.changes) captured++; else existing++;
    }
  }
  return { season, week, epoch_id: epochId, source_vectors: source.length, captured, existing, skipped,
    models: MODEL_IDS, authority: 'restricted_research', staking_units: 0 };
}

export function settleRiskLabPredictions() {
  const due = rows(`SELECT p.season,p.week,p.home,g.team_score,g.opp_score,p.market_margin
    FROM nfl_risk_lab_predictions p JOIN game_lines g
      ON g.season=p.season AND g.week=p.week AND g.team=p.home AND g.home=1
    WHERE p.settled_at IS NULL AND g.team_score IS NOT NULL AND g.opp_score IS NOT NULL
    GROUP BY p.season,p.week,p.home`);
  const settledAt = new Date().toISOString();
  let settled = 0;
  for (const item of due) {
    const actual = item.team_score - item.opp_score;
    settled += run(`UPDATE nfl_risk_lab_predictions SET actual_margin=?,target_residual=?,settled_at=?
      WHERE season=? AND week=? AND home=? AND settled_at IS NULL`, actual,
    actual - item.market_margin, settledAt, item.season, item.week, item.home).changes;
  }
  return { games: due.length, predictions_settled: settled };
}

function completeWeek(season, week) {
  const counts = row(`SELECT COUNT(*) scheduled,SUM(team_score IS NOT NULL AND opp_score IS NOT NULL) final
    FROM game_lines WHERE season=? AND week=? AND home=1`, season, week);
  return Number(counts?.scheduled) > 0 && Number(counts.final) === Number(counts.scheduled);
}

function selected(records) {
  const rank = new Map([['close', 6], ['T-15m', 5], ['T-60m', 4], ['T-6h', 3], ['T-24h', 2], ['open', 1], ['manual', 0]]);
  const best = new Map();
  for (const record of records) {
    const key = `${record.model_id}|${record.home}`;
    const prior = best.get(key);
    if (!prior || record.captured_at > prior.captured_at || (record.captured_at === prior.captured_at
      && (rank.get(record.horizon) ?? -1) > (rank.get(prior.horizon) ?? -1))) best.set(key, record);
  }
  return [...best.values()];
}

function metricsFor(modelId) {
  const epochId = activeLearningEpoch()?.id ?? 1;
  const data = rows(`SELECT season,week,market_margin,predicted_residual,predicted_uncertainty,actual_margin
    FROM nfl_risk_lab_predictions WHERE epoch_id=? AND model_id=? AND selected_for_training=1
      AND actual_margin IS NOT NULL ORDER BY season,week`, epochId, modelId);
  const weekly = new Map();
  for (const item of data) {
    const improvement = Math.abs(item.actual_margin - item.market_margin)
      - Math.abs(item.actual_margin - (item.market_margin + item.predicted_residual));
    const key = `${item.season}|${item.week}`, bucket = weekly.get(key) ?? [];
    bucket.push(improvement); weekly.set(key, bucket);
  }
  const weeklyMeans = [...weekly.values()].map(mean), improvement = weeklyMeans.length ? mean(weeklyMeans) : null;
  const weeklySd = weeklyMeans.length > 1 ? Math.sqrt(weeklyMeans.reduce((sum, value) =>
    sum + (value - improvement) ** 2, 0) / (weeklyMeans.length - 1)) : null;
  const half = weeklySd == null ? null : 1.645 * weeklySd / Math.sqrt(weeklyMeans.length);
  const interval = half == null ? null : [r3(improvement - half), r3(improvement + half)];
  const covered = data.filter(item => item.predicted_uncertainty != null
    && Math.abs(item.actual_margin - item.market_margin - item.predicted_residual) <= 1.645 * item.predicted_uncertainty).length;
  return { examples: data.length, weeks: weeklyMeans.length, mae_improvement: r3(improvement),
    weekly_clustered_improvement_ci90: interval,
    uncertainty_coverage_90: data.length ? r3(covered / data.length) : null,
    review_eligible: data.length >= 128 && weeklyMeans.length >= 8 && interval?.[0] > 0,
    direct_betting_authority: false };
}

export function trainRiskLabThroughSettled() {
  const epochId = activeLearningEpoch()?.id ?? 1;
  const pending = rows(`SELECT * FROM nfl_risk_lab_predictions
    WHERE epoch_id=? AND settled_at IS NOT NULL AND trained_at IS NULL ORDER BY season,week,captured_at`, epochId);
  const weeks = [...new Set(pending.map(item => `${item.season}|${item.week}`))], trained = [];
  for (const key of weeks) {
    const [season, week] = key.split('|').map(Number);
    if (!completeWeek(season, week)) continue;
    const current = selected(pending.filter(item => item.season === season && item.week === week));
    for (const modelId of MODEL_IDS) {
      const modelRows = current.filter(item => item.model_id === modelId);
      if (!modelRows.length) continue;
      const decoded = modelRows.map(record => ({ record, payload: parse(record.features_json), target: record.target_residual }))
        .filter(item => Array.isArray(item.payload?.values));
      if (!decoded.length) continue;
      const active = activeState(modelId, decoded[0].payload.values.length);
      const replay = rows(`SELECT features_json,target_residual FROM nfl_risk_lab_predictions
        WHERE epoch_id=? AND model_id=? AND selected_for_training=1 AND trained_at IS NOT NULL
          AND (season<? OR (season=? AND week<?)) ORDER BY season DESC,week DESC LIMIT 256`,
      epochId, modelId, season, season, week).map(item => ({ payload: parse(item.features_json), target: item.target_residual }))
        .filter(item => Array.isArray(item.payload?.values));
      const next = trainRiskState(modelId, active.state, [...replay, ...decoded]);
      const stateHash = hash(next), createdAt = new Date().toISOString();
      const version = `${modelId}-s${season}w${week}-e${epochId}-${stateHash.slice(0, 10)}`;
      for (const record of pending.filter(item => item.season === season && item.week === week
        && item.model_id === modelId)) {
        const chosen = modelRows.some(item => item.home === record.home && item.horizon === record.horizon);
        run(`UPDATE nfl_risk_lab_predictions SET trained_at=?,selected_for_training=?
          WHERE season=? AND week=? AND home=? AND horizon=? AND model_id=? AND epoch_id=?`,
        createdAt, chosen ? 1 : 0, record.season, record.week, record.home,
        record.horizon, record.model_id, epochId);
      }
      run(`INSERT OR IGNORE INTO nfl_risk_lab_artifacts
        (model_id,epoch_id,version,parent_version,schema_version,created_at,trained_through_season,
         trained_through_week,state_json,state_hash,metrics_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      modelId, epochId, version, active.version, RISK_LAB_SCHEMA, createdAt, season, week,
      JSON.stringify(next), stateHash, JSON.stringify(metricsFor(modelId)));
      trained.push({ model_id: modelId, season, week, examples: decoded.length, replay: replay.length, version });
    }
  }
  return { epoch_id: epochId, artifacts_trained: trained.length, trained, status: nflRiskLabStatus() };
}

export function nflRiskLabStatus() {
  const epochId = activeLearningEpoch()?.id ?? 1;
  return {
    name: 'Restricted Advanced ML Lab', schema_version: RISK_LAB_SCHEMA, epoch_id: epochId,
    authority: 'restricted_research', staking_units: 0,
    models: MODEL_IDS.map(modelId => {
      const artifact = latestArtifact(modelId);
      const counts = row(`SELECT COUNT(*) captured,SUM(settled_at IS NOT NULL) settled,
        SUM(selected_for_training=1) trained FROM nfl_risk_lab_predictions WHERE epoch_id=? AND model_id=?`,
      epochId, modelId) ?? {};
      return { id: modelId, ...RISK_MODELS[modelId], active_version: artifact?.version ?? `${modelId}-cold-start`,
        trained_through: artifact ? { season: artifact.trained_through_season, week: artifact.trained_through_week } : null,
        captured: Number(counts.captured ?? 0), settled: Number(counts.settled ?? 0), trained: Number(counts.trained ?? 0),
        metrics: metricsFor(modelId) };
    }),
    lifecycle: 'Freeze before kickoff → score complete week → update all challengers → compare to market by weekly clusters.',
    promotion_rule: 'A model may request review after 128 forward games across eight weeks with a positive lower CI. It still cannot auto-promote or size bets.'
  };
}

export const __test = { coldState, expertPacket, metricsFor, selected };
