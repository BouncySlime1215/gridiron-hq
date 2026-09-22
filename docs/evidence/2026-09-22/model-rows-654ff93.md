# Honest inventory — the model rows, graded at 654ff93

Phase 0 item 5, the grading half. One row per fantasy-scope model; `kind` is
`model` throughout. The fragment is
`docs/evidence/2026-09-22/model-rows-654ff93.json`; the tables that still need
a live count are in `model-rows-live-count-wanted.json`.

Measured on `654ff9339832f3727f99db263abedf3e1227a9b3`, in a detached worktree
with `node_modules` symlinked — **source-isolated, not isolated**.
`git write-tree` before the run: `69440335b063cb59deaa1f3963b0f4a1de207481`.
Every figure this thread held before today was measured against `791b131`;
nothing from that tree is quoted here without being re-read at `654ff93`.

## The five definitions, and which of them this container can decide

| definition | decidable here? |
|---|---|
| `wired` — reachable from a live surface AND reads a table with current rows | **no**, the second half needs a live count |
| `half_done` — exists, not reachable or no consumer | yes, from the tree |
| `dead` — unreachable and imported by nothing | yes, from the tree |
| `silently_broken` — reachable, returns success, reads or writes nothing real | yes where the case is structural |
| `decoration` — renders a number no current row backs | **no**, needs a live count |

`server/data.sqlite` in this container has exactly one migration applied —
`schema_migrations` holds `000_legacy_schema`, applied `2026-09-20 11:33:43`,
and the other 62 files under `server/migrations/` are unapplied. 213 of its
215 tables hold zero rows; the two that are not empty are
`schema_migrations` (1) and `db_health_checks` (1). So a LOCAL zero cannot
tell "no current rows anywhere" from "this database was never populated", and
no row here is graded `decoration` on a LOCAL zero. Those rows are emitted
`unclassified` with the reason stated.

That `db_health_checks` holds a row while every data table is empty is worth
noting on its own, against Phase 0 item 6: a health check that passes on a
database with no data in it.

## Counts

98 in-scope model rows: 9 `dead`, 11 `half_done`, 1 `silently_broken`,
59 `unclassified` (pending a live count), 18 `needs-read` (name no table in
SQL, so they are graded by reading the call site rather than the schema).

42 further candidates were tagged out of the fantasy scope (betting, market,
execution and MLB services) and are not graded here.

## Nine models no server file imports

Their only importers are their own test file and, for five of them, a
one-off under `scripts/`. No file under `server/` imports any of them, so no
route, no job and no page can reach them:

`bottom-up-team-total`, `draft-abstention-audit`, `joint-score-backtest`,
`nfl-news-event-impact`, `nfl-preseason-blend`, `nfl-team-strength`,
`opportunity-model`, `purged-walk-forward`, `td-features`.

`td-features` has no importer at all, not even a test.

A grep for the module name finds each of them in several `server/` files and
reads as if they were alive — `server/services/gridiron-model.js:330`,
`server/services/nfl-gbm.js:133`, `server/services/model-governance.js:45-51`.
Every one of those is a comment or a registry string. A grep for a name
proves a mention, never an import, which is the same fault as an assertion
about an import proving what was imported and never what was used. The
import statements were then read directly, and there are none.

`server/services/model-governance.js:50-51` is the sharpest case: the
governance registry lists `team_strength_aggregate` as produced by
`nfl-team-strength.js teamStrength(season)`, with a refresh cadence and a
staleness budget, for a module nothing imports.

## Six tables that exist nowhere in the tree

Named in SQL by a model, created by no migration under `server/migrations/`
(63 files) and no file under `server/db/schema/` (4 files, 220 `CREATE TABLE`
statements):

| table | the only `CREATE TABLE` in the repository |
|---|---|
| `league_transactions_raw` | `test/manager-data-pipeline.test.js:131`, `test/manager-signals-api.test.js:112`, `test/trade-tactics.test.js:68` |
| `negotiation_profiles` | `test/manager-data-pipeline.test.js:75`, `test/manager-signals-api.test.js:78`, `test/trade-tactics.test.js:228` |
| `league_season_teams` | `test/manager-signals-api.test.js:121`, `scripts/backfill-league-history.mjs:48` |
| `league_draft_picks` | nowhere, test files included |
| `play_by_play` | nowhere, test files included |
| `pbp_participation` | nowhere, test files included |

The first three are created **only by test fixtures**. The suite is green on
them because the fixture builds a schema production does not have. No live
row count can change a grade that rests on this: the table is absent from the
tree, not empty in the database.

`league_transactions_raw` is read by six services —
`manager-archetypes.js`, `trade-engine.js`, `counterparty-pricing.js`,
`manager-signals.js`, `bluff-detector.js`, `trade-tactics.js`. One of the six
guards it.

## The one `silently_broken` row

`server/services/trade-tactics.js`, reachable from `/trade-brain` and
`/trade-lab`.

1. `:230-235` — `try { tx = rows(\`SELECT tx_id, type, execution_type, team_id, related_tx_id, proposed_at FROM league_transactions_raw WHERE league_id = ? AND (? IS NULL OR season = ?)\`, leagueId, yr, yr); } catch { tx = []; }`
2. The table does not exist at this commit, so the catch fires and `tx` is `[]`.
3. `:251-257` — every roster then gets `blank()`: `decisions_n: 0`,
   `decisions_reason: null`, `median_hours: null`, `busiest_hour: null`,
   `last_decline_at: null`, `source: 'league_transactions_raw'`,
   `fitted: false`.
4. `:337-351` — `median_hours` is not finite so its branch is skipped,
   `decisions_reason` is null so the `else if` is skipped, `busiest_hour` is
   not finite so its branch is skipped.
5. The function returns
   `{ when: 'now', until: null, n: 0, fitted: false, why: 'nothing in his history argues for waiting' }`.

The surface asserts a finding about the manager's history while the table
holding that history does not exist. This is the shape CLAUDE.md names as
having shipped two real bugs already: a silent catch deletes a data layer and
the page keeps printing as if nothing happened.

`server/services/manager-signals.js:167` is the same read done correctly:
`if (!tableExists('league_transactions_raw')) return { present: false, rows: [], related: new Map() };`

`server/services/counterparty-pricing.js:813-817` carries the same bare catch
but reports itself at `:895-900` — `out.available = out.sources.length > 0`,
and when false it sets a reason. It is not silently broken. Its stated reason
is wrong about the cause, though: it says "no captured transactions for this
league", where the truth at this commit is that the table is not created
anywhere, so a reader goes looking for a stalled collector instead of a
missing migration.

## Method: why handler-level reach, and seven faults in the instrument

Route-file-level reach cannot grade anything. `server/routes/model.js`
transitively imports about 180 services, so one page hitting one of its
endpoints would make nearly every service in the repository read as
"reachable from a live surface". The instrument therefore walks each
`r.get()` / `r.post()` block on its own, takes the imported bindings that
block actually names, and expands those. 548 handlers parsed. 199 services
sit in the transitive closure of a handler a routed page requests; 41 are
named directly by one.

Seven faults were found in the instrument before it produced a number, and
all seven are one habit: grepping for a FORM and reading the count as a fact
about the tree.

1. Routers are pulled in dynamically —
   `const { default: teamsRouter } = await import('./routes/teams.js')` at
   `server/index.js:25-55`. The static `import X from` form resolved 0 of 31
   mounts, and the run reported that no service is reachable from any page.
2. The router variable is `r`, not `router` — `const r = Router()` at
   `server/routes/model.js:43`, `server/routes/teams.js:11`. The first
   handler pass parsed 0 of 548.
3. The client prepends `/api` inside its own helper —
   `fetch(\`/api${path}\`)` at `client/src/api.ts:57`. Grepping client code
   for `/api/...` found 5 paths where there are 106.
4. The request path is often inside a ternary —
   `useApi<any>(leagueId ? \`/trades/${leagueId}/lineup?objective=${objective}\` : null)`
   at `client/src/pages/Lineup.tsx:37-38`. Anchoring on `(` plus a quote
   found 3 of `/lineup`'s 7 paths and none of the three that matter, so
   `lineup-brain`, `lineup-posture` and `waiver-brain` would every one have
   been graded unreachable.
5. Mount prefixes have to match longest-first, or `/api/nfl` swallows every
   `/api/nfl-market` and `/api/nfl-betting` path.
6. The first table scan read whole files, so every "from a" and "from all" in
   an English comment became a table name: 242 of 379 "tables" were prose.
   Comments are stripped now and only SQL-looking string literals are read.
7. The second read of the nine dead rows was itself the fault in reverse: a
   grep for the module name found them referenced in `server/` files and
   would have withdrawn a correct finding. The references are comments and
   registry strings.

## What still needs a live reading

82 tables, listed in `model-rows-live-count-wanted.json`. What is wanted per
table is `COUNT(*)` and `MAX()` of whatever season, week or timestamp column
it has, so "current rows" can be judged rather than just "rows". Until that
arrives, 59 rows stay `unclassified` and nothing is graded `decoration`.
