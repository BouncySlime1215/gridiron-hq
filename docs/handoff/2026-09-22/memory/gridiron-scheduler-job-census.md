---
name: gridiron-scheduler-job-census
description: Every scheduler job by tier — none orphaned, 22 background-tier jobs have never fired because the process dies before t+300s, and 12 more are gated off by AUTO_HEAVY_SYNC.
metadata:
  type: project
  modified: 2026-09-20T03:05:00.000Z
---

Enumerated from `JOBS` at the tip of the #56 -> #59 -> #61 -> #63 stack, not
read off the source. Answers "which jobs never fire and why" without guessing.

**62 jobs. Every one is in a real tier** — live 24, growth 20, heavy 12,
metered 6. None orphaned, none registered-but-scheduled-by-nothing, and no job
whose `maxAgeMinutes` is shorter than the tick that drives it (live 90 s,
background 300 s). **So there is no structural never-fires case left.** The
zero-runs-ever on the deployed build is the restart cycle
([[gridiron-boot-restart-loop]]), nothing in the job table.

**12 heavy-tier jobs run zero times because AUTO_HEAVY_SYNC is unset.** That is
the flag working as designed, not a fault, and it is a DIFFERENT thing from the
300 s background tier never firing. Do not conflate them: unsetting
AUTO_HEAVY_SYNC does not stop the restarts (`:1759` gates heavy only).

**42 jobs still run on the request thread** after #62: 23 live (short, keyless
and fast by design, the three book-feeds jobs among them), 13 growth, 6
metered. Only `nfl_model_growth` was measured blocking past the 60 s fuse and
only it was audited for module state, so only it was moved. **Moving the rest
needs the same per-module audit that named the book-feeds three** — guessing
trades a measured fault for an unmeasured one. A job is unsafe in a worker iff
its module holds mutable state used as persistence across calls, because a
worker gets a fresh module graph.

`tier()` is `setInterval`-only with no leading call, so the first background
pass is at t+300 s. Correct on a stable box; pathological only on lives shorter
than that. `fly.toml` has `auto_stop_machines = false` and
`min_machines_running = 1`, so the machine is NOT being idle-stopped.

Evidence file for the whole stack: `docs/tdd/boot-restart-cycle.tdd.md`, added
on #61's branch. It has no RED commits — the diagnosis came from measuring
production, so a RED commit written afterwards would be theatre — and uses 12
defect injections against the merged source instead, each re-run at the tip
rather than quoted from when it was written.

## Corrected 2026-09-20 03:00Z: the never-fired count is 22, not 19

**"19 jobs come due at once at t+300 s" was wrong** and it is in the release
plan. 19 is the count of growth and metered jobs **on the request thread**,
which is a different set from the ones that have never fired.

**22 background-tier jobs have never fired** (18 growth, 4 metered): the
background tier first ticks at t+300 s (`server/index.js:75` passes
`intervalMinutes: 5`; the signature default of 30 is NOT what ships, and
`tier()` has no leading call), and the measured mean interval between restarts
is ~177 s. Four background-tier jobs are excluded because they fire earlier by
another route: `nfl_prop_feeds` and `beat_the_close` are in `BOOT_JOBS`
(t+20 s), and `nfl_model_growth` (t+90 s) and `nfl_reports` (t+150 s) have
their own delayed timers.

**Plus the 12 heavy = 34 of 62 jobs that have never run on this build.**

**That burst is what the 900 s post-unset proof measures, not the boot fix.**
After the six ingests on
`claude/project-thread-o3wt2p-growth-offthread-hold` (`0a198d7`), **10 of the
22 are still inline** rather than 16. A death between 300 and 900 s is in that
burst; reading it as a boot regression sends the next person to the wrong four
PRs.

Full list, the timeline table, and why `sync_log` cannot answer it:
`docs/scheduler-what-actually-fires.md` on that hold branch, with the six
timing constants pinned in `test/scheduler-first-pass-timing.test.js`.
