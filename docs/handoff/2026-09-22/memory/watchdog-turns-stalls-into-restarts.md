---
name: watchdog-turns-stalls-into-restarts
description: The 2026-09-19 22:09Z build restarts every 160-255s because nfl_model_growth blocks the main thread on a flat 90s boot timer; the fix is SCHEDULER_DISABLED=1, NOT unsetting AUTO_HEAVY_SYNC.
metadata:
  type: project
  modified: 2026-09-19T22:50:00.000Z
---

Read this before diagnosing a gridiron-hq restart, and before repeating the
wrong fix — an earlier version of this file named it and it was wrong.

**The mechanism.** `server/services/scheduler.js:1751` fires
`runIfStale('nfl_model_growth')` on its own `setTimeout`, a flat 90 seconds
after every boot, outside `bootJobs` and outside every tier gate. That job is
`tier: 'growth'` (`:1321`). It blocks the main thread, `node:sqlite` being
synchronous, and the loop watchdog SIGKILLs the process once the event loop has
not turned for 60s (`platform/loop-watchdog-worker.js:38`, threshold
`loop-watchdog.js:58`). Fly restarts because `min_machines_running = 1`.

**Measured** across seven lives by the scheduler thread: last `uptime_s` served
before each dark window was 95, 97, 93, 91, 94, 88 — right after the 90s timer,
never at ~66s where the boot chain ends. Independent read: health hung 35.7s
and returned empty at 22:29:34Z, then an 11.68s boot, then sub-second probes.
Lives run 160-255 seconds.

**THE FIX IS `fly secrets set SCHEDULER_DISABLED=1 -a gridiron-hq`**
(`scheduler.js:1732` returns before that `setTimeout` is ever scheduled).

**`fly secrets unset AUTO_HEAVY_SYNC` does NOT stop it.** `:1759` gates only
`jobsInTier('heavy')`. Two independent reasons it is irrelevant here: the
blocking job is growth tier, and the background timer carrying growth, metered
and heavy is `intervalMinutes * 60000` at `:1801` with `intervalMinutes: 5`
from `index.js:75` — 300 seconds, which no life has ever reached. That tier has
never fired on this build. The only heavy job that runs at all is
`evidence_daemon`, via `bootJobs`, and it is off-thread. `heavy_enabled` did
read true at 22:19:26Z, so Nick never ran the unset; it changes nothing.

**Do not quiet the watchdog.** The worker's own message suggests
`LOOP_WATCHDOG_THRESHOLD_MS` or `LOOP_WATCHDOG_DISABLED=1`. Both would restore
the silent multi-minute stall recorded in [[fly-app-stalls-in-bursts]], which
is worse — a TCP check passed through that entire outage and nothing noticed.
The code offers the wrong fix in its own error text.

**Structural defect worth carrying**, found by the scheduler thread:
`DEFAULT_JOB_TIMEOUT_MS` (`scheduler.js:1438`) is 120,000 ms against a watchdog
threshold of 60,000 ms, so every main-thread job is granted twice the budget at
which the host kills the process. `withJobTimeout` (`:1448`) is a
`Promise.race`, which cannot interrupt synchronous work and whose own timer
queues behind the block it is meant to bound. Against `node:sqlite` that budget
enforces nothing. A guard that cannot fire — the family in
[[gridiron-wiring-map-blind-spot]].

**What I got wrong, because the shape recurs.** I attached tonight's cycle to
the AUTO_HEAVY_SYNC wedge in [[fly-app-stalls-in-bursts]] (16:08-19:25Z, old
build, heavy tier on the main thread). Same disease, different carrier: #17 put
the heavy tier off-thread and that entry predates it. I took a correct
measurement, reached for the known prior cause, and never checked whether the
tier could even be scheduled inside a process lifetime — my own timeline said
no life reached 300s, which was the refutation sitting in my hand. Three
threads corrected it with file:line. A remembered cause is a lead, not a
diagnosis.

**The disk risk is not active:** `db/migrate.js:42` only snapshots when a
migration is pending or a repair is planned, and boots have long outlasted the
~10 restarts a 445 MB snapshot each would need to fill the 5 GB volume.

**Every live read taken during this loop is suspect** even at 200, and one
straddling a restart is void. Bracket reads with `/api/health` `uptime_s`.
