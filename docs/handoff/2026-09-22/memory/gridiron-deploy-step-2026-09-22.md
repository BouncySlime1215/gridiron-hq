---
name: gridiron-deploy-step-2026-09-22
description: The live-app deploy plan and current state as of 2026-09-22 — brake still on, two 90s-starter fixes, live-tier branch 9c7cf68, rollback details, and the live DB read showing the "data healthy" banner lies. Linked from MEMORY.md "Live app and the deploy step".
metadata:
  type: project
  modified: 2026-09-22T04:56:20.843Z
---

**Brake**: `SCHEDULER_DISABLED=1` — set, still on. Never touch the LOOP_WATCHDOG env vars, they are unrelated. App is still running the pre-merge image. Restart loop stopped 2026-09-20 13:43:13Z (302 restarts, final count) — everything after that timestamp is the quiet period with the brake on, never read as the loop continuing.

**Deploy step changed**: Nick's plan v2 item 5 flags TWO separate 90-second starters — the `nfl_model_growth` job AND the live-data tier. The PRs already merged (#63/#52/#49) cover only the first. The live-tier move is held on the scheduler thread's branch **9c7cf68**, not yet merged.

**FLAG (2026-09-22, unresolved — re-verify before deploying against this line):** the `9c7cf68` citation above is now suspect. Scheduler has confirmed `9c7cf68` is actually the migration-066 authoring commit, not a live-tier-move branch; `8709ec6` (a different SHA) is the tip of two `o3wt2p` migration/ingest branches, not the live-tier branch either. [[a-branch-head-sha-is-the-whole-stack]] independently found the real live-tier move is `a9511f6` (with `3902ba7` beneath it). This is a flag, not a fix — whoever owns this deploy brief must re-verify directly with Scheduler which SHA the live-tier-fix branch actually is before deploying against it.

**Plan**: deploy main with the brake still on → land the live-tier fix on top → THEN unset the brake → uptime_s climbing past 900s is the proof it held. `flyctl` and the actual unset remain in Nick's hands, never a thread's or the coordinator's.

**Self-validating live read**: uptime_s reading below the request's own elapsed seconds means a restart happened during the read — the read itself proves whether the app is stable, no separate check needed. Runs query: `SELECT id, started_at, status FROM nfl_model_growth_runs ORDER BY id DESC LIMIT 10;` then `ls -la /data`.

**Rollback**: image `deployment-01M2VZ9JRYSXVHCRWJ83V360QH` is the last resort. A full rollback additionally needs the `.bak` file and Nick's explicit word. **NEVER delete `/data/data.sqlite.pre-migration-<stamp>.bak`.**

**Live DB read (last taken)**: 445 MB WAL file. `player_week_usage` covers 2021-2025, **ZERO** 2026 rows. Availability tables absent. Shrinkage fits: 0. `manager_profiles`: 0. The "data healthy" banner only checks the DB connection, not whether any rows exist — it reads healthy over an empty dataset. **445 MB is the live-DB size specifically (full history/rosters/transactions), not a general ingest-cost estimate — see [[gridiron-pbp-only-ingest-size-2026-09-22]] before letting it drive disk-risk calls on narrower ingests.**

**Correction (2026-09-22):** the "Runs query" line above does NOT imply any thread can run it directly — no thread has flyctl/DB credentials. Full detail: [[gridiron-no-thread-has-live-db-access-2026-09-22]].
