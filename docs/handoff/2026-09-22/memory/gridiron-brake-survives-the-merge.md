---
name: gridiron-brake-survives-the-merge
description: Verified at #63's head 64f3ef2, and of record on the merged tree of all six — SCHEDULER_DISABLED still returns upstream of every scheduler timer after the six-PR merge, so a deploy under the brake honours it.
metadata:
  type: project
---

**CORRECTION (release thread).** The verification OF RECORD is on the MERGED
TREE of all six PRs, not on any single head: early return at
`scheduler.js:1927`, with boot pass `:1940`, growth `:1964`, reports `:1968`,
live tier `:2015` and background tier `:2016` all below it, and only
`reapAbandonedRuns()` at `:1914` and `onBootComplete?.()` at `:1931` above it.
The line numbers below are `64f3ef2`'s and differ; the structure is the same.
See [[gridiron-merge-facts-2026-09-20]].

**Why it mattered.** Nick's sequence is brake on → merge the six → deploy →
unset. The deploy has to come up **with the brake still honoured** or the
restart loop returns before he reaches the unset. #63 rewrites the boot path
around the brake, so the structural argument had to be re-read at the new code
rather than inherited from 791b131.

**Verified at `64f3ef2`** (read directly, not taken from another thread).
`server/services/scheduler.js`:

- `1904` `startScheduler({ …, onBootComplete = null })`
- `1914` `reapAbandonedRuns()`
- `1927` `if (process.env.SCHEDULER_DISABLED === '1') {`
- **`1933` `return { disabled: true }`**
- `1955` boot pass `setTimeout(…, bootDelayMs)` · `1965` growth timeout ·
  `1969` reports timeout · `2015` live tier · `2016` background tier

**Every timer is after 1933.** The move from `:1732` is the function growing
above the return, not the return moving. Same env check, same log line, same
early return. See [[gridiron-brake-is-upstream-of-both-candidates]].

**Two things run before the return that did not before; neither is a timer.**

1. `reapAbandonedRuns()` — a `SELECT … WHERE last_status = 'running'` plus one
   `UPDATE` per row and a `console.warn`. No timer, no job, no network. **A
   no-op on the deploy's first boot**: the only writer of that status is
   `recordStart` (:122-128), which ships in this same stack, and 791b131's sole
   `sync_log` writer `record()` writes only ok/skipped/error. A
   `[scheduler] N job(s) did not report back` line is the reaper working, not a
   fault.
2. `try { onBootComplete?.(); } catch {}` in the brake branch (`:1930`) — that
   is `armLoopWatchdog`, which before `app.listen` only sets the `armedEarly`
   flag (`loop-watchdog.js:127-131`). The heartbeat and worker are created in
   `startLoopWatchdog` alone.

**The watchdog claim gets STRONGER after the deploy.** Under the brake the arm
is held as `armedEarly` and applied the instant `startLoopWatchdog()` runs in
the listen callback (`server/index.js:186`), so the watchdog is armed **from
the moment the server listens**, not ~15 s later on the first probe response.
`watchdogArmingMiddleware` now returns early on an exact match of
`LIVENESS_PATH === '/api/health'`, so the Fly probe arms nothing.

**#49 does not touch the watchdog.** Its whole file list is `fly.toml`,
`test/fly-health-check-grace.test.js`, `docs/tdd/health-check-grace.tdd.md`.
`grace_period` 60s → 300s is Fly's routing/eviction timer; since #56 the health
path arms nothing, so the two no longer interact either way.

**Open nit:** `loop-watchdog.js:119` still returns
`armed_by: 'first completed HTTP response'`, wrong in both directions now.
Nothing reads or asserts it, so it changes no behaviour — it should ride the
next code push on that branch, not get its own.
