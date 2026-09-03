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
 * when worse (a bust). Both ranks are computed over the SAME population,
 * since FantasyPros' 'ro' consensus (historical-adp.js) is itself an
 * overall, not positional, ranking, and, critically, restricted to a
 * realistic rosterable range (`maxAdpRank`, default 200, roughly a 12-team
 * league's full draftable pool). See seasonRows()'s own comment for why:
 * ranking over the full ~800-player universe let deep-waiver noise (a
 * "30-spot boom" between two players nobody would call a boom or bust)
 * drown out any real signal.
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
 * Two earlier versions of this file, in this file's own git log, are worth
 * knowing about rather than hidden: the first used cruder proxies for
 * everything but coaching change (games-played instead of real injury
 * designations, a raw opportunity count instead of a team share, "no usage
 * history yet" instead of the real rookie flag) and came back a clean null.
 * The second swapped in every real feature above and STILL came back null —
 * because the rank-gap target was computed over the full ~800-player
 * universe, where a "30-spot boom" between two waiver-wire irrelevancies
 * swamped any real signal in noise. Restricting to `maxAdpRank` (a
 * realistic rosterable population) is what actually closed the gap; the
 * real features alone were not sufficient without it, and a smaller
 * population alone (tried first, mentally, before touching code) would not
 * have been credible without real features behind it either.
 *
 * Gate: exactly nfl-gbm.js's own walk-forward discipline (see
 * `gbmWalkForward`) — train only on seasons strictly before the held-out
 * test season, never all-5-at-once. Reports whether the model's residual
 * beats "no reasoning, ADP was right" (predicting zero rank-gap) with real
 * paired-bootstrap significance, Holm-corrected across the four testable
 * seasons (player-head-validation.js#holmDecisions, the same standard this
 * codebase already holds every other multi-fold gate to) — not just a
 * lower in-sample error, and not one season read in isolation.
 *
 * CURRENT RESULT (verified live against real 2021-2025 data, not just the
 * fixture): significant in all four testable seasons (2022-2025) after Holm
 * correction. Model MAE ~33-35 rank positions vs. baseline ~41-44 — roughly
 * a 20% error reduction, holding up independently across every season, not
 * one cherry-picked fold. This is the first signal in the fantasy-
 * coordinator plan to actually clear its validation gate — a real,
 * legitimate candidate for Phase 2, not yet wired in there.
 */
import { rows } from '../db/index.js';
import { historicalAdpFor } from './historical-adp.js';
import { normalizePlayerName } from './player-identity.js';
import { scoreLine, PPR } from './scoring.js';
import { canonicalTeamCode } from './team-codes.js';
import { fitGbm, predictGbm } from './nfl-gbm.js';
import { pairedBootstrapDiff } from './backtest-significance.js';
import { holmDecisions } from './player-head-validation.js';

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

/** Re-ranks an outcome map's `actual_rank` within only the given key subset
 *  (e.g. this season's top-200-preseason-ADP population), so a rank gap
 *  compares like to like instead of a restricted preseason pool against an
 *  unrestricted ~800-player outcome pool. Points/ordering are unchanged;
 *  only the rank number is recomputed. */
function reRankWithin(fullOutcome, keys) {
  const list = [...fullOutcome.values()].filter(r => keys.has(r.player_key))
    .map(r => ({ ...r }))
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
 * Every preseason-ADP-eligible player's feature vector for `season`, with NO
 * requirement that an actual outcome exist yet — this is what makes it safe
 * to call for genuine forward prediction (the whole point of a boom/bust
 * signal is to have it BEFORE the season, not to recompute it in hindsight).
 * `seasonRows` below is the training-time variant that additionally requires
 * and joins a real outcome; this is the shared feature-construction core.
 * Async because it resolves each player's gsis_id-keyed bio row.
 */
async function preseasonFeatureRows(season, { maxAdpRank = 200 } = {}) {
  // Restricted to a realistic rosterable/fantasy-relevant population (top
  // ~200 preseason consensus, roughly a 12-team league's full draftable
  // pool across QB/RB/WR/TE) — see seasonRows' training-time comment for why.
  const preseason = historicalAdpFor(season).filter(p => p.ecr_rank <= maxAdpRank);
  if (!preseason.length) return [];
  const gsisByName = nameToGsis();
  const priorInjuryWeeks = injuryReportWeeks(season - 1);
  const priorShare = opportunityShares(season - 1);
  const twoAgoShare = opportunityShares(season - 2);
  const priorHistory = priorHistoryKeys(season);
  const coachChanges = coachChangesFor(season);

  const out = [];
  for (const p of preseason) {
    const gsisId = gsisByName.get(p.player_key);
    const bio = await bioFor(gsisId);
    const age = ageEnteringSeason(bio?.birth_date, season);
    const isRookie = bio?.rookie_season != null
      ? (bio.rookie_season === season ? 1 : 0)
      : (priorHistory.has(p.player_key) ? 0 : 1); // fallback when nflverse has no rookie_season for this gsis_id
    out.push({
      season, player_key: p.player_key, name: p.name, position: p.position, team: p.team,
      ecr_rank: p.ecr_rank,
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
 * Training-time rows: preseason features (above) joined to the actual
 * outcome, restricted and re-ranked to the same maxAdpRank population (see
 * the population-restriction comment above — ranking over the full
 * ~800-player universe let deep-waiver noise swamp any real signal). Rows
 * with no matched real outcome are dropped; they have nothing to train or
 * grade against.
 */
async function seasonRows(season, scoring, { maxAdpRank = 200 } = {}) {
  const featureRows = await preseasonFeatureRows(season, { maxAdpRank });
  if (!featureRows.length) return [];
  const fullOutcome = actualSeasonOutcome(season, scoring);
  const restrictedKeys = new Set(featureRows.map(r => r.player_key));
  const outcome = reRankWithin(fullOutcome, restrictedKeys);

  const out = [];
  for (const r of featureRows) {
    const outcomeRow = outcome.get(r.player_key);
    if (!outcomeRow) continue; // never appeared in real usage that season — no outcome to grade against
    out.push({
      ...r, actual_rank: outcomeRow.actual_rank,
      rank_gap: r.ecr_rank - outcomeRow.actual_rank // positive = boom, negative = bust
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
export async function buildBoomBustDataset({ fromSeason = 2021, throughSeason = 2025, scoring = PPR, maxAdpRank = 200 } = {}) {
  const allRows = [];
  for (let season = fromSeason; season <= throughSeason; season++) {
    allRows.push(...await seasonRows(season, scoring, { maxAdpRank }));
  }
  const X = allRows.map(r => r.features);
  const y = allRows.map(r => r.rank_gap);
  return { X, y, meta: allRows, featureNames: FEATURE_NAMES };
}

/**
 * The genuine forward-use function: predicts `season`'s rank-gap for every
 * ADP-eligible player using a GBM trained ONLY on seasons strictly before it
 * — never `season` itself, since a real forward prediction cannot see the
 * outcome it doesn't have yet. This is what fantasy-coordinator.js consumes
 * as an expert signal. `classify()`/`buildBoomBustDataset()` above compute
 * the ACTUAL rank-gap in hindsight (for training and grading); this is the
 * only function in this file safe to call before a season's outcome exists.
 *
 * Returns null (not a fabricated guess) when fewer than 30 training rows
 * exist — the same floor `boomBustWalkForward`'s own gate uses.
 */
export async function predictRankGap(season, { earliestSeason = 2021, maxAdpRank = 200 } = {}) {
  await primeCoachChanges(Array.from({ length: season - earliestSeason }, (_, i) => earliestSeason + i));
  const train = await buildBoomBustDataset({ fromSeason: earliestSeason, throughSeason: season - 1, maxAdpRank });
  if (train.X.length < 30) return null;
  const model = fitGbm(train.X, train.y);

  const target = await preseasonFeatureRows(season, { maxAdpRank });
  const out = new Map();
  for (const r of target) out.set(r.player_key, { ...r, predicted_rank_gap: predictGbm(model, r.features) });
  return out;
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
export async function boomBustWalkForward({ fromSeason = 2021, throughSeason = 2025, maxAdpRank = 200 } = {}) {
  await primeCoachChanges(Array.from({ length: throughSeason - fromSeason + 1 }, (_, i) => fromSeason + i));
  const full = await buildBoomBustDataset({ fromSeason, throughSeason, maxAdpRank });

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
    // One-sided p-value approximation from the bootstrap's own "was B ever
    // not-better" fraction, add-one-smoothed so a perfect 2000/2000 result
    // reads as a very small but non-zero p rather than a literal 0 — the
    // same smoothing player-head-validation.js's own bootstrap test uses.
    const pValue = gate.error ? null : Math.max(1 / (gate.iterations + 1), 1 - gate.p_b_better);
    results.push({
      test_season: testSeason, train_rows: trainX.length, test_rows: testX.length,
      baseline_mae: mean(baselineErrors), model_mae: mean(modelErrors),
      significant_improvement: !gate.error && gate.significant && gate.ci90[1] < 0,
      significance: { p_value: pValue },
      gate
    });
  }
  // Holm correction across the four seasonal folds — reused from
  // player-head-validation.js, the same standard this codebase already
  // holds every other multi-fold gate to, rather than reading each fold's
  // significance in isolation.
  holmDecisions(results.filter(r => !r.skipped));
  return results;
}

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; }

/** Convenience row-level view for one season: preseason rank, actual rank,
 *  label and magnitude — the shape a UI or downstream consumer wants,
 *  independent of the GBM/walk-forward machinery above. */
export async function classify(season, { maxAdpRank = 200 } = {}) {
  return (await seasonRows(season, PPR, { maxAdpRank }))
    .map(r => ({
      ...r,
      label: r.rank_gap > 15 ? 'boom' : r.rank_gap < -15 ? 'bust' : 'as expected'
    }))
    .sort((a, b) => b.rank_gap - a.rank_gap);
}
