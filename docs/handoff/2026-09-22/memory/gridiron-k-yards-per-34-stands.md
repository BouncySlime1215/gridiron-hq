---
name: gridiron-k-yards-per-34-stands
description: K.yards_per = 34 STANDS (2026-09-22). Packages #8 and #11 (raise it to 100-200) are WITHDRAWN by their own author; on the repo's own metric every larger k is monotonically worse.
metadata:
  type: project
---

**Do not reopen this without new evidence on the repo's own weekly MAE.**

Measured on the repository's own replay (`replaySeasonWeekly`) **on the rig**
(see [[gridiron-offline-rig-evidence-line]] — rig, not production), 2024, k=34 →
4.757:

    k= 26  delta -0.0030 [-0.0040,-0.0017]  better
    k= 50  +0.0040   k= 70  +0.0080   k=100 +0.0130
    k=150  +0.0180   k=200 +0.0210 [0.0137,0.0299]  all WORSE

2023 same shape and signs; Spearman degrades monotonically. n = 4,306 and 4,343
graded player-weeks, 2,000 bootstrap iterations grouped on player, seed 20260922.

**`projections.js:88-92` was right.** The repo's own fitter on the rig gives
efficiency k of 129-376, inside the region measured as harmful, so its recorded
rejection reproduces independently in DIRECTION (not in size — that comparison
was struck).

**Why the earlier packages got it backwards:** they scored yards MAE at the
player's *actual* opportunities, holding volume fixed. The real model forecasts
volume and multiplies by the shrunk rate, so raising k stacks a second regression
on an already-regressed volume term. **A proxy that is honest about not being the
real metric is still not evidence about it when the two disagree in sign.**

**k=26 is NOT adoptable** even though its interval excludes zero: **26 is the
boundary of the grid** and the curve is monotone from it upward. A trend running
into the edge of a search space says the grid is mis-centred, not that the edge is
the optimum — no interior minimum has been demonstrated. Magnitude is 0.063%,
read through an instrument whose one magnitude calibration is off 3-5×. To pursue
it: extend the grid to 20/15/10/6/3 and find an INTERIOR minimum. Know in advance
that a continued boundary result means "do not shrink efficiency at all" — a claim
about the shrinkage design, not a constant tweak.

**Open, and the clean test is one run:** the effW-corrected fitter ON THE RIG.
The corrected fitter gives 33-41 on free data, which sits ABOVE the real-metric
optimum of ≤26, so `:88-92`'s stated mechanism (inflated σ²b → k too small) is
contradicted in direction. An earlier auditor ruling that it was "no longer
contradicted" is WITHDRAWN. See [[gridiron-effw-never-wired-efficiency-fits]].

Record: /mnt/project-files/audit-unit-9-the-rig-and-k34-reversal-2026-09-22.md
