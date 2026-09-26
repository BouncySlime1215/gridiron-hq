/**
 * NEGOTIATOR-SAFETY (c): material news on the players in a sent deal, since a moment (the last send).
 * Read-only; every query is parameterised. Three kinds, each from the one store that holds its history:
 *
 *   injury  nfl_feature_revisions, feature 'injury_report' (the bitemporal store nfl-advanced.js#syncInjuries
 *           appends to only when the report changed): a revision published after `since` whose report
 *           status or injury differs from the player's last revision at or before `since`. A first-ever
 *           revision with a status counts; a weekly re-listing of the same status does not.
 *   role    nfl_depth: the player's depth-chart rank at a position, latest capture after `since`, differs
 *           from his latest capture at or before `since`.
 *   roster  league_roster_snapshots (this league): he left the team he was on at `since` (a row marked
 *           off the roster, or a row on another team, first seen after `since`).
 *
 * A source whose table is absent is named in `missing` (never read as "no news"). Any other failure throws.
 * db: { rows(sql, ...params) }.
 * -> { events: [{ player_id, kind, at, detail }], missing: string[] }
 */
import { parseAt } from './negotiator-safety.js';

const S = x => String(x);
const absent = e => /no such table/i.test(String(e?.message ?? e));

function tryRows(db, missing, source, sql, ...params) {
  try { return db.rows(sql, ...params); } catch (e) {
    if (absent(e)) { missing.add(source); return null; }
    throw e;
  }
}

export function dealNews(db, { leagueId, ids = [], since }) {
  const events = [];
  const missing = new Set();
  const t0 = parseAt(since);
  const list = [...new Set(ids.map(S))].filter(id => /^\d+$/.test(id));
  if (!list.length || !Number.isFinite(t0)) return { events, missing: [] };
  const ph = list.map(() => '?').join(', ');
  const players = tryRows(db, missing, 'players', `SELECT id, gsis_id FROM players WHERE id IN (${ph})`, ...list.map(Number)) ?? [];
  const gsisOf = new Map(players.filter(p => p.gsis_id).map(p => [S(p.id), S(p.gsis_id)]));

  for (const id of list) {
    const gsis = gsisOf.get(id);
    if (!gsis) continue;
    // injury: report status / injury changes around `since`.
    const revs = tryRows(db, missing, 'injury reports',
      `SELECT published_at, value_json FROM nfl_feature_revisions
       WHERE feature = 'injury_report' AND entity LIKE ? ORDER BY published_at`, `player:${gsis}:%`);
    if (revs) {
      const key = r => { const v = JSON.parse(r.value_json || '{}'); return { k: `${v.report_status ?? ''}|${v.injury ?? ''}`, v }; };
      let prev = null;
      for (const r of revs) {
        const cur = key(r);
        if (parseAt(r.published_at) <= t0) { prev = cur.k; continue; }
        const first = prev == null;
        if ((first && cur.v.report_status) || (!first && cur.k !== prev)) {
          events.push({ player_id: id, kind: 'injury', at: r.published_at,
            detail: `injury report: ${cur.v.report_status ?? 'no status'}${cur.v.injury ? ` (${cur.v.injury})` : ''}` });
        }
        prev = cur.k;
      }
    }
    // role: depth-chart rank per position, before vs after `since`.
    const depth = tryRows(db, missing, 'depth charts',
      'SELECT pos_abb, pos_rank, captured FROM nfl_depth WHERE gsis_id = ? ORDER BY captured', gsis);
    if (depth) {
      const before = new Map(), after = new Map();
      for (const r of depth) (parseAt(r.captured) <= t0 ? before : after).set(r.pos_abb, r);
      for (const [pos, a] of after) {
        const b = before.get(pos);
        if (b && a.pos_rank != null && b.pos_rank != null && Number(a.pos_rank) !== Number(b.pos_rank)) {
          events.push({ player_id: id, kind: 'role', at: a.captured, detail: `depth chart ${pos}: ${b.pos_rank} -> ${a.pos_rank}` });
        }
      }
    }
  }

  // roster: left the team he was on at `since`.
  const snaps = tryRows(db, missing, 'league rosters',
    `SELECT player_id, team_id, on_roster, first_seen_at, changed_at FROM league_roster_snapshots
     WHERE league_id = ? AND player_id IN (${ph}) ORDER BY first_seen_at`, Number(leagueId), ...list.map(Number));
  if (snaps) {
    for (const id of list) {
      const mine = snaps.filter(r => S(r.player_id) === id);
      const at = mine.filter(r => parseAt(r.first_seen_at) <= t0);
      const team = at.length ? S(at[at.length - 1].team_id) : null;
      if (team == null) continue;
      const moved = mine.find(r => (S(r.team_id) !== team && parseAt(r.first_seen_at) > t0)
        || (S(r.team_id) === team && Number(r.on_roster) === 0 && parseAt(r.changed_at) > t0));
      if (moved) {
        events.push({ player_id: id, kind: 'roster',
          at: S(moved.team_id) !== team ? moved.first_seen_at : moved.changed_at,
          detail: S(moved.team_id) !== team ? 'moved to another team in the league' : 'left the roster' });
      }
    }
  }
  return { events, missing: [...missing] };
}
