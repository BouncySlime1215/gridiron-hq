# Gridiron HQ data catalog — 2026-09-17

Every non-empty table across all four databases, with the time range that shows
whether a source is complete or truncated. Regenerate with
`python3 scripts/line-history/catalog.py`.

| Database | Tables | Rows | Size | Role |
|---|---:|---:|---:|---|
| `line_history` | 40 | 50,016,945 | 9.74 GB | Market history rebuilt from free sources after the loss |
| `nflverse` | 56 | 4,894,910 | 2.16 GB | Full nflverse mirror: play-by-play, participation, stats, rosters |
| `extract` | 18 | 763,393 | 0.10 GB | Read-only extract taken from the live database hours before it was deleted |
| `repo` | 94 | 1,332,043 | 0.49 GB | Application database in the repo; the surviving restore point |

## line_history
`data/line-history/line_history.sqlite` — Market history rebuilt from free sources after the loss

| Table | Rows | Keyed on | First | Last |
|---|---:|---|---|---|
| pm_price_history | 28,906,853 | t | 2024-07-30 01:55 | 2026-08-29 17:20 |
| kalshi_trades | 4,572,987 | created_time | 2026-07-11T00:35:04 | 2026-09-13T20:27:56 |
| kalshi_candles | 4,003,489 | ts | 2026-05-15 18:00 | 2026-09-17 04:03 |
| weather_forecast_hourly | 3,833,280 | ts_utc | 2022-08-01T00:00 | 2026-09-15T23:00 |
| weather_hourly | 2,773,104 | ts_utc | 2016-08-01T00:00 | 2026-09-15T23:00 |
| covers_line_history | 1,914,688 | ts_utc | 2019-04-18T01:09 | 2026-09-16T03:56 |
| oddsapi_snapshots | 1,910,098 | snapshot_at | 2026-09-01T23:55:39 | 2026-09-17T03:40:36 |
| pm_trades | 1,059,927 | ts | 2024-07-30 03:27 | 2025-12-08 00:57 |
| espn_team_stats | 312,544 | season | 2002 | 2026 |
| espn_plays | 265,399 |  |  |  |
| espn_probabilities | 263,179 |  |  |  |
| an_line_history | 36,078 | updated_at | 2026-05-12T15:48:15 | 2026-09-17T01:19:35 |
| pm_markets | 33,415 | created_at | 2024-07-30T01:45:34 | 2026-09-16T02:13:05 |
| espn_fpi | 25,600 | season | 2002 | 2026 |
| espn_transactions | 24,873 | date | 2016-03-01T08:00Z | 2026-09-16T07:00Z |
| wayback_snapshots | 18,239 | captured_at | 2019-01-01T01:35:17 | 2026-09-17T00:33:46 |
| yt_channel_index | 12,858 |  |  |  |
| adv_team_week | 11,108 | season | 2016 | 2026 |
| an_public_splits | 7,924 | captured_at | 2026-09-17T03:07:22 | 2026-09-17T03:19:58 |
| espn_odds | 5,612 | fetched_at | 2026-09-17T03:32:53 | 2026-09-17T03:39:46 |
| kalshi_candles_done | 3,827 | fetched_at | 2026-09-17T03:57:44 | 2026-09-17T05:00:17 |
| kalshi_markets | 3,827 | close_time | 2026-08-07T01:13:19 | 2026-10-01T00:15:00 |
| covers_games | 2,529 | fetched_at | 2026-09-17T01:25:16 | 2026-09-17T02:22:30 |
| pm_trades_done | 2,520 | fetched_at | 2026-09-17T04:10:58 | 2026-09-17T06:08:50 |
| pinnacle_quotes | 2,010 | captured_at | 2026-09-17T03:18:24 | 2026-09-17T06:04:52 |
| espn_events | 1,801 | date | 2016-08-11T23:00Z | 2027-02-14T23:30Z |
| espn_stats_done | 1,600 | fetched_at | 2026-09-17T04:07:17 | 2026-09-17T04:28:03 |
| oddsapi_calls | 1,456 | snapshot_at | 2026-09-01T23:55:39 | 2026-09-17T03:40:36 |
| press_conferences_raw | 1,420 | published_at | 2021-05-08 | 2026-09-16 |
| weather_manifest | 992 | fetched_at | 2026-09-17T04:11:08 | 2026-09-17T06:05:50 |
| pm_events | 984 | created_at | 2024-07-30T01:45:33 | 2026-09-16T02:13:01 |
| wayback_pages | 661 |  |  |  |
| pinnacle_matchups | 587 | start_time | 2026-09-11T00:20:00 | 2026-09-22T00:15:00 |
| espn_extras_done | 496 | fetched_at | 2026-09-17T03:32:54 | 2026-09-17T03:39:46 |
| espn_predictor | 366 |  |  |  |
| covers_week_index | 240 | fetched_at | 2026-09-17T01:23:49 | 2026-09-17T02:03:44 |
| jev_presser_signals | 240 | published_at | 2026-08-22 | 2026-09-16 |
| stadiums | 62 |  |  |  |
| jev_presser_done | 40 |  |  |  |
| an_games | 32 | start_time | 2026-09-10T00:20:00 | 2026-09-22T00:15:00 |

## nflverse
`data/line-history/nflverse.sqlite` — Full nflverse mirror: play-by-play, participation, stats, rosters

| Table | Rows | Keyed on | First | Last |
|---|---:|---|---|---|
| depth_charts | 1,409,371 | season | 2016 | 2024 |
| play_by_play | 487,010 | game_date | 2016-09-08 | 2026-09-14 |
| pbp_participation | 478,989 |  |  |  |
| roster_weekly | 471,747 | season | 2016 | 2026 |
| player_stats_def | 326,386 | season | 1999 | 2024 |
| snap_counts | 254,598 | season | 2016 | 2026 |
| ftn_charting | 187,890 | season | 2022 | 2026 |
| player_stats | 183,631 | season | 1999 | 2024 |
| stats_player_week | 183,373 | season | 2016 | 2026 |
| pbp_patch_ids | 138,864 |  |  |  |
| player_stats_def_season | 111,677 | season | 1999 | 2024 |
| advstats_week_def | 62,764 | season | 2018 | 2026 |
| injuries | 55,749 | season | 2016 | 2026 |
| pfr_rosters | 49,518 | season | 2002 | 2022 |
| pbp_participation_old | 47,160 |  |  |  |
| player_stats_season | 45,934 | season | 1999 | 2024 |
| advstats_week_rec | 35,961 | season | 2018 | 2026 |
| roster | 33,973 | season | 2016 | 2026 |
| historical_contracts | 31,893 |  |  |  |
| ngs_receiving | 26,778 | season | 2016 | 2026 |
| players | 24,824 |  |  |  |
| officials | 22,012 | season | 2015 | 2026 |
| stats_player_regpost | 20,700 | season | 2016 | 2026 |
| stats_player_reg | 20,649 | season | 2016 | 2026 |
| advstats_week_rush | 18,578 | season | 2018 | 2026 |
| player_stats_kicking | 18,203 | season | 1999 | 2024 |
| draft_picks | 12,927 | season | 1980 | 2026 |
| ngs_rushing | 10,941 | season | 2016 | 2026 |
| qbr_week_level | 10,741 | season | 2006 | 2026 |
| ngs_passing | 10,715 | season | 2016 | 2026 |
| closing_lines_1979_2018 | 9,528 | date | Aug 31, 1997 | Sep 9, 2018 |
| espn_draft_player_probs | 9,435 |  |  |  |
| combine | 8,968 | season | 2000 | 2026 |
| games | 7,548 | gameday | 1999-09-12 | 2027-01-10 |
| nfldata_games | 7,548 | gameday | 1999-09-12 | 2027-01-10 |
| advstats_season_def | 7,537 | season | 2018 | 2025 |
| espn_draft_position_probs | 7,126 |  |  |  |
| stats_team_week | 5,554 | season | 2016 | 2026 |
| advstats_week_pass | 5,459 | season | 2018 | 2026 |
| trades | 4,975 | season | 2002 | 2026 |
| stats_player_post | 4,779 | season | 2016 | 2025 |
| advstats_season_rec | 4,130 | season | 2018 | 2025 |
| nfldata_sc_lines | 4,092 | season | 2013 | 2020 |
| player_stats_kicking_season | 3,487 | season | 1999 | 2024 |
| advstats_season_rush | 2,820 | season | 2018 | 2025 |
| scraped_games_snapcounts | 2,689 | season | 2012 | 2021 |
| qbr_season_level | 1,560 | season | 2006 | 2026 |
| nfldata_initial_lines | 1,088 | season | 2021 | 2021 |
| advstats_season_pass | 848 | season | 2018 | 2025 |
| nfldata_standings | 800 | season | 2002 | 2026 |
| stats_team_reg | 352 | season | 2016 | 2026 |
| stats_team_regpost | 352 | season | 2016 | 2026 |
| nflverse_manifest | 319 | season | 2016 | 2026 |
| multiple_lateral_yards | 192 |  |  |  |
| stats_team_post | 132 | season | 2016 | 2025 |
| teams_colors_logos | 36 |  |  |  |

## extract
`data/line-history/extract-2026-09-16.sqlite` — Read-only extract taken from the live database hours before it was deleted

| Table | Rows | Keyed on | First | Last |
|---|---:|---|---|---|
| nfl_blind_input_mutations | 375,794 |  |  |  |
| nfl_depth | 179,325 | season | 2021 | 2026 |
| nfl_snaps | 127,958 | season | 2021 | 2026 |
| nfl_injuries | 28,574 | season | 2021 | 2026 |
| nfl_pfr_adv | 25,147 | season | 2024 | 2026 |
| game_lines | 9,270 | fetched_at | 2026-07-31 01:34:10 | 2026-09-15 22:13:34 |
| nfl_qbr_weekly | 5,844 | fetched_at | 2026-09-02 16:15:37 | 2026-09-15 16:30:20 |
| nfl_team_week_features | 5,395 | season | 2016 | 2026 |
| nfl_external_ratings | 2,432 | fetched_at | 2026-09-02T22:29:08 | 2026-09-15T16:30:18 |
| nfl_nfelo_games | 1,725 | fetched_at | 2026-09-16T00:07:45 | 2026-09-16T00:07:45 |
| nfl_nfelo_qb | 1,725 | fetched_at | 2026-09-16T00:07:45 | 2026-09-16T00:07:45 |
| nfl_ensemble_fit_artifacts | 105 | created_at | 2026-09-16 01:37:08 | 2026-09-16 17:33:20 |
| schema_migrations | 53 |  |  |  |
| model_feature_contracts | 32 |  |  |  |
| model_registry | 11 | updated_at | 2026-09-16 00:18:58 | 2026-09-16 00:18:58 |
| db_health_checks | 1 |  |  |  |
| nfl_ensemble_rank_reports | 1 | created_at | 2026-09-16 00:21:11 | 2026-09-16 00:21:11 |
| nfl_learning_epochs | 1 | created_at | 2026-09-16T00:18:58 | 2026-09-16T00:18:58 |

## repo
`server/data.sqlite` — Application database in the repo; the surviving restore point

| Table | Rows | Keyed on | First | Last |
|---|---:|---|---|---|
| nfl_blind_input_mutations | 520,626 |  |  |  |
| nfl_depth | 171,240 | season | 2021 | 2025 |
| nfl_snaps | 126,561 | season | 2021 | 2025 |
| nfl_odds_archive | 102,288 | commence_time | 2019-08-01T8:00 PM | 2027-01-04T8:15 PM |
| polymarket_quotes | 69,655 | captured_at | 2026-09-03T18:16:06 | 2026-09-03T23:59:24 |
| nfl_player_week_features | 52,544 | season | 2016 | 2026 |
| mlb_batter_games | 41,689 | date | 2026-03-25 | 2026-09-02 |
| player_week_usage | 41,572 | season | 2021 | 2025 |
| nfl_injuries | 27,983 | season | 2021 | 2025 |
| nflverse_player_positions | 25,065 |  |  |  |
| nfl_pfr_adv | 25,058 | season | 2024 | 2025 |
| mlb_pitcher_games | 16,608 | date | 2026-03-25 | 2026-09-02 |
| game_lines | 15,096 | fetched_at | 2026-07-31 01:34:10 | 2026-09-03 23:03:56 |
| nfl_ngs | 11,860 | season | 2021 | 2025 |
| nfl_line_snapshots | 10,377 | captured_at | 2026-08-05T00:09:04 | 2026-09-17T05:34:16 |
| nfl_roster_snapshots | 9,726 | captured_at | 2026-09-03 18:24:32 | 2026-09-04 05:16:08 |
| players | 8,640 |  |  |  |
| polymarket_markets | 6,475 |  |  |  |
| nfl_team_week_features | 5,310 | season | 2016 | 2026 |
| nfl_quote_tape | 4,080 | snapshot_at | 2026-09-03T21:01:35 | 2026-09-03T23:04:24 |
| prediction_market_flow | 3,200 | fetched_at | 2026-09-03T18:15:58 | 2026-09-03T23:53:24 |
| nfl_historical_adp | 2,914 | fetched_at | 2026-09-04T00:02:45 | 2026-09-04T00:02:45 |
| nfl_prop_clv | 2,539 | captured_at | 2026-09-03T21:01:37 | 2026-09-03T23:03:56 |
| nfl_prop_quote_snapshots | 2,539 | captured_at | 2026-09-03T21:01:37 | 2026-09-03T23:03:56 |
| nfl_feature_dictionary | 2,511 | created_at | 2026-09-17T04:36:55 | 2026-09-17T04:36:55 |
| nfl_external_ratings | 2,432 | fetched_at | 2026-09-02T22:29:08 | 2026-09-15T16:30:18 |
| mlb_games | 2,430 | date | 2026-03-25 | 2026-09-27 |
| roster_players | 2,421 | fetched_at | 2026-09-04 05:16:07 | 2026-09-04 05:16:08 |
| nfl_team_feature_vectors | 2,078 | created_at | 2026-09-17T04:36:55 | 2026-09-17T04:38:05 |
| nfl_nfelo_games | 1,709 | fetched_at | 2026-09-03T21:06:12 | 2026-09-03T21:06:12 |
| nfl_nfelo_lines | 1,709 | fetched_at | 2026-09-03T21:06:12 | 2026-09-03T21:06:12 |
| nfl_nfelo_qb | 1,709 | fetched_at | 2026-09-03T21:06:12 | 2026-09-03T21:06:12 |
| nfl_game_weather_forecast_history | 1,488 | fetched_at | 2026-09-17T04:39:12 | 2026-09-17T04:39:12 |
| player_season_stats | 1,291 | fetched_at | 2026-09-03 18:51:17 | 2026-09-03 18:51:17 |
| prediction_market_quotes | 1,024 | captured_at | 2026-09-03T18:15:57 | 2026-09-03T23:53:24 |
| nfl_team_coaches | 893 | fetched_at | 2026-09-17T04:23:21 | 2026-09-17T04:23:21 |
| mlb_pregame_snapshots | 777 | captured_at | 2026-09-03T18:13:16 | 2026-09-04T00:02:24 |
| evidence_capture_windows | 726 | captured_at | 2026-09-03T21:05:43 | 2026-09-04T00:02:24 |
| nfl_signal_snapshots | 720 | captured_at | 2026-09-03T21:01:57 | 2026-09-17T05:36:49 |
| schedule_games | 544 | date | 2026-09-10 | 2027-01-10 |
| nfl_qbr_weekly | 540 | fetched_at | 2026-09-03 21:06:16 | 2026-09-03 21:06:16 |
| news_items | 438 | created_at | 2026-09-03 18:12:23 | 2026-09-03 23:30:54 |
| dynasty_values | 396 | fetched_at | 2026-09-03 18:38:23 | 2026-09-03 18:38:24 |
| draft_picks | 352 | created_at | 2026-09-03 19:14:59 | 2026-09-03 19:15:36 |
| mlb_probable_starters | 201 | fetched_at | 2026-08-23T21:35:43 | 2026-09-04T00:02:24 |
| model_evidence_manifests | 199 | captured_at | 2026-09-03 18:13:17 | 2026-09-04 00:02:24 |
| nfl_game_weather | 193 | fetched_at | 2026-09-03 21:06:17 | 2026-09-03 21:07:29 |
| draft_events | 192 | created_at | 2026-09-03 19:14:59 | 2026-09-03 19:15:01 |
| nfl_ensemble_fit_artifacts | 182 | created_at | 2026-09-03 18:51:56 | 2026-09-03 21:05:02 |
| nfl_player_state_quarantine | 113 | captured_at | 2026-09-03 18:16:25 | 2026-09-03 21:55:23 |
| ranking_entries | 105 |  |  |  |
| nfl_top100 | 100 | fetched_at | 2026-09-03 18:51:18 | 2026-09-03 18:51:18 |
| shadow_decisions | 94 | captured_at | 2026-09-03T21:01:58 | 2026-09-17T05:36:50 |
| odds_cache | 91 | fetched_at | 2026-08-03T17:18:57 | 2026-08-30T15:38:38 |
| polymarket_line_moves | 90 | captured_at | 2026-09-03T18:16:06 | 2026-09-03T23:59:24 |
| nfl_stadiums | 67 | fetched_at | 2026-09-03T21:06:12 | 2026-09-03T21:06:12 |
| nfl_team_stadiums | 59 | fetched_at | 2026-09-03T21:06:12 | 2026-09-03T21:06:12 |
| evidence_daemon_runs | 57 |  |  |  |
| sync_log | 44 |  |  |  |
| auth_sessions | 34 | created_at | 2026-09-03 18:12:46 | 2026-09-04 00:00:36 |
| nfl_pregame_snapshot_history | 32 | captured_at | 2026-09-03T21:07:29 | 2026-09-03T21:07:29 |
| nfl_teams | 32 |  |  |  |
| team_cap | 32 | fetched_at | 2026-09-03 18:51:13 | 2026-09-03 18:51:13 |
| nfl_capture_triggers | 31 | snapshot_at |  |  |
| player_team_changes | 29 |  |  |  |
| audit_log | 27 | created_at | 2026-09-03 19:06:43 | 2026-09-03 19:19:29 |
| nfl_news_signals | 26 | created_at | 2026-09-03 18:27:41 | 2026-09-03 21:47:42 |
| model_feature_contracts | 23 |  |  |  |
| nfl_player_roster_events | 21 | captured_at | 2026-09-03 18:16:25 | 2026-09-03 19:51:01 |
| espn_line_moves | 17 | commence_time | 2026-09-10T00:20Z | 2026-09-15T00:15Z |
| schema_migrations | 17 |  |  |  |
| nfl_pick_decisions | 16 | season | 2026 | 2026 |
| mlb_boxscore_sync | 15 | fetched_at | 2026-09-03T23:54:54 | 2026-09-03T23:54:54 |
| model_registry | 9 | updated_at | 2026-09-03 18:12:02 | 2026-09-03 18:12:02 |
| nfl_cached_reports | 7 |  |  |  |
| nfl_source_registry | 7 | updated_at | 2026-09-03 21:04:00 | 2026-09-03 21:04:00 |
| drafts | 6 | created_at | 2026-09-03 19:03:53 | 2026-09-03 19:15:36 |
| draft_team_ownership | 5 | created_at | 2026-09-03 19:06:43 | 2026-09-03 19:15:36 |
| league_memberships | 5 | created_at | 2026-09-03 18:16:46 | 2026-09-03 18:34:28 |
| leagues | 5 | fetched_at | 2026-09-03 18:13:18 | 2026-09-03 18:38:22 |
| mlb_first_party_picks | 5 |  |  |  |
| research_hypotheses | 4 | created_at | 2026-09-03 18:12:02 | 2026-09-03 18:12:02 |
| app_settings | 3 |  |  |  |
| nfl_quote_batches | 3 | snapshot_at | 2026-09-03T21:01:35 | 2026-09-03T23:04:24 |
| fantasy_coordinator_fits | 2 | created_at | 2026-09-04 00:00:08 | 2026-09-04 01:26:49 |
| nfl_validation_windows | 2 | created_at | 2026-09-03 18:12:02 | 2026-09-03 18:12:02 |
| db_health_checks | 1 |  |  |  |
| model_permissions | 1 | created_at | 2026-09-03 18:12:46 | 2026-09-03 18:12:46 |
| nfl_learning_epochs | 1 | created_at | 2026-09-03T18:12:02 | 2026-09-03T18:12:02 |
| nfl_model_growth_runs | 1 | season | 2026 | 2026 |
| nfl_prop_policy_archive | 1 |  |  |  |
| nfl_residual_audits | 1 | created_at | 2026-09-03 21:04:34 | 2026-09-03 21:04:34 |
| ranking_sets | 1 | created_at | 2026-08-23 19:44:16 | 2026-08-23 19:44:16 |
| users | 1 | created_at | 2026-09-03 18:12:46 | 2026-09-03 18:12:46 |

