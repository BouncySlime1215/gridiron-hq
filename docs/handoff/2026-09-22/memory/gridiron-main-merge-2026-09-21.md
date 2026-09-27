---
name: gridiron-main-merge-2026-09-21
description: What Nick actually merged into main on 2026-09-21 — #63, #52, #49 squash-merged to 654ff93; what he explicitly did NOT do. Linked from MEMORY.md "MAIN = 654ff93".
metadata:
  type: project
  modified: 2026-09-22T04:12:52.182Z
---

Nick squash-merged three PRs Monday 2026-09-21 ~09:42 local time:
- #63 → 22063830
- #52 → 9075e33c
- #49 → 654ff933 (this is current main)

#56, #59 and #61 shipped inside #63 (they were its ancestors) — their formal closing is a separate step, part of the paused seven-item batch (see MEMORY.md "RESOLVED: seven-item batch").

**What Nick explicitly did NOT do** in this pass: did not touch #47, #72, or #85; did not run `fly deploy`; did not unset `SCHEDULER_DISABLED`. The live app is still on the pre-merge image with the brake on — see [[gridiron-deploy-step-2026-09-22]].
