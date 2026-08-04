/**
 * First-party MLB data pipeline.
 *
 * Historical games, first-inning results, and every batter/pitcher game log come
 * straight from MLB's public Stats API — free, no key, same source Diamond Signal's
 * own pipeline description names. This gives real training volume under our own
 * control instead of depending on someone else's small proxied dataset.
 *
 * Two tricks keep this cheap:
 *  - `schedule` with `hydrate=linescore` returns an entire season's games *and*
 *    inning-by-inning scoring in one request, which is all NRFI/YRFI needs.
 *  - Player game logs come one call per player (`stats=gameLog`), each returning
 *    every game they played that season, rather than one call per game per team.
 * A season is on the order of 1,500 requests total, not tens of thousands.
 */
import { db, rows, run } from '../db/index.js';

const BASE = 'https://statsapi.mlb.com/api/v1';

db.exec(`
  CREATE TABLE IF NOT EXISTS mlb_games (
    game_pk INTEGER PRIMARY KEY,
    season INTEGER NOT NULL,
    date TEXT NOT NULL,
    home_team TEXT NOT NULL,
    away_team TEXT NOT NULL,
    home_team_id INTEGER,
    away_team_id INTEGER,
    venue TEXT,
    first_inning_home_runs INTEGER,
    first_inning_away_runs INTEGER,
    yrfi INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_mlb_games_date ON mlb_games(date);
  CREATE INDEX IF NOT EXISTS idx_mlb_games_season ON mlb_games(season);

  CREATE TABLE IF NOT EXISTS mlb_pitcher_games (
    game_pk INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    player_name TEXT,
    season INTEGER NOT NULL,
    date TEXT NOT NULL,
    team_id INTEGER,
    opponent_id INTEGER,
    is_home INTEGER,
    games_started INTEGER,
    strikeouts INTEGER,
    innings_pitched REAL,
    batters_faced INTEGER,
    earned_runs INTEGER,
    PRIMARY KEY (game_pk, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mlb_pg_season ON mlb_pitcher_games(season);
  CREATE INDEX IF NOT EXISTS idx_mlb_pg_player ON mlb_pitcher_games(player_id);

  CREATE TABLE IF NOT EXISTS mlb_batter_games (
    game_pk INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    player_name TEXT,
    season INTEGER NOT NULL,
    date TEXT NOT NULL,
    team_id INTEGER,
    opponent_id INTEGER,
    is_home INTEGER,
    at_bats INTEGER,
    hits INTEGER,
    doubles INTEGER,
    triples INTEGER,
    home_runs INTEGER,
    total_bases INTEGER,
    PRIMARY KEY (game_pk, player_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mlb_bg_season ON mlb_batter_games(season);
  CREATE INDEX IF NOT EXISTS idx_mlb_bg_player ON mlb_batter_games(player_id);
`);

// Columns added after the first release; existing databases get them here
// rather than needing a separate migration.
const gameCols = db.prepare(`PRAGMA table_info(mlb_games)`).all().map(c => c.name);
if (!gameCols.includes('status')) db.exec(`ALTER TABLE mlb_games ADD COLUMN status TEXT`);
if (!gameCols.includes('game_time')) db.exec(`ALTER TABLE mlb_games ADD COLUMN game_time TEXT`);

async function getJson(url, timeoutMs = 20000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`MLB Stats API ${res.status} on ${url}`);
  return res.json();
}

/** Runs a list of async jobs with bounded concurrency, tolerating individual failures. */
async function pool(items, limit, fn) {
  let i = 0, ok = 0, failed = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      try { await fn(item); ok++; } catch { failed++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return { ok, failed };
}

/* ------------------------------------------------------------- schedule/NRFI */

/** One season's games plus first-inning scoring, in a single request. */
export async function syncSeasonSchedule(season) {
  const url = `${BASE}/schedule?sportId=1&season=${season}&gameType=R&hydrate=linescore`;
  const data = await getJson(url, 60000);
  const stmt = db.prepare(`INSERT INTO mlb_games
      (game_pk, season, date, home_team, away_team, home_team_id, away_team_id,
       venue, first_inning_home_runs, first_inning_away_runs, yrfi, status, game_time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(game_pk) DO UPDATE SET
      first_inning_home_runs=excluded.first_inning_home_runs,
      first_inning_away_runs=excluded.first_inning_away_runs, yrfi=excluded.yrfi,
      status=excluded.status, game_time=excluded.game_time`);

  let n = 0, upcoming = 0;
  db.exec('BEGIN');
  try {
    for (const d of data.dates ?? []) {
      for (const g of d.games ?? []) {
        const final = g.status?.abstractGameState === 'Final';
        // Upcoming games are stored too. A betting board that only knows about
        // finished games can never show tonight's slate, which is the one you
        // would actually bet — this used to skip anything not yet Final.
        const first = final ? g.linescore?.innings?.find(inn => inn.num === 1) : null;
        const hR = first ? (first.home?.runs ?? 0) : null;
        const aR = first ? (first.away?.runs ?? 0) : null;
        stmt.run(
          g.gamePk, season, g.officialDate,
          g.teams.home.team.name, g.teams.away.team.name,
          g.teams.home.team.id, g.teams.away.team.id,
          g.venue?.name ?? null, hR, aR,
          first ? ((hR > 0 || aR > 0) ? 1 : 0) : null,
          final ? 'Final' : (g.status?.detailedState ?? 'Scheduled'),
          g.gameDate ?? null
        );
        n++;
        if (!final) upcoming++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { season, games: n, upcoming };
}

/* --------------------------------------------------------- player game logs */

async function seasonPlayers(season) {
  const data = await getJson(`${BASE}/sports/1/players?season=${season}`, 30000);
  return data.people ?? [];
}

export async function syncPitcherGameLogs(season, { concurrency = 8 } = {}) {
  const players = (await seasonPlayers(season)).filter(p => p.primaryPosition?.code === '1');
  const stmt = db.prepare(`INSERT INTO mlb_pitcher_games
      (game_pk, player_id, player_name, season, date, team_id, opponent_id, is_home,
       games_started, strikeouts, innings_pitched, batters_faced, earned_runs)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(game_pk, player_id) DO UPDATE SET
      strikeouts=excluded.strikeouts, innings_pitched=excluded.innings_pitched,
      batters_faced=excluded.batters_faced, earned_runs=excluded.earned_runs`);

  let rowsWritten = 0;
  const { ok, failed } = await pool(players, concurrency, async p => {
    const data = await getJson(`${BASE}/people/${p.id}/stats?stats=gameLog&season=${season}&group=pitching`);
    const splits = data.stats?.[0]?.splits ?? [];
    for (const s of splits) {
      const ip = Number(s.stat?.inningsPitched);
      stmt.run(
        s.game.gamePk, p.id, p.fullName, season, s.date,
        s.team?.id ?? null, s.opponent?.id ?? null, s.isHome ? 1 : 0,
        s.stat?.gamesStarted ?? 0, s.stat?.strikeOuts ?? 0,
        Number.isFinite(ip) ? ip : null, s.stat?.battersFaced ?? null, s.stat?.earnedRuns ?? null
      );
      rowsWritten++;
    }
  });
  return { season, players_ok: ok, players_failed: failed, games: rowsWritten };
}

export async function syncBatterGameLogs(season, { concurrency = 8 } = {}) {
  const players = (await seasonPlayers(season)).filter(p => p.primaryPosition?.code !== '1');
  const stmt = db.prepare(`INSERT INTO mlb_batter_games
      (game_pk, player_id, player_name, season, date, team_id, opponent_id, is_home,
       at_bats, hits, doubles, triples, home_runs, total_bases)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(game_pk, player_id) DO UPDATE SET
      at_bats=excluded.at_bats, hits=excluded.hits, doubles=excluded.doubles,
      triples=excluded.triples, home_runs=excluded.home_runs, total_bases=excluded.total_bases`);

  let rowsWritten = 0;
  const { ok, failed } = await pool(players, concurrency, async p => {
    const data = await getJson(`${BASE}/people/${p.id}/stats?stats=gameLog&season=${season}&group=hitting`);
    const splits = data.stats?.[0]?.splits ?? [];
    for (const s of splits) {
      stmt.run(
        s.game.gamePk, p.id, p.fullName, season, s.date,
        s.team?.id ?? null, s.opponent?.id ?? null, s.isHome ? 1 : 0,
        s.stat?.atBats ?? 0, s.stat?.hits ?? 0, s.stat?.doubles ?? 0,
        s.stat?.triples ?? 0, s.stat?.homeRuns ?? 0, s.stat?.totalBases ?? 0
      );
      rowsWritten++;
    }
  });
  return { season, players_ok: ok, players_failed: failed, games: rowsWritten };
}

export async function syncSeason(season) {
  const schedule = await syncSeasonSchedule(season);
  const pitchers = await syncPitcherGameLogs(season);
  const batters = await syncBatterGameLogs(season);
  return { season, schedule, pitchers, batters };
}

/* ---------------------------------------------------------------- coverage */

export function coverage() {
  return {
    games: rows('SELECT season, COUNT(*) AS n FROM mlb_games GROUP BY season ORDER BY season'),
    pitcher_games: rows(`SELECT season, COUNT(*) AS n, COUNT(DISTINCT player_id) AS players
                          FROM mlb_pitcher_games GROUP BY season ORDER BY season`),
    batter_games: rows(`SELECT season, COUNT(*) AS n, COUNT(DISTINCT player_id) AS players
                         FROM mlb_batter_games GROUP BY season ORDER BY season`)
  };
}
