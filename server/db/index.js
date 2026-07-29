import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data.sqlite');

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

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

// lightweight migration: track when a team's AI analysis was last refreshed
const teamCols = db.prepare(`PRAGMA table_info(nfl_teams)`).all().map(c => c.name);
if (!teamCols.includes('analysis_updated_at')) {
  db.exec(`ALTER TABLE nfl_teams ADD COLUMN analysis_updated_at TEXT`);
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
