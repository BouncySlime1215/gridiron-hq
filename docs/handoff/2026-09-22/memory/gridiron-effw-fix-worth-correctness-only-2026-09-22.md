---
name: gridiron-effw-fix-worth-correctness-only-2026-09-22
description: Fixing the dead effW removes ~90% of the harm from applying the efficiency fit but still does not beat the hardcoded constants — a correctness fix, not a performance win.
metadata:
  type: project
---

Package #22, 2026-09-22. Record `/mnt/project-files/EFFW-SPEC.md`, script
`effw-test.mjs`. Repo's own `fitK`, `replaySeasonWeekly`, `pairedBootstrapDiff`;
`shrinkage-fit.js` NOT edited.

**Repo weekly MAE, k fitted on seasons <= s-1:**

    2024 (hardcoded 4.7570)  RAW fit  4.8080  +0.0510 [0.0337, 0.0692] WORSE
                             EFFW     4.7580  +0.0010 [-0.0030, 0.0053] indist.
                             RAWx.307 4.7740  +0.0170 [0.0100, 0.0248] WORSE
    2023 (hardcoded 4.6220)  RAW      4.6630  +0.0410  EFFW 4.6370 +0.0150 WORSE

**The `effW` fix is a CORRECTNESS fix only.** It takes the efficiency fit from
clearly harmful to indistinguishable (2024) / mildly harmful (2023). It never
beats the hardcoded constants. **Do not gate it on weekly MAE improving — it
will not.** Gate: fitted efficiency k lands in **32-80**, not 130-380; the
efficiency metrics stay excluded from promotion; weekly MAE and Spearman
UNCHANGED (if they move, something is promoting a fit that should not be).

**CORRECTS PACKAGE #21's "multiply by 0.307" shortcut — it is NOT equivalent to
refitting.** True per-metric RAW->EFFW ratios (fit <= 2023) range 0.086 to 0.407:
ypt WR 209.1->35.5 (0.170), ypt RB 375.6->32.4 (0.086), ypt TE 139.1->40.7
(0.293), ypc RB 196.7->39.1 (0.199), ypa QB 310.1->66.7 (0.215). The scaled arm
performs measurably worse than the true refit. 0.307 is a correct population
average and a poor per-metric substitute.

**The efficiency constants are now measured from three directions and survive
all three:** #18 raising them is worse, #21 the documented unit is wrong by ~3x,
#22 even a correctly fitted k does not beat them.
[[gridiron-yards-per-34-stands-2026-09-22]],
[[gridiron-n-is-not-raw-opportunities-2026-09-22]]

**Limit:** `efficiencyObservations` is not exported, so it was mirrored line for
line rather than called. A real in-file fix is the only way to be certain they
agree.
