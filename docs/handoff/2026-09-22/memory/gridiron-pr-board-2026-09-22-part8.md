---
name: gridiron-pr-board-2026-09-22-part8
description: "Archived PR board as of 17:55Z 2026-09-22 (#129 merged c90d2834, hold lifted, Evidence Auditor queue); superseded by the 18:18Z board in [[gridiron-pr-board-2026-09-22]]"
metadata:
  type: project
  modified: 2026-09-22T18:19:00.000Z
---
## Board as of 17:55Z ([[gridiron-state-1278-2026-09-22]], [[gridiron-state-1279-2026-09-22]])
- **MAIN GREEN at c90d2834 (#129 gate fix MERGED 17:53Z; Evidence Auditor REAL 17:51Z on 6432a768 tree 63ebac8a; R52.1 five checks PASS). HOLD-MERGES LIFTED 17:55Z.** Every PR rebases onto c90d2834, one guard `npm run check` (six steps, wiring included) exit 0, head + exit code to the Evidence Auditor before read. **No new unit until Nick answers the 17:53Z budget decision.**
- **MERGED today:** #91 #89 #111 #102 #114 #68 #95 #112 #86 #87 #109 #110 #108 #99 (c5ee3b54 = DEPLOYED tree), then AFTER it and NOT deployed: #113 bf359c68, #115 144b7225, #117 92654e20, #119 f620a120, #129 c90d2834 (git merge-base verified 18:01Z). **CLOSED:** #36 #105 #35 (done: #63 2206383, #52 9075e33, #49 654ff93).
- **Evidence Auditor queue:** #94 00319229 (REAL, rebase first) → #116 6dfc123d (REAL) → #124 db6b001 → #125 0f442fa → #85 69909edd → #92 4a8085c → #100 eb813b4d → #127 43116ab (deploy button) → #130 → #121 → #122 → #123 → #131 → #132 → #133 → #103 08c729e1 / #120 9fad5221 → #77 / #84 / #96 / #104 / MLB removal / #90 / #82 / #106.
- **#130** (Feature audit, ea03d88 tree 33223b3c): **HELD R58** — fourth surface RiskStrip.tsx:5-6 floorOf + types.ts:41/:44-50; Feature audit extends the PR (grant: RiskStrip.tsx + types.ts trade-risk lines). Cache-fingerprint find confirmed.
- **#121** (Model evidence audit, 57c21a0f): **HELD R57** — config B cleared; back once on call site file:line, decisionAt nfl-player-context.js:528 + control, support row per arm; QBR strike reason → configuration.
- **#131 NEW** (Chat sync finding 1, 665cbb2 tree eac38a40, RED eedeb64, 110/110; wiring 1 was the base gate → rebase). **#132 NEW** (UI ceiling-lineup fix; milestone line once REAL). **#133 NEW** (Release nflverse CC BY attribution, branch claude/nflverse-attribution, RED 0c47e60 GREEN 471d3f0 fix 2505240 evidence 470f575; at Auditor).
- **#77** RETARGETED to main, dirty (14 files / 7 commits = squash-merged #63), Scheduler merging main in. **#96** body corrected (ruleShape accepts sql shape). **#106** 771bf64 (committed-fixture 20/20, guard running). **#90** (Coach) final guard, push on green. **#122/#123** evidence-only, held for their Auditor rulings.
- **Coming (drafts pending):** Opportunity reach-ladder (branch claude/project-thread-w45mur-reach-ladder, RED e2f2674b GREEN 83b67b82, at Auditor), Scheduler MLB removal (COMMITTED 11 files / 2,342 lines, gate running, no-deletion confirmation asked), Wiring map MLB commit on Scheduler's branch then CONTRACT.md 172 fix, Planner matchups.js gameMultiplier arm (pre-reg REVISION 1 at Auditor), Feature audit #87 pass_rushers gate (after #92 + re-ingest).
- **Deploy:** live = c5ee3b54, scheduler ON since 17:08Z; everything after 17:05Z NOT deployed; next deploy is Nick's word.
