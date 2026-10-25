---
name: gridiron-mae-optimum-is-the-weighted-median
description: Measured rule — the MAE-optimal multiplier on any prediction is the prediction-weighted median of actual/prediction over all rows, zeros included; reproduces grid-searched optima to 0.002.
metadata:
  type: project
---

Measured 2026-09-22, Unit A (record
`/mnt/project-files/UNIT-A-LEVEL-MECHANISM-2026-09-22.md`, scripts `unitA.mjs`,
`unitA2.mjs`, `meanp.mjs`). Rig, not production.

**The rule, no free parameters:** the multiplier that minimises MAE is the
**prediction-weighted median of `actual / prediction` over ALL rows, absences
included**. Equivalently, the played distribution's quantile at
`q = (0.5 - w0)/(1 - w0)` where `w0` is the zeros' share of **prediction mass**
(not of rows — the row-share version reads visibly low: 0.697 vs 0.742).

**Verified on two instruments whose optima fall on opposite sides of 1**, each
to within 0.002: repo model on the rig, decision rows (predicted 0.742/0.478/0
vs measured 0.740/0.480/0) and the #14 carries baseline (predicted 1.087 vs
measured 1.085).

**The wedge, and why "fix the bias" is the wrong instinct
([[mae-punishes-a-mean-matching-bias-correction]]):** on rows where the player
PLAYED — availability removed by construction — calibration asks for +4.6%
(mean(actual)/mean(pred) = 1.0464) and MAE asks for -8.5% (optimum 0.915).
13 points apart on the same rows. A sub-1 MAE optimum is the score
distribution's right skew, NOT an availability term.

**Refuted here, do not repeat:** Plan 05's `p < m* < 1`. Measured `m*` is BELOW
`P(played)` in both live buckets (0.740 vs 0.7895; 0.480 vs 0.6570). Two forces
push the optimum down (absence mass at zero, and skew); nothing pushes it up.
Also refuted: that the 1.0548 committee factor equals `1/mean(p_i)` — measured
1.2198, moving away, and the restricted eval set is absent MORE often (19.88%)
than the whole population (18.63%), the opposite of Plan 05's premise.
`f = den0/den` is referenced to `p_none`, never to 1, so it was never that
quantity. 1.0302 ratio-of-means vs 1.0548 mean-of-ratios is Jensen.

**Correction to my own record:** "#14 under-scaled by about 5%" understates it.
1.0548 was the committee factor's mean borrowed as a control, never a fitted
optimum. Measured optimum 1.085 (8.5% under MAE), mean-matching 1.2485 (24.9%).

**BINDING (Auditor, Unit A ruling): which side of 1 the optimum falls on is a
property of the BASELINE and carries NO information about availability.** Proof
is in the two instruments above. Related standing principle, recurring defect
#6: any MAE-optimal quantity is a MEDIAN-type statistic, so deriving one from a
mean or variance decomposition is a category error, not an approximation.

**No build follows.** Fitted `m*` is indistinguishable from `P(played)` out of
sample both seasons; both beat the boolean switch. [[gridiron-graded-availability-clears-2026-09-22]]

**UNADJUSTED-rig baselines (Auditor condition A):** 2023 conditional
4.622 / n 4,306, decision 5.152 / n 4,443; 2024 conditional 4.757 / n 4,343,
decision 5.261 / n 4,471. 2024's 4.757 vs the repo's recorded 4.921 is 3.3%
low, which is ONE calibration point, so Condition A stays directions-only.
**NAMING RULE, binding: "unadjusted rig" (4.757) and "absence-augmented rig"
(4.514). The word "fixed" is BANNED on this instrument** — it was a collision
with audit-unit-11's use of it, not a disagreement about numbers. My claim that
the audit record had them swapped is withdrawn; audit-units-12-13-14:30 had the
same numbers and direction. [[gridiron-offline-measuring-rig-2026-09-22]]
