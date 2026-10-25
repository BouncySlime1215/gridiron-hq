---
name: gridiron-rebase-before-merge-lesson
description: Lesson (Trade Brain, 17:01Z) — rebase onto the current main before every merge, because two PRs with zero file overlap (#89/#91) still broke each other
metadata:
  type: project
  modified: 2026-09-22T17:02:00.000Z
---
**Why:** #89 and #91 touched no file in common and each was CI-green on its own head; merged back to back they turned main CI RED (1a136145), and #111 had to fix it. Zero file overlap is not zero interaction — a test in one can depend on a behaviour the other changed.

**Rule Trade Brain adopted, now a fleet lesson:** rebase (or merge main in) onto the head main has RIGHT NOW before every merge, run one clean check, push, and let CI go green on that head; the "REAL" verdict and the merge both refer to that post-rebase head. Example: #94 rebased onto a1e661fc → 951c70f1 immediately before its merge go (17:01Z). Pairs with [[a-branch-head-sha-is-the-whole-stack]] and [[gridiron-check-script-omits-wiring-gate]] (local green never covers the wiring gate). Origin [[gridiron-state-1240-2026-09-22]].
