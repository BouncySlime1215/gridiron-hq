---
name: boot-reaches-everything-exclude-it-from-reachability
description: Reachability over gridiron-hq's wiring map — drop the server/index.js→routes edges (not the boot file), count a package.json script as an entry point, and match betting prefixes as prefixes.
metadata:
  type: feedback
  modified: 2026-09-22T12:07:33.660Z
---

`server/index.js` mounts every route, so in `docs/wiring/wiring-map.json` it
reaches every reachable module, and the map files it under each module's `pages`
array as `boot:server/index.js` — on 140+ of 658 modules. Any question of the
form "is X reached ONLY from <set>?" answers "no" for everything if that counts.
Measured 2026-09-22: including it graded **13 of 19** betting-only rows back to
`wired`, and an independent BFS written to double-check reported the same false
result, so both the implementation and its check walked into it.

**The right fix is Opportunity's, not mine.** Drop the
`server/index.js -> server/routes/*` **edges**, not the file
(`dropRouteBootEdges` in `scripts/reach-grade.mjs`): a mounted route is already
an entry point, and an unmounted one loads at boot with handlers that never run,
while everything else `index.js` imports (scheduler, legacy-access) **is**
genuinely reached at boot. Excluding the file by name also works on today's
graph — measured, 0 of 67 betting-only modules are reached from `index.js` once
route edges are dropped — but it is right by coincidence: a module reached via
the scheduler and not via any route would be graded wrong by the by-name rule.

**Three more rules the same sweep established, each after getting it wrong:**

1. **A script named in `package.json` IS an entry point** (CONTRACT.md's `wired`
   test says so). `reachesLiveSurface()` ignores the map's `scripts` bucket
   correctly — a script is not a live *surface* — but "is every way in a betting
   route" is a different question, and `npm run build:role-scenario-lab` is a way
   in. Ignoring it mis-graded **12** rows. A **hand-run** script (no importer,
   not in `package.json`) still does not disqualify: the contract says never
   record that as `wired`.
2. **Match betting surfaces by PREFIX with a `/` boundary.** `routes/wong.js` is
   mounted at `/api/betting/wong`; equality comparison invents a fourth,
   non-betting surface out of a sub-path of the betting hub.
3. **Test the subject's own entry-point status.** Opportunity's grader read 19 of
   31 route files as unreached because the walk never asked whether the subject
   was itself mounted (fixed at `1b05525`).

**Two map facts, measured, worth not re-deriving:** `wiring.route_families`,
`.jobs`, `.pages` are complete enumerated sets, not first-hit results
(`player-week-engine.js` carries `/api/model@1` and `/api/betting@2` together);
and `MAX_HOPS = 12` (`scripts/wiring-map.mjs:2361`) does not bind — the longest
route-to-module distance in the graph is **8**.

**Blind spot both graders share:** the import graph is built from literal
specifiers, so `server/db/migrate.js:49`'s computed
`await import(pathToFileURL(...))` is invisible and every `server/migrations/`
file reads unreached. Seed a walk from the migration files as entry points in
their own right rather than trying to resolve it.

**Open contract question, not settled:** `CONTRACT.md` names three betting route
files, and at least two more betting surfaces exist —
`server/routes/execution-slate.js` and `server/routes/wong.js`. Set diff at
`/mnt/project-files/betting-only-set-diff-2026-09-22.tsv`.

Related: [[an-empty-read-must-not-reach-a-written-report]],
[[local-data-sqlite-is-at-migration-000]].
