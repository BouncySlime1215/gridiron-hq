---
name: gridiron-empty-rebase-range-lesson
description: Lesson (Opportunity #116, 17:2xZ) — after a stacked branch's base merges, rebase with the OLD base as upstream, never the branch head, and verify `git diff --stat origin/main HEAD` is non-empty before pushing
metadata:
  type: feedback
  modified: 2026-09-22T17:26:00.000Z
---
**Why:** #116 was stacked on #99's branch. After #99 merged (c5ee3b54), Opportunity rebased #116 onto main using the wrong upstream, which produced an EMPTY rebase range — every commit of #116 was considered "already upstream" and dropped, leaving a branch identical to main. It was recovered from the reflog and re-pushed as 28b801b8 on base f620a120 ([[gridiron-state-1255-2026-09-22]]). A pushed empty branch would have looked like a clean, green PR with no diff.

**How to apply, when the base of a stacked branch has merged:**
1. `git rebase --onto origin/main <OLD-BASE-SHA> <branch>` — the upstream argument is the OLD base (the merged branch's last head), never the stacked branch's own head and never bare `origin/main`.
2. Before pushing: `git diff --stat origin/main HEAD` must be NON-EMPTY and list the files the PR is supposed to change; `git log --oneline origin/main..HEAD` must show the expected commits.
3. If the range is empty, stop; `git reflog` has the pre-rebase head — reset to it and redo step 1.
4. State the new head and base in the PR body; the Evidence Auditor's REAL refers to that head.
Pairs with [[gridiron-rebase-before-merge-lesson]] and [[a-branch-head-sha-is-the-whole-stack]].
