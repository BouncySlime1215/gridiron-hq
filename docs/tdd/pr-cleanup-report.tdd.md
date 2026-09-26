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

## RED

## GREEN
