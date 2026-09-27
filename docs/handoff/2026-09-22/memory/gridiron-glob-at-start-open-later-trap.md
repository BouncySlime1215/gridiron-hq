---
name: gridiron-glob-at-start-open-later-trap
description: A suite run against a checkout switched mid-run reports ERR_MODULE_NOT_FOUND on the stack's own new test files, which looks exactly like the stack breaking its own tests — and the standing method that prevents it.
metadata:
  type: feedback
---

**The trap.** `npm test` here is
`node --test --test-concurrency=1 test/*.test.js`. The shell **globs the
directory once, at start**, but node **opens each file when its turn comes**.
So if anything checks that working tree out to another branch while the run is
in flight, every test file that exists only on the branch under test vanishes
underneath the runner.

**Why it is dangerous rather than merely annoying.** The failure names the
stack's **own new test files** and reports `ERR_MODULE_NOT_FOUND`, so it reads
as *"the merged stack breaks the tests it adds"* — the exact shape of a real
regression, in the exact files a reviewer would look at first. Hit on
2026-09-20: a merged-tree run came back 2978 / 2 fail, the two being
`timer-tier-off-thread.test.js` and `watchdog-arming-sources.test.js`. Both were
artefacts. **Never quote 2978 / 2 fail.**

**The tells, in order of how fast they settle it.**
1. `ERR_MODULE_NOT_FOUND` on a path under `test/` — a test that ran and failed
   does not say that.
2. The total is *short* of the expected figure rather than equal to it with
   failures. Eight short here.
3. `git reflog show --date=iso HEAD` on that checkout, with a checkout inside
   the run window.

**The standing method for any merged-tree or branch-comparison run:** a
dedicated `git worktree`, with its own `npm ci`, and `git rev-parse HEAD^{tree}`
recorded **before and after** the run beside the numbers. A tree hash that
changed across the run voids it, whatever the numbers say.

**State the isolation kind on every figure (coordinator, project-wide 2026-09-20).** Record `git write-tree` (or `git rev-parse HEAD^{tree}`) AND the `node_modules` mtime either side of every run, and label the figure **isolated** (own `npm ci`, node_modules a real directory) or **source-isolated** (own source tree, node_modules symlinked to another checkout). A tree or mtime that changed across the run voids it whatever the numbers say. Three separate threads each voided a run on 2026-09-20 for a different invisible reason, which is why this is a verification rather than a procedure.

**Partial isolation is a real risk worth naming.** The `wt-*` worktrees in this
session symlink `node_modules` to the main checkout's. That is enough against a
mid-run *checkout switch*, which is what this trap is, and **not** enough
against a mid-run `npm ci` — that would pull the dependency tree out from under
every worktree at once. State which isolation a run actually had.

**The cheap independent check on a stack of branches:** diff the *passing test
names* between consecutive runs, not just the totals. Each step should add
exactly the tests that branch claims to add and **lose nothing**. On the
o3wt2p stack: #56 → #59 +10, #59 → #61 +9, #61 → #63 +5, nothing lost at any
step. That catches a branch quietly displacing a test rather than adding one,
which a total alone cannot. It also found that #63 adds **five** tests, not the
four its body counted — the fifth, `an arm that arrives before the watchdog
starts is not lost`, went into the existing `test/loop-watchdog.test.js` — which
is why its suite figure is 2980 against a claimed 2979.

Pairs with [[gridiron-pr-body-numbers-must-be-rebuildable]] and
[[ci-disabled-local-checks-are-the-gate]].
