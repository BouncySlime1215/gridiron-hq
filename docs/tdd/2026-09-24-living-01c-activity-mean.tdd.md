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

## Open

The real coefficients and the 2023-24 held-out numbers come from the corpus run on the
Mac (`LOCAL:` line in the PR). Until they are copied into `ACTIVITY_MEAN_FIT`, the shift
is inert even with the flag on.
