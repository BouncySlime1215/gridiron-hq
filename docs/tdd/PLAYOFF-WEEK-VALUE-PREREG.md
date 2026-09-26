# PLAYOFF-WEEK VALUE (plan item 28) pre-registration

Written 2026-09-26, before the code or any result exists.

Item 28 asks for "weeks 15-17 matchup strength (from our 2026 data, research R6 as a
tiebreaker) in the title sim's player value". The history matters, so it is stated first:

- `server/services/matchups.js` MATCHUP_EVIDENCE (tested 2026-09-17): defense-vs-position
  (DvP, K 200) did not make the weekly projection more accurate on held-out 2025
  (MAE change +0.0007, 90% CI [-0.0021, +0.0035]); every matchup multiplier is held at 1.
- The same header: a DvP read built early in the season correlates r ~ 0.01 with the weeks
  15-17 outcome. ONE-PLAN kills forward schedule strength (TM-12) and the playoff-week
  specialist (TM-19) on the R6 schedule-swing result.

So the prior is that this fails. It is built so that the one question left open (does a
SAME-SEASON read, taken at the trade deadline, say anything about that season's playoff
weeks?) gets a clean answer, and so that nothing served can move while it is unanswered.

## What is built

1. `server/services/campaign/playoff-week.js` (pure):
   - `defenseRatios(lines)`: per (defense, position) the shrunk ratio of points allowed to
     each player's own leave-one-out baseline, from ONE season's lines strictly before the
     as-of week. Same method and constants as `matchups.js#computeDvp` (floors QB 6 / RB 4 /
     WR 4 / TE 3, K = 200, the value fitted there), with every game weighted 1 (one season).
   - `playoffWeekRows(...)`: for each player asked about and each of the league's own playoff
     weeks, the opponent (the repaired 2026 slate, `matchupModel().schedule`), the world's
     expected points that week (season-sim `weekData.expected`, the one producer of a
     player's weekly points) and `delta = expected x (mult - 1)`. Summed: `delta_pts`.
   - `tieBreak(targets, rows)`: R6 as a tiebreaker only. Among the served targets whose
     `gain_if_landed` sits within 1 combined SE of the top one, which one the playoff-week
     delta would put first, and whether that differs from the served top. Logged, never applied.
   - `gradePlayoffWeek(bySeason, opts)`: the grade below.
2. `server/services/campaign/playoff-week-inputs.js`: one reader of `player_week_usage`
   (scored with the league's scoring, `scoring.js#scoreLine`), used by both the shadow block
   and the grader, so the graded read is the served read. A missing table is `table_absent`.
3. Producer wiring: `scripts/campaign/league-adapter.mjs` exposes the read and the base
   world; `scripts/campaign/produce-plans.mjs` writes `_run.inputs.playoff_week` after
   planning (ids only). Nothing served reads it.
4. `scripts/rnd/playoff-week-grade.mjs`: the grade on the local nflverse tables.

## Flag

`GRIDIRON_PLAYOFF_WEEK_VALUE`: unset / `0` = off (plans.json byte-identical to before);
`shadow` or `1` = the block is computed and written. Preview mode never turns it on. There is
no served mode in this PR: no multiplier enters `season-sim.js#weekPool`, no target is
reordered, `matchups.js` switches stay false.

## Pass bar (fixed here; K, floors and weeks are not swept)

The grade, per season S in {2023, 2024, 2025}, as-of week A = 13 (league 4's deadline week is
12-13; the decision this would inform is taken there):

- Read: every QB/RB/WR/TE line of season S, PPR (`scoreLine`, `PPR`).
- Ratios: `defenseRatios` on season S weeks < A only.
- Baseline forecast for a player in week w of {15, 16, 17}: his mean points over his games in
  season S weeks < A (at least 4 games). Adjusted forecast: baseline x mult(opponent of w,
  position). Graded on the player-weeks he actually played (a line exists).
- Metric: MAE change, adjusted minus baseline (negative = better), paired bootstrap
  clustered by player (`backtest-significance.js#pairedBootstrapDiff`, 2,000 iterations,
  seed 1), 90% CI.

PASS needs all of:

- **P1 held-out.** 2025: the 90% CI lies entirely below 0.
- **P2 no reversal.** 2023 and 2024: mean MAE change <= 0.
- **P3 power.** At least 300 graded player-weeks in each season.

What would fail it: any of P1-P3. If it fails, the flag stays shadow, the tiebreak stays
logged-only, and item 28 is closed as tested-not-supported (the same verdict as
MATCHUP_EVIDENCE, now for the same-season deadline read).

A pass would only license a follow-up PR that uses the delta as a TIEBREAKER on the served
target order (R6), with its own bar; it would not license a multiplier inside the title sim
(that needs the matchups.js weekly walk-forward test re-run, per its header).

## Proven here without real data (tests)

- T1 the ratios reproduce a planted defense effect on synthetic lines and shrink toward 1
  with few games; a player with one useful game contributes to no ratio.
- T2 the grader PASSES a synthetic league with a real defense effect (power) and does NOT
  pass one with none (no false pass on noise).
- T3 playoff-week rows read the world's expected points and the league's own playoff weeks;
  a bye week is a row with `bye: true` and no delta; no read means mult 1 and is counted.
- T4 the tiebreak only looks inside the SE band and never changes the served order.
- T5 off is off: flag unset, the adapter has no hook and plans.json has no `playoff_week`.
- T6 the block carries ids only (no names) and says `shadow` and `ungraded`.

## Needs local measurement

```
SCHEDULER_DISABLED=1 node scripts/rnd/playoff-week-grade.mjs --seasons 2023,2024,2025 --as-of 13
SCHEDULER_DISABLED=1 GRIDIRON_PLAYOFF_WEEK_VALUE=shadow node scripts/campaign/produce-plans.mjs --leagues 4
```
