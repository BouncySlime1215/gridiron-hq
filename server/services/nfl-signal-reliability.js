/**
 * Cutoff-safe reliability controller for the unified candidate engine.
 *
 * It never searches for a profitable slice and never increases a signal's
 * authority. It can only shrink a component after enough frozen, independently
 * settled forward examples show directional harm and worse squared error than
 * the market. Production weights and staking authority remain untouched.
 */
import crypto from 'node:crypto';
import { db, row, rows, run } from '../db/index.js';

export const SIGNAL_RELIABILITY_VERSION = 'nfl-signal-reliability-v1-shrink-only';
const MIN_EXAMPLES = 32;
const MIN_WEEKS = 4;
const RECENT_WEEKS = 6;
const r3 = value => value == null || !Number.isFinite(value) ? null : +value.toFixed(3);
const parse = (value, fallback = null) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

db.exec(`CREATE TABLE IF NOT EXISTS nfl_signal_reliability_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  target_season INTEGER NOT NULL,
  target_week INTEGER NOT NULL,
  trained_through_season INTEGER NOT NULL,
  trained_through_week INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  examples_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  UNIQUE(target_season,target_week)
)`);

function wilsonUpper(wins, total, z = 1.645) {
  if (!total) return null;
  const p = wins / total, z2 = z * z;
  const center = p + z2 / (2 * total);
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return (center + half) / (1 + z2 / total);
}

function phase(week) { return week <= 6 ? 'early' : week <= 12 ? 'middle' : 'late'; }

/** Pure scoring function, exported so its conservative behavior is testable. */
export function deriveSignalReliability(examples) {
  const weekKeys = [...new Set(examples.map(item => `${item.season}|${item.week}`))].sort((a, b) => {
    const [as, aw] = a.split('|').map(Number), [bs, bw] = b.split('|').map(Number);
    return as - bs || aw - bw;
  });
  const recentKeys = new Set(weekKeys.slice(-RECENT_WEEKS));
  const bySignal = new Map();
  for (const example of examples) {
    if (!example.signal_id || !Number.isFinite(example.signal_residual)
      || !Number.isFinite(example.actual_residual) || Math.abs(example.signal_residual) < 0.25
      || example.actual_residual === 0) continue;
    const current = bySignal.get(example.signal_id) ?? [];
    current.push(example); bySignal.set(example.signal_id, current);
  }
  return [...bySignal.entries()].map(([signalId, items]) => {
    const score = list => {
      const correct = list.filter(item => item.signal_residual * item.actual_residual > 0).length;
      const gains = list.map(item => item.actual_residual ** 2
        - (item.actual_residual - item.signal_residual) ** 2);
      return { n: list.length, correct, directional_rate: list.length ? correct / list.length : null,
        mean_squared_error_gain: gains.length ? gains.reduce((sum, value) => sum + value, 0) / gains.length : null };
    };
    const overall = score(items);
    const recent = score(items.filter(item => recentKeys.has(`${item.season}|${item.week}`)));
    const prior = score(items.filter(item => !recentKeys.has(`${item.season}|${item.week}`)));
    const weeks = new Set(items.map(item => `${item.season}|${item.week}`)).size;
    const upper = wilsonUpper(overall.correct, overall.n);
    const drift = recent.n >= 16 && prior.n >= 16
      && recent.directional_rate <= prior.directional_rate - 0.12;
    let multiplier = 1, state = overall.n < MIN_EXAMPLES || weeks < MIN_WEEKS ? 'warming' : 'stable';
    if (state !== 'warming' && upper < 0.5 && overall.mean_squared_error_gain < 0) {
      multiplier = 0.25; state = 'strong_harm';
    } else if (state !== 'warming' && overall.directional_rate < 0.47
      && overall.mean_squared_error_gain < 0 && (recent.n < 16 || recent.directional_rate < 0.47)) {
      multiplier = 0.6; state = 'probable_harm';
    }
    if (state !== 'warming' && drift) { multiplier = Math.min(multiplier, 0.6); state = `${state}+drift`; }
    const phases = Object.fromEntries(['early', 'middle', 'late'].map(name => [name,
      score(items.filter(item => phase(item.week) === name))]));
    return { signal_id: signalId, examples: overall.n, weeks,
      directional_rate: r3(overall.directional_rate), directional_upper_90: r3(upper),
      mean_squared_error_gain: r3(overall.mean_squared_error_gain),
      recent: { ...recent, directional_rate: r3(recent.directional_rate),
        mean_squared_error_gain: r3(recent.mean_squared_error_gain) },
      prior: { ...prior, directional_rate: r3(prior.directional_rate),
        mean_squared_error_gain: r3(prior.mean_squared_error_gain) },
      phases, drift, multiplier, state,
      reason: state === 'warming' ? `Needs ${MIN_EXAMPLES} examples across ${MIN_WEEKS} weeks.`
        : multiplier < 1 ? 'Forward residual direction and squared-error evidence triggered shrink-only protection.'
          : 'No preregistered harm condition passed; base cutoff-safe weight retained.' };
  }).sort((a, b) => a.multiplier - b.multiplier || b.examples - a.examples);
}

function frozenExamples(throughSeason, throughWeek) {
  const records = rows(`SELECT * FROM shadow_decisions
    WHERE sport='NFL' AND market='spread' AND result IN ('Won','Lost','Push')
      AND (season<? OR (season=? AND week<=?))
    ORDER BY season,week,CASE WHEN model_version LIKE '%:candidate:%' THEN 0 ELSE 1 END,captured_at`,
  throughSeason, throughSeason, throughWeek);
  // Candidate snapshots contain the champion components plus challenger inputs.
  // Prefer that complete trace, then keep only one outcome per game so shared
  // components are never counted twice.
  const independent = new Map();
  for (const record of records) {
    const key = `${record.season}|${record.week}|${record.home_team}|spread`;
    if (!independent.has(key)) independent.set(key, record);
  }
  const examples = [];
  for (const record of independent.values()) {
    const snapshot = parse(record.feature_snapshot_json, {});
    const outcome = parse(record.outcome_json, {});
    const actualMargin = Number(outcome.actual_margin);
    const line = Number(record.line);
    if (!Number.isFinite(actualMargin) || !Number.isFinite(line) || !record.home_team || !record.selection) continue;
    const marketMargin = record.selection === record.home_team ? -line : line;
    for (const model of snapshot.model_trace ?? []) {
      const margin = Number(model.margin);
      if (!model.id || model.margin == null || !Number.isFinite(margin)) continue;
      examples.push({ season: Number(record.season), week: Number(record.week), home: record.home_team,
        signal_id: model.id, family: model.family ?? null,
        challenger_only: model.challenger_only === true,
        signal_residual: margin - marketMargin, actual_residual: actualMargin - marketMargin });
    }
  }
  return examples;
}

export function buildSignalReliabilityArtifact(season, throughWeek) {
  const targetWeek = Number(throughWeek) + 1;
  const examples = frozenExamples(Number(season), Number(throughWeek));
  const signals = deriveSignalReliability(examples);
  const examplesHash = hash(examples);
  const version = `${SIGNAL_RELIABILITY_VERSION}-s${season}w${throughWeek}-${examplesHash.slice(0, 10)}`;
  const result = { schema_version: SIGNAL_RELIABILITY_VERSION, version,
    created_at: new Date().toISOString(), target: { season: Number(season), week: targetWeek },
    trained_through: { season: Number(season), week: Number(throughWeek) },
    independent_games: new Set(examples.map(item => `${item.season}|${item.week}|${item.home}`)).size,
    signal_examples: examples.length, signals,
    adjusted: signals.filter(signal => signal.multiplier < 1).map(signal => signal.signal_id),
    authority: 'candidate forecast influence only; production and staking authority unchanged',
    policy: { mode: 'shrink_only', min_examples: MIN_EXAMPLES, min_weeks: MIN_WEEKS,
      recent_weeks: RECENT_WEEKS, strong_harm: '90% directional upper bound < 50% and MSE gain < 0',
      probable_harm: 'directional rate < 47%, MSE gain < 0, and recent evidence not contradictory' } };
  run(`INSERT INTO nfl_signal_reliability_artifacts
    (version,target_season,target_week,trained_through_season,trained_through_week,created_at,examples_hash,result_json)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(target_season,target_week) DO UPDATE SET version=excluded.version,
      trained_through_season=excluded.trained_through_season,trained_through_week=excluded.trained_through_week,
      created_at=excluded.created_at,examples_hash=excluded.examples_hash,result_json=excluded.result_json`,
  version, Number(season), targetWeek, Number(season), Number(throughWeek), result.created_at, examplesHash, JSON.stringify(result));
  return result;
}

export function signalReliabilityFor(season, week) {
  const artifact = row(`SELECT result_json FROM nfl_signal_reliability_artifacts
    WHERE target_season<? OR (target_season=? AND target_week<=?)
    ORDER BY target_season DESC,target_week DESC LIMIT 1`, Number(season), Number(season), Number(week));
  const result = parse(artifact?.result_json);
  if (!result) return { version: 'neutral-cold-start', multipliers: {}, adjusted: [], result: null };
  return { version: result.version,
    multipliers: Object.fromEntries(result.signals.map(signal => [signal.signal_id, signal.multiplier])),
    adjusted: result.adjusted, result };
}

export function signalReliabilityStatus() {
  const artifact = row('SELECT result_json FROM nfl_signal_reliability_artifacts ORDER BY target_season DESC,target_week DESC LIMIT 1');
  const result = parse(artifact?.result_json);
  return result ?? { schema_version: SIGNAL_RELIABILITY_VERSION, version: 'neutral-cold-start',
    independent_games: 0, signal_examples: 0, signals: [], adjusted: [],
    authority: 'candidate forecast influence only; production and staking authority unchanged' };
}
