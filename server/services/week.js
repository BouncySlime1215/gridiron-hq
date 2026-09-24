/**
 * BROKEN-D: the one producer of "which week is it" — two named fields.
 *
 *   nfl.week     nflWeek(season)   the NFL's week: the first week with an unscored
 *                                  game, cross-checked against the schedule when
 *                                  that looks like a stalled score sync.
 *   league.week  leagueWeek(lg)    the league's own matchup period (ESPN
 *                                  `status.currentMatchupPeriod`), else nfl.week.
 *
 * They are different on purpose (ESPN moves its matchup period a day or two after
 * Monday night; a league's playoff matchup can span two NFL weeks), so a page says
 * which one it reads. What was wrong (BROKEN-NUMBERS row D) is that each caller
 * also computed its own copy: trade-engine.js re-ran the score query without the
 * stalled-sync check, nfl-live.js and nfl-espn-line-watch.js did the same, and the
 * league week read last season's payload for a league that fell back pre-draft.
 *
 * Behind preview-mode.js#previewUnconfirmed(): with it off, every per-caller
 * function below returns exactly what that caller computed before, so the old
 * computations live here, not in the callers. test/broken-d-one-week.test.js
 * greps server/, scripts/ and client/src that no other file computes the week.
 */
import { row, rows } from '../db/index.js';
import { nflKickoffDate } from './date-util.js';
import { previewUnconfirmed } from './preview-mode.js';

// A game missing its score this long after kickoff is no longer "hasn't been
// played yet" — real NFL games (including OT) finish inside this window, and
// ESPN posts finals within minutes after. Past this, a null score is either a
// sync gap or a real data-availability hole, not a game still in progress.
const SCORE_GRACE_HOURS = 6;

const envWeek = () => Number(process.env.NFL_WEEK);
const clampFantasy = week => Math.max(1, Math.min(18, Number(week)));

/** The first week of `season` with an unscored game, or null. */
function unscoredWeek(season) {
  return row(`SELECT MIN(week) AS week FROM game_lines
              WHERE season=? AND team_score IS NULL`, season)?.week ?? null;
}

/**
 * The schedule's own view of "what week is it": the earliest week whose games
 * are not ALL already in the past (i.e. the week currently underway or next
 * up), derived purely from gameday/gametime — no score data involved. Used as
 * a cross-check against the score-derived week below, and as the fallback
 * when that score-derived value looks wrong (see nflWeek).
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

/**
 * nfl.week. `NFL_WEEK` pins it. Unclamped: postseason weeks pass through, and a
 * fantasy caller clamps to 1..18 itself (fantasyWeek).
 */
export function nflWeek(season = Number(process.env.NFL_SEASON) || new Date().getFullYear(), now = new Date()) {
  const scoreWeek = unscoredWeek(season);
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
    week: envWeek() || resolved,
    score_derived_week: scoreWeek,
    schedule_derived_week: scheduleWeek,
    score_signal_flagged: looksWrong
  };
}

/**
 * The fantasy side's NFL week (trade engine, waivers, lineups): nfl.week clamped
 * to 1..18. Flag off: the trade engine's old score query, with no stalled-sync
 * check — the copy that disagreed with nfl.week.
 */
export function fantasyWeek(season) {
  if (previewUnconfirmed()) return { season, week: clampFantasy(nflWeek(season).week) };
  return { season, week: clampFantasy(envWeek() || unscoredWeek(season) || 1) };
}

/** The ESPN scoreboard week nfl-live.js polls. Flag off: first unscored week, NFL_WEEK ignored. */
export function scoreboardWeek(season) {
  if (previewUnconfirmed()) return nflWeek(season).week;
  return unscoredWeek(season) ?? 1;
}

/** The week nfl-espn-line-watch.js polls. Flag off: NFL_WEEK, else first unscored week. */
export function lineWatchWeek(season) {
  if (previewUnconfirmed()) return nflWeek(season).week;
  return envWeek() || (unscoredWeek(season) ?? 1);
}

/**
 * league.week, the way ESPN sees it.
 *
 * Order of truth: the `current_week` column written at the last league sync
 * (ESPN `status.currentMatchupPeriod`), then the same field parsed from the
 * stored payload (leagues synced before the column existed), then nfl.week.
 * Never a hard-coded 1 — that is how the app spent two weeks showing week-1
 * lineups (2026-09-17).
 *
 * Flag on, the payload tier is skipped when the payload is another season's
 * (`payload_season`, the pre-draft fallback): its matchup period is last year's
 * 17 or 18, not this season's week.
 */
export function leagueWeek(lg) {
  const fromColumn = Number(lg?.current_week);
  if (fromColumn >= 1) return Math.min(18, fromColumn);
  const payloadSeason = Number(lg?.payload_season), season = Number(lg?.season);
  const otherSeason = previewUnconfirmed() && payloadSeason && season && payloadSeason !== season;
  if (!otherSeason) {
    const fromPayload = Number(payloadStatus(lg?.payload)?.currentMatchupPeriod);
    if (fromPayload >= 1) return Math.min(18, fromPayload);
  }
  return Math.max(1, Math.min(18, Number(nflWeek(lg?.season || undefined)?.week) || 1));
}

/** The payload's `status`, or null when there is no payload or it is not JSON. */
function payloadStatus(payload) {
  if (typeof payload !== 'string') return payload?.status ?? null;
  try {
    return JSON.parse(payload)?.status ?? null;
  } catch (err) {
    if (err instanceof SyntaxError) return null; // unparseable payload: fall to nfl.week
    throw err;
  }
}
