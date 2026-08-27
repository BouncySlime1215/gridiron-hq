/**
 * Head-coach history and coaching change.
 *
 * CORRECTION to an earlier finding in `docs/WORK_LOG.md`: coaching history was
 * recorded there as unavailable, on the basis that `nfl_teams` holds only a
 * current staff snapshot with no season dimension. That was true of the local
 * database and false as a conclusion. `nflverse/nfldata`'s `games.csv` carries
 * `home_coach` and `away_coach` on every game back to 1999, which yields an
 * exact per-team-per-season head-coach history — 384 team-seasons from 2015
 * alone, 7-11 changes a year, verifiable against public record (Belichick ->
 * Mayo in 2024, Fisher -> McVay in 2017).
 *
 * This does NOT supersede `nfl-scheme.js`. The two answer different questions
 * and are complementary:
 *
 *   nfl-coaches.js   WHO changed — a discrete, verifiable roster fact
 *   nfl-scheme.js    WHAT changed — the play-calling discontinuity that
 *                    actually reaches a player's usage
 *
 * A new head coach who retains the system should not move a projection; an
 * unchanged staff that overhauls its identity should. Having both lets that
 * distinction be tested rather than assumed, which is the point.
 *
 * Limitation, stated: this is HEAD coach only. Offensive coordinator is the
 * role closer to play-calling, and nfldata does not carry it. A coordinator
 * change under a retained head coach is invisible here — which is precisely
 * the case scheme discontinuity detection is meant to catch.
 */
import { db, rows, run } from '../db/index.js';

const NFLDATA_GAMES = 'https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv';

db.exec(`CREATE TABLE IF NOT EXISTS nfl_team_coaches (
  season INTEGER NOT NULL, team TEXT NOT NULL, coach TEXT NOT NULL,
  games INTEGER NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, team)
)`);

/** Minimal CSV split that tolerates quoted fields containing commas. */
function splitCsvLine(line) {
  const out = []; let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { quoted = !quoted; continue; }
    if (c === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Pull head-coach-by-season from nfldata and store the primary coach per
 * team-season (the one who coached the most games, so a midseason firing
 * resolves to whoever actually ran the year).
 */
export async function syncCoaches({ fromSeason = 2015 } = {}) {
  const res = await fetch(NFLDATA_GAMES);
  if (!res.ok) throw new Error(`nfldata games.csv fetch failed: ${res.status}`);
  const text = await res.text();
  const lines = text.split('\n');
  const hdr = splitCsvLine(lines[0]);
  const idx = name => hdr.indexOf(name);
  const iSeason = idx('season'), iHome = idx('home_team'), iAway = idx('away_team');
  const iHC = idx('home_coach'), iAC = idx('away_coach');
  if ([iSeason, iHome, iAway, iHC, iAC].some(i => i < 0)) {
    throw new Error('nfldata games.csv is missing expected coach/team columns');
  }
  const counts = new Map();  // `${season}|${team}` -> Map(coach -> games)
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line);
    if (c.length < hdr.length) continue;
    const season = Number(c[iSeason]);
    if (!Number.isInteger(season) || season < fromSeason) continue;
    for (const [team, coach] of [[c[iHome], c[iHC]], [c[iAway], c[iAC]]]) {
      if (!team || !coach) continue;
      const key = `${season}|${team}`;
      const m = counts.get(key) ?? new Map();
      m.set(coach, (m.get(coach) ?? 0) + 1);
      counts.set(key, m);
    }
  }
  const now = new Date().toISOString();
  let stored = 0;
  db.exec('BEGIN');
  try {
    for (const [key, m] of counts) {
      const [season, team] = key.split('|');
      const [coach, games] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      run(`INSERT INTO nfl_team_coaches (season,team,coach,games,fetched_at) VALUES (?,?,?,?,?)
           ON CONFLICT(season,team) DO UPDATE SET coach=excluded.coach, games=excluded.games, fetched_at=excluded.fetched_at`,
      Number(season), team, coach, games, now);
      stored++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { stored, seasons: [...new Set([...counts.keys()].map(k => Number(k.split('|')[0])))].sort() };
}

export function coachFor(team, season) {
  return rows(`SELECT coach, games FROM nfl_team_coaches WHERE season=? AND team=?`, season, team)[0] ?? null;
}

/** Teams whose head coach changed entering `season`. */
export function coachChanges(season) {
  const cur = new Map(rows(`SELECT team, coach FROM nfl_team_coaches WHERE season=?`, season).map(r => [r.team, r.coach]));
  const prev = new Map(rows(`SELECT team, coach FROM nfl_team_coaches WHERE season=?`, season - 1).map(r => [r.team, r.coach]));
  const out = new Map();
  for (const [team, coach] of cur) {
    const before = prev.get(team);
    if (!before) continue;
    out.set(team, { team, season, prior_coach: before, coach, changed: before !== coach });
  }
  return out;
}

export function coachHistoryStatus() {
  const x = rows(`SELECT COUNT(*) team_seasons, MIN(season) first, MAX(season) last,
                         COUNT(DISTINCT coach) coaches FROM nfl_team_coaches`)[0];
  const comparable = (x?.team_seasons ?? 0) > 0 && x.last > x.first;
  return { ...x, comparable, source: NFLDATA_GAMES,
    limitation: 'Head coach only; offensive coordinator is not carried by nfldata. ' +
      'A coordinator change under a retained head coach is invisible here and is what ' +
      'nfl-scheme.js scheme-discontinuity detection exists to catch.' };
}
