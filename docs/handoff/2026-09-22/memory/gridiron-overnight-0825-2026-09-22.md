---
name: gridiron-overnight-0825-2026-09-22
description: Nick's 08:25Z 2026-09-22 overnight order — keys/merges tomorrow; R&D loop runs all night creating new data/ML/advanced-stats techniques, testers (auditors) decide plan additions; #96 HELD (fails open vs UI data-freshness.js), #95 alone merges first.
metadata:
  type: feedback
  modified: 2026-09-22T08:27:29.693Z
---
**Nick 08:25:21Z (cmsg_01YAsw8AnFv4ioRMQw8dfPmTRm2YBUbGEoT371ioCdkPm3), verbatim:** "ill do tmr - make sure everything does well overnight pls - make sure the R&D are always exploring and creating new techniques anmd new shit to add - from a data ML advanced stats perspective / just run it on a loop then the testers test if we should add to the plan"

**How to apply:** Explorer (Data & techniques R&D) loops on NEW technique classes, not just backlog; Planner specs; both Auditors = "the testers", verdict must open with add-to-plan / do-not-add / redirect. Relayed with id attached to Explorer, Planner, statistical Auditor 08:27Z. Keys rotation + #95 merge deferred to tomorrow by Nick. In the morning: one consolidated post listing every PR, its verified figure/tree, and merge order.

**#96 HELD (Scheduler merge gate 08:25Z):** UI's server/services/data-freshness.js (branch `claude/project-thread-xiezr0-data-freshness` @ 3d92ccb = #86) reads current_rule.{predicate,bind,description}; #96's servedTables() emits current_rule.{sql,params,text}. Mismatch fails open: with #96 present every rule null → verdict "fresh", stale unreachable (measured on real DB, 2021-2025 loaded, 2026 wk3 asked). Two of 17 rules are universals (roster_players MIN(fetched_at); gamescript_model COUNT(DISTINCT target)>=2) that a WHERE fragment cannot express, so fix is consumer-side: UI evaluates rule.sql+params, missing rule = fault, specimen RED test; Scheduler exports evaluator from source-registry.js. **Merge order: #86 (with fix) before or with #96; #95 alone first.** Told Nick 08:27Z.
