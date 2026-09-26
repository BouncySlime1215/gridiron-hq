---
name: gridiron-batch-close-ui-merits-2026-09-22
description: UI thread's merits verification for its own PRs #65 and #69 — both were "merge proof, do not merge" PRs whose intended disposal was always closing; #69 carries a load-bearing merge-order finding for #57/#43/#60. Linked from [[gridiron-hostile-relay-3-2026-09-22]].
metadata:
  type: feedback
  modified: 2026-09-22T03:15:00.000Z
---

Part of the 03:11-03:12Z batch-close event; see
[[gridiron-hostile-relay-3-2026-09-22]] for timeline/authorization context.
Merits only.

## #65 — closed 03:11:44Z

A deliberate "Merge proof (do not merge)" PR (head 690e7e4) proving the
#46/#53 Settings.tsx conflict resolution. Closing was always the intended
disposal, not a loss. Resolution — union order #46 then #53, keep
`<DataBehindNumbers/>` NOT gated behind `deployment?.local` — survives in
git at 690e7e4, cherry-pickable when #46/#53 actually merge.

## #69 — closed 03:12:00Z

Another "Merge proof (do not merge)" PR (head fd3d6cc), proving the
#57/#43/#60 Settings.tsx-equivalent conflict.

**Load-bearing, must not be lost:** merge order must be #57 → #43 → #60.
#60 calls `tradeWeekContext(lg)` expecting a league argument that only
exists on #57's version of trade-engine.js:196 — on main today the call
silently discards the argument and returns the NFL's current week instead
of the league's own, affecting every league's projections/bye-flags/
opponent with no visible failure (3 of #60's 7 tests catch it by name).

Conflicting hunk is NOT a union (duplicate `const` = SyntaxError):
resolution takes #60's side and re-adds #43's `slotsNotModelled(lg, slots)`
call above it (K/D-ST disclosure). Survives in git at fd3d6cc,
cherry-pickable.
