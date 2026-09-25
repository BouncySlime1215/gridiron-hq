/**
 * LOVE-RULE inputs: one read per source, strictly-prior weeks of the current season only.
 *
 *   usage          player_week_usage (keyed on players.id): mean target_share, summed actual TDs
 *   ffopportunity  nfl_ffopportunity_weekly (keyed on players.gsis_id): mean expected and actual
 *                  points per game, summed expected TDs ("usage through week N")
 *   injuries       nfl_injuries, the latest report at or before week N: the healthy-role read
 *   draft          DRAFT-ID-MAP's `by_player` map when the producer has one, else 'not_read'
 *
 * A missing table is reported per source as 'table_absent' ("we cannot look"), never thrown and
 * never an empty 'ok'. Week N itself is never read for usage: its games have not finished.
 */

import { LOVE_RULE } from './love.js';

const IN = ids => ids.map(() => '?').join(', ');

function hasTable(db, name) {
  return !!db.row(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, name);
}

const mean = xs => {
  const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x));
  return v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(3) : null;
};
const sum = xs => {
  const v = xs.filter(x => typeof x === 'number' && Number.isFinite(x));
  return v.length ? +v.reduce((s, x) => s + x, 0).toFixed(3) : null;
};

const UNHEALTHY = new Set(LOVE_RULE.unhealthy_reports);

/**
 * @param db { row, rows } (server/db/index.js shape)
 * @param opts { season, week (the current week; weeks < week are read), ids (app player ids),
 *               draft (optional Map app id -> { overall_pick }), lookback (weeks, default 4) }
 * @returns { players: Map id -> loveTag input, sources: { usage, ffopportunity, injuries, draft } }
 */
export function readLoveInputs(db, { season, week, ids, draft = null, lookback = 4 }) {
  const want = [...new Set(ids.map(Number).filter(Number.isInteger))];
  const sources = {
    usage: { status: 'ok', rows: 0 }, ffopportunity: { status: 'ok', rows: 0, missing_gsis: 0 },
    injuries: { status: 'ok', rows: 0 },
    draft: draft ? { status: 'ok', joined: 0 } : { status: 'not_read', reason: 'DRAFT-ID-MAP read is off or not merged' },
  };
  const players = new Map();
  if (!want.length) return { players, sources };

  const base = db.rows(`SELECT id, position, gsis_id FROM players WHERE id IN (${IN(want)})`, ...want);
  const from = Math.max(1, week - lookback);

  const usage = new Map();
  if (hasTable(db, 'player_week_usage')) {
    const rows = db.rows(`SELECT player_id, week, target_share, passing_tds, rushing_tds, receiving_tds
                          FROM player_week_usage
                          WHERE season = ? AND week >= ? AND week < ? AND player_id IN (${IN(want)})
                          ORDER BY week`, season, from, week, ...want);
    sources.usage.rows = rows.length;
    for (const r of rows) {
      if (!usage.has(r.player_id)) usage.set(r.player_id, []);
      usage.get(r.player_id).push(r);
    }
  } else sources.usage = { status: 'table_absent', reason: 'player_week_usage is not on this database' };

  const gsisIds = base.map(p => p.gsis_id).filter(Boolean);
  sources.ffopportunity.missing_gsis = base.length - gsisIds.length;
  const ffo = new Map();
  if (hasTable(db, 'nfl_ffopportunity_weekly')) {
    if (gsisIds.length) {
      const rows = db.rows(`SELECT player_gsis_id, week, expected_fantasy_points, actual_fantasy_points, expected_touchdowns
                            FROM nfl_ffopportunity_weekly
                            WHERE season = ? AND week >= ? AND week < ? AND player_gsis_id IN (${IN(gsisIds)})
                            ORDER BY week`, season, from, week, ...gsisIds);
      sources.ffopportunity.rows = rows.length;
      for (const r of rows) {
        if (!ffo.has(r.player_gsis_id)) ffo.set(r.player_gsis_id, []);
        ffo.get(r.player_gsis_id).push(r);
      }
    }
  } else sources.ffopportunity = { status: 'table_absent', reason: 'nfl_ffopportunity_weekly is not on this database',
    missing_gsis: sources.ffopportunity.missing_gsis };

  const injury = new Map();
  if (hasTable(db, 'nfl_injuries')) {
    if (gsisIds.length) {
      const rows = db.rows(`SELECT gsis_id, week, report_status FROM nfl_injuries
                            WHERE season = ? AND week <= ? AND gsis_id IN (${IN(gsisIds)})
                            ORDER BY week`, season, week, ...gsisIds);
      sources.injuries.rows = rows.length;
      for (const r of rows) injury.set(r.gsis_id, r);   // ordered by week: the last one wins
    }
  } else sources.injuries = { status: 'table_absent', reason: 'nfl_injuries is not on this database' };

  for (const p of base) {
    const u = usage.get(p.id) ?? [];
    const f = p.gsis_id ? ffo.get(p.gsis_id) ?? [] : [];
    const weeks = [...u.map(r => r.week), ...f.map(r => r.week)];
    const inj = p.gsis_id ? injury.get(p.gsis_id) ?? null : null;
    const report = inj?.report_status ?? null;
    // A healthy role needs a report we could read; no row on a readable table is "not on the report".
    const injuriesRead = sources.injuries.status === 'ok' && !!p.gsis_id;
    const role = !injuriesRead ? { status: 'unknown', report_status: null, radar: null }
      : { status: report && UNHEALTHY.has(report.toLowerCase()) ? 'unhealthy' : 'healthy', report_status: report, radar: null };
    const pick = draft?.get(p.id)?.overall_pick ?? null;
    if (pick != null) sources.draft.joined++;
    players.set(p.id, {
      player: p.id, position: p.position,
      games: Math.max(u.length, f.length),
      through: weeks.length ? `${season}-W${Math.max(...weeks)}` : null,
      target_share: mean(u.map(r => r.target_share)),
      actual_tds: u.length ? sum(u.map(r => (r.passing_tds ?? 0) + (r.rushing_tds ?? 0) + (r.receiving_tds ?? 0))) : null,
      expected_ppg: mean(f.map(r => r.expected_fantasy_points)),
      actual_ppg: mean(f.map(r => r.actual_fantasy_points)),
      expected_tds: sum(f.map(r => r.expected_touchdowns)),
      overall_pick: pick, role,
    });
  }
  return { players, sources };
}
