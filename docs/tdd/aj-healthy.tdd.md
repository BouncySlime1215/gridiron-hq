# AJ-HEALTHY: "a consistent weekly scorer now", measured

RED `27ba9a71` · GREEN follows · `test/aj-healthy.test.js`, 13 cases.

## The rule

Nick, 2026-09-24 (ONE-PLAN 10b.3): A.J. Brown (277) moves only if the return is
a Blue chip who is a CONSISTENT weekly scorer now (high floor, low week-to-week
variance, healthy, established role), not a boom/bust or future piece. Until
this unit, nothing measured "consistent", so `never-give.js#ajMayMove` returned
false and 277 was pinned everywhere.

## Pre-registered metric (`CONSISTENT_NOW`, consistent-now-v1, 2026-09-25)

Written before any real data was read. At the league's current week N, over the
last 4 completed weeks (N-4 .. N-1; week N is never read), all must hold:

| condition | bar | source |
|---|---|---|
| games | >= 3 played | nfl_ffopportunity_weekly |
| established role | mean expected points >= position floor | expected_fantasy_points |
| floor | >= 75% of games at or above the position floor | actual_fantasy_points (PPR) |
| variance | sd / mean <= 0.40 | actual_fantasy_points |
| healthy | this week's report reads healthy (unknown fails) | love-inputs.js injury read |

Position floors (PPR): QB 15, RB 10, WR 10, TE 8. Any other position fails.

## Pre-registered pass bar (`gradeConsistency`)

Backtest over completed seasons, every player-week N with a full forward window.
Eligible: games, role and position pass. Flagged: also floor and variance pass.
Comparison: eligible and not flagged. Outcome: share of weeks N .. N+3 at or
above the floor. PASS needs all of:

- flagged player-weeks >= 200, comparison >= 50;
- flagged forward floor share >= 0.70;
- flagged minus comparison >= +0.10;
- player-clustered bootstrap 95% CI of that difference above 0 (1,000 draws, seed 1).

What fails it: any one of those. On FAIL the flag stays off and 277 stays locked.
The backtest grades the scoring part only; the healthy condition reuses the
already-served week-N injury read.

## Flag

`GRIDIRON_AJ_HEALTHY=1` hands the check to `ruleGate`'s `consistentOf`. Anything
else, including `GRIDIRON_PREVIEW_UNCONFIRMED=1`, leaves 277 pinned exactly as
before (test 7 and 12). No current week, or a failed read, leaves 277 locked and
says so in `rules.consistency` (`rules.sources` is unchanged) without closing the rest of the gate.

The War Room planner still pins 277 (`withNeverGive`, `NEVER_DEPTH`) with the
flag on: this unit only wires the gate. Unpinning in-search is a follow-up once
the grade passes.

## Measured on the made-up fixture (before -> after)

Gets offered for 277, all Blue chips on the served board unless noted:

| get | flag off | flag on |
|---|---|---|
| 301 steady (18/16/20/17) | never_give | allowed |
| 302 boom/bust (35/3/28/4) | never_give | never_give |
| 303 steady, scored 80 | never_give | never_give + below_blue_chip |
| 304 steady, Out this week | never_give | never_give |
| 305 steady, two games | never_give | never_give |

160 and 80 stay never_give with the flag on (test 9).
