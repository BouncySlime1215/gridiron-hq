/**
 * The one cutoff representation.
 *
 * Every pregame evidence question is "what was known before this game's
 * kickoff", and two services answered it with two different clocks: the
 * unified engine used the scheduled kickoff, roster strength used the end of
 * the game day. Same game, two cutoffs, and the difference is a whole slate of
 * Sunday-afternoon injury news. This is the single answer both use
 * (PROFITABILITY_PLAN Priority 0: "one cutoff representation").
 *
 * Returns an ISO instant: the scheduled kickoff when game_lines has one, the
 * end of the game day (23:59 ET) when only the date is known, and null when
 * the game is not in game_lines at all. Callers that need a fallback choose it
 * explicitly rather than inheriting one.
 */
import { rows } from '../db/index.js';
import { nflKickoffDate } from './date-util.js';

export function gameCutoff(season, week, team) {
  const game = rows(`SELECT gameday, gametime FROM game_lines WHERE season=? AND week=? AND team=? LIMIT 1`,
    Number(season), Number(week), String(team ?? '').toUpperCase())[0];
  if (!game?.gameday) return null;
  return nflKickoffDate(game.gameday, game.gametime || '23:59').toISOString();
}
