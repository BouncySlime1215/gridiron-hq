---
name: gridiron-state-1274-2026-09-22
description: "18:44Z-18:47Z forty-fifth batch: Evidence Auditor's lapsed-hold sweep — 30 open PRs carry a false 'CI cannot run' reason, #77 is stacked on a feature branch and MUST RETARGET TO MAIN, #96/#104's gate is satisfied since #86 merged, #35 to close as done; tool caveat that list_pull_requests reports merged:false for merged PRs; #129 early checks clean; REAL list to date"
metadata:
  type: project
  modified: 2026-09-22T18:49:00.000Z
---
(Coordinator asked for this as "state 1272"; 1272 holds batches 42-43, so this is 1274.)
- **Evidence Auditor lapsed-hold sweep of open PR bodies:** **30 open PRs carry a false "CI cannot run / out of minutes" reason** — owners remove it on their next push, no dedicated push; no queue entry until a run exists on the head. **4 carry lapsed stacking/merge-gate reasons:** **#77** says "stacked on #63" (merged yesterday) and its BASE is still `claude/project-thread-o3wt2p-timer-tier` with base sha = #63's head, so merging #77 as-is would merge into a feature branch silently → **MUST RETARGET TO MAIN before anything** (owner being identified). **#96 and #104**'s gate ("freshness consumer must change first" = `data-freshness.js` on #86's branch) is **SATISFIED** since #86 merged 16:59Z (`ruleShape()` both shapes; `askRule()` feature-detects `evaluateServedTable`) → Scheduler told to rewrite the bodies and rebase. **#35** release train describing three completed merges → close as done unless the owner objects.
- **TOOL CAVEAT** [[gridiron-github-list-merged-caveat]]: the GitHub `list_pull_requests` endpoint returns `merged:false` even for merged PRs (#63, #86 observed); use the per-PR get / `merged_at`.
- **#129 early:** check:wiring 0, findings gone, citations reachable, the fix narrows rather than suppresses; full check running.
- **Evidence Auditor REAL list to date:** #111 #68 #114 #112 #109 #110 #86 #95 #87 #108 #103 #102 #113 #99 #115 #117 #119 #94 #120 #116.
Prev [[gridiron-state-1273-2026-09-22]]. Next [[gridiron-state-1275-2026-09-22]].
