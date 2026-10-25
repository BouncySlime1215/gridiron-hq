---
name: gridiron-projection-model-items-2026-09-22
description: Projection-model items for Nick's 2026-09-22 morning post, split from the morning list — TE prior 0.06 hardcode, polymarket.js:204 bare catch, efficiency-k units / effW (#22, PR #106) gate.
metadata:
  type: project
  modified: 2026-09-22T08:44:00.000Z
---
Split out of [[gridiron-nick-morning-list-2026-09-22]] items 7-9 at 09:44Z; numbering kept.
7. **TE prior:** projections.js:547 hardcodes 0.06 for every position; measured TE share 0.1011 (2025), 40.7% low; Plan 03 arm 1; unit 13 ruled: set level by measurement first, then fit K.share (Plan 04).
8. **polymarket.js:204** bare catch over polymarket_quotes, migrated table, unallocated.
9. **k units:** projections.js:50-66 documents efficiency k in raw opportunities; the n is recency-weighted (0.307 of raw). Planner writing the doc fix; effW fix (#22, PR #106) is correctness only and still loses to the constants; Auditor 17b gate: reproduce #22's five k values + both MAE deltas after the in-file edit.
See [[gridiron-offline-rig-2026-09-22]] (rig banner), [[gridiron-state-0850-2026-09-22]] (Auditor units 12-16), [[gridiron-state-0858-2026-09-22]] (unit 17b effW gate).
