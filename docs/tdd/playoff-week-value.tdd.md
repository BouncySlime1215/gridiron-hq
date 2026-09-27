# PLAYOFF-WEEK VALUE (plan item 28): TDD record

<!-- prereg: docs/tdd/PLAYOFF-WEEK-VALUE-PREREG.md -->

Pre-registration: `docs/tdd/PLAYOFF-WEEK-VALUE-PREREG.md`, committed with the tests in the
RED commit, before any implementation was committed.

## RED

`test/playoff-week-value.test.js` against the tree without `server/services/campaign/playoff-week.js`:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/services/campaign/playoff-week.js'
not ok 1 - test/playoff-week-value.test.js
# tests 1  # pass 0  # fail 1
```

## GREEN

- `server/services/campaign/playoff-week.js`: flag, rule, pass bar, `defenseRatios`
  (same-season DvP, matchups.js method, K 200), `playoffWeekRows` (the world's expected points
  on the league's own playoff weeks x (mult - 1)), `tieBreak` (logged, `applied: false`),
  `playoffWeekSummary`, `gradePlayoffWeek`.
- `server/services/campaign/playoff-week-inputs.js`: the one reader of `player_week_usage`
  for the block and the grader.
- `scripts/campaign/league-adapter.mjs`: `adapter.playoffWeek` only with the flag on.
- `scripts/campaign/produce-plans.mjs`: `_run.inputs.playoff_week`, read after planning.
- `scripts/rnd/playoff-week-grade.mjs`: the grade on the local tables.

`node --test test/playoff-week-value.test.js`: 15 pass, 0 fail.

## What the tests prove (made-up league: 32 teams x 7 players, weeks 1-17)

| check | result |
|---|---|
| T1 planted effect recovered | corr(true, read) > 0.8 on WR; reads shrink toward 1 with fewer games |
| T2 power | effect 0.35, noise 0.15: PASS; MAE change 2023 -0.151 [-0.167, -0.135], 2024 -0.136 [-0.151, -0.121], 2025 -0.141 [-0.154, -0.128], 672 player-weeks each |
| T2 no false pass | effect 0: FAIL (P1: 2025 CI [-0.0072, +0.0011]; P2: 2023 +0.0028) |
| T2 P3 | 63 player-weeks: FAIL on P3 |
| T2 as-of | changing weeks 13-14 changes nothing in the grade |
| T3 rows | playoff weeks, byes, no-read weeks explicit |
| T4 tiebreak | only inside the 1-SE band; served targets untouched |
| T5 off is off | no hook, no key; flag on adds only `_run.inputs.playoff_week`; a failed read is status `error` |

These prove the arithmetic and the grader's power on synthetic data. They say nothing about
real defenses; that is the local grade:

`SCHEDULER_DISABLED=1 node scripts/rnd/playoff-week-grade.mjs --seasons 2023,2024,2025 --as-of 13`
