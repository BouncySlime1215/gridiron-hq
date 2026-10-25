---
name: gridiron-ci-blockers
description: The five defects that kept gridiron-hq's CI from ever completing a run before 2026-09-19, and the split lesson about tests coupled to client source.
metadata:
  type: project
  modified: 2026-09-19T21:36:00.000Z
---

Found while splitting PR #6 ([[pr6-split-into-five]]). All fixed in PR #7,
now on main. CI's contract: one job, `timeout-minutes: 20`, Node 22,
`NODE_OPTIONS=--import ./test/offline-guard.mjs`.

**Four things were blocking CI, not one.**

1. The offline guard only wrapped `globalThis.fetch`. The Anthropic SDK uses
   node-fetch → `node:http`, so it walked straight past. It now wraps four
   seams (`fetch`, `http.request`, `https.request`, `net.Socket.connect`) and
   clears ambient provider credentials.
2. `mock.module()` takes `defaultExport` / `namedExports`, **not**
   `exports: { default }`. The wrong key is silently ignored, so the SDK got
   `{}`, threw `this.fetch.call is not a function`, surfaced it as a generic
   `APIConnectionError: Connection error.`, and sat through its retry
   backoff — about 20 minutes per run in two test files. This, not a missing
   API key, was the whole "14 known failures" baseline. (The claim it also
   spent real money is false: the SDK throws before any transport.)
3. `server/services/report-cache.js` called `worker.unref()` on the worker its
   own promise depends on, so Node resolved the loop first and reported three
   tests as **cancelled** rather than failed. Plus a result-overwrite race
   (results latched by report name, not by run) and a worker outliving its
   database. 1/4 → 6/6.
4. `npm run start:smoke` polled `/api/teams`, which is bearer-authenticated,
   so it 401'd eighty times and could never pass. CI never reported this
   because the test step timed out first.

**A fifth, found only by CI:** `prop-clv-free-capture` was a **time bomb**,
not a pre-existing failure — fixtures pinned to absolute dates fell out of a
rolling 14-day window on 2026-09-17. "Check out an older tree and see the
same failure" cannot tell a time bomb from a pre-existing bug.

Also: `process.env.X = undefined` stores the *string* `"undefined"`, which is
truthy. Clearing credentials created exactly that trap in `test/cfbd.test.js`;
the restore must `delete`.

**Measured.** main: 24 min 27 s, 15 fail, 3 cancelled. PR #7 in CI: 2,092
tests, 0 fail, 0 cancelled, whole job 6 min 03 s against the 20-minute
budget — the first CI run the repository had ever completed.

**Splitting lesson.** The seventh test in
`test/availability-honest-degradation.test.js` reads
`client/src/pages/Lineup.tsx`, so it could not pass in the server PR — a test
ahead of its subject. Before splitting server from client again, run
`grep -l "client/src" test/*.test.js`; four files do it.
