/**
 * SELL-HIGH FILTER inputs: per player-week TDs, expected TDs and opportunities.
 *
 *   player_week_usage          (players.id)  attempts, carries, targets, passing/rushing/receiving TDs
 *   nfl_ffopportunity_weekly   (players.gsis_id)  expected_touchdowns
 *
 * One reader serves both the shadow summary (Nick's roster, weeks before this week) and the
 * weekly grader (every player, whole seasons), so the graded rows are the served rows.
 * A missing table is reported as 'table_absent' ("we cannot look"), never thrown and never an
 * empty 'ok'.
 */

import { SELL_HIGH_RULE, opportunitiesOf } from './sell-high.js';

const IN = ids => ids.map(() => '?').join(', ');

function hasTable(db, name) {
  return !!db.row(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name);
}

/**
 * @param db { row, rows } (server/db/index.js shape)
 * @param opts { season, fromWeek, toWeek (exclusive), ids (app player ids) or null for every player }
 * @returns { players: Map id -> { player, position, rows: [{ week, tds, xtd, opportunities }] }, sources }
 */
export function readTdWeeks(db, { season, fromWeek = 1, toWeek = 99, ids = null }) {
  const want = ids ? [...new Set(ids.map(Number).filter(Number.isInteger))] : null;
  const sources = { usage: { status: 'ok', rows: 0 }, ffopportunity: { status: 'ok', rows: 0 } };
  const players = new Map();
  if (want && !want.length) return { players, sources };
  if (!hasTable(db, 'player_week_usage')) {
    sources.usage = { status: 'table_absent', reason: 'player_week_usage is not on this database' };
  }
  if (!hasTable(db, 'nfl_ffopportunity_weekly')) {
    sources.ffopportunity = { status: 'table_absent', reason: 'nfl_ffopportunity_weekly is not on this database' };
  }
  if (sources.usage.status !== 'ok' || sources.ffopportunity.status !== 'ok') return { players, sources };

  const idFilter = want ? `AND u.player_id IN (${IN(want)})` : '';
  const rows = db.rows(`SELECT u.player_id, u.week, COALESCE(p.position, u.position) AS position, u.attempts, u.carries, u.targets,
                               u.passing_tds, u.rushing_tds, u.receiving_tds, f.expected_touchdowns AS xtd
                        FROM player_week_usage u
                        JOIN players p ON p.id = u.player_id
                        LEFT JOIN nfl_ffopportunity_weekly f
                          ON f.season = u.season AND f.week = u.week AND f.player_gsis_id = p.gsis_id
                        WHERE u.season = ? AND u.week >= ? AND u.week < ? ${idFilter}
                        ORDER BY u.player_id, u.week`, season, fromWeek, toWeek, ...(want ?? []));
  sources.usage.rows = rows.length;
  sources.ffopportunity.rows = rows.filter(r => r.xtd != null).length;
  for (const r of rows) {
    const position = r.position ?? null;
    if (!players.has(r.player_id)) players.set(r.player_id, { player: r.player_id, position, rows: [] });
    players.get(r.player_id).rows.push({
      week: r.week,
      tds: (r.passing_tds ?? 0) + (r.rushing_tds ?? 0) + (r.receiving_tds ?? 0),
      xtd: r.xtd ?? null,
      opportunities: opportunitiesOf(position, r),
    });
  }
  // Asked-for ids with no usage row at all still appear (unrated, "0 games"), never silently dropped.
  if (want) {
    const missing = want.filter(id => !players.has(id));
    if (missing.length) {
      for (const p of db.rows(`SELECT id, position FROM players WHERE id IN (${IN(missing)})`, ...missing)) {
        players.set(p.id, { player: p.id, position: p.position, rows: [] });
      }
    }
  }
  return { players, sources };
}

/** Nick's roster, the lookback weeks strictly before this week (this week's games are not final). */
export function readSellHighInputs(db, { season, week, ids, lookback = SELL_HIGH_RULE.lookback }) {
  const r = readTdWeeks(db, { season, fromWeek: Math.max(1, week - lookback), toWeek: week, ids });
  return { ...r, as_of_week: week };
}
