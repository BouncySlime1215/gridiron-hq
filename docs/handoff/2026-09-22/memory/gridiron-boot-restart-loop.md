---
name: gridiron-boot-restart-loop
description: The live app restarted every ~160s on 2026-09-19 — serve ~100s, go dark ~60s, restart; two separate main-thread blocks were measured in the first two minutes of every life, and the #29 watchdog kills the process 60s into the longer one.
metadata:
  type: project
  modified: 2026-09-19T22:46:00.000Z
---

**Measured, 2026-09-19 22:15-22:35Z**, cache-busted GETs on the unauthenticated
`/api/health` (`uptime_s` is `process.uptime()`, `platform/health.js`).
`[000]` = no response inside a 20s budget.

```
22:19:00 uptime 12   22:20:39 uptime 95   22:20:49 [000]
22:21:49 uptime 18   22:23:28 uptime 97   22:23:38 [000]
```

**Serve ~100s, go dark ~60s, restart. Starts ~160s apart.** The 60-second dark
window before each restart is the watchdog's own threshold, which is what
separates this from an OOM kill — that would be instantaneous rather than
leaving the machine accepting connections and answering nothing for a minute.

## TWO blocks, both measured, do not collapse them into one

**1. Inside the boot pass, survivable.** The Trade Brain thread issued a request
41s into a life and got no answer until ~64s, with a control 22s into the next
life answering in 0.35s. So a block of 23s or more sits between 22s and 41s,
which is the boot chain (`bootDelayMs` 20000). Under the 60s fuse, so it
stutters the app rather than killing it. It does not appear in every life.

**2. At boot+90s, fatal.** Last `uptime_s` served before each dark window across
seven consecutive lives: **95, 97, 93, 91, 94, 88**, next probe dark every time.
Never at 66s where the chain ends, never scattered. The only thing scheduled
there is `scheduler.js:1751`,
`setTimeout(() => runIfStale('nfl_model_growth'), Math.max(90000, bootDelayMs + 60000))`.

`nfl_model_growth` (`:1321`) is **growth tier with no `offThread`**, so it runs
on the request thread, and it runs on EVERY boot rather than every six hours:
`nextDueMinutes` (`:165-176`) gives a job whose `last_status` is `error` a
5-minute retry window, not its `maxAgeMinutes`. Its `last_run_at` stayed frozen
at 21:17:44Z with `consecutive_failures: 1` across every life — the signature of
a job that starts and never finishes, since `record()` runs only after `run()`
returns. Named by Trade Brain from source; the boot+90 timing is the support
for it, not proof of which line inside it blocks.

**So `fly secrets unset AUTO_HEAVY_SYNC` does nothing here** (`:1759` gates the
heavy tier only, and this is growth). **`fly secrets set SCHEDULER_DISABLED=1`
does work** (`:1732` returns before that `setTimeout` is ever scheduled), and is
the morning's first command.

## The structural fault underneath

`DEFAULT_JOB_TIMEOUT_MS` (`scheduler.js:1438`) is **120,000 ms**; the watchdog
threshold (`loop-watchdog.js:89`) is **60,000 ms**. Every main-thread job is
granted a budget twice the tolerance at which the host kills the process, so any
of them using half its allowance is fatal by design.

And the budget cannot bound the case that matters: `withJobTimeout` (`:1448`) is
a `Promise.race`, so it only abandons a promise, and its own timer is queued
behind the block it is meant to bound. Against synchronous work — which
`node:sqlite` guarantees — 120 seconds enforces nothing. **Lowering it is not a
fix; it would read as a guard while guarding nothing.**

**The arming half, the fixes, and what each does NOT fix:
[[gridiron-boot-restart-loop-fixes]].** Off-thread audit of the 19 boot jobs:
[[gridiron-boot-pass-offthread]].

Not [[gridiron-fly-boot-and-grace]] or
[[gridiron-migration-snapshot-disk-gate]]: both of those are a boot that never
reaches `listen`. This one reaches it, serves, and then dies.
