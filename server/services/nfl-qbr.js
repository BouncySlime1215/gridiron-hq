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

db.exec(`CREATE TABLE IF NOT EXISTS nfl_qbr_weekly (
  season INTEGER NOT NULL, week INTEGER NOT NULL, team TEXT NOT NULL,
  player_id TEXT NOT NULL, name TEXT, opponent TEXT,
  qbr_total REAL, pts_added REAL, qb_plays INTEGER, epa_total REAL, qbr_raw REAL, sack REAL, qualified INTEGER,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, week, team, player_id)
)`);

const num = v => { if (v === '' || v == null || v === 'NA') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

export async function syncQbr({ seasons = null } = {}) {
  const res = await fetch(URL, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`qbr_week_level.csv -> HTTP ${res.status}`);
  const { header, records } = parseCsv(await res.text());
  const at = name => header.indexOf(name);
  const i = Object.fromEntries(['season', 'season_type', 'game_week', 'team_abb', 'player_id', 'name_display', 'opp_abb',
    'qbr_total', 'pts_added', 'qb_plays', 'epa_total', 'qbr_raw', 'sack', 'qualified'].map(name => [name, at(name)]));
  const stmt = db.prepare(`INSERT OR REPLACE INTO nfl_qbr_weekly
    (season,week,team,player_id,name,opponent,qbr_total,pts_added,qb_plays,epa_total,qbr_raw,sack,qualified,fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`);
  let written = 0, reviewed = 0;
  db.exec('BEGIN');
  try {
    for (const r of records) {
      if (r[i.season_type] !== 'Regular') continue;
      const season = num(r[i.season]), week = num(r[i.game_week]);
      if (!season || !week || (seasons && !seasons.includes(season))) continue;
      reviewed++;
      stmt.run(season, week, canonicalTeamCode(r[i.team_abb]), String(r[i.player_id]), r[i.name_display] || null,
        canonicalTeamCode(r[i.opp_abb]), num(r[i.qbr_total]), num(r[i.pts_added]), num(r[i.qb_plays]), num(r[i.epa_total]),
        num(r[i.qbr_raw]), num(r[i.sack]), r[i.qualified] === 'TRUE' ? 1 : 0);
      written++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { version: NFL_QBR_VERSION, reviewed, written, source: URL };
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

export function qbrStatus() {
  return { version: NFL_QBR_VERSION, by_season: rows(`SELECT season, COUNT(*) rows, COUNT(DISTINCT team) teams, MAX(week) last_week FROM nfl_qbr_weekly GROUP BY season ORDER BY season`),
    source: URL };
}
