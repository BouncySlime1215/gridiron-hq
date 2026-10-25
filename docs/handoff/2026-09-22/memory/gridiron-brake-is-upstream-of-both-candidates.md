---
name: gridiron-brake-is-upstream-of-both-candidates
description: Why SCHEDULER_DISABLED=1 stops both restart-cycle candidates at once — one return at scheduler.js:1732-1735 precedes every timer — and therefore what a clean run under the brake can and cannot prove.
metadata:
  type: project
---

**The structure, at 791b131.** `startScheduler` begins with
`if (process.env.SCHEDULER_DISABLED === '1') { console.log(…); return { disabled: true }; }`
at `server/services/scheduler.js:1732-1735`. **Every** timer in the function is
created after it:

- `:1741` the 20-second boot pass (20 jobs)
- `:1751` `nfl_model_growth` at `Math.max(90000, bootDelayMs + 60000)`
- `:1754` `nfl_reports` at `Math.max(150000, bootDelayMs + 120000)`
- the four `tier()` `setInterval`s below, live tier included

So both candidates memory names for the restart cycle — the growth job at 90 s
and the live tier at 90 s — are downstream of the same one statement. There is
no version of the brake reaching one and not the other.

**What that means for evidence.** A long uptime under the brake proves the loop
survives with the scheduler off; it **cannot** discriminate between the two
candidates, because the brake stops both. Attribution only comes after the
unset, where the timing separates them: the growth job's timeout fires **once
per boot**, the live tier fires **every 90 s forever**, so a death about three
minutes after the unset points at the live tier. See
[[gridiron-restart-cycle-2026-09-19]].

**What the uptime does add.** `startLoopWatchdog()` still runs
(`server/index.js:178`), and on 791b131 it is still armed by the first completed
HTTP response — on Fly, the platform's own probe about 15 s in. So the watchdog
is awake under the brake and would still SIGKILL on a 60-second stall. A long
uptime is therefore a continuously tested claim, not an unwatched machine.

**What keeps running under the brake**, because `server/index.js` starts them
separately at `:80` and `:84` and the brake never touches them:
`draft-auto-pick-clock` (2-second tick) and `draft-finalize-watch` (10 minutes),
both via `platform/jobs.js`. **A live draft behaves normally under the brake.**
Everything else — news, lines, play-by-play, scores, model growth, ESPN refresh
— is a scheduler tier and stops.

**What is not a fault while the brake is on:** every "last updated" and "as of"
frozen at the moment the brake was set, source-confidence numbers falling, and
diagnostic panels listing sources as stale or erroring. All of those read
`last_run_at`, which nothing is advancing on purpose. A stale timestamp is the
brake working; an unresponsive page would be the fault. Worth volunteering
before he opens the app and reports the freeze as a bug.

**Measured 2026-09-20**: Nick set the brake himself at 13:43Z; three reads at
16:01:32Z / 16:02:28Z / 16:02:48Z returned `uptime_s` 8298 / 8353 / 8374, each
answering in under a second, all three implying a boot at 13:43:14±1Z.
