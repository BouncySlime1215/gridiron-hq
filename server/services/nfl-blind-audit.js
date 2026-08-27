/**
 * Content-addressed, week-at-a-time NFL audit controller.
 *
 * Historical outcomes physically exist in the local database, so this is an
 * algorithmically blind chronological replay—not a claim that a human has
 * never inspected 2021-25. The untouched test is the forward 2026 shadow
 * ledger. This controller still makes historical leakage difficult: it freezes
 * the exact code, input tables, candidate registry and policy, then refuses to
 * open week N+1 if any of them change after preregistration.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, rows, run } from '../db/index.js';
import { replaySeasonWeekly } from './weekly-backtest.js';
import { replaySeason } from './nfl-replay.js';
import { PLAYER_HEAD_REGISTRY_VERSION, PLAYER_HEADS } from './player-head-registry.js';
import { PLAYER_WEEK_ENGINE_VERSION } from './player-week-engine.js';
import { NFL_PRODUCTION_POLICY } from './nfl-policy.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_blind_audit_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    label TEXT NOT NULL,
    spec_hash TEXT NOT NULL UNIQUE,
    spec_json TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    data_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'registered',
    next_ordinal INTEGER NOT NULL DEFAULT 0,
    final_json TEXT
  );
  CREATE TABLE IF NOT EXISTS nfl_blind_audit_weeks (
    run_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    opened_at TEXT NOT NULL,
    prior_chain_hash TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    chain_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    fault_json TEXT NOT NULL,
    PRIMARY KEY (run_id, ordinal),
    UNIQUE (run_id, season, week)
  );
`);

const INPUT_TABLES = [
  'players', 'player_week_usage', 'game_lines', 'nflverse_player_positions',
  'nfl_team_week_features', 'nfl_player_week_features', 'nfl_depth',
  'nfl_injuries', 'nfl_ngs', 'nfl_pfr_adv', 'nfl_snaps', 'nfl_teams',
  'weekly_ensemble_fits', 'nfl_ensemble_fit_artifacts'
];
const sha = value => createHash('sha256').update(value).digest('hex');

function repositoryState() {
  const cwd = process.cwd();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const diff = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  const content = createHash('sha256').update(commit).update('\0').update(diff);
  for (const path of untracked) content.update('\0').update(path).update('\0').update(readFileSync(resolve(cwd, path)));
  return { commit, dirty: diff.length > 0 || untracked.length > 0, hash: content.digest('hex') };
}

function inputDataState() {
  const hash = createHash('sha256');
  const tables = new Set(rows("SELECT name FROM sqlite_master WHERE type='table'").map(x => x.name));
  const coverage = {};
  for (const table of INPUT_TABLES) {
    if (!tables.has(table)) { coverage[table] = { rows: 0, missing: true }; continue; }
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name);
    const data = rows(`SELECT * FROM ${table} ORDER BY rowid`);
    coverage[table] = { rows: data.length, columns };
    hash.update(table).update('\0').update(JSON.stringify(columns)).update('\0');
    for (const record of data) hash.update(JSON.stringify(record)).update('\n');
  }
  return { hash: hash.digest('hex'), coverage };
}

function scheduleFor(seasons, startWeek, endWeek) {
  return seasons.flatMap(season => Array.from({ length: endWeek - startWeek + 1 }, (_, i) => ({
    season, week: startWeek + i
  })));
}

function normalizeSpec(input = {}) {
  const seasons = [...new Set((input.seasons ?? [2021, 2022, 2023, 2024, 2025]).map(Number))]
    .sort((a, b) => a - b);
  if (!seasons.length || seasons.some(x => !Number.isInteger(x) || x < 1999 || x > 2100)) {
    throw new Error('blind audit requires valid seasons');
  }
  const startWeek = Math.max(5, Number(input.startWeek) || 5);
  const endWeek = Math.min(18, Number(input.endWeek) || 18);
  if (endWeek < startWeek) throw new Error('blind audit endWeek must be at or after startWeek');
  return {
    protocol: 'nfl-blind-week-chain-v1',
    classification: 'historical_algorithmically_blind_replay',
    seasons, startWeek, endWeek,
    schedule: scheduleFor(seasons, startWeek, endWeek),
    domains: ['player_week', 'spread', 'total'],
    player_engine: PLAYER_WEEK_ENGINE_VERSION,
    player_head_registry: PLAYER_HEAD_REGISTRY_VERSION,
    player_head_ids: PLAYER_HEADS.map(x => x.id),
    betting_policy: NFL_PRODUCTION_POLICY,
    rules: [
      'One week opens once and cannot be overwritten.',
      'Every prediction is generated from information strictly before its target week.',
      'Code and model-input data must match preregistration before every opened week.',
      'Fault attribution is descriptive and cannot alter the frozen model during this run.',
      'Historical ROI is reported but cannot establish production profitability without real archived quotes and forward CLV.',
      'The genuinely untouched gate is the 2026 forward shadow ledger.'
    ]
  };
}

export function preregisterBlindAudit({ label = 'NFL five-year blind replay', allowDirty = false, ...input } = {}) {
  const code = repositoryState();
  if (code.dirty && !allowDirty) {
    throw new Error('blind audit preregistration requires a clean committed repository state');
  }
  const data = inputDataState();
  const spec = { ...normalizeSpec(input), provenance: { code, data_coverage: data.coverage } };
  const specHash = sha(JSON.stringify(spec));
  run(`INSERT INTO nfl_blind_audit_runs
       (created_at,label,spec_hash,spec_json,code_hash,data_hash,status,next_ordinal)
       VALUES (datetime('now'),?,?,?,?,?,'registered',0)`,
    label, specHash, JSON.stringify(spec), code.hash, data.hash);
  return blindAuditStatus(rows('SELECT last_insert_rowid() id')[0].id);
}

function parseRun(record) {
  if (!record) return null;
  return { ...record, spec: JSON.parse(record.spec_json), final: record.final_json ? JSON.parse(record.final_json) : null,
    spec_json: undefined, final_json: undefined };
}

function assertFrozen(record) {
  const code = repositoryState();
  if (code.hash !== record.code_hash) throw new Error('blind audit blocked: repository state changed after preregistration');
  const data = inputDataState();
  if (data.hash !== record.data_hash) throw new Error('blind audit blocked: model input data changed after preregistration');
}

function playerWeekResult(season, week) {
  const replay = replaySeasonWeekly(season, { startWeek: week, endWeek: week, distributions: false });
  const misses = [...replay._predictions]
    .map(x => ({ player_id: x.player_id, position: x.position, predicted: +x.prediction.toFixed(3),
      actual: +x.actual.toFixed(3), error: +Math.abs(x.prediction - x.actual).toFixed(3),
      direction: x.prediction > x.actual ? 'over_projection' : 'under_projection' }))
    .sort((a, b) => b.error - a.error).slice(0, 10);
  return {
    metrics: { player_weeks: replay.player_weeks, point: replay.point,
      decision_including_dnp: replay.decision_including_dnp },
    faults: misses
  };
}

function bettingWeekResult(season, week) {
  const replay = replaySeason(season, { startWeek: week, endWeek: week });
  if (replay.error) return { metrics: { error: replay.error }, faults: [] };
  const misses = [...replay.bets]
    .map(x => ({ market: x.market, matchup: `${x.away} at ${x.home}`, selection: x.side,
      model: x.model_margin, market_line: x.market_margin, actual_margin: x.actual_margin,
      actual_total: x.actual_total, result: x.result,
      miss_size: x.market === 'spread'
        ? +Math.abs(x.model_margin - x.actual_margin).toFixed(3)
        : +Math.abs(x.model_margin - x.actual_total).toFixed(3) }))
    .sort((a, b) => b.miss_size - a.miss_size).slice(0, 10);
  return { metrics: replay.summary, faults: misses };
}

function aggregate(weeks) {
  const player = weeks.flatMap(x => x.result.player?.faults ?? []);
  const bets = weeks.flatMap(x => x.result.betting?.metrics?.bets ? [x.result.betting.metrics] : []);
  const totalBets = bets.reduce((sum, x) => sum + x.bets, 0);
  const units = bets.reduce((sum, x) => sum + x.units, 0);
  return {
    weeks_opened: weeks.length,
    player_faults_recorded: player.length,
    betting: { bets: totalBets, wins: bets.reduce((s, x) => s + x.wins, 0),
      losses: bets.reduce((s, x) => s + x.losses, 0), units: +units.toFixed(3),
      roi: totalBets ? +(units / totalBets).toFixed(4) : null },
    interpretation: 'Historical chronological replay only. Profitability promotion still requires forward priced decisions and positive CLV.'
  };
}

export function runNextBlindAuditWeek(id) {
  const record = rows('SELECT * FROM nfl_blind_audit_runs WHERE id=?', Number(id))[0];
  if (!record) throw new Error('blind audit not found');
  if (record.status === 'complete') throw new Error('blind audit is already complete');
  assertFrozen(record);
  const spec = JSON.parse(record.spec_json);
  const target = spec.schedule[record.next_ordinal];
  if (!target) throw new Error('blind audit has no remaining weeks');
  const result = {
    cutoff: `${target.season}-W${target.week - 1}`,
    player: playerWeekResult(target.season, target.week),
    betting: bettingWeekResult(target.season, target.week)
  };
  const fault = { player: result.player.faults, betting: result.betting.faults,
    classification: 'outcome-visible fault pass; no model mutation authorized' };
  const prior = rows(`SELECT chain_hash FROM nfl_blind_audit_weeks
                      WHERE run_id=? ORDER BY ordinal DESC LIMIT 1`, record.id)[0]?.chain_hash ?? record.spec_hash;
  const resultHash = sha(JSON.stringify(result));
  const chainHash = sha(`${prior}:${record.next_ordinal}:${target.season}:${target.week}:${resultHash}`);
  db.exec('BEGIN');
  try {
    run(`INSERT INTO nfl_blind_audit_weeks
         (run_id,ordinal,season,week,opened_at,prior_chain_hash,result_hash,chain_hash,result_json,fault_json)
         VALUES (?,?,?,?,datetime('now'),?,?,?,?,?)`, record.id, record.next_ordinal,
      target.season, target.week, prior, resultHash, chainHash, JSON.stringify(result), JSON.stringify(fault));
    const next = record.next_ordinal + 1;
    const complete = next >= spec.schedule.length;
    const weekRows = rows('SELECT result_json FROM nfl_blind_audit_weeks WHERE run_id=? ORDER BY ordinal', record.id)
      .map(x => ({ result: JSON.parse(x.result_json) }));
    const final = complete ? aggregate(weekRows) : null;
    run(`UPDATE nfl_blind_audit_runs SET next_ordinal=?,status=?,final_json=? WHERE id=?`,
      next, complete ? 'complete' : 'running', final ? JSON.stringify(final) : null, record.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return blindAuditStatus(record.id);
}

export function blindAuditStatus(id) {
  const record = parseRun(rows('SELECT * FROM nfl_blind_audit_runs WHERE id=?', Number(id))[0]);
  if (!record) return null;
  const weeks = rows(`SELECT ordinal,season,week,opened_at,prior_chain_hash,result_hash,chain_hash,
                             result_json,fault_json FROM nfl_blind_audit_weeks
                      WHERE run_id=? ORDER BY ordinal`, record.id).map(x => ({ ...x,
    result: JSON.parse(x.result_json), faults: JSON.parse(x.fault_json), result_json: undefined, fault_json: undefined }));
  return { ...record, progress: { opened: weeks.length, total: record.spec.schedule.length,
    next: record.spec.schedule[record.next_ordinal] ?? null }, weeks };
}

export function listBlindAudits() {
  return rows('SELECT id FROM nfl_blind_audit_runs ORDER BY id DESC').map(x => blindAuditStatus(x.id));
}

export function blindAuditProtocol() {
  return { ...normalizeSpec({}), input_tables: INPUT_TABLES,
    warning: 'Do not preregister until the model code is committed and the input data snapshot is frozen.' };
}
