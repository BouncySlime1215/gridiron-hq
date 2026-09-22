# A "data healthy" light that reads rows, not a connection

## 1. What was wrong, and why it is a type specimen

The banner this replaces asked the wrong question. `GET /model/setup-status`
checked, per source, whether `last_status === 'never run'` — did the sync job
ever run. A job that ran once and wrote zero rows for the season being played
is not "never run", so the app reported healthy while `player_week_usage` held
2021-2025 and nothing for 2026. A live connection is not freshness; a row for
the current week is.

This is the `silently_broken` specimen for the honest-inventory work: a surface
that answers a question adjacent to the one it appears to answer, and passes.
The fix is not a patch to the predicate — it is reading the served tables
themselves.

## 2. The contract

For each served table, exactly one verdict, from its own rows:

- `empty` — the table holds nothing, or is not present in this database.
- `stale` — it holds rows, but none satisfy its current-data rule.
- `fresh` — at least one row satisfies the rule.

`stale` and `empty` are kept distinct on purpose: 2021-2025 with no 2026 is a
pipeline that stopped, an empty table is one that never started, and a light
that collapses them tells you nothing about which to fix. A table that is not
present is a real answer (`empty` with a note), never a swallowed exception —
that silent-catch shape is the exact bug CLAUDE.md names, and this feature
exists to end it, not to add one.

Each registry entry is developer-authored: a plain sentence for the panel and a
WHERE fragment with `?` placeholders. The placeholder VALUES (season, week) are
bound, never interpolated. The table and column NAMES are the only identifiers
that reach the SQL text; they come only from the code registry and are validated
against an identifier pattern regardless, so an entry carrying `x; DROP TABLE y`
is rejected before it runs. No string-built SQL from a value; no identifier that
is not a bare identifier.

## 3. RED → GREEN

- `9230d3d` RED: `test/data-freshness.test.js`, module absent, all fail as one.
- `4277495` GREEN: `server/services/data-freshness.js`; 13 tests pass (17 after the second-grain fields). Two test
  fixes folded in from the module-absent RED, both stated in the commit: the
  fixture seeds a `players` row because `player_week_usage` carries a FK to it,
  and a local variable named `pwu` shadowed the insert helper.
- `8ea8570` RED / `a1c771d` GREEN: `test/data-freshness-route.test.js` and
  `server/routes/data-freshness.js`.
- `fe6ba16`: the panel replaces the banner; `DataSetupBanner.tsx` deleted; a
  guard test pins both halves so neither the old banner nor a bannerless state
  returns.
- `ecf4604`: the two `server/index.js` lines the route GREEN added are backed
  out — that file is the scheduler thread's, and the lines are handed over
  verbatim in the commit message for the integration slice.

## 4. Acceptance, on a live-like local DB

`player_week_usage` seeded with 2021-2025 and nothing for 2026, endpoint hit
over HTTP:

```json
{"season":2026,"week":3,"all_fresh":false,"tables":[{"table":"player_week_usage",
"label":"Weekly player usage","row_count":15,"earliest":2021,"latest":2025,
"last_write":null,"current_rule":"Has weekly usage rows for the season being
played, up to the current week.","status":"stale","note":null}]}
```

A table with a connection and rows present, but none current, comes back
`stale` and `all_fresh` is `false`. A check that said OK here would be wrong by
construction, and this one does not.

## 4a. Second grain: fit stores, not just feeds

The model-audit thread's reconciliation against the scheduler's `servedTables()`
found the feed-only registry has this feature's own bug one layer up: 73 of the
82 tables the models read are not in it, and none of the ten fit-artifact stores
(`correlation_estimates`, `fantasy_coordinator_fits`, `shrinkage_fits`,
`weekly_ensemble_fits`, …) are covered — so a model can read a stale or
wrong-season fit, answer anyway, and its store still reads "fresh" because rows
exist.

Decided now, before the registry shape locks, because it is a field now and a
schema change later. An entry carries two optional passthrough fields: `grain`
(`feed` or `fit`) and `reader` (the model that consumes a fit). Feeds leave
them at `feed`/`null` and are unchanged. The point that must not regress: a fit
store's verdict is still **coverage, never a timestamp** — `fresh` means a fit
exists for the season being played, and a recent `fitted_at` over
last-season-only fits reads `stale`, because that is the stale-fit trap. The
`fitted_at` populates `last_write` for display and is not the verdict. Tests pin
exactly this: a 2025-only fit stamped one minute before midnight tonight reads
`stale` with its `last_write` still shown. The service already computed coverage
this way; only the two passthrough fields were added.

## 5. Mutation sweep

`docs/tdd/sweeps/data-freshness.mutations.json`, run with
`docs/tdd/sweeps/mutation-runner.py`, which decides APPLIED by `count(old) == 1`
and records each file's SHA-256 before the edit, after it, and after the
restore, so a row cannot be recorded killed without a hash change proving the
file differed when the suite ran. Every behavioural test has a killing row.

| Mutation | Aimed at | Applied (hash→) | Result |
|---|---|---|---|
| S1 every table reported fresh | the specimen, current, future-week, fallback acceptance | 87148aac11df→9207c4cd7bc8 | killed (3) |
| S2 predicate short-circuited to the full row count | current-count logic | →811120db4acb | killed (3) |
| S3 empty/stale collapsed (empty computes the predicate) | empty | →1707732ac31c | killed |
| S4 present-check removed (missing table not caught) | missing table | →73b925c144e7 | killed |
| S5 identifier guard disabled | injection | →eb506afa3a00 | killed |
| S6 placeholder/bind mismatch check disabled | bind mismatch | →33131f8249f3 | killed |
| S7 updated-col branch skipped (last_write always null) | last_write | →69669298fe23 | killed |
| S8 earliest/latest never populated | row_count/earliest/latest | →dcc54d6ee1b0 | killed |
| S9 rule sentence dropped from the row | verbatim rule | →b1721605ea35 | killed |
| S10 fallback registry's table replaced | fallback acceptance, servedTablesRegistry | →1b37b9f6ba6f | killed (2) |
| R1 route always claims all_fresh | all_fresh | f994a28f130b→309c550b9011 | killed |
| R2 route stops reporting the week | season/week | →6db8cbece63a | killed |
| R3 route passes a fixed week (1) | route's current-week plumbing | →8f640c5e9332 | killed |
| G1 grain default flipped to fit | feed-default | →d65e07fac33d | killed |
| G2 reader never carried through | grain/reader carried | →eb43f3875d28 | killed |
| C1 a comment reworded | designed survivor | →e5ca1f945621 | SURVIVED |
| C2 anchor `database.prepare(` | designed NOT APPLIED | (anchor x5) | NOT APPLIED |

Two controls prove the runner reports both outcomes, not only kills: C1 applies
and no test fails (a comment is not behaviour), C2's anchor matches five times so
it is reported NOT APPLIED with its count rather than mutated at one arbitrary
site.

### R3 was found by this sweep, not by the first green

R3 survived the first run: `currentWeek: now.week` → `currentWeek: 1` changed
nothing any test could see, because no route test seeded a current-season row at
a week between the wrong week and the right one. The route's whole reason to
exist — resolving which week is current and handing it to the pure service — was
unpinned. A test was added (`the route uses the schedule's current week, not a
fixed one`) that seeds a 2026 row at week 3 and asserts `fresh`; a route
hardwired to week 1 calls that future data and reports stale, so the test now
kills R3. This is the argument for running mutations expected to fail loudly: a
green suite is not evidence that the thing you built is the thing under test.

## 6. Full check

Measured on the tree at HEAD after the backout and the added route test,
source-isolated (own source tree, `node_modules` symlinked to the primary
clone), tree `56f06dfb1137` (measured before this evidence edit), identical
`git write-tree` before and after the run, `node_modules` mtime unmoved:

| Step | Result |
|---|---|
| typecheck | clean |
| lint | clean |
| test | 3,012 tests, 2,971 pass, 0 fail, 41 skipped |
| build | ✓ |
| start:smoke | passed on isolated DB (32 teams) |

(Five above the 3,007 at `fe6ba16`: the route test that closes R3, plus
four for the second grain.)

## 7. What this does NOT settle

- The registry is one entry until the scheduler thread exports `servedTables()`
  from `source-registry.js`. `servedTablesRegistry()` prefers that list the
  moment it is a non-empty array of the entry shape, and falls back to the single
  `player_week_usage` entry until then, so the light is honest on day one. The
  two lists are expected to differ (scheduler's is ~10 tables from query counts
  in `routes/`; this seeds one) and are being reconciled before the Coach tool
  is registered.
- The Coach hook (the same payload as a tool the Coach can call) is held one
  cycle pending that reconciliation and the registration path, which the Coach
  thread owns.
- The orphaned `GET /model/setup-status` in `routes/model.js` is the wiring-map
  thread's to remove, in the same integration slice as the banner kill, so there
  is never a live route with no consumer.

## The five questions

- **Is it well built?** It reads the served rows and gives one of three verdicts
  with a mutation-killed test behind each; the SQL is bound and identifier-guarded.
- **Stats, or made up?** Row counts and season spans read straight from the
  tables. Nothing is modelled or assumed.
- **How do we know?** The acceptance JSON above, produced on a seeded local DB,
  and the sweep in §5.
- **Pointed anywhere else?** Yes — the same payload is intended as a Coach tool
  so "is the data current" is answerable with rows and dates; held for the
  registry reconciliation.
- **How does it unify?** One registry, one verdict vocabulary (fresh/stale/empty),
  one endpoint, feeding both the panel and (next) the Coach — replacing a banner
  that read a different signal and got it wrong.
