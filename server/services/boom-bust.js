/**
 * Boom/bust: how far a player's actual season finish diverged from what the
 * market expected of him preseason, and whether that divergence is
 * predictable from information available before the season started.
 *
 * Phase 1 of the fantasy-coordinator plan (see the plan this session's
 * historical-adp.js Phase 0 belongs to). "Boom" and "bust" are expressed as a
 * RANK gap, not a raw point gap — a preseason WR13 who finishes WR30 busted,
 * and a raw fantasy-point number means nothing without that positional
 * context. Concretely: `ecr_rank(preseason) - actual_rank(season)`, positive
 * when a player finished better than the market thought (a boom), negative
 * when worse (a bust). Both ranks are computed over the SAME overall
 * fantasy-relevant population, since FantasyPros' 'ro' consensus
 * (historical-adp.js) is itself an overall, not positional, ranking.
 *
 * The "figure out the reasoning" half fits nfl-gbm.js's existing, walk-
 * forward-safe gradient-boosted trees (reused, not reinvented) against that
 * rank-gap target, using only features knowable BEFORE the season being
 * predicted: prior-season workload/availability, a share trend across the
 * two prior seasons, whether the player has any usage history at all yet
 * (a rookie/first-year-in-data proxy), and whether the team the market had
 * him on entering the season just changed head coaches (nfl-coaches.js,
 * real per-team-season history back to 2015).
 *
 * Gate: exactly nfl-gbm.js's own walk-forward discipline (see
 * `gbmWalkForward`) — train only on seasons strictly before the held-out
 * test season, never all-5-at-once. Reports whether the model's residual
 * beats "no reasoning, ADP was right" (predicting zero rank-gap) with real
 * paired-bootstrap significance, not just a lower in-sample error.
 */
import { rows } from '../db/index.js';
import { historicalAdpFor } from './historical-adp.js';
import { normalizePlayerName } from './player-identity.js';
import { scoreLine, PPR } from './scoring.js';
import { canonicalTeamCode } from './team-codes.js';
import { fitGbm, predictGbm } from './nfl-gbm.js';
import { pairedBootstrapDiff } from './backtest-significance.js';

const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

/**
 * Every player's actual total fantasy points for a season, from real weekly
 * usage (player_week_usage — nflverse, 2021-2025 confirmed present), ranked
 * overall across QB/RB/WR/TE — the same population historical-adp.js's
 * redraft-overall consensus describes.
 */
function actualSeasonOutcome(season, scoring = PPR) {
  const weeks = rows(`SELECT u.*, p.name, p.position AS current_position
                      FROM player_week_usage u JOIN players p ON p.id = u.player_id
                      WHERE u.season = ?`, season);
  const byPlayer = new Map();
  for (const w of weeks) {
    const pos = w.position || w.current_position;
    if (!FANTASY_POSITIONS.has(pos)) continue;
    const key = normalizePlayerName(w.name);
    if (!key) continue;
    const acc = byPlayer.get(key) ?? { name: w.name, position: pos, points: 0, weeks_played: 0 };
    acc.points += Number(scoreLine(w, scoring));
    acc.weeks_played += 1;
    byPlayer.set(key, acc);
  }
  const list = [...byPlayer.entries()].map(([key, v]) => ({ player_key: key, ...v }))
    .sort((a, b) => b.points - a.points);
  list.forEach((r, i) => { r.actual_rank = i + 1; });
  return new Map(list.map(r => [r.player_key, r]));
}

/**
 * Games a player actually appeared in during `season` — a genuine
 * availability signal (injury, suspension, benching), not assumed from age
 * or position. Keyed by normalized name, same as opportunityTotals() below,
 * since historical-adp.js's rows carry no player_id to join on directly.
 */
function gamesPlayed(season) {
  const rowsBySeason = rows(`SELECT p.name, COUNT(*) AS games FROM player_week_usage u
                             JOIN players p ON p.id = u.player_id
                             WHERE u.season = ? GROUP BY u.player_id`, season);
  const byKey = new Map();
  for (const r of rowsBySeason) byKey.set(normalizePlayerName(r.name), r.games);
  return byKey;
}

/** Total opportunities (attempts+carries+targets) per player-season — a
 *  volume proxy that doesn't require computing full team-share denominators
 *  for a first pass. */
function opportunityTotals(season) {
  const rowsBySeason = rows(`SELECT player_id, name,
      SUM(COALESCE(attempts,0)+COALESCE(carries,0)+COALESCE(targets,0)) AS opportunities
    FROM player_week_usage u JOIN players p ON p.id = u.player_id
    WHERE season = ? GROUP BY player_id`, season);
  const byKey = new Map();
  for (const r of rowsBySeason) byKey.set(normalizePlayerName(r.name), r.opportunities);
  return byKey;
}

/** Whether ANY usage row exists for this player before `season` — a proxy
 *  for "first year we have data on him," not literal rookie status (a
 *  veteran who entered the league before 2021 reads the same way; stated
 *  as a limitation, not hidden). */
function priorHistoryKeys(beforeSeason) {
  const rowsBySeason = rows(`SELECT DISTINCT p.name FROM player_week_usage u
    JOIN players p ON p.id = u.player_id WHERE u.season < ?`, beforeSeason);
  return new Set(rowsBySeason.map(r => normalizePlayerName(r.name)));
}

const FEATURE_NAMES = ['ecr_rank', 'prior_games_played', 'opportunity_trend', 'is_first_year_in_data', 'coaching_change'];

/**
 * One season's rows: preseason ECR joined to actual outcome, with the
 * walk-forward-safe feature set above. Every feature here is computable from
 * information available before `season` starts (historical-adp.js's ECR is
 * itself a preseason scrape; prior-season workload/opportunity is by
 * definition from the season before).
 */
function seasonRows(season, scoring) {
  const preseason = historicalAdpFor(season);
  if (!preseason.length) return [];
  const outcome = actualSeasonOutcome(season, scoring);
  const priorOpportunity = opportunityTotals(season - 1);
  const twoAgoOpportunity = opportunityTotals(season - 2);
  const priorGames = gamesPlayed(season - 1);
  const priorHistory = priorHistoryKeys(season);
  const coachChanges = coachChangesFor(season);

  const out = [];
  for (const p of preseason) {
    const outcomeRow = outcome.get(p.player_key);
    if (!outcomeRow) continue; // never appeared in real usage that season — no outcome to grade against
    const priorOpp = priorOpportunity.get(p.player_key) ?? 0;
    const twoAgoOpp = twoAgoOpportunity.get(p.player_key) ?? 0;
    const priorGamesPlayed = priorGames.get(p.player_key) ?? 0;
    out.push({
      season, player_key: p.player_key, name: p.name, position: p.position,
      ecr_rank: p.ecr_rank, actual_rank: outcomeRow.actual_rank,
      rank_gap: p.ecr_rank - outcomeRow.actual_rank, // positive = boom, negative = bust
      features: [
        p.ecr_rank,
        priorGamesPlayed,
        priorOpp - twoAgoOpp,
        priorHistory.has(p.player_key) ? 0 : 1,
        coachChanges.has(canonicalTeamCode(p.team)) && coachChanges.get(canonicalTeamCode(p.team)).changed ? 1 : 0
      ]
    });
  }
  return out;
}

function coachChangesFor(season) {
  // Lazy import: nfl-coaches.js is a shared-engine file with its own broader
  // import surface; loaded here only when a boom/bust dataset is actually built.
  return coachChangesCache.get(season) ?? new Map();
}
const coachChangesCache = new Map();
export async function primeCoachChanges(seasons) {
  const { coachChanges } = await import('./nfl-coaches.js');
  for (const season of seasons) coachChangesCache.set(season, coachChanges(season));
}

/**
 * Every season's boom/bust rows in [fromSeason, throughSeason], with the
 * GBM-ready feature matrix. `primeCoachChanges` must be awaited first if
 * the coaching-change feature is wanted (kept a separate async step so this
 * function itself stays synchronous, matching nfl-gbm.js#buildGbmDataset).
 */
export function buildBoomBustDataset({ fromSeason = 2021, throughSeason = 2025, scoring = PPR } = {}) {
  const allRows = [];
  for (let season = fromSeason; season <= throughSeason; season++) {
    allRows.push(...seasonRows(season, scoring));
  }
  const X = allRows.map(r => r.features);
  const y = allRows.map(r => r.rank_gap);
  return { X, y, meta: allRows, featureNames: FEATURE_NAMES };
}

/**
 * Walk-forward gate: train on every season strictly before each held-out
 * test season, never all seasons at once. Reports whether the model's
 * residual on the held-out season beats "ADP was right, no adjustment"
 * (predicting a zero rank-gap) with real paired-bootstrap significance —
 * the same standard nfl-props.js#allBaselineGates and nfl-gbm.js#gbmWalkForward
 * already hold every other model change to. A season with fewer than 10
 * matched rows is skipped rather than forced through bootstrapping.
 */
export async function boomBustWalkForward({ fromSeason = 2021, throughSeason = 2025 } = {}) {
  await primeCoachChanges(Array.from({ length: throughSeason - fromSeason + 1 }, (_, i) => fromSeason + i));
  const full = buildBoomBustDataset({ fromSeason, throughSeason });

  const results = [];
  for (let testSeason = fromSeason + 1; testSeason <= throughSeason; testSeason++) {
    const trainIdx = [], testIdx = [];
    full.meta.forEach((r, i) => {
      if (r.season < testSeason) trainIdx.push(i);
      else if (r.season === testSeason) testIdx.push(i);
      // r.season > testSeason: a later season, not yet relevant to this fold
    });
    const trainX = trainIdx.map(i => full.X[i]), trainY = trainIdx.map(i => full.y[i]);
    const testX = testIdx.map(i => full.X[i]), testY = testIdx.map(i => full.y[i]);
    if (trainX.length < 30 || testX.length < 10) {
      results.push({ test_season: testSeason, skipped: true, reason: `too few rows (train ${trainX.length}, test ${testX.length})` });
      continue;
    }
    const model = fitGbm(trainX, trainY);
    const baselineErrors = testY.map(v => Math.abs(v)); // "predict zero rank-gap"
    const modelErrors = testX.map((x, i) => Math.abs(testY[i] - predictGbm(model, x)));
    // pairedBootstrapDiff(A, B) bootstraps (B - A); A=baseline error, B=model
    // error, so a negative mean_diff whose 90% CI excludes zero on the
    // negative side means the model's error is significantly LOWER.
    const gate = pairedBootstrapDiff(baselineErrors, modelErrors);
    results.push({
      test_season: testSeason, train_rows: trainX.length, test_rows: testX.length,
      baseline_mae: mean(baselineErrors), model_mae: mean(modelErrors),
      significant_improvement: !gate.error && gate.significant && gate.ci90[1] < 0,
      gate
    });
  }
  return results;
}

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }

/** Convenience row-level view for one season: preseason rank, actual rank,
 *  label and magnitude — the shape a UI or downstream consumer wants,
 *  independent of the GBM/walk-forward machinery above. */
export function classify(season) {
  return seasonRows(season, PPR)
    .map(r => ({
      ...r,
      label: r.rank_gap > 15 ? 'boom' : r.rank_gap < -15 ? 'bust' : 'as expected'
    }))
    .sort((a, b) => b.rank_gap - a.rank_gap);
}
