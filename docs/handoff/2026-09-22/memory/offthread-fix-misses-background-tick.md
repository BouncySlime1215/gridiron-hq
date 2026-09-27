---
name: offthread-fix-misses-background-tick
description: Moving nfl_model_growth off-thread at the :1751 call site only defers the wedge to the 300s background tick - which fires right where the stability check looks.
metadata:
  type: project
---

Raised 2026-09-19 against the scheduler thread's PR 2, which passed
`{ offThread: true }` at the `scheduler.js:1751` and `:1754` boot timers rather
than putting `offThread: true` on the JOBS entry at `:1321`. Their reason: the
flag "would also send it off-thread on the 300-second background tick, which is
a wider change than the boot-time fix needs".

**That is backwards, and the arithmetic says why.**

`:1801` is `tier('background', [...growth, ...metered, ...heavy], intervalMinutes * 60000)`,
`index.js:75` passes `intervalMinutes: 5`, and the pass at `:1782` is a bare
`for (const j of jobs) await runIfStale(j)` — no options. `nfl_model_growth` is
tier `growth` (`:1321`), so it IS in that list and runs there with whatever the
JOBS entry says. A call-site override does not reach it.

Both branches end in a main-thread run:
- boot run SUCCEEDS → `last_status='ok'` → `nextDueMinutes` = cadence = 360 min
  → the background tick runs it MAIN THREAD **six hours later**, on an app
  everyone has signed off as fixed.
- boot run FAILS (what it has been doing) → `consecutive_failures`=2 →
  backoff `5 * 2^1` = **10 min**. The 300 s tick skips (age 5 min < 10 min);
  the **600 s tick does not** → MAIN THREAD.

**The second branch is the dangerous one.** The morning stability proof is
`uptime_s` past **600 s**. The uncovered path fires at ~600 s. So the app holds
for ten minutes, gets read as stable, then dies again — with nobody looking at
the scheduler because the scheduler was already "fixed". Same
healthy-looking-and-not-working shape as everything else that night, except
ours.

PREFERRED FIXES, in order:
1. `offThread: true` on the JOBS entry at `:1321` — covers both paths, one line.
2. Pass the override in the tier pass too (two call sites; the next timer
   anyone adds gets it wrong).
3. Best: the scheduler thread's own proposed invariant — **no main-thread-
   reachable job may carry a budget at or above the watchdog threshold.**
   `DEFAULT_JOB_TIMEOUT_MS` is 120,000 (`:1438`) against a 60,000 fuse
   (`loop-watchdog.js:58`), so any such job is fatal by design. And
   `withJobTimeout` (`:1448`) is a `Promise.race`, so it cannot interrupt
   synchronous work at all — its own timer is queued behind the block it is
   meant to bound. An assertion catches the timer nobody thought about, which
   is the actual recurring failure mode.

See [[growth-job-restart-loop]] and [[growth-loop-fix-and-evidence]].
