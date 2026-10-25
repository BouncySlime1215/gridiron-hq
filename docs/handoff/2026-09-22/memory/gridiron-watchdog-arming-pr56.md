---
name: gridiron-watchdog-arming-pr56
description: PR #56, why the deployed app armed its loop watchdog on Fly's own health probe, and why #56 alone does not break the 2026-09-19 restart loop.
metadata:
  type: project
  modified: 2026-09-19T23:24:00.000Z
---

Part of the 2026-09-19 restart-loop work. Measurement and mechanism in
[[gridiron-boot-restart-loop]]; the other two PRs in
[[gridiron-boot-restart-loop-fixes]].

## PR #56, `claude/project-thread-o3wt2p-watchdog-arming`

**What was wrong.** `watchdogArmingMiddleware` armed the watchdog on the first
completed HTTP response of any kind. `loop-watchdog.js` argues for that rule
because a timer-armed watchdog can kill a booting process and turn one slow boot
into a restart loop. The rule is right; `fly.toml` polls `/api/health` every 15
seconds, so on the deployed machine the first completed response is the
platform's probe, ~15s after `listen`, before the boot work starts. Circular
too: `/api/health` answers exactly when the loop is turning, which is the thing
the watchdog measures.

**The fix, two halves, neither sufficient alone.** `LIVENESS_PATH` arms nothing
(equality, not prefix); and `startScheduler` takes `onBootComplete`, wired in
`server/index.js` to `armLoopWatchdog`, in a `finally` so a pass where every job
timed out still arms. Without the second, an app nobody has visited wedges and
is never restarted, because the request that would arm it can no longer
complete. `armLoopWatchdog` remembers an arm that arrives before
`startLoopWatchdog` — with `SCHEDULER_DISABLED=1` the callback fires
synchronously, before `app.listen`.

**WHAT #56 DOES NOT FIX: the cycle.** If the fatal block is the boot+90s timer,
#56 arms the watchdog when the chain ends at ~66s and the kill still lands at
~150s. Same loop. It is a real defect fixed on its own terms, not the remedy.
The wiring-map thread independently checked the hole worth worrying about —
that excluding the liveness path could leave an idle app unable to arm at all —
and confirmed `onBootComplete` plus the early-arm path closes it.

