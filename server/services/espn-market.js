/**
 * ESPN's own market view of the player pool, per league.
 *
 * The people in an ESPN draft room see ESPN's rank, ESPN's ADP and ESPN's
 * injury tag next to every name, and most of them draft off it. So for an
 * ESPN league this is the single most relevant "market" signal there is —
 * more than FFC or Sleeper, which are what the board used until 2026-09-06.
 * Fetched from the league's own URL so `appliedTotal` is in the league's
 * scoring. Proven fields (300/300 coverage for 2026): ownership.averageDraftPosition,
 * draftRanksByRankType.PPR.rank, injuryStatus, stats[102026] season projection,
 * stats[1120261] week-1 projection, lastNewsDate.
 */
import { db, row, rows, run } from '../db/index.js';

const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

db.exec(`CREATE TABLE IF NOT EXISTS espn_player_market (
  espn_id INTEGER PRIMARY KEY,
  season INTEGER NOT NULL,
  adp REAL, adp_change REAL, ppr_rank INTEGER, std_rank INTEGER,
  percent_owned REAL, percent_started REAL,
  injury_status TEXT, season_proj REAL, week1_proj REAL, news_at TEXT,
  outlook TEXT, fetched_at TEXT NOT NULL
)`);

export async function syncEspnMarket(leagueRowId, { limit = 400 } = {}) {
  const lg = row('SELECT league_id, season, espn_s2, swid FROM leagues WHERE id = ?', leagueRowId);
  if (!lg) throw new Error(`league row ${leagueRowId} not found`);
  const season = lg.season;
  const filter = {
    players: {
      limit,
      filterSlotIds: { value: [0, 2, 4, 6, 16, 17, 23] },
      sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'PPR' },
      filterStatsForTopScoringPeriodIds: { value: 2, additionalValue: [`00${season}`, `10${season}`, `11${season}1`] }
    }
  };
  const headers = { Accept: 'application/json', 'x-fantasy-filter': JSON.stringify(filter) };
  if (lg.espn_s2 && lg.swid) headers.Cookie = `espn_s2=${lg.espn_s2}; SWID=${lg.swid}`;
  const url = `${BASE}/seasons/${season}/segments/0/leagues/${lg.league_id}?view=kona_player_info`;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`ESPN kona_player_info ${resp.status}`);
  const data = await resp.json();
  const now = new Date().toISOString();
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const e of data.players ?? []) {
      const p = e.player ?? e;
      if (p?.id == null) continue;
      const seasonStat = (p.stats ?? []).find(s => s.statSourceId === 1 && s.scoringPeriodId === 0 && s.seasonId === season);
      const week1 = (p.stats ?? []).find(s => s.statSourceId === 1 && s.scoringPeriodId === 1 && s.seasonId === season);
      run(`INSERT INTO espn_player_market (espn_id, season, adp, adp_change, ppr_rank, std_rank, percent_owned, percent_started,
             injury_status, season_proj, week1_proj, news_at, outlook, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(espn_id) DO UPDATE SET season=excluded.season, adp=excluded.adp, adp_change=excluded.adp_change,
             ppr_rank=excluded.ppr_rank, std_rank=excluded.std_rank, percent_owned=excluded.percent_owned,
             percent_started=excluded.percent_started, injury_status=excluded.injury_status, season_proj=excluded.season_proj,
             week1_proj=excluded.week1_proj, news_at=excluded.news_at, outlook=excluded.outlook, fetched_at=excluded.fetched_at`,
        p.id, season,
        p.ownership?.averageDraftPosition ?? null, p.ownership?.averageDraftPositionPercentChange ?? null,
        p.draftRanksByRankType?.PPR?.rank ?? null, p.draftRanksByRankType?.STANDARD?.rank ?? null,
        p.ownership?.percentOwned ?? null, p.ownership?.percentStarted ?? null,
        p.injuryStatus ?? null, seasonStat?.appliedTotal ?? null, week1?.appliedTotal ?? null,
        p.lastNewsDate ? new Date(p.lastNewsDate).toISOString() : null,
        p.seasonOutlook ? String(p.seasonOutlook).slice(0, 1200) : null, now);
      n++;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { synced: n, fetched_at: now };
}

/** ESPN market rows keyed by OUR player id, for the board. */
export function espnMarketByPlayerId() {
  const out = new Map();
  for (const r of rows(`SELECT p.id AS player_id, m.* FROM espn_player_market m JOIN players p ON p.espn_id = m.espn_id`)) {
    out.set(r.player_id, r);
  }
  return out;
}

export function espnMarketFreshness() {
  return row(`SELECT COUNT(*) AS n, MAX(fetched_at) AS fetched_at FROM espn_player_market`);
}
