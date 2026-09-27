---
name: gridiron-fantasy-plan-results-2026-09-22
description: Fantasy plan thread's K-family sweep result and the WA-WORKFLOW-RECORD.md:62 citation resolution, as reported at Nick's 01:01Z 2026-09-22 stop order; companion to gridiron-stop-ledger-2026-09-22.
metadata:
  type: project
---

Branch state (effk, head 2709263, unpushed) is in [[gridiron-stop-ledger-2026-09-22]]. Figures below were produced off 791b131.

**K-family sweep FINISHED, answer NO**: held out on 2023, incumbent 4.580 vs candidate 4.574, mean_diff -0.0061, ci90 [-0.0169, +0.0046], not significant, 4,389 rows; 9 of 20 cells dead by construction; 2024-2025 unspent; nothing promoted.

**Citation WA-WORKFLOW-RECORD.md:62 "40% at week 2" is CORRECT**: derived in ros-projection.js (ROS_PARAMS :69 alpha 0.5, k 4; coefficient (1-0.5)*4/5 = 0.4 at n=1, measured), NOT RECOMMENDED_MODEL_BLEND_WEIGHT (0.2, different quantity); defect is the cite target, should be ros-projection.js:69 with formula at :14; edit NOT made.

**Validity**: its six holds and #79, #80, #83 all off 791b131, none rebased; figures not valid against 654ff93 until re-run.
