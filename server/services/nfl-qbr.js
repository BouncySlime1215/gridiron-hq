/**
 * ESPN weekly QBR from the nflverse release (2006 onward, free, versioned).
 * NEXT_SESSION_PLAN 3c: the quarterback is the single largest driver of a
 * line, and the council's rulebook Elo does not carry him. Stored per
 * team-week; `teamQbrProfile` gives a strictly-prior, cutoff-safe read for
 * the team's current starter as evidence for the line-move study and a
 * `qb_state` role.
 */
import { db, rows, run } from '../db/index.js';
import { parseCsv } from './nflverse.js';
import { canonicalTeamCode } from './team-codes.js';

export const NFL_QBR_VERSION = 'nfl-qbr-weekly-v1';
const URL = 'https://github.com/nflverse/nflverse-data/releases/download/espn_data/qbr_week_level.csv';

const num = v => { if (v === '' || v == null || v === 'NA') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

export async function syncQbr({ seasons = null } = {}) {
  const res = await fetch(URL, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`qbr_week_level.csv -> HTTP ${res.status}`);
  const { header, records } = parseCsv(await res.text());
  const at = name => header.indexOf(name);
  const i = Object.fromEntries(['season', 'season_type', 'game_week', 'team_abb', 'player_id', 'name_display', 'opp_abb',
    'qbr_total', 'pts_added', 'qb_plays', 'epa_total', 'qbr_raw', 'sack', 'qualified'].map(name => [name, at(name)]));
  // 2026-09: a stale team tag from an earlier sync (a trade, or ESPN
  // correcting one) must not survive as a second row. The declared primary
  // key is (season,week,team,player_id), so a changed team alone leaves the
  // old row in place and INSERTs a new one beside it instead of replacing
  // it -- confirmed live in server/data.sqlite for player_id 15864 (Geno
  // Smith), which carried both a team='LV' row fetched 2026-09-10 and a
  // team='NYJ' row fetched 2026-09-14 simultaneously. Deleting any
  // other-team row for this exact (season,week,player_id) immediately before
  // the authoritative INSERT OR REPLACE makes the *effective* upsert key
  // (season,week,player_id) without a schema/migration change: a player has
  // at most one team and one QBR result in a given week's actual game
  // (player_id is ESPN's id, confirmed elsewhere as a reliable crosswalk to
  // players.espn_id -- not a value that legitimately collides across two
  // different players), so this can only ever remove the stale sibling, not
  // a distinct real row.
  const deleteStaleTeam = db.prepare(`DELETE FROM nfl_qbr_weekly WHERE season=? AND week=? AND player_id=? AND team<>?`);
  const stmt = db.prepare(`INSERT OR REPLACE INTO nfl_qbr_weekly
    (season,week,team,player_id,name,opponent,qbr_total,pts_added,qb_plays,epa_total,qbr_raw,sack,qualified,fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`);
  // 2026-09: nfl_qbr_weekly's entire season=2026, weeks 1-18 turned out to be
  // 94.5% byte-identical copies of the matching 2025 (player,week,team) row,
  // all landed by one single sync (one shared fetched_at timestamp) -- weeks
  // 2-18, which had not been played, were 100% copied. This module has no
  // season-defaulting or "carry the last known value forward" logic of its
  // own: season/week/values are taken verbatim from whatever the upstream
  // CSV says, and no other file in this codebase writes to nfl_qbr_weekly
  // (confirmed by grep). Independently re-fetching the live release
  // (github.com/nflverse/nflverse-data, tag espn_data) on 2026-09-14 found it
  // holding only 30 real season=2026 rows, all week 1, nothing for weeks
  // 2-18 -- consistent with the upstream provider itself having served a
  // full-season placeholder/scaffold at the point our 2026-09-10 sync ran,
  // since corrected. Whatever the exact upstream mechanism, a genuinely
  // played week's stat line cannot legitimately equal last year's on all six
  // independent continuous-valued columns at once -- that coincidence is not
  // realistic, so this is refused as fact regardless of source.
  const priorSeasonRow = db.prepare(`SELECT qbr_total,pts_added,qb_plays,epa_total,qbr_raw,sack
    FROM nfl_qbr_weekly WHERE season=? AND week=? AND team=? AND player_id=?`);
  const sameSix = (a, b) => a.qbr_total === b.qbr_total && a.pts_added === b.pts_added && a.qb_plays === b.qb_plays
    && a.epa_total === b.epa_total && a.qbr_raw === b.qbr_raw && a.sack === b.sack;
  let written = 0, reviewed = 0, quarantined = 0;
  db.exec('BEGIN');
  try {
    for (const r of records) {
      if (r[i.season_type] !== 'Regular') continue;
      const season = num(r[i.season]), week = num(r[i.game_week]);
      if (!season || !week || (seasons && !seasons.includes(season))) continue;
      reviewed++;
      const team = canonicalTeamCode(r[i.team_abb]);
      const player_id = String(r[i.player_id]);
      const incoming = {
        qbr_total: num(r[i.qbr_total]), pts_added: num(r[i.pts_added]), qb_plays: num(r[i.qb_plays]),
        epa_total: num(r[i.epa_total]), qbr_raw: num(r[i.qbr_raw]), sack: num(r[i.sack]),
      };
      const prior = priorSeasonRow.get(season - 1, week, team, player_id);
      if (prior && incoming.qb_plays > 0 && sameSix(incoming, prior)) { quarantined++; continue; }
      deleteStaleTeam.run(season, week, player_id, team);
      stmt.run(season, week, team, player_id, r[i.name_display] || null, canonicalTeamCode(r[i.opp_abb]),
        incoming.qbr_total, incoming.pts_added, incoming.qb_plays, incoming.epa_total, incoming.qbr_raw, incoming.sack,
        r[i.qualified] === 'TRUE' ? 1 : 0);
      written++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { version: NFL_QBR_VERSION, reviewed, written, quarantined, source: URL };
}

/**
 * The team's quarterback picture from strictly earlier weeks: the current
 * starter (most plays in the most recent prior week), his trailing QBR over
 * his last six starts (this season first, last season to fill), the team's
 * trailing QBR regardless of starter, and whether the starter changed
 * between the last two prior weeks.
 */
export function teamQbrProfile(season, week, team, { window = 6 } = {}) {
  const prior = rows(`SELECT season,week,player_id,name,qbr_total,qb_plays FROM nfl_qbr_weekly
    WHERE team=? AND ((season=? AND week<?) OR season=?) ORDER BY season DESC, week DESC, qb_plays DESC`, team, season, week, season - 1);
  if (!prior.length) return null;
  const weeks = new Map();
  for (const r of prior) { const key = `${r.season}|${r.week}`; if (!weeks.has(key)) weeks.set(key, r); }
  const recent = [...weeks.values()];
  const starter = recent[0];
  const starterRows = prior.filter(r => r.player_id === starter.player_id).slice(0, window);
  const teamRows = recent.slice(0, window);
  const mean = list => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : null);
  const previousStarter = recent[1]?.player_id ?? null;
  return { team, season, week, starter: { player_id: starter.player_id, name: starter.name, last_week: `${starter.season} W${starter.week}` },
    starter_qbr: mean(starterRows.map(r => r.qbr_total).filter(Number.isFinite)),
    starter_starts: starterRows.length,
    team_qbr: mean(teamRows.map(r => r.qbr_total).filter(Number.isFinite)),
    starter_changed: previousStarter != null && previousStarter !== starter.player_id ? 1 : 0,
    this_season_weeks: recent.filter(r => r.season === season).length };
}

/**
 * Player-level trailing QBR, cutoff-safe against the SAME (through, throughWeek)
 * boundary `projections.js`'s `buildProjections` uses: strictly prior seasons,
 * plus the current season only through `throughWeek` inclusive (or the whole
 * season when `throughWeek` is null, matching `history()`'s season-boundary
 * mode). Keyed on ESPN id, which is the crosswalk `nfl_qbr_weekly.player_id`
 * actually uses (confirmed by join: 5285/5294 rows match `players.espn_id`).
 *
 * Returns null when there is no qualifying evidence, so a caller can fall back
 * to "no signal" rather than a fabricated league-average QBR.
 */
export function qbrTrailingForPlayer(espnId, through, throughWeek, { window = 8 } = {}) {
  if (espnId == null) return null;
  const prior = throughWeek == null
    ? rows(`SELECT season,week,qbr_total,qb_plays FROM nfl_qbr_weekly
        WHERE player_id=? AND season<=? ORDER BY season DESC, week DESC`, String(espnId), through)
    : rows(`SELECT season,week,qbr_total,qb_plays FROM nfl_qbr_weekly
        WHERE player_id=? AND (season<? OR (season=? AND week<=?)) ORDER BY season DESC, week DESC`,
        String(espnId), through, through, throughWeek);
  const starts = prior.filter(r => Number.isFinite(r.qbr_total) && r.qb_plays >= 5).slice(0, window);
  if (!starts.length) return null;
  const qbr = starts.reduce((s, r) => s + r.qbr_total, 0) / starts.length;
  return { qbr, starts: starts.length };
}

export function qbrStatus() {
  return { version: NFL_QBR_VERSION, by_season: rows(`SELECT season, COUNT(*) rows, COUNT(DISTINCT team) teams, MAX(week) last_week FROM nfl_qbr_weekly GROUP BY season ORDER BY season`),
    source: URL };
}
