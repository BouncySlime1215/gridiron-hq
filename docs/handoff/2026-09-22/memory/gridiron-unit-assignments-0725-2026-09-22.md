---
name: gridiron-unit-assignments-0725-2026-09-22
description: The 07:25Z per-thread unit assignments, moved verbatim out of MEMORY.md at 17:00Z to make room; historical — current assignments live in the state files
metadata:
  type: project
  modified: 2026-09-22T17:00:00.000Z
---
Moved verbatim from MEMORY.md at 17:00Z 2026-09-22. Superseded by the state files ([[gridiron-state-index-2026-09-22]]); kept for the record.

## Current unit assignments (07:25Z)
- Release → fix CLAUDE.md:61 (Auditor: false — TASKS.md IS on main, tracked, added d9b4a90d; stale/behind, not absent). CLAUDE.md loads in every session; the wrong line sends each one hunting. + CLAUDE.md §3 'never completed on main' line: correct after pause.
- Feature audit → `nfl-weekly-feature-store.js:149,160`, same feed-zero contamination (raw AVG where feed writes 0), TDD + push.
- Scheduler → epoch-rollover-AFTER-promotion gap: new active epoch → activeWeeklyWeightSet finds nothing, weightSetFrom silently returns frozen-2023, nothing logged, no test. Make the fallback loud. Trigger POST /api/nfl-betting/engine/learning-epoch (routes/nfl-betting.js:268-273), authed, not open.
- UI → confirm/complete the fake "data healthy" banner kill (item 3 required it in the freshness-registry PR). Branch `claude/project-thread-xiezr0-data-freshness` @ 7c289e8 pushed, 3037 tests/2996 pass/0 fail, no PR.
- Coach + any finishing thread → pick own next unit from remaining Phase A scope, report the pick.
- Opportunity → pushing 467b849 + `docs/inventory/CONTRACT.md` (08be6e1) after 2 real runs; Nick said "do it" in that thread. Branch carries PR #85, so the push widens #85 — Nick approved in-thread.
- Model evidence audit → push 58c29114 + 7a3b8262 so the Auditor can reach them; then ypc/ypa/rush_td_rate/pass_td_rate sweep.
- R&D-cleanup → 3rd feed-zero instance (chartingSummary in nfl-formations.js publishes 4.50 where measurement is 6.00) + unbound season param (NaN → 500 instead of empty answer). RED ce75775/GREEN 1f37be6, 8/8 mutations killed, 3030 tests green. Idle after.
- Data & techniques R&D → BDB notebooks; K.yards_per=34 finding queued for Auditor (recommend ~100 ypt / ~150 ypc if it survives; curve flat, "150" is false precision).
