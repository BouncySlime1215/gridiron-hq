# U1b RB-SE: pre-registration

Committed before measuring. Stacked on #472 (U1: title SE fields), which is not merged yet.

## Problem (measured in U1, docs/tdd/2026-09-25-u1-rb-title-on.tdd.md)

`rb-title.js#meanInterval` treats each run's conditional title probability as independent.
Each run's probability comes from the same pooled playoff-week scores, and that pool's error is
shared, so the reported SE runs 1.0x (4-team brackets) to 2.75x (8-team) too small.

## Change

Independent-batch SE. Split the runs into B = 20 contiguous batches. Each batch builds its OWN
playoff-week score pool from its own runs only and computes every run's conditional title
probability from it. SE = sd(batch means) / sqrt(B). The served mean is unchanged (full pool).
Paired deltas: the per-batch difference of the two arms (same runs, same batches), same formula.
The SE flows into `title_delta_se`, `title_delta_clears_noise` (clears 2 SE), `title_before_se`,
the served 95% interval, and through `paths.js#pathExpectation`'s `expected_se` into
`confirm.js#confirmVerdict`'s holds/shrank split. Flag off: nothing changes.

Why batches and not a bootstrap: a bootstrap redoes the full bracket integration for every
resample (B full passes); batches cost one extra pass over the runs, on pools 20x smaller.

## Bars

1. **Bar 3 (as set by the coordinator):** 20 fuzz leagues (same generator and seeds as U1),
   RB at 1,200 runs vs plain MC at 20,000 runs, `z = (rb - plain) / sqrt(se_rb^2 + se_plain^2)`.
   Levels and deltas each: 0/20 past 2 SE and pooled |z| < 2.
   Stated up front: with a correct SE about 1 in 20 lands past 2 SE by chance (P(0 of 20) is
   about 0.36-0.40), so the calibrated reading U1 pre-registered (at most 3/20) is reported
   beside it. Both are reported; the coordinator's is the gate.
2. **Coverage:** 30 independent replicates of 1,200 runs on fuzz leagues 4, 12, 18, 8:
   true sd / mean reported SE within [0.8, 1.25] for levels and deltas (U1 before: up to 2.75).
3. **League 4 reference:** plain MC over 20,000 runs (10 independent seeds x 2,000) for Nick's
   title level and the deltas of 12 single-player deals; RB (1,200 runs, batch SE) within 2 SE
   on the level and on at least 11 of 12 deltas.
4. **Runtime:** the flag-on league-4 producer run within 1.5x the flag-off run (same copy, no cache).
5. **No rule violations:** RULE-FUZZ, rules-everywhere league 4.

If 1-5 hold, recommend `GRIDIRON_RB_TITLE=1`.
