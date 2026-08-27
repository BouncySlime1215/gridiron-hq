/**
 * Rookie projections — the model's largest structural blind spot.
 *
 * `buildProjections` builds entirely from `player_week_usage`, so a player
 * with no NFL history produces no projection at all. Verified directly: at
 * Week 1 of 2025, 880 players received a projection and **zero** of them were
 * players without prior usage. The model is not merely inaccurate about
 * rookies; it cannot see them. That is worst precisely when it matters most —
 * draft season and the opening weeks.
 *
 * The fix is not new modelling technique, it is a prior. Everywhere else in
 * this codebase an unknown quantity starts at a positional prior and shrinks
 * toward observed evidence as it accumulates. Rookies had no prior to start
 * from. Draft capital is that prior:
 *
 *   round 1    16.60 opportunities per game
 *   round 2     9.77
 *   round 3     5.56
 *   rounds 4-5  4.05
 *
 * A 4x spread, monotonic across the range that matters. And it is available
 * before a single snap is played.
 *
 * On college statistics — deliberately NOT used, and not because they would
 * be useless. Draft position is already an aggregation of college production,
 * athletic testing, medicals and interviews, priced by thirty-two
 * organisations with far more information than this database has. It is the
 * market's own summary. College box scores would add signal only to the
 * extent they beat that consensus, which is the same bet as beating a closing
 * line — and this codebase has already measured, repeatedly, how that goes.
 * If college data is added later it should be tested as a candidate against
 * this draft-capital prior, not assumed to improve on it.
 *
 * COVERAGE LIMIT, stated plainly: `player_accolades` is keyed to the current
 * roster snapshot, so draft capital exists only for players still rostered in
 * 2026. The n=75 historical rookie seasons behind the table above are
 * survivors. Late-round bands are the least trustworthy for exactly this
 * reason — a sixth-rounder in this sample is a sixth-rounder who lasted.
 * Bands are therefore shrunk hard and the late-round bands are collapsed.
 */
import { rows } from '../db/index.js';

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r3 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(3));

/** Draft-capital bands. Collapsed at the tail where survivorship dominates. */
export function draftBand(pick) {
  if (pick == null) return 'undrafted';
  if (pick <= 32) return 'R1';
  if (pick <= 64) return 'R2';
  if (pick <= 105) return 'R3';
  return 'R4+';
}

/**
 * Measured rookie opportunity per game by draft band and position.
 * Survivorship-limited; see the file header.
 */
export function measureRookiePriors() {
  const acc = rows(`SELECT a.name, a.draft_round, a.draft_pick, a.draft_year, r.position
                    FROM player_accolades a JOIN roster_players r ON r.id = a.roster_player_id
                    WHERE a.draft_pick IS NOT NULL AND a.draft_year IS NOT NULL
                      AND r.position IN ('QB','RB','WR','TE')`);
  const nameToId = new Map(rows(`SELECT id, name FROM players`).map(p => [p.name.toLowerCase(), p.id]));
  const usage = new Map();
  for (const u of rows(`SELECT player_id, season,
                               SUM(COALESCE(targets,0)+COALESCE(carries,0)+COALESCE(attempts,0)) opp,
                               SUM(COALESCE(targets,0)) targets, SUM(COALESCE(carries,0)) carries,
                               SUM(COALESCE(attempts,0)) attempts, COUNT(*) g
                        FROM player_week_usage GROUP BY player_id, season`)) {
    usage.set(`${u.player_id}|${u.season}`, u);
  }
  const points = [];
  for (const a of acc) {
    const pid = nameToId.get(a.name.toLowerCase());
    if (!pid) continue;
    const u = usage.get(`${pid}|${a.draft_year}`);
    if (!u || u.g < 4) continue;
    points.push({ position: a.position, band: draftBand(a.draft_pick), pick: a.draft_pick,
      opp_per_game: u.opp / u.g, targets_per_game: u.targets / u.g,
      carries_per_game: u.carries / u.g, attempts_per_game: u.attempts / u.g });
  }
  const byBand = {}, byBandPos = {};
  for (const p of points) {
    (byBand[p.band] ??= []).push(p);
    (byBandPos[`${p.band}|${p.position}`] ??= []).push(p);
  }
  const summarize = list => ({
    n: list.length,
    opp_per_game: r3(mean(list.map(x => x.opp_per_game))),
    targets_per_game: r3(mean(list.map(x => x.targets_per_game))),
    carries_per_game: r3(mean(list.map(x => x.carries_per_game))),
    attempts_per_game: r3(mean(list.map(x => x.attempts_per_game)))
  });
  return {
    n: points.length,
    by_band: Object.fromEntries(Object.entries(byBand).map(([k, v]) => [k, summarize(v)])),
    by_band_position: Object.fromEntries(Object.entries(byBandPos)
      .filter(([, v]) => v.length >= 4)
      .map(([k, v]) => [k, summarize(v)])),
    caveat: 'Draft capital is joined via the 2026 roster snapshot, so these are surviving rookies. ' +
      'Late-round bands overstate; they are collapsed into R4+ and shrunk hard downstream.'
  };
}

/** Cached measured priors, with conservative hardcoded fallbacks. */
let priorCache = null;
function priors() {
  if (priorCache) return priorCache;
  let measured;
  try { measured = measureRookiePriors(); } catch { measured = { by_band: {}, by_band_position: {} }; }
  priorCache = measured;
  return measured;
}

/**
 * Fallbacks used when a band has too little data to speak. Deliberately
 * conservative — an unknown rookie should look like a marginal contributor,
 * not a starter, because the cost of over-projecting an unknown in a draft
 * tool is a wasted pick.
 */
const FALLBACK_OPP = { R1: 12, R2: 8, R3: 5, 'R4+': 3, undrafted: 1.5 };

/**
 * Opportunity prior for a rookie, before he has played.
 *
 * `depthRank` (from `nfl_depth.pos_rank`) refines it when available: a
 * third-round receiver listed WR1 is a different proposition from the same
 * player listed WR4. Applied as a modest multiplier rather than an override,
 * because preseason depth charts are notoriously soft.
 */
export function rookieOpportunityPrior({ position, draftPick, depthRank = null } = {}) {
  const band = draftBand(draftPick);
  const p = priors();
  const posKey = `${band}|${position}`;
  const source = p.by_band_position?.[posKey] ?? p.by_band?.[band] ?? null;
  const base = source?.opp_per_game ?? FALLBACK_OPP[band] ?? 2;
  // Shrink the measured value toward the conservative fallback in proportion
  // to how thin the sample is. n=4 barely moves it; n=30 mostly trusts it.
  const n = source?.n ?? 0;
  const shrunk = (base * n + (FALLBACK_OPP[band] ?? 2) * 12) / (n + 12);
  const depthMult = depthRank == null ? 1
    : depthRank === 1 ? 1.25 : depthRank === 2 ? 1.0 : depthRank === 3 ? 0.75 : 0.5;
  return {
    band, position,
    opportunity_per_game: r3(shrunk * depthMult),
    measured_n: n,
    depth_rank: depthRank,
    depth_multiplier: depthMult,
    basis: source ? (p.by_band_position?.[posKey] ? 'band+position' : 'band') : 'fallback',
    confidence: n >= 20 ? 'moderate' : n >= 8 ? 'low' : 'very_low',
    caveat: 'Prior only. Replace with observed usage as soon as real games exist.'
  };
}

/** Current depth-chart rank for a player, latest capture at or before the season/week. */
export function depthRankFor(gsisId, season, week) {
  if (!gsisId) return null;
  const r = rows(`SELECT pos_rank FROM nfl_depth
                  WHERE gsis_id = ? AND (season < ? OR (season = ? AND week <= ?))
                  ORDER BY season DESC, week DESC LIMIT 1`, gsisId, season, season, week)[0];
  return r?.pos_rank ?? null;
}

/**
 * Blend the draft-capital prior with observed NFL usage as it accumulates.
 *
 * Identical logic to every other shrinkage in this codebase: the prior holds
 * while evidence is thin and yields as games arrive. `k = 4` means the prior
 * still carries half the weight after four games — rookie roles genuinely do
 * change fast, and four games is roughly where usage starts being real rather
 * than situational.
 */
export function blendedRookieOpportunity({ prior, observedPerGame, gamesPlayed = 0, k = 4 }) {
  if (!Number.isFinite(observedPerGame) || gamesPlayed <= 0) return prior;
  return (observedPerGame * gamesPlayed + prior * k) / (gamesPlayed + k);
}
