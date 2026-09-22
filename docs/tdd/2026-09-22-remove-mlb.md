# Removing MLB from the product

2026-09-22. Branch `claude/project-thread-o3wt2p-remove-mlb`. Nick, 17:24:12Z:
*"get rid of MLB btw"*, and at 17:59Z his word extended it to the MLB reads the
deletion left without a writer.

The census written before anything was deleted is
`docs/tdd/2026-09-22-remove-mlb-preregistration.md`. This file records what the
deletion did.

## TDD record

| | PR | commit subject | sha |
| --- | --- | --- | --- |
| RED | #128 | `test: RED — pin MLB gone, the tables kept, and Middle Linebacker untouched` | `64b1aa4b` |
| GREEN | #128 | `feat: remove MLB from the product` | `79a4dd98` |
| GREEN (2) | #128 | `feat: remove the MLB reads the deletion left without a writer` | `8e2667bc` |

Both RED and GREEN are ancestors of the pushed head.

### The RED failure, verbatim

5 tests, 3 pass, 2 fail on `64b1aa4b`:

```
not ok 1 - no MLB job is left in the registry or in either thread list
  error: |-
    these MLB jobs are still scheduled. They fetch statsapi.mlb.com on a timer for a product that no longer exists
    + actual - expected

    + [
    +   'mlb_schedule',
    +   'mlb_logs',
    +   'mlb_boxscores',
    +   'mlb_probables',
    +   'mlb_tomorrow_picks'
    + ]
    - []
  code: 'ERR_ASSERTION'

not ok 3 - /api/mlb is not mounted and nothing imports an MLB service
  error: 'server/index.js still imports the MLB router'
  name: 'AssertionError'
```

The three green at RED are pins that must hold on **both** sides — the tables
still being declared, Middle Linebacker still being in the formation, and the
structural guard below. A removal's failure mode is silence, so the tests that
matter most are the ones that were already green.

## What came out

| | |
| --- | --- |
| `server/routes/mlb.js` | 209 lines, 28 endpoints, mounted at `/api/mlb` |
| `server/index.js` | the router import and the mount |
| 8 services | `mlb.js`, `mlb-auto-picks.js`, `mlb-projections.js`, `mlb-pregame.js`, `mlb-calibration.js`, `mlb-shrinkage-fit.js`, `mlb-experiments.js`, `mlb-research.js` — 1,898 lines |
| `scheduler.js` | 5 job entries, 5 bodies, 3 `ON_REQUEST_THREAD` excuses, 3 `BOOT_JOBS` names, `refreshInBackground`'s default |
| `evidence-daemon.js` | the MLB planning and capture halves |
| `market-movement.js` | `mlbMarketMovement()` |
| `model-intelligence.js` | `mlbIntelligence()`, the import, the `mlb-lineup` seed, `IN ('NFL','MLB')` → `'NFL'` |
| `nfl-shopping-board.js` | `bookHold`'s `sport` option and its `mlb_market_quotes` branch |
| `routes/betting-hub.js` | `GET /hold`'s MLB comparison, and the `sport` argument at `:134` |
| `services/parlay-api.js` | whole file, with `test/parlay-api.test.js` |
| `scripts/bootstrap-mlb.mjs`, `test/mlb-nrfi-shrinkage.test.js` | whole files |

## The structural finding

The jobs and the router could not be separated, and the test that says so is
not "no `mlb_` keys":

- `runIfStale` on a name not in `JOBS` returns `{ job, error: 'unknown job' }`.
  It does not throw.
- `refreshInBackground` was called fire-and-forget from `routes/mlb.js:61` and
  `:126`, neither of which read the result.
- Its default argument was `['mlb_schedule']`.

So removing the jobs while any caller survived would have left a route
answering from a feed that had silently stopped. Test 2 asserts every name
`BOOT_JOBS` carries and every name `refreshInBackground` can default to is a
job that exists — green before and after, and there to catch a future
half-removal. Mutations M1 and M2 are exactly that half-removal, and it kills
both.

## What the wiring gate caught that I would have shipped

Deleting `mlb-pregame.js` removed the only writer of `mlb_market_quotes`. The
first full gate on the removal reported **11 blocking findings on a main that
was itself green**, so they were this branch's: `market-movement.js` and
`nfl-shopping-board.js:387-392` were left reading a table nothing would ever
write again, and `parlay-api.js` was left imported only by its own test.

`GET /hold` is the one worth naming. Left in place it would have compared the
NFL hold against a table that can only be empty and reported `comparison: null`
— which reads as *no prop premium*, not as *the source is gone*. That is the
inert-layer shape this codebase keeps fixing, introduced by a deletion rather
than by a catch.

## Windows retired, not dropped

`evidence_capture_windows` holds rows for MLB events planned before the
removal. Dropping the MLB branch from the capture loop would have left them
`queued` and due on every run forever, reading from the table as outstanding
work while being silently skipped. They are marked once with status `retired`
and the reason on the row, and the run reports `retired_mlb: <count>`.

## Middle Linebacker

`MLB` is also a football position, in two files and seven places:
`client/src/components/FormationView.tsx:207,213` (beside `LILB` in the
defensive formation diagram) and `server/routes/nfldata.js:346,429,439,563`
(the depth-chart slot maps). Both are pinned, and mutations M6 and M7 confirm
the pins bite.

## Data

**No table dropped, no row deleted.** The eleven `mlb_*` tables stay declared in
`server/db/schema/mlb-model-misc.js`, a 985-line file that also declares about
fifty unrelated tables. None of the eleven deleted files is a migration, and
`grep -ciE "DROP TABLE|DROP INDEX|TRUNCATE|DELETE FROM"` returns **0** for every
one of them at `f620a120`. Test 4 asserts both halves — the tables are still
declared, and no file in `server/migrations/` drops one.

That schema file's `sources` array still names five deleted modules, and that is
deliberate: it records where the DDL was lifted from, which stays true after the
files are gone. The `mlb-lineup` row stays in `research_hypotheses` for the same
reason; only its seed and the query that surfaced it are gone.

## The on-thread ratchet

Re-measured by running the shipped module, not by subtracting:

```
accountable 48 | onThread 26 {"live":13,"metered":6,"growth":7}
| ON_REQUEST_THREAD 22 + MAIN_THREAD_ONLY 4 = 26
```

Was 29 (16 live), `ON_REQUEST_THREAD` 25. The accountable total falls 51 → 48
too, because `mlb_logs` and `mlb_tomorrow_picks` leave the heavy tier — which is
why it is measured rather than adjusted.

## Mutation sweep: 8 applied, 8 killed

Each verified applied by md5 before the run and restored by md5 after, never by
grep. Four mutate the unit, three mutate a **call site**, and one adds a file.

| | mutation | md5 | verdict |
| --- | --- | --- | --- |
| M1 | call site: a removed job name put back in `BOOT_JOBS` | `7f0b8604 → 50151ebd` | KILLED by tests 1 and 2 |
| M2 | call site: `refreshInBackground`'s default back to a removed job | `7f0b8604 → 5f954a97` | KILLED by test 2 |
| M3 | unit: an MLB excuse restored to `ON_REQUEST_THREAD` | `7f0b8604 → 5af9a707` | KILLED by test 1 |
| M4 | unit: a kept table quietly renamed out of the schema | `36f8344d → 25ff69dc` | KILLED by test 4 |
| M5 | unit: a migration that drops a kept table | file added, then removed | KILLED by test 4 |
| M6 | unit: the Middle Linebacker node removed from the formation | `4311f64a → 6214dd02` | KILLED by test 5 |
| M7 | unit: the middle-linebacker depth slot removed from the map | `482b5a4e → 5c9614bb` | KILLED by test 5 |
| M8 | call site: a surviving file imports a deleted MLB service | `d07cdb68 → ef979c94` | KILLED by test 3 |

The worktree was clean (`git status --porcelain` → 0 paths) after the sweep.

## Left for Wiring map, listed and untouched

One-editor rule. `scripts/wiring-map.mjs:2164-2165` — `BETTING_FILE` matches
`mlb` and now matches nothing; `BETTING_TABLE` matches `mlb_` and **must stay**,
because the tables remain on disk. And `docs/inventory/CONTRACT.md`'s mlb
column: the `wired-mlb-only` grade at `:126` and `:162`, the surface label at
`:199`, the grade definition at `:205`, and the 172 figure at `:182`, which the
`/api/mlb` label produced by moving 24 files out of fantasy `wired`. Those 24
change grade again.

Expect the **unreached** count to rise: `wired-mlb-only` files are NFL modules
reached only through `/api/mlb` (`CONTRACT.md:348-349` names
`nfl-auto-picks.js <- model-intelligence.js <- routes/mlb.js`), and deleting the
route does not delete them.

## Five questions

**1. What defect or gap does this fix, with `file:line` on a stated tree?**
Not a defect — a product decision, executed. On `f620a120`: `server/routes/mlb.js`
(28 endpoints) mounted at `server/index.js:138`, eight services, and five jobs at
`scheduler.js:1234-1238`, three of them running inline on the request thread on
30/60/90-minute cadences. Nothing in the app reached any of it: no nav tab, no
page, and `grep -rn "api/mlb" client/src/` returns zero.

**2. What is the incumbent, by command?** `node --test test/mlb-removed.test.js`
on `64b1aa4b` — the RED above. And on `f620a120`,
`node -e "import('./server/services/scheduler.js').then(m => …)"` printed 51
accountable jobs, 29 on the request thread, `ON_REQUEST_THREAD` 25.

**3. What did RED fail on, verbatim?** Quoted in full above: the five job names
against `[]`, and `'server/index.js still imports the MLB router'`.

**4. What does the change NOT cover?**
- **No latency was measured.** The production log line `'mlb_schedule' took 1.5s
  — every request was blocked for that long while it ran` is one line, not a
  distribution. The sign is established; the size is not.
- **The MLB code was never executed before deletion.** This proves nothing in
  the app reaches it, not that it worked.
- **The tables were not inspected on production.** "No table dropped" is a
  property of the diff, not of the volume.
- **`scripts/wiring-map.mjs` and `docs/inventory/CONTRACT.md` are not updated** —
  another thread's files, listed above.

**5. What would make this wrong?** If some surface reaches `/api/mlb` by a path
neither the census nor the wiring map can see — a runtime-built URL on the
client, or a bookmark somebody uses directly. The census's evidence is a grep of
`client/src` plus the wiring map's own reachability, and both read source, not
the running app. If Nick opens a page and something is missing, that is the case
this missed, and the branch is a clean revert.
