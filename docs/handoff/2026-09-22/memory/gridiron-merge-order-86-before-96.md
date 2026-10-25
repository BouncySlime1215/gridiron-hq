---
name: gridiron-merge-order-86-before-96
description: PR #96 (servedTables()) must merge with or after PR #86, never before — alone it hands the {sql,params} rule shape to a reader that silently reports every table fresh; #104 adds the evaluator #86 should then delegate to.
metadata:
  type: project
---

**PR #96 must not merge ahead of PR #86.** Order is: #86 first, or both together.
#104 is stacked on #96 and carries the shared evaluator.

#96 exports `servedTables()` from `server/services/source-registry.js`, whose
current-data rules are in the `{ sql, params, text }` shape. Until #86
(`claude/project-thread-xiezr0-data-freshness`, head `071c6c1`, 2026-09-22T09:05Z)
merged, `data-freshness.js` only understood `{ predicate, bind, description }` and
treated the shipped shape as "no rule", falling through to `row_count > 0`. Every
table with any row reports `fresh`, `stale` unreachable, no error anywhere. See
[[a-shape-mismatch-can-pass-every-guard]] for the five-line path.

The fallback registry reads today's data correctly as `stale`, so #96 landing first
would make the freshness light **less** truthful than no registry at all. Stated in
#86's body under "Merge order".

**Measured from both sides, independently.** The Scheduler thread ran #86's files at
`3d92ccb` over its registry at `a24692d` on a real migrated DB: with `FALLBACK_REGISTRY`
→ `stale`, correct; with `servedTables()` → `fresh`, `row_count: 15`,
`current_rule: null`, and **all 17 entries read rule NULL**. #86's own RED test pins the
same specimen (2021-2025 loaded, 2026 week 3 asked).

**Do not "fix" this by having the registry emit a predicate.** Two of the 17 rules are
universals a WHERE fragment cannot carry: `roster_players` is
`MIN(fetched_at) >= datetime('now','-1 day')` and `gamescript_model` is
`COUNT(DISTINCT target) >= 2`. A fragment matching one row answers "at least one is
fresh", which for the second is exactly the half-fitted-model bug the rule exists to
catch.

**DONE 2026-09-22T11:40Z, local commit `5af541c`, not pushed.** `askRule()` delegates to
#104's export, feature-detected (`typeof registry.evaluateServedTable === 'function'`)
exactly as `servedTables()` is, since a hard import would make the module unloadable
until #104 merges. Its throw becomes `status: 'unknown'` with the reason. Tested from
both sides with `mock.module` — the real evaluator has never run against it, and the
first real exercise is the merge. Grain also widened to the producer's four ('week',
'season', 'static', 'fit'); an unstated grain is now `null`, not the invented `'feed'`.
Signature verified by `git fetch` and reading the file, not taken on report — branch
`claude/project-thread-o3wt2p-freshness-evaluator` @ `e3a8676`, exports at lines 346,
623, 684:

```js
import { servedTableVerdicts, evaluateServedTable } from './source-registry.js';
servedTableVerdicts({ entries = servedTables(), season, week, database })
  // -> [{ table, current: true|false|null, rule, grain, reader, error }]
evaluateServedTable(entry, { season, week, database })  // THROWS on an unrunnable rule
```

`current: null` maps onto #86's `status: 'unknown'` — same three-valued contract reached
from both ends. Their `grain` is `'week'|'season'|'static'|'fit'`, wider than #86's
`'feed'|'fit'`; reconcile when delegating. Their `runMigrations()` is a separate call
from opening the DB (6 of 17 tables come from numbered migrations, `league_roster_snapshots`
is 058), so a harness that only imports `server/db/index.js` gets `no such table`.

Also: #104 corrects the `roster_players` rule sentence (it said "every connected league";
that table references `nfl_teams` and has no league column — fantasy rosters are
`league_roster_snapshots`). **#86 needs no change for it** — verified 09:10Z that neither
`DataFreshnessBanner.tsx` nor `data-freshness.js` hardcodes any table's sentence; it is
passed through from the registry, so the correction propagates on its own.

The route `/api/data-freshness` is still not mounted — two lines in `server/index.js`,
which the Scheduler thread owns. Mounted and live are separate milestones; see
[[gridiron-deploy-step-2026-09-22]].
