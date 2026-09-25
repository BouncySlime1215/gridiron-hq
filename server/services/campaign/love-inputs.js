/**
 * LOVE-RULE inputs: one read per source, strictly-prior weeks of the current season only.
 *
 *   usage          player_week_usage (keyed on players.id): mean target_share, summed actual TDs
 *   ffopportunity  nfl_ffopportunity_weekly (keyed on players.gsis_id): mean expected and actual
 *                  points per game, summed expected TDs ("usage through week N")
 *   injuries       nfl_injuries, the week-N report only (reports expire): the healthy-role read;
 *                  an older or missing report makes every role 'unknown', never 'healthy'
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

function hasColumn(db, table, column) {
  return db.rows(`SELECT name FROM pragma_table_info(?)`, table).some(c => c.name === column);
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

  // The player's NFL team (players.team_id -> nfl_teams.abbr): a partly published week-N
  // injury report only covers the teams that have filed (Thursday teams first).
  const teamRead = hasTable(db, 'nfl_teams') && hasColumn(db, 'players', 'team_id');
  const base = teamRead
    ? db.rows(`SELECT p.id, p.position, p.gsis_id, t.abbr AS team_abbr FROM players p
               LEFT JOIN nfl_teams t ON t.id = p.team_id WHERE p.id IN (${IN(want)})`, ...want)
    : db.rows(`SELECT id, position, gsis_id, NULL AS team_abbr FROM players WHERE id IN (${IN(want)})`, ...want);
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
  let reportedTeams = new Set();
  if (hasTable(db, 'nfl_injuries')) {
    // Injury reports expire: only THIS week's report (week N) counts. Last week's is stale, so a
    // player Out in an earlier week is not still Out. With no week-N report (not published yet, or
    // nothing this season) nobody can be called healthy: every role reads 'unknown' (caps at PASS).
    const latest = db.row(`SELECT MAX(week) AS w FROM nfl_injuries WHERE season = ? AND week <= ?`, season, week)?.w ?? null;
    if (latest !== week) {
      sources.injuries = { status: 'stale', max_week: latest, rows: 0,
        reason: latest == null ? `nfl_injuries has no ${season} report at or before week ${week}`
          : `nfl_injuries' latest ${season} report is week ${latest}, not this week (${week})` };
    } else {
      sources.injuries.report_week = latest;
      // Which NFL teams have filed a week-N report. MAX(week) = N is met by the first team's
      // rows, so early in the week most teams have not filed yet: a player whose team has no
      // week-N row is 'unknown', never 'healthy' (#393 review, partly published week).
      if (hasColumn(db, 'nfl_injuries', 'team')) {
        reportedTeams = new Set(db.rows(`SELECT DISTINCT team FROM nfl_injuries WHERE season = ? AND week = ? AND team IS NOT NULL`,
          season, latest).map(r => String(r.team)));
        sources.injuries.teams_reported = reportedTeams.size;
      } else {
        sources.injuries.teams_reported = null;
        sources.injuries.team_reason = 'nfl_injuries has no team column: no player can be called healthy';
      }
      if (gsisIds.length) {
        const rows = db.rows(`SELECT gsis_id, week, report_status FROM nfl_injuries
                              WHERE season = ? AND week = ? AND gsis_id IN (${IN(gsisIds)})`, season, latest, ...gsisIds);
        sources.injuries.rows = rows.length;
        for (const r of rows) injury.set(r.gsis_id, r);
      }
    }
  } else sources.injuries = { status: 'table_absent', reason: 'nfl_injuries is not on this database' };

  for (const p of base) {
    const u = usage.get(p.id) ?? [];
    const f = p.gsis_id ? ffo.get(p.gsis_id) ?? [] : [];
    const weeks = [...u.map(r => r.week), ...f.map(r => r.week)];
    const inj = p.gsis_id ? injury.get(p.gsis_id) ?? null : null;
    const report = inj?.report_status ?? null;
    // A healthy role needs a current report; no row on a current report is "not on the report".
    // ...and his team must have filed this week's report: else nobody can say he is healthy.
    const teamFiled = !!p.team_abbr && reportedTeams.has(String(p.team_abbr));
    const injuriesRead = sources.injuries.status === 'ok' && !!p.gsis_id && (teamFiled || !!inj);
    if (sources.injuries.status === 'ok' && p.gsis_id && !injuriesRead) {
      sources.injuries.team_not_filed = (sources.injuries.team_not_filed ?? 0) + 1;
    }
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
