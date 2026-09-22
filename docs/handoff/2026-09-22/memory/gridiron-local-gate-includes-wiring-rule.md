---
name: gridiron-local-gate-includes-wiring-rule
description: "RESOLVED 2026-09-22 18:00Z — `npm run check` now INCLUDES `check:wiring` as of main c90d2834 (#129), so the gate is one command; the history of why is below"
metadata:
  type: feedback
  modified: 2026-09-22T18:10:00.000Z
---
**Why:** `package.json` `check` (`:20`) = typecheck && lint && test && build && start:smoke and does NOT include `check:wiring` (`:36`). `.github/workflows/ci.yml:69-70` runs `check:wiring` between Lint and Test — BEFORE the tests — so a red on that step means CI ran zero tests. Main went red at 144b722 (17:07Z) on exactly that step with three false positives, and every "one clean run" quoted before 17:13Z had never exercised the wiring gate at all ([[gridiron-check-script-omits-wiring-gate]], [[gridiron-state-1250-2026-09-22]]).

**How to apply:**
1. The gate for "one clean run" is `npm run check && npm run check:wiring` under one guard, on the branch merged with current origin/main, tree asserted in the log. A rundown that omits the wiring line is not a clean run.
2. A check:wiring finding is triaged like any other: genuine (fix or wire it), pre-registered (annotation with owner and the PR it waits on, e.g. `cascade-grade.js` for #72), or false positive (fix the analyser, not the annotation).
3. **RESOLVED 2026-09-22 ~17:55Z. #129 merged as `c90d2834` and `package.json:20`
   now reads `typecheck && lint && check:wiring && test && build && start:smoke`.
   The gate is therefore `npm run check` alone**, and it is the first local
   command in this project's history that exercises everything CI exercises.
   Verified on `claude/project-thread-w0gpjt` @ `91ed5f1a` (tree `f5969717`):
   `npm run check` exit 0, 3,553 tests / 3,512 pass / 0 fail / 41 skipped, and
   `check:wiring` run a second time explicitly also exit 0.
4. **Still run `check:wiring` explicitly as a second command for one release
   cycle.** Confirming the inclusion costs seconds; assuming it is exactly how
   every thread's "clean run" was a strict subset of CI for weeks. Drop the
   second run only once someone has seen `check` fail on a wiring finding.
5. `#129` also added `test/check-script-covers-ci.test.js`, which pins the
   inclusion, so a future edit that drops `check:wiring` from `check` fails the
   suite rather than silently re-opening the gap.
Pairs with [[gridiron-verify-once-and-model-by-weight]] (one run, on the merged tree) and [[gridiron-rebase-before-merge-lesson]].
