/**
 * How good is the quarterback who is about to take the snaps.
 *
 * RUNBOOK Sec4.1 measured injury/availability data through the correction head
 * and found it made no measurable difference (v2 9.943 vs v1 9.913, diff
 * +0.030 CI[-0.006,0.071], not significant) -- most likely because only 43%
 * of games carry any admissible injury evidence at all. Starting quarterback
 * quality has FULL coverage from 2021 (the depth-chart table's own coverage
 * floor) and is a large, undisputed driver of spread movement that the frozen
 * 14 football features cannot see: they carry team EPA over a multi-week
 * trailing window, which embeds whoever was playing quarterback last month,
 * not whoever is playing this week.
 *
 * WHAT THIS COMPUTES, for a (season, week, team): the CURRENT week's starting
 * quarterback, from the public depth chart, and that specific player's own
 * trailing QBR from strictly earlier weeks -- never the team's, never a
 * league average, and never the outcome of the game being predicted.
 *
 * TWO DIFFERENT CUTOFF-SAFETY CATEGORIES, deliberately handled differently:
 *   - The STARTER'S IDENTITY comes from `nfl_depth` for the CURRENT week.
 *     This is legitimately known pregame -- depth charts are public before
 *     kickoff, the same cutoff-safety category `nfl-availability.js` already
 *     documents for injury reports. `syncDepthCharts` (`nfl-advanced.js`)
 *     already collapses each week to "only the latest snapshot before each
 *     game," so no additional cutoff filtering belongs here: the ingestion
 *     is the boundary, the same way it already is for every other consumer
 *     of `nfl_depth` in this codebase.
 *   - That player's OWN QBR HISTORY must come from strictly earlier weeks
 *     (same season) or an entirely earlier season -- reading his own
 *     performance in the game being predicted would be reading the outcome
 *     of the thing this feature is meant to help forecast. This is the same
 *     boundary `nfl-availability.js` draws for snap shares, applied here to
 *     a different table.
 *
 * MATCHING. `nfl_qbr_weekly.player_id` is ESPN's own numeric id and shares no
 * id space with `nfl_depth.gsis_id` -- confirmed by direct comparison, zero
 * overlap. So the starter identified from the depth chart is matched into
 * `nfl_qbr_weekly` by NAME, reusing -- not re-deriving -- the exact rule
 * `nfl-player-value.js`'s `priorAdvancedPerformance` and
 * `nfl-availability.js`'s `defensiveProductionWeight` already established for
 * this precise cross-source problem: `normalize(name)` tried first for an
 * exact match, `nameSignature` (first-initial + surname) fallback only when
 * it resolves to exactly one identity among the candidate rows. The match is
 * NOT scoped to the player's current team: a quarterback's own quality
 * follows him across a trade or a free-agent signing, and restricting to the
 * current team would silently null out exactly the players whose history
 * matters most for that question (production's own `qbrTrailingForPlayer` in
 * `nfl-qbr.js` is likewise player-scoped, not team-scoped).
 *
 * MISSINGNESS. `teamStartingQbQuality` returns `qbr: null` -- never a
 * fabricated league-average QBR -- whenever no starter can be identified for
 * that team-week, or the identified starter has no admissible prior QBR row
 * at all (a true rookie, or anyone whose first career start is this game).
 * `evidence` says which case applies without the caller having to guess from
 * the null alone.
 */
import { rows } from '../db/index.js';
import { normalize, nameSignature } from './nfl-player-value.js';

// A start with fewer plays than this is a mop-up/kneel-down appearance, not a
// real performance -- the same qb_plays floor `nfl-qbr.js`'s own
// `qbrTrailingForPlayer` already applies to this table.
const MIN_QUALIFYING_PLAYS = 5;

// How many of the player's own most-recent qualifying starts to average,
// matching `qbrTrailingForPlayer`'s own default window in this package.
const TRAILING_WINDOW = 8;

/**
 * The team's declared starting quarterback for one season/week, or null when
 * `nfl_depth` has no `pos_rank=1` QB row for that team-week at all (seasons
 * before 2021, or a genuine coverage gap).
 *
 * A team-week can carry more than one `pos_rank=1` QB row when the depth
 * chart was captured more than once in the same week (a Wednesday listing
 * superseded by a Friday one after a late change) -- `ORDER BY captured DESC`
 * takes the most recent capture, the same tie-break `nfl-player-value.js`'s
 * own `depthChart` uses.
 */
function startingQuarterback(season, week, team) {
  const candidates = rows(
    `SELECT gsis_id, player_name FROM nfl_depth
     WHERE season = ? AND week = ? AND team = ? AND pos_abb = 'QB' AND pos_rank = 1
     ORDER BY captured DESC`, season, week, team);
  return candidates[0] ?? null;
}

/**
 * That quarterback's own trailing QBR from admissible history, or null when
 * he has none -- never the team's average, never a league-wide default.
 *
 * `admissible` is every `nfl_qbr_weekly` row from strictly earlier weeks of
 * THIS season, or from any strictly earlier season -- a season that has
 * already ended is safely in the past regardless of which week of the new
 * season is being scored, so unlike the injury/snap-share lookback this is
 * not a "week 1 only" special case: it is simply every QBR row this specific
 * player earned before this week's kickoff, most recent first.
 */
function priorStarterQbr(season, week, playerName) {
  const admissible = rows(
    `SELECT season, week, player_id, name, qbr_total FROM nfl_qbr_weekly
     WHERE (season < ? OR (season = ? AND week < ?))
       AND qbr_total IS NOT NULL AND qb_plays >= ?
     ORDER BY season DESC, week DESC`, season, season, week, MIN_QUALIFYING_PLAYS);
  if (!admissible.length) return null;

  const name = normalize(playerName);
  const exact = admissible.filter(r => normalize(r.name) === name);
  const signature = nameSignature(playerName);
  const signatureMatches = admissible.filter(r => nameSignature(r.name) === signature);
  const signatureIds = new Set(signatureMatches.map(r => r.player_id));
  // Ambiguous signature matches (two different quarterbacks sharing a
  // first-initial + surname) abstain rather than attach the wrong player's
  // history -- same rule, same reason, as nfl-availability.js and
  // nfl-player-value.js.
  const matches = exact.length ? exact
    : signature && signatureIds.size === 1 ? signatureMatches : [];
  if (!matches.length) return null;

  const window = matches.slice(0, TRAILING_WINDOW);
  const values = window.map(r => r.qbr_total).filter(Number.isFinite);
  if (!values.length) return null;
  return { qbr: values.reduce((a, b) => a + b, 0) / values.length, starts: values.length };
}

let _cache = new Map();
export function clearQbQualityCache() { _cache = new Map(); }

/**
 * The starting-QB-quality signal for one team-week.
 *
 * Returns `{ starter, qbr, prior_starts, evidence }`. `qbr` and `evidence`
 * are the two fields a caller actually needs: `evidence: false` (with
 * `qbr: null`) covers both "no starter identified" and "starter identified
 * but no admissible prior QBR" -- a rookie making his first career start
 * looks identical, evidence-wise, to a team `nfl_depth` has no row for at
 * all, because both are genuinely "nothing knowable to report," not two
 * different kinds of zero.
 */
export function teamStartingQbQuality(season, week, team) {
  const key = `${season}|${week}|${team}`;
  if (_cache.has(key)) return _cache.get(key);

  const starter = startingQuarterback(season, week, team);
  let result;
  if (!starter) {
    result = { starter: null, qbr: null, prior_starts: 0, evidence: false };
  } else {
    const prior = priorStarterQbr(season, week, starter.player_name);
    result = {
      starter: { gsis_id: starter.gsis_id, name: starter.player_name },
      qbr: prior ? prior.qbr : null,
      prior_starts: prior ? prior.starts : 0,
      evidence: prior != null,
    };
  }
  _cache.set(key, result);
  return result;
}
