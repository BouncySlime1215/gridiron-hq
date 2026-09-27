# TDD record: CLEANUP tracking report (plan item 20)

Base: `main` 721da970.

## Pre-registration

Metric: for each open PR, `scripts/ops/pr-cleanup-report.mjs` says `close` (main already holds the
work, or a merged replacement superseded it, and the PR is at least 7 days old), `flag` (unique
work, or unreadable), `wait` (younger than 7 days) or `keep` (on the keep list: locally owned, the
handoff branch that holds ONE-PLAN.md). The script only reads git; it never closes a PR.

Pass bar (all in `test/pr-cleanup-report.test.js`, on a throwaway git repo):

- **B1** a branch merged into main (ancestor) is `on-main`.
- **B2** a squash-merged or cherry-picked branch is `on-main`.
- **B3** a branch with any commit main never gained is `unique` and names the files; its action is
  `flag`, never `close`.
- **B4** a branch squash-merged and then rewritten on main (same lines) is `unique`, not `on-main`:
  the check errs toward keeping.
- **B5** a PR younger than 7 days is `wait` even when obsolete.
- **B6** the keep list wins; an unreadable head is `flag`; a superseded PR is `close` only when its
  replacement is merged.
- **B7** the script has no HTTP, `gh`, push or close path.

Fails it: any `unique` branch that comes out `close`, or any close path in the script.

## RED (097fa2d8)

`node --test test/pr-cleanup-report.test.js`: the script did not exist; tests 5, pass 0, fail 5.

## GREEN

Same command: tests 7, pass 7, fail 0.

Two test corrections on the way, both where the test's fixture did not match the case it named:

- **B4.** The first fixture squash-merged a one-commit branch, which is a cherry-pick, and main held
  that exact patch before rewriting the lines. The PR's change really did land, so `on-main` was
  right. The fixture now squash-merges two commits (no patch match) before main rewrites them; that
  comes out `unique`, as B4 requires.
- **Hint test.** A same-second cherry-pick onto an identical parent reproduces the same commit, so
  the "partial" branch's first commit was already main's ancestor. The hint test now uses its own
  fixture (one of two added lines reshaped onto main: 50%).

Added after the first real run (**B8**): main was re-rooted on 2026-09-24, and 102 of 126 open PRs
share no history with it. `git merge-base` fails for them, so the first run crashed instead of
classifying. Such a PR is now measured from its own GitHub base sha; with no base, or a base the
head does not descend from, it is `unreadable` (flag), never guessed. B8 pins both.

Also added: the added-lines share (a hint in the reason, never a close reason).

## Real run

126 open PRs, main 721da970, 2026-09-26 08:00 UTC: all `wait` (none is 7 days old). When eligible:
close 4 (#77 on main; #288, #377, #387 superseded by merged #443, #440, #473), flag 104 (2 unreadable,
4 with 90%+ of added lines on main), keep 18. Full table: `docs/ops/PR-CLEANUP.md`.
