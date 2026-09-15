# Gridiron HQ (`server/data.sqlite`): pre-kickoff data you can use as features

I opened the 15 GB database read-only and edited nothing. It has 262 tables. The NFL tables that could feed a margin, total or residual model are below. Timestamps are UTC.

## 1. Training sample: completed games with a score and a closing spread

Source is `game_lines`. It has two rows per game, one from each team's side, and a negative spread means that team is favored.

For every season from 1999 to 2025, the closing spread is in the `spread` column. The nflverse rows match `off_schedule_games.spread_line` exactly (average gap 0.000 for 2019–25). The `closing_spread` and `closing_total` columns are only filled for 2026, so `coalesce(closing_spread, spread)` covers every season.

| Season | Games (reg+post) | Scored with closing spread | With opening spread | Market RMSE on margin |
|---|---|---|---|---|
| 1999–2001 | 259 each | 259 each | 0 | 13.1–13.5 |
| 2002–2012 | 267 each | 267 each | 0 | 12.9–14.3 |
| 2013–2019 | 267 each | 267 each | 256 each | 11.8–14.4 |
| 2020 | 269 | 269 | 251 | 12.70 |
| 2021 | 285 | 285 | 272 | 13.55 |
| 2022 | 284 | 284 | 267 | 11.49 |
| 2023 | 285 | 285 | 285 | 13.17 |
| 2024 | 285 | 285 | 285 | 12.72 |
| 2025 | 285 | 285 | 285 | 12.24 |
| 2026 | 272 scheduled | 14 so far (Week 1) | 14 | — |

- **Totals:** 7,445 scored games with a closing spread and total across 1999–2025. 1,968 of them are from 2019–2025, and 1,424 from 2021–2025.
- **The real limit is where the features live:**
  - Box-score features in `nfl_team_week_features`: 2016–2025, about 2,700 games.
  - Play-by-play, snaps and Next Gen Stats: 2021–2025, about 1,420 games.
  - The finished feature vectors and team cards: 2022–2025, Weeks 5–18 only, about 830 games.
  - Timestamped multi-book quotes: 2020–2025, about 1,340 games, mostly Weeks 5–18.
- **Other closing-line sources agree:**
  - Pinnacle close in `nfl_odds_archive` (2022–25) is within 0.23–0.32 points on average.
  - `nfl_nfelo_games.home_line_close` (2020–25) is within 0.14–0.32.
- **Opening spreads before 2022 are suspect.** For 2013–2021 the source is unlabeled, and it disagrees with nfelo's open by 2.91 points on average in 2021 (1.1–1.3 in 2020 and 2022). The 2022–2025 opens are labeled `pinnacle_archive_reopen_2022_2025`, except 34 rows labeled `unresolved_legacy_median`.

## 2. Table inventory

"Safe" means you can rebuild exactly what was known before kickoff.

### Markets and lines

**`game_lines`** (15,096 rows, 1999–2026, one row per team per game)
- Useful columns: spread, total, implied_points, moneyline, spread/total odds, open_spread/open_total (2013+), temp and wind (outdoor games only), roof, surface, rest_days, div_game, neutral_site, gameday/gametime.
- Safety:
  - Spread and total are the close, so they are safe only as a kickoff-time input or as the baseline the residual is measured against.
  - `fetched_at` is 2026 for every row, so there's no timeline within a week.
  - temp and wind are what the weather actually was, not a forecast.

**`nfl_odds_archive`** (135,930 rows, 2022–2026, one row per book/market/side/phase)
- Coverage: 11 books including Pinnacle, open and close phases, spreads, moneylines and totals, with `book_updated_at`. About 285 games per season, playoffs included.
- Safety: safe with a filter. 9,785 of 66,902 close rows (14.6%) have `book_updated_at` after kickoff, so require `book_updated_at < commence_time`. Opens are about 333 hours before kickoff on average.

**`nfl_quote_tape` + `nfl_quote_batches`** (2,042,179 rows)
- Historical: The Odds API, 2020–2025, 168 snapshots, 14–21 books, about 1,340 games, mostly October–early January (roughly Weeks 5–18).
- Live: 2026 feed at a high rate (1,546 batches since September 2).
- How far before kickoff the snapshots fall: 641 games have one 7+ days out, 1,230 at 3–7 days, 811 at 1–3 days, 95 at 3–24 hours, 186 at 0–3 hours.
- Safety: true timestamps (`snapshot_at`, and `received_at` on batches). Drop the 9 snapshots taken after kickoff.

**`nfl_line_snapshots`** (2,260,693 rows)
- Historical rows are a copy of the oddstrader archive (open and close only, 2022–25).
- Live rows are 2026 feeds from oddstrader, Pinnacle, Rotowire, Kambi, SBR, Bovada and FanDuel, with `captured_at`.
- Safety: safe via `captured_at`.

**Short-lived line feeds (2026 only, safe)**
- `espn_line_moves`: 90 rows, Week 1.
- `polymarket_line_moves`: 6,065 rows, Weeks 1–4.
- `prediction_market_quotes`: 128,277 rows, Kalshi, August–September.
- `polymarket_quotes`: 18.7 million rows.
- `nfl_signal_snapshots`: 40,196 rows from September 2 onward, covering injury_burden_delta, nfelo_pre_vs_open, pinnacle_move_so_far, qb_out_delta, ratings_vs_open, teamrankings_vs_open, trades_since_open and wind_total.

**`nfl_nfelo_lines`** (1,709 rows, 2020–2026, one row per game)
- Columns: home_spread open/last, moneyline open/last, total open/last, spread tickets % and money %.
- Coverage: tickets % in 2020 and 2024–26; money % and moneylines in 2024–26 only.
- Safety: the percentages carry a timestamp at kickoff, so they're safe only as a close-time feature.

**`nfl_scottfree_game_features`** (285 rows, 2025–26 only): one sample season with lines, opens and a JSON features blob. It has limited value.

### Ratings and power numbers

**`nfl_nfelo_games` + `nfl_nfelo_qb`** (1,709 rows each, 2020–2026, one row per game)
- Columns: starting_nfelo home/away, hfa_mod, 538 QB adjustments, nfelo_dif_base, elo/qbelo pre-game, qb value pre-game, market_regression_factor, nfelo line open/close.
- Safety:
  - The pre-game ratings are safe by construction.
  - `nfelo_home_line_close` is pulled toward the closing market, so it is not independent of the close.
  - Every row was fetched today, so you're trusting the provider not to have revised history.

**`nfl_external_ratings`** (2,368 rows)
- TeamRankings predictive ratings: Weeks 1–18 of 2022–2025, captured each Wednesday (`as_of`), plus 2026 Week 1.
- ESPN FPI: 2026 Week 1 only.
- Safety: safe via `as_of` = Wednesday. The Hi/Lo columns inside the stored JSON may cover the whole season, so don't use them.

### Play-by-play and charting (all post-game data, so lag by at least one week)

**`nfl_play_by_play`** (254,191 rows, 2021–2025 Weeks 1–18 plus 2026 Week 1, one row per play)
- Columns: down, distance, yards_to_endzone, play_type, yards_gained, turnover/scoring/penalty flags, score, shotgun, no_huddle, pass_depth/direction.
- There's no EPA stored here.

**`nfl_play_charting`** (185,215 rows, 2022–2025 incl. playoffs, one row per play)
- Columns: qb_location, backfield, defense_box, motion, play_action, screen, rpo, out_of_pocket, contested.

**`nfl_play_formations`** (96,318 rows, 2022–2023 only, one row per play)
- Columns: offensive formation, offensive and defensive personnel, defenders in box, pass rushers.

**`nfl_team_week_features`** (5,363 rows, 2016–2025 Weeks 1–17/18, one row per team per week)
- This is the richest raw team table: 183 per-game stats as JSON.
  - EPA: overall/pass/rush EPA and success rate, early-down EPA, neutral-win-probability EPA, EPA volatility, EPA by field zone.
  - Pass game: CPOE, PROE, xpass, pressure vs. clean-pocket EPA, YAC over expected, explosive rate.
  - Drives and situations: drive TD/FG/punt/turnover rates, three-and-out rate, average drive start, red zone, third down, havoc, sack/turnover rates.
  - Everything is split into offense and defense, plus seven net_* stats.
- Safety: these are the game's own results, so they are safe only when rolled up from weeks before the game.

**`nfl_player_week_features`** (52,231 rows, 2016–2025, one row per player per week)
- 67 stats: pass EPA, CPOE, aDOT, target/air-yard share, WOPR, carry share, red-zone/goal-line usage, YAC over expected. Lag required.

**`player_week_usage`** (43,243 rows, 2021–2025, one row per player per week)
- Columns: attempts, carries, targets, target_share, air_yards_share, wopr, passing/rushing/receiving EPA, cpoe, racr, pacr. Lag required.

**`nfl_ngs`** (11,860 rows, 2021–2025 Weeks 1–18, one row per player per week)
- Passing: time to throw, aggressiveness, CPOE, air yards.
- Rushing: rush yards over expected, efficiency.
- Receiving: separation, cushion, YAC above expectation.
- Lag required.

**`nfl_pfr_adv`** (25,058 rows, 2024–2025 only, one row per player per week)
- Passing: pressured/blitzed/hurried/hit counts, drops, bad throws.
- Receiving and defensive advanced stats.
- Lag required.

**`nfl_qbr_weekly`** (5,844 rows, 2016–2026, one row per QB per week)
- Columns: qbr_total, pts_added, epa_total, qb_plays.
- Lag required.
- **Data bug:** 520 of the 550 rows labeled 2026 are exact copies of 2025 (for example, Week 5 Cooper Rush BAL vs HOU). Only real Week 1 2026 rows are valid. Drop `season=2026 AND week>1` or the model will leak.

**`nfl_ffopportunity_weekly`** (22,571 rows, 2022–2025 Weeks 1–22, one row per player per week)
- Expected vs. actual fantasy points, expected touchdowns and yards.
- Lag required. It's a "latest-data" release, so values may have been revised after the fact.

**`off_team_season_stats`** (2020–2025) **/ `off_ngs_season` / `off_pfr_adv_season` / `off_qbr_season`**
- One row per season.
- Safe only as the prior season's value.

### Personnel, availability and depth

**`nfl_snaps`** (126,561 rows, 2021–2025 Weeks 1–18, one row per player per week)
- Offense, defense and special-teams snap counts and percentages. Lag required.

**`player_week_snaps`** (42,970 rows, 2021–2025): offensive snaps only. Lag required.

**`nfl_depth`** (177,059 rows, 2021–2026, one row per player per snapshot)
- Columns: pos_rank, pos_slot, `captured`.
- 2021–24 has about 62 snapshots a season on synthetic date boundaries; 2025–26 has real timestamps (193 and 118 snapshots).
- Safety: safe via `captured`. The pre-2025 timestamps are approximate.

**`nfl_injuries`** (28,574 rows, 2021–2026, one row per player per week)
- Columns: report_status (Out 5,434, Doubtful 758, Questionable 7,254), practice_status, injury, modified_at.
- Safety:
  - Safe via `modified_at` for 2021–2024; only 12 of 6,213 rows in 2024 were modified after game day.
  - 2025 and 2026 have no `modified_at`, so you have to assume the Friday report timing.

**`nfl_verified_events`** (119,639 rows, 2020–2026, one row per event)
- Types: official_injury_report (2021–24 only, none for 2025), weekly roster status and team changes, trades.
- Columns: `available_at`, `time_precision`, status_before/after.
- Safety: safe via `available_at` (trades use a conservative end-of-day time).

**`nfl_roster_snapshots`** (37,885 rows): 2026 only (July and September), with `captured_at`.

**`nfl_pregame_snapshot_history`** (3,818 rows): 2026 Weeks 1–2 only, bitemporal. Columns: quarterback, roster, injuries, coaching, feature coverage JSON.

**`off_rosters` / `off_depth_chart`** (2020/2021–2026, one row per player per season): mostly preseason or source-week data, so only safe with care.

**`off_player_season_features`** (6,062 rows, 2021–2026)
- Carryover from the prior season: prior_*, team_change, vacated target/carry share, draft capital added.
- Safe as a preseason prior.

**`nflverse_player_positions` / `off_draft_picks` / `nfl_rookie_evidence`** (combine and draft data, 2000+): static and safe.

**Not safe for history:**
- `off_contracts` and `team_cap` are current snapshots (cap fetched 2026-09-08).
- `nfl_teams` scheme text was updated in September 2026.

**Live only (2026, timestamped and safe, but no history):** `nfl_news_signals` (550 rows), `nfl_news_events` (30), `news_items` (3,682), `press_conferences` (1,858), `nfl_tweet_line_watch` (22,276, almost all August–September 2026).

### Context

**`nfl_game_weather_forecast_history`** (3,770 rows, 2022–2026)
- Open-Meteo archived forecast runs at 0–5 days out, about 190 outdoor games a season.
- Columns: wind, gust, precipitation, temperature.
- Safe: this is what the forecast said before the game.

**`nfl_game_weather`** (784 rows, 2022–2026)
- Open-Meteo archive, meaning the weather that actually happened.
- Only 2026 has forecast-sourced rows (30). Close to safe near kickoff, but it's hindsight.

**`nfl_officials`** (22,012 rows, 2015–2026, one row per official per game): crew assignments. Announced before the game but there's no timestamp; referee tendencies must be built from earlier games only.

**`nfl_team_coaches`** (384 rows, 2015–2026, one row per team per season)
- Coach and games. Mid-season firings aren't dated, and the games count covers the whole season.

**`nfl_stadiums` / `nfl_team_stadiums`**: altitude, roof, surface, latitude/longitude, time zone. Static and safe; useful for travel distance and time-zone shifts.

**`off_schedule_games`** (2019–2026, one row per game)
- Columns: rest, starting QB ids, coaches, roof, div_game, location.
- The starting QB is known only after the game, but it's a strong feature if you project it pre-game.

**`off_team_season`** (2021–2026, one row per team per season)
- Prior-season values: head-coach change and tenure, QB change and prior QBR, pass-rate prior, implied points prior. Safe preseason.

### Features the app already built

**`nfl_team_feature_vectors`** (1,662 rows, 2022–2025 Weeks 5–18, one row per team per week)
- 2,511–2,679 features built from about 208 raw stats. Each stat has latest, mean over 3/6/12 games, 6-game EWMA, slope, SD, min/max, 1-week delta, coverage and z-score.
- Sources: team-week EPA stats, charting, formations, injury counts, snap concentration.
- Safety: has cutoff and evidence_hash and was rebuilt in September 2026 under "strictly before week" rules. Likely safe, but it's derived.
- Oddity: 2024 W10 ARI shows `charting__coverage_12=0.25`, meaning only 3 charted games. Charting may lag or be missing.

**`nfl_player_feature_vectors`** (16,173 rows, 2022–2025 Weeks 5–18, one row per player per week)
- About 790 features: base stats, NGS passing, injury severity. Same cutoff metadata as the team vectors.

**`nfl_team_cards`** (4,298 rows, one row per team per week, pregame)
- Versions:
  - v1: 2022–25 Weeks 1–18.
  - v2 reconciled-depth: 2021–25 Weeks 5–18, plus 2026 Weeks 1–2.
- Contents: schedule, market, roster scores (roster, starter, depth, fragility, per-unit), tendencies to date, injury list, verified-event state (injury burden, trade arrivals, roster changes), coaching, cutoff contract flags.
- Safety: safe by contract. The embedded market is the close, and coaching.games is a full-season count.

**Model output tables:** `nfl_weekly_expert_examples` (142,183 rows, 2021–25 Weeks 5–18, 20 experts), `nfl_historical_signal_replay` (8 signals, 2022–25), `nfl_risk_lab_predictions`, `nfl_online_neural_examples`.
- These hold the old model's predictions and residuals. They're the thing you're rebuilding, so use them as baselines, not raw features.

**Post-game results:** `nfl_game_variance` (2021–25, luck-adjusted residual) and `nfl_postgame_truth_packets`.
- They're post-game truth, so they're safe only when lagged (e.g., a team's luck-adjusted margins from earlier weeks).

## 3. The 25 most promising feature groups

1. **Closing spread and total, as the baseline and offset for the residual target.** `game_lines` (coalesce closing_spread/spread), one row per game, 1999–2026. Safe at kickoff; it's the target's reference, not an edge signal.
2. **Rolling team EPA and success rate (offense, defense, net, pass/rush split, opponent-adjusted).** `nfl_team_week_features`, team-week, 2016–2025. Safe if you aggregate only earlier weeks.
3. **Line movement from open to T-x, and across books, in points and prices.** `nfl_quote_tape` (2020–25) and `nfl_odds_archive` (2022–25). Safe via `snapshot_at` / `book_updated_at`, after filtering out post-kickoff rows.
4. **Pinnacle vs. other books (sharp/soft gap, consensus vs. the Pinnacle open).** `nfl_odds_archive`, `nfl_quote_tape`, one row per game per book, 2020–25. Safe with timestamps.
5. **nfelo / QB-Elo pre-game ratings and QB adjustments.** `nfl_nfelo_games`, `nfl_nfelo_qb`, one row per game, 2020–26. Safe for pre-game ratings; exclude `nfelo_home_line_close`, which is pulled toward the close.
6. **Starting QB identity and change, and QB quality (rolling QBR, pass EPA, CPOE).** `off_schedule_games` QB ids, `nfl_qbr_weekly`, `nfl_player_week_features`; one row per game or player-week; 2016/2019–2025. Stats are safe when lagged. The QB id must be projected from depth charts and injuries, and the 2026 QBR copies must be dropped.
7. **Injury burden weighted by position and snap share (Out/Doubtful/Questionable × prior snap %).** `nfl_injuries` + `nfl_snaps`, player-week, 2021–2025. Safe via `modified_at` for 2021–24; 2025–26 relies on assumed report timing.
8. **Drive-level efficiency (points and TDs per drive, three-and-out rate, average drive start, seconds per drive).** `nfl_team_week_features`, team-week, 2016–25. Safe when lagged. Seconds per drive also matters for totals.
9. **Pace and pass tendency (PROE, neutral pass rate, plays per drive, no-huddle) for totals.** `nfl_team_week_features`, `nfl_play_by_play`; team-week or play; 2016/2021–25. Safe when lagged.
10. **Pressure and trench matchups (sack rate, QB-hit rate, pressure vs. clean-pocket EPA, times pressured).** `nfl_team_week_features`, `nfl_pfr_adv` (2024–25 only), `nfl_ngs` time to throw; team-week or player-week. Safe when lagged.
11. **The pre-built feature vector (rolling stats at 3/6/12 games, EWMA, slope, volatility, z-scores).** `nfl_team_feature_vectors`, team-week, 2022–25 Weeks 5–18. Safe by its cutoff contract, but the sample is small (about 830 games).
12. **Roster, starter and depth strength and fragility.** `nfl_team_cards` roster block, team-week, 2021–25. Safe by contract.
13. **Weather forecast (wind, gust, precipitation, temperature at 0–5 days) for totals.** `nfl_game_weather_forecast_history`, one row per game per forecast lead time, 2022–26. Safe (archived forecasts).
14. **Rest and schedule spots (rest days, short week, bye, travel distance, time-zone shift, primetime, division, neutral site).** `game_lines`, `off_schedule_games`, `nfl_stadiums`; one row per game; 1999–2026. Safe (the schedule is known in advance).
15. **Turnover luck and variance (lagged fumble/INT rates vs. expected, luck-adjusted margin).** `nfl_team_week_features`, `nfl_game_variance`; team-week or game; 2016/2021–25. Safe when lagged.
16. **TeamRankings predictive rating vs. the market.** `nfl_external_ratings`, team-week (Wednesday), 2022–26. Safe via `as_of`; skip the Hi/Lo columns.
17. **Red-zone and third-down performance.** `nfl_team_week_features`, team-week, 2016–25. Safe when lagged. Noisy, so let regularization shrink it.
18. **Roster movement (trades, team changes, status changes, weekly counts).** `nfl_verified_events`, one row per event, 2020–26. Safe via `available_at`.
19. **Share of snaps going to core players and continuity (starters' prior snap share, offensive-line continuity).** `nfl_snaps`, `nfl_depth`, player-week, 2021–25. Safe when lagged; depth via `captured`.
20. **Scheme and charting mix (play action, RPO, screen, motion, men in box, personnel).** `nfl_play_charting` (2022–25), `nfl_play_formations` (2022–23); play level. Safe when lagged; charting coverage has gaps.
21. **Player efficiency aggregated to team level (NGS separation/cushion, rush yards over expected, YAC over expected, WOPR concentration).** `nfl_ngs`, `player_week_usage`, player-week, 2021–25. Safe when lagged.
22. **Public betting % (spread tickets and money).** `nfl_nfelo_lines`, one row per game, 2024–26 (tickets also 2020). Captured at close, so near-kickoff only and a tiny sample.
23. **Offseason carryover priors (head-coach change, QB change, prior-season EPA and implied points, vacated shares, draft capital).** `off_team_season`, `off_player_season_features`; team-season or player-season; 2021–26. Safe as prior-season values.
24. **Referee crew tendencies (penalty rate, home/road penalty split, totals effect).** `nfl_officials` joined to `nfl_team_week_features` penalties; one row per game; 2015–26. Safe if tendencies come only from earlier games; the assignment itself has no timestamp.
25. **Live market structure (Kalshi/Polymarket vs. books, weekday movement tape).** `prediction_market_quotes`, `polymarket_*`, live `nfl_line_snapshots`; quote level. Safe via `captured_at`, but 2026 only, so it can be collected for the future but can't be trained on yet.

**Data problems to fix before training:**
- 2026 QBR rows that copy 2025.
- Close rows timestamped after kickoff (14.6% of archive close rows; 9 tape snapshots).
- `game_lines` temp/wind and `nfl_game_weather` are the weather that actually happened, not a forecast.
- 2025–26 injuries have no `modified_at`.
- Opening spreads before 2022 are unreliable.
- Cards' coaching.games and TeamRankings Hi/Lo cover the full season.
- `nfl_nfelo_games`, `nfl_ffopportunity_weekly` and `nfl_team_coaches` were all re-fetched this month, so rows could reflect later revisions.

Scratch query scripts are in `/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/`.