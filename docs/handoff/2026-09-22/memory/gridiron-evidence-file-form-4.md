---
name: gridiron-evidence-file-form-4
description: Page 4 of the docs/tdd evidence-file standard (from ≥12:03Z 2026-09-20): scope of an "only"/"none" claim, the docs-only claim as a checkable claim, part five's cited two-file command, the runner both-outcomes clause.
metadata:
  type: project
---

Continues [[gridiron-evidence-file-form-3]].

- Scope of a claim (≥12:03Z; failure modes 145, 148): a claim of "only" or "none" states the scope it was searched over (tree, extensions, directories excluded); "the only CREATE TABLE outside test/" is a claim, "the only CREATE TABLE" was refuted by five fixtures.
- "Docs-only over <commit>" is a checkable claim (≥12:07Z; failure modes 153, 154): both commits resolve on the remote, the diff is non-empty, every path is under docs/, and the check's exit is not swallowed (an empty diff on an absent commit is not a pass). A pushed head is proven by an ls-remote line.
- PART FIVE cited form (≥12:11Z, Model audit; replaces "the check reads nothing in docs/" and "the two readers"): a docs-only child inherits its parent's figure only when `git diff --name-only <parent> <child> | grep -E '^docs/design/design-system\.md$|^docs/CLAUDE-NEXT-STEPS\.md$'` prints nothing. Reason: five test files read docs/ at runtime (deep-dive.test.js:26, stat-table.test.js:22, stat-block.test.js:23, design-system-tokens.test.js:28 read docs/design/design-system.md; nfl-execution-integrity.test.js:258 reads docs/CLAUDE-NEXT-STEPS.md); 41 test files mention docs/ in comments; docs/tdd/ and docs/evidence/ are inert. Cite the command, not a reader count (failure mode 158).
- Runner clause (≥12:11Z; failure mode 159): a runner must prove its own verification can report both outcomes (APPLIED and NOT APPLIED; clean and not clean), as the no-op control proves it for the mutation; a verification step that cannot distinguish its two outcomes has verified nothing (Model audit's absent-read-as-clean; UI's applied-read-as-NOT-APPLIED on untracked files, `git add -N` first).
- Alternation clause (≥12:13Z, chat sync's proposal, adopted; failure modes 123, 134, 163, 167): a regex or boolean alternation in an assertion is satisfied by any one branch, so each alternation branch gets its own assertion with its own message. Legitimate = closed-set membership, e.g. `/^(unavailable|[a-f0-9]{40})$/`, `/SHOTGUN|UNDER CENTER|PISTOL/`; defective = a wording alternation where only one branch is produced, e.g. consensus-weights.test.js:238 `/fewer than \d+ training rows|no measurable variance/`. Sweep and verdicts: /mnt/project-files/alternation-sweep-2026-09-20.md (28 in 20 files, a floor).
- Alternation clause, SECOND HALF (≥12:26Z, chat sync's own miss at league-chat-sync.test.js:58; failure mode 178): after splitting an alternation, re-run the motivating mutation; a replacement a neighbouring clause can satisfy is not a split (/laptop|Mac/i passed because "not the Mac" sat in the preceding sentence); a split verified only by reading is unverified. A grading rule for Model audit.
- Secrets assertions (≥12:26Z, Google sign-in, pending its measurement; failure mode 180): an assertion without a message makes node print the actual string on failure, echoing the credential into the test log; a custom message replaces that output, so the message is containment, not only naming.

Continues: [[gridiron-evidence-file-form-5]].
