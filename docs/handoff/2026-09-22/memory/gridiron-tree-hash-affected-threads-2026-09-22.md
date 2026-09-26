---
name: gridiron-tree-hash-affected-threads-2026-09-22
description: Which threads tonight (2026-09-22) cited a stable git write-tree hash alone as mid-run proof, per the correction on gridiron-tree-hash-rule-correction-2026-09-22.
metadata:
  type: feedback
  modified: 2026-09-22T06:36:01.358Z
---

Companion to [[gridiron-tree-hash-rule-correction-2026-09-22]] — that
file has the mechanism; this has the who.

**Who this affects.** Every thread tonight that quoted a stable
`git write-tree` hash as its *complete* mid-run proof, without also
stating `git status --porcelain` was checked/empty throughout, has proof
weaker than presented — not necessarily wrong. Nothing found so far
indicates any of them actually had an uncaught mid-run edit; most likely
had clean status throughout simply because they weren't editing files
mid-run.

Found citing write-tree alone (no explicit git-status statement beside
it):
- [[trade-brain-stop-snapshot-2026-09-22-0546Z]] — "write-tree and
  node_modules mtime identical either side."
- [[gridiron-pr-body-diffs-2026-09-22]] — "git write-tree matched
  before/after every run."

Found already doing both (good pattern, no correction needed):
- [[suite-check-a-merge-without-touching-a-branch]] — records write-tree
  in the primary tree before/after AND `git status --porcelain` count
  both sides.

**Not exhaustive.** Built from a `write-tree` grep across memory tonight,
not a full transcript audit. Absence from this list is not a clean bill;
presence is not proof of a real gap. Re-check the specific thread's own
record if its figure matters to a decision.
