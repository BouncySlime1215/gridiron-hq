# PROJ-01-a pre-registration: ESPN Mistake Map

Written and committed before any spot error or residual-model number was computed.
The only numbers seen before this commit are the baseline below (ESPN's MAE and mean
error per season and position) and the count of rows in each spot (no errors).

Study script: `scripts/rnd/espn-mistake-map.mjs` (`--grade` refuses to run unless this
file is committed and unchanged). Results: `docs/tdd/2026-09-23-proj-01a-mistake-map.tdd.md`.
Produces no served number. Local copy of the app database, not production.

## 1. Data and population

- ESPN projection and actual: `~/gridiron-local/rnd/loop/data/espn_proj_hist/espn_leaguedefaults3_<season>.json.gz`
  (public leaguedefaults/3, full PPR, top 800 players per season; local only, never
  committed). Projection = statSourceId 1, actual = statSourceId 0, both statSplitTypeId 1
  (one week), `appliedTotal`. The reader is BLEND-01's `parseEspnArchive` (PR #164's
  branch) plus the statSourceId 0 line, so projection and outcome share one scoring.
- Seasons 2021, 2022, 2023, 2024. Weeks 1-17 (week 18 excluded: resting starters).
- Rows: QB/RB/WR/TE player-weeks with ESPN projection >= 5.0 points whose team had a
  game (bye rows dropped). A row with no ESPN actual line counts as 0 points.
- Error = actual - ESPN. Positive = ESPN projected too low.
- **2025 is not opened.** The unit's rule 2 ("never open 2025") governs; the optional
  2025 confirmation named in the unit's goal is not used by this unit (section 6).

## 2. Baseline (measured before this file, tree `16dcf6b8`, local copy)

Command: `node scripts/rnd/espn-mistake-map.mjs --baseline --db .local-db/data.sqlite`

| season | rows | ESPN MAE | ESPN mean error |
|---|---|---|---|
| 2021 | 3,496 | 5.645 | -0.663 |
| 2022 | 3,326 | 5.552 | -0.478 |
| 2023 | 3,116 | 5.457 | -0.414 |
| 2024 | 3,275 | 5.562 | -0.336 |

ESPN over-projects this population on average in every season (mean error < 0), which is
why the spot test below uses the excess error over the complement, not the raw mean.

## 3. Blind-spot library (each spot tested alone)

Statistic: **excess error** of a spot row = its error minus the mean error of the rows of
the same season and position that are not in the spot. This removes ESPN's population
bias (section 2) so a spot is credited only for what is special about it. The raw spot
mean error is reported beside it and decides nothing.

| id | definition (all from data available before kickoff unless noted) | positions | predicted sign |
|---|---|---|---|
| backup_after_injury | he is rank 2 at his position on his team's previous-game depth chart (`nfl_depth`, `pos_slot = pos_abb`), a rank-1 player there is listed Out this week (`nfl_injuries`), and he is not Out | QB, RB, TE | + (ESPN under-projects the promoted backup) |
| rookie_weeks_1_4 | his first season with any stat line in `nfl_player_week_features` (starts 2016) is this season, weeks 1-4 | all | - (ESPN over-projects rookies early) |
| return_from_absence | his last played week this season (non-empty ESPN stat line or a `nfl_player_week_features` row) is 5+ weeks before this week (4+ missed weeks: IR-return proxy) | all | - (ESPN projects the full role; snaps are eased back) |
| qb_change | his team's starting QB this week (most pass attempts, `nfl_player_week_features`) differs from the starter in the team's previous game this season. Note: this week's starter is read from the game itself (announced before kickoff in practice, not stored pre-game here) | RB, WR, TE | - |
| wind_15_plus | `game_lines.wind` >= 15 mph, roof outdoors/open | QB, WR, TE | - |
| blowout_favorite_rb | his team's spread (`game_lines.spread`) <= -7 | RB | + |
| blowout_underdog_rb | his team's spread >= +7 | RB | - |

**Dropped (no source):** team total moved 2.5+ since open. No opening total exists for
2022 or 2023 (`game_lines.open_total`: 2021 and 2026 only; `nfl_nfelo_games.total_line_open`:
2024 and 2 games of 2023), so it cannot be tested in all four seasons. Recorded as dead.
PR #218's nflverse pbp loader was not needed: the QB-change and blowout spots are built
from `nfl_player_week_features` and `game_lines`, which cover 2021-2024.

**A spot counts (is "proven") only if all hold:**
1. the per-season mean excess error has the predicted sign in 2021, 2022, 2023 and 2024 separately;
2. the pooled (2021-2024) mean excess error has the predicted sign, with a player-clustered
   standard error, and its two-sided p-value survives Benjamini-Hochberg at q < 0.05 across
   all 7 tested spots (equivalently the BH-adjusted interval, level 1 - rank*0.05/7,
   excludes 0).

## 4. Residual model (walk-forward)

- Correction: least-absolute-deviation linear model of the error on: intercept, position
  (RB/WR/TE dummies), ESPN projection and its interaction with position, team spread,
  team implied points (`game_lines.implied_points`), weeks 1-4 flag, and the 7 spot flags.
  Prediction = ESPN + correction.
- Distribution: the fit's training residuals, bucketed by position x ESPN-projection
  tercile (edges from training rows). Each graded row's PIT is its residual's randomized
  empirical CDF value in its bucket.
- Walk-forward: fit on seasons < S, grade S, for S = 2022, 2023, 2024. 2023 and 2024 decide;
  2022 (one training season) is reported only.
- **Counts only if**, in both 2023 and 2024: MAE(ESPN + correction) < MAE(ESPN), and the
  KS test of the PIT values against Uniform(0,1) has p > 0.05.

## 5. Decision

- Status "built" if at least one spot is proven or the residual model counts; the output
  lists which spots, with sign and size (pooled excess, CI, per-season signs), for
  PROJ-01-b and the "why ESPN is off" UI to use. Only proven spots may be used later.
- Status "declined" otherwise; the dead spots are recorded in the results file.
- Nothing is served by this unit either way (no flag).

## 6. 2025

Not opened. If a spot is proven here, the 2025 confirmation belongs to the unit that
would serve it (PROJ-01-b), with a HOLDOUT-LEDGER row written before it looks.

## 7. Amendment 1 (2026-09-23, before this spot was graded): team total moved 2.5+

Review of PR #222 found that section 3's reason for dropping this spot is false. The
opening and closing lines exist for every study season in `nfl_odds_archive` (source
covers, 4 books: bet365, betvictor, betway, williamhill; open and close for totals and
spreads). The drop was wrong, so the spot is added here. Sections 1-6 are otherwise
unchanged, and the grades of the other 7 spots are not re-decided by this text.

**No error of any kind for this spot was computed or seen before this amendment was
committed.** Only row counts were seen (below), plus a check that the closing implied
team total matches `game_lines.implied_points` (mean absolute gap 0.17-0.21 points per
season). That check uses lines only, not ESPN errors. The other 7 spots' results were
already known (PR #222). They do not involve this spot's rows beyond the shared population.

| id | definition | positions | predicted sign |
|---|---|---|---|
| team_total_moved_2_5 | implied team total = total/2 - team spread/2, per book, averaged over books with open and close for both markets (`nfl_odds_archive`, weeks with a number, a game listed twice for one team-week is dropped). Move = close - open. Value +1 if move >= +2.5, -1 if <= -2.5, else not in the spot. Tested statistic = value x excess error (section 3's excess) | QB, RB, WR, TE | + (ESPN lags the market: under-projects when the team total rose, over-projects when it fell) |

- Row counts (population of section 1, in the spot, up / down): 2021 277 (67 / 210),
  2022 345 (91 / 254), 2023 303 (86 / 217), 2024 218 (58 / 160). Team-weeks with open and
  close: 272 / 271 / 259 / 272 games. Population rows matched to a line: 3,390 / 3,260 /
  2,871 / 3,275 total rows (3,187 matched in 2024). Rows with no line count as not in the spot.
- Timing caveat, decided in advance: the "open" is the book's first posted line (often
  about 10 days before the game), the close is at kickoff, and ESPN's projection time is
  unknown. A proven result means ESPN's number sits closer to the opening line than the
  close. It does not show when ESPN published.
- **The family is now 8 spots.** Section 3 rule 2 reads "across all 8 tested spots" and
  the BH-adjusted interval level is 1 - rank*0.05/8. All 8 spots are re-graded under m = 8.
- Section 4's residual model uses "the spot flags". It now has 8, and this spot enters
  as -1/0/+1. The residual-model numbers are re-graded with it.
