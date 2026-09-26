---
name: growth-job-restart-loop
description: Mechanism for the 2026-09-19 22:09Z+ restart cycle - nfl_model_growth on a boot+90s main-thread timer re-ingesting a full prior season every boot.
metadata:
  type: project
---

Read line by line out of the deployed tree (791b131). Source-verified; the live
confirmation query is in [[growth-loop-fix-and-evidence]] and had NOT been run.

THE LOOP
1. `scheduler.js:1751` fires `runIfStale('nfl_model_growth')` on a FIXED
   boot+90s `setTimeout`, independent of the boot chain (`:1746` is a
   fire-and-forget async IIFE, so the two overlap). It is NOT in `bootJobs`.
2. It is never skipped. `runIfStale` (`:1566`) gates on `nextDueMinutes`, NOT
   on the status payload's `stale`. For `last_status==='error'` with
   `consecutive_failures=1` that is `RETRY_BASE_MINUTES * 2^0` = 5 minutes
   (`:141`, `:171-173`). The payload's `stale` is a different number:
   `age >= maxAgeMinutes`, six hours (`:1831`). **Never read `stale:false` as
   "runIfStale would skip it".** I made that mistake and had to retract it.
3. Tier is `growth`, so `off_thread` resolves FALSE via
   `j.offThread ?? j.tier === 'heavy'` (`:1843`). Main thread.
4. `nfl-model-growth.js:186` — the expensive-ingest branch is guarded by
   `coreLag` (`:181`): any REQUIRED source lagging the finalized week.
   `player_week_usage` is required (`:81`) and the live DB has 2021-2025 with
   NO 2026 rows, so `coreLag` is TRUE every invocation.
5. Nine ingests run in series on the main thread. **The blocking step is a
   WRITE phase, not a parse.** Not `syncPbpSeason` — that streams
   (`nfl-pbp.js:410-415`, gunzip into `for await (const chunk of source)`), so
   the loop turns, and in week 2 the 2026 file is ~2 weeks of plays. I claimed
   it and withdrew it. The real ones re-read the PRIOR season every time:
   `syncSnaps([season-1, season])` (`:194`) batches in memory then runs
   `db.exec('BEGIN')` / `for (const b of batch) stmt.run(...b)` / `COMMIT`
   (`nfl-advanced.js:199-201`) — one synchronous transaction over a full 2025
   season, order 30k statement runs, NO yield; and
   `syncVerifiedEventArchive({seasons:[2025,2026], includeWeeklyRosters:true})`
   (`:197-199`) writes weekly roster events at the same order again.
   **The two are not equivalent.** `nfl-event-archive.js` contains NO BEGIN or
   COMMIT at all (verified: `grep -c` returns 0), so the roster loop
   autocommits per row. Per-row autocommit is the SLOWER of the two for the
   same row count, since every commit is its own fsync — so it blocks the loop
   HARDER while holding no long lock. Only the snap-count transaction can make
   `SELECT 1` exceed the 15000 ms `busy_timeout` and throw. Both block the
   loop; only one produces the 503. A fix moving only the archive off-thread
   leaves the 503 where it is.
6. The #29 watchdog exits after 60s of blocked loop. `record()` only stamps
   AFTER `job.run()` returns, so `last_run_at` stays frozen at 21:17:44.903Z
   and `consecutive_failures` stays 1 — still due at the next boot.

SELF-SEALING. `attempt()` (`:146-150`) swallows each ingest error, so a failing
`syncNflverse` does not stop the chain. The writes are `ON CONFLICT DO UPDATE`,
so every boot rewrites the SAME 2025 rows: expensive work that makes no
progress toward clearing `coreLag`. The 2026 rows that would clear it come from
`syncNflverse`, first in the chain and the one that errored.

WHY LIFE LENGTHS VARY (178 / 161 / 255 s). Fixed 90s timer + a download of
variable length + a fixed 60s watchdog threshold. The 255s life fits at fire
90s, download ~100s, block from ~190s, kill ~250s vs 252s observed. One
arithmetic fit among several, not proof.

Reconciles with the release thread's signature (35s to first byte, then the
health handler's own 503 from `SELECT 1`) WITHOUT needing WAL to misbehave: a
blocked event loop queues the request for 35s, and a 30k-row exclusive
transaction is what makes `SELECT 1` exceed the 15000 ms `busy_timeout` and
throw. See [[wal-mode-changes-the-wedge-diagnosis]].
