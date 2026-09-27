---
name: a-low-projection-is-an-accidental-availability-hedge
description: A model with no availability term can be flattered by a downward bias; fixing the bias makes a DNP-inclusive metric look worse without the model getting worse.
metadata:
  type: project
---

Measured 2026-09-22 on the target-share prior unit (Gridiron HQ). The legacy
single `0.06` target-share prior under-projected every pass-catcher: mean
signed error **−0.9764** targets on weeks played. Replacing it with each
position's measured mean cut that to −0.3165 and won **+0.1044** MAE on the
conditional metric — but on the repository's availability-inclusive metric
(`decision_including_dnp`, `weekly-backtest.js:170`, a missed week scores a
real 0) the same change is a **null**: −0.0136, 90% CI [−0.0499, +0.0225].

**Why:** a projection that is systematically too low is an accidental hedge
against the weeks a player does not play at all. Remove the bias and the
DNP-inclusive metric charges for it — the fitted arm's level flipped to
+0.2486. Nothing got worse; a missing availability term stopped being masked.

**How to apply:** never read a DNP-inclusive regression as evidence against a
bias fix without the level/information split. `MSE = ME² + Var(error)`, and
"de-biased MAE" (score each arm after removing its own mean error) separates
them. Here the fitted arm won de-biased on *both* metrics (+0.1273 and
+0.0482, both significant), which is what says the prior carries information.
Report signed error beside MAE on every arm whenever a change moves a level —
a prior, a shrinkage target, a calibration — because a MAE gain alone cannot
tell a level shift from something learned. See
[[mae-optimal-is-a-median-statistic]] and
[[a-recovery-fraction-needs-both-denominators]].
