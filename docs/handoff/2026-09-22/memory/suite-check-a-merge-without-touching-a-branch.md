---
name: suite-check-a-merge-without-touching-a-branch
description: How to run the full suite on the merge of a PR head with main while a branch freeze is in force — a dangling merge commit in a detached worktree, with node_modules hard-linked so no npm ci is needed.
metadata:
  type: feedback
---

Under Nick's 2026-09-22 01:25Z rule (no pushes, no PRs, main never touched) a
merged-tree suite figure still has to be producible. It is, with no branch
created, moved or deleted:

```
TREE=$(git merge-tree --write-tree "$BASE" "$HEAD")        # conflicts -> non-zero, no tree
COMMIT=$(git commit-tree "$TREE" -p "$BASE" -p "$HEAD" -m "local merge check")
git worktree add -q --detach "$WT" "$COMMIT"
cp -al "$REPO/node_modules" "$WT/node_modules"
npm run check                                              # read the exit status
```

**Why each part.**
1. `merge-tree --write-tree` writes the merged tree into the object store
   without a working tree and without a ref. `commit-tree` hangs a commit off
   it with both parents. Nothing points at that commit, so `git prune` collects
   it and no branch ever moved — the merge is real enough to run and invisible
   to the remote.
2. `--detach` keeps the worktree off every branch, so the primary checkout can
   keep working; the worktree is what stops a checkout voiding the run
   ([[a-checkout-voids-a-running-suite]]).
3. `cp -al` hard-links `node_modules` instead of running `npm ci`. Every run
   then has byte-identical dependencies, to each other and to the tree the
   PR-body figures were measured in, so a difference in the numbers can only be
   the source. It also saves the install time and the disk, which matters on a
   fixed session allowance. Verify it worked by recording the `node_modules`
   mtime either side — unchanged means nothing reinstalled.

**Record with every figure**, or it is not a measurement: the merged tree sha,
`git write-tree` in the *primary* tree before and after (a mismatch voids the
run), `git status --porcelain` count both sides, the `node_modules` mtime both
sides, the isolation label, the `npm run check` exit status, and all four suite
numbers. See [[gridiron-suite-figure-rule]].

**What the figure does not say.** A merged-tree number is not the PR head's
number — the merge adds main's commits, so it is legitimately different and is
not a correction to the PR body ([[gridiron-cite-the-shipping-tree]]). And a
clean textual merge with zero file overlap is *not* a passing suite: the three
PRs checked on 2026-09-22 overlapped no file with main's three new commits and
the run was still the only thing that proved them green. One run per tree also
cannot show a flake; say so rather than implying the tree is settled.

Runner kept at `scratchpad/merged-run.sh <pr> <head> <base>`.
