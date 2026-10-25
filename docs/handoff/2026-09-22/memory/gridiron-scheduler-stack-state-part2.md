---
name: gridiron-scheduler-stack-state-part2
description: Merge-check-re-run detail moved out of gridiron-scheduler-stack-state.md at 16:2xZ 2026-09-22 to stay under cap; part 1 is [[gridiron-scheduler-stack-state]]
metadata:
  type: project
  modified: 2026-09-22T16:28:34.075Z
---
Moved verbatim from gridiron-scheduler-stack-state.md's "## Merge check re-run 2026-09-20 04:05Z" section:

Verified locally, from `origin/main` 791b131 forward: `63ca21e -> b5b74b5 ->
7534ff1 -> a986f37 -> 01b7a2f -> 64f3ef2 -> 3902ba7 (#77) -> bec666d -> 3d4ca74 (hold head, pushed 03:2xZ)`
is **one linear fast-forward chain**, 19 files, +2237/-42.

Onto the stack tip, #39, #45, #49 and #52 all merge **clean**.

Hold head **8709ec6** (2026-09-20 ~06:35Z, no PR on the branch so no email).
Chain past #77: `3d4ca74` (#61 served-field pins + five-question block, 3003
tests) -> `9c7cf68` (ESPN transaction collector as a metered off-thread
registry job + migration 066, 3012 tests) -> `8709ec6` (wiring-map findings:
roster sweep reports `skipped`/`synced`, `/dev/usage` and the two unused
`paths.js` helpers removed, `listJobs()` served from `/dev/status`, dead
`cancelJob` status write removed; **3021 tests / 2980 pass / 0 fail / 41
skipped**, build, start:smoke).

**`server/index.js` on this branch is UNTOUCHED past #56.** The decision-inbox
unmount (import :46, mount :137) was routed here and handed BACK: the wiring
map carries both lines in the same commit as its route deletion, a stated
two-line one-editor exception. Reason it must be atomic: no test reads the real
mount table -- `test/decision-inbox.test.js:47` and
`test/legacy-route-security.test.js:75` each mount the router on their own
express app, so removing the mount while the four routes still exist takes
`/api/decision-inbox` off the app with a green suite.

**#50 (espn-market) conflicts with the HOLD BRANCH only** — clean onto
`64f3ef2` (the morning tip) and clean onto `3902ba7` (#77). **The morning merge
order is unaffected.** One hunk, `scheduler.js:1330`, a pure adjacency
conflict: #50 adds the `espn_market` JOBS entry where the hold branch flags
`league_rosters` off-thread. **Resolution is the union, both entries kept**, and
both branches are this thread's, so it is mine to resolve when the hold branch
lands rather than anyone else's problem.
