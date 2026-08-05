/**
 * Locked NFL model experiments.
 *
 * An experiment is immutable after creation. Discovery, validation and holdout
 * seasons must be chronological and disjoint. The holdout can be opened only
 * once, after validation passes, so repeatedly inspecting the same future data
 * cannot quietly become another tuning loop.
 */
import { createHash } from 'node:crypto';
import { db, rows, run } from '../db/index.js';
import { trainingIteration } from './nfl-replay.js';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_model_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, hypothesis TEXT NOT NULL, created_at TEXT NOT NULL,
  spec_hash TEXT NOT NULL UNIQUE, spec_json TEXT NOT NULL,
  discovery_json TEXT, validation_json TEXT, holdout_json TEXT,
  validation_passed INTEGER, verdict TEXT
)`);

const PRODUCTION = {
  minEdge: 3, maxDisagreement: 4.5, markets: ['spread', 'total'],
  modelOptions: { weighting: 'exponential', families: null }
};
const FAMILIES = new Set(['Rating systems', 'Efficiency', 'Context', 'Market']);
const WEIGHTINGS = new Set(['exponential', 'inverse_mse', 'equal']);

function normalizeSeasons(value, field) {
  const out = [...new Set((value ?? []).map(Number))].sort((a, b) => a - b);
  if (!out.length || out.some(x => !Number.isInteger(x) || x < 1999 || x > 2100)) {
    throw new Error(`${field} must contain valid NFL seasons`);
  }
  return out;
}

function normalizeConfig(raw = {}) {
  const minEdge = Number(raw.minEdge ?? PRODUCTION.minEdge);
  const maxDisagreement = raw.maxDisagreement == null ? null : Number(raw.maxDisagreement);
  const markets = (raw.markets ?? PRODUCTION.markets).filter(x => x === 'spread' || x === 'total');
  const weighting = raw.modelOptions?.weighting ?? 'exponential';
  const families = raw.modelOptions?.families == null ? null
    : [...new Set(raw.modelOptions.families)].filter(x => FAMILIES.has(x));
  if (!Number.isFinite(minEdge) || minEdge < 0 || minEdge > 14) throw new Error('minEdge outside safe range');
  if (maxDisagreement != null && (!Number.isFinite(maxDisagreement) || maxDisagreement < 0 || maxDisagreement > 20)) {
    throw new Error('maxDisagreement outside safe range');
  }
  if (!markets.length) throw new Error('at least one supported market is required');
  if (!WEIGHTINGS.has(weighting)) throw new Error('unsupported weighting method');
  if (raw.modelOptions?.families != null && !families.length) throw new Error('no supported model families selected');
  return { minEdge, maxDisagreement, markets, modelOptions: { weighting, families } };
}

function normalizedSpec(input) {
  const discovery = normalizeSeasons(input.discovery, 'discovery');
  const validation = normalizeSeasons(input.validation, 'validation');
  const holdout = normalizeSeasons(input.holdout, 'holdout');
  const all = [...discovery, ...validation, ...holdout];
  if (new Set(all).size !== all.length) throw new Error('discovery, validation and holdout cannot overlap');
  if (Math.max(...discovery) >= Math.min(...validation) || Math.max(...validation) >= Math.min(...holdout)) {
    throw new Error('splits must be chronological: discovery, then validation, then holdout');
  }
  return {
    discovery, validation, holdout,
    baseline: normalizeConfig(input.baseline ?? PRODUCTION),
    candidate: normalizeConfig(input.candidate),
    minBets: Math.max(20, Number(input.minBets) || 30)
  };
}

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => value ? JSON.parse(value) : null;

export function createExperiment({ name, hypothesis, ...input }) {
  if (!String(name ?? '').trim() || !String(hypothesis ?? '').trim()) {
    throw new Error('name and falsifiable hypothesis are required');
  }
  const spec = normalizedSpec(input);
  const specHash = hash({ name: String(name).trim(), hypothesis: String(hypothesis).trim(), spec });
  run(`INSERT INTO nfl_model_experiments
       (name,hypothesis,created_at,spec_hash,spec_json) VALUES (?,?,datetime('now'),?,?)`,
      String(name).trim(), String(hypothesis).trim(), specHash, JSON.stringify(spec));
  return experiment(rows('SELECT * FROM nfl_model_experiments WHERE spec_hash=?', specHash)[0]);
}

function scorePair(seasons, spec) {
  return {
    seasons,
    baseline: trainingIteration(seasons, { ...spec.baseline, minBets: spec.minBets }).overall,
    candidate: trainingIteration(seasons, { ...spec.candidate, minBets: spec.minBets }).overall
  };
}

function earnsPromotion(result, minBets) {
  return result.candidate.bets >= minBets
    && result.candidate.beat_vig === true
    && (result.candidate.roi ?? -Infinity) > (result.baseline.roi ?? -Infinity)
    && (result.candidate.uncertainty?.probability_roi_above_zero ?? 0) >= 0.75;
}

export function runExperimentStage(id, stage) {
  const record = rows('SELECT * FROM nfl_model_experiments WHERE id=?', Number(id))[0];
  if (!record) throw new Error('experiment not found');
  const spec = parse(record.spec_json);
  if (stage === 'discovery') {
    if (record.discovery_json) throw new Error('discovery was already run; the locked result cannot be overwritten');
    const result = scorePair(spec.discovery, spec);
    run('UPDATE nfl_model_experiments SET discovery_json=? WHERE id=?', JSON.stringify(result), record.id);
  } else if (stage === 'validation') {
    if (!record.discovery_json) throw new Error('run discovery first');
    if (record.validation_json) throw new Error('validation was already run; the locked result cannot be overwritten');
    const result = scorePair(spec.validation, spec);
    const passed = earnsPromotion(result, spec.minBets);
    run(`UPDATE nfl_model_experiments SET validation_json=?,validation_passed=?,verdict=? WHERE id=?`,
      JSON.stringify(result), passed ? 1 : 0,
      passed ? 'Validation passed — holdout may be opened once.' : 'Rejected on validation — holdout remains sealed.', record.id);
  } else if (stage === 'holdout') {
    if (!record.validation_json || record.validation_passed !== 1) throw new Error('holdout stays sealed until validation passes');
    if (record.holdout_json) throw new Error('holdout was already opened; it cannot be rerun or overwritten');
    const result = scorePair(spec.holdout, spec);
    const passed = earnsPromotion(result, spec.minBets);
    run(`UPDATE nfl_model_experiments SET holdout_json=?,verdict=? WHERE id=?`, JSON.stringify(result),
      passed ? 'Promote candidate — improved on validation and the one-time holdout.'
        : 'Reject candidate — failed the one-time holdout; do not tune against these seasons.', record.id);
  } else throw new Error('stage must be discovery, validation, or holdout');
  return getExperiment(id);
}

function experiment(r) {
  if (!r) return null;
  return { ...r, spec: parse(r.spec_json), discovery: parse(r.discovery_json),
    validation: parse(r.validation_json), holdout: parse(r.holdout_json),
    spec_json: undefined, discovery_json: undefined, validation_json: undefined, holdout_json: undefined,
    validation_passed: r.validation_passed == null ? null : r.validation_passed === 1 };
}

export function getExperiment(id) { return experiment(rows('SELECT * FROM nfl_model_experiments WHERE id=?', Number(id))[0]); }
export function listExperiments() { return rows('SELECT * FROM nfl_model_experiments ORDER BY id DESC').map(experiment); }

export function experimentProtocol() {
  return {
    production_baseline: PRODUCTION,
    supported_weightings: [...WEIGHTINGS], supported_families: [...FAMILIES],
    rules: [
      'Write a falsifiable hypothesis and lock all parameters before seeing validation.',
      'Discovery, validation and holdout seasons must be chronological and non-overlapping.',
      'A candidate must beat production, beat the vig, meet the minimum sample, and reach a 75% estimated chance of positive ROI on validation.',
      'The holdout opens once, only after validation passes, and its result is immutable.',
      'A failed holdout is not a new discovery set. New work requires future untouched data.'
    ]
  };
}
