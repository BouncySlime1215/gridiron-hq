/**
 * DRAFT-ID-MAP (ONE-PLAN 4b row 1, night 5): draft capital per app player, joined on the right key.
 *
 * `league_draft_picks.player_id` is the ESPN id. Measured on the live DB: 0 of 1,738 picks join
 * `players.id`, 1,738 of 1,738 join `players.espn_id`. So the join is `players.espn_id`, with two
 * guards the naive join lacks:
 *   - `players.espn_id = 0` is a placeholder on 2,884 historical rows (4b row 5); a pick or a player
 *     carrying 0 never joins, or one pick fans out into thousands of players.
 *   - an espn id on more than one players row is ambiguous; it is counted and named, never guessed.
 *
 * Draft capital is `overall_pick`, owner-independent: a player keeps his pick when traded or
 * dropped. `drafting_roster` is `team_id` (it IS the drafting roster id, 10 ids x 17 picks measured);
 * `current_roster` comes from the producer's own roster map, so there is one owner answer.
 *
 * SHADOW behind GRIDIRON_DRAFT_ID_MAP: the producer writes counts to `_run.inputs.draft_id_map`
 * and nothing served reads `by_player` yet. LOVE-RULE (unit 13) is its first consumer.
 */

export const DRAFT_ID_MAP_ENV = 'GRIDIRON_DRAFT_ID_MAP';
export const draftIdMapEnabled = (env = process.env) => env[DRAFT_ID_MAP_ENV] === '1';

const TABLE = 'league_draft_picks';

const empty = (status, reason, season) => ({
  status, reason, season, picks: 0, joined: 0, joined_via_players_id: 0, unjoined: [],
  drafting_rosters: 0, by_player: new Map(),
});

/**
 * @param db { row, rows } (server/db/index.js shape)
 * @param rosters Map roster id -> app player ids (the producer's roster); may be empty
 * @returns { status: 'ok'|'table_absent'|'no_picks' ('error' only via draftCapitalGuarded), reason, season, picks, joined,
 *   joined_via_players_id, unjoined: [{ overall_pick, espn_id, why }], drafting_rosters,
 *   by_player: Map app id -> { espn_id, overall_pick, round, drafting_roster, current_roster } }
 */
export function draftCapital(db, { leagueId, season, rosters = new Map() }) {
  const present = db.row(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, TABLE);
  if (!present) {
    return empty('table_absent', `${TABLE} is not on this database, so draft capital cannot be read `
      + '("we cannot look", not "nobody was drafted")', season);
  }
  const picks = db.rows(`SELECT overall_pick, round, team_id, player_id FROM ${TABLE}
                         WHERE league_id = ? AND season = ? ORDER BY overall_pick`, Number(leagueId), Number(season));
  if (!picks.length) return empty('no_picks', `${TABLE} has no picks for league ${leagueId} season ${season}`, season);

  const ids = [...new Set(picks.map(p => Number(p.player_id)).filter(id => id > 0))];
  const byEspn = new Map();
  if (ids.length) {
    const found = db.rows(`SELECT id, espn_id FROM players WHERE espn_id IN (${ids.map(() => '?').join(', ')})`, ...ids);
    for (const r of found) {
      if (!byEspn.has(r.espn_id)) byEspn.set(r.espn_id, []);
      byEspn.get(r.espn_id).push(r.id);
    }
  }
  // The old key, measured on the same picks so the PR can show it finds nothing.
  const viaId = ids.length
    ? db.row(`SELECT COUNT(*) AS n FROM players WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids).n : 0;

  const ownerOf = new Map();
  for (const [roster, list] of rosters) for (const id of list) ownerOf.set(Number(id), String(roster));

  const byPlayer = new Map();
  const unjoined = [];
  for (const p of picks) {
    const espn = Number(p.player_id);
    const hits = espn > 0 ? byEspn.get(espn) ?? [] : [];
    const why = !(espn > 0) ? 'placeholder espn id'
      : hits.length === 0 ? 'espn id on no players row'
        : hits.length > 1 ? `espn id on ${hits.length} players rows` : null;
    if (why) { unjoined.push({ overall_pick: p.overall_pick, espn_id: espn, why }); continue; }
    const app = hits[0];
    byPlayer.set(app, { espn_id: espn, overall_pick: p.overall_pick, round: p.round,
      drafting_roster: String(p.team_id), current_roster: ownerOf.get(app) ?? null });
  }
  return {
    status: 'ok', reason: null, season, picks: picks.length, joined: byPlayer.size,
    joined_via_players_id: viaId, unjoined,
    drafting_rosters: new Set(picks.map(p => String(p.team_id))).size,
    by_player: byPlayer,
  };
}

/**
 * The adapter's read: draftCapital with a failure recorded, not thrown. A shadow read must not take
 * the league's served plans down with it, and it must not look like "no picks" either: the error
 * is status 'error' with its message, and it reaches `_run.inputs.draft_id_map` through draftSummary.
 */
export function draftCapitalGuarded(db, opts) {
  try {
    return draftCapital(db, opts);
  } catch (e) {
    return empty('error', `draft capital read failed: ${e?.message ?? e}`, opts?.season);
  }
}

/** Counts only, for `_run.inputs.draft_id_map`: no names, no per-player rows. */
export function draftSummary(d) {
  const unjoinedWhy = {};
  for (const u of d.unjoined) unjoinedWhy[u.why] = (unjoinedWhy[u.why] ?? 0) + 1;
  return {
    status: d.status, reason: d.reason, season: d.season, picks: d.picks, joined: d.joined,
    joined_via_players_id: d.joined_via_players_id, unjoined: d.unjoined.length, unjoined_why: unjoinedWhy,
    drafting_rosters: d.drafting_rosters,
    drafted_on_rosters_now: [...d.by_player.values()].filter(x => x.current_roster != null).length,
    lane: 'shadow',
  };
}
