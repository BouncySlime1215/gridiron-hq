---
name: gridiron-long-writes-block-the-app
description: A long synchronous sync on the live Fly app makes the whole app unresponsive for as long as it runs — better-sqlite3 is synchronous, so any heavy ingest is a production outage, not a background job.
metadata:
  type: project
  modified: 2026-09-19T19:20:00.000Z
---

Learned the hard way on 2026-09-19. Design around it; do not rediscover it.

**What happened.** `POST /api/model/sync` (default seasons 2021-2025: five
seasons of play-by-play, then nflverse player feeds, advanced stats and
historical lines) was started at about 16:08Z against gridiron-hq.fly.dev.
The HTTP connection was cut at five minutes, but the Express handler kept
running server side. From 16:13Z to 16:37Z the app answered **nothing at
all** — not the API, not even the static index page. TCP connected and TLS
completed, so the edge and the machine were fine; the Node process was simply
never yielding.

**Why.** This app uses better-sqlite3, which is **synchronous**. Every
statement blocks the single Node event loop, and `syncHistoricalLines` wraps
its insert in one explicit `db.exec('BEGIN')` transaction. While a bulk
ingest runs, no other request gets a turn. More memory does not fix this —
the 2 GB resize earlier the same day fixed the OOM crashes and changed
nothing about the blocking.

**Consequences to design for.**
- A multi-season pull against the live app is a **production outage**, not a
  background job. Never start one without agreeing a window first.
- Timing out the client does **not** cancel the work. There is no cancel
  endpoint. The only way to stop an in-flight sync is
  `fly apps restart gridiron-hq`, which is Nick's call. A restart is safe:
  finished steps are committed, an open transaction rolls back cleanly.
- Judge "is it still running" by whether the app answers, not by whether your
  request returned.
- Prefer one season at a time (`?seasons=2026`) over the default range, and
  prefer `POST /api/mlb/sync/now?job=<name>` for a single registered job.
- `AUTO_HEAVY_SYNC=1` was switched on at about 16:05Z the same day, so the
  scheduler now runs `tier: 'heavy'` jobs on its own timers. `mlb_logs` alone
  took 100 s when forced. That is a second, independent source of sustained
  load that is not anyone's manual sync.

See [[gridiron-fly-ingestion-limits]] and [[gridiron-live-data-state]].
