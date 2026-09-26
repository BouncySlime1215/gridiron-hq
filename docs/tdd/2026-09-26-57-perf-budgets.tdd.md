# 57 PERF BUDGETS IN CI

`scripts/perf-budgets.mjs` (bundle bytes, enforced in CI) and `scripts/perf-longtasks.mjs`
(long tasks on a view switch, report only). Tests: `test/perf-budgets.test.js`.

## Pre-registered bar (written before the implementation, RED commit 765afd59)

- B1 The seven areas are derived from `navigation.ts` + `App.tsx`; an area with no lazy page throws.
- B2 First load = entry closure + page closure (JS + CSS), each file once, dynamic imports excluded.
- B3 Exactly +10% gzip passes; +10.1% fails; smaller is "improved".
- B4 A new area with no baseline, or a baseline area that vanished, fails.
- B5 The committed baseline budgets exactly the seven areas at 10%.
- B6 CLI: exit 1 on a breach under `GRIDIRON_PERF_BUDGETS=enforce`, 0 in report mode, 2 with no manifest.
- B7 Two clean builds of the same tree give the same bytes (no false failures).
- B8 A real planted growth on one area fails CI; a planted 80 ms task on a switch is reported OVER.
- Would fail it: any of the above not holding, or the long-task probe reporting zeros while blind.

## Measured (Linux cloud container, Node 22.22.2, Chromium 1194)

- RED: `node --test test/perf-budgets.test.js` 0 pass 1 fail (module missing).
- GREEN: 11 pass 0 fail. Full `npm test`: 6886 tests, 6836 pass, 0 fail, 49 skipped.
- B7: `rm -rf client/dist && npm run build` then enforce: 7/7 PASS at +0%.
- B8 bundle: ~200 kB of incompressible text appended to `pages/Settings.tsx` (temporary, reverted):
  `OVER /settings Settings: 280.6 kB gzip vs 131.9 kB (+112.8%)`, exit 1.
- B8 long tasks: an 80 ms busy loop in `pages/Settings.tsx` module scope (temporary, reverted):
  `OVER /settings Settings: longest task 80 ms`, exit 1 under enforce, 0 in report mode.
- Long tasks on the unmodified build, 3 runs, empty database: 0 long tasks on all 7 switches.
  The canary (a deliberate 120 ms task) was observed each run, so the zeros are real, but an empty
  database renders empty states only: this is a floor, not Nick's real cost.
