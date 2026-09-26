/**
 * INJURY INSURANCE inputs (batch D item 27).
 *
 *   handcuffsByStarter  contingency.js#handcuffValue (the one handoff measurement), turned round so
 *                       each starter lists his measured backups, each with the workload test run on
 *                       that starter's path alone (waiver-perishable.js#handcuffWorkload).
 *   servedTrade         Nick's side of the planner's served move (res.best), for the comparison.
 *   readGradeGames      held-out games where a starter missed, for gradeInsurance: the backup's
 *                       predicted points (fit through season-1) against what he scored.
 *
 * Ids are players.id throughout (the adapter's ids). No names are read or written.
 */

import { handcuffWorkload } from '../waiver-perishable.js';

/** The fantasy points formula handcuffValue's points-per-opportunity uses (PPR), for one usage row. */
export function pprPoints(r) {
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return n(r.passing_yards) * 0.04 + n(r.passing_tds) * 4 + n(r.rushing_yards) * 0.1 + n(r.rushing_tds) * 6
    + n(r.receptions) + n(r.receiving_yards) * 0.1 + n(r.receiving_tds) * 6;
}

/**
 * @param entries handcuffValue() output: [{ player_id, position, paths: [{ starter_id, points_without, ... }] }]
 * @param opts { starters: ids to keep (null = all), playerOf(id) -> { position, ros_ppg, available } | null,
 *               ownerOf(id) -> roster id | null }
 * @returns Map starterId (string) -> [{ id, position, ros_ppg, available, points_without, owner, workload_test }]
 */
export function handcuffsByStarter(entries, { starters = null, playerOf = () => null, ownerOf = () => null } = {}) {
  const keep = starters ? new Set([...starters].map(String)) : null;
  const out = new Map();
  for (const e of entries ?? []) {
    for (const path of e.paths ?? []) {
      const s = String(path.starter_id);
      if (keep && !keep.has(s)) continue;
      const p = playerOf(e.player_id);
      const list = out.get(s) ?? [];
      list.push({ id: e.player_id, position: p?.position ?? e.position, ros_ppg: Number.isFinite(p?.ros_ppg) ? p.ros_ppg : 0,
        available: p?.available ?? true, points_without: path.points_without ?? null, owner: ownerOf(e.player_id) ?? null,
        workload_test: handcuffWorkload({ position: e.position, paths: [path] }) });
      out.set(s, list);
    }
  }
  return out;
}

/**
 * Nick's side of the served move: everything he gives across the steps, what he still holds of what
 * he gets (a flip piece given on a later step is not held), and P(every step says yes).
 * @param best planner res.best ({ steps: [{ give, get }], p_complete }) or null
 */
export function servedTrade(best, playerOf) {
  if (!best?.steps?.length) return null;
  const give = new Set(), got = new Set();
  for (const st of best.steps) {
    for (const id of st.give ?? []) { const k = String(id); if (got.has(k)) got.delete(k); else give.add(k); }
    for (const id of st.get ?? []) got.add(String(id));
  }
  return { give: [...give], get: [...got].map(id => ({ id, ...(playerOf(id) ?? {}) })), p_complete: best.p_complete ?? null };
}

/**
 * Held-out games for the grade. For each (starter, backup) path in `entries` (fit through season-1):
 * the starter's team is his most common team in `season`; a missed game is a week that team played
 * (any player on it has a row) and the starter has none. The backup must be on the same team that
 * season; realized = his PPR points that week, 0 when he has no row.
 * @param db { rows } (server/db/index.js shape)
 */
export function readGradeGames(db, { season, entries }) {
  const usage = db.rows(`SELECT player_id, week, team, passing_yards, passing_tds, rushing_yards, rushing_tds,
                                receptions, receiving_yards, receiving_tds
                         FROM player_week_usage WHERE season = ? AND team IS NOT NULL`, season);
  const byPlayer = new Map(), teamWeeks = new Map();
  for (const r of usage) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, new Map());
    byPlayer.get(r.player_id).set(r.week, r);
    if (!teamWeeks.has(r.team)) teamWeeks.set(r.team, new Set());
    teamWeeks.get(r.team).add(r.week);
  }
  const teamOf = id => {
    const weeks = byPlayer.get(id);
    if (!weeks) return null;
    const c = new Map();
    for (const r of weeks.values()) c.set(r.team, (c.get(r.team) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0][0];
  };
  const games = [];
  for (const e of entries ?? []) {
    for (const path of e.paths ?? []) {
      const starter = Number(path.starter_id), backup = Number(e.player_id);
      const team = teamOf(starter);
      if (!team || teamOf(backup) !== team || !Number.isFinite(path.points_without)) continue;
      const passes = handcuffWorkload({ position: e.position, paths: [path] }).passes;
      const sw = byPlayer.get(starter), bw = byPlayer.get(backup);
      for (const week of [...teamWeeks.get(team)].sort((a, b) => a - b)) {
        if (sw.has(week)) continue;
        const r = bw.get(week);
        if (r && r.team !== team) continue;
        games.push({ season, week, starter, backup, predicted: path.points_without, realized: r ? pprPoints(r) : 0, passes });
      }
    }
  }
  return games;
}
