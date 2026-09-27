---
name: gridiron-yards-per-34-stands-2026-09-22
description: K.yards_per=34 STANDS — packages #8 and #11 recommending a larger value are withdrawn; on the repo's own weekly MAE every larger k is worse.
metadata:
  type: project
---

2026-09-22, package #18 (`/mnt/project-files/A6-RECONCILE-SPEC.md`). Banners
added to `EFFICIENCY-K-SPEC.md` (#8) and `KWALK-SPEC.md` (#11).

**Do not raise `K.yards_per` (projections.js:97). `projections.js:88-92` was
right.** On the repo's own weekly MAE via `replaySeasonWeekly`, held out:

    2024 (k=34 -> 4.757):  k=26 -0.0030 [-0.0040,-0.0017] better
                           k=50 +0.0040   k=70 +0.0080   k=100 +0.0130
                           k=150 +0.0180  k=200 +0.0210  ALL worse, CIs exclude 0

2023 identical in shape and sign. Spearman degrades monotonically as k rises.

**Why #8/#11 were wrong:** both scored **yards MAE at the player's actual
opportunities**, to isolate the rate from volume. The proxy and the real metric
**disagree in sign**. The real model forecasts volume and multiplies it by the
shrunk rate, so raising k stacks a second regression on an already heavily
regressed volume term. **A proxy that is honest about not being the real metric
is still not evidence about it when the signs differ** — that is the lesson,
and it generalises past this constant.

**The repo's own fitter** (run on the rig) puts efficiency k at ypt WR 168-209,
TE 129-139, RB 343-376, ypc RB 197-288, ypa QB 310-334 — i.e. squarely in the
region measured as harmful. The repo's recorded 4.773-vs-4.749 rejection
reproduces independently.

**Live defect, unrelated to the constant:** `shrinkage-fit.js:323` builds
`effW = efficiencyWeightFor(through)` and **never passes it** (`grep -n effW`
returns one line). So efficiency specs at `:355-373` are fit with every season
weighted equally, violating the invariant the same file states at `:60-67`.
The volume side was fixed to satisfy it; the efficiency side was not. Applying
the required decay moves the fitted k to 40.62/32.92/35.62 — near the 34 in the
file. **Worth a small correctness unit; it changes no shipped number**, because
the efficiency k is not applied in production.

Related: [[gridiron-offline-measuring-rig-2026-09-22]],
[[gridiron-k-yards-per-too-small]].
