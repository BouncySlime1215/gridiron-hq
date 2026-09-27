---
name: live-tier-flag-belongs-on-the-job
description: On 654ff93 the scheduler boot pass passes an off-thread override but the tier timer does not, so #59's boot fix dies on the first live tick unless the flag is on the job declaration.
metadata:
  type: project
---

Read on 654ff93, server/services/scheduler.js: the boot pass calls
`runIfStale(j, { offThread: bootOffThread(j) })` (:1952), but the tier timer calls
`runIfStale(j)` with no override (:1997). `resolveOffThread(job, undefined)` then
falls back to `job.offThread ?? job.tier === 'heavy'`, which is **false** for an
unflagged live job.

**Why:** that asymmetry means a job taken off the request thread at boot is back
on it 90 seconds later. Unsetting `SCHEDULER_DISABLED` on 654ff93 alone would undo
#59's fix on the first live tick, for fourteen jobs.

**How to apply:** fix it at the **job declaration** (`offThread: true` in JOBS),
not at the timer caller. The flag then holds on both paths and the tier timer needs
no change at all. That is what a9511f6 does, with 3902ba7 beneath it making
`MAIN_THREAD_ONLY` outrank both the flag and the override in `resolveOffThread`,
matched by identity against JOBS so no caller signature changes.
One job must stay main-thread: `trade_asset_universe_warm`. Its product IS
in-process memory -- it warms compute-cache.js's Map so Trade Lab is fast. In a
worker it would warm its own Map, post `{leagues_warmed: 5}`, exit, and serve
nothing faster: a structural limit, not a flag to get right. See
[[deploy-654ff93-applies-no-schema]] and [[brake-not-in-fly-toml]].
