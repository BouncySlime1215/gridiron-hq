---
name: gridiron-rebase-moves-evidence-shas-lesson
description: Lesson (Feature audit #130, 18:40Z) — a rebase is not done until the evidence file's RED/GREEN shas move with it in the SAME push (R52.2); #130 nearly merged citing pre-rebase shas orphaned by the rebase, fixed a7c7ae5 + 44b41cf
metadata:
  type: project
  modified: 2026-09-22T19:15:00.000Z
---
**Why:** #130 was rebased onto c90d2834 and then b6c7b739; the code moved, but `docs/tdd/…` still cited the pre-rebase chain 77ccbbc → … → 5b8a345. Those commits no longer existed on any branch, so the RED/GREEN citations pointed at nothing — an evidence file that could not be checked, on a PR whose gate is that it can be. The Evidence Auditor's body read (18:15Z) found nine PRs quoting stale shas for the same reason. Fixed in a7c7ae5 (sha table → post-rebase chain b6e0641 RED1 → 5c1560d → 44adbca → bce6958 → b8b29f9 → 07af90c → 4807e2e) + 44b41cf, in the same push as the guard figure.

**Rule:** a rebase (or merge of main that rewrites the chain) is complete only when, in the same push: (1) the evidence file's RED/GREEN/fix shas are the post-rebase shas, each reachable from the new head; (2) the PR body's self-check block cites the same shas; (3) the guard figure quoted is from a run on the new tree. The merge-gate skill's §2 checks reachability with `git merge-base --is-ancestor <sha> HEAD` for every cited sha. Pairs with [[gridiron-evidence-citation-rule]] and [[gridiron-rerun-red-after-assertion-change-lesson]]. Origin [[gridiron-state-1300-2026-09-22]].
