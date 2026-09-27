---
name: cite-the-subtree-not-the-write-tree
description: "A document that cites its own commit write-tree invalidates that citation the moment the document is edited — cite the hash of the measured subtree instead."
metadata:
  type: feedback
  modified: 2026-09-22T17:58:45.997Z
---

When an evidence file records a measurement, cite the **tree hash of the
directories actually measured**, never the commit's `git write-tree`.

    # WRONG - changes every time this very document is edited
    git write-tree                          -> 02096ca5

    # RIGHT - moves only when the measured code moves
    git rev-parse HEAD:server/services      -> 2c900fff
    git rev-parse HEAD:server/modeling      -> 6bbd8e6a

**Why:** 2026-09-22, `scripts/reach-ladder.mjs`. Two separate failures, one
after the other:

1. The evidence file said "on current main, `write-tree 02096ca5`".
   `02096ca5` was **the branch's** tree, not main's — main had `6c00c129`.
   A correct figure sitting beside a wrong tree, in a document whose whole
   thesis is that a figure must carry its tree.
2. Fixing it by citing the *new* `write-tree` went stale **while being
   typed**: writing the correction into the document changed the tree the
   correction named. A self-invalidating citation.

The subtree hash has neither problem. It is also the honest referent: the
figures are a count over those directories, so that is what they are a
statement about.

**How to apply:**
- Before attributing a population figure to `main`, check whether the branch
  changes the measured directories at all. Compare subtree hashes — if they
  are byte-identical, the number is **main's**, measured on a branch that
  does not disturb it. Do not let a reviewer's "N = base + your files"
  arithmetic stand unchecked; here the +2 was main's own churn (three files
  added, one removed) and none of the branch's three files could enter the
  population, all living outside the measured directories.
- **A line number is only a fact about the tree it was read on.** The same
  session cited `scheduler.js:714-721`, which was *correct* at the
  falsification tree `b0c1616d` and wrong at `f620a120` (there `:737-742`,
  docblock `:728`). A cite that outlives its tree is a different defect from
  a fabricated cite, and only the first is repaired by carrying the tree.
- Do not assert "this cite matches no tree in the history" without checking
  every candidate tree. That claim was made here and was false.

Related: [[gridiron-evidence-citation-rule]] and
[[falsy-return-read-as-a-real-negative]] — all cases where something read as
verified while referring to less than it appeared to.
