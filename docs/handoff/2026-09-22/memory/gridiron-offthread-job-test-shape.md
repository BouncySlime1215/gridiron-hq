---
name: gridiron-offthread-job-test-shape
description: A test that drives a Gridiron HQ scheduler job through runIfStale is testing the thread, not the work — the shape to use instead when moving a job off-thread turns its tests red.
metadata:
  type: feedback
  modified: 2026-09-20T04:00:00.000Z
---

**A test that drives an off-thread job through `runIfStale` is testing the
thread, not the work.**

`job-worker.js` gives each run a fresh module graph, its own globals and its
own SQLite connection. So a `globalThis.fetch` stub, a `mock.module()`, or any
other main-thread arrangement **never reaches the job**. The offline guard then
blocks the real call and the test goes red.

**Why this matters more than it sounds.** Such a test looks like a behaviour
test and is silently a thread test. It passes for as long as the job runs
inline, and the day someone moves the job off-thread it fails — for a reason
that has nothing to do with the behaviour it names. The tempting read is "these
tests are in the way of the fix", and deleting them is the worst available
outcome.

**The shape that works** (first used by #45 for `ffOpportunitySeasons`, then by
`league_rosters` on 2026-09-20):

1. **Export the work.** Make the job body, or the decision inside it, an
   export.
2. **Assert the behaviour by calling that export directly.** No `runIfStale`,
   no scheduler, no thread.
3. **Assert the wiring separately, against `JOBS`**: the job exists, `run` is
   that function, it has a tier, and `maxAgeMinutes` is finite and > 0. A job
   with `maxAgeMinutes: 0` is never stale and therefore never runs, and it
   looks exactly like a healthy registry entry — injection-tested.
4. **Do NOT assert off-thread in the wiring test.** That is a scheduling
   decision with its own guard; pinning it there is what couples the behaviour
   tests to the thread in the first place.

**Worked example.** `test/league-roster-schedule.test.js` stubbed
`globalThis.fetch` and drove `runIfStale('league_rosters', { force: true })`,
asserting real rows: a renamed league's payload refreshes, and one league's 500
does not stop the next league syncing. Both went red on the off-thread move.
Rewritten to the shape above, both still fail under injection — including
re-throwing inside the per-league `catch`, which is the regression the original
test existed to prevent.

`refreshLeagueRosters` is exported in `scheduler.js` for exactly this reason,
and its doc comment says so, so nobody un-exports it as dead API.

Related: [[gridiron-live-tier-boot-fix-gap]],
[[gridiron-a-cited-proof-is-not-a-proof]],
[[gridiron-tdd-evidence-sweep-o3wt2p]].
