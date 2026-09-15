# Offseason data and the player-season feature set

> Built 2026-09-06. Owner: `server/services/offseason-data.js`, `scripts/sync-offseason-data.mjs`,
> `test/offseason-data.test.js`. Writes only tables prefixed `off_`; reads and modifies nothing else.

## What this is for

`nfl-offseason-change.js` derives two quantities before Week 1 — did the player change teams, and
what share of his old team's opportunity walked out the door — both from `player_week_usage`. That is
everything one table can honestly support. This module is the wider net: every free, public,
key-less source that says something about a player-season *before* it is played, ingested into
`off_*` tables and reduced to one 66-column row per player-season for 2021-2026.

Nothing here is a projection or an adjustment. It is a feature table. Whether any of these columns
survives the discovery → significance → Holm pipeline is a separate question, and none of them gets
an exemption for being well-motivated.

**Cutoff discipline.** Every column is either (a) a fact about season `T-1` or earlier, or (b) a fact
about season `T` that is settled before Week 1 — the roster, the draft, the schedule and its closing
betting lines, the opening depth chart, contracts. Nothing reads a season-`T` game result.

## Running it

```
node scripts/sync-offseason-data.mjs                 # 2021-2026, ~17s, ~90MB downloaded
node scripts/sync-offseason-data.mjs 2025 2026       # a subset of seasons
node scripts/sync-offseason-data.mjs --features-only  # recompute from what is already stored
```

Idempotent: every write is `INSERT OR REPLACE` keyed on season + player/team, inside a transaction.
A rerun changes no value except `computed_at` (asserted in the test suite). Each dataset is isolated —
one 404 upstream costs that dataset and nothing else, and is reported rather than swallowed.

## Reading it

```js
import { offseasonFeatures, offseasonFeatureRow } from './services/offseason-data.js';

offseasonFeatures(2026);              // Map<players.id, featureRow>, one query, cached per process
offseasonFeatureRow(417, 2026);       // by players.id
offseasonFeatureRow('00-0036900', 2026); // or by nflverse gsis_id
```

`offseasonFeatures` runs one `SELECT` per season and indexes it in memory. The cache is per process;
call `clearOffseasonCache()` after a sync.

## Datasets ingested

| Table | Source | Seasons | Rows | Notes |
| --- | --- | --- | --- | --- |
| `off_rosters` | `rosters/roster_YYYY.csv` | 2020-2026 | 21,542 | Week-1 roster + the id crosswalk (`espn_id`, `pfr_id`, `sleeper_id`) everything else joins through |
| `off_draft_picks` | `draft_picks/draft_picks.csv` | 2015-2026 | 3,078 | Rookie capital by team/position/round/pick |
| `off_contracts` | `contracts/historical_contracts.csv.gz` | ≤2022 signings | 24,918 | OverTheCap via nflverse. **Stale upstream — see gaps** |
| `off_depth_chart` | `depth_charts/depth_charts_YYYY.csv` | 2021-2026 | 13,864 | Opening-week ordering only |
| `off_ngs_season` | `nextgen_stats/ngs_{receiving,rushing,passing}.csv.gz` | 2020-2025 | 1,298 | The `week = 0` season-total rows |
| `off_pfr_adv_season` | `pfr_advstats/advstats_season_{rec,rush,pass}.csv` | 2018-2025 | 7,721 | aDOT, YBC/YAC, broken tackles, drop %, pressure % |
| `off_qbr_season` | `espn_data/qbr_season_level.csv` | 2015-2025 | 659 | Keyed on ESPN athlete id |
| `off_schedule_games` | `schedules/games.csv` | 2019-2026 | 2,232 | Carries `spread_line`/`total_line` per game — the free historical implied-total source |
| `off_team_season_stats` | `stats_team/stats_team_reg_YYYY.csv` | 2020-2025 | 192 | Team pace and pass rate, pre-aggregated |
| `off_sleeper_players` | `api.sleeper.app/v1/players/nfl` | current only | 6,059 | Live depth order + injury designation |
| `off_team_season` | derived | 2021-2026 | 192 | 29 columns of team context |
| `off_player_season_features` | derived | 2021-2026 | 6,062 | The deliverable |

Total run: **16.6s** wall clock, no failures, one documented skip (2026 team totals — that season has
not been played).

### Two ingest details worth knowing

**NGS must be read from the all-seasons assets.** `ngs_2024_receiving.csv.gz` still exists but stopped
being refreshed: it currently holds four rows, and there is no `ngs_2025_*` file at all. The combined
`ngs_receiving.csv.gz` is complete through 2025. A per-season fetch here produced 8 rows for 2024 and
404s for 2025 before this was caught.

**Depth charts changed format in 2025.** Through 2024 the feed is the NFL's own weekly chart
(`season`/`club_code`/`week`/`depth_team`); from 2025 it is a dated ESPN scrape (`dt`/`team`/`pos_abb`/
`pos_rank`) with no season or week column at all. Both are reduced to opening-week ordering. For the
dated format the ingest takes the earliest snapshot **on or after 1 August** — the 2026 file starts in
March, and a March depth chart predates free agency and the draft.

## Datasets skipped, and why

| Dataset | Why |
| --- | --- |
| `ftn_charting` (routes, motion, play action) | Play-level with no player id and no offense column. Attributing a motion rate to a *player* needs a `pbp` join on `nflverse_play_id`, which means the ~200MB per-season play-by-play files. The team-level slice it would yield is already covered by `team_pass_rate_prior`. `prior_adot`, `prior_drop_pct` and `prior_broken_tackles` from `pfr_advstats` cover the per-player charting need at a fraction of the cost. |
| `pbp` / `pbp_participation` | ~200MB per season for team pace and neutral pass rate that `stats_team_reg_*.csv` publishes pre-aggregated at ~30KB. Pass rate over expectation genuinely needs pbp and is therefore **not** in this feature set — `team_pass_rate_prior` is a raw dropback rate, not PROE. |
| `officials` | Explicitly out of scope. |
| `teams` release | Only `teams_colors_logos.csv`; the metadata this app needs is already in `nfl_teams`. |
| Offensive-coordinator history | No free per-season OC feed exists. `nfl_teams.oc_name` is current-only (one row per team, overwritten), so `oc_change` cannot be computed for a past season without back-filling from Wikipedia or PFR tables — neither reliable enough to key a model column on. **`oc_change` is absent, not NULL-filled.** Head-coach change *is* available, from `games.csv`'s `home_coach`/`away_coach`, for every season. |
| Scheme change | Same reason: `nfl_teams.off_scheme` is a current-only text field with no history. **`scheme_change_flag` is absent.** |
| Offseason surgery | Not derivable from any free feed. The weekly injury report carries a designation, not a procedure. The honest substitute is `late_season_injury_flag` (Out in any of the prior season's final four weeks), which is what shipped. |
| Team win totals (season-long futures) | Not free historically. Superseded anyway: per-game closing lines in `games.csv` give a *better* offense expectation (`implied_team_points`) for every season 2021-2026, which is what the win-total column was a proxy for. |

## The columns

66 columns, one row per player-season, primary key `(season, gsis_id)`. Coverage below is the
percentage of rows where the column is non-NULL, over **all** rows including deep-bench players.

### Identity

| Column | Source | Formula |
| --- | --- | --- |
| `season`, `gsis_id` | — | Primary key |
| `player_id` | `players.gsis_id` | This app's own row id, NULL for players it does not carry |
| `player_name`, `position` | `off_rosters` | |
| `team` | `off_rosters` season `T` | Where he is in August |
| `prior_team` | `player_week_usage` `T-1` | The team he took the most opportunity for |

### Prior-season production and role (all from season `T-1`)

| Column | Source | Formula |
| --- | --- | --- |
| `prior_ppg` | `player_week_usage` | Full-PPR points ÷ games played |
| `prior_games` | `player_week_usage` | Weeks with a usage row |
| `prior_target_share` | `player_week_usage` | Mean weekly `target_share` |
| `prior_carry_share` | `player_week_usage` | His carries ÷ his team's carries |
| `prior_air_yard_share` | `player_week_usage` | Mean weekly `air_yards_share` |
| `prior_snap_share` | `player_week_snaps` | Mean weekly `offense_pct` |
| `prior_wopr` | `player_week_usage` | Mean weekly WOPR |
| `prior_epa_per_play` | `player_week_usage` | (pass + rush + rec EPA) ÷ (attempts + carries + targets) |
| `prior_xfp_per_game` | `nfl_ffopportunity_weekly` | Expected fantasy points ÷ charted games |
| `prior_xfp_diff` | `nfl_ffopportunity_weekly` | (actual − expected) ÷ charted games |
| `prior_ngs_separation`, `prior_ngs_cushion`, `prior_ngs_air_yards_share`, `prior_yac_oe` | `off_ngs_season` receiving | Season totals |
| `prior_ryoe_per_att` | `off_ngs_season` rushing | `rush_yards_over_expected_per_att` |
| `prior_adot`, `prior_drop_pct` | `off_pfr_adv_season` rec | |
| `prior_broken_tackles` | `off_pfr_adv_season` rec + rush | Summed |

### Offseason movement

| Column | Source | Formula |
| --- | --- | --- |
| `team_change` | rosters vs `T-1` usage | 1 if `team ≠ prior_team` |
| `new_team_vacated_target_share` | derived | Share of the **new** team's `T-1` targets held by players not on its `T` roster |
| `new_team_vacated_carry_share` | derived | Same for carries |
| `own_team_vacated_share` | derived | The same measure on his **prior** team, using carries for RBs and targets for everyone else |
| `capital_added_at_position` | `off_draft_picks` | Count of rounds-1-3 picks his `T` team spent at his position group |
| `top_pick_added_at_position` | `off_draft_picks` | Lowest pick number spent at his position group (any round); NULL if none |
| `veterans_added_at_position` | `off_rosters` | Players at his position group on his `T` team who were elsewhere in `T-1` and have ≥1 year of experience |

"Departed" is resolved from season `T`'s roster file, not from news. A player with no `T` roster row at
all — unsigned free agent, retirement — counts as departed, which is correct: his opportunity is
genuinely available.

### Contract

| Column | Source | Formula |
| --- | --- | --- |
| `apy`, `apy_cap_pct` | `off_contracts` | Latest signing covering season `T` |
| `apy_rank_on_team_at_position` | derived | Rank by APY among players actually rostered at his team + position group in `T` |
| `contract_year` | `off_contracts` | 1 if `year_signed + years − 1 == T` |
| `new_contract` | `off_contracts` | 1 if `year_signed == T` |
| `contract_years_remaining` | `off_contracts` | `year_signed + years − T` |

### Team context (denormalised from `off_team_season` so a read is one query)

| Column | Source | Formula |
| --- | --- | --- |
| `qb_change` | usage `T-1` vs `T` (or `T` depth chart) | 1 if the primary QB differs |
| `qb_qbr_delta` | `off_qbr_season` `T-1` | New QB's `T-1` QBR − old QB's `T-1` QBR. Quantifies the change rather than flagging it |
| `hc_change` | `games.csv` coach fields | 1 if the modal head coach differs from `T-1` |
| `hc_tenure_years` | `games.csv` | Consecutive seasons with the same coach, walked back to 2010 |
| `implied_team_points` | `off_schedule_games` | Mean of `total_line/2 ± spread_line/2` over the season's games |
| `implied_points_delta_vs_prior` | derived | `T` minus `T-1` |
| `team_pass_rate_prior` | `off_team_season_stats` `T-1` | dropbacks ÷ (dropbacks + carries), where dropbacks = attempts + sacks suffered |
| `team_plays_prior` | `off_team_season_stats` `T-1` | Plays per game |
| `team_points_per_game_prior` | `game_lines` `T-1` | Mean `team_score` |
| `division_sos_proxy` | `off_schedule_games` | Mean `implied_team_points` of the opponents faced in `T` — higher means facing better offenses |
| `bye_week` | `off_schedule_games` | First week 1..N with no game |
| `dome_home`, `home_surface` | `off_schedule_games` | Modal roof/surface of the team's home games |

### Depth chart

| Column | Source | Formula |
| --- | --- | --- |
| `depth_slot_t` | `off_depth_chart` `T` | Best (lowest) rank on the opening chart |
| `depth_slot_prior_end` | `nfl_depth` `T-1` | Best rank in the last **regular-season** week (capped at 18 — weeks 19-22 are the playoffs and resolve ~3% of players) |
| `depth_slot_delta` | derived | `depth_slot_t − depth_slot_prior_end` |
| `sleeper_depth_chart_order`, `sleeper_injury_status` | Sleeper | **Current season only.** Sleeper publishes a live snapshot with no history; stamping today's chart onto 2022 would be a leak |

### Biography and availability

| Column | Source | Formula |
| --- | --- | --- |
| `age_at_season` | rosters / `nflverse_player_positions` / OTC | Years between birth date and 1 September of season `T` |
| `years_exp`, `rookie` | `off_rosters` | `rookie` is `rookie_year == T` |
| `draft_round`, `draft_pick` | `nflverse_player_positions`, OTC, rosters | First non-NULL of the three |
| `injury_games_missed_prior` | `nfl_injuries` `T-1` | Weeks with `report_status = 'Out'` |
| `injury_reports_prior` | `nfl_injuries` `T-1` | Weeks appearing on the report at all |
| `ir_stints_prior` | `nfl_injuries` `T-1` | Runs of ≥3 consecutive Out weeks. A proxy — the injury report never says IR |
| `late_season_injury_flag` | `nfl_injuries` `T-1` | Out in any of the final four reported weeks |

## Coverage, per season, all rows

Row counts: **2021: 929 · 2022: 1,047 · 2023: 1,031 · 2024: 1,039 · 2025: 1,020 · 2026: 996.**
Percentages are non-NULL over all rows.

| Column | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
| --- | --- | --- | --- | --- | --- | --- |
| `player_id` | 97 | 93 | 94 | 92 | 94 | 98 |
| `player_name` | 100 | 100 | 100 | 100 | 100 | 100 |
| `position` | 100 | 100 | 100 | 100 | 100 | 100 |
| `team` | 100 | 95 | 94 | 96 | 95 | 92 |
| `prior_team` | 0 | 61 | 59 | 56 | 58 | 61 |
| `prior_ppg` | 0 | 61 | 59 | 56 | 58 | 61 |
| `prior_games` | 0 | 61 | 59 | 56 | 58 | 61 |
| `prior_target_share` | 0 | 61 | 59 | 56 | 58 | 61 |
| `prior_carry_share` | 0 | 61 | 59 | 56 | 58 | 61 |
| `prior_air_yard_share` | 0 | 61 | 59 | 56 | 58 | 61 |
| `prior_snap_share` | 0 | 60 | 58 | 56 | 57 | 60 |
| `prior_wopr` | 0 | 61 | 59 | 56 | 58 | 61 |
| `prior_epa_per_play` | 0 | 57 | 56 | 53 | 55 | 57 |
| `prior_xfp_per_game` | 0 | 0 | 57 | 54 | 56 | 59 |
| `prior_xfp_diff` | 0 | 0 | 57 | 54 | 56 | 59 |
| `prior_ngs_separation` | 14 | 12 | 12 | 11 | 13 | 12 |
| `prior_ngs_cushion` | 14 | 12 | 12 | 11 | 13 | 12 |
| `prior_ngs_air_yards_share` | 14 | 12 | 12 | 11 | 13 | 12 |
| `prior_ryoe_per_att` | 6 | 5 | 5 | 5 | 5 | 5 |
| `prior_yac_oe` | 14 | 12 | 12 | 11 | 13 | 12 |
| `prior_adot` | 48 | 46 | 47 | 45 | 46 | 49 |
| `prior_broken_tackles` | 55 | 53 | 55 | 52 | 55 | 58 |
| `prior_drop_pct` | 48 | 46 | 47 | 45 | 46 | 49 |
| `team_change` | 0 | 56 | 53 | 51 | 53 | 53 |
| `new_team_vacated_target_share` | 0 | 95 | 94 | 96 | 95 | 92 |
| `new_team_vacated_carry_share` | 0 | 95 | 94 | 96 | 95 | 92 |
| `own_team_vacated_share` | 0 | 61 | 59 | 56 | 58 | 61 |
| `capital_added_at_position` | 100 | 95 | 94 | 96 | 95 | 92 |
| `top_pick_added_at_position` | 52 | 44 | 46 | 45 | 42 | 45 |
| `veterans_added_at_position` | 100 | 95 | 94 | 96 | 95 | 92 |
| `apy` | 97 | 88 | 42 | 23 | 8 | 1 |
| `apy_cap_pct` | 97 | 88 | 42 | 23 | 8 | 1 |
| `apy_rank_on_team_at_position` | 97 | 87 | 41 | 23 | 8 | 1 |
| `contract_year` | 97 | 88 | 42 | 23 | 8 | 1 |
| `new_contract` | 97 | 88 | 42 | 23 | 8 | 1 |
| `contract_years_remaining` | 97 | 88 | 42 | 23 | 8 | 1 |
| `qb_change` | 0 | 88 | 89 | 90 | 84 | 86 |
| `qb_qbr_delta` | 0 | 76 | 61 | 59 | 62 | 77 |
| `hc_change` | 100 | 95 | 94 | 96 | 95 | 92 |
| `hc_tenure_years` | 100 | 95 | 94 | 96 | 95 | 92 |
| `implied_team_points` | 100 | 95 | 94 | 96 | 95 | 92 |
| `implied_points_delta_vs_prior` | 100 | 95 | 94 | 96 | 95 | 92 |
| `team_pass_rate_prior` | 100 | 95 | 94 | 96 | 95 | 92 |
| `team_plays_prior` | 100 | 95 | 94 | 96 | 95 | 92 |
| `team_points_per_game_prior` | 100 | 95 | 94 | 96 | 95 | 92 |
| `division_sos_proxy` | 100 | 95 | 94 | 96 | 95 | 92 |
| `bye_week` | 100 | 95 | 94 | 96 | 95 | 92 |
| `dome_home` | 100 | 95 | 94 | 96 | 95 | 78 |
| `home_surface` | 100 | 95 | 94 | 96 | 95 | 92 |
| `depth_slot_t` | 52 | 47 | 46 | 47 | 84 | 84 |
| `depth_slot_prior_end` | 0 | 43 | 46 | 46 | 44 | 62 |
| `depth_slot_delta` | 0 | 30 | 32 | 34 | 41 | 56 |
| `sleeper_depth_chart_order` | 0 | 0 | 0 | 0 | 0 | 56 |
| `sleeper_injury_status` | 0 | 0 | 0 | 0 | 0 | 15 |
| `age_at_season` | 99 | 95 | 95 | 99 | 95 | 99 |
| `years_exp` | 100 | 95 | 94 | 96 | 95 | 92 |
| `rookie` | 100 | 100 | 100 | 100 | 100 | 100 |
| `draft_round` | 56 | 54 | 57 | 57 | 58 | 59 |
| `draft_pick` | 56 | 54 | 57 | 57 | 58 | 59 |
| `injury_games_missed_prior` | 0 | 41 | 41 | 41 | 41 | 44 |
| `injury_reports_prior` | 0 | 41 | 41 | 41 | 41 | 44 |
| `ir_stints_prior` | 0 | 41 | 41 | 41 | 41 | 44 |
| `late_season_injury_flag` | 0 | 41 | 41 | 41 | 41 | 44 |

## Coverage among players who actually matter

The table above divides by ~1,000 rows a season, and roughly 400 of those are camp bodies with no
prior production at all. Restricted to the rows with `prior_ppg >= 6` (~230 a season — a redraft
league's entire draftable pool), the sparse columns look very different:

| Column | 2022 | 2023 | 2024 | 2025 | 2026 |
| --- | --- | --- | --- | --- | --- |
| rows | 261 | 247 | 223 | 237 | 224 |
| `prior_xfp_per_game` | 0 | 99 | 99 | 99 | 100 |
| `depth_slot_t` | 82 | 85 | 87 | 97 | 95 |
| `draft_round` | 85 | 89 | 91 | 90 | 93 |
| `injury_games_missed_prior` | 82 | 81 | 82 | 85 | 83 |
| `prior_adot` / `prior_drop_pct` | 79 | 78 | 78 | 78 | 80 |
| `sleeper_depth_chart_order` | 0 | 0 | 0 | 0 | 92 |
| `prior_ngs_separation` | 42 | 43 | 43 | 48 | 43 |
| `prior_ryoe_per_att` | 19 | 18 | 19 | 17 | 20 |
| `apy` | 88 | 60 | 37 | 16 | 2 |

## Known gaps

1. **The contracts feed is stale.** nflverse's `historical_contracts` release has no signing later
   than **2022**. Every contract column is therefore trustworthy for 2021-2023 and effectively empty
   by 2025-2026 (`apy` reaches 2% of relevant players in 2026). This is an upstream problem, not an
   ingest bug — verified with `SELECT MAX(year_signed) FROM off_contracts`. There is no free,
   licence-clean replacement; OverTheCap and Spotrac both require scraping their own pages. **Do not
   use the contract columns for 2024+ without checking this again.** Everything else in the module
   works without them.
2. **2021 has almost no prior-season columns.** `player_week_usage` starts at 2021, so season 2021's
   `T-1` is empty. The first fully-populated feature season is **2022**, and the first with expected
   fantasy points is **2023** (`nfl_ffopportunity_weekly` starts at 2022).
3. **NGS covers only qualified players** — about 120 receivers and 50 rushers a season, by design.
   12% of all rows, 43% of relevant receivers. `prior_ryoe_per_att` is the thinnest column in the set.
4. **`ir_stints_prior` is a proxy**, defined as runs of ≥3 consecutive `Out` weeks. The weekly injury
   report does not publish transaction status, so a genuine IR designation is not directly observable.
5. **`prior_carry_share` divides by team carries from `player_week_usage`**, which only covers players
   this app carries a `gsis_id` for. It is a share of *observed* carries, very close to but not
   exactly the team total.
6. **No pass rate over expectation.** `team_pass_rate_prior` is a raw dropback rate. PROE needs
   play-by-play; see the skipped list.
7. **`oc_change` and `scheme_change_flag` do not exist as columns.** There is no free per-season
   offensive-coordinator or scheme feed, and `nfl_teams` carries only a current value with no history.
   A NULL column across every season would be worse than an absent one.
8. **`depth_slot_prior_end` sits around 45%** for 2022-2025 because `nfl_depth` only holds the players
   a team listed that week, and the 2025+ ESPN-sourced format is much wider than the older NFL one
   (hence the jump to 62% for 2026).
9. **Contract rows collapse on `(otc_id, year_signed, years)`.** 31,874 upstream rows land as 24,918:
   restructures and duplicate publications of the same deal fold together. Since the read path takes
   the latest signing covering season `T`, this is the intended behaviour, not data loss.

## Tests

`test/offseason-data.test.js` — 14 tests, hermetic, no network. A synthetic 32-team league of 256
players is generated with the real nflverse column names, `fetch` is mocked, and the full sync runs
end to end against a temporary database. Covers: the shared RFC-4180 parser (quoted commas, escaped
quotes, CRLF, embedded newlines, ragged rows, empty input); every exported formula (`pprPoints`,
`impliedPoints`, `nicknameToAbbr`, `normTeam`, `vacatedShares`) against hand-computed values; a smoke
that `offseasonFeatures(2026)` returns >150 players carrying every documented column; per-column value
assertions on a known synthetic player; idempotency of a rerun; and an assertion that the sync writes
nothing outside `off_*`.
