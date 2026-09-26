/**
 * PLAYOFF-WEEK VALUE inputs: one season's weekly lines from `player_week_usage`, scored with
 * the league's scoring (scoring.js#scoreLine), opponents canonicalised (ESPN writes WSH).
 *
 * One reader serves both the shadow block (this season, weeks before this week) and the
 * grader (whole past seasons), so the graded read is the served read. A missing table is
 * 'table_absent' ("we cannot look"), never thrown and never an empty 'ok'.
 */

import { scoreLine, PPR } from '../scoring.js';
import { canonicalTeamCode } from '../team-codes.js';
import { PLAYOFF_WEEK_RULE } from './playoff-week.js';

/**
 * @param db { row, rows } (server/db/index.js shape)
 * @param opts { season, fromWeek = 1, toWeek (exclusive), scoring }
 * @returns { lines: [{ player, position, team, opponent, week, pts }], sources: { usage: { status, rows } } }
 */
export function readPlayoffWeekLines(db, { season, fromWeek = 1, toWeek = 99, scoring = PPR }) {
  const has = db.row(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, 'player_week_usage');
  if (!has) return { lines: [], sources: { usage: { status: 'table_absent', reason: 'player_week_usage is not on this database', rows: 0 } } };
  const positions = PLAYOFF_WEEK_RULE.positions;
  const raw = db.rows(`SELECT u.*, COALESCE(p.position, u.position) AS pos
                       FROM player_week_usage u
                       JOIN players p ON p.id = u.player_id
                       WHERE u.season = ? AND u.week >= ? AND u.week < ? AND u.opponent IS NOT NULL
                         AND COALESCE(p.position, u.position) IN (${positions.map(() => '?').join(', ')})
                       ORDER BY u.player_id, u.week`, season, fromWeek, toWeek, ...positions);
  const lines = raw.map(u => ({
    player: u.player_id, position: u.pos, team: u.team == null ? null : canonicalTeamCode(u.team),
    opponent: canonicalTeamCode(u.opponent), week: u.week, pts: scoreLine(u, scoring),
  }));
  return { lines, sources: { usage: { status: 'ok', rows: lines.length } } };
}
