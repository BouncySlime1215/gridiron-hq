/**
 * One version clock for the many-headed Gridiron Engine.
 *
 * Team lines, roster state, player usage, fantasy, props and neural residuals
 * remain specialized heads. This registry binds their exact active artifacts
 * and feature warehouse cutoff into one content-addressed engine version, so a
 * prediction can never vaguely claim it came from “the model.”
 */
import crypto from 'node:crypto';
import { db, row, rows, run } from '../db/index.js';
import { modelMap } from './gridiron-model.js';

export const GRIDIRON_ENGINE_SCHEMA = 'gridiron-engine-v1';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tableExists = table => Boolean(row(`SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?`, table));
const columnExists = (table, column) => tableExists(table)
  && db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
const computedCache = new Map();

db.exec(`CREATE TABLE IF NOT EXISTS nfl_engine_artifacts (
  engine_version TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  season INTEGER NOT NULL,
  trained_through_week INTEGER NOT NULL,
  predicts_week INTEGER NOT NULL,
  epoch_id INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  component_json TEXT NOT NULL,
  UNIQUE(season,predicts_week,data_hash)
);
CREATE TABLE IF NOT EXISTS nfl_learning_epochs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_epoch_id INTEGER,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','archived')),
  reason TEXT NOT NULL,
  reset_policy_json TEXT NOT NULL,
  FOREIGN KEY(parent_epoch_id) REFERENCES nfl_learning_epochs(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nfl_one_active_learning_epoch
  ON nfl_learning_epochs(status) WHERE status='active';
`);

if (!columnExists('nfl_engine_artifacts', 'epoch_id')) {
  db.exec(`ALTER TABLE nfl_engine_artifacts ADD COLUMN epoch_id INTEGER NOT NULL DEFAULT 1`);
}

if (!row(`SELECT 1 ok FROM nfl_learning_epochs WHERE status='active' LIMIT 1`)) {
  run(`INSERT INTO nfl_learning_epochs
    (parent_epoch_id,created_at,status,reason,reset_policy_json)
    VALUES (NULL,?,'active','initial persistent learning epoch',?)`, new Date().toISOString(),
  JSON.stringify({ preserve: ['raw evidence', 'outcomes', 'predictions', 'audits'],
    reset: [], automatic: false }));
}

// These tables predate learning epochs in existing installations. The registry
// can be imported before their owning services, so upgrade them here as well as
// in those modules instead of depending on import order.
for (const table of ['weekly_ensemble_fits', 'nfl_online_neural_artifacts', 'nfl_online_neural_examples']) {
  if (tableExists(table) && !columnExists(table, 'epoch_id')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN epoch_id INTEGER NOT NULL DEFAULT 1`);
  }
}

const optionalRow = (table, sql, ...params) => tableExists(table) ? row(sql, ...params) : null;
const optionalRows = (table, sql, ...params) => tableExists(table) ? rows(sql, ...params) : [];

function sourceState(table, season, predictsWeek) {
  if (!tableExists(table)) return { rows: 0, through_week: 0 };
  const state = row(`SELECT COUNT(*) rows,COALESCE(MAX(week),0) through_week FROM ${table}
    WHERE season<? OR (season=? AND week<?)`, season, season, predictsWeek);
  return { rows: Number(state?.rows ?? 0), through_week: Number(state?.through_week ?? 0) };
}

export function nflEngineComponents(season, predictsWeek) {
  const epoch = activeLearningEpoch();
  const teamFit = optionalRow('nfl_ensemble_fit_artifacts', `SELECT model_version,artifact_key,data_fingerprint,cutoff,created_at
    FROM nfl_ensemble_fit_artifacts WHERE cutoff=? ORDER BY created_at DESC LIMIT 1`, `${season}|${predictsWeek}`);
  const playerFit = optionalRow('weekly_ensemble_fits', `SELECT id,data_hash,through_season,through_week,created_at
    FROM weekly_ensemble_fits WHERE promoted=1 AND epoch_id=? AND (through_season<? OR (through_season=? AND through_week<?))
    ORDER BY through_season DESC,through_week DESC,id DESC LIMIT 1`, epoch?.id ?? 1, season, season, predictsWeek);
  const neuralFit = optionalRow('nfl_online_neural_artifacts', `SELECT head,version,state_hash,trained_through_season,trained_through_week,created_at
    FROM nfl_online_neural_artifacts WHERE epoch_id=? AND (trained_through_season<?
      OR (trained_through_season=? AND trained_through_week<?)
    ) ORDER BY id DESC LIMIT 1`, epoch?.id ?? 1, season, season, predictsWeek);
  const reliabilityFit = optionalRow('nfl_signal_reliability_artifacts', `SELECT version,target_season,target_week,
      trained_through_season,trained_through_week,created_at,examples_hash
    FROM nfl_signal_reliability_artifacts WHERE target_season<? OR (target_season=? AND target_week<=?)
    ORDER BY target_season DESC,target_week DESC LIMIT 1`, season, season, predictsWeek);
  const riskFits = optionalRows('nfl_risk_lab_artifacts', `SELECT a.model_id,a.version,a.state_hash,
      a.trained_through_season,a.trained_through_week,a.created_at
    FROM nfl_risk_lab_artifacts a JOIN (
      SELECT model_id,MAX(id) id FROM nfl_risk_lab_artifacts WHERE epoch_id=?
        AND (trained_through_season<? OR (trained_through_season=? AND trained_through_week<?))
      GROUP BY model_id
    ) latest ON latest.id=a.id ORDER BY a.model_id`, epoch?.id ?? 1, season, season, predictsWeek);
  return {
    learning_epoch: epoch,
    cutoff: { season, predicts_week: predictsWeek, trained_through_week: Math.max(0, predictsWeek - 1) },
    heads: {
      team_spread_total: teamFit ?? { model_version: 'ensemble-cold-cutoff' },
      roster_availability: { model_version: 'roster-replacement-v2-pfr-ngs', authority: 'shadow' },
      player_usage_fantasy: playerFit
        ? { model_version: `weekly-fit-${playerFit.id}`, ...playerFit }
        : { model_version: 'player-week-v2.1-frozen-weights' },
      player_props: { model_version: 'shared-player-events-v1', inherits: 'player_usage_fantasy' },
      online_residual: neuralFit ?? { version: 'online-spread-v1-cold-start', authority: 'shadow' },
      pattern_reliability: reliabilityFit ?? {
        version: 'neutral-cold-start', authority: 'candidate shrink-only' },
      advanced_risk_lab: riskFits.length ? riskFits : [
        { model_id: 'deep_ensemble', version: 'cold-start' },
        { model_id: 'bayesian_online', version: 'cold-start' },
        { model_id: 'contextual_moe', version: 'cold-start' },
        { model_id: 'multitask_encoder', version: 'cold-start' }
      ]
    },
    capability_authority: (() => {
      const map = tableExists('audit_registry') ? modelMap()
        : { counts: {}, can_size: [], retired: [], note: 'audit registry has not been initialized' };
      return { counts: map.counts, can_size: map.can_size,
        restricted_research_pool: map.retired.map(capability => ({ ...capability,
          still_used_for: ['online learner inputs', 'disagreement/regime detection', 'shadow challengers'],
          reentry_gate: 'fresh cutoff-safe replay plus sealed forward validation' })),
        rule: 'A failed standalone picker loses direct bankroll authority, not its information. Its internals remain available to validated downstream heads.' };
    })(),
    warehouse: Object.fromEntries([
      'game_lines', 'nfl_team_week_features', 'nfl_player_week_features', 'player_week_usage',
      'nfl_snaps', 'nfl_depth', 'nfl_injuries', 'nfl_ngs', 'nfl_pfr_adv'
    ].map(table => [table, sourceState(table, season, predictsWeek)]))
  };
}

function computedVersion(season, predictsWeek) {
  const key = `${season}|${predictsWeek}`;
  const cached = computedCache.get(key);
  if (cached && Date.now() - cached.at < 10000) return cached.value;
  const components = nflEngineComponents(season, predictsWeek);
  const dataHash = digest(components);
  const value = { engine_version: `${GRIDIRON_ENGINE_SCHEMA}-s${season}w${predictsWeek}-${dataHash.slice(0, 12)}`,
    data_hash: dataHash, components };
  computedCache.set(key, { at: Date.now(), value });
  return value;
}

export function clearNflEngineRegistryCache() { computedCache.clear(); }

export function activeLearningEpoch() {
  const epoch = row(`SELECT * FROM nfl_learning_epochs WHERE status='active' ORDER BY id DESC LIMIT 1`);
  return epoch ? {
    id: Number(epoch.id),
    parent_epoch_id: epoch.parent_epoch_id == null ? null : Number(epoch.parent_epoch_id),
    created_at: epoch.created_at,
    reason: epoch.reason,
    reset_policy: JSON.parse(epoch.reset_policy_json)
  } : null;
}

/** Start a cold adaptive epoch while retaining all evidence and failed runs. */
export function startLearningEpoch({ reason, confirmed = false,
  reset = ['online_residual', 'adaptive_player_weights', 'risk_lab'] } = {}) {
  if (!confirmed) throw new Error('learning reset requires confirmed=true');
  if (!String(reason ?? '').trim()) throw new Error('learning reset requires a recorded reason');
  const allowed = new Set(['online_residual', 'adaptive_player_weights', 'risk_lab']);
  if (!Array.isArray(reset) || reset.some(component => !allowed.has(component))) {
    throw new Error(`unsupported reset component; allowed: ${[...allowed].join(', ')}`);
  }
  const prior = activeLearningEpoch();
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    run(`UPDATE nfl_learning_epochs SET status='archived',closed_at=? WHERE status='active'`, now);
    run(`INSERT INTO nfl_learning_epochs
      (parent_epoch_id,created_at,status,reason,reset_policy_json) VALUES (?,?,'active',?,?)`,
    prior?.id ?? null, now, String(reason).trim(), JSON.stringify({
      preserve: ['raw evidence', 'outcomes', 'frozen predictions', 'artifacts', 'audits'],
      reset, automatic: false
    }));
    db.exec('COMMIT');
    clearNflEngineRegistryCache();
    return { prior_epoch: prior, active_epoch: activeLearningEpoch(), deleted_rows: 0,
      rule: 'Prior adaptive weights are ignored; immutable evidence and failed artifacts remain auditable.' };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function nflEngineVersionFor(season, predictsWeek) {
  const epochId = activeLearningEpoch()?.id ?? 1;
  const artifact = row(`SELECT engine_version FROM nfl_engine_artifacts
    WHERE season=? AND predicts_week=? AND epoch_id=? ORDER BY created_at DESC LIMIT 1`, season, predictsWeek, epochId);
  return artifact?.engine_version ?? computedVersion(season, predictsWeek).engine_version;
}

/** Seal the coordinated state after a completed weekly learning cycle. */
export function recordNflEngineArtifact(season, trainedThroughWeek) {
  clearNflEngineRegistryCache();
  const predictsWeek = trainedThroughWeek + 1;
  const computed = computedVersion(season, predictsWeek);
  const createdAt = new Date().toISOString();
  run(`INSERT OR IGNORE INTO nfl_engine_artifacts
    (engine_version,schema_version,season,trained_through_week,predicts_week,epoch_id,created_at,data_hash,component_json)
    VALUES (?,?,?,?,?,?,?,?,?)`, computed.engine_version, GRIDIRON_ENGINE_SCHEMA, season,
  trainedThroughWeek, predictsWeek, activeLearningEpoch()?.id ?? 1, createdAt, computed.data_hash, JSON.stringify(computed.components));
  return { ...computed, schema_version: GRIDIRON_ENGINE_SCHEMA, season,
    trained_through_week: trainedThroughWeek, predicts_week: predictsWeek, created_at: createdAt };
}

export function nflEngineStatus(season = Number(process.env.NFL_SEASON) || 2026, week = 1) {
  const latest = row('SELECT * FROM nfl_engine_artifacts ORDER BY created_at DESC LIMIT 1');
  const current = computedVersion(season, week);
  return {
    name: 'Gridiron Engine', schema_version: GRIDIRON_ENGINE_SCHEMA,
    learning_epoch: activeLearningEpoch(),
    current_version: nflEngineVersionFor(season, week), current_components: current.components,
    latest_sealed: latest ? { ...latest, components: JSON.parse(latest.component_json), component_json: undefined } : null,
    architecture: [
      { head: 'team_spread_total', cadence: 'weekly cutoff refit', consumes: 'team PBP, ratings, context, market' },
      { head: 'roster_availability', cadence: 'each evidence capture', consumes: 'injury, depth, snaps, PFR, NGS' },
      { head: 'player_usage_fantasy', cadence: 'weekly guarded challenger', consumes: 'shared player event state' },
      { head: 'player_props', cadence: 'shared state + market-specific calibration', consumes: 'player usage and game script' },
      { head: 'online_residual', cadence: 'whole-week prequential update', consumes: 'all upstream heads + evidence masks' },
      { head: 'pattern_reliability', cadence: 'after each finalized week', consumes: 'frozen per-signal residuals + outcomes + regime phase' },
      { head: 'advanced_risk_lab', cadence: 'whole-week prequential competition', consumes: 'frozen vectors + restricted model-family signals' }
    ],
    rule: 'One cutoff, learning epoch and engine version; many specialized heads. Heads may adapt weekly but only independently validated challengers can replace champion behavior.',
    reset_rule: 'A failed preregistered profitability gate may start a new cold epoch by explicit action. Evidence is never erased and resets never happen automatically.'
  };
}

export const __test = { computedVersion, sourceState, optionalRows };
