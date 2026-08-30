/**
 * Progressive weekly learning with a hard pregame/outcome boundary.
 *
 * Predictions are captured before any result for the week exists. Outcomes are
 * attached later. Challenger weights train on the older 80% and are promoted
 * only when they beat the active champion on the newest 20% while preserving
 * rank and interval coverage. Failed fits remain in the ledger.
 */
import crypto from 'node:crypto';
import { db, row, rows, run } from '../db/index.js';
import { buildPlayerWeekEngine, playerWeekDistribution, clearPlayerWeekEngineCache } from './player-week-engine.js';
import { PPR, scoreLine } from './scoring.js';
import { WEEKLY_ENSEMBLE_HEADS } from './weekly-ensemble.js';
import { PLAYER_HEADS, PLAYER_HEAD_REGISTRY_VERSION } from './player-head-registry.js';
import { activeWeeklyWeightSet, saveWeeklyFit, weeklyFitHistory } from './weekly-weight-store.js';
import { spearman } from './backtest.js';
import { nflKickoffDate } from './date-util.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS weekly_prediction_snapshots (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    position TEXT NOT NULL,
    as_of TEXT NOT NULL,
    cutoff TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    structural REAL NOT NULL,
    season_to_date REAL,
    last3 REAL,
    last1 REAL,
    median REAL,
    prediction REAL NOT NULL,
    lower_80 REAL,
    upper_80 REAL,
    weights_json TEXT,
    weight_fit TEXT,
    actual REAL,
    settled_at TEXT,
    PRIMARY KEY (season, week, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_weekly_snapshots_settlement
    ON weekly_prediction_snapshots(actual, season, week);
`);

const snapshotColumns = new Set(db.prepare('PRAGMA table_info(weekly_prediction_snapshots)').all().map(x => x.name));
if (!snapshotColumns.has('candidate_version')) {
  db.exec('ALTER TABLE weekly_prediction_snapshots ADD COLUMN candidate_version TEXT');
}
if (!snapshotColumns.has('candidate_heads_json')) {
  db.exec('ALTER TABLE weekly_prediction_snapshots ADD COLUMN candidate_heads_json TEXT');
}

const predict = (weights, observation) => WEEKLY_ENSEMBLE_HEADS.reduce(
  (sum, head, index) => sum + weights[index] * observation[head], 0);
const mae = (data, fn) => data.reduce((sum, x) => sum + Math.abs(fn(x) - x.actual), 0) / data.length;
const rank = (data, fn) => spearman(data.map(x => ({ pred: fn(x), act: x.actual })));

function grid() {
  const out = [], units = 10;
  for (let a = 0; a <= units; a++)
    for (let b = 0; b <= units - a; b++)
      for (let c = 0; c <= units - a - b; c++)
        for (let d = 0; d <= units - a - b - c; d++)
          out.push([a, b, c, d, units - a - b - c - d].map(x => x / units));
  return out;
}
const WEIGHT_GRID = grid();

function fitPosition(data, fallback) {
  if (data.length < 75) return fallback;
  let best = { weights: fallback, error: mae(data, row => predict(fallback, row)) };
  for (const weights of WEIGHT_GRID) {
    const error = mae(data, observation => predict(weights, observation));
    if (error < best.error) best = { weights, error };
  }
  return best.weights;
}

export function captureWeeklyPredictions(season, week, { scoring = PPR, runs = 250 } = {}) {
  const outcomes = row('SELECT COUNT(*) AS n FROM player_week_usage WHERE season=? AND week=?', season, week)?.n ?? 0;
  if (outcomes > 0) return { captured: 0, blocked: true, reason: 'week already has outcomes; pregame snapshot cannot be rewritten' };
  const schedule = rows(`SELECT gameday,gametime,team_score FROM game_lines
    WHERE season=? AND week=? AND home=1`, season, week);
  const firstKickoff = schedule.map(game => nflKickoffDate(game.gameday, game.gametime || '23:59'))
    .filter(date => date && Number.isFinite(date.getTime())).sort((a, b) => a - b)[0];
  if (schedule.some(game => game.team_score != null) || (firstKickoff && firstKickoff.getTime() <= Date.now())) {
    return { captured: 0, blocked: true,
      reason: 'the weekly slate has started; a whole-week pregame snapshot cannot be reconstructed' };
  }
  const projections = buildPlayerWeekEngine({ season, week, scoring });
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT OR IGNORE INTO weekly_prediction_snapshots
    (season,week,player_id,position,as_of,cutoff,engine_version,structural,season_to_date,last3,last1,median,
     prediction,lower_80,upper_80,weights_json,weight_fit,candidate_version,candidate_heads_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let captured = 0;
  db.exec('BEGIN');
  try {
    for (const projection of projections.values()) {
      const engine = projection.player_week_engine;
      if (!engine?.heads) continue;
      const dist = playerWeekDistribution(projection, { scoring, runs });
      captured += insert.run(season, week, projection.player_id, projection.position, now, engine.cutoff,
        engine.version, engine.heads.structural, engine.heads.season_to_date, engine.heads.last3,
        engine.heads.last1, engine.heads.median, projection.ppg, dist.p10, dist.p90,
        JSON.stringify(engine.weights), engine.weight_fit, projection.candidate_head_version,
        JSON.stringify(projection.candidate_heads)).changes;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { captured, season, week, as_of: now, first_kickoff: firstKickoff?.toISOString() ?? null };
}

function candidateForwardScoreboard() {
  const settled = rows(`SELECT position,prediction,actual,candidate_version,candidate_heads_json
                        FROM weekly_prediction_snapshots
                        WHERE actual IS NOT NULL AND candidate_heads_json IS NOT NULL
                        ORDER BY season,week,player_id`);
  const baselinePairs = settled.map(x => ({ pred: Number(x.prediction), act: Number(x.actual) }));
  const baselineMae = settled.length
    ? settled.reduce((sum, x) => sum + Math.abs(Number(x.prediction) - Number(x.actual)), 0) / settled.length
    : null;
  const baselineRank = settled.length ? spearman(baselinePairs) : null;
  const candidates = PLAYER_HEADS.map(head => {
    const use = settled.flatMap(x => {
      try {
        const values = JSON.parse(x.candidate_heads_json);
        if (!Object.prototype.hasOwnProperty.call(values, head.id)) return [];
        const pred = Number(values[head.id]);
        return Number.isFinite(pred) ? [{ pred, act: Number(x.actual) }] : [];
      } catch { return []; }
    });
    const candidateMae = use.length
      ? use.reduce((sum, x) => sum + Math.abs(x.pred - x.act), 0) / use.length
      : null;
    const candidateRank = use.length ? spearman(use) : null;
    return {
      id: head.id, name: head.name, family: head.family, n: use.length,
      mae: candidateMae == null ? null : +candidateMae.toFixed(4),
      mae_delta_vs_champion: candidateMae == null || baselineMae == null
        ? null : +(candidateMae - baselineMae).toFixed(4),
      spearman: candidateRank,
      rank_delta_vs_champion: candidateRank == null || baselineRank == null
        ? null : +(candidateRank - baselineRank).toFixed(4),
      eligible_for_review: use.length >= 250 && candidateMae <= baselineMae - 0.005
        && candidateRank >= baselineRank - 0.002,
      authority: 'shadow_only'
    };
  }).sort((a, b) => (a.mae ?? Infinity) - (b.mae ?? Infinity));
  return {
    registry_version: PLAYER_HEAD_REGISTRY_VERSION,
    settled: settled.length,
    minimum_before_review: 250,
    champion: {
      n: settled.length,
      mae: baselineMae == null ? null : +baselineMae.toFixed(4),
      spearman: baselineRank
    },
    candidates,
    note: 'Forward snapshots are first-write immutable. A review-eligible challenger is not automatically promoted.'
  };
}

export function settleWeeklyPredictions() {
  const pending = rows('SELECT * FROM weekly_prediction_snapshots WHERE actual IS NULL ORDER BY season,week');
  const update = db.prepare(`UPDATE weekly_prediction_snapshots
    SET actual=?, settled_at=datetime('now') WHERE season=? AND week=? AND player_id=? AND actual IS NULL`);
  let settled = 0;
  db.exec('BEGIN');
  try {
    for (const snapshot of pending) {
      const outcome = row('SELECT * FROM player_week_usage WHERE season=? AND week=? AND player_id=?',
        snapshot.season, snapshot.week, snapshot.player_id);
      if (!outcome) continue;
      settled += update.run(Number(scoreLine(outcome, PPR)), snapshot.season, snapshot.week, snapshot.player_id).changes;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { pending: pending.length, settled };
}

export function retrainWeeklyWeights({ minSettled = 250, maxRows = 2400 } = {}) {
  const all = rows(`SELECT * FROM weekly_prediction_snapshots WHERE actual IS NOT NULL
                    AND season_to_date IS NOT NULL ORDER BY season,week,player_id`)
    .slice(-maxRows);
  if (all.length < minSettled) return { trained: false, reason: `need ${minSettled} settled snapshots`, settled: all.length };
  const hash = crypto.createHash('sha256').update(JSON.stringify(all.map(x =>
    [x.season, x.week, x.player_id, x.actual, x.structural, x.season_to_date, x.last3, x.last1, x.median]))).digest('hex');
  const existing = row('SELECT id,promoted FROM weekly_ensemble_fits WHERE data_hash=?', hash);
  if (existing) return { trained: false, reason: 'this settled dataset was already evaluated', fit_id: existing.id };

  const split = Math.max(1, Math.floor(all.length * 0.8));
  const train = all.slice(0, split), validation = all.slice(split);
  const champion = activeWeeklyWeightSet();
  const candidate = {};
  for (const position of ['QB', 'RB', 'WR', 'TE']) {
    candidate[position] = fitPosition(train.filter(x => x.position === position), champion.weights[position]);
  }
  const candidateFn = x => predict(candidate[x.position] ?? champion.weights[x.position], x);
  const championFn = x => predict(champion.weights[x.position], x);
  const candidateMae = mae(validation, candidateFn), championMae = mae(validation, championFn);
  const candidateRank = rank(validation, candidateFn), championRank = rank(validation, championFn);
  const covered = validation.filter(x => {
    if (x.lower_80 == null || x.upper_80 == null) return false;
    const shift = candidateFn(x) - x.prediction;
    return x.actual >= x.lower_80 + shift && x.actual <= x.upper_80 + shift;
  });
  const withIntervals = validation.filter(x => x.lower_80 != null && x.upper_80 != null);
  const coverage = withIntervals.length ? covered.length / withIntervals.length : null;
  const promoted = validation.length >= 100 && candidateMae <= championMae - 0.005
    && candidateRank >= championRank - 0.001 && coverage != null && coverage >= 0.78 && coverage <= 0.82;
  const last = all.at(-1);
  const rejection = promoted ? null
    : `gate failed: mae ${candidateMae.toFixed(4)} vs ${championMae.toFixed(4)}, ` +
      `rank ${candidateRank} vs ${championRank}, coverage ${coverage?.toFixed(3) ?? 'n/a'}`;
  const saved = saveWeeklyFit({
    data_hash: hash, through_season: last.season, through_week: last.week,
    weights: candidate, sample_size: all.length, validation_size: validation.length,
    candidate_mae: candidateMae, champion_mae: championMae,
    candidate_spearman: candidateRank, champion_spearman: championRank,
    coverage_80: coverage, promoted, rejection_reason: rejection
  });
  if (promoted) clearPlayerWeekEngineCache();
  return { trained: true, ...saved };
}

export function weeklyLearningStatus() {
  return {
    snapshots: row(`SELECT COUNT(*) AS total, SUM(actual IS NOT NULL) AS settled,
                           MAX(as_of) AS latest_capture FROM weekly_prediction_snapshots`),
    champion: activeWeeklyWeightSet(),
    fits: weeklyFitHistory(10),
    candidate_heads: candidateForwardScoreboard()
  };
}

export function currentNflWeek(season = Number(process.env.NFL_SEASON) || new Date().getFullYear()) {
  const upcoming = row(`SELECT MIN(week) AS week FROM game_lines
                        WHERE season=? AND team_score IS NULL`, season)?.week;
  return { season, week: Number(process.env.NFL_WEEK) || upcoming || 1 };
}

export function runWeeklyLearningCycle() {
  const current = currentNflWeek();
  return {
    current,
    capture: captureWeeklyPredictions(current.season, current.week),
    settlement: settleWeeklyPredictions(),
    training: retrainWeeklyWeights()
  };
}
