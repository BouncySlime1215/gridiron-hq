/**
 * nfelo — greerreNFL's free, public NFL Elo model and market data, read from
 * the raw GitHub CSVs the repos publish (refreshed several times a day in
 * season). Five sources, each isolated so one failing never blocks the rest:
 *
 *   qb_elos.csv                    FiveThirtyEight-schema QB-adjusted Elo,
 *                                  carried forward past 538's shutdown
 *                                  (repo greerreNFL/nfeloqb)   -> nfl_nfelo_qb
 *   nfelo_games.csv                the nfelo model's per-game components and
 *                                  its own open/close spread next to the
 *                                  market's (repo greerreNFL/nfelo) -> nfl_nfelo_games
 *   historic_projected_spreads.csv the pre-market-regression nfelo line — the
 *                                  model's opinion before it is pulled toward
 *                                  the market                     -> merged into nfl_nfelo_games
 *   lines.csv                      open/last spread, ML, total plus the public
 *                                  ticket and money splits on the spread
 *                                  (repo greerreNFL/nfelomarket_data) -> nfl_nfelo_lines
 *   stadiums.csv / team_stadiums.csv  venue coordinates, altitude, roof, tz
 *                                  (repo greerreNFL/Stadiums)   -> nfl_stadiums, nfl_team_stadiums
 *
 * Team codes: nfelo still writes OAK for the Raiders in every season and
 * team_stadiums maps OAK -> VEG00; everything is passed through
 * `canonicalTeamCode` (OAK -> LV, LA -> LAR, SD -> LAC, STL -> LAR, WSH -> WAS,
 * JAC -> JAX) on the way in, so `home`/`away`/`team1`/`team2` are nflverse
 * codes. The upstream `game_id` (`2021_01_SF_DET` = season_week_away_home) is
 * kept verbatim as the primary key so a row can always be traced back.
 *
 * `nfeloFeatures` is home-minus-away from the home team's perspective, and
 * every feature is null when the evidence is absent — never 0.
 */
import { db, rows, row, run } from '../db/index.js';
import { canonicalTeamCode } from './team-codes.js';

export const NFELO_VERSION = 'nfelo-github-csv-v1';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const NFELO_SOURCES = Object.freeze({
  qb: 'https://raw.githubusercontent.com/greerreNFL/nfeloqb/main/qb_elos.csv',
  games: 'https://raw.githubusercontent.com/greerreNFL/nfelo/main/output_data/nfelo_games.csv',
  hps: 'https://raw.githubusercontent.com/greerreNFL/nfelo/main/output_data/historic_projected_spreads.csv',
  lines: 'https://raw.githubusercontent.com/greerreNFL/nfelomarket_data/main/Data/lines.csv',
  stadiums: 'https://raw.githubusercontent.com/greerreNFL/Stadiums/main/data/stadiums.csv',
  team_stadiums: 'https://raw.githubusercontent.com/greerreNFL/Stadiums/main/data/team_stadiums.csv'
});

/* ------------------------------------------------------------------ schema */

db.exec(`CREATE TABLE IF NOT EXISTS nfl_nfelo_qb (
  season INTEGER NOT NULL, week INTEGER, date TEXT NOT NULL,
  team1 TEXT NOT NULL, team2 TEXT NOT NULL, neutral INTEGER, game_id TEXT,
  elo1_pre REAL, elo2_pre REAL, qbelo1_pre REAL, qbelo2_pre REAL,
  qb1 TEXT, qb2 TEXT, qb1_value_pre REAL, qb2_value_pre REAL, qb1_adj REAL, qb2_adj REAL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, date, team1, team2)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_nfl_nfelo_qb_week ON nfl_nfelo_qb (season, week, team1, team2)');

db.exec(`CREATE TABLE IF NOT EXISTS nfl_nfelo_games (
  game_id TEXT PRIMARY KEY,
  season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
  starting_nfelo_home REAL, starting_nfelo_away REAL, hfa_mod REAL,
  home_538_qb_adj REAL, away_538_qb_adj REAL, nfelo_dif_base REAL,
  nfelo_home_line_open REAL, nfelo_home_line_close REAL,
  home_line_open REAL, home_line_close REAL, total_line_open REAL, total_line_close REAL,
  home_line_pre_regression REAL, market_regression_factor REAL, market_implied_elo_dif REAL,
  fetched_at TEXT NOT NULL
)`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_nfl_nfelo_games_match ON nfl_nfelo_games (season, week, home, away)');
// The historic_projected_spreads merge columns, added idempotently for a table created before them.
{
  const cols = rows('PRAGMA table_info(nfl_nfelo_games)').map(c => c.name);
  for (const col of ['home_line_pre_regression', 'market_regression_factor', 'market_implied_elo_dif']) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE nfl_nfelo_games ADD COLUMN ${col} REAL`);
  }
}

db.exec(`CREATE TABLE IF NOT EXISTS nfl_nfelo_lines (
  game_id TEXT PRIMARY KEY,
  season INTEGER NOT NULL, week INTEGER NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL,
  home_spread_open REAL, home_spread_last REAL,
  home_spread_tickets_pct REAL, home_spread_money_pct REAL, home_spread_pcts_source TEXT, home_spread_pct_timestamp TEXT,
  home_ml_open REAL, away_ml_open REAL, home_ml_last REAL, away_ml_last REAL,
  total_line_open REAL, total_line_last REAL,
  total_over_tickets_pct REAL, total_over_money_pct REAL,
  fetched_at TEXT NOT NULL
)`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_nfl_nfelo_lines_match ON nfl_nfelo_lines (season, week, home, away)');

db.exec(`CREATE TABLE IF NOT EXISTS nfl_stadiums (
  stadium_id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL, altitude REAL,
  roof_type TEXT, surface_type TEXT, tz TEXT, city TEXT, state TEXT,
  first_game_date TEXT, last_game_date TEXT, fetched_at TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS nfl_team_stadiums (
  team TEXT NOT NULL, stadium_id TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 0,
  first_game_date TEXT, last_game_date TEXT, fetched_at TEXT NOT NULL,
  PRIMARY KEY (team, stadium_id)
)`);

/* ------------------------------------------------------------- CSV parsing */

/** Minimal RFC-4180 parser: quoted fields (stadium addresses and architects carry commas), doubled quotes, CRLF. */
export function parseCsv(text) {
  const out = [];
  let field = '', record = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { record.push(field); field = ''; }
    else if (ch === '\n') { record.push(field); out.push(record); record = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || record.length) { record.push(field); out.push(record); }
  if (!out.length) return [];
  const header = out[0];
  return out.slice(1)
    .filter(r => r.length === header.length)
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const num = v => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === 'NA' || s === 'nan' || s === 'NaN' || s === 'None') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const str = v => { const s = String(v ?? '').trim(); return s === '' || s === 'nan' || s === 'None' ? null : s; };
const flag = v => { const s = String(v ?? '').trim().toLowerCase(); return s === 'true' || s === '1' ? 1 : 0; };

/** `2021_01_SF_DET` -> { season, week, away, home } with canonical codes, or null. */
export function parseGameId(gameId) {
  const m = /^(\d{4})_(\d{1,2})_([A-Za-z]{2,3})_([A-Za-z]{2,3})$/.exec(String(gameId ?? '').trim());
  if (!m) return null;
  return { season: Number(m[1]), week: Number(m[2]), away: canonicalTeamCode(m[3]), home: canonicalTeamCode(m[4]) };
}

async function fetchCsv(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url.split('/').pop()} -> HTTP ${res.status}`);
  return parseCsv(await res.text());
}

function inTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/* ------------------------------------------------------------------ loaders */

function loadQb(records, sinceSeason, fetchedAt) {
  let written = 0, skipped = 0;
  inTransaction(() => {
    for (const r of records) {
      const season = num(r.season);
      const team1 = str(r.team1), team2 = str(r.team2), date = str(r.date);
      if (season == null || season < sinceSeason || !team1 || !team2 || !date) { skipped++; continue; }
      run(`INSERT OR REPLACE INTO nfl_nfelo_qb
        (season, week, date, team1, team2, neutral, game_id, elo1_pre, elo2_pre, qbelo1_pre, qbelo2_pre,
         qb1, qb2, qb1_value_pre, qb2_value_pre, qb1_adj, qb2_adj, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      season, num(r.week), date, canonicalTeamCode(team1), canonicalTeamCode(team2), num(r.neutral), str(r.game_id),
      num(r.elo1_pre), num(r.elo2_pre), num(r.qbelo1_pre), num(r.qbelo2_pre),
      str(r.qb1), str(r.qb2), num(r.qb1_value_pre), num(r.qb2_value_pre), num(r.qb1_adj), num(r.qb2_adj), fetchedAt);
      written++;
    }
  });
  return { rows: written, skipped };
}

function loadGames(records, sinceSeason, fetchedAt) {
  let written = 0, skipped = 0;
  inTransaction(() => {
    for (const r of records) {
      const id = parseGameId(r.game_id);
      if (!id || id.season < sinceSeason) { skipped++; continue; }
      run(`INSERT INTO nfl_nfelo_games
        (game_id, season, week, home, away, starting_nfelo_home, starting_nfelo_away, hfa_mod,
         home_538_qb_adj, away_538_qb_adj, nfelo_dif_base, nfelo_home_line_open, nfelo_home_line_close,
         home_line_open, home_line_close, total_line_open, total_line_close, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(game_id) DO UPDATE SET
          season=excluded.season, week=excluded.week, home=excluded.home, away=excluded.away,
          starting_nfelo_home=excluded.starting_nfelo_home, starting_nfelo_away=excluded.starting_nfelo_away,
          hfa_mod=excluded.hfa_mod, home_538_qb_adj=excluded.home_538_qb_adj, away_538_qb_adj=excluded.away_538_qb_adj,
          nfelo_dif_base=excluded.nfelo_dif_base, nfelo_home_line_open=excluded.nfelo_home_line_open,
          nfelo_home_line_close=excluded.nfelo_home_line_close, home_line_open=excluded.home_line_open,
          home_line_close=excluded.home_line_close, total_line_open=excluded.total_line_open,
          total_line_close=excluded.total_line_close, fetched_at=excluded.fetched_at`,
      r.game_id.trim(), id.season, id.week, id.home, id.away,
      num(r.starting_nfelo_home), num(r.starting_nfelo_away), num(r.hfa_mod),
      num(r.home_538_qb_adj), num(r.away_538_qb_adj), num(r.nfelo_dif_base),
      num(r.nfelo_home_line_open), num(r.nfelo_home_line_close),
      num(r.home_line_open), num(r.home_line_close), num(r.total_line_open), num(r.total_line_close), fetchedAt);
      written++;
    }
  });
  return { rows: written, skipped };
}

/** historic_projected_spreads merges into games rows already loaded; a game not in nfl_nfelo_games is counted, not invented. */
function loadHps(records, sinceSeason) {
  let merged = 0, unmatched = 0, skipped = 0;
  inTransaction(() => {
    for (const r of records) {
      const id = parseGameId(r.game_id);
      if (!id || id.season < sinceSeason) { skipped++; continue; }
      const res = run(`UPDATE nfl_nfelo_games SET home_line_pre_regression=?, market_regression_factor=?, market_implied_elo_dif=?
        WHERE game_id=?`, num(r.home_line_pre_regression), num(r.market_regression_factor), num(r.market_implied_elo_dif), r.game_id.trim());
      if (res.changes > 0) merged++; else unmatched++;
    }
  });
  return { merged, unmatched, skipped };
}

// lines.csv publishes ticket/money splits for the spread only (verified 2026-09-02);
// these are the column names a total split would plausibly arrive under.
const TOTAL_TICKETS_COLS = ['total_over_tickets_pct', 'over_tickets_pct', 'total_tickets_pct'];
const TOTAL_MONEY_COLS = ['total_over_money_pct', 'over_money_pct', 'total_money_pct'];
const firstNum = (r, names) => { for (const n of names) { const v = num(r[n]); if (v != null) return v; } return null; };

function loadLines(records, sinceSeason, fetchedAt) {
  let written = 0, skipped = 0;
  inTransaction(() => {
    for (const r of records) {
      const id = parseGameId(r.game_id);
      if (!id || id.season < sinceSeason) { skipped++; continue; }
      run(`INSERT OR REPLACE INTO nfl_nfelo_lines
        (game_id, season, week, home, away, home_spread_open, home_spread_last,
         home_spread_tickets_pct, home_spread_money_pct, home_spread_pcts_source, home_spread_pct_timestamp,
         home_ml_open, away_ml_open, home_ml_last, away_ml_last, total_line_open, total_line_last,
         total_over_tickets_pct, total_over_money_pct, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      r.game_id.trim(), id.season, id.week, id.home, id.away, num(r.home_spread_open), num(r.home_spread_last),
      num(r.home_spread_tickets_pct), num(r.home_spread_money_pct), str(r.home_spread_pcts_source), str(r.home_spread_pct_timestamp),
      num(r.home_ml_open), num(r.away_ml_open), num(r.home_ml_last), num(r.away_ml_last), num(r.total_line_open), num(r.total_line_last),
      firstNum(r, TOTAL_TICKETS_COLS), firstNum(r, TOTAL_MONEY_COLS), fetchedAt);
      written++;
    }
  });
  return { rows: written, skipped };
}

/** stadiums.csv keys on `stadium_id`; team_stadiums.csv repeats the venue columns under `stadium`. Both feed nfl_stadiums. */
function upsertStadium(r, fetchedAt) {
  const stadiumId = str(r.stadium_id) ?? str(r.stadium);
  if (!stadiumId) return false;
  run(`INSERT OR REPLACE INTO nfl_stadiums
    (stadium_id, name, lat, lon, altitude, roof_type, surface_type, tz, city, state, first_game_date, last_game_date, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  stadiumId, str(r.stadium_name), num(r.lat), num(r.lon), num(r.altitude), str(r.roof_type), str(r.surface_type),
  str(r.tz), str(r.city), str(r.state), str(r.first_game_date), str(r.last_game_date), fetchedAt);
  return true;
}

function loadStadiums(records, fetchedAt) {
  let written = 0;
  inTransaction(() => { for (const r of records) if (upsertStadium(r, fetchedAt)) written++; });
  return { rows: written };
}

function loadTeamStadiums(records, fetchedAt) {
  let stadiums = 0, teams = 0;
  inTransaction(() => {
    for (const r of records) {
      const team = str(r.team), stadiumId = str(r.stadium);
      if (!team || !stadiumId) continue;
      if (upsertStadium(r, fetchedAt)) stadiums++;
      run(`INSERT OR REPLACE INTO nfl_team_stadiums (team, stadium_id, is_current, first_game_date, last_game_date, fetched_at)
        VALUES (?,?,?,?,?,?)`, canonicalTeamCode(team), stadiumId, flag(r.is_current), str(r.first_game_date), str(r.last_game_date), fetchedAt);
      teams++;
    }
  });
  return { rows: teams, stadiums };
}

/* -------------------------------------------------------------------- sync */

/**
 * Fetch every nfelo source and upsert it. Each source is isolated: a failure
 * lands in `errors[source]` and the others still load. The HPS merge runs
 * after games so its UPDATE has rows to hit.
 */
export async function syncNfelo({ sinceSeason = 2020 } = {}) {
  const fetchedAt = new Date().toISOString();
  const out = { version: NFELO_VERSION, since_season: sinceSeason, fetched_at: fetchedAt, errors: {} };
  const attempt = async (name, fn) => {
    try { out[name] = await fn(); } catch (error) { out.errors[name] = error.message; }
  };
  await attempt('qb', async () => loadQb(await fetchCsv(NFELO_SOURCES.qb), sinceSeason, fetchedAt));
  await attempt('games', async () => loadGames(await fetchCsv(NFELO_SOURCES.games), sinceSeason, fetchedAt));
  await attempt('hps', async () => loadHps(await fetchCsv(NFELO_SOURCES.hps), sinceSeason));
  await attempt('lines', async () => loadLines(await fetchCsv(NFELO_SOURCES.lines), sinceSeason, fetchedAt));
  await attempt('stadiums', async () => loadStadiums(await fetchCsv(NFELO_SOURCES.stadiums), fetchedAt));
  await attempt('team_stadiums', async () => loadTeamStadiums(await fetchCsv(NFELO_SOURCES.team_stadiums), fetchedAt));
  if (!Object.keys(out.errors).length) delete out.errors;
  return out;
}

/* ---------------------------------------------------------------- features */

const diff = (a, b) => (a == null || b == null ? null : a - b);

/**
 * Home-minus-away nfelo evidence for one game. Every value is null when the
 * source row (or the field in it) is absent; nothing is defaulted to 0.
 *
 *   qb_adj_diff            538 QB adjustment, home minus away (points)
 *   elo_diff / qbelo_diff  pre-game Elo and QB-adjusted Elo, home minus away
 *   nfelo_diff             nfelo's own starting rating, home minus away
 *   nfelo_pre_line         nfelo's home line before market regression
 *   nfelo_line_open        nfelo's regressed home line at open
 *   hfa_mod                nfelo's home-field modifier (Elo points)
 *   tickets_pct_home / money_pct_home            public split on the home spread (0-1)
 *   tickets_pct_total_over / money_pct_total_over public split on the over (0-1; upstream does not publish it yet)
 */
export function nfeloFeatures(season, week, home, away) {
  const h = canonicalTeamCode(home), a = canonicalTeamCode(away);
  const s = Number(season), w = Number(week);
  const game = row('SELECT * FROM nfl_nfelo_games WHERE season=? AND week=? AND home=? AND away=?', s, w, h, a) ?? null;
  const lines = row('SELECT * FROM nfl_nfelo_lines WHERE season=? AND week=? AND home=? AND away=?', s, w, h, a) ?? null;
  // 538 rows list the home side as team1 except at neutral sites; accept either orientation and sign it home-minus-away.
  let qb = row('SELECT * FROM nfl_nfelo_qb WHERE season=? AND week=? AND team1=? AND team2=?', s, w, h, a) ?? null;
  let sign = 1;
  if (!qb) {
    qb = row('SELECT * FROM nfl_nfelo_qb WHERE season=? AND week=? AND team1=? AND team2=?', s, w, a, h) ?? null;
    sign = -1;
  }
  const oriented = (x, y) => { const d = diff(x, y); return d == null ? null : sign * d; };
  return {
    qb_adj_diff: game ? diff(game.home_538_qb_adj, game.away_538_qb_adj) : qb ? oriented(qb.qb1_adj, qb.qb2_adj) : null,
    elo_diff: qb ? oriented(qb.elo1_pre, qb.elo2_pre) : null,
    qbelo_diff: qb ? oriented(qb.qbelo1_pre, qb.qbelo2_pre) : null,
    nfelo_diff: game ? diff(game.starting_nfelo_home, game.starting_nfelo_away) : null,
    nfelo_pre_line: game?.home_line_pre_regression ?? null,
    nfelo_line_open: game?.nfelo_home_line_open ?? null,
    hfa_mod: game?.hfa_mod ?? null,
    tickets_pct_home: lines?.home_spread_tickets_pct ?? null,
    money_pct_home: lines?.home_spread_money_pct ?? null,
    tickets_pct_total_over: lines?.total_over_tickets_pct ?? null,
    money_pct_total_over: lines?.total_over_money_pct ?? null
  };
}

/* ------------------------------------------------------------------ status */

export function nfeloStatus() {
  const count = table => row(`SELECT COUNT(*) n FROM ${table}`).n;
  const span = row('SELECT MIN(season) first_season, MAX(season) last_season, MAX(fetched_at) fetched_at FROM nfl_nfelo_games');
  const latest = row('SELECT game_id, season, week, home, away FROM nfl_nfelo_games ORDER BY season DESC, week DESC, game_id DESC LIMIT 1') ?? null;
  return {
    version: NFELO_VERSION,
    rows: { nfl_nfelo_qb: count('nfl_nfelo_qb'), nfl_nfelo_games: count('nfl_nfelo_games'), nfl_nfelo_lines: count('nfl_nfelo_lines'),
      nfl_stadiums: count('nfl_stadiums'), nfl_team_stadiums: count('nfl_team_stadiums') },
    seasons: span?.first_season == null ? [] : [span.first_season, span.last_season],
    pre_regression_rows: row('SELECT COUNT(*) n FROM nfl_nfelo_games WHERE home_line_pre_regression IS NOT NULL').n,
    ticket_split_rows: row('SELECT COUNT(*) n FROM nfl_nfelo_lines WHERE home_spread_tickets_pct IS NOT NULL').n,
    latest_game: latest,
    fetched_at: span?.fetched_at ?? null
  };
}
