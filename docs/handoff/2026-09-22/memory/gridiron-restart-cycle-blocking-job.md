---
name: gridiron-restart-cycle-blocking-job
description: The job that wedges gridiron-hq after each boot is nfl_model_growth on scheduler.js:1751's 90-second timer, named by measurement across six lives — and the blocking step inside it is a prior-season re-read, not the play-by-play parse.
metadata:
  type: project
---

**Named by measurement, not arithmetic, 2026-09-19.** The last `uptime_s`
served before each dark window was **95, 97, 93, 91, 94, 88** across six lives,
and never near 66 s, where the boot chain ends. The only thing scheduled at boot
plus 90 s is `scheduler.js:1751`, `runIfStale('nfl_model_growth')`, on the
request thread. Read one field across enough lives; four threads had spent an
evening fitting timing arithmetic instead.

**Two main-thread blockers stack in every life, and conflating them cost that
evening.** The **boot pass** (`bootDelayMs` 20000) blocks about 23 s — a request
issued 41 s into a life answered at ~64 s, against a control 22 s into the next
life answered in 0.35 s. That is under the 60 s fuse: it **stutters**. The
**90-second timer** is what **kills**. A fix must move both, plus `:1754`.

## The blocking step inside the job

Gate: `weekly_player_usage` (`nfl-model-growth.js:82-83`, `required: true`) has
no 2026 rows, so `coreLag` (`:181`) opens the ingest branch (`:186`).

**Withdrawn: the play-by-play parse.** `syncPbpSeason` (`:188`) **streams** —
gunzip piped into `for await (const chunk of source)`, `nfl-pbp.js:410-415` — so
the loop turns between chunks, and in week 2 the 2026 file is one or two weeks
of plays. *Read the consumer, not the URL shape.*

**The real blockers are the two deliberate prior-season re-reads**, both on
`[season - 1, season]` = **2025 and 2026, every boot**. Line numbers off
`origin/main` 791b131 (a relay had these 3-4 lines early, landing on plausible
neighbours):

- `snap_counts` **`:194`** → `syncSnaps([2025, 2026])`. `nfl-advanced.js:199-200`
  is `db.exec('BEGIN')`, an unyielding `for (const b of batch) stmt.run(...)`,
  `COMMIT` — **one long exclusive transaction**, order 30,000 statements.
- `verified_event_archive` **`:197-198`** → `syncVerifiedEventArchive({ seasons:
  [2025, 2026], includeWeeklyRosters: true })`, `nfl-event-archive.js:204-210`.

**They are NOT the same shape, and it runs opposite to the intuition.**
`syncWeeklyRosterEvents` (`nfl-event-archive.js:150-199`) calls `insertEvent`
per row in a tight synchronous loop with **no `BEGIN`/`COMMIT` anywhere in that
file** (`grep -c` returns 0) — every row autocommits, which is the **slower** of
the two for the same row count, since each commit is its own fsync. So **the
writer holding no lock blocks the thread longer, and the writer blocking for
less wall time is the only one that can make `SELECT 1` exceed the 15 s
`busy_timeout` and throw.** The roster loop causes the queueing; the snap-counts
transaction causes the 503. A fix moving only the archive off-thread leaves the
503. See [[gridiron-502-vs-503-names-the-fault]].

**Why it never converges.** Both writers use `ON CONFLICT … DO UPDATE`, so every
restart rewrites the same 2025 rows and never clears `coreLag`. The 2026 rows
that would clear it come from `syncNflverse` (`:187`), first in the branch,
which is the step that errored at 21:17:44Z.

## The budget that looks like a defence and is not

`DEFAULT_JOB_TIMEOUT_MS = 120_000` (`scheduler.js:1438`) is applied as a
`Promise.race` (`withJobTimeout`). **A race cannot interrupt synchronous work** —
nothing runs to notice the timer — so a blocking job burns through its 120 s
budget while the watchdog fuse is 60. Do not read the timeout as a second line
of defence; it is a number that never gets read.

**The confirming read** (read-only, needs a terminal): `SELECT id, started_at,
status FROM nfl_model_growth_runs ORDER BY id DESC LIMIT 10`. `:164-166` INSERTs
`status: 'running'` before any work, so one row ~90 s after each start proves
it; none kills it. Found by Trade Brain; named by the scheduler thread.
