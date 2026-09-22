---
name: gridiron-502-vs-503-names-the-fault
description: On gridiron-hq.fly.dev 502, 503 and no-response-at-all are three different faults naming three different layers - and in the 2026-09-19 restart cycle every failure was the third, which rules out lock contention.
metadata:
  type: project
---

**Read the status code before theorising. It names the layer.**

| Response | Layer | Means |
| --- | --- | --- |
| **502, empty body** | Fly's edge | no healthy instance behind it — crash loop, refused boot, or evicted from routing |
| **503, `{"ok":false}`** | the app itself | `healthHandler`'s `catch` — `db.prepare('SELECT 1').get()` **threw** |
| **connect fast, no bytes, hangs** | the app itself | event loop blocked; the kernel accepted onto the listen backlog |

`SELECT 1` cannot fail for want of data, so a 503 means the read **threw**.
Measured twice on 2026-09-19: 503 after **35 s**, TCP connect sub-ms.

**The restart cycle was row 3, not row 2, and the count settles it.** Over
2026-09-19/20, two independent samplers took **335 reads; 137 failed; ZERO were
503**. So the loop was not turning — it was never "a writer holds a lock while
the server keeps serving". **That rules out `busy_timeout`, WAL tuning and
retry-on-busy as fixes**: nothing is left running to retry. What remains is
synchronous work on the main thread, and the only answer is moving it off.
**Counting the codes is the cheap discriminator; do it before theorising.**

**Do NOT read that as "a long write is holding the lock" — that was wrong and
was withdrawn.** `db/index.js:24-26` sets `journal_mode = WAL`,
`busy_timeout = 15000`. **In WAL mode readers do not block on a writer**, so no
ordinary write can make `SELECT 1` throw. Only an exclusive-lock operation can,
and the list is closed: `wal_checkpoint` at `report-cache.js:113` (defended with
`busy_timeout = 250`, a catch and a `finally`) and `VACUUM INTO` in
`backupBeforeMigration`, which runs only when migrations are pending. The 503
fits ~20 s queued behind a blocked loop plus the 15 s busy timeout, the lock
most plausibly WAL-index recovery after a kill mid-write — **a consequence of
the cycle, not its cause.**

**`uptime_s` is a free restart detector.** `GET /api/health` is unauthenticated
and returns `{"ok":true,"uptime_s":<n>}`; derive the start and compare across
reads. Whole process starts were mapped this way with no terminal at all.

**Better: one read brackets itself** — `uptime_s` below that request's own
elapsed time means it crossed a restart. [[reads-that-cross-a-restart]].

**Why voiding matters rather than re-running.** `routes/model.js` memoises
`proj:` (`:404`, `:426`) and `player-week:` (`:443`) under keys with no seed or
fit id, so a capture spanning a restart mixes two memo generations **with
nothing marking the seam**.

**The self-sustaining shape.** Fly's `/api/health` probe arms the #29 watchdog
within 15 s of listen (`index.js:63` above the health route at `:86`); it exits
the process at 60 s of blocked loop (`loop-watchdog.js:58`); every restart
re-runs the same work. Mechanism: [[gridiron-restart-cycle-blocking-job]].

**`AUTO_HEAVY_SYNC` is NOT the fix.** `scheduler.js:1759` gates only the
*heavy* tier. The boot pass stutters (~23 s, under the fuse); the kill comes
later — see [[gridiron-restart-cycle-blocking-job]].

**Never raise `LOOP_WATCHDOG_THRESHOLD_MS`** (`loop-watchdog.js:58`): it stops
the restarts by turning a machine that recovers into one wedged forever.

**No corruption from the cycle**: SQLite transactions are atomic and a killed
process rolls back on the next open.

**CORRECTED 2026-09-20.** Seven jobs at `consecutive_failures: 1` was read as
"a counter reset by each restart". Wrong: `record()` runs only *after*
`job.run()` returns, so a killed job increments **nothing**. Those counters are
a tally that **stopped being written** — a floor on abandoned attempts, never a
count of them. `sync_log` cannot show a killed job at all, which is why the
table looks quiet while nothing is finishing.
