---
name: gridiron-phase-a-0447-b-2026-09-22
description: Detail for 04:32-04:47Z cycle, part 2 (UI CLEAR_THRESHOLD question, wiring map, scheduler, unchanged threads). Part 1: [[gridiron-phase-a-0447-2026-09-22]].
metadata:
  type: project
  modified: 2026-09-22T04:49:24.561Z
---

**UI**: shipped lineup-posture.js display-bug fix (RED 48fddf4/GREEN 23c6c2c, 7 new tests, full check 3019/2978/0-fail) — bench/IR/taxi-squad players were counted as "excluded starters" and mislabeled K/DEF. Confirmed lineup-brain.js is UI's file per allocation map. UI wants measurement scope (was 72.8%/81.4% win-rate measured on mean week_points, or on ceiling/floor margins — file's own code only calibrates for week_points) + precise "wins a comparison" definition + sample size before CLEAR_THRESHOLD 4→6 change — routed to Model evidence audit, awaiting answer. UI also flagged that "clear" at 6pts still means ~1-in-5 wrong calls; considering softening label's implied confidence (show win rate, or rename band) rather than just moving the number.

**Wiring map**: building a column-level dead-end detection rule (~2h, approved) to generalize its tool past two bugs (satellite-table false-positive fix, read-but-never-created rule) already caught by hand tonight.

**Scheduler**: confirmed no collision on its source-registry.js carve-out to the integration thread; corrected its own earlier wrong claim that migration 066 isn't its file (it is — 9c7cf68, under its o3wt2p branch-namespace); still declining to register nfl_route_splits in the freshness registry until it's actually pulling live data; still holding 5 local branches for Nick's word.

**Unchanged since last checkpoint**: Release, Feature audit, Opportunity, Chat sync, Coach.
