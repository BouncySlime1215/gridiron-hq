---
name: gridiron-live-tier-boot-fix-gap
description: #59's boot fix does not survive the first live tick — fourteen live jobs go off-thread once at boot and run inline every 90 s after; and 23 of 24 live jobs are inline on 791b131, not 21.
metadata:
  type: project
  modified: 2026-09-20T03:30:00.000Z
---

**Verified against `791b131` itself**, per [[gridiron-cite-the-shipping-tree]].

## The gap

#59 takes the boot pass off the request thread by passing `bootOffThread(j)`
as an override (`scheduler.js:2051` at the stack tip). **The live timer calls
`runIfStale(j)` with no override**, so `resolveOffThread` falls back to
`job.offThread ?? job.tier === 'heavy'` — false for a live job.

**Fourteen jobs go into a worker once at boot and run on the request thread
every 90 s for the rest of the process's life.** (18 of the 20 `BOOT_JOBS` are
live-tier, 3 are in `MAIN_THREAD_ONLY`, `evidence_daemon` has its own flag.)

**This is #63's defect on a different tier**, and fixing #63's single instance
made these fourteen *harder* to see, because the shape looked handled.
Consequence for the morning: **the first 90 s after a boot are not
representative of the next 90**, so uptime read inside that window overstates.

## Numbers on 791b131, checked by name

- `liveTimer = tier('live', live, liveIntervalSeconds * 1000)` — **:1800**
- `liveIntervalSeconds = 90` in the signature — **:1717**; `tier()` is plain
  `setInterval`, no leading call, so the first live pass is t+90 s
- `const offThread = job.offThread ?? job.tier === 'heavy';` — **:1605**
- The 2026-09-07 comment blaming the betting-side live tier's "90-second
  polling of a 6GB+ synchronous SQLite database" as "the actual cause of the
  app going periodically unresponsive" — **:1720–1731**, above the
  `SCHEDULER_DISABLED` check at :1732

**23 of the 24 live jobs are inline, NOT 21** (the release thread's figure).
Exactly **seven** `offThread: true` declarations exist in the whole file:
`nflverse_crosswalk`, `nflverse_weekly_usage`, `nflverse_snap_counts`,
`nfelo_sync`, `nfl_reports`, `ffopportunity` (growth) and `evidence_daemon`
(live). **`player_rosters` and `nfl_book_feeds_extra` do NOT declare it** —
checked by name.

## What is on the hold branch

`claude/project-thread-o3wt2p-growth-offthread-hold`, head **`bec666d`**,
**3002 tests / 0 fail / 41 skipped**, build and start:smoke clean. **Thirteen**
jobs moved off the request thread (6 growth, 7 live); **29 remain, every one
named** in `ON_REQUEST_THREAD`, which now covers every tier and whose size plus
`MAIN_THREAD_ONLY`'s is asserted to equal the number that actually block.

**`league_rosters`: reverted, then fixed properly.** Off-thread it turned two
tests red that stub `globalThis.fetch` on the MAIN thread and drive the job
through `runIfStale`, asserting real rows. **The tests were not the problem —
the test SHAPE was.** They asserted behaviour *through the scheduler*, which
made them silently conditional on the job running inline. `refreshLeagueRosters`
is now exported, the wiring is asserted against the registry and the behaviour
by calling the function directly — #45's `ffOpportunitySeasons` move.
**Generalise this: an off-thread job cannot be reached from the main thread's
test process, so a test that drives one through `runIfStale` is a test of the
thread, not of the work.**

## My recommendation, given 03:30Z

**After the unset, as a follow-up; NOT in the morning merge.** The brake stops
the live tier too, so it cannot help the 600 s proof; merging it into the same
deploy gives a death in the 900 s window two candidate causes instead of one;
and the betting-side 3-minute jobs the 2026-09-07 comment actually blames are
the ones NOT moved. Nick's call if he wants one deploy instead of two.

Freeze rules: [[gridiron-github-freeze-2026-09-20]]. Counts:
[[gridiron-scheduler-job-census]].
