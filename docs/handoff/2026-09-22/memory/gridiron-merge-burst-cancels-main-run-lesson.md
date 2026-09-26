---
name: gridiron-merge-burst-cancels-main-run-lesson
description: Lesson (Evidence Auditor, 18:15Z) — CI's concurrency group cancels the in-flight main run on the next push, so back-to-back merges leave the earlier merge commit never verified (#124's run cancelled by #92); the gate serialises merges and cancelled runs go in the ledger
metadata:
  type: project
  modified: 2026-09-22T18:19:00.000Z
---
**Why:** `.github/workflows/ci.yml` runs main under a concurrency group that cancels the in-progress run when a new push arrives. #124 merged as 9f0b5b66 and its main run 35765168683 started; #92's merge pushed 6e722719 minutes later and the group cancelled #124's run. So 9f0b5b66 was never verified by CI — the last fully verified main was c90d2834 until run 35765300584 on 6e722719 completes. A merge burst under the new gate (owning threads merge on their own CI green) makes this the default failure, not an edge case.

**Rule:**
1. Merges are serialised: the next squash-merge waits for main's push run on the previous merge to finish (success), or the coordinator hands out merge slots in order.
2. A cancelled main run is recorded in `/mnt/project-files/USAGE-LEDGER.md` notes and the Evidence Auditor's merge ledger with the sha it left unverified; "main green" is claimed only for a sha whose own run succeeded.
3. A PR whose pre-resolved conflicts were computed against an older main (#125's 4d2c505 against 9f0b5b66) is re-checked against the newest main before merge, because the intervening merge (#92: nfl-model-growth.js, nfl-formations.js, who-plays.js, migration 070) may touch the same files.
Pairs with [[gridiron-rebase-before-merge-lesson]] and [[verify-the-merge-not-just-the-head]]. Origin [[gridiron-state-1289-2026-09-22]].
