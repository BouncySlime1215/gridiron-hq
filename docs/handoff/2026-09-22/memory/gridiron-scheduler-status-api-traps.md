---
name: gridiron-scheduler-status-api-traps
description: Three ways Gridiron HQ's scheduler status API misleads — `stale` is not the field the gate reads, `last_run_at` only stamps on completion, and `never` can mean the tier never fired.
metadata:
  type: project
---

All three verified on `origin/main` at `791b131`, `server/services/scheduler.js`.
They matter because `/api/mlb/sync/status` is the only view of the scheduler
available over HTTP, and each of these makes it answer a *different* question
from the one being asked.

**1. `stale` is NOT the field the gate reads.** The payload's `stale` is
`age >= j.maxAgeMinutes` (`:1831`). But `runIfStale` gates on
`age < nextDueMinutes(name, job)` (`:1566-1567`), and for
`last_status === 'error'` that returns
`Math.min(RETRY_BASE_MINUTES * 2 ** Math.min(failures - 1, 20), cadence)` with
`RETRY_BASE_MINUTES = 5` (`:141`, `:171-173`); `'skipped'` gets
`SKIP_RETRY_MINUTES`; never-run returns 0, due now.

**So a job reading `stale: false` against a six-hour cadence can still be due on
every single boot** if its last run errored. On 2026-09-19 `nfl_model_growth`
read `stale: false` with `consecutive_failures: 1` and an age of 112 minutes —
and was due every boot, at 5. **Read `due_after_minutes`, never `stale`.**

**2. `last_run_at` only stamps after `job.run()` returns.** A process killed
mid-job leaves it frozen at the previous attempt and the failure counter stuck.
**A cluster of jobs sitting at exactly `consecutive_failures: 1` — one each,
never two — is the signature of a process that never lives long enough to
retry**, not of jobs that failed once and recovered.

**3. `last_run_at: never` may mean the tier never fired.** `:1801` registers
growth, metered and heavy as ONE background tier on `intervalMinutes * 60000`,
and `server/index.js:75` passes `intervalMinutes: 5` — so **300 seconds**. A
process dying sooner never reaches it, and every job in all three tiers outside
`bootJobs` reads `never`. That is one symptom, not N broken jobs. See
[[gridiron-scheduler-disabled-brake]].

**The shared lesson.** Each of these reports something true about a *different*
quantity than the reader assumes — the house failure mode in its API form.
Before concluding a job will or will not run, find the line that actually gates
it.
