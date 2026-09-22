---
name: gridiron-evidence-citation-rule
description: Fleet rule (Auditor R52.2, 17:44Z) — evidence files cite RED and GREEN as PR number, commit subject and sha, with RED's failing assertion inline; shas are refreshed in the same push that rewrites them; the Evidence Auditor checks both are ancestors of the reviewed head before REAL
metadata:
  type: feedback
  modified: 2026-09-22T17:47:00.000Z
---
**Why:** Opportunity's #116 evidence cited a RED sha (b885db2b) that no longer existed after two rebases; squash merges orphan every branch sha, and a reviewer cannot verify a claim whose commit is unreachable ([[gridiron-state-1259-2026-09-22]], ruled [[gridiron-state-1261-2026-09-22]]).

**How to apply:**
1. Every RED and GREEN citation in a PR body or `docs/tdd/*.tdd.md` reads: `#N` (the PR), the commit subject, then the sha. `refs/pull/N/head` survives a squash merge; a bare branch sha does not.
2. RED's failing assertion message is quoted inline in the evidence file, so the claim is checkable even if the sha is gone.
3. A rebase or amend that rewrites the cited commits updates the shas in the SAME push — never a later "fix the evidence" commit.
4. Before REAL, the Evidence Auditor runs `git merge-base --is-ancestor <sha> <reviewed-head>` for both RED and GREEN; a sha unreachable from the PR head blocks REAL.
5. Scope: fix before merge only where a cited sha is unreachable from the PR head; other PRs fix it when next touched; already-merged files stay untouched.
Pairs with [[a-branch-head-sha-is-the-whole-stack]], [[gridiron-empty-rebase-range-lesson]] and [[gridiron-five-questions-rule]].

**Refinement 17:47Z (Evidence Auditor, accepted):** the ancestry check in point 4 applies to shas cited AS EVIDENCE — "commit measured on", RED, GREEN. A sha printed deliberately as a cautionary example of a dead citation (as #116's file does with b885db2b) is not evidence and is not checked. [[gridiron-state-1262-2026-09-22]]

**Caveat 18:20Z (Trade Brain's main audit):** 198 of 324 commit-shaped citations under `docs/` (61%, 74 files) are unreachable from main because squash merges orphan branch shas. That is expected, not a defect: merged citations are preserved via `refs/pull/N/head` and are NEVER rewritten; R52.2 is scoped to the open PR's own RED/GREEN on its reviewed head. A GREEN that no longer closes on current main (e.g. valuation-map bdb97355 on f620a120) is re-measured and the new pair recorded with the reason. [[gridiron-state-1268-2026-09-22]]

**19:15Z addendum:** after any rebase the cited shas must move in the same push and each must be reachable from the new head [[gridiron-rebase-moves-evidence-shas-lesson]].
