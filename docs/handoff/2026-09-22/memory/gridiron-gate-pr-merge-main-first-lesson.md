---
name: gridiron-gate-pr-merge-main-first-lesson
description: "Fleet rule (Wiring map #146, 19:1xZ) — a green CI on a gate change is green against the main it built on, not the main you merge into; any PR that adds or tightens a gate merges current main and runs that gate locally in the minute before merging (#146 green on c0a051bd would have taken main b3e79709 red, same shape as #108)"
metadata:
  type: feedback
  modified: 2026-09-22T19:12:00.000Z
---
**Why:** Wiring map's receiver ratchet #146 went CI green on 6212253 against main c0a051bd. By the time the green came back, main was b3e79709 (Coach #90, #55, #62, #133, #106 had landed). Merging current main locally and running `check:wiring` on the combination gave EXIT 1 with two new pairs from Coach's chat corpus — `server/services/coach/people/grading.js` (corpus, 4) and `server/services/coach/people/variables.js` (chatDb, 9). Merging on the stale green would have taken main red, exactly the #108 shape. A gate change is the one kind of PR where "no overlapping files" proves nothing: the gate reads every file on main, so every merge into main since the build changes the answer.

**Rule (fleet):**
1. Any PR that adds or tightens a gate (wiring map, reach grader, contract check, lint rule, test that scans the tree) merges current main and runs that gate locally in the minute before merging; CI green from before that merge is not the merge criterion.
2. New findings surfaced that way are baselined with owner + a result-based RETIRES WHEN and marked as post-build churn, or fixed — never merged past. #146: both pairs baselined; head 5dfedb80, gate 0 on the merged tree, 18/18 ratchet tests, CI re-running, merges on THAT green.
3. **Collector defect, NOT a naming rule:** `foreign.has(name)` is checked before the `db` convention and should already resolve `chatDb`; this is Wiring map's next unit (evidence 2). The takeaway is not "name your handle db" — Coach's rename to `chatDb` was right ([[gridiron-db-local-name-false-finding-lesson]]).
Pairs with [[gridiron-rebase-before-merge-lesson]] and [[gridiron-merge-burst-cancels-main-run-lesson]]. Origin [[gridiron-state-1299-2026-09-22]].
