---
name: gridiron-graded-availability-clears-2026-09-22
description: The graded availability multiplier beats the boolean 'Out' switch on the repo's OWN model and metric, both held-out seasons, level control applied — the first R&D finding to clear the full gate.
metadata:
  type: project
---

Package #19, 2026-09-22. Record `/mnt/project-files/GRADED-AVAILABILITY-SPEC.md`;
scripts `add-absences.mjs`, `inj-on-rig.mjs`.

**THE CLAIM — graded vs the boolean `report_status !== 'Out'`
(`role-scenario-engine.js:127`), on the repo's own weekly MAE:**

    2023  -0.0180 [-0.0255, -0.0108]  BETTER   (n=4,443)
    2024  -0.0164 [-0.0223, -0.0107]  BETTER   (n=4,471)

CORRECTED same day. The first figures (-0.0635 / -0.0860) were measured on an
augmented rig and against `point.model.mae`; both were wrong. These are on the
production-faithful rig against `decision_including_dnp`. Script
`inj-decision.mjs`.

Fitted 2022, held out 2023-2024, `pairedBootstrapDiff` grouped on player.
`Questionable x0.8435` is the whole difference: the boolean treats a
Questionable player as fully available and he is not.

**LEVEL CONTROL IS MANDATORY HERE AND MY FIRST RUN LACKED IT.** Raw, the
`(none)` bucket is 0.6745, so applying the graded vector directly scales EVERY
row by 0.67 and inflates the gain ~4x. Normalise by the `(none)` bucket so an
unreported row is exactly 1.0. Flat control is worth only −0.055/−0.034; graded
beats flat by −0.224/−0.232. Same trap as
[[mae-punishes-a-mean-matching-bias-correction]].

**DO NOT quote the −0.18/−0.22 "zeroing an Out player" number as a finding.**
That is measured on the structural HEAD, and production applies a fitted
P(active) downstream (`scripts/promote-volume-shrinkage.mjs` header). How much
production already captures is untested.

**THE RIG NOW SEES ABSENCES — `add-absences.mjs`.** From the free
`weekly_rosters` release. Absent = on the roster that REG week with status
`ACT` or `INA` and no usage row; `DEV`/`RES`/`CUT`/`RET` excluded. Restricted
to players with >=1 usage row that season. 11,250 rows added (29,428 ->
40,678), zero-opportunity share 9.8% -> 34.4%.

**It made the rig markedly more faithful, which is why I trust it:** the repo's
recorded volume-k win (~0.35-0.46) reproduces at −0.3630 [−0.4246, −0.3004] and
−0.4090 [−0.4716, −0.3462] after the fix, versus −0.0740/−0.1490 before.
**Always run `add-absences.mjs` after `load-rig.mjs`.**

Package #18's k conclusion is unchanged under the fix. **Package #17's "does
not clear" verdict is withdrawn** — it ran on the blind rig.

Related: [[gridiron-offline-measuring-rig-2026-09-22]],
[[gridiron-injury-report-forecasts-snaps-2026-09-22]],
[[gridiron-committee-reallocation-real-2026-09-22]].
