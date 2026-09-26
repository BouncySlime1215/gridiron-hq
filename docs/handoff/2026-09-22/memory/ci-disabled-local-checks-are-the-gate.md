---
name: ci-disabled-local-checks-are-the-gate
description: The repo's only workflow is still disabled_manually so a push triggers nothing and local checks are the entire gate - but the minutes cap that caused it is STALE (repo is public now) and our token cannot re-enable it anyway.
metadata:
  type: project
---

2026-09-20 ~01:04Z, from Nick: the account's GitHub Actions limit is hit —
**2,000 of 2,000 minutes used, resets 1 October 2026.**

**Verified directly, not taken on relay:** the repo has exactly ONE workflow,
`CI` / `.github/workflows/ci.yml`, id `357164314`, and its state is
`disabled_manually` (set 2026-09-19T21:06:42-04:00). A push therefore triggers
nothing.

## UPDATE 2026-09-22 02:38Z -- two facts, both API-verified, that change this
1. **The minutes cap no longer applies.** `search_repositories` on the repo
   returns `"private": false, "visibility": "public"`. Public repositories get
   unlimited Actions minutes, so "there are no minutes to spend" is no longer
   the reason for anything. Do not present re-enabling to Nick as a spend risk.
   What remains is `timeout-minutes: 20` in ci.yml, which cut off every run on
   main until #7. Four full `npm run check` runs on 2026-09-22 came in at
   **325-331 s (~5.5 min)** -- strong indication it now fits, but that is a
   container, NOT the CI runner, and CI has still never been observed passing.
2. **We could not re-enable it even if told to.** The same read returns
   `permissions: { admin: false, maintain: false, push: true, triage: true,
   pull: true }`. Enabling a `disabled_manually` workflow is an admin/maintain
   operation. So that is Nick's hands in the GitHub UI regardless of who
   authorises it -- it is a permission fact, not a policy choice. `triage: true`
   does cover closing PRs and `push: true` does cover deleting branches, so
   those two are mechanically possible and must not be lumped in with it.
   Workflow re-read the same minute: still `disabled_manually`.

## The rules that follow
- **Do not re-enable that workflow or re-run any run on your own initiative**,
  and note you lack the permission to anyway. Listing workflows is read-only and
  fine; re-enabling, re-running and dispatching are not yours to do.
- **Every push must be preceded by a full local check, stated with numbers** in
  whatever message reports the push. Not "tests pass" — the counts.
- Nick briefly froze pushes entirely (01:04Z) and lifted the freeze for pushes
  only (01:09Z) once the workflow was confirmed disabled. If a future freeze
  arrives, it is about Actions minutes, not about the work.

## What this changes about the PR posture
The standing "drive the PR to green" loop assumes CI reports something. Here it
reports nothing, so **a green check will never arrive and waiting for one is
waiting forever.** The local run IS the verification, and a PR's readiness is a
claim made by whoever pushed it rather than a fact a check attests. That makes
the number-stating rule above the only thing standing between a broken push and
nobody noticing.

## The local check for this repo
```
npm ci          # CLAUDE.md: required before trusting any suite number; a fresh
                # clone fails offline-guard tests with ERR_MODULE_NOT_FOUND,
                # which looks exactly like a regression and is not
npm run lint       # syntax across ~876 JS files
npm run typecheck  # tsc --noEmit, covers the TS/TSX the linter does not
npm test           # test/*.test.js, concurrency 1, under a 20-minute budget
```
`npm test` sets `GRIDIRON_DB_PATH` to a temp file, `SCHEDULER_DISABLED=1`, and
imports `test/offline-guard.mjs` — so it never touches the live app or network.

RETIRED 15:24Z: Nick re-enabled Actions himself 14:52Z; public repo, free; see state 1199/1198.
