# Removing MLB — pre-registration (measured before any deletion)

2026-09-22. Measured on `origin/main` **f620a120**. Nothing deleted yet; this
file is the census the removal is planned from, written first so the plan can
be checked against it rather than against a memory of it.

Scope came from Nick: *"get rid of MLB btw"* (2026-09-22T17:24:12Z).

## Headline

**The MLB product has no user-facing surface left.** There is no nav tab, no
page, and the client never calls `/api/mlb` — 28 endpoints, 8 services and 5
scheduled jobs that nothing in the app reaches. So the visible cost of removing
it is: MLB feeds stop being fetched. Nothing a person can open changes.

**Two false positives that a grep-and-delete would have broken**, both checked
by hand:

- `client/src/components/FormationView.tsx:207,213` — `MLB` there is **Middle
  Linebacker**, a football position on the defensive formation diagram. It has
  nothing to do with baseball.
- `client/src/App.tsx:138,146` and `client/src/navigation.ts:18` — comments
  *about routes that were already deleted* (`/props/*`, `/betting/mlb/legacy`,
  `/betting/mlb/auto-legacy`). Historical notes, not live references.

`client/src/components/StaleBanner.tsx:7` names "the proxied MLB board" in its
doc comment, but the component takes a generic `freshness` prop and is not
MLB-specific. Comment, not coupling.

## What exists (server)

**Router** — `server/routes/mlb.js` (209 lines), mounted at
`server/index.js:47` and `:138` as `/api/mlb`, 28 endpoints:

```
POST /sync  /sync/schedule  /sync/pitchers  /sync/batters  /sync/boxscores  /sync/now
GET  /status /board /coverage /model/accuracy /operations /intelligence /sync/status
GET  /evidence/status /model/calibrations /auto-picks /pregame/status /experiments /experiments/:id
POST /evidence/capture /model/calibrations/:market /operations/audit /operations/promote/:auditId
POST /auto-picks/audit-decisions /auto-picks/backfill /pregame/snapshot /experiments /experiments/:id/:stage
```

**Services** — 1,689 lines, MLB-only, reachable only from each other, the
router, the scheduler and the four files in the next section:

| File | Lines |
| --- | --- |
| `server/services/mlb-auto-picks.js` | 441 |
| `server/services/mlb-projections.js` | 426 |
| `server/services/mlb.js` | 295 |
| `server/services/mlb-pregame.js` | 139 |
| `server/services/mlb-calibration.js` | 119 |
| `server/services/mlb-shrinkage-fit.js` | 116 |
| `server/services/mlb-experiments.js` | 79 |
| `server/services/mlb-research.js` | 74 |

**Scheduler jobs** — five, `server/services/scheduler.js:1191-1195`:

| Job | Tier | Cadence | Thread |
| --- | --- | --- | --- |
| `mlb_schedule` | live | 60 min | request thread (in `ON_REQUEST_THREAD`) |
| `mlb_boxscores` | live | 30 min | request thread (in `ON_REQUEST_THREAD`) |
| `mlb_probables` | live | 90 min | request thread (in `ON_REQUEST_THREAD`) |
| `mlb_logs` | heavy | 6 h | off-thread by tier, gated on `AUTO_HEAVY_SYNC` (off) |
| `mlb_tomorrow_picks` | heavy | 90 min | off-thread by tier, gated on `AUTO_HEAVY_SYNC` (off) |

Their job bodies are `refreshMlbSchedule`, `refreshMlbLogs`,
`refreshMlbBoxscores`, `refreshMlbProbables` and `prepareTomorrowPicks`
(`scheduler.js:274-448`). Three of the five are also in `BOOT_JOBS:1821`, and
`refreshInBackground` (`:2058`) **defaults its argument to `['mlb_schedule']`**.

**Script and test** — `scripts/bootstrap-mlb.mjs` (29),
`test/mlb-nrfi-shrinkage.test.js` (167). MLB assertions also live inside
`test/model-integrity.test.js`, `test/parlay-api.test.js` and
`test/legacy-route-security.test.js`, which are not MLB files.

## What reaches MLB from outside it — the "list it and stop" set

Four modules that are not MLB read MLB tables or import MLB services. **All
four are betting-side, which is out of scope for this thread by standing rule**,
so none of them is mine to edit without routing:

| File | What it uses | Severable? |
| --- | --- | --- |
| `server/services/market-movement.js` (47 lines) | reads `mlb_market_quotes`; exports `mlbMarketMovement` beside `nflMarketMovement` | Yes — one export. Imported by `model-intelligence.js:12` (both names) and `test/model-integrity.test.js:34` (NFL only) |
| `server/services/evidence-daemon.js` (198 lines, 13 MLB lines) | imports `captureMlbPregame`; builds MLB capture windows from `mlb_games`; one branch of the capture loop | Yes, but it is a live scheduled job (`evidence_daemon`) and the deepest coupling of the four |
| `server/services/nfl-shopping-board.js:387-392` | reads `mlb_market_quotes` to price player props against NFL sides | Yes — one query block |
| `server/routes/betting-hub.js:368-383` | same NFL-vs-MLB margin comparison, in a route response | Yes — one block, but it changes a route's response shape |

## Tables and data — NOT touched

Eleven MLB tables are declared in `server/db/schema/mlb-model-misc.js`, a
985-line file that also declares roughly fifty tables that have nothing to do
with MLB (`model_registry`, `nfl_player_week_features`, `odds_usage`,
`sync_log`, the whole `off_*` family, …):

```
mlb_batter_games      mlb_boxscore_sync     mlb_first_party_picks
mlb_games             mlb_market_quotes     mlb_model_experiments
mlb_pick_decisions    mlb_pitcher_games     mlb_pregame_snapshots
mlb_probability_calibrations                mlb_probable_starters
```

**No table is dropped and no row is deleted by this unit.** Dropping a table is
destructive and irreversible on the live volume, and it needs Nick's own word,
separately. The tables and their rows stay exactly where they are; what stops is
the code that writes to and reads from them. `scripts/_prepare-validation-db.mjs:54`
already excludes `/^(mlb_|polymarket_|prediction_market_)/`, so the validation
database never carried them anyway.

## What the removal cannot do quietly

Taking the jobs out without taking the router out would leave a silent inert
layer, which is the exact shape CLAUDE.md forbids. `runIfStale` on a name that
is no longer in `JOBS` returns `{ job: name, error: 'unknown job' }` — it does
not throw. `server/routes/mlb.js:61` and `:126` call
`refreshInBackground(['mlb_schedule'])` and `(['mlb_boxscores'])`
fire-and-forget and never read the result, and `POST /sync/now` passes a job
name straight through. So the router would keep answering, the page would keep
printing whatever was last stored, and nothing anywhere would say the feed had
stopped.

**The jobs and the router come out together, or neither does.** That is the one
structural finding of this census.

## Planned order (nothing executed yet)

1. RED: pin that `JOBS` holds no `mlb_*` key, that `ON_REQUEST_THREAD` and
   `BOOT_JOBS` name none, that `refreshInBackground`'s default is not a removed
   job, and that `/api/mlb` is not mounted.
2. GREEN: delete the router and its mount, the 8 MLB services, the 5 jobs and
   their bodies, `scripts/bootstrap-mlb.mjs`, `test/mlb-nrfi-shrinkage.test.js`,
   and the MLB assertions inside the three shared test files.
3. The four betting-side files: **not touched here.** Listed above and routed.
4. `mlb-model-misc.js`: the eleven `CREATE TABLE` statements stay, because the
   file is shared and the tables must survive. Only their readers go.
5. Re-measure the `ON_REQUEST_THREAD` ratchet in
   `test/growth-jobs-off-thread.test.js` — three entries leave it, so the
   bound moves again and the arithmetic is re-derived by running the module,
   not by subtracting.

## Superseded work

`claude/project-thread-o3wt2p-mlb-offthread` (RED `d11e1692`, GREEN `579e522f`,
evidence `501e89e7`) moved those same three jobs off the request thread earlier
today, with a full module-state audit and a seven-mutation sweep. Removing a
job you have just moved is churn, so that branch is **not pushed** and is
superseded by this one. Its audit is the input here: `mlb.js` holds one
module-level binding (`const BASE`, a string), the services' entire product is
rows, and every reader goes back to SQLite. That is why nothing in the app
breaks when the writers stop — and why the tables can be left full and inert
without anything reading a half-updated view of them.
