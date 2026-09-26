---
name: gridiron-rd-explorer-planner-loop-2026-09-22
description: Nick's 2026-09-22 08:07Z structure for R&D — a three-stage explore/plan/build loop, and the fixed Planner hand-off section every R&D package must now end with.
metadata:
  type: feedback
---

Nick, 2026-09-22 08:07:25Z, message id
cmsg_01YAsw8AnFv4ioRMQw8dfPmTCXAo4ZsR87wYou7x94bzbr, verbatim:

"WHERE DID MY R&D AGENTS GO - MAKE SURE THEY WORK TOGETHER - ONE EXPLORES - ONE
SEES IF WE CAN DO IT AND PLANS IT- then sends it t the plan - then repeat - add
another planner and can we do it if they evrr get backed up"

**The structure the coordinator set from it:**

- **Explorer** = Data & techniques R&D (this thread). Finds and prices. Keeps
  publishing packages exactly as before.
- **Planner** = R&D integration & cleanup. Decides whether a finding can be
  built in this repo and writes the build spec.
- **Builder** = Fantasy plan, for `projections.js`. **Auditor gates** each unit.
- A second Planner is authorised if the queue backs up. Negatives get no plan.
- Packages route to the **coordinator**, which places them with the Planner and
  the Auditor. The Explorer still sends the Auditor its submission format
  directly for the statistical gate.

**Why:** Nick wants findings to become builds instead of accumulating as specs.
The Explorer was producing packages faster than anything was consuming them.

**How to apply — every R&D package now ends with a fixed
`## Hand-off for the Planner` section**, so the Planner never reconstructs it:

1. **Table** — where the data already is, and whether new ingestion is needed.
2. **File** the change is believed to land in, `file:line` for the incumbent.
3. **Incumbent to beat**, concretely.
4. **Gate metric** the build should be held to, including the control that
   would catch a recalibration passing as a signal.
5. **The stated limit, VERBATIM** — quoted from the spec's own weaknesses, not
   paraphrased, so the Planner cannot plan past it by accident.

Retrofitted into `/mnt/project-files/COMMITTEE-SPEC.md` and `DEPTHRANK-SPEC.md`
on 2026-09-22. A negative still gets the section, saying "nothing to plan" and
why, so a later session finds the measurement instead of repeating the work.

Related: [[gridiron-five-questions-rule]],
[[gridiron-committee-reallocation-real-2026-09-22]],
[[gridiron-chat-reserved-for-his-word-or-milestone]].
