---
name: gridiron-pr-board-2026-09-22-part5
description: PR board as of 17:14Z with its 17:16Z-17:25Z rows, moved verbatim out of [[gridiron-pr-board-2026-09-22]] at 17:51Z
metadata:
  type: project
  modified: 2026-09-22T17:51:00.000Z
---
Moved verbatim from gridiron-pr-board-2026-09-22.md at 17:51Z.

## Board as of 17:14Z ([[gridiron-state-1250-2026-09-22]], [[gridiron-state-1251-2026-09-22]])
- **MAIN RED at 144b722 (check:wiring gate false positives, runs before tests). HOLD-MERGES since 17:10Z until Wiring map's root-cause fix lands.** A PR red only on that step is main's fault, not the PR's.
- **MERGED today:** #91, #89, #111, #102, #114, #68, #95 eb861feb, #112 a1e661fc, #86 7eca9a8b, #87 0c5b7be4, #109 4ff3048b, #110 ab01efa8, #108 eb19f475, #99 c5ee3b54 (= DEPLOYED tree), then NOT deployed: #113 bf359c68, #115 144b7225, #119 (main f620a120), #117 92654e20. **CLOSED:** #36, #105.
- **REAL, awaiting merge (held):** #94 951c70f1 (full local run), #92 67b05ef (3196/0, CI running), #103 08c729e1 (after #94), #116 (rebased 8ff70768, unpushed).
- **At the Evidence Auditor / CI:** #118 (body fixed), #120 (held for rebased head, base #103), #106 1a70355 (green, held per R35 until R40 flag), #100, #96, engine-fault.
- **Drafts / pre-reg:** #121 pre-reg 45b01240 (Model evidence audit, needs Independent Auditor clearance), #122 evidence-only (Feature audit), Wiring map check:wiring follow-up branch (RED 17a6051/GREEN e33c6cb), Scheduler epoch-fallback-loud (3236/0), Coach suspension unit (RED 03da7fd6), UI ceiling-lineup fix (RED 6247820/GREEN 81d0fa8/ev 0753e2e, at Auditor), Release deploy.yml + .dockerignore.
- **Deploy:** live = c5ee3b54, scheduler ON since 17:08Z; #119/#117 and later merges NOT deployed; next deploy is Nick's word.
- **17:16Z:** #92 to be SPLIT — route splits out into a second PR that wires `syncRouteSplits` as a scheduled job (Planner, one scheduler.js entry). cascade-grade.js accept-list entry stays (pre-registered for #72). [[gridiron-state-1252-2026-09-22]]
- **17:20Z** ([[gridiron-state-1254-2026-09-22]], [[gridiron-state-1255-2026-09-22]]): **#94 REAL 00319229** (3261/3220/0/41; CI red = main's gate). **#116 head 28b801b8** (base f620a120, full run in flight). **#124 NEW draft db6b001** (Chat sync, liveDraft fail-closed, 3112/3071/0/41, holding). Wiring map gate fix head **c3527d4a** (not yet a merge sha) — first in the Evidence Auditor queue, then #116, #124, then #103/#120/#100 after #94. #121 HELD (R47 two text fixes). HOLD-MERGES still in force.
- **17:25Z** ([[gridiron-state-1256-2026-09-22]]): **#120 REAL on 9fad5221** but no check:wiring on that tree → #103/#120 rerun both gates on rebased heads first. **#123 NEW** (Feature audit, negative result on roster-risk/waiver-brain). Gate fix c3527d4a NOT on origin yet (branch at 603080a2). **#54, #85: zero check runs, need a push**; stale 'CI disabled' text in #85/#103 bodies to remove. Feature audit playerRiskProfile unit: RED 1c0b93f / GREEN bcd6fb2 / ev fd1f031, changed pin awaiting Auditor.
