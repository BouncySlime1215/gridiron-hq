---
name: gridiron-restart-cycle-2026-09-19
description: 2026-09-19 gridiron-hq restart loop mechanism (nfl_model_growth 90 s main-thread timer vs #29 watchdog), brake, query, fixes.
metadata:
  type: project
  modified: 2026-09-20T02:48:00.000Z
---

Settled 22:40Z 2026-09-19 (Trade Brain, scheduler-timing, release-check); lines: origin/main 791b131. Overnight count 01:09Z 2026-09-20: 46 restarts (COUNT, 60 s cadence since 22:53Z, one per ~176 s), longest logged life 65 s.

## Mechanism
- `scheduler.js:1751` `setTimeout(runIfStale('nfl_model_growth'), max(90000, bootDelayMs+60000))` = flat 90 s every boot, request thread (growth tier, no `offThread`, :1321).
- Due EVERY boot: `nextDueMinutes` (:165-176) retries an errored job in 5 min, not 6 h; `record()` runs after `job.run()` returns; status `stale` (6 h, :1831) is false.
- Why coreLag (fantasy plan, corrected): `weekly_player_usage` is required at through_week 0, so nfl-model-growth.js:181 `coreLag` is true, :187 calls `syncAll([SEASON])` every boot. 2026 rows never land: syncAll stamps `nflverse_weekly_usage` once per season (last season wins; `record()` resets consecutive_failures on any non-error) and stamps 'ok' for a season that downloaded rows, inserted none (routes/model.js:607 comment names it). The six '2021,2022,2023,2024,2025' defaults in routes/nfl-betting.js are off the boot path. Fix: fantasy plan's usage-feed PR (local 5044317 RED / 989baf2 GREEN, 13/13 new file, 2963/0 suite).
- Blocking = PRIOR-season re-reads (PBP streams, doesn't block): snap counts (:194, syncSnaps writes a season in ONE sync transaction, nfl-advanced.js:199-200; the only step that pushes health's SELECT 1 past the 15 s busy_timeout) and event archive + weekly rosters (:197-198, nfl-event-archive.js:150-199, insertEvent per row, sync loop, autocommit). Both ON CONFLICT DO UPDATE: each restart rewrites 2025 rows, never clears it. Download precedes the block (lives 161-255 s). Boot pass blocks ~23 s from ~listen+20 s: stutter, not kill.
- Loop blocks; #29 watchdog (armed <15 s by Fly's /api/health probe, index.js:63; 60 s fuse, loop-watchdog.js:58) SIGKILLs (loop-watchdog-worker.js:38); Fly restarts. Proof (7 lives 22:20-22:35Z): last `uptime_s` before dark 95/97/93/91/94/88.
- Root: `DEFAULT_JOB_TIMEOUT_MS` 120 s (:1438) is 2x the 60 s fuse; `withJobTimeout` (:1448) can't interrupt sync work. Same stall on OLD build 16:08-19:25Z ([[fly-app-stalls-in-bursts]]).

## Non-fixes
- `AUTO_HEAVY_SYNC` unset: :1759 gates only the off-thread heavy tier. Threshold up / `LOOP_WATCHDOG_DISABLED=1`: silent stall. Never. #56 alone: kill at 150 s.

## Brake, proof, fix
- Brake: `fly secrets set SCHEDULER_DISABLED=1 -a gridiron-hq`; scheduler.js:1732 returns before :1751, boot pass and all tiers. Pass: `/api/health` `uptime_s` >600, climbing.
- Read (`fly ssh console`): `SELECT id, started_at, status FROM nfl_model_growth_runs ORDER BY id DESC LIMIT 10;` a 'running' row ~90 s after start proves it.
- Fix: stack #56 → #59 → #61 → #63 (`offThread: true` on :1751, :1754, boot chain per job; `nfl_book_feeds_*` stay on-thread). Retargeted to main 01:02Z 2026-09-20 (not rebased): fast-forward chain 63ca21e → b5b74b5 → 7534ff1 → a986f37 → 01b7a2f onto 791b131; #63 alone lands all four. Deploy, prove, unset `SCHEDULER_DISABLED`.
- The 900 s proof after the unset covers the first two background tier passes: 19 never-run jobs (13 growth + 6 metered) (CORRECTED 02:44Z: 22, see scheduler 0a198d7) come due at t+300 s on the request thread; a death between 300 and 900 s is in that group, not the boot fix.
- Open: OOM vs SIGKILL (`fly logs`); `ls -la /data` tomorrow.

See [[gridiron-post-deploy-chain]], [[gridiron-next-train]].
02:15Z probe (release): eight lives, onset (94,110] s, no ramp (29 reads at age 78+ all under 0.46 s), cycles 167-179 s, restart 5-20 s. See [[gridiron-morning-message-inputs-6-2026-09-20]].
**02:48Z: second candidate at 90 s = live data tier (24 jobs, 23 on request thread); neither fix PR touches it; a post-unset death ~3 min in is not a rollback reason; brake stops both.**
