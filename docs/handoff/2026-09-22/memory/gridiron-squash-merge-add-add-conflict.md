---
name: gridiron-squash-merge-add-add-conflict
description: A branch cut from a PR head that later SQUASH-merged hits add/add conflicts on every file that PR added; how to resolve it safely.
metadata:
  type: project
  modified: 2026-09-22T17:51:23.478Z
---

**2026-09-22.** #86 squash-merged as `7eca9a8`. Every branch cut from its head
before that merge now hits an **add/add conflict** — not a content conflict — on
each file #86 *added*, because the squash gave `main` its own copy with no
shared history.

Seen on `claude/project-thread-xiezr0-position-applicability` (#118) for
`server/services/player-advanced-stats.js` and
`client/src/components/AdvancedStatsPanel.tsx`.

**Resolving to your own side is correct, but only after this check:**

    git diff origin/main <the-PR-head-you-cut-from> -- <file>

Empty means `main`'s copy is byte-identical to the head you branched from, so
your copy is that same content plus your work and nothing from `main` is lost.
Non-empty means somebody changed the file on `main` after the squash and you
must merge by hand. Then:

    git checkout --ours -- <files>   # --ours = your branch, in a merge
    git add <files>
    # verify: each file identical to your pre-merge commit
    git diff --cached <your-pre-merge-sha> -- <file>

**Why it matters:** the tempting move is `--ours` without the diff, which
silently discards any post-squash change to those files. The diff turns "I
assume nothing else touched it" into "nothing else touched it".

**This project squash-merges everything**, so expect it for every PR that adds
files. Related: [[gridiron-pr-board-2026-09-22]].
