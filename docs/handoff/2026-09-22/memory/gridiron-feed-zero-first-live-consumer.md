---
name: gridiron-feed-zero-first-live-consumer
description: "Planner, 16:40Z: the first LIVE (shipped, not evidence-only) feed-zero consumer, projections.js:492 -> tgtShareObs -> volume.target_share, measured 18.0% of 2024 players understated"
metadata:
  type: project
  modified: 2026-09-22T16:43:06.372Z
---
Planner, 2026-09-22, pushed 28ff7ae (docs-only amend of 67d2bc1, branch
`claude/project-thread-2oztzw`, run 3168/3126/1/41 — the 1 fail is the old
main regression, not this).

**`football-context.js:93` pricing is WITHDRAWN in text** — dead column, no
fix needed (closes Feature audit's feed-zero class together with #87/#114).

**FIRST LIVE feed-zero consumer found:** `projections.js:492` — `history()`
(`:294-300`) has no snap filter, feeds `tgtShareObs` (`:522`), which feeds
`volume.target_share` (`:723`), which is consumed live by
`news-fantasy-impact.js:121` and `trade-engine.js:411`. Unlike prior
feed-zero findings (evidence-only), this one is on a path both consumers
actually read.

**Measured, 2024:** 113/627 players (**18.0%**) affected; mean understatement
**0.0059** target-share, **34.1%** of the site's own displayed value; 41
players ≥ 0.005 understatement; max **+0.0769**. This is stated as an upper
bound.

**Three-support defect:** `projections.js:395` and `shrinkage-fit.js:330`
both gate on `> 0`; `projections.js:492` does not — the inconsistency is why
this path is a live feed-zero and the other two are not.

**Routing:** beside R35's coupled-grade unit for the Auditor's ruling; owner
`projections.js` is Model evidence audit's [[gridiron-file-allocation]].
