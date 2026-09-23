# PROJ-01-a: ESPN Mistake Map (results)

Stage 2 UNDERSTAND of the one engine: where does ESPN's weekly projection miss, in which
direction, and by how much? Offline study, nothing served, no flag.
Local copy of the app database, not production. Aggregates only.

- Pre-registration (committed first, `96457c6b`): `docs/evidence/2026-09-23/proj-01-preregistration.md`
- Script: `scripts/rnd/espn-mistake-map.mjs`; helper tests: `test/espn-mistake-map.test.js` (10 pass)
- Pre-registration amendment 1 (`c1126661`, typo fix `7644b3b1`), committed before the spot was
  graded: adds `team_total_moved_2_5` from `nfl_odds_archive`. The family becomes 8 spots.
- Graded on tree `975fb796` (8 spots, m = 8), local copy. The first grading (7 spots, tree
  `7912de2c`) is superseded; section 6 lists what changed.

```
sqlite3 ~/gridiron-local/data.sqlite ".backup '<worktree>/.local-db/data.sqlite'"
node scripts/rnd/espn-mistake-map.mjs --grade --db .local-db/data.sqlite
```

## 1. Population and baseline

ESPN leaguedefaults/3 (full PPR) projection vs ESPN's own actual line from the same payload.
QB/RB/WR/TE player-weeks with ESPN projection >= 5.0, weeks 1-17, 2021-2024. Error = actual - ESPN.
2025 not opened.

| season | rows | ESPN MAE | ESPN mean error |
|---|---|---|---|
| 2021 | 3,496 | 5.645 | -0.663 |
| 2022 | 3,326 | 5.552 | -0.478 |
| 2023 | 3,116 | 5.457 | -0.414 |
| 2024 | 3,275 | 5.562 | -0.336 |

The unit's brief gave no number for this baseline ("measured first"); these are the numbers.
ESPN over-projects this population every season (by 0.3-0.7 points a week). The spot test
therefore scores each spot's **excess** error over same-season, same-position rows outside it.

## 2. Blind-spot library

Each spot tested alone. Excess error in points per player-week; negative = ESPN projects too high
in that spot. Per-season n and excess are 2021 / 2022 / 2023 / 2024. CI = 95%, clustered by player.
BH = Benjamini-Hochberg across the 8 tested spots.

| spot | predicted | n per season | excess per season | pooled excess [95% CI] | BH-adjusted CI | p | q (BH) | raw mean | players | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| qb_change (RB/WR/TE) | - | 322 / 307 / 262 / 240 | -0.83 / -0.42 / -0.71 / -0.25 | -0.57 [-0.95, -0.19] | -1.05, -0.09 | 0.0032 | 0.009 | -0.96 | 339 | **proven** |
| blowout_underdog_rb (spread >= +7) | - | 174 / 99 / 96 / 82 | -0.05 / -1.02 / -0.23 / -2.03 | -0.66 [-1.23, -0.10] | -1.28, -0.04 | 0.0219 | 0.035 | -1.13 | 117 | **proven** |
| team_total_moved_2_5 (signed, all positions) | + | 277 / 345 / 303 / 218 | -0.33 / +0.36 / +1.43 / +1.02 | +0.60 [0.20, 1.00] | 0.12, 1.08 | 0.0035 | 0.009 | +0.80 | 434 | dead (2021 sign) |
| wind_15_plus (QB/WR/TE) | - | 270 / 116 / 87 / 126 | -1.61 / +0.15 / -0.90 / -0.56 | -0.95 [-1.44, -0.46] | -1.63, -0.26 | 0.0002 | 0.001 | -1.38 | 251 | dead (2022 sign) |
| blowout_favorite_rb (spread <= -7) | + | 186 / 106 / 109 / 86 | +0.87 / +1.50 / +1.22 / -0.53 | +0.84 [0.18, 1.50] | 0.09, 1.59 | 0.0123 | 0.025 | +0.17 | 109 | dead (2024 sign) |
| backup_after_injury (QB/RB/TE) | + | 45 / 33 / 41 / 41 | -0.41 / -1.82 / -0.05 / -0.25 | -0.57 [-1.59, 0.45] | -1.62, 0.48 | 0.274 | 0.313 | -1.00 | 94 | dead (wrong sign, CI spans 0) |
| return_from_absence (4+ missed weeks) | - | 44 / 28 / 24 / 25 | -1.35 / -0.54 / -2.48 / +1.25 | -0.85 [-2.09, 0.39] | -2.16, 0.46 | 0.178 | 0.237 | -1.35 | 107 | dead |
| rookie_weeks_1_4 | - | 92 / 65 / 81 / 79 | -1.16 / +0.32 / +1.02 / -0.66 | -0.17 [-0.99, 0.64] | -0.99, 0.64 | 0.675 | 0.675 | -0.66 | 120 | dead |

`team_total_moved_2_5` (amendment 1): the implied team total is total/2 - team spread/2 from
`nfl_odds_archive` (4 books, open and close), and move = close - open. A row counts as +1 when the move is
at least +2.5 and as -1 when it is at most -2.5. The statistic is the direction times the excess error, so
+ means ESPN lags the market's move. Rows in the spot, up / down: 67 / 210, 91 / 254, 86 / 217, 58 / 160.

What this means in plain words:

1. **When a team changes starting QB, ESPN over-projects that team's RBs, WRs and TEs by about
   0.6 points a week** beyond its usual miss. Same direction in all four seasons.
2. **RBs on 7+ point underdogs score about 0.7 points a week less than ESPN says** beyond its
   usual RB miss. Same direction in all four seasons, but 2021 (-0.05) and 2023 (-0.23) are
   small; most of the effect is 2022 and 2024.
3. Wind, big-favorite RBs and team-total moves look real in the pooled number, but each flipped
   sign in one season, so none counts under the pre-registered rule. Team-total moves are the
   closest miss. When a team total moved 2.5+ from open to close, the player's score followed the
   move by about 0.6 points a week beyond ESPN's usual miss in 2022-24 (q 0.009), but 2021 went
   the other way (-0.33).

### Checks on the two proven spots (reported, decide nothing)

- **QB change leakage.** The pre-registered spot reads this week's starter from the game
  itself, so an in-game injury could create the spot after kickoff. Restricting to changes where
  the previous starter threw no pass this week (he did not play, which is known before kickoff):
  excess -0.62 [-1.03, -0.21], p = 0.003, n 241 / 253 / 208 / 185, negative in all four seasons.
  The in-game-only remainder is -0.38 [-1.25, 0.49]. The effect is not a leakage artifact.
- Reading this week's starter from `nfl_depth` instead gave -0.16 [-0.58, 0.26]; that version
  overlaps the game-based one on only 322 of 1,131 rows (the weekly depth chart's QB1 is often
  stale), so it is a poor proxy, not a contradiction. PROJ-01-b needs a clean pre-kickoff
  starter source before serving this spot.
- Rows without an ESPN actual line (counted as 0): 2 of 13,213. Dropping them moves no spot by
  more than 0.01.

## 3. Residual model (walk-forward, fit on seasons before the graded one)

LAD correction on position, ESPN projection (x position), spread, implied points, weeks 1-4,
and the 8 spot flags (team_total_moved_2_5 enters as -1/0/+1); error distribution from training
residuals by position x projection tercile.

| graded | fit on | rows fit / graded | ESPN MAE | ESPN + correction MAE | change [95% CI] | PIT KS D | KS p | 80% band coverage |
|---|---|---|---|---|---|---|---|---|
| 2022 (report only) | 2021 | 3,496 / 3,326 | 5.552 | 5.434 | -0.118 [-0.176, -0.059] | 0.0114 | 0.780 | 0.793 |
| 2023 | 2021-22 | 6,822 / 3,116 | 5.457 | 5.336 | -0.120 [-0.181, -0.060] | 0.0337 | **0.0017** | 0.817 |
| 2024 | 2021-23 | 9,938 / 3,275 | 5.562 | 5.426 | -0.136 [-0.193, -0.078] | 0.0193 | 0.174 | 0.808 |

**The residual model does not count.** It beats ESPN's MAE by about 0.12-0.14 points in 2023 and
2024, but its predicted error distribution fails the PIT check in 2023 (KS p = 0.0017 < 0.05).
Most of the MAE gain is the intercept (ESPN's population-wide over-projection), not the spots.

## 4. Verdict

- Proven spots: **qb_change** (-0.57) and **blowout_underdog_rb** (-0.66). Only these may be
  used by PROJ-01-b and the "why ESPN is off" UI.
- Dead spots: team_total_moved_2_5 (2021 sign), wind_15_plus, blowout_favorite_rb,
  backup_after_injury, return_from_absence, rookie_weeks_1_4.
- Residual model: not counted (PIT fails 2023). Its distribution needs work before any
  served interval uses it.
- 2025: not opened. The one-time 2025 confirmation belongs to PROJ-01-b, with a
  HOLDOUT-LEDGER row written before it looks.

## 5. Not confirmed

- ESPN's archived projection is taken to be its final pre-kickoff number; the archive does
  not carry a timestamp per week.
- Team-total move: the "open" is each book's first posted line, often about 10 days before the
  game. The close is at kickoff. Since ESPN's publish time is unknown, a positive result would say
  only that ESPN sits closer to the opening line. 4 books are averaged, and 2-8% of population rows
  have no matched line and count as not in the spot.
- `game_lines.spread` is nflverse's closing line; wind is nflverse's game-day value (NA on
  many outdoor games, so the wind spot covers only games with a recorded wind).
- PR #218's nflverse pbp loader was not used: the spots needed only `nfl_player_week_features`,
  `game_lines`, `nfl_depth` and `nfl_injuries`, which cover 2021-2024 on the local copy.
- BLEND-01's assembler (PR #164) builds our projection beside ESPN's; this study needs only
  ESPN's projection and actual, so it reuses that branch's archive reader
  (`parseEspnArchive`, same filters) and adds the actual line; it does not import the branch.

## 6. Change from the first grading (review of PR #222)

- The first version dropped `team_total_moved_2_5` as "no source (no opening total for 2022-23)".
  That was false: it checked only `game_lines.open_total` and `nfl_nfelo_*`. `nfl_odds_archive`
  holds open and close totals and spreads for 2021-24 (262-280 games a season, 4 books).
- The spot was added by pre-registration amendment 1 before it was graded, and all 8 spots were
  re-graded with m = 8.
- What moved:
  - q-values: qb_change 0.011 -> 0.009, blowout_underdog_rb 0.038 -> 0.035,
    blowout_favorite_rb 0.029 -> 0.025. No verdict changed.
  - Residual model (it now has the 8th flag): 2023 MAE 5.328 -> 5.336 and KS p 0.0035 -> 0.0017;
    2024 5.425 -> 5.426 and KS p 0.162 -> 0.174. It still does not count.
- Baseline, spot n's, the other spots' excess and CIs, and the QB-change sensitivities are unchanged.
