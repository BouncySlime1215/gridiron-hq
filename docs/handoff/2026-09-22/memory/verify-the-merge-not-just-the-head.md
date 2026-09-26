---
name: verify-the-merge-not-just-the-head
description: A clean local run on a branch head does not predict CI, because CI tests the branch merged with main; verify the merge before pushing.
metadata:
  type: project
  modified: 2026-09-22T16:47:38.958Z
---

Before pushing a branch, run the suite on **the branch merged with current
main**, not on the branch head alone. GitHub's `on: pull_request` builds the
merge commit, so a local run on the head is measuring a tree nobody merges.

**Why:** 2026-09-22, PR #99. Two clean pre-push runs on `b0c1616d` gave
3027 tests / 0 fail, twice, with a write-tree guard either side. CI on the
same commit reported **3152 tests and 1 failure**. The extra 125 tests came
from main's newer commits, which the branch was not based on. The
verification was rigorous and still said nothing about what CI would run.

This is not specific to one thread. Any branch cut from an older main has
the same blind spot, and the older the base, the wider it gets.

**How to apply:**
- `git fetch origin main && git merge origin/main` into the branch, then run
  the check on that tree, then push. A detached worktree at the merge keeps
  the primary tree clean while it runs.
- When a figure is measured from the code, say which tree it was measured
  on. The same measurement gave 123 on the branch head and 118 after merging
  main — five files left the set purely because main moved, not because
  anything about the branch changed.
- A red CI on a PR is not automatically the PR's fault. Reproduce on the
  merge, then reproduce on **bare main** in a detached worktree. If it fails
  there with the branch absent, it is main's regression, and the honest
  move is one comment on the PR saying so rather than a speculative fix.

Related: [[gridiron-file-allocation]] for whose files a regression belongs
to once it is located.
