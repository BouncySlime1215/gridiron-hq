---
name: github-actions-exhausted-2026-09
description: GitHub Actions minutes for gridiron-hq are spent until 2026-10-01; the CI workflow is disabled_manually, so pushes trigger nothing and must be validated locally.
metadata:
  type: project
---

2026-09-20 01:04Z Nick hit the account's GitHub Actions limit: 2,000 of 2,000
minutes used, **resets 2026-10-01**. The coordinator froze pushes, then lifted
the freeze once the workflow was disabled.

**State, verified 01:10Z via the Actions API:** the repository has exactly ONE
workflow, `.github/workflows/ci.yml` ("CI", id 357164314), and its state is
`disabled_manually` (updated 2026-09-19T21:06:42-04:00). A push therefore
triggers nothing — confirmed after pushing 20cf7d4 to PR #47:
`get_check_runs` returned `total_count: 0`.

**Standing rules while this holds:**
- **Never re-enable the workflow and never re-run a run.** Both spend minutes
  that are not there, and a re-run is the reflex to resist on a red PR.
- Every push is preceded by the full local check, stated with its numbers:
  `npm run lint`, `npm run typecheck`, `node --run test`. On 2026-09-20 that
  was 877 files linted, typecheck exit 0, 2,957 tests / 2,916 passed / 0 failed
  / 41 skipped, ~300 s.
- **A PR opened now shows no checks at all, and that is not a failure.** Say so
  in the PR body rather than leaving a reviewer to hunt for a missing tick, and
  name the commit CI was last green on.
- The drive-to-green rules still apply in substance, but "re-run the job once to
  confirm a flake" is unavailable here: make the test robust within the PR's
  scope, or say so once.

RETIRED 15:24Z: Nick re-enabled Actions himself 14:52Z; public repo, free; see state 1199/1198.
