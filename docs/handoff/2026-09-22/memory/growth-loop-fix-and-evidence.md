---
name: growth-loop-fix-and-evidence
description: What does and does not stop the nfl_model_growth restart loop, and the one read-only query that proves or kills it.
metadata:
  type: project
---

Companion to [[growth-job-restart-loop]], which has the mechanism.

WHAT DOES NOT STOP IT
- **`fly secrets unset AUTO_HEAVY_SYNC`.** `scheduler.js:1758` gates ONLY
  `jobsInTier('heavy')`. `nfl_model_growth` is tier `growth`. The `nfl_reports`
  timer at boot+150s (`:1754`) is outside the brake for the same reason.
  Sending Nick the unset as "the stabilising step" hands him a command that
  looks like a fix and changes nothing.
- **PR #56, for the growth job.** Its two halves fix a real defect (Fly's own
  `/api/health` probe arming the watchdog at listen+15s), but it arms via
  `onBootComplete` at ~66s while this job starts at 90s — armed and waiting
  when the block arrives. Moving the boot pass off-thread misses it too: this
  job is not in `bootJobs`.

SMALLEST REAL FIX for the growth job: `offThread: true` at
`scheduler.js:1321`, the mechanism #17 used for the heavy tier. Follow-up PR:
re-ingesting a full prior season EVERY cycle is a real cost even on a healthy
machine; the `season - 1` read exists for the Week 1 replacement baseline
(`nfl-model-growth.js:191-193`) and needs no full rewrite each time.

THE ONLY DIRECT MEASUREMENT OF THE BLOCK'S TIMING (my 5-min health log):
  issued 22:28:15Z · 200 after 23.38 s · uptime_s 65 · start 22:27:34Z
  issued 22:33:39Z · 200 after 0.35 s  · uptime_s 22 · start 22:33:17Z
The first request went out 41 s into that life and was answered ~64 s in: the
loop did not turn for >=23 s, all inside 41-64 s. The second is the control —
22 s in, answered instantly. **So the block begins between 22 s and 41 s after
boot.** `bootDelayMs` is 20000, so that is the BOOT PASS, not the 90 s growth
timer. This is also the cleanest corroboration of the release thread's original
signature (35 s to first byte, then the handler's own 503): same shape, and
both are the loop not turning rather than anything about WAL.

WITHDRAWN ON THAT EVIDENCE: my "the boot pass is not the blocker", argued from
the chain completing at ~66 s in a life that lasted 255 s. That shows only that
the chain did not kill THAT life, not that it never blocks 60 s. The honest
picture is TWO main-thread blockers stacked in the first two minutes of every
life; #56 reaches the boot pass, `offThread: true` reaches the growth job, and
which one lands the fatal 60 s is open.

RESTART TIMELINE, start to start: 22:09:00, 22:12:07, 22:14:51, 22:19:03,
22:27:34, 22:33:17 — gaps 187, 164, 252, 511, 343 s. The 511 is out of family;
a stopped interval before Fly restarted it would explain it.

THE ONE READ THAT SETTLES IT (read-only, Nick's terminal):
`fly ssh console -a gridiron-hq -C "sqlite3 /data/data.sqlite \"SELECT id, started_at, status FROM nfl_model_growth_runs ORDER BY id DESC LIMIT 10;\""`
`nfl-model-growth.js:163-165` INSERTs a `status='running'` row BEFORE any work,
so a process killed mid-job leaves it at `running` forever. One such row per
life, each ~90s after a process start, proves it. None kills it. **It does not
depend on which step inside the job blocks** — which is the point, after I
named the wrong step once already.

THE LINK NOT RE-VERIFIED: that `player_week_usage` still has no 2026 rows.
From a verified read earlier on 2026-09-19, not re-read under the capture hold.
If that changed, `coreLag` is false and the whole chain collapses.

ACCEPTED FROM THE RELEASE THREAD, source-checked here: `nfl_reports` is
offThread so it explains none of these lives (I had offered it for the 255s
life; withdrawn); and the background tier ticks at 300s (`index.js:75` passes
`intervalMinutes: 5`, `scheduler.js:1801`), which no life has reached.

MY OWN EARLIER FINDING, CORRECTED: `manager_signals`/`manager_archetypes` at
`last_run_at: never` is the AUTO_HEAVY_SYNC gate first (heavy tier, excluded
until it was set tonight), the 300s tick second. Not a separate bug.
