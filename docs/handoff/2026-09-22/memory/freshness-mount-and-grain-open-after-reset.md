---
name: freshness-mount-and-grain-open-after-reset
description: Two items left open on the data-freshness seam when work paused for Nick's 08:53Z usage order — the route is not mounted, and the two sides use different `grain` vocabularies.
metadata:
  type: project
---

Both sides of the freshness seam are fixed and pushed as of 2026-09-22 ~08:56Z
(**#96** registry + **#104** evaluator on the producer side, **#86** at `071c6c1`
on the consumer side). Two things were NOT done before the pause, neither of them
a defect in what shipped:

## 1. The route is not mounted

`server/routes/data-freshness.js` exists and nothing in `server/index.js`
imports it, so the endpoint answers nowhere. **This is the same state #96 was in
and it reads identically from outside: the service exists, nothing reaches it.**

`server/index.js` is the Scheduler thread's file, but **the mount cannot be made
from a branch off `main`** — the route file does not exist there
(`git cat-file -e 654ff93:server/routes/data-freshness.js` → does not exist), so
the import would fail at boot and `start:smoke` would go red. It has to land on
a tree that already carries the route, i.e. UI's.

Scheduler handed UI the two lines 08:55Z as an **explicit handover of those two
lines only**:

```js
// near the other route imports, server/index.js:43
const { default: dataFreshnessRouter } = await import('./routes/data-freshness.js');
// beside the other authenticated mounts, next to :134's /api/model
app.use('/api/data-freshness', ...legacyAuthenticated, dataFreshnessRouter);
```

`legacyAuthenticated` is destructured at `server/index.js:57` and **spread**, not
passed as an array.

**UI accepted the handover 08:56Z and verified all four facts against `071c6c1`
rather than trusting them:** `useApi` fetches `` `/api${path}` ``
(`client/src/api.ts:56`) and the banner calls `/data-freshness`, so
`/api/data-freshness` is the matching path; `data-freshness.js:38` is
`export default r`, so the destructured import is right; the spread is correct;
and the off-main boot failure reproduces. **It is NOT applied yet** — applying
costs a full `npm run check`, which is the burn the usage order stopped. UI has
it queued in memory as `gridiron-data-freshness-mount-handover` with the lines
verbatim. After the reset it is a paste, a check and a push on their branch, and
**nothing about it needs the Scheduler thread.** Do not re-derive it or re-hand
it over. Confirm with `grep -n data-freshness server/index.js` before believing
it either way. Mounted is also still not live: the deploy is Nick's word.

## 2. The two sides use different `grain` vocabularies

Producer (`servedTables()`) emits `'week' | 'season' | 'static' | 'fit'`.
Consumer (`data-freshness.js`) expects `'feed' | 'fit'`, defaulting to `'feed'`.
So a `'week'`, `'season'` or `'static'` entry arrives as a grain the consumer has
no case for. **One side has to widen; nobody has decided which.** UI raised it
and agrees it is open.

This is the same class of defect as the one that started the whole episode
([[freshness-contract-seam-failed-open]]) and it is smaller only by luck: the
verdict does not depend on `grain`, so it degrades to a display oddity rather
than a wrong answer. Worth fixing before it becomes load-bearing.

## Also still open

UI has **not** swapped `askRule()` for `servedTableVerdicts` — its own evaluator
duplicates the logic, correctly, on its side. Their write-up is
`gridiron-merge-order-86-before-96`.

**Merge order, agreed by both sides and stated on both PRs: #86 lands with or
before #96, never after.** #96 alone hands the shipped rule shape to a reader
that cannot parse it, and the failure is silent and total.

Related: [[freshness-contract-seam-failed-open]],
[[servedtables-is-coverage-not-timestamps]], [[gridiron-file-allocation]].
