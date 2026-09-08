/**
 * Legacy schema fragment: batch "mlb-model-misc".
 *
 * DDL lifted verbatim from the 31 DDL-bearing modules listed in `sources`
 * (offseason-model.js is in the batch but carries no DDL). See README.md for
 * the fragment contract; see mlb-model-misc.manifest.json for provenance
 * (source line ranges, added IF NOT EXISTS, dynamic-column expansions, and
 * what was deliberately left in place).
 *
 * Statement order within each phase follows the batch's source-file order,
 * and each file's original statement order within that.
 */

export const sources = [
  'server/services/mlb-auto-picks.js',
  'server/services/mlb-calibration.js',
  'server/services/mlb-experiments.js',
  'server/services/mlb-pregame.js',
  'server/services/mlb.js',
  'server/services/model-governance.js',
  'server/services/model-intelligence.js',
  'server/services/nfelo.js',
  'server/services/nflverse.js',
  'server/services/odds-api.js',
  'server/services/odds-archive.js',
  'server/services/offseason-data.js',
  'server/services/offseason-model.js',
  'server/services/parlay-api.js',
  'server/services/player-career.js',
  'server/services/player-head-validation.js',
  'server/services/player-repair.js',
  'server/services/polymarket-lines.js',
  'server/services/polymarket.js',
  'server/services/prediction-markets.js',
  'server/services/press-conference.js',
  'server/services/prop-feeds.js',
  'server/services/report-cache.js',
  'server/services/scheduler.js',
  'server/services/shadow-ledger.js',
  'server/services/shrinkage-fit.js',
  'server/services/source-validation.js',
  'server/services/sportsgameodds.js',
  'server/services/trend-watch.js',
  'server/services/twitterapi-io.js',
  'server/services/weekly-learning.js',
  'server/services/weekly-weight-store.js'
];

/** ONLY `CREATE TABLE IF NOT EXISTS ...` statements, verbatim. */
export function tables(db) {
  // ---- server/services/mlb-auto-picks.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS mlb_first_party_picks (
    pick_date TEXT NOT NULL, rank INTEGER NOT NULL,
    market TEXT NOT NULL, selection TEXT, player_id INTEGER,
    matchup TEXT, game_pk INTEGER,
    side TEXT, line REAL, model_probability REAL, projection REAL,
    selected_at TEXT NOT NULL,
    PRIMARY KEY (pick_date, rank)
  );
  CREATE TABLE IF NOT EXISTS mlb_pick_decisions (
    pick_date TEXT NOT NULL, market TEXT NOT NULL, selection TEXT NOT NULL,
    game_pk INTEGER, side TEXT, line REAL, model_probability REAL,
    eligible INTEGER NOT NULL, abstention_reason TEXT, recorded_at TEXT NOT NULL,
    model_version TEXT NOT NULL, evidence_json TEXT NOT NULL,
    PRIMARY KEY (pick_date,market,selection,side,line,model_version)
  );
`);

  // ---- server/services/mlb-calibration.js
  db.exec(`CREATE TABLE IF NOT EXISTS mlb_probability_calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT NOT NULL, model_version TEXT NOT NULL,
  trained_through TEXT NOT NULL, created_at TEXT NOT NULL, sample_size INTEGER NOT NULL,
  intercept REAL, model_slope REAL, market_slope REAL, metrics_json TEXT NOT NULL,
  UNIQUE(market,model_version,trained_through)
)`);

  // ---- server/services/mlb-experiments.js
  db.exec(`CREATE TABLE IF NOT EXISTS mlb_model_experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, market TEXT NOT NULL, name TEXT NOT NULL,
  hypothesis TEXT NOT NULL, created_at TEXT NOT NULL, spec_hash TEXT NOT NULL UNIQUE,
  spec_json TEXT NOT NULL, discovery_json TEXT, validation_json TEXT, holdout_json TEXT,
  validation_passed INTEGER, verdict TEXT
)`);

  // ---- server/services/mlb-pregame.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS mlb_pregame_snapshots (
    game_pk INTEGER NOT NULL, captured_at TEXT NOT NULL, slate_date TEXT NOT NULL,
    game_time TEXT, probable_starters_json TEXT NOT NULL,
    lineups_json TEXT NOT NULL, scratches_json TEXT NOT NULL,
    lineup_status TEXT NOT NULL, odds_status TEXT NOT NULL,
    PRIMARY KEY (game_pk, captured_at)
  );
  CREATE TABLE IF NOT EXISTS mlb_market_quotes (
    captured_at TEXT NOT NULL, event_id TEXT NOT NULL, game_pk INTEGER,
    commence_time TEXT, home_team TEXT, away_team TEXT, book TEXT NOT NULL,
    market TEXT NOT NULL, selection TEXT, side TEXT, line REAL, price INTEGER,
    PRIMARY KEY (captured_at,event_id,book,market,selection,side,line)
  );
`);

  // ---- server/services/mlb.js
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

  CREATE TABLE IF NOT EXISTS mlb_probable_starters (
    game_pk INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    opponent_id INTEGER,
    date TEXT NOT NULL,
    pitcher_id INTEGER,
    pitcher_name TEXT,
    fetched_at TEXT,
    PRIMARY KEY (game_pk, team_id)
  );

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

  -- A final game is only allowed to produce a "true void" after its own
  -- boxscore was successfully hydrated. This prevents missing ingestion from
  -- being mistaken for a player who did not appear.
  CREATE TABLE IF NOT EXISTS mlb_boxscore_sync (
    game_pk INTEGER PRIMARY KEY, fetched_at TEXT NOT NULL, status TEXT NOT NULL,
    detail TEXT
  );
`);

  // ---- server/services/model-governance.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS model_feature_contracts (
    sport TEXT NOT NULL, market TEXT NOT NULL, feature_key TEXT NOT NULL,
    source TEXT NOT NULL, availability_rule TEXT NOT NULL, cadence TEXT NOT NULL,
    max_staleness_minutes INTEGER, missing_behavior TEXT NOT NULL,
    allowed_modes_json TEXT NOT NULL, leakage_risk TEXT NOT NULL,
    contract_version TEXT NOT NULL, registered_at TEXT NOT NULL,
    PRIMARY KEY (sport,market,feature_key,contract_version)
  );
  CREATE TABLE IF NOT EXISTS model_evidence_manifests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, market TEXT NOT NULL,
    model_version TEXT NOT NULL, cutoff_at TEXT NOT NULL, captured_at TEXT NOT NULL,
    manifest_hash TEXT NOT NULL UNIQUE, manifest_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS model_registry (
    sport TEXT NOT NULL, market TEXT NOT NULL, role TEXT NOT NULL,
    model_version TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL,
    metrics_json TEXT, registered_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (sport,market,role)
  );
  CREATE TABLE IF NOT EXISTS model_gate_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, market TEXT NOT NULL,
    model_version TEXT NOT NULL, created_at TEXT NOT NULL, audit_hash TEXT NOT NULL UNIQUE,
    verdict TEXT NOT NULL, gates_json TEXT NOT NULL, evidence_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS model_registry_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, market TEXT NOT NULL,
    action TEXT NOT NULL, changed_at TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL,
    gate_audit_id INTEGER, reason TEXT NOT NULL
  );
`);

  // ---- server/services/model-intelligence.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS research_hypotheses (
    id TEXT PRIMARY KEY, sport TEXT NOT NULL, title TEXT NOT NULL, hypothesis TEXT NOT NULL,
    source TEXT NOT NULL, status TEXT NOT NULL, holdout_rule TEXT NOT NULL, created_at TEXT NOT NULL
  );
`);

  // ---- server/services/nfelo.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_nfelo_qb (
  season INTEGER NOT NULL, week INTEGER, date TEXT NOT NULL,
  team1 TEXT NOT NULL, team2 TEXT NOT NULL, neutral INTEGER, game_id TEXT,
  elo1_pre REAL, elo2_pre REAL, qbelo1_pre REAL, qbelo2_pre REAL,
  qb1 TEXT, qb2 TEXT, qb1_value_pre REAL, qb2_value_pre REAL, qb1_adj REAL, qb2_adj REAL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (season, date, team1, team2)
)`);
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

  // ---- server/services/nflverse.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS player_week_usage (
    player_id INTEGER NOT NULL REFERENCES players(id),
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    team TEXT,
    opponent TEXT,
    position TEXT,
    -- opportunity
    attempts REAL, carries REAL, targets REAL, receptions REAL,
    target_share REAL, air_yards_share REAL, wopr REAL,
    receiving_air_yards REAL, passing_air_yards REAL,
    -- production
    passing_yards REAL, rushing_yards REAL, receiving_yards REAL,
    passing_tds REAL, rushing_tds REAL, receiving_tds REAL,
    interceptions REAL, fumbles_lost REAL,
    -- efficiency
    passing_epa REAL, rushing_epa REAL, receiving_epa REAL,
    cpoe REAL, racr REAL, pacr REAL,
    first_downs REAL,
    PRIMARY KEY (player_id, season, week)
  );

  CREATE TABLE IF NOT EXISTS player_week_snaps (
    player_id INTEGER NOT NULL REFERENCES players(id),
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    offense_snaps REAL, offense_pct REAL,
    PRIMARY KEY (player_id, season, week)
  );

  -- gsis_id -> position, sourced straight from nflverse's players.csv. This is
  -- comprehensive (every player who has ever appeared in a play), unlike our
  -- own players table which only carries the current ~800-player roster
  -- universe. nfl_player_week_features keys on gsis_id, so this is what makes
  -- backfilling its position column (and future ingests) possible.
  CREATE TABLE IF NOT EXISTS nflverse_player_positions (
    gsis_id TEXT PRIMARY KEY,
    position TEXT,
    position_group TEXT,
    ngs_position TEXT
  );
`);

  // ---- server/services/odds-api.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS odds_cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS odds_usage (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    requests_used INTEGER, requests_remaining INTEGER, last_call_at TEXT
  );
`);

  // ---- server/services/odds-archive.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_odds_archive (
  eid INTEGER NOT NULL,
  season INTEGER, week INTEGER,
  home TEXT NOT NULL, away TEXT NOT NULL,
  commence_time TEXT NOT NULL,
  book TEXT NOT NULL, market TEXT NOT NULL, side TEXT NOT NULL,
  phase TEXT NOT NULL,
  line REAL, price INTEGER NOT NULL,
  book_updated_at TEXT,
  source TEXT NOT NULL DEFAULT 'oddstrader',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (eid, book, market, side, phase)
)`);

  // ---- server/services/offseason-data.js
  db.exec(`
  -- Rookie draft capital. One row per pick, 1980-present upstream; we keep 2015+.
  CREATE TABLE IF NOT EXISTS off_draft_picks (
    season INTEGER NOT NULL, pick INTEGER NOT NULL,
    round INTEGER, team TEXT, gsis_id TEXT, pfr_id TEXT,
    player_name TEXT, position TEXT, side TEXT, college TEXT, age REAL,
    PRIMARY KEY (season, pick)
  );

  -- OverTheCap contract history, republished by nflverse. No gsis_id upstream;
  -- gsis_id here is resolved by name+position+draft capital against off_rosters.
  CREATE TABLE IF NOT EXISTS off_contracts (
    otc_id TEXT NOT NULL, year_signed INTEGER NOT NULL, years INTEGER NOT NULL,
    player TEXT, position TEXT, team TEXT, team_abbr TEXT, is_active INTEGER,
    value REAL, apy REAL, guaranteed REAL, apy_cap_pct REAL,
    draft_year INTEGER, draft_round INTEGER, draft_overall INTEGER,
    date_of_birth TEXT, college TEXT, gsis_id TEXT,
    PRIMARY KEY (otc_id, year_signed, years)
  );

  -- Week-1 roster per season: team, status, experience, and the id crosswalk
  -- (espn_id / pfr_id / sleeper_id) that everything else joins through.
  CREATE TABLE IF NOT EXISTS off_rosters (
    season INTEGER NOT NULL, gsis_id TEXT NOT NULL,
    team TEXT, position TEXT, depth_chart_position TEXT, status TEXT,
    jersey_number INTEGER, years_exp INTEGER, birth_date TEXT,
    height REAL, weight REAL, college TEXT,
    espn_id INTEGER, pfr_id TEXT, sleeper_id TEXT,
    entry_year INTEGER, rookie_year INTEGER, draft_club TEXT, draft_number INTEGER,
    player_name TEXT,
    PRIMARY KEY (season, gsis_id)
  );

  -- Earliest published depth chart of each season. nflverse changed formats in
  -- 2025 (weekly NFL-sourced -> dated ESPN-sourced); both normalise to this.
  CREATE TABLE IF NOT EXISTS off_depth_chart (
    season INTEGER NOT NULL, team TEXT NOT NULL, gsis_id TEXT NOT NULL,
    pos_abb TEXT NOT NULL, pos_rank INTEGER, pos_slot TEXT,
    source_week INTEGER, source_dt TEXT, player_name TEXT,
    PRIMARY KEY (season, team, gsis_id, pos_abb)
  );

  -- Next Gen Stats season totals (the week=0 rows of the weekly files).
  CREATE TABLE IF NOT EXISTS off_ngs_season (
    season INTEGER NOT NULL, gsis_id TEXT NOT NULL, kind TEXT NOT NULL,
    team TEXT, position TEXT,
    avg_separation REAL, avg_cushion REAL, avg_intended_air_yards REAL,
    air_yards_share REAL, avg_yac_above_expectation REAL, catch_percentage REAL,
    rush_efficiency REAL, rush_yards_over_expected_per_att REAL,
    pct_attempts_gte_eight_defenders REAL, avg_time_to_los REAL,
    avg_time_to_throw REAL, aggressiveness REAL, completion_pct_above_expectation REAL,
    PRIMARY KEY (season, gsis_id, kind)
  );

  -- Pro-Football-Reference advanced season splits, keyed on pfr_id.
  CREATE TABLE IF NOT EXISTS off_pfr_adv_season (
    season INTEGER NOT NULL, pfr_id TEXT NOT NULL, kind TEXT NOT NULL,
    player TEXT, team TEXT, position TEXT, games INTEGER, games_started INTEGER,
    adot REAL, yac_per_rec REAL, ybc_per_rec REAL, broken_tackles REAL,
    drop_pct REAL, ybc_per_att REAL, yac_per_att REAL,
    pressure_pct REAL, on_target_pct REAL, pocket_time REAL, play_action_att REAL,
    PRIMARY KEY (season, pfr_id, kind)
  );

  -- ESPN QBR, season level. player_id is an ESPN athlete id.
  CREATE TABLE IF NOT EXISTS off_qbr_season (
    season INTEGER NOT NULL, team TEXT NOT NULL, espn_player_id INTEGER NOT NULL,
    name TEXT, qbr_total REAL, pts_added REAL, qb_plays INTEGER,
    epa_total REAL, qbr_raw REAL, qualified INTEGER,
    PRIMARY KEY (season, team, espn_player_id)
  );

  -- nflverse schedules. Carries closing spread/total for every game 1999-present,
  -- which is what makes historical implied team totals free.
  CREATE TABLE IF NOT EXISTS off_schedule_games (
    game_id TEXT PRIMARY KEY,
    season INTEGER, game_type TEXT, week INTEGER, gameday TEXT, weekday TEXT,
    away_team TEXT, home_team TEXT, location TEXT,
    spread_line REAL, total_line REAL, away_moneyline INTEGER, home_moneyline INTEGER,
    div_game INTEGER, roof TEXT, surface TEXT, stadium_id TEXT,
    away_rest INTEGER, home_rest INTEGER,
    away_coach TEXT, home_coach TEXT,
    away_qb_id TEXT, home_qb_id TEXT, away_score INTEGER, home_score INTEGER
  );

  -- Team season totals, regular season only. Source of team pace / pass rate.
  CREATE TABLE IF NOT EXISTS off_team_season_stats (
    season INTEGER NOT NULL, team TEXT NOT NULL,
    games INTEGER, attempts REAL, carries REAL, sacks_suffered REAL,
    completions REAL, passing_yards REAL, rushing_yards REAL,
    passing_tds REAL, rushing_tds REAL, passing_epa REAL, rushing_epa REAL,
    passing_air_yards REAL, targets REAL, passing_first_downs REAL, rushing_first_downs REAL,
    PRIMARY KEY (season, team)
  );

  -- Sleeper's open players endpoint. Current state only (no history) — used for
  -- the upcoming season's depth order and injury designation.
  CREATE TABLE IF NOT EXISTS off_sleeper_players (
    sleeper_id TEXT PRIMARY KEY, gsis_id TEXT, espn_id INTEGER,
    full_name TEXT, position TEXT, team TEXT, status TEXT,
    injury_status TEXT, injury_body_part TEXT, practice_participation TEXT,
    depth_chart_position TEXT, depth_chart_order INTEGER,
    years_exp INTEGER, age REAL, fetched_at TEXT
  );

  -- Derived team-season context. Everything a player inherits from his team.
  CREATE TABLE IF NOT EXISTS off_team_season (
    season INTEGER NOT NULL, team TEXT NOT NULL,
    games_scheduled INTEGER, bye_week INTEGER,
    implied_team_points REAL, implied_points_prior REAL, implied_points_delta REAL,
    team_total_line_avg REAL, team_spread_avg REAL,
    opp_implied_points_avg REAL, division_sos_proxy REAL,
    div_games INTEGER, neutral_site_games INTEGER,
    dome_home INTEGER, home_surface TEXT,
    head_coach TEXT, hc_change INTEGER, hc_tenure_years INTEGER,
    qb_gsis_id TEXT, qb_prior_gsis_id TEXT, qb_change INTEGER,
    qb_qbr_prior REAL, qb_prior_starter_qbr REAL, qb_qbr_delta REAL,
    team_pass_rate_prior REAL, team_plays_per_game_prior REAL,
    team_pass_epa_prior REAL, team_points_per_game_prior REAL,
    draft_picks_r1_3 INTEGER,
    PRIMARY KEY (season, team)
  );

  -- The deliverable: one row per player-season, ~55 columns, all computed from
  -- data available before Week 1 of that season.
  CREATE TABLE IF NOT EXISTS off_player_season_features (
    season INTEGER NOT NULL, gsis_id TEXT NOT NULL,
    player_id INTEGER, player_name TEXT, position TEXT, team TEXT, prior_team TEXT,
    -- prior-season production and role
    prior_ppg REAL, prior_games REAL, prior_target_share REAL, prior_carry_share REAL,
    prior_air_yard_share REAL, prior_snap_share REAL, prior_wopr REAL,
    prior_epa_per_play REAL, prior_xfp_per_game REAL, prior_xfp_diff REAL,
    prior_ngs_separation REAL, prior_ngs_cushion REAL, prior_ngs_air_yards_share REAL,
    prior_ryoe_per_att REAL, prior_yac_oe REAL,
    prior_adot REAL, prior_broken_tackles REAL, prior_drop_pct REAL,
    -- offseason movement
    team_change INTEGER, new_team_vacated_target_share REAL,
    new_team_vacated_carry_share REAL, own_team_vacated_share REAL,
    capital_added_at_position INTEGER, top_pick_added_at_position INTEGER,
    veterans_added_at_position INTEGER,
    -- contract
    apy REAL, apy_cap_pct REAL, apy_rank_on_team_at_position INTEGER,
    contract_year INTEGER, new_contract INTEGER, contract_years_remaining INTEGER,
    -- team context (denormalised from off_team_season so a read is one query)
    qb_change INTEGER, qb_qbr_delta REAL, hc_change INTEGER, hc_tenure_years INTEGER,
    implied_team_points REAL, implied_points_delta_vs_prior REAL,
    team_pass_rate_prior REAL, team_plays_prior REAL, team_points_per_game_prior REAL,
    division_sos_proxy REAL, bye_week INTEGER, dome_home INTEGER, home_surface TEXT,
    -- depth chart
    depth_slot_t INTEGER, depth_slot_prior_end INTEGER, depth_slot_delta INTEGER,
    sleeper_depth_chart_order INTEGER, sleeper_injury_status TEXT,
    -- biography
    age_at_season REAL, years_exp INTEGER, rookie INTEGER,
    draft_round INTEGER, draft_pick INTEGER,
    -- availability
    injury_games_missed_prior INTEGER, injury_reports_prior INTEGER,
    ir_stints_prior INTEGER, late_season_injury_flag INTEGER,
    computed_at TEXT,
    PRIMARY KEY (season, gsis_id)
  );
`);

  // ---- server/services/offseason-model.js: no DDL.

  // ---- server/services/parlay-api.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS parlay_cache (
    cache_key TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS parlay_usage (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    requests_used INTEGER, requests_remaining INTEGER, requests_last INTEGER, last_call_at TEXT
  );
`);

  // ---- server/services/player-career.js
  // (Identical text to nfl-pbp.js's definition; whichever fragment runs first wins, same result.)
  db.exec(`
  CREATE TABLE IF NOT EXISTS nfl_player_week_features (
    season INTEGER NOT NULL, week INTEGER NOT NULL, player_id TEXT NOT NULL,
    player_name TEXT, team TEXT, opponent TEXT, position TEXT, features TEXT NOT NULL,
    PRIMARY KEY (season, week, player_id)
  );
`);

  // ---- server/services/player-head-validation.js
  db.exec(`CREATE TABLE IF NOT EXISTS player_head_audits (
  spec_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, registry_version TEXT NOT NULL,
  development_season INTEGER NOT NULL, discovery_season INTEGER NOT NULL,
  validation_season INTEGER, validation_opened INTEGER NOT NULL DEFAULT 0,
  result_json TEXT NOT NULL
)`);

  // ---- server/services/player-repair.js
  db.exec(`CREATE TABLE IF NOT EXISTS player_identity_repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, player_id INTEGER NOT NULL,
  stable_id_type TEXT NOT NULL, stable_id TEXT NOT NULL, old_name TEXT NOT NULL,
  new_name TEXT NOT NULL, evidence_rows INTEGER NOT NULL, evidence_share REAL NOT NULL,
  repaired_at TEXT NOT NULL
);`);

  // ---- server/services/polymarket-lines.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS polymarket_line_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_at TEXT NOT NULL, captured_at TEXT NOT NULL,
    season INTEGER, week INTEGER, event_title TEXT NOT NULL,
    home_team TEXT, away_team TEXT, commence_time TEXT,
    home_spread REAL, total REAL,
    prev_home_spread REAL, prev_total REAL,
    spread_delta REAL, total_delta REAL, spread_move_value REAL,
    spread_ladder INTEGER, total_ladder INTEGER,
    first_sighting INTEGER NOT NULL DEFAULT 0,
    UNIQUE(event_title, captured_at)
  );
`);

  // ---- server/services/polymarket.js
  db.exec(`CREATE TABLE IF NOT EXISTS polymarket_markets (
  condition_id TEXT PRIMARY KEY,
  question     TEXT,
  event_title  TEXT,
  kind         TEXT,
  player       TEXT,
  stat         TEXT,
  threshold    REAL,
  end_date     TEXT,
  clob_token_yes TEXT,
  clob_token_no  TEXT,
  first_seen   TEXT
)`);
  db.exec(`CREATE TABLE IF NOT EXISTS polymarket_quotes (
  captured_at  TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  mid_yes      REAL,
  best_bid     REAL,
  best_ask     REAL,
  bid_size     REAL,
  ask_size     REAL,
  spread       REAL,
  volume       REAL,
  liquidity    REAL,
  PRIMARY KEY (captured_at, condition_id)
)`);
  db.exec(`CREATE TABLE IF NOT EXISTS polymarket_price_history (
  condition_id TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  price        REAL NOT NULL,
  PRIMARY KEY (condition_id, ts)
)`);

  // ---- server/services/prediction-markets.js
  db.exec(`CREATE TABLE IF NOT EXISTS prediction_market_quotes (
  captured_at TEXT NOT NULL,
  venue       TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  title       TEXT,
  team        TEXT,
  event_key   TEXT,
  yes_price   REAL,
  no_price    REAL,
  open_interest REAL,
  volume      REAL,
  close_time  TEXT,
  PRIMARY KEY (captured_at, venue, ticker)
)`);
  db.exec(`CREATE TABLE IF NOT EXISTS prediction_market_flow (
  trade_id    TEXT PRIMARY KEY,
  venue       TEXT NOT NULL,
  ticker      TEXT NOT NULL,
  traded_at   TEXT NOT NULL,
  size        REAL,
  yes_price   REAL,
  no_price    REAL,
  taker_side  TEXT,
  is_block    INTEGER,
  notional    REAL,
  fetched_at  TEXT
)`);

  // ---- server/services/press-conference.js
  db.exec(`CREATE TABLE IF NOT EXISTS yt_channels (
  team         TEXT PRIMARY KEY,
  handle       TEXT NOT NULL,
  channel_id   TEXT,
  title        TEXT,
  subscribers  TEXT,
  verdict      TEXT,
  checked_at   TEXT
)`);
  db.exec(`CREATE TABLE IF NOT EXISTS press_conferences (
  video_id     TEXT PRIMARY KEY,
  team         TEXT,
  title        TEXT,
  published_at TEXT,
  is_presser   INTEGER,
  transcript   TEXT,
  chars        INTEGER,
  fetched_at   TEXT
)`);
  db.exec(`CREATE TABLE IF NOT EXISTS press_availability (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id     TEXT NOT NULL,
  team         TEXT,
  published_at TEXT,
  player       TEXT,
  keyword      TEXT,
  quote        TEXT
)`);

  // ---- server/services/prop-feeds.js: no CREATE (only ALTERs, see alters()).

  // ---- server/services/report-cache.js
  db.exec(`CREATE TABLE IF NOT EXISTS nfl_cached_reports (
  report TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  payload_json TEXT,
  error TEXT
)`);

  // ---- server/services/scheduler.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS sync_log (
    job TEXT PRIMARY KEY,
    last_run_at TEXT,
    last_status TEXT,
    last_detail TEXT,
    runs INTEGER DEFAULT 0
  );
`);

  // ---- server/services/shadow-ledger.js
  db.exec(`CREATE TABLE IF NOT EXISTS shadow_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sport TEXT NOT NULL, event_key TEXT NOT NULL,
  market TEXT NOT NULL, selection TEXT, model_version TEXT NOT NULL,
  probability REAL, market_probability REAL, uncertainty REAL,
  regime TEXT, decision TEXT NOT NULL, reason TEXT NOT NULL,
  captured_at TEXT NOT NULL, settled_at TEXT, outcome_json TEXT,
  UNIQUE(sport,event_key,market,model_version,captured_at)
)`);

  // ---- server/services/shrinkage-fit.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS shrinkage_fits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fitted_at TEXT NOT NULL,
    through_season INTEGER NOT NULL,
    test_season INTEGER,
    crps_fitted REAL,
    crps_hardcoded REAL,
    mae_fitted REAL,
    mae_hardcoded REAL,
    active INTEGER NOT NULL DEFAULT 0,
    note TEXT
  );
  CREATE TABLE IF NOT EXISTS shrinkage_k (
    fit_id INTEGER NOT NULL REFERENCES shrinkage_fits(id),
    metric TEXT NOT NULL,
    position TEXT NOT NULL,
    k REAL NOT NULL,
    sigma2_within REAL,
    sigma2_between REAL,
    n_groups INTEGER,
    n_obs INTEGER,
    PRIMARY KEY (fit_id, metric, position)
  );
`);

  // ---- server/services/source-validation.js
  db.exec(`CREATE TABLE IF NOT EXISTS news_source_validation (
  handle       TEXT PRIMARY KEY,
  role         TEXT,
  team         TEXT,
  checked_at   TEXT NOT NULL,
  exists_now   INTEGER,
  verified     INTEGER,
  followers    INTEGER,
  display_name TEXT,
  bio          TEXT,
  verdict      TEXT,
  reason       TEXT
)`);

  // ---- server/services/sportsgameodds.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS sgo_usage (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    objects_used_this_month INTEGER NOT NULL DEFAULT 0,
    month TEXT NOT NULL, last_call_at TEXT
  );
`);

  // ---- server/services/trend-watch.js
  db.exec(`CREATE TABLE IF NOT EXISTS trend_findings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type  TEXT NOT NULL,        -- 'team' | 'player'
  subject       TEXT NOT NULL,        -- team abbr or player id
  subject_name  TEXT,
  metric        TEXT NOT NULL,
  season        INTEGER NOT NULL,
  through_week  INTEGER NOT NULL,
  lookback      INTEGER NOT NULL,
  direction     TEXT,
  baseline      REAL,
  recent        REAL,
  effect_size   REAL,
  p_value       REAL,
  favourable    INTEGER,
  first_seen_week INTEGER,
  last_seen_week  INTEGER,
  status        TEXT,                 -- 'active' | 'faded'
  detected_at   TEXT NOT NULL
)`);

  // ---- server/services/twitterapi-io.js
  db.exec(`CREATE TABLE IF NOT EXISTS twitterapi_io_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, called_at TEXT NOT NULL,
  endpoint TEXT NOT NULL, items INTEGER NOT NULL, cost_usd REAL NOT NULL,
  purpose TEXT, query TEXT
)`);

  // ---- server/services/weekly-learning.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS weekly_prediction_snapshots (
    season INTEGER NOT NULL,
    week INTEGER NOT NULL,
    player_id INTEGER NOT NULL,
    position TEXT NOT NULL,
    as_of TEXT NOT NULL,
    cutoff TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    gridiron_engine_version TEXT,
    structural REAL NOT NULL,
    season_to_date REAL,
    last3 REAL,
    last1 REAL,
    median REAL,
    prediction REAL NOT NULL,
    lower_80 REAL,
    upper_80 REAL,
    weights_json TEXT,
    weight_fit TEXT,
    actual REAL,
    settled_at TEXT,
    PRIMARY KEY (season, week, player_id)
  );
`);

  // ---- server/services/weekly-weight-store.js
  db.exec(`
  CREATE TABLE IF NOT EXISTS weekly_ensemble_fits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data_hash TEXT NOT NULL UNIQUE,
    through_season INTEGER NOT NULL,
    through_week INTEGER NOT NULL,
    weights_json TEXT NOT NULL,
    sample_size INTEGER NOT NULL,
    validation_size INTEGER NOT NULL,
    candidate_mae REAL,
    champion_mae REAL,
    candidate_spearman REAL,
    champion_spearman REAL,
    coverage_80 REAL,
    promoted INTEGER NOT NULL DEFAULT 0,
    rejection_reason TEXT,
    epoch_id INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
}

/** Guarded column additions, verbatim guards translated to plain JS. */
export function alters(db) {
  // ---- server/services/mlb-auto-picks.js (lines 42-49)
  for (const [name, type] of [
    ['american_price', 'INTEGER'], ['implied_probability', 'REAL'], ['probability_difference', 'REAL'],
    ['book', 'TEXT'], ['quote_at', 'TEXT'], ['quote_event_id', 'TEXT'], ['model_version', 'TEXT'],
    ['pregame_snapshot_at', 'TEXT'], ['lineup_status', 'TEXT'], ['tracking_mode', 'TEXT']
  ]) {
    const cols = db.prepare('PRAGMA table_info(mlb_first_party_picks)').all().map(c => c.name);
    if (!cols.includes(name)) db.exec(`ALTER TABLE mlb_first_party_picks ADD COLUMN ${name} ${type}`);
  }

  // ---- server/services/mlb-pregame.js (lines 29-32)
  const snapshotCols = db.prepare("PRAGMA table_info(mlb_pregame_snapshots)").all().map(c => c.name);
  if (!snapshotCols.includes('odds_source')) db.exec(`ALTER TABLE mlb_pregame_snapshots ADD COLUMN odds_source TEXT`);
  const quoteCols = db.prepare("PRAGMA table_info(mlb_market_quotes)").all().map(c => c.name);
  if (!quoteCols.includes('source')) db.exec(`ALTER TABLE mlb_market_quotes ADD COLUMN source TEXT`);

  // ---- server/services/mlb.js (lines 100-102)
  const gameCols = db.prepare(`PRAGMA table_info(mlb_games)`).all().map(c => c.name);
  if (!gameCols.includes('status')) db.exec(`ALTER TABLE mlb_games ADD COLUMN status TEXT`);
  if (!gameCols.includes('game_time')) db.exec(`ALTER TABLE mlb_games ADD COLUMN game_time TEXT`);

  // ---- server/services/nfelo.js (lines 71-76); no-op on a fresh DB, the CREATE already carries these.
  {
    const cols = db.prepare('PRAGMA table_info(nfl_nfelo_games)').all().map(c => c.name);
    for (const col of ['home_line_pre_regression', 'market_regression_factor', 'market_implied_elo_dif']) {
      if (!cols.includes(col)) db.exec(`ALTER TABLE nfl_nfelo_games ADD COLUMN ${col} REAL`);
    }
  }

  // ---- server/services/nflverse.js (lines 72-80)
  {
    const cols = db.prepare(`PRAGMA table_info(nflverse_player_positions)`).all().map(c => c.name);
    const addCol = (name, type) => { if (!cols.includes(name)) db.exec(`ALTER TABLE nflverse_player_positions ADD COLUMN ${name} ${type}`); };
    addCol('birth_date', 'TEXT');
    addCol('rookie_season', 'INTEGER');
    addCol('draft_year', 'INTEGER');
    addCol('draft_round', 'INTEGER');
    addCol('draft_pick', 'INTEGER');
  }
  // ---- server/services/nflverse.js (lines 88-89); duplicate of the same guard in server/db/index.js.
  const playerCols = db.prepare(`PRAGMA table_info(players)`).all().map(c => c.name);
  if (!playerCols.includes('gsis_id')) db.exec(`ALTER TABLE players ADD COLUMN gsis_id TEXT`);

  // ---- server/services/prop-feeds.js (lines 41-44); nfl_prop_quote_snapshots is owned by nfl-props.js.
  const propCols = new Set(db.prepare('PRAGMA table_info(nfl_prop_quote_snapshots)').all().map(c => c.name));
  for (const [column, type] of [['provider', 'TEXT'], ['book_updated_at', 'TEXT'], ['is_opener', 'INTEGER']]) {
    if (!propCols.has(column)) db.exec(`ALTER TABLE nfl_prop_quote_snapshots ADD COLUMN ${column} ${type}`);
  }

  // ---- server/services/shadow-ledger.js (lines 18-25)
  const columns = new Set(db.prepare('PRAGMA table_info(shadow_decisions)').all().map(x => x.name));
  for (const [name, type] of [
    ['season', 'INTEGER'], ['week', 'INTEGER'], ['home_team', 'TEXT'], ['away_team', 'TEXT'],
    ['line', 'REAL'], ['american_price', 'INTEGER'], ['quote_at', 'TEXT'],
    ['feature_snapshot_json', 'TEXT'], ['result', 'TEXT'], ['clv_points', 'REAL']
  ]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE shadow_decisions ADD COLUMN ${name} ${type}`);
  }

  // ---- server/services/weekly-learning.js (lines 48-57)
  const snapshotColumns = new Set(db.prepare('PRAGMA table_info(weekly_prediction_snapshots)').all().map(x => x.name));
  if (!snapshotColumns.has('candidate_version')) {
    db.exec('ALTER TABLE weekly_prediction_snapshots ADD COLUMN candidate_version TEXT');
  }
  if (!snapshotColumns.has('candidate_heads_json')) {
    db.exec('ALTER TABLE weekly_prediction_snapshots ADD COLUMN candidate_heads_json TEXT');
  }
  if (!snapshotColumns.has('gridiron_engine_version')) {
    db.exec('ALTER TABLE weekly_prediction_snapshots ADD COLUMN gridiron_engine_version TEXT');
  }

  // ---- server/services/weekly-weight-store.js (lines 29-32); no-op on a fresh DB, the CREATE already carries epoch_id.
  const fitColumns = new Set(db.prepare('PRAGMA table_info(weekly_ensemble_fits)').all().map(item => item.name));
  if (!fitColumns.has('epoch_id')) {
    db.exec('ALTER TABLE weekly_ensemble_fits ADD COLUMN epoch_id INTEGER NOT NULL DEFAULT 1');
  }
}

/** `CREATE INDEX IF NOT EXISTS` and `CREATE TRIGGER IF NOT EXISTS`, verbatim. */
export function indexesAndTriggers(db) {
  // ---- server/services/mlb-pregame.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_mlb_quotes_game ON mlb_market_quotes(game_pk,market,captured_at);
`);

  // ---- server/services/mlb.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_mlb_games_date ON mlb_games(date);
  CREATE INDEX IF NOT EXISTS idx_mlb_games_season ON mlb_games(season);
  CREATE INDEX IF NOT EXISTS idx_probable_date ON mlb_probable_starters(date);
  CREATE INDEX IF NOT EXISTS idx_mlb_pg_season ON mlb_pitcher_games(season);
  CREATE INDEX IF NOT EXISTS idx_mlb_pg_player ON mlb_pitcher_games(player_id);
  CREATE INDEX IF NOT EXISTS idx_mlb_bg_season ON mlb_batter_games(season);
  CREATE INDEX IF NOT EXISTS idx_mlb_bg_player ON mlb_batter_games(player_id);
`);

  // ---- server/services/nfelo.js
  db.exec('CREATE INDEX IF NOT EXISTS idx_nfl_nfelo_qb_week ON nfl_nfelo_qb (season, week, team1, team2)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_nfl_nfelo_games_match ON nfl_nfelo_games (season, week, home, away)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_nfl_nfelo_lines_match ON nfl_nfelo_lines (season, week, home, away)');

  // ---- server/services/nflverse.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_pwu_season_week ON player_week_usage(season, week);
  CREATE INDEX IF NOT EXISTS idx_pwu_player ON player_week_usage(player_id, season);
`);

  // ---- server/services/odds-archive.js
  db.exec(`CREATE INDEX IF NOT EXISTS idx_nfl_odds_archive_game ON nfl_odds_archive(season, week, home)`);

  // ---- server/services/offseason-data.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_off_draft_team ON off_draft_picks(season, team, position);
  CREATE INDEX IF NOT EXISTS idx_off_contracts_gsis ON off_contracts(gsis_id);
  CREATE INDEX IF NOT EXISTS idx_off_rosters_team ON off_rosters(season, team, position);
  CREATE INDEX IF NOT EXISTS idx_off_rosters_pfr ON off_rosters(pfr_id);
  CREATE INDEX IF NOT EXISTS idx_off_depth_player ON off_depth_chart(gsis_id, season);
  CREATE INDEX IF NOT EXISTS idx_off_sched_season ON off_schedule_games(season, week);
  CREATE INDEX IF NOT EXISTS idx_off_sleeper_gsis ON off_sleeper_players(gsis_id);
  CREATE INDEX IF NOT EXISTS idx_off_features_player ON off_player_season_features(player_id, season);
`);

  // ---- server/services/player-repair.js
  db.exec(`CREATE TRIGGER IF NOT EXISTS player_identity_repairs_no_update BEFORE UPDATE ON player_identity_repairs
  BEGIN SELECT RAISE(ABORT, 'player identity repair audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS player_identity_repairs_no_delete BEFORE DELETE ON player_identity_repairs
  BEGIN SELECT RAISE(ABORT, 'player identity repair audit is immutable'); END;`);

  // ---- server/services/polymarket-lines.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_pm_moves_time ON polymarket_line_moves(observed_at);
  CREATE INDEX IF NOT EXISTS idx_pm_moves_game ON polymarket_line_moves(season, week, home_team);
`);

  // ---- server/services/polymarket.js
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pmq_cond ON polymarket_quotes(condition_id, captured_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pmh_ts ON polymarket_price_history(ts)`);

  // ---- server/services/prediction-markets.js
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pm_ticker ON prediction_market_quotes(ticker, captured_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pmflow_ticker ON prediction_market_flow(ticker, traded_at)`);

  // ---- server/services/press-conference.js
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pa_team ON press_availability(team, published_at)`);

  // ---- server/services/trend-watch.js
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS trend_findings_unique
     ON trend_findings (subject_type, subject, metric, season, lookback)`);
  db.exec(`CREATE INDEX IF NOT EXISTS trend_findings_week
     ON trend_findings (season, through_week, status)`);

  // ---- server/services/weekly-learning.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_weekly_snapshots_settlement
    ON weekly_prediction_snapshots(actual, season, week);
`);

  // ---- server/services/weekly-weight-store.js
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_weekly_fits_cutoff
    ON weekly_ensemble_fits(promoted, through_season, through_week);
`);
}

/** Default rows that lived inside DDL blocks (`INSERT OR IGNORE ...`), verbatim. */
export function seeds(db) {
  // None in this batch. model-intelligence.js seeds research_hypotheses at
  // import time through a parameterized run(`INSERT ... ON CONFLICT(id) DO
  // NOTHING`) outside its DDL block; that is left in place (see manifest).
}
