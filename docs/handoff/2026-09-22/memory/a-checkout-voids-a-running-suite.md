---
name: a-checkout-voids-a-running-suite
description: Running the suite in the main checkout and then switching branches mid-run silently voids the run; the failures look like real regressions in the new tests.
metadata:
  type: feedback
---

Started `npm ci && npm test` on a merge-rehearsal branch in
`/home/user/gridiron-hq`, then — while it was still running — did
`git checkout` back to the docs branch to edit a file. The suite finished with
**2 failures**, and both were in test files that exist only on the branch I had
switched away from:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
  '/home/user/gridiron-hq/test/timer-tier-off-thread.test.js'
```

**Why:** the test script globs `test/*.test.js`, so the file list is fixed when
the command starts, but each file is read when its turn comes. A checkout
deletes the ones the other branch does not have, and by then the runner is
holding a path that no longer exists. The totals came out eight tests short of
the expected figure as well, which is the other half of the same tell.

**Why it is dangerous rather than merely wrong:** the failures name the branch's
own new tests. Read without the timeline it says "the merged stack breaks the
tests it adds", which is a serious-looking and completely false result. It cost
nothing here only because `git reflog --date=iso` put the checkout inside the
run's window and settled it in one command.

**How to apply.** Any suite run that has to survive other work runs in its own
worktree:

```
git worktree add <scratchpad>/stack <branch>
cd <scratchpad>/stack && npm ci && npm test
```

The worktree has its own files and its own `node_modules`, so the main checkout
can switch branches freely. Check `git rev-parse HEAD^{tree}` before and after
the run and record it beside the numbers — a figure whose tree was not pinned at
both ends is not a measurement. Related: [[gridiron-failure-modes]].
