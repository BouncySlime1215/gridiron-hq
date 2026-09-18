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
import {
  activeWeeklyWeightSet, latestWeeklyWeightSet, saveWeeklyFit, storedEarlyWeights, weeklyFitDataHash, weeklyFitHistory
} from './weekly-weight-store.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
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
  /*
   * Only rows the per-position vector is actually served for. Inside the stored
   * early-week window (weeks 2-4) production serves the early buckets, which this
   * retrain does not refit and saveWeeklyFit carries forward unchanged. Fitting or
   * grading the vector on those rows scores it where it never runs: on the live table,
   * whose only settled rows will be 2026 week 2, the champion was graded as fit-1's
   * vector (the blend known to lose at week 2), so a candidate fit on week-2 rows
   * cleared the gate and would have been served at weeks 5-18. The pass rule below is
   * unchanged; only the population is restricted to where the candidate would run.
   */
  const early = storedEarlyWeights();
  const [earlyFrom, earlyTo] = Array.isArray(early?.weeks) ? early.weeks : [];
  const inEarlyWindow = x => early != null && x.week >= earlyFrom && x.week <= earlyTo;
  const settled = rows(`SELECT * FROM weekly_prediction_snapshots WHERE actual IS NOT NULL
                    AND season_to_date IS NOT NULL ORDER BY season,week,player_id`);
  const servedByVectors = settled.filter(x => !inEarlyWindow(x));
  const excludedEarly = settled.length - servedByVectors.length;
  const all = servedByVectors.slice(-maxRows);
  if (all.length < minSettled) {
    return {
      trained: false, settled: all.length, excluded_early_window: excludedEarly,
      reason: `need ${minSettled} settled snapshots outside the early-week window` +
        (early ? ` (weeks ${earlyFrom}-${earlyTo} are served by the stored early buckets)` : '')
    };
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify(all.map(x =>
    [x.season, x.week, x.player_id, x.actual, x.structural, x.season_to_date, x.last3, x.last1, x.median]))).digest('hex');
  const existing = row('SELECT id,promoted FROM weekly_ensemble_fits WHERE data_hash=?', weeklyFitDataHash(hash));
  if (existing) return { trained: false, reason: 'this settled dataset was already evaluated', fit_id: existing.id };

  const split = Math.max(1, Math.floor(all.length * 0.8));
  const train = all.slice(0, split), validation = all.slice(split);
  // The champion is the one that was legitimately available BEFORE the validation
  // window — the newest promoted fit trained strictly before its first row. This used
  // to be an uncut `activeWeeklyWeightSet()`, which returned the newest fit regardless
  // of what it was trained on; if that fit had seen the validation rows it graded
  // artificially well and the gate would refuse genuinely better candidates.
  const firstValidation = validation[0];
  const champion = activeWeeklyWeightSet({ season: firstValidation.season, week: firstValidation.week });
  /*
   * GLOBAL architecture only: one convex vector shared by every position. This used
   * to fit a separate vector per position unconditionally, which is the architecture
   * the promotion script's own 2024 discovery step did NOT select (global 4.4284 vs
   * position 4.4310, and the stored champion's data_hash reads `phase1a:global:...`).
   * On <= 2,400 settled rows that is ~600 per position with four free parameters each,
   * which is exactly the regime where a lucky fit clears a small threshold by chance.
   * Re-introduce per-position only if a fresh discovery step re-selects it. The vector
   * is stored replicated per position because a bare array would make
   * weeklyEnsemblePrediction() fall through to the structural head for every player.
   */
  const globalFallback = champion.weights.WR ?? champion.weights[Object.keys(champion.weights)[0]];
  const globalWeights = fitPosition(train, globalFallback);
  const candidate = Object.fromEntries(['QB', 'RB', 'WR', 'TE'].map(position => [position, globalWeights]));
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
  /*
   * Significance, not a fixed margin. The gate used to be `candidateMae <= championMae
   * - 0.005`: an unfitted threshold with no test at all, on the SAME table that
   * scripts/promote-weekly-ensemble.mjs writes to under a paired bootstrap against two
   * baselines. A second, weaker door into one table means the weaker door decides.
   * This is now the same test the promotion script uses, clustered by player: the
   * validation rows are ~a few hundred players observed over several weeks each, and
   * resampling player-weeks as if independent narrows the interval by ~30% (measured
   * on 2025). The candidate must be significantly better than the champion.
   */
  const significance = pairedBootstrapDiff(
    validation.map(x => Math.abs(championFn(x) - x.actual)),
    validation.map(x => Math.abs(candidateFn(x) - x.actual)),
    { seed: 20260917, groups: validation.map(x => x.player_id) }
  );
  const significantlyBetter = !significance.error && significance.significant && significance.mean_diff < 0;
  const promoted = validation.length >= 100 && significantlyBetter
    && candidateRank >= championRank - 0.001 && coverage != null && coverage >= 0.78 && coverage <= 0.82;
  const last = all.at(-1);
  const rejection = promoted ? null
    : `gate failed: mae ${candidateMae.toFixed(4)} vs ${championMae.toFixed(4)} ` +
      `(player-clustered ci90 ${JSON.stringify(significance.ci90 ?? significance.error)}), ` +
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
    // Display only: the newest promoted fit, uncut. Never grade or predict with it.
    champion: latestWeeklyWeightSet(),
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
