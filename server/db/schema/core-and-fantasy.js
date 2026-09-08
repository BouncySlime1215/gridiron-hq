/**
 * Legacy schema fragment: core-and-fantasy.
 *
 * Every statement below is lifted verbatim (same column order, defaults,
 * constraint text and inline comments) from the source files in `sources`,
 * which still run the originals at import time until the removal phase. See
 * server/db/schema/README.md for the contract and core-and-fantasy.manifest.json
 * for the line ranges each statement came from.
 *
 * File order follows the production import order (server/index.js top-level
 * imports, then scripts/schema-files.txt) with server/db/index.js first, since
 * it is evaluated before every other module. Within a file, statements keep
 * their original order — this matters for the guarded ALTERs on `drafts` and
 * `draft_picks`, where db/index.js's columns precede espn-draft.js's.
 *
 * Deliberately NOT here (left in server/db/index.js): the PRAGMAs, the
 * `schema_migrations` and `db_health_checks` tables (index.js must create those
 * itself before any migration can be recorded or a health check stored), the
 * integrity/quick check, the espn_settings -> leagues row copy, and the
 * migrate()/rows/row/run helpers.
 */

export const sources = [
  'server/db/index.js',
  'server/routes/espn.js',
  'server/routes/aggregates.js',
  'server/routes/nfldata.js',
  'server/routes/stats.js',
  'server/routes/accolades.js',
  'server/routes/edge.js',
  'server/routes/tradelab.js',
  'server/routes/props.js',
  'server/services/audit-registry.js',
  'server/services/beat-the-close.js',
  'server/services/cfbd.js',
  'server/services/claude.js',
  'server/services/consensus-weights.js',
  'server/services/contingency.js',
  'server/services/correlation.js',
  'server/services/decay-watch.js',
  'server/services/decision-basis.js',
  'server/services/draft-ingest.js',
  'server/services/draft-reconcile.js',
  'server/services/espn-draft.js',
  'server/services/espn-market.js',
  'server/services/evidence-daemon.js',
  'server/services/fantasy-coordinator.js',
  'server/services/ffopportunity.js',
  'server/services/forward-ledger.js',
  'server/services/gamescript.js',
  'server/services/historical-adp-scrapes.js',
  'server/services/historical-adp.js',
  'server/services/line-shopping.js'
];

/** ONLY `CREATE TABLE IF NOT EXISTS ...` statements, verbatim. */
export function tables(db) {
  // server/db/index.js:17-120 (block opened at line 12; PRAGMAs at 13-15 stay in index.js)
  db.exec(`
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

  // server/db/index.js:139-196 (block 138-202; schema_migrations at 198-201 stays in index.js)
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
`);

  // server/routes/espn.js:16-19
  db.exec(`CREATE TABLE IF NOT EXISTS player_team_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL,
  player_name TEXT NOT NULL, from_team TEXT, to_team TEXT, detected_at TEXT NOT NULL
)`);

  // server/routes/aggregates.js:11-17 (server/services/contingency.js:34-38 defines the
  // same table; identical after whitespace normalization — see manifest "conflicts")
  db.exec(`CREATE TABLE IF NOT EXISTS player_metrics (
  player_id INTEGER NOT NULL REFERENCES players(id),
  source TEXT NOT NULL,
  value REAL NOT NULL,
  fetched_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (player_id, source)
)`);

  // server/routes/nfldata.js:11-52
  db.exec(`
  CREATE TABLE IF NOT EXISTS roster_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL REFERENCES nfl_teams(id),
    espn_id INTEGER,
    name TEXT NOT NULL,
    position TEXT,
    unit TEXT,                -- offense | defense | specialTeam | ir | practiceSquad
    jersey TEXT,
    age INTEGER,
    experience INTEGER,
    height TEXT,
    weight INTEGER,
    status TEXT,
    fetched_at TEXT,
    depth_slot TEXT,
    depth_order INTEGER,
    UNIQUE(team_id, espn_id)
  );

  CREATE TABLE IF NOT EXISTS schedule_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season INTEGER NOT NULL,
    team_id INTEGER NOT NULL REFERENCES nfl_teams(id),
    week INTEGER,
    date TEXT,
    opponent_abbr TEXT,
    home INTEGER,
    UNIQUE(season, team_id, week)
  );

  CREATE TABLE IF NOT EXISTS team_cap (
    team_id INTEGER PRIMARY KEY REFERENCES nfl_teams(id),
    cap_space REAL,
    effective_cap_space REAL,
    active_spending REAL,
    dead_money REAL,
    roster_count INTEGER,
    source TEXT,
    fetched_at TEXT
  );
`);

  // server/routes/stats.js:8-19
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

  // server/routes/accolades.js:7-23
  db.exec(`
  CREATE TABLE IF NOT EXISTS player_accolades (
    roster_player_id INTEGER PRIMARY KEY REFERENCES roster_players(id),
    name TEXT,
    pro_bowls INTEGER DEFAULT 0,
    first_team_all_pro INTEGER DEFAULT 0,
    second_team_all_pro INTEGER DEFAULT 0,
    super_bowls INTEGER DEFAULT 0,
    major_awards TEXT,              -- MVP / OPOY / DPOY / OROY / DROY etc
    all_rookie INTEGER DEFAULT 0,
    draft_round INTEGER,
    draft_pick INTEGER,
    draft_year INTEGER,
    source TEXT,
    fetched_at TEXT
  );
`);

  // server/routes/accolades.js:181-189
  db.exec(`
  CREATE TABLE IF NOT EXISTS slot_weakness (
    roster_player_id INTEGER PRIMARY KEY REFERENCES roster_players(id),
    verdict TEXT,              -- 'weak' | 'fine'
    reasoning TEXT,
    stats_seen TEXT,
    generated_at TEXT
  );
`);

  // server/routes/accolades.js:272-281
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_top100 (
    season INTEGER NOT NULL,
    rank INTEGER NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT,
    fetched_at TEXT,
    PRIMARY KEY (season, rank)
  );
`);

  // server/routes/edge.js:10-23
  db.exec(`
  CREATE TABLE IF NOT EXISTS player_gamelog (
    player_id INTEGER NOT NULL,
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    opponent TEXT,
    fantasy_points REAL,
    PRIMARY KEY (player_id, season, week)
  );
  CREATE TABLE IF NOT EXISTS scout_reports (
    player_id INTEGER PRIMARY KEY REFERENCES players(id),
    verdict TEXT, report TEXT, confidence TEXT, generated_at TEXT
  );
`);

  // server/routes/tradelab.js:335-337
  db.exec(`CREATE TABLE IF NOT EXISTS trending_players (
  player_id INTEGER PRIMARY KEY, kind TEXT, count INTEGER, fetched_at TEXT
)`);

  // server/routes/props.js:25-35
  db.exec(`
  CREATE TABLE IF NOT EXISTS props_auto_picks (
    pick_date TEXT NOT NULL,
    rank INTEGER NOT NULL,
    market TEXT, selection TEXT, matchup TEXT, game_time TEXT, side TEXT, line REAL,
    american_price INTEGER, model_probability REAL, implied_probability REAL,
    probability_difference REAL, recommendation TEXT, signal TEXT,
    selected_at TEXT NOT NULL,
    PRIMARY KEY (pick_date, rank)
  );
`);

  // server/services/audit-registry.js:36-60 (was run(`...`))
  db.exec(`CREATE TABLE IF NOT EXISTS audit_registry (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  hypothesis     TEXT NOT NULL,
  metric         TEXT NOT NULL,
  direction      TEXT NOT NULL,
  threshold      REAL NOT NULL,
  preregistered_at TEXT NOT NULL,
  code_hash      TEXT NOT NULL,
  data_signature TEXT NOT NULL,
  status         TEXT NOT NULL,
  require_significance INTEGER DEFAULT 0,
  require_deterministic INTEGER DEFAULT 0,
  significant    INTEGER,
  ran_at         TEXT,
  observed       REAL,
  passed         INTEGER,
  p_value        REAL,
  sample_size    INTEGER,
  detail_json    TEXT,
  void_reason    TEXT,
  always_valid_p           REAL,
  always_valid_significant INTEGER,
  always_valid_n           INTEGER
)`);

  // server/services/beat-the-close.js:69-74
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_rule_state (
  signal TEXT PRIMARY KEY,
  consecutive_negative_weeks INTEGER NOT NULL DEFAULT 0,
  last_read_season INTEGER, last_read_week INTEGER,
  retired_at TEXT, retired_reason TEXT
)`);

  // server/services/beat-the-close.js:76-84
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_signal_snapshots (
  captured_at TEXT NOT NULL,
  season INTEGER NOT NULL, week INTEGER NOT NULL,
  home TEXT NOT NULL, away TEXT NOT NULL,
  market TEXT NOT NULL, signal TEXT NOT NULL,
  value REAL, opener_line REAL, current_line REAL, opener_at TEXT,
  detail_json TEXT,
  PRIMARY KEY (captured_at, season, week, home, market, signal)
)`);

  // server/services/cfbd.js:30-46
  db.exec(`
  CREATE TABLE IF NOT EXISTS cfbd_player_season (
    season INTEGER NOT NULL,
    player_key TEXT NOT NULL,
    name TEXT NOT NULL,
    position TEXT,
    team TEXT,
    usage_overall REAL,
    usage_rush REAL,
    usage_pass REAL,
    ppa_overall REAL,
    ppa_rush REAL,
    ppa_pass REAL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (season, player_key)
  );
`);

  // server/services/claude.js:9-24
  db.exec(`
  CREATE TABLE IF NOT EXISTS ai_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    feature TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    calls INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

  // server/services/consensus-weights.js:124-140
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_historical_ffc_adp (
    season INTEGER NOT NULL,
    source TEXT NOT NULL,
    player_key TEXT NOT NULL,
    name TEXT NOT NULL,
    position TEXT,
    team TEXT,
    adp REAL NOT NULL,
    adp_stdev REAL,
    times_drafted INTEGER,
    window_start TEXT,
    window_end TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (season, source, player_key)
  )
`);

  // server/services/contingency.js:29-33 (server/services/nfl-advanced.js — another batch —
  // also creates nfl_injuries, with modified_at inline; see manifest "conflicts")
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_injuries (
  season INTEGER, week INTEGER, gsis_id TEXT, team TEXT, full_name TEXT,
  position TEXT, report_status TEXT, practice_status TEXT, injury TEXT,
  PRIMARY KEY (season, week, gsis_id)
)`);
  // server/services/contingency.js:34-38 — player_metrics: duplicate of routes/aggregates.js:11-17
  // (identical after whitespace normalization); lifted once above, not repeated here.

  // server/services/correlation.js:29-36
  db.exec(`
  CREATE TABLE IF NOT EXISTS correlation_estimates (
    key TEXT PRIMARY KEY,       -- e.g. 'QB|WR|team'
    correlation REAL,
    pairs INTEGER,
    fitted_at TEXT
  );
`);

  // server/services/decay-watch.js:52-66
  db.exec(`CREATE TABLE IF NOT EXISTS decay_watch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_key TEXT NOT NULL,
  label TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  approved_at TEXT,
  status TEXT NOT NULL,
  flag INTEGER NOT NULL DEFAULT 0,
  n INTEGER,
  min_n INTEGER,
  mean_post_approval_effect REAL,
  p_always_valid REAL,
  reason TEXT,
  detail_json TEXT
)`);

  // server/services/decision-basis.js:33-42 (was run(`...`))
  db.exec(`CREATE TABLE IF NOT EXISTS decision_basis (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at  TEXT NOT NULL,
  season       INTEGER, week INTEGER,
  home         TEXT, away TEXT, side TEXT,
  market_margin REAL, model_margin REAL, edge_points REAL,
  result       TEXT, units REAL,
  drivers_json TEXT,
  narrative    TEXT
)`);

  // server/services/draft-ingest.js:25-43 (index at line 44 moved to indexesAndTriggers)
  db.exec(`
  CREATE TABLE IF NOT EXISTS draft_capture_sessions (
    capture_id TEXT PRIMARY KEY,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    baseline_picks INTEGER,
    started_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT
  );
  CREATE TABLE IF NOT EXISTS draft_capture_events (
    capture_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    draft_id INTEGER NOT NULL,
    ts INTEGER,
    dir TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (capture_id, seq)
  );
`);

  // server/services/draft-reconcile.js:20-47
  db.exec(`
  CREATE TABLE IF NOT EXISTS draft_pick_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    espn_pick_number INTEGER NOT NULL,
    espn_player_id INTEGER NOT NULL,
    espn_team_id INTEGER,
    reason TEXT NOT NULL,
    first_seen_at TEXT DEFAULT (datetime('now')),
    last_attempt_at TEXT DEFAULT (datetime('now')),
    attempt_count INTEGER DEFAULT 1,
    resolved_at TEXT,
    UNIQUE(draft_id, espn_pick_number, espn_player_id)
  );

  CREATE TABLE IF NOT EXISTS draft_pick_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    espn_league_id TEXT,
    season INTEGER,
    espn_pick_number INTEGER NOT NULL,
    previous_state TEXT,
    corrected_state TEXT NOT NULL,
    reason TEXT NOT NULL,
    source_snapshot TEXT,
    applied_at TEXT DEFAULT (datetime('now'))
  );
`);

  // server/services/espn-draft.js:19-27
  db.exec(`
  CREATE TABLE IF NOT EXISTS draft_advice (
    draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
    pick_number INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (draft_id, pick_number)
  );
`);

  // server/services/espn-market.js:18-25
  db.exec(`CREATE TABLE IF NOT EXISTS espn_player_market (
  espn_id INTEGER PRIMARY KEY,
  season INTEGER NOT NULL,
  adp REAL, adp_change REAL, ppr_rank INTEGER, std_rank INTEGER,
  percent_owned REAL, percent_started REAL,
  injury_status TEXT, season_proj REAL, week1_proj REAL, news_at TEXT,
  outlook TEXT, fetched_at TEXT NOT NULL
)`);

  // server/services/evidence-daemon.js:23-37 (index at lines 31-32 moved to indexesAndTriggers)
  db.exec(`
  CREATE TABLE IF NOT EXISTS evidence_capture_windows (
    sport TEXT NOT NULL, event_key TEXT NOT NULL, event_at TEXT NOT NULL,
    horizon TEXT NOT NULL, due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, captured_at TEXT,
    detail_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (sport,event_key,horizon)
  );
  CREATE TABLE IF NOT EXISTS evidence_daemon_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT,
    status TEXT NOT NULL, detail_json TEXT
  );
`);

  // server/services/fantasy-coordinator.js:107-116
  db.exec(`
  CREATE TABLE IF NOT EXISTS fantasy_coordinator_fits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    through_season INTEGER NOT NULL,
    rows INTEGER NOT NULL,
    fit_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

  // server/services/ffopportunity.js:25-43 (index at lines 44-45 moved to indexesAndTriggers)
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_ffopportunity_weekly (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    player_gsis_id TEXT NOT NULL,
    player_name TEXT,
    team TEXT,
    position TEXT,
    expected_fantasy_points REAL,
    actual_fantasy_points REAL,
    expected_pass_points REAL,
    expected_receive_points REAL,
    expected_rush_points REAL,
    expected_total_yards REAL,
    expected_touchdowns REAL,
    source_release TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    PRIMARY KEY (season,week,player_gsis_id)
  );
`);

  // server/services/forward-ledger.js:70-94 (was run(`...`))
  db.exec(`CREATE TABLE IF NOT EXISTS forward_picks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recorded_at   TEXT NOT NULL,
  season        INTEGER NOT NULL,
  week          INTEGER NOT NULL,
  home          TEXT NOT NULL,
  away          TEXT NOT NULL,
  market        TEXT NOT NULL,
  side          TEXT NOT NULL,
  line_at_pick  REAL,
  price_at_pick INTEGER,
  source        TEXT NOT NULL,
  lean          REAL,
  confidence    REAL,
  leading_reason TEXT,
  reasoning     TEXT,
  features      TEXT,
  -- Settled later, never at insert.
  closing_line  REAL,
  actual_margin REAL,
  actual_total  REAL,
  result        TEXT,
  clv_points    REAL,
  settled_at    TEXT
)`);

  // server/services/gamescript.js:26-45
  db.exec(`
  CREATE TABLE IF NOT EXISTS game_lines (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    team TEXT NOT NULL,
    opponent TEXT,
    home INTEGER,
    spread REAL,          -- from this team's perspective; negative = favoured
    total REAL,
    implied_points REAL,  -- this team's share of the total
    source TEXT,
    fetched_at TEXT,
    PRIMARY KEY (season, week, team)
  );
  CREATE TABLE IF NOT EXISTS gamescript_model (
    target TEXT PRIMARY KEY,   -- 'pass_att' | 'rush_att'
    b0 REAL, b_spread REAL, b_total REAL,
    r2 REAL, n INTEGER, fitted_at TEXT
  );
`);

  // server/services/historical-adp-scrapes.js:34-48
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_historical_adp_scrape (
    season INTEGER NOT NULL,
    source TEXT NOT NULL,
    player_key TEXT NOT NULL,
    scrape_date TEXT NOT NULL,
    name TEXT NOT NULL,
    position TEXT,
    team TEXT,
    ecr_rank REAL NOT NULL,
    ecr_std_dev REAL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (season, source, player_key, scrape_date)
  )
`);

  // server/services/historical-adp.js:60-74
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_historical_adp (
    season INTEGER NOT NULL,
    source TEXT NOT NULL,
    player_key TEXT NOT NULL,
    name TEXT NOT NULL,
    position TEXT,
    team TEXT,
    ecr_rank REAL NOT NULL,
    ecr_std_dev REAL,
    scrape_date TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (season, source, player_key)
  )
`);

  // server/services/line-shopping.js:24-31 (index at line 32 moved to indexesAndTriggers)
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_line_snapshots (
    captured_at TEXT NOT NULL, event_id TEXT NOT NULL,
    commence_time TEXT, home_team TEXT, away_team TEXT,
    book TEXT NOT NULL, market TEXT NOT NULL,
    side TEXT, line REAL, price INTEGER,
    PRIMARY KEY (captured_at, event_id, book, market, side)
  );
`);
}

/** Guarded column additions, verbatim guards translated to plain JS. */
export function alters(db) {
  // server/db/index.js:124-136
  {
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
  }

  // server/db/index.js:263-266
  {
    const leagueCols = db.prepare(`PRAGMA table_info(leagues)`).all().map(c => c.name);
    // 'redraft' | 'keeper' | 'dynasty' — drives whether we price this league off
    // FantasyCalc's dynasty or redraft value set.
    if (!leagueCols.includes('league_type')) db.exec(`ALTER TABLE leagues ADD COLUMN league_type TEXT`);
  }

  // server/routes/nfldata.js:55-57
  {
    // migrations for tables created before these columns existed
    const rpCols = db.prepare(`PRAGMA table_info(roster_players)`).all().map(c => c.name);
    if (!rpCols.includes('depth_slot')) db.exec(`ALTER TABLE roster_players ADD COLUMN depth_slot TEXT`);
    if (!rpCols.includes('depth_order')) db.exec(`ALTER TABLE roster_players ADD COLUMN depth_order INTEGER`);
  }

  // server/services/audit-registry.js:67-71 — the source wraps each ALTER in
  // try/catch and swallows "duplicate column"; translated to a table_info guard
  // (same six columns, same order, same definitions).
  {
    const auditCols = db.prepare(`PRAGMA table_info(audit_registry)`).all().map(c => c.name);
    for (const col of ['require_significance INTEGER DEFAULT 0',
      'require_deterministic INTEGER DEFAULT 0', 'significant INTEGER',
      'always_valid_p REAL', 'always_valid_significant INTEGER', 'always_valid_n INTEGER']) {
      if (!auditCols.includes(col.split(' ')[0])) db.exec(`ALTER TABLE audit_registry ADD COLUMN ${col}`);
    }
  }

  // server/services/espn-draft.js:30-46
  {
    // Live drafts are bound to a connected league; mock drafts leave these null.
    const draftCols = db.prepare(`PRAGMA table_info(drafts)`).all().map(c => c.name);
    if (!draftCols.includes('league_row_id')) db.exec(`ALTER TABLE drafts ADD COLUMN league_row_id INTEGER`);
    if (!draftCols.includes('espn_league_id')) db.exec(`ALTER TABLE drafts ADD COLUMN espn_league_id TEXT`);
    if (!draftCols.includes('season')) db.exec(`ALTER TABLE drafts ADD COLUMN season INTEGER`);
    if (!draftCols.includes('pick_order')) db.exec(`ALTER TABLE drafts ADD COLUMN pick_order TEXT`);
    if (!draftCols.includes('roster_slots')) db.exec(`ALTER TABLE drafts ADD COLUMN roster_slots TEXT`);
    if (!draftCols.includes('last_synced_at')) db.exec(`ALTER TABLE drafts ADD COLUMN last_synced_at TEXT`);
    if (!draftCols.includes('draft_at')) db.exec(`ALTER TABLE drafts ADD COLUMN draft_at TEXT`);
    // NULL/0 means "we could not prove which ESPN team is the connected user's" — the
    // client must ask them to confirm before treating any slot as "my turn" (Phase 3A).
    if (!draftCols.includes('my_slot_confirmed')) db.exec(`ALTER TABLE drafts ADD COLUMN my_slot_confirmed INTEGER DEFAULT 1`);
    // In-page capture (draft-ingest.js): a per-draft key the bookmarklet presents, and
    // the last time it delivered frames — while that is fresh, polling ESPN is paused.
    if (!draftCols.includes('ingest_key_hash')) db.exec(`ALTER TABLE drafts ADD COLUMN ingest_key_hash TEXT`);
    if (!draftCols.includes('ingest_key_expires_at')) db.exec(`ALTER TABLE drafts ADD COLUMN ingest_key_expires_at TEXT`);
    if (!draftCols.includes('ingest_last_seen_at')) db.exec(`ALTER TABLE drafts ADD COLUMN ingest_last_seen_at TEXT`);
    if (!draftCols.includes('ingest_capture_id')) db.exec(`ALTER TABLE drafts ADD COLUMN ingest_capture_id TEXT`);
  }

  // server/services/espn-draft.js:55-57
  {
    const pickCols = db.prepare(`PRAGMA table_info(draft_picks)`).all().map(c => c.name);
    if (!pickCols.includes('espn_team_id')) db.exec(`ALTER TABLE draft_picks ADD COLUMN espn_team_id INTEGER`);
    if (!pickCols.includes('keeper')) db.exec(`ALTER TABLE draft_picks ADD COLUMN keeper INTEGER DEFAULT 0`);
  }

  // server/services/gamescript.js:50-76
  {
    // Real final scores and real sportsbook prices (not just the spread/total numbers), added
    // alongside the original columns — both are already sitting in the same nflverse/ESPN
    // responses this file already fetches, and the NFL win/cover/total model needs them.
    const glCols = db.prepare(`PRAGMA table_info(game_lines)`).all().map(c => c.name);
    for (const [col, type] of [
      ['team_score', 'INTEGER'], ['opp_score', 'INTEGER'], ['moneyline', 'INTEGER'],
      ['spread_odds', 'INTEGER'], ['total_over_odds', 'INTEGER'], ['total_under_odds', 'INTEGER'],
      // Game context: weather, surface, rest and divisional status all come from the
      // same games.csv row already being read, and drive a whole family of betting
      // variables (dome vs wind, short week, off a bye, division familiarity).
      ['temp', 'INTEGER'], ['wind', 'INTEGER'], ['roof', 'TEXT'], ['surface', 'TEXT'],
      ['rest_days', 'INTEGER'], ['div_game', 'INTEGER'], ['gameday', 'TEXT'], ['gametime', 'TEXT'],
      // Opening numbers, so line movement (and reverse line movement) is measurable
      // rather than inferred. ESPN reports both the open and the current quote.
      ['open_spread', 'REAL'], ['open_total', 'REAL'], ['book_count', 'INTEGER'],
      // A neutral-site game (London, Munich, Melbourne, a relocated Super Bowl) has a
      // nominal home team and no home field. Without this flag every model hands the
      // nominal home side a ~1.9-point advantage it does not have.
      ['neutral_site', 'INTEGER'],
      // The immutable "true close": the last spread/total observed strictly before
      // this game's kickoff, frozen by syncCurrentLines and never touched again.
      // `spread`/`total` above stay live (line-shopping and movement detection read
      // them as "current"), which is exactly what lets ESPN's odds object — which
      // sometimes keeps quoting a moving in-game number after kickoff — clobber them
      // mid-game. Consumers that need the real close (forward-ledger settlement,
      // gamescript's own training path) must read these columns instead.
      ['closing_spread', 'REAL'], ['closing_total', 'REAL']
    ]) {
      if (!glCols.includes(col)) db.exec(`ALTER TABLE game_lines ADD COLUMN ${col} ${type}`);
    }
  }

  // server/services/line-shopping.js:38-41
  {
    // Provider-agnostic columns. `provider` says which feed wrote the row (the
    // Odds API, SportsGameOdds, or one of the free book feeds); `book_updated_at`
    // is the book's own last-change stamp when the feed exposes one, so a capture
    // whose book last moved four hours earlier is not mistaken for a fresh quote.
    for (const [col, type] of [['provider', 'TEXT'], ['book_updated_at', 'TEXT']]) {
      const cols = db.prepare('PRAGMA table_info(nfl_line_snapshots)').all().map(c => c.name);
      if (!cols.includes(col)) db.exec(`ALTER TABLE nfl_line_snapshots ADD COLUMN ${col} ${type}`);
    }
  }
}

/** `CREATE INDEX IF NOT EXISTS` and `CREATE TRIGGER IF NOT EXISTS`, verbatim. */
export function indexesAndTriggers(db) {
  // server/services/decision-basis.js:43 (was run(`...`))
  db.exec(`CREATE INDEX IF NOT EXISTS idx_db_season ON decision_basis(season, week)`);

  // server/services/draft-ingest.js:44
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_draft_capture_events_draft ON draft_capture_events(draft_id, capture_id, seq);
`);

  // server/services/evidence-daemon.js:31-32
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_evidence_windows_due
    ON evidence_capture_windows(status,due_at);
`);

  // server/services/ffopportunity.js:44-45
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_ffopp_player_cutoff
    ON nfl_ffopportunity_weekly(player_gsis_id,season,week);
`);

  // server/services/forward-ledger.js:95-96 (was run(`...`))
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS forward_picks_unique
     ON forward_picks (season, week, home, away, market, source)`);

  // server/services/historical-adp-scrapes.js:49-50
  db.exec(`CREATE INDEX IF NOT EXISTS idx_adp_scrape_season_date
         ON nfl_historical_adp_scrape (season, scrape_date)`);

  // server/services/line-shopping.js:32
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_lines_event ON nfl_line_snapshots(event_id, market);
`);
}

/** Default rows that lived inside DDL blocks (`INSERT OR IGNORE ...`), verbatim. */
export function seeds(db) {
  // None in this batch. Every INSERT OR IGNORE / INSERT OR REPLACE in these files is
  // runtime data written by a sync or capture function, not a default row inside a
  // DDL block (see manifest notes).
}
