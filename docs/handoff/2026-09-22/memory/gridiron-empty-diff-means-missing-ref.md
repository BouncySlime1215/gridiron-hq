---
name: gridiron-empty-diff-means-missing-ref
description: git answers an unfetched commit with an empty diff rather than an error — on gridiron-hq, always fetch the ref before diffing it, and read an unexpectedly empty diff as "object missing" until proven otherwise.
metadata:
  type: feedback
  modified: 2026-09-20T07:40:00.000Z
---

**2026-09-20 07:35Z: `git diff 791b131 caac88a -- <file>` printed nothing, and
I nearly reported "the wiring map did not change that file".** The real diff is
+19/-4. It printed nothing because that commit had not been fetched into this
clone yet; git answered with silence rather than "unknown revision".

**Fetch the ref first, then diff.** `git fetch origin --quiet` before any
comparison against another thread's head. And treat an unexpectedly empty
result as a missing object until a `git cat-file -t <sha>` says `commit` AND a
re-run after fetching still comes back empty.

This is the same family as the three checks that went wrong tonight:

- diffing a branch against **its own PR head** and concluding it is empty
  ([[gridiron-o3wt2p-branch-ledger]]);
- an import-graph scan calling `fork(new URL(...))` targets orphans
  ([[gridiron-import-graph-orphans-are-not-dead]]);
- a grep that **excludes the defining module** and calls a same-file export
  unused.

All four share one shape: **the tool answered honestly about the wrong
question, and the answer looked like a finding.** Before reporting any "X is
missing / unused / empty / dead", state what was actually compared or searched
and check that it is the question you meant to ask.

Related: [[gridiron-cite-the-shipping-tree]], [[gridiron-docs-claims-rot]].
