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

---

# Second pass: the reachability half, and what it moved

The first pass graded `dead`, `half_done` and `silently_broken` from the
tree and held `wired` against `decoration` for a live row count. This pass
settled the two open groups — the 18 rows that name no table, and the rows
reachable only transitively — and in doing so found that the live surface is
smaller than the router suggests.

Final counts over the same 98 rows: **9 `dead`, 38 `half_done`,
1 `silently_broken`, 50 `unclassified`** pending a live row count.

## The rule the two open groups needed

A model that names no table in SQL is only as real as the chain that feeds
it, so it is graded on its callers, not its own reads. A model reachable only
by transitive import has no consumer: transitive import is not a call. Under
that rule, of the 18 table-less rows, the ones whose importers all sit off
every live surface are `half_done`, and the ones with a caller on a live
surface stay `unclassified` with the rows in question being their caller's.

## Seven client files `App.tsx` cannot reach

Walking the import closure of `client/src/App.tsx` reaches 68 of the 76 files
under `client/src`. Excluding `main.tsx`, which renders `App`, seven are
unreachable:

`components/StaleBanner.tsx`, `components/StatTable.tsx`,
`features/model-lab/ModelRegistryPanel.tsx`, `pages/Edge.tsx`,
`pages/Model.tsx`, `pages/Projections.tsx`, `pages/Rankings.tsx`.

`StaleBanner.tsx` is worth naming twice: a staleness banner that nothing
renders, in a build whose rendered banner reports health from a connection
check. That belongs with Phase 0 item 6.

17 `/api` paths are requested by nothing but those files, six of them under
`/api/model` — `accuracy`, `availability`, `correlations`, `gamescript`,
`handcuffs`, `status` — all from `pages/Model.tsx`, and
`/api/model/registry/candidates` from `ModelRegistryPanel.tsx`.

## Twelve mounted route files no reachable client file requests

`accolades`, `aggregates`, `decision-inbox`, `execution-slate`, `mlb`,
`nfl-betting`, `nfl-market`, `props-tickets`, `props`, `stats`, `tradelab`,
`wong` — all 31 route files are mounted in `server/index.js`; 19 have a
caller somewhere in the surface `App.tsx` reaches.

`server/routes/tradelab.js` is the one to look at first: `/trade-lab` is in
the nav and renders, but it requests `/api/trades/*` and `/api/model/*`, and
nothing requests `/api/tradelab`.

That correction moved 16 model rows to `half_done`, every one of them
reachable only through `routes/nfl-betting.js` or `routes/nfl-market.js`:
`football-context`, `nfl-drive-sim`, `nfl-ensemble`, `nfl-espn-pbp`,
`nfl-expert-council`, `nfl-external-ratings`, `nfl-gbm`, `nfl-online-neural`,
`nfl-player-value`, `nfl-policy`, `nfl-replay`, `nfl-rookies`,
`nfl-roster-strength`, `nfl-specialists`, `nfl-weather-history`,
`pick-confidence`. They carry fantasy-sounding names, which is why the
filename scope filter passed them through; they are betting-facing, and the
grade is a wiring fact about them rather than a fantasy finding.

## `/api/model/availability` at this commit, and a cite that moved

The cite carried in from `791b131` was `server/services/availability-basis.js`.
**That file does not exist at `654ff93`.** The functions live in
`server/services/contingency.js`, imported at `server/routes/model.js:18`.

`server/routes/model.js:580-593` — one path, two sources, chosen by whether
a query parameter is present:

- with `?week`, `weeklyAvailability(season, week)` at
  `contingency.js:885-890`, reading `players`, `nfl_teams` and
  `nfl_injuries WHERE season=? AND week=?`;
- without it, `availability()` at `contingency.js:40-45`, whose default is
  `through = SEASON - 1`, reading `player_week_usage JOIN players` and
  `player_metrics WHERE source='injury_flag'` — a durability prior over
  prior seasons, not the current week.

Nothing in the bare response says which one answered. The one client caller,
`client/src/pages/Model.tsx:397`, always passes `?week=`, so the fitted
branch is the only one any client takes — and that page is one of the seven
`App.tsx` cannot reach, so at this commit no live surface calls either.

## Three more instrument faults, all caught before reporting

8. Building the live path set from routed pages alone missed the App shell's
   own components — `EspnConnectGate`, `DataSetupBanner`, `QuickJump`,
   `RefreshAll`, `DevHub`, `PageExplainAssistant` all render outside
   `<Routes>`, on every page. That version called `server/routes/dev.js` and
   `server/routes/betting-hub.js` unreached when those components request
   them, and would have moved 17 rows instead of the correct 16.
9. A grep for `pages/MyTeam` found no importer and would have called
   `MyTeam.tsx`, `Drafts.tsx` and `Leagues.tsx` orphaned. They are imported
   relatively — `client/src/pages/LeagueHub.tsx:3-4` and
   `client/src/pages/DraftHub.tsx:3` — which is consistent with the
   `/my-team` and `/drafts` redirects. The closure walk had them right and
   the grep was the weaker instrument, again.
10. `final4.mjs` mutated `model-rows.json` in place, and the rule it applied
    then changed. The 16 moves were therefore re-derived by rebuilding the
    whole chain from `rows654.json`, not by re-running the last step over an
    already-mutated file. A recorded count over a mutated artifact is not a
    measurement of anything.

## Known granularity limit

Reachability is decided per handler where a model is named directly by one,
and per importer otherwise. An importer that is a live route file counts as
live even when the specific handler that calls the model is one of the
orphan-served paths. `draft-survival` is the clearest instance:
`server/routes/edge.js` is live through `/api/edge/scout/:id`, which
`/league` requests, while `/api/edge/simulate` — the path that reaches
`draft-survival` — is requested only by `pages/Edge.tsx`. Its row is
`unclassified` and should be read as reachable-at-file-level, not
reachable-at-handler-level. Tightening that needs a per-export call graph,
which this pass does not build.

---

# Reconciliation against the freshness registry

The scheduler thread's `servedTables()` — `server/services/source-registry.js:322`
on their local-only branch, ten entries — was reconciled against the 82 tables
the graded model rows read. Their ten, verbatim: `player_week_usage`,
`nfl_player_week_features`, `nfl_injuries`, `nfl_depth`, `schedule_games`,
`player_season_stats`, `league_roster_snapshots`, `roster_players`,
`news_items`, `players`.

All ten are declared in the tree at `654ff93`. Nine of the ten are in the 82.
`league_roster_snapshots` is not, because no model in the candidate set reads
it — that is a scope difference, not a gap: their registry covers the data
feeds, this list covers what models read.

**The gap runs the other way. 73 of the 82 tables the fantasy models read are
not in the registry — it covers 9, or 11%.** A freshness dashboard built on
those ten can be entirely green while 73 tables the models depend on are
unmonitored.

## Not one fitted-model store is covered

Ten of the 82 are fit or fitted-artifact stores:
`correlation_estimates`, `fantasy_coordinator_fits`, `gamescript_model`,
`nfl_ensemble_fit_artifacts`, `nfl_online_neural_artifacts`,
`nfl_orthogonal_specialist_artifacts`, `nfl_prop_calibration_fits`,
`shrinkage_fits`, `shrinkage_k`, `weekly_ensemble_fits`.

**Zero of them are in the registry.** So a dashboard on it cannot report that
a model is unfitted, which is the single thing that most needs reporting: an
unfitted model still answers, and its answer still renders. Two of the ten,
`correlation_estimates` and `gamescript_model`, are already counted by
`server/routes/model.js:596-599` under `/api/model/status`, so the numbers
exist — they are just not on the freshness path.

Recommendation for item 6, on the evidence above rather than on preference:
the registry needs a second grain beside "feed freshness" — a fitted-at
stamp per fit store, with the model that reads it named. A table that has
rows but whose fit is from a prior season is a `decoration` risk that a row
count alone reports as healthy.

## A further note on `half_done`

All 38 `half_done` rows were re-measured for importers across
`server/`, `scripts/` and `test/`. **None has zero server importers**, so
none of them collapses into `dead`; the 9 `dead` rows remain 9. That check
was worth running because `final2.mjs` only set the `serverImporters` field
on rows it touched, and an absent field printed with a `|| 'NONE'` default
reads exactly like a measured zero. It was printed that way once, for
`roster-risk`, `trend-exploits`, `manager-archetypes` and five others,
before the field was measured for all 98.

---

# Third pass: a false alarm I raised, and the two rows that really moved

I raised an alarm that the handler scanner was truncating 43% of route
handler bodies and asked for the reachability findings to be held. **The
alarm was wrong and I withdraw it.** What follows is what actually happened,
because the sequence matters more than the conclusion.

## The alarm, and why it was wrong

Validating the fragment against the brief's own evidence rule — a file:line,
a query with its result, or a request with its response, never prose — showed
that 46 of 48 graded rows carried no file:line at all. Filling that in forced
a specific importer line per row, and `roster-risk`'s came back as
`server/routes/trades.js:36`, a live route file, which contradicted its
`half_done` grade.

Chasing that, I found `manager-archetypes` imported at
`server/routes/trades.js:501`, which the handler block starting at
`:374` did not contain. I concluded the block had closed early, wrote a
detector that flagged any block ending more than 80 characters before the
next handler declaration, and it reported 238 of 548 — 43%.

**The detector was the broken instrument.** It assumed handlers are
contiguous. They are not: helper functions and doc comments sit between them.
`server/routes/trades.js:374-385` is the whole of
`POST /:leagueId/brain/managers/:rosterId`, correctly delimited. Line 501 is
inside a file-level helper — the "measured manager layer" — which
`GET /:leagueId/managers/signals` at `:553` calls.

A construct-aware paren matcher, written to fix the supposed truncation,
returned exactly the same span for that handler: 374 to 385. That is what
established the original scanner had been right, and it is the only reason
the retraction is well founded rather than a second guess.

## The two faults that were real

**Thirteen.** The handler scan read only the bindings a handler block itself
names. A handler that delegates to a file-level helper reached nothing that
helper reaches. Following local helpers transitively within the route file
raises services named directly by some handler from 185 to 189, and services
named by a handler a routed page requests from 41 to 46.

**Fourteen.** The first run of the rewritten scanner reported zero services
reached by any of 548 handlers, because `named()` returned the binding NAMES
and the caller filtered them with `startsWith('server/services/')`, which
matches no name. A total of zero is the one result too absurd to ship; a
total that is merely wrong is the dangerous kind, and the twelfth fault — the
43% — was exactly that.

## The delta, row by row

Two rows of 98 changed status, both `half_done` to `unclassified`:

| row | was | is | why |
|---|---|---|---|
| `manager-archetypes` | half_done | unclassified | `server/routes/trades.js:501` imports `archetypesFor` inside the helper that `GET /:leagueId/managers/signals` (`:553`) calls, and `client/src/pages/TradeBrain.tsx` requests `/api/trades/:id/managers/signals` |
| `talk-vs-model` | half_done | unclassified | `server/services/counterparty-pricing.js:23`, reached from the same handler |

Final counts: **9 `dead`, 36 `half_done`, 1 `silently_broken`,
52 `unclassified`** pending a live row count.

Unchanged, and therefore never actually at risk:

- the 9 `dead` rows, identical;
- the `trade-tactics` `silently_broken` row, identical;
- the six tables created nowhere or only by test fixtures, identical;
- the 12 route files with no caller in the surface `App.tsx` reaches —
  `accolades`, `aggregates`, `decision-inbox`, `execution-slate`, `mlb`,
  `nfl-betting`, `nfl-market`, `props-tickets`, `props`, `stats`, `tradelab`,
  `wong` — identical;
- the 16 betting-facing reclassifications, identical, same 16 names;
- the freshness-registry reconciliation, which never touched handler blocks.

The client-side findings — the seven files `App.tsx` cannot reach,
`StaleBanner.tsx` among them — come from an import-closure walk over
`client/src` and never used a handler block. They were not exposed.

## What the episode is actually about

The alarm cost two threads a hold on findings that were correct. It was
raised on a measurement from an instrument built in the same minute to check
another instrument, and reported before the new instrument had been checked
against a case whose answer was already known. The rule that would have
caught it is the one already in use for everything else here: before a number
is reported, run the instrument against a case whose answer is known
independently. `trades.js:374` was exactly that case, and it was available
before the alarm, not after.
