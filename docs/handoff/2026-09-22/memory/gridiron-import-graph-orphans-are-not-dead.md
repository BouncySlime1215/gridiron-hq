---
name: gridiron-import-graph-orphans-are-not-dead
description: On gridiron-hq, "imported by nothing" does not mean dead — fork(new URL(...)), package.json scripts and express route registration are entry points an import-graph scan cannot see.
metadata:
  type: feedback
  modified: 2026-09-20T06:30:00.000Z
---

**Before deleting anything a scan called an orphan, check the three entry
points an import graph does not model.** 2026-09-20, the wiring map's sweep
reported `server/scripts/run-nfl-ai-replay.js` and `server/scripts/sync-history.js`
as "imported by nothing: delete or name the caller". Both are live:

- `run-nfl-ai-replay.js` is spawned at `server/services/nfl-ai-replay.js:376`
  with `fork(new URL('../scripts/run-nfl-ai-replay.js', import.meta.url), ...)`
  — the detached worker the AI replay feature reconstructs in.
- `sync-history.js` is `package.json:27`, the `sync:history` npm script.

Deleting either would have removed a working feature. The scan was right about
what it measured and wrong about what it concluded, which is the same failure
as [[gridiron-cite-the-shipping-tree]]: a plausible claim that fails silently.

**The roots to add before trusting an orphan list:** `fork`/`spawn`/`execFile`
by `new URL(...)` or by path string; every `package.json` `scripts` entry; and
`new Worker(new URL(...))`. This repo uses all three.

**The same caution in its other direction.** An uncalled express route is not
automatically dead either, but it is not automatically worth keeping. The test
that separates them is whether it duplicates something already reachable:

- `GET /dev/usage` answered `usageSummary(Number(req.query.days) || 30)` and
  `GET /dev/status` already answered `usage: usageSummary(30)`. A strict
  duplicate whose only extra was a parameter no caller passed. **Deleted.**
- `/dev/sources`, and two player-identity dry-runs, are read-only diagnostics
  with no duplicate anywhere. `/dev/sources` is the ONLY inventory of every
  source with its staleness, which is the thing Finding 7 says no surface
  shows. **Kept, and pinned by `test/dev-routes.test.js`** — rotting unnoticed
  is the real risk of an uncalled route, and a test removes it.

**And a grep that excludes the defining module hides same-module use.** This
thread reported `MIGRATIONS_ROOT` and `EVIDENCE_ROOT` in `platform/paths.js` as
uncalled; both are named inside `resolvedRoots()` in that same file. Only
`dataPath` and `docsPath` were genuinely unreferenced. Check inside the file
before calling an export unused.

**The third kind: an orphaned backend of a DELETED page.** `/dev/sources`
scanned as dead because its caller no longer exists. It had one:
`docs/evidence/history/platform-audit-implementation-2026-09-08.md:29` and
`:74` record a "Data health center" at `/data-health` (Lab nav group) built to
surface `/dev/sources`, and `docs/STRUCTURAL-RELOOK.md:24` records the UI
teardown (`60f5f5d`) that removed it. **The surface was torn out; the need was
not.** `/dev/sources` is still the only thing in the app that computes
per-source staleness — the exact thing Finding 7 says no surface shows.

So Finding 7's honest statement is not "no surface shows an age". It is: the
computation exists and answers today at `GET /api/dev/sources`; the page that
showed it was deleted. That is a different decision for Nick — whether the
teardown went one page too far — and NOT a licence to rebuild it: his standing
rule is never rebuild a deleted page.

**A ref count that does not separate "dialled" from "merely named" is not
evidence.** `/dev/sources` showed "refs: 4" and none of the four was an HTTP
dial: two docs prose, one test comment, one assertion MESSAGE string. Same gap
in the other direction at `docs/tdd/llm-plumbing.tdd.md:104`, where
`PUT /api/dev/llm-budget/:key` is a RECOMMENDATION for a route nobody built —
reading it as a caller would send someone building it.

Related: [[gridiron-failure-modes]], [[gridiron-league-transactions-raw-unwritten-on-fly]],
[[gridiron-cite-the-shipping-tree]].
