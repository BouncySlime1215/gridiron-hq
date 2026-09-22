---
name: gridiron-state-1275-2026-09-22
description: "18:47Z-18:52Z forty-sixth batch: #121 at 57c21a0f carries configuration B, k wiring control and call-site-binds-build; Feature audit draft #130 (thrown career reads 'record could not be read'); cache-fingerprint TEST HAZARD lesson (findTrades cache not busted by tradeability-only fixtures); CLAUDE.md correction — TASKS.md IS on main since d9b4a90d and 'CI never completed' is scoped through 2026-09-15; queue additions after #127"
metadata:
  type: project
  modified: 2026-09-22T18:53:00.000Z
---
(Coordinator asked for this as an append to 1272; 1272 is near 4 KB, so this is 1275.)
- **Model evidence audit:** #121 at 57c21a0f has configuration B (§2c:133-138), the k wiring control (§2c:140-147), call-site-binds-build (§5:341-344); CI red = the inherited gate (run 35762351113); the stale "no fix exists" comment corrected on #121; **#129 deliberately NOT ported** (Wiring map's files).
- **Feature audit draft PR #130** (trade-engine evidence fault: a thrown career now reads "a player whose record could not be read", rookie unchanged) head ea03d88 on `claude/project-thread-5f9c3y-evidence-fault-not-no-record`; check 0, 3546/3505/0/41; wiring 1 byte-identical to base; R50 (a)-(f) addressed, the cache recommendation deferred with reason and a called-once pin; R52.2 six-commit table.
- **TEST HAZARD** [[gridiron-cache-fingerprint-test-hazard]]: the `findTrades` cache fingerprint = `manager_profiles` COUNT + MAX(`updated_at`) (`trade-engine.js:1478`, `compute-cache.js:48-68`); fixtures upserting tradeability alone do not bust it, so a second search returns the first's objects and tests pass on unfixed code. Fix = a strictly-newer `updated_at` helper + a reference-inequality assertion. Trade Brain asked to sweep its tests.
- **CLAUDE.md CORRECTION (for memory):** `TASKS.md` IS on main since d9b4a90d (2026-09-19; byte-identical to the cursor branch as of 654ff93), and "CI never completed on main" is now scoped to **through 2026-09-15**. Noted in [[gridiron-claude-md-tasks-md-claim-stale]]; MEMORY.md carried no contrary line.
- **Evidence Auditor queue additions after #127:** #130, #121, #122, #123 (each after its Auditor ruling).
Prev [[gridiron-state-1274-2026-09-22]]. Next [[gridiron-state-1276-2026-09-22]].
