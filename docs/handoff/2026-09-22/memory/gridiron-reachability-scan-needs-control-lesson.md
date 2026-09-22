---
name: gridiron-reachability-scan-needs-control-lesson
description: Lesson (UI, 17:58Z) — a reachability scan that reports a page unreachable must first find a KNOWN-reachable page; UI's first scan missed React.lazy() and hub imports and would have called live pages dead
metadata:
  type: project
  modified: 2026-09-22T18:01:00.000Z
---
**Why:** UI scanned the client for routes to decide whether Model.tsx (which fetches a route that does not exist, model.js:538) is reachable. The first scan looked only at direct `import` statements and static route tables; it did not follow `React.lazy(() => import(...))` or the hub components that import pages indirectly. Run on its own it would have reported reachable pages as unreachable, and the unit was nearly assigned on that basis. The corrected scan found Model.tsx unreachable by design (model.js:1-26 forbids re-adding the routes; 8-tab nav rule) and the unit was PULLED — but only after the control passed.

**Rule:** any scan whose output is "X is not reached / not imported / not wired" runs a control first: point it at one page or symbol known to be reachable (e.g. a nav-tab page) and require a hit. No hit on the control = the scanner is wrong, not the code. Same shape as the fleet [[gridiron-contradiction-test-rule]] (a zero from a bespoke check needs one known-nonzero case) and [[gridiron-bespoke-tool-cross-check-rule]]. Origin [[gridiron-state-1280-2026-09-22-part2]].
