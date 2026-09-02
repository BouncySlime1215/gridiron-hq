import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Tests and offline diagnostics can point at an isolated database instead of
// mutating the user's league file. Production keeps the original local path.
const DB_PATH = process.env.GRIDIRON_DB_PATH || path.join(__dirname, '..', 'data.sqlite');

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 15000;

  CREATE TABLE IF NOT EXISTS nfl_teams (
    id INTEGER PRIMARY KEY,
    abbr TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    conference TEXT NOT NULL,
    division TEXT NOT NULL,
    head_coach TEXT,
    oc_name TEXT,
    dc_name TEXT,
    off_scheme TEXT,
    off_scheme_detail TEXT,
    def_scheme TEXT,
    def_scheme_detail TEXT,
    st_coordinator TEXT,
    ol_analysis TEXT,
    dl_analysis TEXT,
    lb_analysis TEXT,
    secondary_analysis TEXT,
    st_analysis TEXT,
    coach_analysis TEXT,
    primary_color TEXT,
    secondary_color TEXT
  );

  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position TEXT NOT NULL,
    team_id INTEGER REFERENCES nfl_teams(id),
    depth_rank INTEGER DEFAULT 1,
    slot_code TEXT,
    phase TEXT DEFAULT 'offense',
    bye_week INTEGER,
    fantasy_relevant INTEGER DEFAULT 0,
    scheme_note TEXT
  );

  CREATE TABLE IF NOT EXISTS ranking_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    scoring TEXT DEFAULT 'PPR',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ranking_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id INTEGER NOT NULL REFERENCES ranking_sets(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id),
    rank INTEGER NOT NULL,
    tier INTEGER DEFAULT 1,
    note TEXT,
    UNIQUE(set_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'mock',
    team_count INTEGER DEFAULT 12,
    rounds INTEGER DEFAULT 16,
    my_slot INTEGER DEFAULT 1,
    ranking_set_id INTEGER REFERENCES ranking_sets(id),
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS draft_picks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    pick_number INTEGER NOT NULL,
    team_slot INTEGER NOT NULL,
    player_id INTEGER NOT NULL REFERENCES players(id),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(draft_id, pick_number),
    UNIQUE(draft_id, player_id)
  );

  CREATE TABLE IF NOT EXISTS espn_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    league_id TEXT,
    season INTEGER,
    team_id INTEGER,
    espn_s2 TEXT,
    swid TEXT
  );

  CREATE TABLE IF NOT EXISTS espn_cache (
    key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    fetched_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS news_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    team_id INTEGER REFERENCES nfl_teams(id),
    headline TEXT NOT NULL,
    body TEXT,
    ai_analysis TEXT,
    fantasy_impact TEXT,
    importance INTEGER DEFAULT 2,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// lightweight migrations
const teamCols = db.prepare(`PRAGMA table_info(nfl_teams)`).all().map(c => c.name);
if (!teamCols.includes('analysis_updated_at')) {
  db.exec(`ALTER TABLE nfl_teams ADD COLUMN analysis_updated_at TEXT`);
}
const playerCols = db.prepare(`PRAGMA table_info(players)`).all().map(c => c.name);
if (!playerCols.includes('espn_id')) db.exec(`ALTER TABLE players ADD COLUMN espn_id INTEGER`);
if (!playerCols.includes('sleeper_id')) db.exec(`ALTER TABLE players ADD COLUMN sleeper_id TEXT`);
if (!playerCols.includes('gsis_id')) db.exec(`ALTER TABLE players ADD COLUMN gsis_id TEXT`);

const dpCols = db.prepare(`PRAGMA table_info(draft_picks)`).all().map(c => c.name);
if (!dpCols.includes('reason')) db.exec(`ALTER TABLE draft_picks ADD COLUMN reason TEXT`);
const draftCols = db.prepare(`PRAGMA table_info(drafts)`).all().map(c => c.name);
if (!draftCols.includes('pick_seconds')) db.exec(`ALTER TABLE drafts ADD COLUMN pick_seconds INTEGER DEFAULT 90`);

db.exec(`
  CREATE TABLE IF NOT EXISTS leagues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,             -- 'espn' | 'sleeper'
    league_id TEXT NOT NULL,
    season INTEGER,
    name TEXT,
    my_team_id TEXT,
    espn_s2 TEXT,
    swid TEXT,
    team_count INTEGER,
    ppr REAL DEFAULT 1,
    superflex INTEGER DEFAULT 0,
    roster_positions TEXT,              -- JSON array
    payload TEXT,                       -- cached full league JSON
    fetched_at TEXT,
    UNIQUE(platform, league_id, season)
  );

  CREATE TABLE IF NOT EXISTS draft_grades (
    draft_id INTEGER PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
    grade TEXT, summary TEXT, strengths TEXT, weaknesses TEXT,
    best_pick TEXT, reach TEXT, generated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS player_analysis (
    player_id INTEGER PRIMARY KEY REFERENCES players(id),
    verdict TEXT,                       -- BUY | SELL | HOLD
    reasoning TEXT,
    generated_at TEXT
  );

  -- Dynasty / format-aware market values. Kept separate from player_metrics on
  -- purpose: FantasyCalc prices per league format (a superflex QB is worth roughly
  -- double his 1QB value), so values cannot be stored once globally. player_metrics
  -- keeps serving the redraft 'fc_value' path unchanged.
  CREATE TABLE IF NOT EXISTS dynasty_values (
    format_key TEXT NOT NULL,
    player_id INTEGER NOT NULL REFERENCES players(id),
    value INTEGER,
    redraft_value INTEGER,
    trend30 INTEGER,
    age REAL,
    pos_rank INTEGER,
    fetched_at TEXT,
    PRIMARY KEY (format_key, player_id)
  );

  -- Draft pick market values, e.g. pick_key 'FP_2027_1' = "2027 1st".
  CREATE TABLE IF NOT EXISTS pick_values (
    format_key TEXT NOT NULL,
    pick_key TEXT NOT NULL,
    label TEXT,
    season INTEGER,
    round INTEGER,
    value INTEGER,
    fetched_at TEXT,
    PRIMARY KEY (format_key, pick_key)
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  );
`);

/**
 * Run a one-time, named migration. Schema is still created ad-hoc across ~40
 * route/service files at import time (each idempotent CREATE TABLE IF NOT
 * EXISTS / ALTER TABLE ADD COLUMN) — retroactively centralizing all of that
 * on a database people are actively using is a real but separate, higher-risk
 * project. This is the mechanism new schema changes should use going forward,
 * and what a future centralization would consolidate into.
 */
export function migrate(name, fn) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(name)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// A full integrity_check scans the entire database. Once historical NFL evidence
// grew past 2 GB, doing that on every import made each server and worker process
// spend tens of seconds proving the same file healthy. Persist the last result,
// run the lighter quick_check at most daily by default, and retain an explicit
// full mode for maintenance windows.
db.exec(`CREATE TABLE IF NOT EXISTS db_health_checks (
  check_name TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  result TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
)`);
const integrityMode = String(process.env.GRIDIRON_DB_INTEGRITY_CHECK ?? 'quick').toLowerCase();
const integrityIntervalHours = Math.max(1,
  Number(process.env.GRIDIRON_DB_INTEGRITY_INTERVAL_HOURS) || 24);
if (integrityMode !== 'off') {
  const checkName = integrityMode === 'full' ? 'integrity_check' : 'quick_check';
  const lastCheck = db.prepare('SELECT checked_at FROM db_health_checks WHERE check_name=?').get(checkName);
  const lastCheckMs = Date.parse(lastCheck?.checked_at ?? '');
  const due = !Number.isFinite(lastCheckMs)
    || Date.now() - lastCheckMs >= integrityIntervalHours * 60 * 60 * 1000;
  if (due) {
    const startedAt = performance.now();
    try {
      const result = integrityMode === 'full'
        ? db.prepare('PRAGMA integrity_check').get()?.integrity_check
        : db.prepare('PRAGMA quick_check(1)').get()?.quick_check;
      const durationMs = Math.round(performance.now() - startedAt);
      db.prepare(`INSERT INTO db_health_checks(check_name,checked_at,result,duration_ms)
        VALUES (?,datetime('now'),?,?) ON CONFLICT(check_name) DO UPDATE SET
        checked_at=excluded.checked_at,result=excluded.result,duration_ms=excluded.duration_ms`)
        .run(checkName, String(result ?? 'no result'), durationMs);
      if (result !== 'ok') console.error(`[db] ${checkName} reported a problem:`, result);
    } catch (e) {
      console.error(`[db] ${checkName} failed to run:`, e.message);
    }
  }
}

const leagueCols = db.prepare(`PRAGMA table_info(leagues)`).all().map(c => c.name);
// 'redraft' | 'keeper' | 'dynasty' — drives whether we price this league off
// FantasyCalc's dynasty or redraft value set.
if (!leagueCols.includes('league_type')) db.exec(`ALTER TABLE leagues ADD COLUMN league_type TEXT`);

// migrate the old single-league espn_settings row into leagues
const legacy = db.prepare('SELECT * FROM espn_settings WHERE id = 1').get();
if (legacy?.league_id) {
  const exists = db.prepare(`SELECT 1 FROM leagues WHERE platform='espn' AND league_id=? AND season=?`)
    .get(String(legacy.league_id), legacy.season);
  if (!exists) {
    db.prepare(`INSERT INTO leagues (platform, league_id, season, my_team_id, espn_s2, swid)
                VALUES ('espn', ?, ?, ?, ?, ?)`)
      .run(String(legacy.league_id), legacy.season, legacy.team_id != null ? String(legacy.team_id) : null,
        legacy.espn_s2, legacy.swid);
  }
}

export function rows(sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function row(sql, ...params) {
  return db.prepare(sql).get(...params);
}
export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}
