---
name: gridiron-boot-restart-loop-fixes
description: PRs #59, #61 and #63 for the 2026-09-19 restart loop, what each does NOT fix, and the 62-job tier census.
metadata:
  type: project
  modified: 2026-09-19T23:24:00.000Z
---

The measurement and the mechanism are in [[gridiron-boot-restart-loop]]; the
arming PR #56 is in [[gridiron-watchdog-arming-pr56]]. This file is the two
PRs that address the loop itself, and the caveats are the point of it: read
alone, the diagnosis makes the fix sound finished. Order to merge: #56, #59,
#61, #63 — each is based on the one before.

**Verified locally 01:15Z 2026-09-20: all four bases are `main`** (retargeted,
not rebased), one linear chain fast-forwarding onto 791b131. **No base to
change by hand.** State and the held commit: [[gridiron-scheduler-stack-state]].

## The real half — PR #59, `claude/project-thread-o3wt2p-boot-offthread`

Stacked on #56. `runIfStale` takes an `offThread` override resolved by the
exported `resolveOffThread(job, override)`; the boot chain passes it per job;
both delayed timers pass it, `:1751` (`nfl_model_growth`) and `:1754`
(`nfl_reports`). `bootJobs` becomes the exported `BOOT_JOBS` so the test reads
the shipped list. The pass stays sequential — one worker at a time.

**The invariant is structural, not numeric**, because a `Promise.race` cannot
bound synchronous work: no boot-path job runs on the request thread unless it is
named in `MAIN_THREAD_ONLY` with its reason.

**WHAT IT DOES NOT FIX: three betting-side jobs keep the hazard.**
`nfl_book_feeds_fast`, `_slow` and `_extra` stay on the main thread — see
[[gridiron-boot-pass-offthread]] for the state that stops them moving. Named
rather than removed. Persisting that state is the follow-up.

**And neither PR touches the 120s-budget-vs-60s-fuse mismatch itself.** That is
recorded in [[gridiron-boot-restart-loop]] as the root cause and is deliberately
left alone, because changing the number would be the false guard.

## The backoff half — PR #61, `claude/project-thread-o3wt2p-abandoned-runs`

Stacked on #59. **A job that kills the process records nothing**, because
`record()` only runs after `job.run()` returns. Its `sync_log` row survives
untouched, so every boot reads the same row and starts the same job. Every
guard in scheduler.js is downstream of a recorded outcome, so all of them are
blind to the one failure mode that is defined by not reaching the recording
line. `recordStart` marks the job `running` with its start time in
`last_detail`; `reapAbandonedRuns` at startup rewrites leftover `running` rows
as errors, and the existing backoff (5, 10, 20, 40 min, capped at cadence)
then bites. No schema change, so no migration and no snapshot.

**The two details that make it work rather than decorate:** `recordStart` does
NOT stamp `last_run_at` (every freshness view reads it; stamping would make an
unproduced job read as fresh), and the reaper DOES, using the marker's start
time (otherwise the backoff is computed against an hours-old timestamp and
never bites). Both are covered by tests proved against broken copies.

**WHAT #61 DOES NOT FIX:** it does not stop a job blocking the loop — #59 does
that. It stops a job that already did from being handed the process again on
every boot forever.

## The half that would have undone #59 — PR #63, `…-timer-tier`

**#59's override reaches the boot path ONLY.** The background tier pass calls
`runIfStale(j)` with no override every 5 min, so `resolveOffThread` falls back
to `job.offThread ?? job.tier === 'heavy'` — false for a growth job.
`nfl_model_growth` had no flag in its JOBS entry, so the first time its 6-hour
cadence came due on a machine that stayed up it would have gone back onto the
request thread and blocked the loop again. **A fix that only holds until it
succeeds is not a fix.** #63 sets `offThread: true` on the entry itself.

Found by enumerating every job's tier and flag, not by re-reading the boot
path — see [[gridiron-scheduler-job-census]].
