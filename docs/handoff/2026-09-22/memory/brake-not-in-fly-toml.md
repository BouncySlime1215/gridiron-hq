---
name: brake-not-in-fly-toml
description: SCHEDULER_DISABLED=1 is set out-of-band on the Fly machine, not in fly.toml, so a deploy may silently drop it depending on how it was set.
metadata:
  type: project
---

Read 2026-09-22 on 654ff93: `grep -rn SCHEDULER_DISABLED` across the repo finds
only code that reads it (server/services/scheduler.js:1927) and comments. It is
**not in fly.toml's `[env]` block.** So the brake exists only as runtime state on
the machine.

**Why:** whether it survives `fly deploy` depends on how it was set. As an app
secret (`fly secrets set`) it persists. As a machine env
(`fly machine update --env`) a deploy that replaces the machine can drop it. If
it drops, the new image starts all 24 live-tier jobs on a 90-second timer -- the
exact condition the brake was applied for.

**How to apply:** before any deploy, read `fly secrets list -a gridiron-hq` (it
prints names and digests only, never values, so reading it satisfies the secrets
rule) and re-assert `fly secrets set SCHEDULER_DISABLED=1` so it is app-level
before the code deploy. After deploying, prove the brake took by finding the line
the brake itself prints -- `Scheduler disabled via SCHEDULER_DISABLED=1 -- no
background jobs will run.` (scheduler.js:1928). **Absent that line, the brake is
off.** Re-setting the brake is also the correct FIRST rollback, ahead of any image
rollback: one command, reversible, and it addresses the only failure this deploy
introduces. Never touch the LOOP_WATCHDOG_* env vars; they are not the brake.
Related: [[deploy-654ff93-applies-no-schema]].
