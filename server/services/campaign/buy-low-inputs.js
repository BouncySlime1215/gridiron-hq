/**
 * BUY-LOW inputs: one read per source, weeks strictly before the as-of week (this season) and last
 * season's regular season. Week W itself is never read: its games have not finished.
 *
 *   ffopportunity  nfl_ffopportunity_weekly (keyed on players.gsis_id): expected and actual points
 *   usage          player_week_usage (keyed on players.id): target_share, carries, targets
 *
 * A missing table is reported as 'table_absent' ("we cannot look") and every player then reads
 * 'no_games' / 'no_baseline'; it is never thrown and never an empty 'ok'.
 */

import { scoreBuyLow, scoreBuyLowV2, SERVED_RULE, BUY_LOW_RULE } from './buy-low.js';

const IN = ids => ids.map(() => '?').join(', ');

function hasTable(db, name) {
  return !!db.row(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name);
}

/**
 * @param db { row, rows } (server/db/index.js shape)
 * @param opts { season, week (weeks < week are read), ids (app player ids), rule (1 | 2, default the served rule) }
 * @returns { reads: Map String(id) -> scoreBuyLow result, sources }
 */
export function readBuyLow(db, { season, week, ids, rule = SERVED_RULE }) {
  const score = rule === 1 ? scoreBuyLow : scoreBuyLowV2;
  const want = [...new Set((ids ?? []).map(Number).filter(Number.isInteger))];
  const sources = { ffopportunity: { status: 'ok', rows: 0, missing_gsis: 0 }, usage: { status: 'ok', rows: 0 } };
  const reads = new Map();
  if (!want.length) return { reads, sources };
  const last = BUY_LOW_RULE.last_regular_week;
  const base = db.rows(`SELECT id, position, gsis_id FROM players WHERE id IN (${IN(want)})`, ...want);
  const byGsis = new Map(base.filter(p => p.gsis_id).map(p => [String(p.gsis_id), p]));
  sources.ffopportunity.missing_gsis = base.length - byGsis.size;
  const games = new Map(base.map(p => [String(p.id), new Map()]));
  const key = (s, w) => `${s}:${w}`;

  if (!hasTable(db, 'nfl_ffopportunity_weekly')) sources.ffopportunity = { status: 'table_absent' };
  else if (byGsis.size) {
    const g = [...byGsis.keys()];
    const rows = db.rows(`SELECT player_gsis_id, season, week, expected_fantasy_points AS xfp, actual_fantasy_points AS act
      FROM nfl_ffopportunity_weekly WHERE player_gsis_id IN (${IN(g)}) AND week <= ?
      AND (season = ? OR (season = ? AND week < ?))`, ...g, last, season - 1, season, week);
    sources.ffopportunity.rows = rows.length;
    for (const r of rows) {
      const p = byGsis.get(String(r.player_gsis_id));
      games.get(String(p.id)).set(key(r.season, r.week), { season: r.season, week: r.week, xfp: r.xfp, act: r.act });
    }
  }
  if (!hasTable(db, 'player_week_usage')) sources.usage = { status: 'table_absent' };
  else {
    const rows = db.rows(`SELECT player_id, season, week, target_share, carries, targets FROM player_week_usage
      WHERE player_id IN (${IN(want)}) AND week <= ? AND (season = ? OR (season = ? AND week < ?))`,
    ...want, last, season - 1, season, week);
    sources.usage.rows = rows.length;
    for (const r of rows) {
      const g = games.get(String(r.player_id))?.get(key(r.season, r.week));
      if (g) Object.assign(g, { target_share: r.target_share, carries: r.carries, targets: r.targets });
    }
  }
  for (const p of base) {
    reads.set(String(p.id), score({ position: p.position, games: [...games.get(String(p.id)).values()] }, { season, week }));
  }
  return { reads, sources };
}
