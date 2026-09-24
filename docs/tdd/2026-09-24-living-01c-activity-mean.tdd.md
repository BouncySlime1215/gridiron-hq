# LIVING-01c — activity-adjusted team mean in the season sim (TDD record)

Source: R&D r25 IDEA-046, CONFIRMED (`rnd/loop/r25-IDEA-046.md` on the Mac). The
activity-adjusted team mean beat the frozen-roster sim (playoff Brier +0.0039, weeks
10-14 points MSE +31.6); the full checkout sim added only +0.0008 Brier. This unit
builds only the adjusted mean.

## What changed

- `server/services/activity-team-mean.js` (new): flag `GRIDIRON_ACTIVITY_MEAN=1` or
  preview mode; fitted coefficients `ACTIVITY_MEAN_FIT`; `activityShifts` (pure) and
  `activityMeanFor` (reads `managerSignalsFor`, the existing producer of
  `tx_adds_per_week` and `lineup_dead_starts_last_week`).
- `server/services/season-sim.js#simulateSeason`: one shift per team added to every
  simulated week (regular season and bracket), so it feeds `title_odds`. Draws are
  untouched (common random numbers). Payload gains `activity_mean` only when on.
- `server/routes/model.js` `/simulate`: memo key carries the switch.
- `scripts/rnd/living01c-fit.mjs`: fit 2021-22 Sleeper, grade 2023 and 2024 held out.
- No migration: coefficients live in code, inputs are existing `manager_signals` rows.

## RED

`test/living-01c-activity-mean.test.js` with the `server/` changes stashed (the new
module untracked, so still present): 5 tests, 2 pass (L1, L2 pure), 3 fail (L3, L4,
L5: `simulateSeason` has no `activityMean` option and no `activity_mean` payload).

## GREEN

Same file plus the neighbouring sim suites (`preview-mode`, `league-rules-bracket-sim`,
`b-01-real-record-odds`, `rl-6-3-trade-impact-paired`): 35 pass, 0 fail.

| id | pins |
|---|---|
| L1 | shifts league-centred on the two signals; clamp at the cap; missing value or too few weeks is a 0 term with the reason |
| L2 | unfitted coefficients: on but inert, reason in the payload |
| L3 | off (unset, or forced false with the env set) deep-equals the frozen sim; no `activity_mean` key |
| L4 | on: T2 (+3 adds/wk vs 1) gets +20/wk, T1 −4, and T2 takes the title the frozen sim gives T1 |
| L5 | the site flag and preview mode both turn it on; only preview labels `preview`/`preview_reason` |

## Fit script check (synthetic corpus, not evidence about real leagues)

A generated corpus with a planted forward effect (points rise 1.5 per cumulative add; a
persistent checkout state costs 12 points and shows dead starts): the script recovered
`per_add_per_week` +7.36 (SE 0.75) and `per_dead_start` −3.49 (SE 0.67), held-out MSE
delta +10.1 (2023) and +11.9 (2024). It only shows that the script runs end to end and
recovers the signs.

## Sweep fixes (FIX-273-1..3, 2026-09-24)

**FIX-273-2, title Brier.** The fit script now carries each run on into the league's
bracket (top N seeds, byes to the top seeds, fixed bracket, one week per round) and
grades `team_seasons.champion`, beside playoff Brier, on 2023 and 2024 separately with
the same league bootstrap. The bracket has its own random stream, so the playoff Brier
numbers are unchanged from the earlier run (checked: identical to 4 dp).

**FIX-273-1, the corpus run** (`--runs 2000`, local Mac):

| | 2023 held out (474 leagues) | 2024 held out (471 leagues) |
|---|---|---|
| playoff Brier delta, 90% | +0.0011 [+0.0003, +0.0018] | +0.0005 [−0.0004, +0.0013] |
| title Brier delta, 90% | +0.0009 [+0.0005, +0.0013] | +0.0001 [−0.0003, +0.0006] |
| points MSE w10-14 delta, 90% | +6.0 [+3.9, +8.3] | +16.9 [+7.8, +28.8] |

Fit (2021-22): per_add_per_week +2.490 (SE 0.140), per_dead_start −1.012 (SE 0.153).
Gate: both held-out playoff Brier intervals must clear 0. 2024's does not, so the null
is recorded in `ACTIVITY_MEAN_FIT.gate` and the coefficients stay out (`fitted: false`,
inert even with the flag on; the payload reason says the gate did not pass).

**FIX-273-3, dead-start definition.** `manager-signals.js` now also emits
`lineup_dead_starts_at_lock_last_week` (the spec's: a final-lineup starter on bye or with
an Out tag at lineup lock), beside `lineup_dead_starts_last_week` (did not play: no snaps).
`ACTIVITY_MEAN_FIT.dead_start_metric` picks the input; it is the did-not-play one, because
the corpus's `dead_starts` is "a started player with no stat row" and the coefficients were
fitted on that. The corpus has no lock-time tags, so the at-lock definition cannot be fitted.

| id | pins |
|---|---|
| L6 | fixture where they differ (surprise inactive: snaps only; DEF on bye: at lock only): counts [1,1,0,1] vs [0,1,1,1], shifts differ, shipped fit reads did-not-play, payload names it. RED on the old manager-signals.js |
| L7 | the shipped fit records the gate; `fitted` iff both intervals clear 0; failed means inert with that reason |

## Open

A forward check on the synced leagues; a fit that clears 2024 (more seasons, or a
different window) before the coefficients go in.
