---
name: gridiron-offthread-breaks-fetch-stub-tests
description: Adding offThread:true to a scheduler job silently breaks any test that stubs globalThis.fetch and drives it through runIfStale — the worker is a separate V8 isolate; league_rosters is the next one at risk.
metadata:
  type: project
---

`runJobOffThread` (`server/services/scheduler.js:1719`) spawns a real
`new Worker(...)`, which is a **separate V8 isolate**. A test that stubs
`globalThis.fetch` stubs only its own isolate, so the job in the worker calls
the REAL fetch. Under `npm test` that is blocked by `test/offline-guard.mjs`
(the guard does reach the worker — `NODE_OPTIONS` propagates), so the job's
network reads all fail.

**Why the failure is hard to read.** The job does not throw. `backfillLeagueHistory`
counts each blocked league-season as a failure by design ("one league-season
failing is counted, not swallowed and not fatal"), so `runIfStale` returns
`ran: true` with **no error** — the `ran`/`error` assertions pass — and writes
zero rows. Only a later row-count assertion fails, with a bare `0 !== 2` that
points at the database and says nothing about threads.

Measured 2026-09-22 on tree `070d6cbaff5e`: commit `6c6c672` added
`offThread: true` to `league_history` (`scheduler.js:1514`) and turned
`test/league-history-schedule.test.js:90` red. Same tree, one variable:
`runIfStale('league_history', { force: true, offThread: false })` → 7/7 pass.
Worker detail was `{attempted:4, ok:0, failed:4, not_existing:0}`, every entry
`offline test guard: blocked an external request to lm-api-reads.fantasy.espn.com`.

**How to apply:**
- Before adding `offThread: true` to a job, grep its tests for
  `globalThis.fetch =`. **`test/league-roster-schedule.test.js:38` and `:60`
  are the next casualty**: they drive `league_rosters`, which is tier `'live'`
  with no flag (`scheduler.js:1263`), so they pass today and will not the day
  it is flagged.
- The fix is in the test, not the job: an assertion about what the writer puts
  in the database is not a threading claim, so it passes `offThread: false`.
  Coverage is not lost — the threading claim belongs in
  `test/scheduler-blocking-jobs.test.js`, where `6c6c672` put it (`:44`).
- Do not call this failure a flake or an environment problem. It is
  deterministic and reproduces alone in ~4s.
- Running such a test file OUTSIDE `npm test` (bare `node --test`) loads no
  guard, and the worker then makes real outbound ESPN requests. Keep probes
  under the suite's env.

Related: [[gridiron-swallow-scan-tool]]
