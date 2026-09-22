---
name: gridiron-merge-gate-self-audit-skill
description: "Threads load skill `gridiron-merge-gate-v2` (Nick saved 18:13:38Z 2026-09-22; v1 superseded) before every push; its results go in the PR body under a 'Merge gate' heading; v2 adds the liveness proof, ONE five-questions list (Nick's 2026-09-20 five, with the four PR facts under the same heading), the fresh-session rule and four lessons"
metadata:
  type: feedback
  modified: 2026-09-22T18:22:00.000Z
---
**Which skill:** `anthropic-skills:gridiron-merge-gate-v2` (the prefix is required — bare name = "Unknown skill" [[gridiron-skill-prefix-lesson]]), SAVED by Nick 18:13:38Z (asked 18:11:04Z "where is the skill", answered by the card post). **v1 (`anthropic-skills:gridiron-merge-gate`, saved 18:06Z) is superseded — load v2, not v1.** v2 was proposed as a NEW skill because the improvement path needs a file read the coordinator session cannot do. Gate text: [[gridiron-merge-gate-rule]].

**What v2 makes threads report in the PR body under "Merge gate":**
1. One guard run on one tree: `npm run check` command + exit code, head sha, tree hash.
2. TDD record: RED/GREEN cited per R52.2 (#N + subject + sha, RED assertion inline).
3. **Liveness proof per behaviour change** (new in v2): RED fails on the unfixed code, or a named mutant dies. CI green alone missed #130's two dead tests, #135's surviving mutant and #119's false note.
4. **Five questions — ONE list only, Nick's 2026-09-20 01:21Z** ([[gridiron-five-questions-rule]]): well built / stats or made up / how do we know / pointed anywhere else / how does it unify. **The four PR facts sit under the same heading**, not as a second list: defect with file:line on a stated tree; incumbent by command; what the change does NOT cover; what would make it wrong. (v1 had a separate skill-five; that split is gone.)
5. Hard rules + lessons carried in v2: fresh-session restart from the handoff once PRs land [[gridiron-restart-fresh-from-handoff-rule]]; db-local-name false finding [[gridiron-db-local-name-false-finding-lesson]]; subtree hashes for population claims (R62); absence-field (unknown/unreadable is not "no record", R58); never edit a shared script in place — new path (verify2x v4→v5).
6. Merge: owning thread squash-merges on CI green on the exact head; model / projection / trade-valuation / lineup / inventory-number PRs ALSO go to the Independent Auditor first (R63 scope). Docs-only or pre-registration PRs with no RED/GREEN: say so with the reason, do not omit the section.

**Second skill `anthropic-skills:gridiron-token-efficiency` SAVED by Nick 18:17:52Z** (six sections: start cold from handoff; one run, one read; report by milestone; right-size the model/thread; measure via `/mnt/project-files/USAGE-LEDGER.md`; keep improving) — from Nick's 18:16:38Z rule that any procedure repeated twice becomes a skill proposal the same day [[gridiron-usage-priority-rule]].

**How to apply:** invoke v2 before pushing, on the exact tree you are about to push; a body without the block stalls on a formatting gap, not a finding. Origin [[gridiron-state-1288-2026-09-22]].
