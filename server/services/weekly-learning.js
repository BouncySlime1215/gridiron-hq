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
import { activeWeeklyWeightSet, saveWeeklyFit, weeklyFitDataHash, weeklyFitHistory } from './weekly-weight-store.js';
import { spearman } from './backtest.js';
import { nflKickoffDate } from './date-util.js';
import { nflEngineVersionFor } from './nfl-engine-registry.js';

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
  const gridironVersion = nflEngineVersionFor(season, week);
  const insert = db.prepare(`INSERT OR IGNORE INTO weekly_prediction_snapshots
    (season,week,player_id,position,as_of,cutoff,engine_version,gridiron_engine_version,structural,season_to_date,last3,last1,median,
     prediction,lower_80,upper_80,weights_json,weight_fit,candidate_version,candidate_heads_json,mode)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let captured = 0;
  let coldStart = 0;
  db.exec('BEGIN');
  try {
    for (const projection of projections.values()) {
      const engine = projection.player_week_engine;
      // engine.heads is null when the player has zero prior-week evidence
      // anywhere (a true first-week-of-career cold start) — previously this
      // silently dropped the player from the whole capture with no record.
      // Mirror the fallback pattern in player-head-registry.js (degrade to
      // the structural estimate for every head, never null) so the week
      // still gets a row instead of a silent gap.
      const structuralOnly = !engine?.heads;
      const heads = engine?.heads ?? Object.fromEntries(
        WEEKLY_ENSEMBLE_HEADS.map(head => [head, projection.structural_ppg]));
      if (structuralOnly) coldStart += 1;
      const dist = playerWeekDistribution(projection, { scoring, runs });
      captured += insert.run(season, week, projection.player_id, projection.position, now, engine.cutoff,
        engine.version, gridironVersion, heads.structural, heads.season_to_date, heads.last3,
        heads.last1, heads.median, projection.ppg, dist.p10, dist.p90,
        JSON.stringify(engine.weights), engine.weight_fit, projection.candidate_head_version,
        JSON.stringify(projection.candidate_heads),
        structuralOnly ? 'cold_start_structural_only' : 'position_ensemble').changes;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  // Honest status for the scheduler: nothing was silently skipped (the
  // cold-start rows above are captured, just degraded), so say so instead
  // of leaving `skipped` undefined and letting it read as an unqualified 'ok'.
  return { captured, cold_start_structural_only: coldStart, skipped: false,
    season, week, as_of: now, engine_version: gridironVersion,
    first_kickoff: firstKickoff?.toISOString() ?? null };
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
  const existing = row('SELECT id,promoted FROM weekly_ensemble_fits WHERE data_hash=?', weeklyFitDataHash(hash));
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

// A game missing its score this long after kickoff is no longer "hasn't been
// played yet" — real NFL games (including OT) finish inside this window, and
// ESPN posts finals within minutes after. Past this, a null score is either a
// sync gap or a real data-availability hole, not a game still in progress.
const SCORE_GRACE_HOURS = 6;

/**
 * The schedule's own view of "what week is it": the earliest week whose games
 * are not ALL already in the past (i.e. the week currently underway or next
 * up), derived purely from gameday/gametime — no score data involved. Used as
 * a cross-check against the score-derived week below, and as the fallback
 * when that score-derived value looks wrong (see currentNflWeek).
 */
function scheduleDerivedWeek(season, now = new Date()) {
  const weeks = rows(`SELECT DISTINCT week, gameday, gametime FROM game_lines
                      WHERE season=? AND gameday IS NOT NULL`, season);
  if (!weeks.length) return null;
  const maxKickoffByWeek = new Map();
  for (const w of weeks) {
    const kickoff = nflKickoffDate(w.gameday, w.gametime);
    if (!kickoff) continue;
    const prior = maxKickoffByWeek.get(w.week);
    if (!prior || kickoff > prior) maxKickoffByWeek.set(w.week, kickoff);
  }
  if (!maxKickoffByWeek.size) return null;
  const ordered = [...maxKickoffByWeek.entries()].sort((a, b) => a[0] - b[0]);
  const notYetConcluded = ordered.find(([, maxKickoff]) => maxKickoff.getTime() >= now.getTime());
  return (notYetConcluded ?? ordered.at(-1))[0];
}

export function currentNflWeek(season = Number(process.env.NFL_SEASON) || new Date().getFullYear(), now = new Date()) {
  const scoreWeek = row(`SELECT MIN(week) AS week FROM game_lines
                        WHERE season=? AND team_score IS NULL`, season)?.week ?? null;
  const scheduleWeek = scheduleDerivedWeek(season, now);
  const bestGuess = scoreWeek ?? scheduleWeek ?? 1;

  // Cross-check: of bestGuess's games, how many are missing a score well past
  // their own kickoff? If more than half are, the score-derived signal is
  // unreliable (a stalled/broken sync, not just "week still in progress") and
  // the schedule's own idea of the current week takes over instead.
  const games = rows(`SELECT team_score, gameday, gametime FROM game_lines
                      WHERE season=? AND week=?`, season, bestGuess);
  const graceMs = SCORE_GRACE_HOURS * 60 * 60 * 1000;
  const overdue = games.filter(g => {
    if (g.team_score != null) return false;
    const kickoff = nflKickoffDate(g.gameday, g.gametime);
    return kickoff && (now.getTime() - kickoff.getTime()) > graceMs;
  });
  const looksWrong = games.length > 0 && (overdue.length / games.length) > 0.5;
  const resolved = looksWrong && scheduleWeek != null ? scheduleWeek : bestGuess;

  return {
    season,
    week: Number(process.env.NFL_WEEK) || resolved,
    score_derived_week: scoreWeek,
    schedule_derived_week: scheduleWeek,
    score_signal_flagged: looksWrong
  };
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
