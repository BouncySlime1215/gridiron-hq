---
name: gridiron-rebase-moves-what-a-commit-proves
description: "A rebase can move which commit closes a RED/GREEN pair, not just its sha; and 61% of main's cited shas are unreachable because the repo squash-merges"
metadata:
  type: feedback
  modified: 2026-09-22T17:37:21.603Z
---

**A rebase rewrites shas, and the figures go with them — but it can also change
which commit is the GREEN.** On #100 (2026-09-22), rebasing onto `f620a120`
left `bdb97355` ("fix: selfRead says which of three things happened…") red on
its own: 114 tests, 112 pass, 2 fail. The rebase brought in main's
`transactionsCollected`, which reads `last_seen_at` unguarded, so `G5e2` threw
`ERR_SQLITE_ERROR` out of the accessor (`manager-signals.js:585` via
`selfRead` at `counterparty-pricing.js:1049`) before `selfRead`'s answer was
reached. The pair only closes two commits later at `f7977515` (116/116/0). The
same rebase moved the other pair's counts (RED 24/23/1 → 28/27/1, GREEN 25/25 →
29/29) purely from main's additions to the test file.

**Why:** zero file overlap does not mean no interaction — the same lesson as
#89/#91. A RED/GREEN record is a claim about a tree, so after a rebase every row
is unmeasured until re-measured at its commit, and relabelling shas without
re-running hides a moved GREEN.

**How to apply:** after any rebase, re-run each cited commit in a detached
worktree (`git worktree add --detach <dir> <sha>` + `cp -al node_modules`) and
write down what it actually produces. Carry the RED's failing assertion text,
not its line number — a line number moves with the tree. If a middle commit is
red on the new base, say so in the table rather than reordering history.

**Do not sweep main for unreachable shas.** An audit of every commit-shaped
citation in `docs/tdd`, `docs/inventory` and `docs/evidence` on `origin/main`
found 324 resolvable, **198 of them (61%, across 74 files) unreachable from
main** — the normal consequence of squash-merging, not a defect. The
reachability rule (Auditor R52.2) belongs to an OPEN PR's own head; merged
citations are preserved by `refs/pull/N/head` and must not be rewritten.

See [[gridiron-wiring-gate-landed-red]], [[gridiron-rebase-before-merge-lesson]].
