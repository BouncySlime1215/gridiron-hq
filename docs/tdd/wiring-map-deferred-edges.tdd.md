# A script does not reach through a function body

Reach is of kinds and is never summed (Auditor R17). This generator summed them:
one import graph, one walk, every surface kind following every edge.

## The case, found by running the scripts rather than reading them

The map said `scripts/diagnose-passing-components.mjs` reaches
`server/services/model-governance.js` at 6 hops:

    scripts/diagnose-passing-components.mjs
      -> server/services/nfl-passing-diagnostic.js
      -> server/services/nfl-props.js
      -> server/services/nfl-pbp.js
      -> server/services/scheduler.js
      -> server/services/nfl-pick-watch.js
      -> server/services/model-governance.js

`model-governance.js:88-89` calls `seedContracts()` and `seedRegistry()` at module
top level, so **anything that imports it writes 43 rows**. That makes the claim
testable. Run each script against a migrated copy of `server/data.sqlite` and diff
`sqlite_master` plus every table's row count:

| script | rows written |
|---|---|
| `scripts/nfl-blind-audit.mjs` (`audit:nfl`) | 32 into `model_feature_contracts`, 11 into `model_registry` |
| `scripts/diagnose-passing-components.mjs` (`diagnose:nfl-passing`) | **none, anywhere** |

The difference is one edge: `scheduler.js:1002`,
`const { reshopOpenPicks } = await import('./nfl-pick-watch.js')`, inside a job
body. Importing the scheduler does not import pick-watch. `nfl-blind-audit.mjs`'s
chain to the same module (`nfl-ensemble.js → nfl-player-value.js →
nfl-pregame.js`) is plain static imports the whole way.

## The rule

The edge is real, so it is labelled, not deleted:

- **load edge** — a static import, a bare import, a re-export, or a dynamic
  import at module scope. Module-scope `await import(...)` runs when the module
  is imported, so it belongs here; depth is the test, not the keyword.
- **deferred edge** — a dynamic import at depth > 0. It runs only if the
  enclosing function is called.

Which walk follows which:

- **route reach** and **job reach** follow both. A handler or a job body executes
  its own code, so `betting-hub.js:598` genuinely runs `nfl-pick-watch.js` when
  that endpoint is hit. Dropping those edges would delete real reach.
- **script reach** follows load edges only. A script loads its closure and then
  calls what it calls; the map cannot know which functions run, so crediting it
  with everything a function body *might* import over-reports — measurably.

`moduleEdges` sets `deferred` per import, `build()` carries a second graph with
them removed, and the surface walk picks its edge set by `s.kind === 'script'`.

## Measured, same tree, old code vs new

| | before | after |
|---|---|---|
| modules losing **all** script reach | — | **86** |
| modules gaining one | — | **0** |
| (module, script) pairs removed | — | **6,795** |
| modules whose route families changed | — | **0** |
| modules whose jobs changed | — | **0** |
| inventory grades moved | — | **0** |

`model-governance.js` keeps `nfl-blind-audit.mjs` and loses
`diagnose-passing-components.mjs`, which is exactly what the two runs showed.
`nfl-features.js` keeps its 4-hop reach from `audit:nfl` — an entirely static
chain, and the case the previous fix existed for.

**The two fixes interact, and the net is worth saying plainly.** Several modules
that gained a script reach from lifting `CLOSE_HOPS` — `forecast-packet.js`,
`spread-probabilities.js`, the seven `server/modeling/*` — lose it again here,
because what they gained came through the scheduler's job-body edge. The
empirical runs support the net answer, not either fix alone.

Three findings fall out of the tighter reach and are **not** investigated here:
`falls-with-a-deleted-route` on `nfl-evidence-provenance.js`, `nfl-news-events.js`
and `trial-statistics.js`.

## Tests — `test/wiring-map-deferred-edges.test.js`

Six cases, two of them the RED (`dbe7370`):

1. **RED** `moduleEdges` labels a function-body dynamic import `deferred` and
   leaves a module-scope `await import` and a static import as load edges.
2. **RED** a script does not reach `model-governance.js` through the job body.
3. a script still reaches it through the fully static chain — the control,
   without which the fix could pass by pruning everything.
4. a route handler keeps the reach its own dynamic import gives it.
5. a job keeps the reach its own dynamic import gives it.
6. the scripts bucket does not collapse: more than 200 modules still carry one.

Cases 3–6 are the over-pruning guard. Dropping deferred edges everywhere passes
1 and 2 and is wrong.

## Scripts run empirically, and none of them bills

Standing rule: R&D, nothing paid, ever. Before each run I checked the script's
import closure for an Anthropic client construction.

| script | closure | Anthropic |
|---|---|---|
| `scripts/migrate.mjs` | 9 modules | no mention at all |
| `scripts/nfl-blind-audit.mjs` | 222 modules | `claude.js` present, unreachable on this path |
| `scripts/diagnose-passing-components.mjs` | 218 modules | same |

`server/services/claude.js` cannot fire on either path: the SDK is
`await import('@anthropic-ai/sdk')` **inside** `clientFor()` at `:142-143`, the
only `messages.create` is at `:246` in that same lazy path, and the file has no
top-level call statements, so importing it constructs nothing. `audit:nfl` runs
the `protocol` command, which returns a constant spec; `diagnose:nfl-passing` is
a numeric replay. The empirical side agrees — `claude.js`'s own `app_settings`
writes at `:57, :65, :73` produced nothing, so the module was never entered.
`scripts/run-news-event-impact.mjs` is on the do-not-run list and was not run.

Every run used `GRIDIRON_DB_PATH` pointed at a copy. The primary
`server/data.sqlite` was read, never written.

## The five questions

- **Well built?** One flag on the edge, one derived graph, one branch in the
  walk. Nothing is deleted from the model, so a later consumer can ask for either
  kind. The over-pruning guard is in the tests, not in review.
- **Stats or made up?** Measured twice over: the artifact diff (86 / 0 / 6,795 /
  0 / 0) and, underneath it, two real script runs whose durable output was read
  out of a database rather than argued from source.
- **How do we know?** The prediction came first. `model-governance.js` seeds at
  import, so "does this script reach it" has a yes/no answer in a row count. The
  map said yes for both scripts; the database said yes for one.
- **Pointed anywhere else on the platform?** Yes. 240 function-body imports
  against 1,687 module-scope ones across the repo, and every reachability
  question asked of this map has been summing them. The same applies to anything
  built on `importsOf` without asking which kind of reach it means.
- **How does it unify?** Third time this week the same shape: a single answer
  computed for a question that was really several. `boot:` made reachability
  answer yes always, `CLOSE_HOPS` made it no at the tail, and one import graph
  made a script look like a job.
