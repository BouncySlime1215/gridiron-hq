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
 * predicted:
 *   - real age entering the season (nflverse's players.csv birth_date,
 *     nflverse.js#nflversePlayerBio — not a proxy)
 *   - real rookie flag (nflverse's own rookie_season field, not "first year
 *     we happen to have usage data on him")
 *   - prior-season injury-report burden (nfl_injuries — weeks actually
 *     listed with a real designation, not a games-played proxy)
 *   - a team-SHARE trend across the two prior seasons (own opportunities /
 *     that team's total opportunities that season — a true share, not a raw
 *     count that conflates "more competitive team" with "bigger role")
 *   - whether the team the market had him on entering the season just
 *     changed head coaches (nfl-coaches.js, real per-team-season history)
 *
 * An earlier version of this file used cruder proxies for all but the last
 * of these (games-played instead of real injury designations, a raw
 * opportunity count instead of a team share, "no usage history yet" instead
 * of the real rookie flag) and its walk-forward gate came back a clean null
 * — see docs/WORK_LOG.md-style history in this file's git log. This version
 * exists to find out whether that was a real ceiling or just weak features.
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

/** normalized name -> gsis_id, so historical-adp.js's name-only rows (see its
 *  own doc-comment on why it keeps no player_id) can reach nflverse's bio
 *  table. Only players with a gsis_id are useful here, same convention as
 *  nflverse.js's own crosswalk. */
function nameToGsis() {
  const list = rows(`SELECT name, gsis_id FROM players WHERE gsis_id IS NOT NULL`);
  const map = new Map();
  for (const p of list) map.set(normalizePlayerName(p.name), p.gsis_id);
  return map;
}

/** Real age as of September 1 of `season` (the standard "age entering the
 *  season" convention) from a birth_date string (YYYY-MM-DD). Null when the
 *  birth date itself is missing rather than guessed. */
function ageEnteringSeason(birthDate, season) {
  if (!birthDate) return null;
  const [by, bm] = birthDate.split('-').map(Number);
  if (!Number.isFinite(by)) return null;
  const turnsAgeThisYear = (bm ?? 1) <= 9; // birthday falls on/before Sept 1
  return season - by - (turnsAgeThisYear ? 0 : 1);
}

/**
 * Real per-player, per-team-share of that team's total opportunities
 * (attempts+carries+targets) for a season — not a raw count, so a bigger
 * role reads as a bigger role regardless of how run-heavy or pass-heavy the
 * team as a whole is. Keyed by normalized name (see nameToGsis's comment).
 */
function opportunityShares(season) {
  const weeks = rows(`SELECT p.name, u.team,
      (COALESCE(u.attempts,0)+COALESCE(u.carries,0)+COALESCE(u.targets,0)) AS opp
    FROM player_week_usage u JOIN players p ON p.id = u.player_id WHERE u.season = ?`, season);
  const byPlayer = new Map(); // key -> { team -> opp } (most-used team wins ties)
  const byTeam = new Map();   // team -> total opp
  for (const w of weeks) {
    if (!w.team) continue;
    const key = normalizePlayerName(w.name);
    if (!key) continue;
    const perTeam = byPlayer.get(key) ?? new Map();
    perTeam.set(w.team, (perTeam.get(w.team) ?? 0) + w.opp);
    byPlayer.set(key, perTeam);
    byTeam.set(w.team, (byTeam.get(w.team) ?? 0) + w.opp);
  }
  const shares = new Map();
  for (const [key, perTeam] of byPlayer) {
    let team = null, own = 0;
    for (const [t, opp] of perTeam) if (opp > own) { team = t; own = opp; }
    const teamTotal = byTeam.get(team) ?? 0;
    shares.set(key, teamTotal > 0 ? own / teamTotal : 0);
  }
  return shares;
}

/**
 * Real weeks a player was listed on the injury report at all in `season` —
 * a genuine designation-based burden, not a "weeks he happened not to play"
 * proxy (which conflates injury with a bye week, a healthy scratch, or
 * simply not being on a roster that week).
 */
function injuryReportWeeks(season) {
  const list = rows(`SELECT full_name, COUNT(DISTINCT week) AS weeks FROM nfl_injuries
                     WHERE season = ? AND report_status IS NOT NULL AND report_status != ''
                     GROUP BY full_name`, season);
  const byKey = new Map();
  for (const r of list) byKey.set(normalizePlayerName(r.full_name), r.weeks);
  return byKey;
}

/** Whether ANY usage row exists for this player before `season` at all — a
 *  fallback rookie signal for players nflverse's own rookie_season field
 *  doesn't resolve (kept only as a fallback now that the real flag exists;
 *  see FEATURE_NAMES). */
function priorHistoryKeys(beforeSeason) {
  const rowsBySeason = rows(`SELECT DISTINCT p.name FROM player_week_usage u
    JOIN players p ON p.id = u.player_id WHERE u.season < ?`, beforeSeason);
  return new Set(rowsBySeason.map(r => normalizePlayerName(r.name)));
}

const FEATURE_NAMES = [
  'ecr_rank', 'age_entering_season', 'is_rookie_season', 'prior_injury_report_weeks',
  'opportunity_share_trend', 'coaching_change'
];

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

let bioLookup = null;
async function bioFor(gsisId) {
  if (!gsisId) return null;
  if (!bioLookup) bioLookup = (await import('./nflverse.js')).nflversePlayerBio;
  return bioLookup(gsisId);
}

/**
 * One season's rows: preseason ECR joined to actual outcome, with the
 * walk-forward-safe feature set above. Every feature here is computable from
 * information available before `season` starts (historical-adp.js's ECR is
 * itself a preseason scrape; prior-season injury/share data is by definition
 * from the season before; age and rookie status are fixed historical facts).
 * Async because it resolves each player's gsis_id-keyed bio row.
 */
async function seasonRows(season, scoring) {
  const preseason = historicalAdpFor(season);
  if (!preseason.length) return [];
  const outcome = actualSeasonOutcome(season, scoring);
  const gsisByName = nameToGsis();
  const priorInjuryWeeks = injuryReportWeeks(season - 1);
  const priorShare = opportunityShares(season - 1);
  const twoAgoShare = opportunityShares(season - 2);
  const priorHistory = priorHistoryKeys(season);
  const coachChanges = coachChangesFor(season);

  const out = [];
  for (const p of preseason) {
    const outcomeRow = outcome.get(p.player_key);
    if (!outcomeRow) continue; // never appeared in real usage that season — no outcome to grade against
    const gsisId = gsisByName.get(p.player_key);
    const bio = await bioFor(gsisId);
    const age = ageEnteringSeason(bio?.birth_date, season);
    const isRookie = bio?.rookie_season != null
      ? (bio.rookie_season === season ? 1 : 0)
      : (priorHistory.has(p.player_key) ? 0 : 1); // fallback when nflverse has no rookie_season for this gsis_id
    out.push({
      season, player_key: p.player_key, name: p.name, position: p.position,
      ecr_rank: p.ecr_rank, actual_rank: outcomeRow.actual_rank,
      rank_gap: p.ecr_rank - outcomeRow.actual_rank, // positive = boom, negative = bust
      features: [
        p.ecr_rank,
        age ?? -1, // -1 (not 0/mean) so a missing birth_date is distinguishable to the tree, not a fabricated age
        isRookie,
        priorInjuryWeeks.get(p.player_key) ?? 0,
        (priorShare.get(p.player_key) ?? 0) - (twoAgoShare.get(p.player_key) ?? 0),
        coachChanges.has(canonicalTeamCode(p.team)) && coachChanges.get(canonicalTeamCode(p.team)).changed ? 1 : 0
      ]
    });
  }
  return out;
}

/**
 * Every season's boom/bust rows in [fromSeason, throughSeason], with the
 * GBM-ready feature matrix. `primeCoachChanges` must be awaited first if
 * the coaching-change feature is wanted (kept a separate async priming step
 * so the coaching lookup itself stays synchronous per-row, matching
 * nfl-gbm.js#buildGbmDataset's own structure).
 */
export async function buildBoomBustDataset({ fromSeason = 2021, throughSeason = 2025, scoring = PPR } = {}) {
  const allRows = [];
  for (let season = fromSeason; season <= throughSeason; season++) {
    allRows.push(...await seasonRows(season, scoring));
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
  const full = await buildBoomBustDataset({ fromSeason, throughSeason });

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
export async function classify(season) {
  return (await seasonRows(season, PPR))
    .map(r => ({
      ...r,
      label: r.rank_gap > 15 ? 'boom' : r.rank_gap < -15 ? 'bust' : 'as expected'
    }))
    .sort((a, b) => b.rank_gap - a.rank_gap);
}
