/** Locked, market-specific MLB validation registry. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { db, rows, run } from '../db/index.js';
import { modelAudit } from './mlb-auto-picks.js';

const MARKETS = new Set(['nrfi', 'batter_total_bases', 'pitcher_strikeouts']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = x => x ? JSON.parse(x) : null;

db.exec(`CREATE TABLE IF NOT EXISTS mlb_model_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT NOT NULL, name TEXT NOT NULL,
  hypothesis TEXT NOT NULL, created_at TEXT NOT NULL, spec_hash TEXT NOT NULL UNIQUE,
  spec_json TEXT NOT NULL, discovery_json TEXT, validation_json TEXT, holdout_json TEXT,
  validation_passed INTEGER, verdict TEXT
)`);

function provenance() {
  let commit = 'unavailable';
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(); } catch {}
  const snapshot = {
    games: rows('SELECT COUNT(*) n,MAX(date) through FROM mlb_games')[0],
    batters: rows('SELECT COUNT(*) n,MAX(date) through FROM mlb_batter_games')[0],
    pitchers: rows('SELECT COUNT(*) n,MAX(date) through FROM mlb_pitcher_games')[0],
    pregame: rows('SELECT COUNT(*) n,MAX(captured_at) through FROM mlb_pregame_snapshots')[0]
  };
  return { git_commit: commit, data_snapshot_hash: hash(snapshot), data_snapshot: snapshot, model_version: 'mlb-projection-v2-cutoff' };
}

const dayAfter = d => new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
function normalized(input) {
  if (!MARKETS.has(input.market)) throw new Error('one supported MLB market is required');
  const split = name => {
    const x = input[name];
    if (!x?.from || !x?.through || x.from > x.through) throw new Error(`${name} requires an ordered from/through range`);
    return { from: x.from, through: x.through };
  };
  const discovery = split('discovery'), validation = split('validation'), holdout = split('holdout');
  if (discovery.through >= validation.from || validation.through >= holdout.from) {
    throw new Error('MLB splits must be chronological and non-overlapping');
  }
  return { market: input.market, discovery, validation, holdout,
    cadenceDays: Math.max(1, Number(input.cadenceDays) || 3), minSamples: Math.max(20, Number(input.minSamples) || 30),
    provenance: provenance() };
}

export function createMlbExperiment({ name, hypothesis, ...input }) {
  if (!String(name ?? '').trim() || !String(hypothesis ?? '').trim()) throw new Error('name and falsifiable hypothesis are required');
  const spec = normalized(input);
  const specHash = hash({ name, hypothesis, spec });
  run(`INSERT INTO mlb_model_experiments (market,name,hypothesis,created_at,spec_hash,spec_json)
       VALUES (?,?,?,datetime('now'),?,?)`, spec.market, String(name).trim(), String(hypothesis).trim(), specHash, JSON.stringify(spec));
  return getMlbExperiment(rows('SELECT last_insert_rowid() id')[0].id);
}

function score(spec, range) {
  const season = Number(range.from.slice(0, 4));
  if (Number(range.through.slice(0, 4)) !== season) throw new Error('a registry stage must stay within one MLB season');
  const audit = modelAudit(season, dayAfter(range.through), { fromDate: range.from, cadenceDays: spec.cadenceDays });
  return { range, metric: audit.by_market[spec.market], sampled_dates: audit.sampled_dates };
}

export function runMlbExperimentStage(id, stage) {
  const record = rows('SELECT * FROM mlb_model_experiments WHERE id=?', Number(id))[0];
  if (!record) throw new Error('MLB experiment not found');
  const spec = parse(record.spec_json);
  if (!['discovery', 'validation', 'holdout'].includes(stage)) throw new Error('unsupported stage');
  if (record[`${stage}_json`]) throw new Error(`${stage} is already locked`);
  if (stage === 'validation' && !record.discovery_json) throw new Error('run discovery first');
  if (stage === 'holdout' && record.validation_passed !== 1) throw new Error('holdout stays sealed until validation passes');
  const result = score(spec, spec[stage]);
  const passed = result.metric.n >= spec.minSamples && result.metric.status === 'validated' && result.metric.brier < 0.25;
  if (stage === 'discovery') run('UPDATE mlb_model_experiments SET discovery_json=? WHERE id=?', JSON.stringify(result), record.id);
  else if (stage === 'validation') run(`UPDATE mlb_model_experiments SET validation_json=?,validation_passed=?,verdict=? WHERE id=?`,
    JSON.stringify(result), passed ? 1 : 0, passed ? 'Validation passed; one-time holdout may open.' : 'Rejected independently on validation.', record.id);
  else run(`UPDATE mlb_model_experiments SET holdout_json=?,verdict=? WHERE id=?`, JSON.stringify(result),
    passed ? 'Market model passed its one-time holdout.' : 'Market model failed its one-time holdout.', record.id);
  return getMlbExperiment(id);
}

const unpack = r => r && ({ ...r, spec: parse(r.spec_json), discovery: parse(r.discovery_json),
  validation: parse(r.validation_json), holdout: parse(r.holdout_json),
  validation_passed: r.validation_passed == null ? null : r.validation_passed === 1,
  spec_json: undefined, discovery_json: undefined, validation_json: undefined, holdout_json: undefined });
export const getMlbExperiment = id => unpack(rows('SELECT * FROM mlb_model_experiments WHERE id=?', Number(id))[0]);
export const listMlbExperiments = () => rows('SELECT * FROM mlb_model_experiments ORDER BY id DESC').map(unpack);
