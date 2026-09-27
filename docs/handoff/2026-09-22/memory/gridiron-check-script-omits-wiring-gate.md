---
name: gridiron-check-script-omits-wiring-gate
description: Fleet fact (Wiring map, 16:58Z) — npm `check` does not run check:wiring; only CI on the pushed head covers the wiring gate, and main carries 11 baselined orphan findings of its own
metadata:
  type: project
  modified: 2026-09-22T16:59:00.000Z
---
**Fact:** `package.json` `check` = typecheck && lint && test && build && start:smoke. `check:wiring` is a separate step in `.github/workflows/ci.yml`. So a thread's local verify guard ("one clean run") never exercises the wiring gate; **only CI on the pushed head covers it.** A local green is not evidence about wiring.

**Main's own findings (11 blocking, baselined in annotations.json with owners):** roster-risk.js, trend-watch.js, week-postmortem.js imported by nothing; position-liquidity.js only by its test; league_draft_picks has no INSERT outside test. Four wired-to-nothing features and owners: roster-risk.js + week-postmortem.js (Trade Brain), trend-watch.js (#91 thread), position-liquidity.js (trade-planner owner).

**Unit:** `staleOrphanEntries` RED 19b5bdd / GREEN 31c2a52 on #108 (head a333f449f8fe6476d49c17af07a331426e71c4a4, CI 35756924017). **Follow-up PR after #108 merges: add check:wiring to `check`** so the local guard and CI agree. Origin [[gridiron-state-1236-2026-09-22]].

**17:08Z CORRECTION (Wiring map):** `ci.yml` does NOT call `npm run check`; it invokes each script directly, and `ci.yml:70` is check:wiring's only CI invocation. So adding check:wiring to `check` costs ~15s locally and nothing on CI, and there is no duplication for Scheduler to remove (the earlier 'state the duplication' ask is withdrawn). Follow-up branch from eb19f475: RED 17a6051 / GREEN e33c6cb, evidence `docs/tdd/check-script-covers-ci.tdd.md` — the test reads ci.yml `run:` lines and expands `check` transitively, so the two can no longer drift apart silently. [[gridiron-state-1246-2026-09-22]]
