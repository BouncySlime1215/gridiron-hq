---
name: wal-mode-changes-the-wedge-diagnosis
description: The app's SQLite runs in WAL, so "a long write blocks every read" is false — only an EXCLUSIVE-lock operation can wedge reads, and off_thread does not protect against it.
metadata:
  type: project
---

Established 2026-09-19 during the post-deploy restart cycle, from code on
`791b131` rather than from reasoning about `node:sqlite` in general.

**WAL is on.** `server/db/index.js:24-25`: `PRAGMA journal_mode = WAL` and
`PRAGMA busy_timeout = 15000`, plus `journal_size_limit = 67108864`. In WAL mode
**readers do not block on a writer**. So the natural-sounding diagnosis — "node:sqlite
is synchronous and single-writer, so one long write blocks every read" — is
WRONG for this database, and it was stated by two sessions before being caught.

**What can actually wedge a read** is an EXCLUSIVE-lock operation:
`wal_checkpoint(TRUNCATE)` or `(RESTART)`, a `VACUUM`, or a schema change. The
signature is a reader waiting out the 15-second `busy_timeout`, throwing
`SQLITE_BUSY`, and `/api/health` returning **503** from its own catch (a 502 is
the edge with no instance; a 503 is the handler). Observed: 503 after 35.3s to
first byte with TCP connecting in under a millisecond.

So when the app wedges, the question is not "which job writes a lot" but
**"which job takes an exclusive lock"** — a far shorter list.

**`report-cache.js:113` is NOT it**, though it is the obvious candidate since it
runs `PRAGMA wal_checkpoint(TRUNCATE)` outright. `reclaimWal()` sets
`busy_timeout = 250` first, catches the busy failure, and restores the timeout in
a `finally`, so it gives up in a quarter of a second rather than blocking; and
`journal_size_limit` bounds the truncate. Checked and ruled out — do not re-chase
it.

**`off_thread=true` does NOT protect against this.** #17 moves a job off the HTTP
thread, which stops it blocking the event loop; a worker thread writing the same
file takes the same database locks. So "every heavy job is off_thread" exonerates
the heavy tier for event-loop wedging and says NOTHING about lock contention.
This session drew the wrong conclusion from it first and retracted. The heavy
tier stays a suspect while `heavy_enabled` is true, and
`fly secrets unset AUTO_HEAVY_SYNC` stays the right first command.

How to tell a wedge from a restart from an outage, and how to void a
straddled read: [[health-uptime-brackets-every-read]].

**AUTO_HEAVY_SYNC gates ONLY the heavy tier.** `scheduler.js:1758`:
`const heavy = process.env.AUTO_HEAVY_SYNC === '1' ? jobsInTier('heavy') : [];`
Live, growth and metered register unconditionally. So
`fly secrets unset AUTO_HEAVY_SYNC` stops one tier of four and nothing else. Do
NOT present it as "the fix" for a wedge whose cause is not established — if the
culprit is outside the heavy tier the restarts continue and it reads as a wrong
diagnosis rather than a wrong lever.

**Fixed-offset boot work, which is what a same-age-every-time wedge points at**
(contention is ragged; a timer is not). `scheduler.js:1745-1747` awaits TWENTY
jobs IN SERIES starting at `bootDelayMs` (default 20000, `:1717`), several
`off_thread=false`. Then `:1751` fires `nfl_model_growth` at 90s and `:1754`
fires `nfl_reports` at 150s. Measured 2026-09-19: the app served for ~105-120s
after each boot, then wedged; in the 22:09 life the boot chain's `last_run_at`
timestamps run 22:09:44 to 22:10:43 and stop partway down the list, inside that
window. Circumstantial, one snapshot, job cadences confound it.

`nfl_model_growth` at 90s is the tidy answer and probably WRONG: it read
`stale=false` with a 6h `maxAgeMinutes`, so `runIfStale` would have skipped it.

**Cheapest next step, needs the Fly log (Nick's terminal):** the boot chain logs
its jobs by name in order. If the same job is the last to log in every life, the
wedge is named with no instrumentation.
