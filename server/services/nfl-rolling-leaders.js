/**
 * Cutoff-safe rolling stat leaderboards — "who led the league in EPA/play
 * through their first 6 games, as known entering week 7" — for EVERY numeric
 * feature `nfl_team_week_features` tracks (178 of them: EPA variants,
 * success rate, explosive-play rate, turnover rate, third/red-zone/drive
 * efficiency, pressure, havoc, and more), not a hand-picked subset.
 *
 * Deliberately wide rather than curated: pre-guessing which of 178 stats
 * "should" matter is exactly the kind of assumption this project's own
 * house style avoids (see nfl-replay.js's header on why hand-picked segment
 * fixes overfit). Instead this feeds ALL of them into `segmentsFor`
 * (nfl-replay.js) as additional segment dimensions, and lets the same
 * machinery already built for that file do the actual filtering: Holm
 * correction across however many segments a run tests, a minimum real
 * effect size, leave-one-season-out robustness, and — for anything that
 * survives all three — Phase 3's requirement of independent re-discovery
 * plus three non-overlapping holdout seasons before it is ever even flagged
 * for a human to look at. Casting a wide net and trusting that pipeline to
 * find what's real over time, rather than curating a shortlist by hand.
 *
 * Every average here is computed from STRICTLY EARLIER weeks of the same
 * season only — this is a leaderboard "as of" a given week, never one that
 * peeks at the week it's being used to judge.
 */
import { rows } from '../db/index.js';

const MIN_GAMES_FOR_RANKING = 2;
const BUCKET_LABELS = ['bottom_quartile', 'lower_middle', 'upper_middle', 'top_quartile'];

const statsCache = new Map();
const bucketsCache = new Map();

/** Every numeric key present in the stored feature JSON, discovered from the
 * data itself rather than a maintained list — if the upstream feature
 * warehouse ever adds or removes a column, this follows it with no edit here. */
function discoverNumericKeys(sampleFeatures) {
  return Object.keys(sampleFeatures).filter(k => typeof sampleFeatures[k] === 'number' && Number.isFinite(sampleFeatures[k]));
}

/**
 * Rolling per-team averages of every numeric stat, using only weeks strictly
 * before `week` in `season`. Returns `Map<team, {statKey: avg|undefined, _games: n}>`.
 * A team with fewer than MIN_GAMES_FOR_RANKING qualifying weeks is OMITTED
 * entirely rather than given a noisy one-game average — the leaderboard
 * for week 2 of a season legitimately has very few qualified teams, and
 * that thinness should be visible, not papered over.
 */
export function rollingTeamStats(season, week) {
  const key = `${season}|${week}`;
  if (statsCache.has(key)) return statsCache.get(key);

  const feat = rows(`SELECT team, features FROM nfl_team_week_features WHERE season=? AND week<?`, season, week);
  const byTeam = new Map();
  for (const row of feat) {
    let parsed; try { parsed = JSON.parse(row.features); } catch { continue; }
    if (!byTeam.has(row.team)) byTeam.set(row.team, []);
    byTeam.get(row.team).push(parsed);
  }

  const result = new Map();
  let sampleFeatures = null;
  for (const list of byTeam.values()) { if (list.length) { sampleFeatures = list[0]; break; } }
  const keys = sampleFeatures ? discoverNumericKeys(sampleFeatures) : [];

  for (const [team, list] of byTeam) {
    if (list.length < MIN_GAMES_FOR_RANKING) continue;
    const avg = { _games: list.length };
    for (const k of keys) {
      const vals = list.map(f => f[k]).filter(v => typeof v === 'number' && Number.isFinite(v));
      if (vals.length) avg[k] = vals.reduce((s, v) => s + v, 0) / vals.length;
    }
    result.set(team, avg);
  }
  statsCache.set(key, result);
  return result;
}

/**
 * Quartile bucket per team per stat, ranked among only the teams that
 * qualify (>= MIN_GAMES_FOR_RANKING) that week. Returns
 * `Map<team, Map<statKey, 'top_quartile'|'upper_middle'|'lower_middle'|'bottom_quartile'>>`.
 * A stat with too few qualifying teams to form real quartiles (early in a
 * season, or a column with sparse coverage) is simply absent from every
 * team's map for that week — never a fabricated bucket.
 */
export function statLeaderboardBuckets(season, week) {
  const key = `${season}|${week}`;
  if (bucketsCache.has(key)) return bucketsCache.get(key);

  const stats = rollingTeamStats(season, week);
  const teams = [...stats.keys()];
  const result = new Map(teams.map(t => [t, new Map()]));
  if (teams.length < 8) { bucketsCache.set(key, result); return result; } // too few teams to rank meaningfully

  const allKeys = new Set();
  for (const s of stats.values()) for (const k of Object.keys(s)) if (k !== '_games') allKeys.add(k);

  for (const statKey of allKeys) {
    const ranked = teams
      .map(team => ({ team, value: stats.get(team)[statKey] }))
      .filter(x => typeof x.value === 'number' && Number.isFinite(x.value))
      .sort((a, b) => a.value - b.value);
    if (ranked.length < 8) continue; // need real quartiles, not a bucket of 1-2 teams
    ranked.forEach((entry, i) => {
      const quartile = Math.min(3, Math.floor((i / ranked.length) * 4));
      result.get(entry.team).set(statKey, BUCKET_LABELS[quartile]);
    });
  }
  bucketsCache.set(key, result);
  return result;
}

/** Single (team, statKey) lookup — convenience wrapper over statLeaderboardBuckets. */
export function teamStatBucket(season, week, team, statKey) {
  return statLeaderboardBuckets(season, week).get(team)?.get(statKey) ?? null;
}

/** Every stat key with a real leaderboard for this (season, week) — what
 * segmentsFor should actually iterate, rather than a fixed list that might
 * not have enough coverage yet this early in a season. */
export function availableLeaderboardKeys(season, week) {
  const buckets = statLeaderboardBuckets(season, week);
  const keys = new Set();
  for (const perTeam of buckets.values()) for (const k of perTeam.keys()) keys.add(k);
  return [...keys].sort();
}

export function clearRollingLeaderCache() { statsCache.clear(); bucketsCache.clear(); }
