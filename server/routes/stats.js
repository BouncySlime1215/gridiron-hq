import { Router } from 'express';
import { db, rows, row, run } from '../db/index.js';

const r = Router();
const SEASON = Number(process.env.NFL_SEASON) || 2026;

db.exec(`
  CREATE TABLE IF NOT EXISTS player_season_stats (
    player_id INTEGER NOT NULL REFERENCES players(id),
    season INTEGER NOT NULL,
    kind TEXT NOT NULL,            -- 'projected' | 'actual'
    fantasy_points REAL,
    games INTEGER,
    raw TEXT,                      -- JSON of the underlying stat map
    fetched_at TEXT,
    PRIMARY KEY (player_id, season, kind)
  );
`);

// ESPN stat ids we care about (fantasy-relevant box score lines)
const STAT_LABEL = {
  3: 'passYds', 4: 'passTD', 20: 'int',
  24: 'rushYds', 25: 'rushTD', 23: 'rushAtt',
  42: 'recYds', 43: 'recTD', 53: 'rec', 58: 'targets'
};

const ESPN_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K' };

/**
 * Pull ESPN's season projections (statSourceId 1) and last year's actuals
 * (statSourceId 0) for the top ~800 fantasy players.
 */
export async function syncStats(season = SEASON) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`;
  const filter = { players: { limit: 800, sortPercOwned: { sortAsc: false, sortPriority: 1 } } };
  const resp = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Fantasy-Filter': JSON.stringify(filter) }
  });
  if (!resp.ok) throw new Error(`ESPN stats API ${resp.status}`);
  const data = await resp.json();

  const byEspnId = new Map(rows('SELECT id, espn_id FROM players WHERE espn_id IS NOT NULL').map(p => [String(p.espn_id), p.id]));
  const norm = s => (s ?? '').toLowerCase().replace(/[.'’]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
  const byName = new Map(rows('SELECT id, name, position FROM players').map(p => [`${norm(p.name)}|${p.position}`, p.id]));

  const upsert = db.prepare(`INSERT INTO player_season_stats (player_id, season, kind, fantasy_points, games, raw, fetched_at)
    VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(player_id, season, kind) DO UPDATE SET
      fantasy_points=excluded.fantasy_points, games=excluded.games, raw=excluded.raw, fetched_at=excluded.fetched_at`);

  let projected = 0, actual = 0;
  for (const entry of data.players ?? []) {
    const pl = entry.player ?? {};
    const pos = ESPN_POS[pl.defaultPositionId];
    if (!pos || !pl.fullName) continue;
    const pid = byEspnId.get(String(pl.id)) ?? byName.get(`${norm(pl.fullName)}|${pos}`);
    if (!pid) continue;

    for (const st of pl.stats ?? []) {
      // splitType 0 = full season totals
      if (st.statSplitTypeId !== 0) continue;
      const isProj = st.statSourceId === 1;
      const kind = isProj ? 'projected' : 'actual';
      // projections for the upcoming season, actuals for the season just played
      if (isProj && st.seasonId !== season) continue;
      if (!isProj && st.seasonId !== season - 1) continue;

      const raw = {};
      for (const [id, label] of Object.entries(STAT_LABEL)) {
        const v = st.stats?.[id];
        if (v != null) raw[label] = Math.round(v * 10) / 10;
      }
      upsert.run(pid, st.seasonId, kind, st.appliedTotal ?? null,
        st.stats?.['0'] != null ? Math.round(st.stats['0']) : null, JSON.stringify(raw));
      if (isProj) projected++; else actual++;
    }
  }
  return { projected, actual };
}

r.post('/sync', async (req, res, next) => {
  try { res.json(await syncStats(Number(req.query.season) || SEASON)); } catch (e) { next(e); }
});

/** Projected points + last year's actual + projected positional rank. */
export function statsFor(playerId, season = SEASON) {
  const proj = row(`SELECT fantasy_points, raw FROM player_season_stats
                    WHERE player_id = ? AND season = ? AND kind = 'projected'`, playerId, season);
  const prev = row(`SELECT fantasy_points, games, raw FROM player_season_stats
                    WHERE player_id = ? AND season = ? AND kind = 'actual'`, playerId, season - 1);
  const posRank = row(`SELECT pos_rank FROM (
      SELECT s.player_id, RANK() OVER (PARTITION BY p.position ORDER BY s.fantasy_points DESC) AS pos_rank
      FROM player_season_stats s JOIN players p ON p.id = s.player_id
      WHERE s.season = ? AND s.kind = 'projected' AND s.fantasy_points IS NOT NULL
    ) WHERE player_id = ?`, season, playerId);

  if (!proj && !prev) return null;
  const projPts = proj?.fantasy_points ?? null;
  const prevPts = prev?.fantasy_points ?? null;
  return {
    season,
    projected_points: projPts,
    projected_pos_rank: posRank?.pos_rank ?? null,
    last_season: season - 1,
    last_season_points: prevPts,
    last_season_games: prev?.games ?? null,
    delta: projPts != null && prevPts != null ? +(projPts - prevPts).toFixed(1) : null,
    projected_line: proj?.raw ? JSON.parse(proj.raw) : null,
    last_season_line: prev?.raw ? JSON.parse(prev.raw) : null
  };
}

/** Bulk map for list views: player_id -> compact stat summary. */
export function statsMap(season = SEASON) {
  const out = new Map();
  for (const s of rows(`SELECT s.player_id, s.kind, s.fantasy_points, p.position
                        FROM player_season_stats s JOIN players p ON p.id = s.player_id
                        WHERE (s.season = ? AND s.kind = 'projected')
                           OR (s.season = ? AND s.kind = 'actual')`, season, season - 1)) {
    const e = out.get(s.player_id) ?? { position: s.position };
    if (s.kind === 'projected') e.projected_points = s.fantasy_points;
    else e.last_season_points = s.fantasy_points;
    out.set(s.player_id, e);
  }
  // positional ranks off projections
  const byPos = {};
  for (const [id, e] of out) {
    if (e.projected_points == null) continue;
    (byPos[e.position] ??= []).push([id, e.projected_points]);
  }
  for (const list of Object.values(byPos)) {
    list.sort((a, b) => b[1] - a[1]);
    list.forEach(([id], i) => { out.get(id).projected_pos_rank = i + 1; });
  }
  return out;
}

/** Leaderboard: projected points by position, with last year's actuals side by side. */
r.get('/projections', (req, res) => {
  const season = Number(req.query.season) || SEASON;
  const pos = req.query.position;
  const list = rows(`SELECT p.id, p.name, p.position, p.espn_id, p.sleeper_id,
                            t.abbr AS team_abbr,
                            pr.fantasy_points AS projected_points,
                            ac.fantasy_points AS last_season_points,
                            ac.games AS last_season_games
                     FROM players p
                     LEFT JOIN nfl_teams t ON t.id = p.team_id
                     JOIN player_season_stats pr ON pr.player_id = p.id AND pr.season = ? AND pr.kind = 'projected'
                     LEFT JOIN player_season_stats ac ON ac.player_id = p.id AND ac.season = ? AND ac.kind = 'actual'
                     WHERE pr.fantasy_points IS NOT NULL ${pos ? 'AND p.position = ?' : ''}
                     ORDER BY pr.fantasy_points DESC`,
    season, season - 1, ...(pos ? [pos] : []));

  const rankCount = {};
  res.json(list.map(p => {
    rankCount[p.position] = (rankCount[p.position] ?? 0) + 1;
    return {
      ...p,
      projected_pos_rank: rankCount[p.position],
      delta: p.projected_points != null && p.last_season_points != null
        ? +(p.projected_points - p.last_season_points).toFixed(1) : null
    };
  }));
});

/** Team-level projected offense, summed from the players on each roster. */
r.get('/teams', (req, res) => {
  const season = Number(req.query.season) || SEASON;
  const list = rows(`SELECT t.abbr, t.name, t.primary_color,
                            SUM(pr.fantasy_points) AS projected_points,
                            SUM(CASE WHEN p.position='QB' THEN pr.fantasy_points ELSE 0 END) AS qb,
                            SUM(CASE WHEN p.position='RB' THEN pr.fantasy_points ELSE 0 END) AS rb,
                            SUM(CASE WHEN p.position='WR' THEN pr.fantasy_points ELSE 0 END) AS wr,
                            SUM(CASE WHEN p.position='TE' THEN pr.fantasy_points ELSE 0 END) AS te,
                            COUNT(*) AS players
                     FROM players p
                     JOIN nfl_teams t ON t.id = p.team_id
                     JOIN player_season_stats pr ON pr.player_id = p.id AND pr.season = ? AND pr.kind = 'projected'
                     WHERE p.position IN ('QB','RB','WR','TE')
                     GROUP BY t.id
                     ORDER BY projected_points DESC`, season);
  res.json(list.map((t, i) => ({ ...t, rank: i + 1 })));
});

export default r;

/** Game-by-game log from ESPN for one player (live, not cached). */
export async function fetchGameLog(espnId, season) {
  const url = `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${espnId}/gamelog?season=${season}`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`ESPN gamelog ${resp.status}`);
  const d = await resp.json();
  const labels = d.labels ?? [];
  const names = d.names ?? [];
  const eventsById = d.events ?? {};
  const out = [];
  for (const st of d.seasonTypes ?? []) {
    for (const cat of st.categories ?? []) {
      for (const ev of cat.events ?? []) {
        const meta = eventsById[ev.eventId] ?? {};
        const line = {};
        (ev.stats ?? []).forEach((v, i) => {
          const key = names[i] ?? labels[i];
          if (key) line[key] = v;
        });
        out.push({
          week: meta.week ?? null,
          date: (meta.gameDate ?? '').slice(0, 10),
          opponent: `${meta.atVs ?? ''} ${meta.opponent?.abbreviation ?? ''}`.trim(),
          score: meta.score ?? null,
          result: meta.gameResult ?? null,
          stats: line
        });
      }
    }
  }
  out.sort((a, b) => (a.week ?? 0) - (b.week ?? 0));
  return { season, labels, names, games: out };
}
