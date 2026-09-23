# PROJ-01-a: ESPN Mistake Map (results)

Stage 2 UNDERSTAND of the one engine: where does ESPN's weekly projection miss, in which
direction, and by how much? Offline study, nothing served, no flag.
Local copy of the app database, not production. Aggregates only.

- Pre-registration (committed first, `96457c6b`): `docs/evidence/2026-09-23/proj-01-preregistration.md`
- Script: `scripts/rnd/espn-mistake-map.mjs`; helper tests: `test/espn-mistake-map.test.js` (10 pass)
- Graded on tree `7912de2c`; the same command on `256bec9a` gave identical spot and model numbers
  (the later commit only added the sensitivity rows).

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
BH = Benjamini-Hochberg across the 7 tested spots.

| spot | predicted | n per season | excess per season | pooled excess [95% CI] | BH-adjusted CI | p | q (BH) | raw mean | players | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| qb_change (RB/WR/TE) | - | 322 / 307 / 262 / 240 | -0.83 / -0.42 / -0.71 / -0.25 | -0.57 [-0.95, -0.19] | -1.04, -0.10 | 0.0032 | 0.011 | -0.96 | 339 | **proven** |
| blowout_underdog_rb (spread >= +7) | - | 174 / 99 / 96 / 82 | -0.05 / -1.02 / -0.23 / -2.03 | -0.66 [-1.23, -0.10] | -1.29, -0.03 | 0.0219 | 0.038 | -1.13 | 117 | **proven** |
| wind_15_plus (QB/WR/TE) | - | 270 / 116 / 87 / 126 | -1.61 / +0.15 / -0.90 / -0.56 | -0.95 [-1.44, -0.46] | -1.62, -0.27 | 0.0002 | 0.001 | -1.38 | 251 | dead (2022 sign) |
| blowout_favorite_rb (spread <= -7) | + | 186 / 106 / 109 / 86 | +0.87 / +1.50 / +1.22 / -0.53 | +0.84 [0.18, 1.50] | 0.07, 1.61 | 0.0123 | 0.029 | +0.17 | 109 | dead (2024 sign) |
| backup_after_injury (QB/RB/TE) | + | 45 / 33 / 41 / 41 | -0.41 / -1.82 / -0.05 / -0.25 | -0.57 [-1.59, 0.45] | -1.62, 0.48 | 0.274 | 0.320 | -1.00 | 94 | dead (wrong sign, CI spans 0) |
| return_from_absence (4+ missed weeks) | - | 44 / 28 / 24 / 25 | -1.35 / -0.54 / -2.48 / +1.25 | -0.85 [-2.09, 0.39] | -2.18, 0.48 | 0.178 | 0.249 | -1.35 | 107 | dead |
| rookie_weeks_1_4 | - | 92 / 65 / 81 / 79 | -1.16 / +0.32 / +1.02 / -0.66 | -0.17 [-0.99, 0.64] | -0.99, 0.64 | 0.675 | 0.675 | -0.66 | 120 | dead |
| team_total_moved_2_5 | + / - | - | - | - | - | - | - | - | - | dead: no source (no opening total for 2022-23) |

What this means in plain words:

1. **When a team changes starting QB, ESPN over-projects that team's RBs, WRs and TEs by about
   0.6 points a week** beyond its usual miss. Same direction in all four seasons.
2. **RBs on 7+ point underdogs score about 0.7 points a week less than ESPN says** beyond its
   usual RB miss. Same direction in all four seasons, but 2021 (-0.05) and 2023 (-0.23) are
   small; most of the effect is 2022 and 2024.
3. Wind and big-favorite RBs look real in the pooled number but each flipped sign in one
   season, so they do not count under the pre-registered rule.

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
and the 7 spot flags; error distribution from training residuals by position x projection tercile.

| graded | fit on | rows fit / graded | ESPN MAE | ESPN + correction MAE | change [95% CI] | PIT KS D | KS p | 80% band coverage |
|---|---|---|---|---|---|---|---|---|
| 2022 (report only) | 2021 | 3,496 / 3,326 | 5.552 | 5.424 | -0.128 [-0.186, -0.070] | 0.0136 | 0.564 | 0.800 |
| 2023 | 2021-22 | 6,822 / 3,116 | 5.457 | 5.328 | -0.129 [-0.189, -0.069] | 0.0319 | **0.0035** | 0.818 |
| 2024 | 2021-23 | 9,938 / 3,275 | 5.562 | 5.425 | -0.137 [-0.194, -0.079] | 0.0196 | 0.162 | 0.807 |

**The residual model does not count.** It beats ESPN's MAE by about 0.13 points in 2023 and
2024, but its predicted error distribution fails the PIT check in 2023 (KS p = 0.0035 < 0.05).
Most of the MAE gain is the intercept (ESPN's population-wide over-projection), not the spots.

## 4. Verdict

- Proven spots: **qb_change** (-0.57) and **blowout_underdog_rb** (-0.66). Only these may be
  used by PROJ-01-b and the "why ESPN is off" UI.
- Dead spots: backup_after_injury, rookie_weeks_1_4, return_from_absence, wind_15_plus,
  blowout_favorite_rb, team_total_moved_2_5 (no source).
- Residual model: not counted (PIT fails 2023). Its distribution needs work before any
  served interval uses it.
- 2025: not opened. The one-time 2025 confirmation belongs to PROJ-01-b, with a
  HOLDOUT-LEDGER row written before it looks.

## 5. Not confirmed

- ESPN's archived projection is taken to be its final pre-kickoff number; the archive does
  not carry a timestamp per week.
- `game_lines.spread` is nflverse's closing line; wind is nflverse's game-day value (NA on
  many outdoor games, so the wind spot covers only games with a recorded wind).
- PR #218's nflverse pbp loader was not used: the spots needed only `nfl_player_week_features`,
  `game_lines`, `nfl_depth` and `nfl_injuries`, which cover 2021-2024 on the local copy.
- BLEND-01's assembler (PR #164) builds our projection beside ESPN's; this study needs only
  ESPN's projection and actual, so it reuses that branch's archive reader
  (`parseEspnArchive`, same filters) and adds the actual line; it does not import the branch.
