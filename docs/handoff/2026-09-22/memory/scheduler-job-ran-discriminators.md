---
name: scheduler-job-ran-discriminators
description: How to tell whether a scheduler job actually ran on the live box — scheduled_now is a constant and carries no information; a missing sync_log row means never called.
metadata:
  type: reference
---

Read from `server/services/scheduler.js` and `scripts/refresh-live-data.mjs` on
`791b131`, 2026-09-19, while the Trade Brain thread was diagnosing
`manager_signals`/`manager_archetypes` showing `last_run_at` never.

**`scheduled_now` is not evidence of anything.** scheduler.js:1881 is
`scheduled_now: j.tier === 'heavy' ? process.env.AUTO_HEAVY_SYNC === '1' : true`
— a pure function of tier and env, computed at read time. For any non-heavy job
it is the literal constant `true` on every box, always, whether or not the job
has ever been invoked. For a heavy job it only reports `AUTO_HEAVY_SYNC=1`.
`due_after_minutes` is also computed, and `nextDueMinutes` returns 0 for a job
that never ran, so "due now" is likewise not a signal.

**The real discriminator is whether a `sync_log` ROW EXISTS for the job name.**
`runIfStale`'s catch calls `record(name, 'error', e.message)` (and a throw from
`record` itself is swallowed separately so the pass continues), so a job that
was reached and failed always leaves a row with `last_status: 'error'`. No row
at all means nothing ever called it. Ask for the row, not the timestamp.

**CORRECTED 2026-09-19 22:32Z — the Fly box runs the IN-PROCESS scheduler, not
a loop.** `Dockerfile` CMD is `node server/index.js`, `fly.toml [env]` sets only
`HOST`, there is no `[processes]`, and nothing spawns
`scripts/refresh-live-data.mjs` there. `SCHEDULER_DISABLED=1` is about Nick's
Mac and the off-server loop, NOT the Fly machine — I asserted otherwise here
first and was wrong. The loop's `FANTASY_LIVE_JOBS` still matters for wherever
the loop runs, and a job added to it still needs that process restarted, but it
is not what drives the deployed app.

**What actually keeps a growth/metered/heavy job from ever running on Fly**
(scheduler thread's finding, 2026-09-19, verified line by line): scheduler.js
puts growth + metered + heavy on ONE background timer,
`tier('background', [...growth, ...metered, ...heavy], intervalMinutes * 60000)`,
and server/index.js:75 starts it with `intervalMinutes: 5` — so 300,000 ms, and
`setInterval` first fires at 300 s. While the machine is in a restart cycle
living 160-255 s per life, **that timer never fires once**, and no
growth/metered/heavy job has ever run on that build. `bootJobs` is all
live-tier, so they get no boot pass either; the two exceptions are
`nfl_model_growth` and `nfl_reports`, which have their own explicit `setTimeout`
boot passes at 90 s and 150 s. That is the pattern for a growth job that has to
run on a short-lived process.

**So a job's shape distinguishes how it goes missing:** a contiguous TAIL of
jobs starved points at boot-order or tier starvation; a whole TIER missing with
live-tier jobs healthy points at the 300 s timer never firing; precisely the
newest entries missing points at a stale loop process wherever a loop does run.

Related: [[league-history-orphan-closed]] (adds `league_history` to the same
list, so it inherits the same restart requirement),
[[gridiron-scheduler-outage-2026-09-19]].
