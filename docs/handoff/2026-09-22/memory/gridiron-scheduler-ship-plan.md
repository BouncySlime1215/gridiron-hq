---
name: gridiron-scheduler-ship-plan
description: The eight scheduler PRs are merged into main (2026-09-19 21:22Z); what remains is the deploy-time steps and three things not to misread afterwards.
metadata:
  type: project
  modified: 2026-09-19T21:32:00.000Z
---

**MERGED.** Nick pushed `ffe4e72..791b131` to main at 2026-09-19 21:22Z. All
eight are in: **#17 #19 #20 #28 #29 #31 #32 #33**. Not yet deployed at time of
writing. Diagnosis is in [[gridiron-scheduler-outage-2026-09-19]].

- **#17** heavy tier into worker threads, `/api/health`, fly.toml http_check
- **#19** retry backoff, `consecutive_failures`, honest status
- **#20** the six fantasy feeds put on timers
- **#28** `nfelo_sync` and `ffopportunity` off the request thread
- **#29** event-loop watchdog, armed by a served response
- **#31** `POST /api/model/sync` ingests the season being played
- **#32** `evidence_daemon` and `nfl_reports` off the request thread
- **#33** a job can no longer run on top of itself —
  [[gridiron-scheduler-job-reentry]]

Proved before merge: 2812 tests, 2771 pass, 0 fail, 41 skipped; lint,
typecheck and `npm run start:smoke` clean; all eight CI green.

**#17 also carried a late security fix.** `GET /api/health` was returning
`{ ok: false, error: error.message }` — an unauthenticated public endpoint
handing out a raw SQLite error naming the database path. Now exactly
`{ ok: false }`, cause to the process log, handler extracted to
`server/platform/health.js` so the failure path is testable at all.

## Three things that change what the deploy looks like

**1. AUTO_HEAVY_SYNC is a deploy-time step, not a precondition.** Nothing in
the eight depends on the flag being unset — #17 is what makes the heavy tier
safe to run at all. Order: deploy, THEN turn it back on. It had been treated
project-wide as a blocker Nick had to clear first; it is not.

**2. No PR here backfills 2021-2024 QBR.** Verified in code:
`nfl_qbr_weekly` is written only by `syncQbr` (`nfl-qbr.js:41`); its only
scheduled caller is `nfl_qbr_weather` (growth, 24h) passing
`seasons: [season-1, season]`; and `POST /api/model/sync`, the route #31
changes, never calls it. So the hold in [[gridiron-open-risks]] is safe.

**3. The post-deploy check must test SCHEDULING, not status.** Every
unscheduled source reads `ok` today only because a human swept it — see
[[gridiron-live-data-state]]. "Everything reads ok" proves nothing. Read
`GET /api/mlb/sync/status` and confirm **`scheduled_now: true` and a
`due_after_minutes`** on each fantasy source; those two fields exist in #19
precisely to answer this.

**And one thing not to misread:** `evidence_daemon` has never once succeeded
(29 runs, 29 timeouts at its 120s budget). #32 makes that failure cheap, which
also makes it quiet. A clean live tier after the deploy is not evidence
capture working. Same for `nfl_prop_calibration`, which crashes on a null
before doing anything. Both are betting-side and deliberately unfixed.

Open follow-ups: [[gridiron-ffopportunity-held-gap]] and PR #39
([[gridiron-migration-number-collisions]]).
