---
name: gridiron-add-add-squash-conflict-lesson
description: Lesson (UI #118, 17:58Z) — a branch cut from a pre-squash head hits add/add conflicts on the squashed files when it rebases onto main; take your side only after `git diff origin/main <old-base>` is empty for those files
metadata:
  type: project
  modified: 2026-09-22T18:01:00.000Z
---
**Why:** UI's #118 was cut from a head that contained #86's commits unsquashed. When #86 squash-merged (7eca9a8b) and #118 rebased onto main, git saw the same files added twice with different histories and reported add/add conflicts on files #118 never edited. Nothing was actually in conflict — both sides held the same content — but "take ours" is only safe when that is proven, because a real divergence on one of those files would be silently discarded.

**Rule:** before resolving an add/add conflict by taking your side, run `git diff origin/main <old-base> -- <files>`; it must be EMPTY for every conflicted file. Then take your side and verify the result is byte-identical to main (UI did: #118 head 79b39676, check 0). If the diff is not empty, the conflict is real — merge by hand. Pairs with [[gridiron-empty-rebase-range-lesson]] (stacked branches rebase with the OLD base as upstream) and [[gridiron-rebase-before-merge-lesson]]. Origin [[gridiron-state-1280-2026-09-22-part2]].
