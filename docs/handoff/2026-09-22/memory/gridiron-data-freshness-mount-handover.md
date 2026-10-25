---
name: gridiron-data-freshness-mount-handover
description: The Scheduler thread formally handed the two /api/data-freshness mount lines in server/index.js to the xiezr0 thread; verified correct against 071c6c1, not yet applied — paused for the 11:11Z usage reset.
metadata:
  type: project
---

**Recorded handover, 2026-09-22T08:55Z.** The Scheduler thread
(`session_01DrNvRmumDqr2e83XuG7Qr1`), which owns `server/index.js` under the
one-editor rule, explicitly handed **these two lines only** to the xiezr0 thread.
Nothing else in that file moves.

**Why it had to go this way:** `server/routes/data-freshness.js` does not exist on
`main` (`git cat-file -e 654ff93:server/routes/data-freshness.js` → does not exist). It
exists only on `claude/project-thread-xiezr0-data-freshness`. A mount on any branch off
`main` would import a missing module, the app would fail to boot and `start:smoke` would
go red. The mount must live on a tree that already carries the route.

```js
// with the other route imports, near server/index.js:43
const { default: dataFreshnessRouter } = await import('./routes/data-freshness.js');

// with the other authenticated mounts, next to :134's /api/model
app.use('/api/data-freshness', ...legacyAuthenticated, dataFreshnessRouter);
```

**Verified against `071c6c1` 2026-09-22T09:12Z, all four:**

- `useApi` fetches `` `/api${path}` `` (`client/src/api.ts:56`) and the banner calls
  `/data-freshness`, so `/api/data-freshness` is the matching path. No vocabulary
  mismatch — which is what the whole #86/#96 episode was about, so it was checked
  rather than assumed. See [[a-shape-mismatch-can-pass-every-guard]].
- `server/routes/data-freshness.js:38` is `export default r`, so the destructured
  `{ default: ... }` import is right.
- `legacyAuthenticated` is destructured at `server/index.js:57` and **spread** into
  every data mount (`:105-107`, `:134`). Spread it; do not pass the array.
- That gate is what the route's own header asks for, and it keeps
  `platform/health.js` the only unauthenticated liveness endpoint.

**APPLIED LOCALLY 2026-09-22T11:40Z, NOT PUSHED.** Commit `5af541c` on
`claude/project-thread-xiezr0-data-freshness` (branch local head `9f899d1`; remote is
still `071c6c1`). `npm run check` on `5af541c` / tree `8850b4b3`: rc=0, 3056 tests,
3015 pass, 0 fail, 41 skip, and **`start:smoke` boots the app with the route mounted**,
which is the mount's real proof rather than a static argument. The push is held under
the standing instruction that nothing pushes until Nick restores it.

**Say it in #86's body when it lands.** "The service exists and nothing mounts it" is
the state #96 was in and reads identically from outside. Mounted and live are still
separate milestones — the deploy is its own step, see
[[gridiron-deploy-step-2026-09-22]]. Merge order unchanged:
[[gridiron-merge-order-86-before-96]].
