---
name: gridiron-scheduler-disabled-brake
description: SCHEDULER_DISABLED=1 is Gridiron HQ's hand-operated brake — it returns before the boot pass is even scheduled and is the one-command fix when the app wedges and restart-loops.
metadata:
  type: project
---

```
fly secrets set SCHEDULER_DISABLED=1 -a gridiron-hq
```

**`scheduler.js:1732` returns before anything is scheduled** — no `bootJobs`
chain, no 90-second or 150-second boot timers, no tiers. Setting a secret
restarts the machine, which is what you want. Fully reversible by unsetting it.

**Reach for this before `fly secrets unset AUTO_HEAVY_SYNC`**, which gates only
the *heavy* tier (`:1759`) and leaves the boot pass running. Unsetting heavy is
a run-sheet step, not a stability fix.

**The comment above it (written 2026-09-07, hours before the Matta-Kodsi draft)
names the failure class:** the live tier polling a synchronous SQLite database
"was found to be the actual cause of the app going periodically unresponsive",
and the safe move is to stop paying the cost "rather than chase which of a dozen
jobs is the one currently holding the lock."

## What blocks the loop

- **`bootJobs`, `:1740-1744`** — twenty jobs **awaited in series** at `:1746`,
  starting at `bootDelayMs` (default 20000, `:1717`). Several are main-thread.
  Order ends `… polymarket_line_watch, beat_the_close, nfl_pick_watch,
  nfl_t60_runner`.
- **`:1751`** — `runIfStale('nfl_model_growth')` at 90 s after **every** boot,
  main thread, a model fit. A no-op while the job is fresh.
- **`:1754`** — `runIfStale('nfl_reports')` at 150 s.

**The loop this forms** (observed 2026-09-19 22:09-22:25Z): boot → serve ~110 s
→ the serial chain blocks the loop → Fly's own `/api/health` probe already armed
the #29 watchdog within 15 s → watchdog exits at 60 s of blocked loop → restart
→ **the same boot pass runs again**. Two individually correct changes forming a
loop. See [[gridiron-502-vs-503-names-the-fault]] for how it presents over HTTP.

**Never raise `LOOP_WATCHDOG_THRESHOLD_MS` (env-read, `loop-watchdog.js:58`)
and never set `LOOP_WATCHDOG_DISABLED=1`** to stop the restarts. Both turn a
machine that recovers into one that hangs and stays hung — the bug the watchdog
exists to end. See [[fly-app-stalls-in-bursts]]: the same wedge ran silently on
the pre-2026-09-19 build for hours.

**The trap: the code recommends the wrong fix in its own kill message.**
`loop-watchdog-worker.js:32-33` writes "If this is not a hung job, raise
`LOOP_WATCHDOG_THRESHOLD_MS` or set `LOOP_WATCHDOG_DISABLED=1`." It will be the
most authoritative-looking line in the log and it addresses a different case.
**It is a hung job.**

**A restart loop after a deploy is not proof the deploy caused it.** On
2026-09-19 the watchdog shipped in the same release as 26 other PRs, so the
release *exposed* a stall it did not create. Check whether the symptom predates
the build before attributing it to one.

**Three traps in reading the scheduler's own status API** — `stale` is not the
gate, `last_run_at` only stamps on completion, and `never` may mean the tier
never fired: [[gridiron-scheduler-status-api-traps]].

**A disabled scheduler is a *quiet* app, not a degraded one** — which is the
best condition for a long capture, since nothing writes underneath it and there
is no drift between the first league read and the last.
