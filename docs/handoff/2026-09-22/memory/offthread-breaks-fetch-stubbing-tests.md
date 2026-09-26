---
name: offthread-breaks-fetch-stubbing-tests
description: Giving a gridiron scheduler job offThread:true breaks any test that stubs globalThis.fetch and drives it through runIfStale — the Worker is a separate V8 isolate that never sees the stub, and the job reports ran:true with zero rows.
metadata:
  type: project
---

**`runJobOffThread` spawns a real Worker, in a separate V8 isolate.** A test that
stubs `globalThis.fetch` in the main isolate and then drives the job through
`runIfStale` is stubbing a global the job never sees. The offline guard
(`test/offline-guard.mjs`) then blocks the real network call, and the job comes
back **`ran: true` with zero rows** — passing shape, no data, no error.

So adding `offThread: true` to a job can break a test that never mentions
threading, in a way that looks like a data problem rather than a wiring one.

**Measured:** found by Trade Brain 2026-09-22 rebuilding on #89's true head.
`test/league-history-schedule.test.js:90` broke on `6c6c672` the moment
`league_history` gained the flag; Chat sync fixed the test by passing
`offThread: false` in its own `runIfStale` call.

**Still latent:** `test/league-roster-schedule.test.js:38` and `:60` are in the
same shape and pass today only because `league_rosters`
(`scheduler.js:1263`) carries no flag. **Flag that job and that file fails the
same way.** Check it before adding `offThread: true` there.

**How to apply.** Before giving any job `offThread: true`, grep the test suite
for tests that drive it through `runIfStale` while stubbing `fetch`, and pass
`offThread: false` in the test's own `runIfStale` call. The flag belongs in
production wiring; a test that wants to exercise the job body wants it inline.

**And the lesson about verifying a cross-branch fix.** My control triple for the
#89/#95 collision injected a synthetic `league_history` job onto #95's tree
rather than merging #89's actual branch — so **every test #89 ADDS was invisible
to it**, including the one that broke. The triple's conclusion (the two
accountability tests pass with the flag, fail without it, baseline green) was
correct and is unaffected; it was just narrower than "verified end to end"
suggests. **Simulating the other branch's change tests your reading of it, not
their branch.** When both branches are reachable, merge them in a scratch
worktree and run the union of the suites; when one is held in another session's
sandbox, say which half was tested and which was inferred.

See [[scheduler-tier-is-not-the-thread]], [[gridiron-file-allocation]].
