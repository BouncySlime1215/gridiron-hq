-- Gridiron HQ line_history.sqlite schema only; no data or credentials.
-- Source path: /Users/nick_matta/Documents/GitHub/gridiron-hq/data/line-history/line_history.sqlite
-- Source logical bytes: 21084332032
-- Exported: 2026-10-06. Upstream releases and captures are not pinned by this file.

-- table adv_team_week
CREATE TABLE adv_team_week (plays REAL, epa_play REAL, success_rate REAL, early_down_epa REAL, early_down_success REAL, early_down_pass_rate REAL, proe REAL, xpass REAL, cpoe REAL, dropback_epa REAL, rush_epa REAL, adot REAL, sack_rate REAL, qb_hit_rate REAL, scramble_rate REAL, shotgun_rate REAL, no_huddle_rate REAL, explosive_pass_rate REAL, explosive_rush_rate REAL, third_down_success REAL, third_down_dist REAL, redzone_epa REAL, redzone_success REAL, series_success REAL, wpa_play REAL, yac REAL, drives REAL, pressure_rate REAL, box_count REAL, pass_rushers REAL, blitz_rate REAL, time_to_throw REAL, ngs_air_yards REAL, man_rate REAL, zone_rate REAL, cover1_rate REAL, cover2_rate REAL, cover3_rate REAL, pers_11_rate REAL, pers_12_rate REAL, pers_2rb_rate REAL, part_plays REAL, play_action_rate REAL, rpo_rate REAL, screen_rate REAL, motion_rate REAL, ftn_no_huddle_rate REAL, out_of_pocket_rate REAL, throwaway_rate REAL, catchable_rate REAL, contested_rate REAL, int_worthy_rate REAL, ftn_box REAL, trick_rate REAL, ftn_plays REAL, season INTEGER, week INTEGER, team TEXT, side TEXT, PRIMARY KEY (season, week, team, side));

-- table an_games
CREATE TABLE an_games (event_id INTEGER PRIMARY KEY, season INTEGER, week INTEGER, start_time TEXT,
  away TEXT, home TEXT, away_team_id INTEGER, home_team_id INTEGER, last_capture TEXT, raw_json TEXT);

-- table an_line_history
CREATE TABLE an_line_history (event_id INTEGER, book_id INTEGER, book TEXT, market TEXT, side TEXT,
  period TEXT, team_id INTEGER, updated_at TEXT, value REAL, odds INTEGER, line_status TEXT,
  UNIQUE(event_id, book_id, market, side, period, updated_at, value, odds));

-- table an_public_splits
CREATE TABLE an_public_splits (season INTEGER, week INTEGER, event_id INTEGER, start_time TEXT, away TEXT, home TEXT,
  status TEXT, away_score INTEGER, home_score INTEGER, ml_away REAL, ml_home REAL, spread_away REAL, spread_home REAL, spread_away_line REAL, spread_home_line REAL, over REAL, under REAL, total REAL, ml_home_public REAL, ml_away_public REAL, spread_home_public REAL, spread_away_public REAL, total_under_public REAL, total_over_public REAL, ml_home_money REAL, ml_away_money REAL, spread_home_money REAL, spread_away_money REAL, total_over_money REAL, total_under_money REAL, num_bets REAL, book_id REAL, type TEXT, inserted TEXT, line_status TEXT,
  captured_at TEXT, UNIQUE(season, week, event_id, book_id, type, inserted));

-- table covers_games
CREATE TABLE covers_games (
  game_id INTEGER PRIMARY KEY, season INTEGER, game_date TEXT, kickoff_et TEXT,
  away TEXT, home TEXT, away_name TEXT, home_name TEXT,
  fetched_at TEXT, source_bytes INTEGER, rows INTEGER, note TEXT);

-- table covers_line_history
CREATE TABLE covers_line_history (
  game_id INTEGER, book_id INTEGER, book TEXT, market TEXT,
  ts_et TEXT, ts_utc TEXT, is_open INTEGER,
  away_line REAL, away_price INTEGER, home_line REAL, home_price INTEGER,
  total_line REAL, over_price INTEGER, under_price INTEGER,
  UNIQUE(game_id, book_id, market, ts_et, away_line, away_price, home_line, home_price, total_line, over_price, under_price));

-- table covers_week_index
CREATE TABLE covers_week_index (season INTEGER, selected_date TEXT, game_ids TEXT, fetched_at TEXT,
  PRIMARY KEY(season, selected_date));

-- table espn_events
CREATE TABLE espn_events (event_id TEXT PRIMARY KEY, date TEXT, name TEXT, season INTEGER, week INTEGER,
  home TEXT, away TEXT, plays_fetched_at TEXT, plays INTEGER, prob_points INTEGER);

-- table espn_extras_done
CREATE TABLE espn_extras_done (event_id TEXT PRIMARY KEY, fetched_at TEXT);

-- table espn_fpi
CREATE TABLE espn_fpi (
  season INTEGER, team_id TEXT, category TEXT, stat TEXT, value REAL, display_value TEXT,
  PRIMARY KEY (season, team_id, category, stat));

-- table espn_odds
CREATE TABLE espn_odds (event_id TEXT, provider_id TEXT, provider TEXT, spread REAL, over_under REAL, details TEXT,
  home_ml INTEGER, away_ml INTEGER, open_json TEXT, close_json TEXT, current_json TEXT, fetched_at TEXT, PRIMARY KEY(event_id, provider_id));

-- table espn_plays
CREATE TABLE espn_plays (event_id TEXT, play_id TEXT, sequence INTEGER, period INTEGER, clock TEXT, wallclock TEXT,
  type TEXT, text TEXT, home_score INTEGER, away_score INTEGER, scoring INTEGER, start_down INTEGER, start_distance INTEGER,
  start_yardline INTEGER, start_team TEXT, stat_yardage INTEGER, PRIMARY KEY(event_id, play_id));

-- table espn_predictor
CREATE TABLE espn_predictor (event_id TEXT PRIMARY KEY, last_modified TEXT, home_team_id TEXT, away_team_id TEXT,
  home_win_prob REAL, away_win_prob REAL, home_proj_margin REAL, raw_json TEXT);

-- table espn_probabilities
CREATE TABLE espn_probabilities (event_id TEXT, play_id TEXT, sequence INTEGER, home_wp REAL, away_wp REAL, tie REAL,
  seconds_left INTEGER, last_modified TEXT, PRIMARY KEY(event_id, play_id));

-- table espn_stats_done
CREATE TABLE espn_stats_done (key TEXT PRIMARY KEY, fetched_at TEXT, rows INTEGER);

-- table espn_team_stats
CREATE TABLE espn_team_stats (
  season INTEGER, season_type INTEGER, team_id TEXT, category TEXT, stat TEXT,
  value REAL, display_value TEXT, per_game REAL, rank INTEGER,
  PRIMARY KEY (season, season_type, team_id, category, stat));

-- table espn_transactions
CREATE TABLE espn_transactions (date TEXT, team_id TEXT, description TEXT, PRIMARY KEY(date, team_id, description));

-- table jev_presser_done
CREATE TABLE jev_presser_done (
  video_id TEXT PRIMARY KEY, evaluated_at TEXT NOT NULL,
  input_tokens INTEGER, ok INTEGER NOT NULL, error TEXT);

-- table jev_presser_signals
CREATE TABLE jev_presser_signals (
  video_id TEXT NOT NULL, question TEXT NOT NULL, probability REAL,
  team TEXT, published_at TEXT, evaluated_at TEXT NOT NULL,
  PRIMARY KEY (video_id, question));

-- table jev_transaction_done
CREATE TABLE jev_transaction_done (
  txn_key TEXT PRIMARY KEY, evaluated_at TEXT NOT NULL,
  input_tokens INTEGER, ok INTEGER, error TEXT);

-- table jev_transaction_signals
CREATE TABLE jev_transaction_signals (
  txn_key TEXT NOT NULL, question TEXT NOT NULL, probability REAL,
  team_id TEXT, date TEXT, evaluated_at TEXT NOT NULL,
  PRIMARY KEY (txn_key, question));

-- table kalshi_candles
CREATE TABLE kalshi_candles (
  ticker TEXT, period INTEGER, ts INTEGER,
  price_open INTEGER, price_high INTEGER, price_low INTEGER, price_close INTEGER, price_mean INTEGER,
  bid_open INTEGER, bid_high INTEGER, bid_low INTEGER, bid_close INTEGER,
  ask_open INTEGER, ask_high INTEGER, ask_low INTEGER, ask_close INTEGER,
  volume REAL, open_interest REAL,
  PRIMARY KEY (ticker, period, ts));

-- table kalshi_candles_done
CREATE TABLE kalshi_candles_done (ticker TEXT PRIMARY KEY, fetched_at TEXT, rows INTEGER, complete INTEGER);

-- table kalshi_markets
CREATE TABLE kalshi_markets (ticker TEXT PRIMARY KEY, series TEXT, event_ticker TEXT, title TEXT, subtitle TEXT,
  status TEXT, open_time TEXT, close_time TEXT, expiration_time TEXT, result TEXT, volume INTEGER, yes_bid INTEGER, yes_ask INTEGER,
  last_price INTEGER, trades_fetched_at TEXT, trade_rows INTEGER);

-- table kalshi_trades
CREATE TABLE kalshi_trades (trade_id TEXT PRIMARY KEY, ticker TEXT, created_time TEXT, yes_price INTEGER, no_price INTEGER,
  count REAL, taker_side TEXT);

-- table oddsapi_calls
CREATE TABLE oddsapi_calls (requested_date TEXT PRIMARY KEY, snapshot_at TEXT, prev_at TEXT, next_at TEXT,
  markets TEXT, regions TEXT, events INTEGER, rows INTEGER, credits_used INTEGER, remaining INTEGER, fetched_at TEXT);

-- table oddsapi_snapshots
CREATE TABLE oddsapi_snapshots (
  snapshot_at TEXT, event_id TEXT, commence_time TEXT, home TEXT, away TEXT, book TEXT, market TEXT,
  side TEXT, line REAL, price INTEGER, book_updated_at TEXT,
  UNIQUE(snapshot_at, event_id, book, market, side));

-- table pinnacle_matchups
CREATE TABLE pinnacle_matchups (matchup_id INTEGER PRIMARY KEY, start_time TEXT, home TEXT, away TEXT, parent_id INTEGER,
  type TEXT, units TEXT, first_seen TEXT, last_seen TEXT);

-- table pinnacle_quotes
CREATE TABLE pinnacle_quotes (captured_at TEXT, matchup_id INTEGER, market_type TEXT, period INTEGER, key TEXT, is_alternate INTEGER,
  version INTEGER, cutoff_at TEXT, status TEXT, max_risk REAL, home_points REAL, home_price INTEGER, away_points REAL, away_price INTEGER,
  over_points REAL, over_price INTEGER, under_points REAL, under_price INTEGER,
  UNIQUE(matchup_id, key, version));

-- table pm_events
CREATE TABLE pm_events (event_id TEXT PRIMARY KEY, slug TEXT, title TEXT, start_date TEXT, end_date TEXT,
  created_at TEXT, closed INTEGER, volume REAL, liquidity REAL, raw_json TEXT);

-- table pm_markets
CREATE TABLE pm_markets (condition_id TEXT PRIMARY KEY, event_id TEXT, question TEXT, market_type TEXT,
  line REAL, outcome0 TEXT, outcome1 TEXT, token0 TEXT, token1 TEXT, created_at TEXT, end_date TEXT, game_start_time TEXT,
  volume REAL, closed INTEGER, history_fetched_at TEXT, history_points INTEGER, is_core INTEGER);

-- table pm_price_history
CREATE TABLE pm_price_history (condition_id TEXT, t INTEGER, p REAL, PRIMARY KEY(condition_id, t)) WITHOUT ROWID;

-- table pm_trades
CREATE TABLE pm_trades (condition_id TEXT, ts INTEGER, tx_hash TEXT, wallet TEXT, side TEXT, outcome TEXT,
  outcome_index INTEGER, price REAL, size REAL, PRIMARY KEY(condition_id, tx_hash, wallet, outcome_index, ts, price, size)) WITHOUT ROWID;

-- table pm_trades_done
CREATE TABLE pm_trades_done (condition_id TEXT PRIMARY KEY, fetched_at TEXT, rows INTEGER, complete INTEGER);

-- table press_conferences_raw
CREATE TABLE press_conferences_raw (video_id TEXT PRIMARY KEY, team TEXT, title TEXT, published_at TEXT,
        duration_s INTEGER, is_presser INTEGER, speaker_guess TEXT, transcript TEXT, chars INTEGER, fetched_at TEXT);

-- table presser_timestamp_failures
CREATE TABLE presser_timestamp_failures (
                     video_id TEXT PRIMARY KEY, reason TEXT, tried_at TEXT);

-- table stadiums
CREATE TABLE stadiums (stadium_id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL, altitude REAL, roof_type TEXT, surface_type TEXT, tz TEXT, city TEXT, state TEXT);

-- table wayback_pages
CREATE TABLE wayback_pages (
  url TEXT, timestamp TEXT, html_z BLOB,
  PRIMARY KEY (url, timestamp));

-- table wayback_snapshots
CREATE TABLE wayback_snapshots (
  url TEXT, timestamp TEXT, original TEXT, mimetype TEXT, statuscode TEXT, digest TEXT,
  length INTEGER, captured_at TEXT, fetched_at TEXT, body_bytes INTEGER,
  PRIMARY KEY (url, timestamp));

-- table weather_forecast_hourly
CREATE TABLE weather_forecast_hourly (stadium_id TEXT, ts_utc TEXT, lead_days INTEGER, temp_c REAL, wind_kmh REAL, gust_kmh REAL,
  precip_mm REAL, PRIMARY KEY(stadium_id, ts_utc, lead_days)) WITHOUT ROWID;

-- table weather_hourly
CREATE TABLE weather_hourly (stadium_id TEXT, ts_utc TEXT, temp_c REAL, wind_kmh REAL, gust_kmh REAL, wind_dir REAL,
  precip_mm REAL, rain_mm REAL, snow_cm REAL, humidity REAL, pressure_hpa REAL, cloud_pct REAL, PRIMARY KEY(stadium_id, ts_utc)) WITHOUT ROWID;

-- table weather_manifest
CREATE TABLE weather_manifest (stadium_id TEXT, season INTEGER, kind TEXT, rows INTEGER, fetched_at TEXT, PRIMARY KEY(stadium_id, season, kind));

-- table yt_channel_index
CREATE TABLE yt_channel_index (team TEXT, video_id TEXT, title TEXT, upload_date TEXT, duration_s INTEGER, listed_at TEXT, PRIMARY KEY(team, video_id));

-- index an_lh_evt
CREATE INDEX an_lh_evt ON an_line_history(event_id, market, book_id, updated_at);

-- index covers_lh_game
CREATE INDEX covers_lh_game ON covers_line_history(game_id, market, book_id, ts_utc);

-- index jev_presser_at
CREATE INDEX jev_presser_at ON jev_presser_signals(team, published_at);

-- index kalshi_candles_ts
CREATE INDEX kalshi_candles_ts ON kalshi_candles(ts);

-- index kalshi_trades_tk
CREATE INDEX kalshi_trades_tk ON kalshi_trades(ticker, created_time);

-- index oddsapi_evt
CREATE INDEX oddsapi_evt ON oddsapi_snapshots(event_id, market, book, snapshot_at);

-- index pinnacle_q_m
CREATE INDEX pinnacle_q_m ON pinnacle_quotes(matchup_id, market_type, captured_at);

-- index pm_ph_t
CREATE INDEX pm_ph_t ON pm_price_history(t);

-- index pm_trades_ts
CREATE INDEX pm_trades_ts ON pm_trades(condition_id, ts);

-- index wayback_snap_at
CREATE INDEX wayback_snap_at ON wayback_snapshots(captured_at);

