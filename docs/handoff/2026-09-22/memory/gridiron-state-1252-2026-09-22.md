---
name: gridiron-state-1252-2026-09-22
description: "17:12Z-17:13Z sixteenth batch (1 of 2): new standing rule — the local gate is npm run check && npm run check:wiring under one guard, because check omits the wiring step every prior 'clean run' skipped; Trade Brain's four lines on clean main (cascade-grade.js accept entry is log-only and stays); Planner's #92 has three genuine wiring findings → split route splits out, second PR wires a scheduled job, Planner granted one scheduler.js job-table entry"
metadata:
  type: project
  modified: 2026-09-22T17:16:00.000Z
---
- **STANDING RULE 17:13Z — LOCAL GATE = `npm run check && npm run check:wiring` under one guard** [[gridiron-local-gate-includes-wiring-rule]]. `package.json` `check` (`:20`) omits `check:wiring` (`:36`); `ci.yml:69-70` runs it between Lint and Test, BEFORE tests, so a red there runs zero tests. **Every 'clean run' quoted before 17:13Z never exercised it.** Wiring map's follow-up PR folds it into `check`.
- **Trade Brain: four lines on clean main f620a120** — the three findings ([[gridiron-state-1250-2026-09-22]]) plus a stale accept-list entry `cascade-grade.js`, which per `wiring-map.mjs:4076` is **log-only** (`:4089` is the only `exit(1)`; Wiring map confirming). The `cascade-grade.js` entry is pre-registered for Opportunity's unlanded PR #72 — **STAYS**.
- **Planner #92 has THREE GENUINE findings of its own:** `syncRouteSplits` producer-with-no-caller; table-hand-fed `nfl_route_splits`; module-only-tested `nfl-route-splits.js` (reader at `nfl-weekly-feature-store.js:237`, never wired). **Coordinator routing 17:13Z: OPTION 2** — split route splits OUT of #92; a second PR wires it as a scheduled job. **Planner GRANTED `scheduler.js` for ONE job-table entry (`:1312-1373`) only**, head coordinated with Scheduler first ([[gridiron-file-allocation]]). Planner edited its hourly trigger prompt (item 6 → opus 5.5; widened gate; merge-ref lesson).
Prev [[gridiron-state-1251-2026-09-22]]. Next [[gridiron-state-1253-2026-09-22]].
