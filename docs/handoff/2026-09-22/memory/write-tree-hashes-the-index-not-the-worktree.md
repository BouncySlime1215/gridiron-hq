---
name: write-tree-hashes-the-index-not-the-worktree
description: git write-tree hashes the INDEX, so the project's TREE-HASH RULE cannot see an unstaged edit landing mid-run — pair it with git status --porcelain (proved 2026-09-22).
metadata:
  type: feedback
  modified: 2026-09-22T06:23:48.535Z
---

**`git write-tree` hashes the index, not the working tree.** The project-wide
TREE-HASH RULE in [[gridiron-suite-figure-rule]] says every suite run records
`git write-tree` before and after, and that a changed tree voids the run. As
written, **that guard cannot see an unstaged working-tree edit**, which is the
most likely way a run gets corrupted.

**Proved, 2026-09-22 ~06:20Z, wiring-map thread, at `bd840c0`:** wrote a byte
into `docs/wiring/wiring-map.json` in the working tree, left it unstaged, ran
`git write-tree` — identical hash, `b295e1fa60c5875411cbd735bca6be037fbb2153`,
before and after. `git status --porcelain` showed the file as ` M`.

**Why the rule appeared to work anyway.** The one case it did catch — commit
`ceb4548` landing inside a run window — was a *commit*, and a commit updates the
index. Every void it has ever caught was of that shape. The failure mode it was
written for, a file changing under a running suite, is the one it is blind to.

**The corrected rule:** record **`git status --porcelain` AND `git write-tree`**
either side of every run, plus the `node_modules` mtime. Non-empty status either
side, or a changed tree hash, or a changed mtime, voids the run. Status is the
load-bearing half; write-tree only adds the staged/committed case.

**How tonight's figure survives this.** The `npm run check` at `bd840c0`
(3138 / 3097 / 0 fail / 41 skipped, exit 0) is still good, but **not because of
the hash** — because `git status --porcelain` was separately checked and empty
during the run and again at the end. Any *earlier* figure on any thread that
rests on `write-tree` alone rests on less than it claims; it is not thereby
wrong, it is just unproven against unstaged edits.

**Immediate instance of exactly this risk:** `node scripts/wiring-map.mjs
--check` rewrites `docs/wiring/wiring-map.json` as a side effect (only
`generated_at` changes). A validate-only flag that writes is precisely the
unstaged mid-run edit the old guard would have missed. See
[[a-checkout-voids-a-running-suite]] for the sibling trap.

Same family as the rest of [[gridiron-failure-modes]]: **a true observation with
the wrong mechanism attached.** The rule's conclusion (pin the tree) was right;
its instrument was measuring something else.
