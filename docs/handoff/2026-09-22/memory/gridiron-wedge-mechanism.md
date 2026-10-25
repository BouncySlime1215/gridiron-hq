---
name: gridiron-wedge-mechanism
description: Why gridiron-hq.fly.dev wedges rather than crashes, why a Fly health check alone cannot recover it, and the three mechanism traps that silently defeat the obvious watchdog.
metadata:
  type: reference
  modified: 2026-09-19T21:36:00.000Z
---

`server/index.js` calls `startScheduler({ intervalMinutes: 5 })`, overriding
the 30-minute default `scheduler.js`'s own comments describe. AUTO_HEAVY_SYNC
adds eleven `tier: 'heavy'` jobs (season simulations, model refits, LLM
writeups, minutes each) to that pass, sequentially, **on the thread serving
HTTP**. `node:sqlite`'s `DatabaseSync` is fully synchronous, so a running job
and an unresponsive app are the same event. The in-flight guard only stops a
second pass stacking behind the first.

**Symptom to recognise:** DNS resolves, fly.io and other hosts are reachable,
but every request — including unauthenticated `GET /` — times out with zero
bytes. Also see [[gridiron-fly-cold-start]]: a cold start takes 60-180s, so a
short curl timeout reads a healthy app as dead. Three threads made that
mistake on 2026-09-19.

**Fly semantics, read from the configuration reference rather than assumed.**
Health checks and the restart policy are INDEPENDENT. A failing
`[[services.http_checks]]` takes the machine out of the routing pool and never
restarts it. Only a process EXIT triggers the restart policy. With one machine
and `min_machines_running = 1`, "unhealthy and not routed to" is not a
recovery. So the HTTP check added in #17 would NOT by itself have ended the
three-hour wedge — something inside the process has to exit.

Before #17 `fly.toml` had `[[services.tcp_checks]]` and nothing else, which the
kernel's listen backlog answers while the event loop is blocked. Fly saw a
healthy machine throughout. There was no health endpoint in the app at all.

`server/platform/loop-watchdog.js` (#29) is what exits: a SharedArrayBuffer
heartbeat written by the main thread, watched by a worker on its own thread,
SIGKILL after 60s of no event loop.

**Three traps that silently defeat the obvious implementation:**

1. A watchdog **on the main thread cannot fire during a block** — its timer is
   queued behind the block. It must live on another thread and communicate
   through shared memory, because `postMessage` is also delivered through the
   blocked loop.
2. A worker's `console.error` is piped to the parent and delivered through the
   **main thread's** event loop. During a wedge it never arrives, and a SIGKILL
   destroys it. Anything that must survive a wedge has to be
   `fs.writeSync(2, ...)` straight to the file descriptor. A test asserting the
   message reaches the logs is what caught this; it would have shipped useless.
3. An off-thread job **cannot be module-mocked from the main thread** — the
   worker imports its own copy of every module, so `t.mock.module` does not
   reach it. Test such a job's logic directly (see `ffOpportunitySeasons`).

`offThread` was deliberately made a property separate from `tier`: "expensive,
must not block" and "opt-in behind a flag" are different things, and conflating
them is what left the core feeds switched off.

**GRIDIRON_FLY_TOKEN is an app session token, not a Fly platform token.**
`api.machines.dev` returns 401 for it, so no session here can see machine state
or restart the machine. That needs Nick.

Part of [[gridiron-scheduler-outage-2026-09-19]].
