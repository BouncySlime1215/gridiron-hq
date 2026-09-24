# BROKEN-D: one `nfl.week` and one `league.week`

BROKEN-NUMBERS row D: "several pages — three different current weeks —
trade-engine.js:180 vs league-week.js:12 vs season-sim.js:190". Behind
`preview-mode.js#previewUnconfirmed()`; flag off, every caller returns what it did.

## 1. Audit: who computed "which week is it" (origin/main `ea947d4`)

`grep -rn "process.env.NFL_WEEK\|team_score IS NULL\|currentMatchupPeriod" server scripts client/src`

| Site | Computation | Differs from nfl.week how |
|---|---|---|
| trade-engine.js:180-184 `tradeWeekContext` | `NFL_WEEK` ‖ `MIN(week)` unscored ‖ 1, clamp 1..18 | no stalled-sync cross-check: a week whose scores never arrived stays "current" |
| weekly-learning.js:345-399 `currentNflWeek` | same query + schedule cross-check (>50% of the week's games unscored 6 h past kickoff → schedule week) | this is the good copy; now `week.js#nflWeek` |
| league-week.js:12-21 `leagueCurrentWeek` | `current_week` column ‖ payload `status.currentMatchupPeriod` ‖ currentNflWeek | payload tier reads a pre-draft fallback's **last-season** payload (period 17) |
| season-sim.js:190-198 `simStartWeek` | payload-season guard → explicit → leagueCurrentWeek | a consumer; its week-1 guard is about last season's scored weeks, kept |
| nfl-live.js:111, nfl-espn-line-watch.js:122/:138-142 | first unscored week (`ORDER BY week LIMIT 1`) ‖ 1 | same gap as trade-engine; nfl-live also ignores `NFL_WEEK` |
| book-feeds-extra.js:196-199 | `NFL_WEEK` ‖ currentNflWeek | equal to nfl.week already (currentNflWeek honours `NFL_WEEK`) |

Verdict: **build** `server/services/week.js`, move every computation into it (the
old ones as the flag-off branch), and make each site a one-line reader.

## 2. RED — `5fff8448`

`test/broken-d-one-week.test.js`, fixture: weeks 1-2 scored, week 3 kicked off 3
days ago with no scores (stalled sync), week 4 next weekend; a synced league with
`current_week=4`; a fallen-back league (`payload_season=2025`, payload period 17).

```
ok 1 - control: the fixture really is a stalled sync (score week 3, schedule week 4)
ok 2 - flag off: every caller keeps its old answer (the row-D disagreement, pinned)
not ok 3 - flag on: trade engine, NFL week and league week read one nfl.week / league.week
    (tradeWeekContext() { season: 2026, week: 3 } vs nfl.week 4)
not ok 4 - flag on: the NFL scoreboard and line-watch weeks are nfl.week   (week.js absent)
ok 5 - NFL_WEEK still pins every NFL-week reader, flag on or off
not ok 6 - ratchet (nfl_week_env): book-feeds-extra, nfl-espn-line-watch, trade-engine, weekly-learning
not ok 7 - ratchet (unscored_week_query): nfl-espn-line-watch, nfl-live, trade-engine, weekly-learning
not ok 8 - ratchet (schedule_week): weekly-learning
not ok 9 - ratchet (currentMatchupPeriod): league-week.js beside routes/leagues.js
# pass 3  # fail 6
```

## 3. GREEN

```
ok 1 … ok 9
# pass 9  # fail 0
```

## 4. What each field means now

- `nfl.week` = `week.js#nflWeek(season)`: `NFL_WEEK`, else the first unscored
  week, else the schedule week when that week looks stalled. Unclamped.
- `league.week` = `week.js#leagueWeek(lg)`: ESPN matchup period (column, then
  this season's payload), else nfl.week clamped 1..18.
- They legitimately differ on Tuesday/Wednesday (ESPN advances its matchup period
  after Monday night processing) and in multi-week playoff matchups. The trade
  engine has no league argument and reads nfl.week; the sim reads league.week.

## 5. Liveness: mutation sweep (each mutant applied alone, then restored)

| Mutant | Where | Result |
|---|---|---|
| M1 league.week keeps last-season payload under flag (`otherSeason = false`) | week.js#leagueWeek | killed: test 3 (`leagueCurrentWeek(fellBack)` 17 ≠ 4) |
| M2 fantasyWeek flag-on branch deleted | week.js#fantasyWeek | killed: test 3 |
| M3 scoreboardWeek flag-on branch deleted | week.js#scoreboardWeek | killed: test 4 |
| M4 lineWatchWeek flag-on branch deleted | week.js#lineWatchWeek | killed: test 4 |
| M5 not-applied control: flag ignored, new path always | week.js#fantasyWeek | killed: test 2 (flag off must keep week 3) |
| M6 nfl.week stalled-sync cross-check removed | week.js#nflWeek | killed: tests 1-4 |
| M7 call site: `tradeWeekContext` passes `SEASON - 1` | trade-engine.js#tradeWeekContext | killed: tests 2, 3 |
| M7s designed survivor: `SCORE_GRACE_HOURS` 6 → 12 | week.js | survived, as designed: the fixture's week 3 is 3 days overdue, so any grace under 72 h gives the same answer |

## 6. Full suite

`npm test` on this tree: tests 4837, pass 4794, fail 0, skipped 43.

## Local run (FIX-283-1, 2026-09-24 05:0x EDT)
The PR's LOCAL command on a `.backup` copy of the local DB, head `7f4a5c6e`, tree `d3262ab6`. Preview 0 and 1 printed the same numbers:

| league id | season / payload_season | current_week | league.week | sim_start |
|---|---|---|---|---|
| 1-5 (all) | 2026 / 2026 | 3 | 3 | 3 |

- nfl.week 3: score-derived 3, schedule-derived 3, stalled-sync flag false. tradeWeekContext 3.
- Disagreement on the live copy: none. The fixture's row-D split (3 vs 4, and 17 for a league that fell back) does not happen on today's data. Scores are current, it is Thursday of week 3 before kickoff, and no league holds another season's payload. So the flag changes nothing live today. It is a guard for a stalled sync or a pre-draft fallback, which is what caused row D.
