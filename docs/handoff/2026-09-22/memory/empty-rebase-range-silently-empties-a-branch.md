---
name: empty-rebase-range-silently-empties-a-branch
description: "`git rebase --onto <new> <upstream>` with the branch head as upstream succeeds, reports success, and leaves the branch with none of its work on it."
metadata:
  type: project
  modified: 2026-09-22T17:15:20.902Z
---

When rebasing a stacked branch after its base has merged, the upstream
argument must be the **old base**, never the branch head:

    # WRONG - range HEAD..branch is empty, branch silently becomes origin/main
    git rebase --onto origin/main <branch-head> <branch>

    # RIGHT - range <old-base>..branch is the work to replay
    git rebase --onto origin/main <old-base> <branch>

The wrong form does not error. It prints "Successfully rebased and updated",
exits 0, and leaves the branch pointing at the new base with none of its
commits. The only signal is that `git diff --stat origin/main HEAD` comes
back empty.

**Why:** 2026-09-22, Opportunity thread, rebasing #116 after #99 merged. The
branch head and the previous rebase target were both in mind at once and the
head went into the upstream slot. Caught by the empty diff, recovered with
`git reflog <branch>` — the dropped commits were still reachable by sha.
Nothing was pushed in the broken state.

**How to apply:**
- After any rebase, before pushing, run
  `git diff --stat <base> HEAD` and confirm the file count and insertion
  count match what the branch is supposed to add. An empty or wrong-sized
  diff is the whole signal.
- Recover with `git reflog <branch>`; the pre-rebase head is entry `@{1}`.
  `git checkout -B <branch> <that-sha>` restores it, then redo the rebase
  with the correct upstream.
- This gets more likely, not less, the more times a base moves under a
  stacked branch — and a fast-moving main means several rebases in a row.

Related: [[verify-the-merge-not-just-the-head]] and
[[npm-check-does-not-run-the-wiring-gate]] — all three are cases where a
command reported success while measuring or preserving nothing.
