---
name: gridiron-game-script-does-not-forecast-snaps
description: Pre-game spread adds nothing to rushing participation forecasting (both CIs contain zero) — and a multiplicative level correction fitted to means makes an MAE score worse.
metadata:
  type: project
---

Measured 2026-09-22, free nflverse data. Spec `GAMESCRIPT-SPEC.md`, scripts
`gs-build.mjs` / `gs-test.mjs`. Layered on top of package #14's best model, so
this is INCREMENTAL value. n = 11,355 player-weeks, eval 2024-2025 (two seasons
consumed by the fit), paired bootstrap clustered on player.

**NEGATIVE, and it closes the guess made in `RUSHSNAP-SPEC.md`.**
- on-field rush plays: −0.0036 [−0.0097, +0.0019] indistinguishable
- carries: +0.0003 [−0.0020, +0.0025] indistinguishable

Bucket multipliers, level removed, are flat and NON-MONOTONE: 1.0369 (≤ −7),
0.9850, 1.0159, 0.9825, 1.0229, 0.9737 (> +7). Big underdogs and big favourites
both ≈1.0. There is no dose-response to find.

**Game script matters to what HAPPENS and does not help you PREDICT it.** A
team actually ahead in the fourth quarter does run more; a Wednesday spread
does not tell you that.

## TWO METHOD LESSONS, both from getting it wrong first

**1. Read the fitted parameters, not the headline metric.** My first run said
"game script makes it WORSE, +0.0414 [+0.0157, +0.0763], significant" — a more
interesting headline and completely wrong. The raw bucket ratios were all
≈1.18 and barely varied, which is a LEVEL BIAS, not a spread signal: the injury
multiplier `P(play|status)` is applied to every player including the ~88% with
no report, scaling every prediction down ~0.88, and the bucket fit was quietly
correcting it back up. I was testing a recalibration wearing a game-script
label. Six numbers clustered inside 0.07 of each other in no order is the tell.

**2. A multiplicative bias correction fitted to match MEANS degrades an
ABSOLUTE-ERROR score.** Multiplying every prediction by 1.1838 made MAE worse
(5.0125 against 4.9715 on plays; 1.0212 against 0.9959 on carries). MAE rewards
the conditional MEDIAN, and this distribution is spiky at zero because 17% of
rows are absences. Fixing the mean moves the prediction away from the median
for everyone who plays a normal week.

**Still unclaimed on the rushing side, in order worth trying:** committee split
(a coaching-staff property, not a game property); in-game injury and ejection
(unknowable pre-game, so genuinely part of the unreachable ceiling); realised
game state rather than expected.

**The game TOTAL is dead too**, tested separately on the same rows: plays
+0.0061 [−0.0017, +0.0089], carries +0.0008 [−0.0008, +0.0028], both
indistinguishable, multipliers 1.0290 / 0.9930 / 0.9619 / 1.0250 / 0.9612 —
flat, non-monotone, lowest in the middle. **Both market lines are now closed as
participation signals.** Coarse buckets remain the one functional-form caveat.

Related: [[gridiron-injury-report-forecasts-snaps-2026-09-22]],
[[gridiron-participation-not-target-rate-2026-09-22]].
