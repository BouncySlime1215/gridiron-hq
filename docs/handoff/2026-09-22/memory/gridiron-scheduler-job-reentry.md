---
name: gridiron-scheduler-job-reentry
description: Five independent callers could start the same scheduler job concurrently because the only guards were per-tier and per-caller; fixed in PR #33 with a per-job in-flight map.
metadata:
  type: project
  modified: 2026-09-19T19:55:00.000Z
---

Found 2026-09-19 while checking a peer thread's claim that `bootJobs` contains
no fantasy job. That claim is true and is NOT a defect — see the bottom. This
is what looking into it actually turned up.

**`runIfStale` had no per-job concurrency guard.** `scheduler.js`'s `tier()`
helper guards a tier against its own next pass, and the file's comment says so
in capitals, which is why this hid: a tier never runs on top of itself, but a
JOB did, routinely. Five independent callers reach `runIfStale`:

1. the boot catch-up pass, 20s after `startScheduler`
2. the live timer, every 90s
3. the background timer, every `intervalMinutes` (5 at the live call site)
4. `refreshInBackground`, on page loads
5. `POST /api/mlb/sync/now?job=X` and `POST /api/nfl-betting/sync`, by hand

**The staleness gate cannot coordinate them, and this is the non-obvious
part.** `record()` runs only AFTER `job.run()` returns, so for the entire time
a job is in flight its last recorded run is the previous one — it reads as
stale to every other caller, and they all start it. Callers 4 and 5 pass
`force: true` and skip the gate outright.

**It fired on every boot of the live app, not occasionally.** The boot pass
holds 18 jobs; `evidence_daemon` is ninth and spends its full 120s budget on
every run, so the pass is still going when the live timer fires at 90s. With
`node:sqlite` being synchronous, the duplicate is two transactions writing the
same tables and recording over each other's `sync_log` rows.

**Fix: PR #33**, a module-level `Map` of job name to in-flight promise, checked
ahead of the staleness gate so `force` cannot bypass it, cleared in a `finally`.
A second caller gets the SAME promise, so it receives the real result and the
work happens once. `runJobNow` holds the unchanged run.

**The bootJobs claim, resolved: not a defect, do not "fix" it.** 18 of its 20
entries are tier `live`, and the live timer runs those every 90s regardless of
the list, so membership buys 70 seconds after a restart. `player_rosters`
(live, 3h), `league_rosters` (live, 60m) and `nfl_injuries` (live, 6h) are all
live tier and therefore already scheduled. `espn_rosters` is growth with a
24-hour budget and gains nothing from a boot pass. The list's own comment says
it exists to keep launch interactive; adding long fantasy syncs to it would
reintroduce what it was curated to avoid.

See [[gridiron-scheduler-outage-2026-09-19]] for the rest of the stack.
