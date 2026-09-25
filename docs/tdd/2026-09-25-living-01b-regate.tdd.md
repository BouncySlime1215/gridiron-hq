# LIVING-01b re-gate: a weekly graded test instead of "40 finished team-seasons"

Pre-registration, committed before any test or code (2026-09-25). Scope: the
coordinator comment on PR #261 (2026-09-25 01:21Z, decision from Nick). The old
gate, E3-live's `MIN_TEAM_SEASONS = 40` finished team-seasons, cannot pass
before the season ends: league_transactions_raw holds 2026 only (5 leagues,
46 team-seasons). This record replaces it for LIVING-01b / ACTIVITY-01 in the
sim. Nothing here moves a served number; the gate only reports.

## Where it runs

The one grader producer: `server/services/eval/index.js#runAll`, run by
`scripts/eval/run-graders.mjs` on the refresh loop and stored in `brain_report`.
One new grader, `server/services/eval/living-gate.js`, emits three rows:
`L01B-ACT`, `L01B-SIM`, `L01B-GATE`. No second producer.

## Part 1: ACTIVITY (grade from data already stored)

- **Unit.** One team-week (league, team, week w), every ESPN league with rows in
  league_transactions_raw, pooled. Graded weeks: covered by the collector
  (below), w <= the league's last completed scoring period, and at least 2
  covered history weeks before w.
- **Realised.** From league_transactions_raw, counted by manager-signals.js's
  own readers (no second counter): adds = ADD items on EXECUTED WAIVER /
  FREEAGENT rows; drops = DROP items on those rows; trades = completed trades
  (TRADE_ACCEPT / PROCESS / EXECUTED), one per party.
- **Coverage.** ESPN returns ~3 days of transactions, so weeks before the
  collector started are incomplete. First covered week per league = (lowest
  scoring period among the rows seen on the collector's first run) + 1.
  History for both arms is covered weeks only.
- **Baseline (B).** Each team's own trailing rate per stream, shrunk to the
  league rate: lambda_s = (own_s + 2 * league_rate_s) / (h + 2), floor 0.001.
  The shrink is ACTIVITY-01's own B0 (alpha = 2), so an empty history is not a
  zero rate.
- **Model (M).** B times ACTIVITY-01's (#334) activity multiplier for that
  team-week, exp(log_ratio) from `leagueActivityIntensity`, applied to all three
  streams. History passed as-of: weeks < w only.
- **Metrics.** Poisson log-loss summed over the 3 streams, mean per team-week
  (nats); Brier on "any move of stream s" (p = 1 - exp(-lambda_s)), mean over the
  3 streams. Delta = M - B, lower is better. 90% bootstrap CI clustered by team,
  seed 303, 1000 reps.
- **Week passes** when mean log-loss delta < 0 AND mean Brier delta < 0.
  Needs >= 20 graded team-weeks that week, else the week is not graded.

## Part 2: SIM (forward-only, recorded before the week)

- **Recorded.** Each tick, for each league, the week after the scoring period in
  progress (not started yet): each team's predicted starting-lineup points,
  static sim vs sim with league-mates acting, same seed and runs (paired), into
  `living_gate_sim_predictions` (migration 103). Write-once: a later tick cannot
  overwrite a recorded week.
- **Realised.** league_week_scores.points for that team-week, once the week is
  <= the league's last completed scoring period.
- **Metric.** Absolute error; delta = |living - realised| - |static - realised|,
  mean per team-week, 90% bootstrap CI clustered by team. MSE reported beside it.
- **Week passes** when mean delta < 0, with >= 20 graded team-weeks.

## The gate

- A part **passes** when its two latest graded weeks are consecutive week numbers
  and both pass.
- `L01B-GATE` is **passing** when both parts pass, **not_enough_data** while
  either part has fewer than 2 graded weeks, **failing** otherwise.
- Passing means: the coordinator may flip GRIDIRON_LIVING=1 after a local
  measurement. The grader flips nothing.

## What would fail it

- The gate row reads failing (either part's latest two weeks not both better).
- A leakage test: changing any row dated in week >= w must not change week w's
  predictions. If it does, the grade is invalid.
- The gate row reading passing with fewer than 2 graded weeks in either part.

## What is not decided here

- Point-estimate pass per week, not CI-excludes-zero: with ~46 team-weeks a week
  a CI rule would not clear before 12/02. Two consecutive weeks is the guard;
  the CIs are reported.
- Dead / empty starters are not passed to ACTIVITY-01 (its term is 0 and named in
  `missing`); the multiplier is weaker than the fitted model.

## Record

RED: tests first. GREEN: the grader, migration, recorder hook. Results under
"Measured" in the PR.
