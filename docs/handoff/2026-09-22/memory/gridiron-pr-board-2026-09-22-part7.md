---
name: gridiron-pr-board-2026-09-22-part7
description: PR board as of 18:18Z with its rows to 19:00Z, moved verbatim out of [[gridiron-pr-board-2026-09-22]] at 17:56Z (coordinator clock) when #129 merged
metadata:
  type: project
  modified: 2026-09-22T17:56:00.000Z
---
Moved verbatim from gridiron-pr-board-2026-09-22.md at 17:56Z.


## Board as of 18:18Z ([[gridiron-state-1266-2026-09-22]], [[gridiron-state-1267-2026-09-22]])
- **MAIN RED at 144b722 (wiring gate before tests; a ~1-minute CI red = gate, tests ABSENT). HOLD-MERGES until **#129** (gate fix, head 6432a768, PUSHED 18:35Z, CI 35762304798, 3553/3512/0/41) merges.**
- **MERGED today:** #91 #89 #111 #102 #114 #68 #95 #112 #86 #87 #109 #110 #108 #99 (c5ee3b54 = DEPLOYED tree), then NOT deployed: #113 #115 #119 (f620a120) #117 (order corrected 18:01Z). **CLOSED:** #36 #105.
- **Queue after the gate sha (Evidence Auditor):** #94 00319229 (REAL) → #116 6dfc123d (REAL, fast-forward) → #124 db6b001 → #125 0f442fa → #85 69909edd (3546/3505/0/41) → #92 4a8085c (3575/3534/0/41) → #103 08c729e1 / #120 9fad5221 (both gates on rebased heads) / #100 eb813b4d (measured f7977515, 3539/3498/0/41; citations re-measured).
- **Other open:** #106 d4c6e49 + 7c00e40 + eaffd75 PUSHED (default-off ACCEPTED; committed-fixture RED still owed), #118 39d0231e (dirty → UI), #121 57c21a0f (revised; at Auditor for R47(B)), #122/#123 evidence-only, #126 refresh-lastline, #128 MLB census (docs-only), #54 207f7640 (keep-or-close), #96, engine-fault.
- **Coming:** gate fix PR (6432a768), Scheduler MLB removal + epoch-fallback-loud + staleness trigger, Coach suspension, UI ceiling-lineup (at Auditor), Opportunity partition script (pre-reg at Auditor) then call graph, Planner migration-070 (pre-reg starting), Release #127 43116ab (deploy button + .dockerignore; queued after #100), Chat sync finding 1 (#113 hole) then its four-item queue, Feature audit playerRiskProfile (R50 checks), Fantasy plan observed_diff + level correction.
- **Deploy:** live = c5ee3b54, scheduler ON since 17:08Z; everything after 17:05Z NOT deployed; next deploy is Nick's word.
- **18:24Z** ([[gridiron-state-1268-2026-09-22]]): **#100 PUSHED eb813b4d**; queue now ends … #92, #100.
- **18:30Z** ([[gridiron-state-1270-2026-09-22]]): #106 pushed with conditions commits; **#90 (Coach)** merged main f620a120, RED 03da7fd6 / GREEN 9e1a931b, final guard running, push on green, merge held.
- **18:33Z** ([[gridiron-state-1271-2026-09-22]]): Opportunity partition script on branch claude/project-thread-w45mur-reach-ladder off f620a120 (R54.2 falsification passed exactly), draft PR to come, held. Planner 070 pre-reg at Auditor (059 with 070 held out).
- **18:35Z** ([[gridiron-state-1271-2026-09-22]]): **#127 NEW draft** (Release; workflow_dispatch deploy button + .dockerignore 491 MB → 12 MB; 3541/3500/0/41, 22/22 mutations; queued after #100, held for gate sha). After it merges: Nick creates the Fly deploy token and adds FLY_API_TOKEN as a repo secret (copy-paste in the 30-min post).
- **18:42Z** ([[gridiron-state-1272-2026-09-22]]): **#129 PUSHED** (gate fix; first in queue; `check` now includes check:wiring). Planner charting unit HELD by R56 (three text items). New Scheduler unit queued: saveAndVerifyWeeklyFit zero callers.
- **18:47Z** ([[gridiron-state-1273-2026-09-22]]): **#121 revised 57c21a0f** (3533/3492/0/41) at Auditor. #129 merge onto f620a120 proven fast-forward; CI job 106863085562 in progress.
- **18:49Z** ([[gridiron-state-1274-2026-09-22]]): sweep — 30 open PRs carry a false 'CI cannot run' reason (remove on next push). **#77 MUST RETARGET TO MAIN** (base is still the #63 feature branch). #96/#104 gate satisfied since #86 merged → Scheduler rewrites bodies + rebases. #35 → close as done. REAL to date: #111 #68 #114 #112 #109 #110 #86 #95 #87 #108 #103 #102 #113 #99 #115 #117 #119 #94 #120 #116.
- **18:53Z** ([[gridiron-state-1275-2026-09-22]]): **#130 NEW draft** (Feature audit, ea03d88, 3546/3505/0/41). Queue after #127: #130, #121 (57c21a0f, configuration B in), #122, #123 — each after its Auditor ruling.
- **19:00Z** ([[gridiron-state-1276-2026-09-22]]): #106 committed-fixture RED 60dc4f0 / GREEN d01aac8 / evidence 771bf64, guard running, push on DONE, held for gate sha. New unit: nflverse CC BY attribution (Release + UI one line).
