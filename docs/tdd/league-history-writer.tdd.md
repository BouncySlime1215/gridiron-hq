# TDD evidence (retroactive): the league-history writer on a timer — 2026-09-20

**What this is.** PR #47 (`claude/project-thread-sytruo-lst`, head `b1f0cb6`) gives
`league_season_teams` and `league_week_scores` a scheduled writer. The tests were
written alongside the implementation rather than ahead of it, so there is no RED
commit to point at. This file supplies the retroactive RED in the form
`docs/tdd/week2-numbers.tdd.md` established: every guarded rule is shown failing
against a mutated copy of the code, with the real output pasted.

**Files:** `server/services/league-history.js` (new), `server/migrations/064_league_history_tables.js`
(new), `server/services/scheduler.js` (`liveDraftActive` exported, `refreshLeagueHistory`,
the `league_history` registry entry), `scripts/refresh-live-data.mjs`
(`FANTASY_LIVE_JOBS`), `scripts/backfill-league-history.mjs` (now a CLI over the
service); test `test/league-history-schedule.test.js`.

**Why:** `league_season_teams` is read on the trades surface —
`manager-archetypes.js:243` attributes draft picks with it, `:819` names an ESPN
member, `:831` keys a league's managers by roster id — and its only writer was
`scripts/backfill-league-history.mjs`, run by hand, which also created the table. So
the table's *existence* was conditional on a person having run a script, and a league
nobody had backfilled was indistinguishable from a league with no history.

**LLM spend:** $0. No gateway or Anthropic calls.

**Environment:** cloud box. Every number below is from a fixture database built in
the test or in a throwaway script; nothing here was measured against production, and
the app was not deployed or pushed to while this was written (GitHub Actions freeze,
2026-09-20 01:04Z).

## User journeys

- As a manager opening the trades screen, I want the other managers to have names and
  histories without anyone having remembered to run a script.
- As a manager mid-draft on ESPN, I want nothing on the server touching my ESPN
  session while I am drafting with it.
- As whoever reads Data Health, I want a job that half-worked to say `partial` and a
  job that skipped to say `skipped`, not `ok`.

## How the retroactive RED was shown

The code already works, so a test written now passes. Each guarded rule was therefore
run against the code with that rule reverted — one mutation per rule, applied in the
working tree, the single test file run, then `git checkout --` to restore. A rule no
mutation can break is not guarded, so a mutation that fails nothing would be a finding
against the test, not against the mutation.

Mutation logs: `scratchpad/mut/M1.log` … `M9.log` (session scratch, not committed);
summary `scratchpad/mut/summary.json`. Baseline at head: **7 pass, 0 fail.**

| # | Mutation | Test that caught it | Result |
|---|----------|--------------------|--------|
| M1 | migration 064 no longer creates `league_season_teams` | whole file | 0 pass / 1 fail |
| M2 | the `league_history` JOBS entry is renamed away (job never registered) | timer + order; scheduled run | 5 pass / 2 fail |
| M3 | the job is moved to the `heavy` tier | timer + order; scheduled run | 5 pass / 2 fail |
| M4 | the loop runs it *after* `manager_archetypes` | timer + order | 6 pass / 1 fail |
| M5 | the current season is fetched from the `leagueHistory` endpoint | scheduled run | 6 pass / 1 fail |
| M6 | `seasonsToFetch` ignores what is already stored | prior season not re-fetched | 6 pass / 1 fail |
| M7 | the live-draft gate is removed | ESPN untouched during a draft | 6 pass / 1 fail |
| M8 | the detail reports only its successes as the total | one league-season failing | 6 pass / 1 fail |
| M9 | a 404 throws instead of meaning "the league did not exist" | 404 is absence, not failure | 6 pass / 1 fail |

All nine caught. Output as printed, trimmed to the assertion:

**M1** — the failure this migration exists to prevent, reproduced exactly:

```
# Error: no such table: main.league_season_teams
#   code: 'ERR_SQLITE_ERROR',
```

It takes the whole file down rather than one test, because the fixture cannot even be
seeded. That is the same shape `manager-archetypes.js` would hit on a box where the
backfill had never run: not an empty result, a throw.

**M2**

```
error: 'league_season_teams had no scheduled writer at all'
```

**M3**

```
error: |-
  the heavy tier is gated behind AUTO_HEAVY_SYNC, and a history layer that only builds behind a flag is the failure being fixed

  'heavy' !== 'growth'
```

**M4**

```
error: 'manager_archetypes replays league-seasons out of the rows this writes'
```

**M5**

```
Expected values to be strictly equal:

0 !== 2
```

**M6**

```
error: 'a finished season cannot change, so re-reading it is a wasted ESPN request'
expected: true
actual: false
```

**M7**

```
error: 'a live draft has to skip the whole run'
```

**M8**

```
error: |-
  the total has to be the whole batch, or one failure of two reads as total failure

  NaN !== 2
```

`NaN` rather than a wrong number: with the key renamed, `statusFromDetail` finds no
readable total at all, which is how this recorded `error` for a run that half worked.

**M9**

```
Expected values to be strictly equal:

0 !== 1
```

## What the tests found that reading did not

Two defects were caught by writing the tests rather than by review, and both are
fixed in the PR:

1. **The detail's total was wrong.** `backfillLeagueHistory` first reported `seasons`
   = the count of *successful* league-seasons. `statusFromDetail` measures `failed`
   against the total, so one failure out of two satisfied `failed >= total` and the
   job recorded `error` — a run that wrote half its rows reported as a dead one. The
   key is now `attempted`, the whole batch. M8 is that regression.
2. **The pace slept after the last request.** `await sleep(paceMs)` ran once per
   league-season including the last, so a single-league-season run idled 900 ms before
   returning and the scheduler's slow-job line fired on it. Pacing now happens
   *between* requests.

## Also verified, outside the test file

Against a throwaway database built with the **old script's DDL verbatim** and rows in
both tables, then migrated (`scratchpad/live-shape.mjs`, the live box's shape):

- both tables' `sqlite_master` SQL byte-identical before and after; rows untouched;
  recorded once; a second `runMigrations()` returns `[]`;
- `idx_league_season_teams_member` **is** created on the pre-existing table, so this
  is not literally a no-op;
- the job then run against that same database skipped the season that already had a
  row, left it byte-identical, and fetched only the others;
- `sync_log` recorded `ok`.

Full suite at head `b1f0cb6`: **2,957 tests, 0 failed** (2,916 passed, 41 skipped).
`npm run lint` and `npm run typecheck` clean. CI green on the same commit.

## Known limits

- **M5 is caught indirectly.** The URL assertion lives inside the `fetch` stub, and
  the service catches per league-season, so a wrong endpoint surfaces as "no rows
  written" (`0 !== 2`) rather than as the match message. The rule is guarded, but the
  diagnostic a future failure prints will not name the URL. Worth restructuring if
  that test ever fails for real.
- **M3 fails a second test incidentally.** Moving the job to `heavy` makes it run
  off-thread, where the test's `globalThis.fetch` stub does not exist. That second
  failure is a property of the worker boundary, not a designed assertion.
- **No test covers the ESPN payload shapes themselves** — `fetchView`'s
  array-vs-object unwrapping for `leagueHistory`, or `mSettings` missing
  `matchupPeriodCount`. Those came across from the script unchanged and are exercised
  only by the fixture's one shape.
- **Nothing here proves the job runs on the deployed app.** `league_history` is a
  growth job, and on `791b131` growth fires only on the single 300-second background
  timer (`scheduler.js:1801`, with `server/index.js:75` starting it at
  `intervalMinutes: 5`); while the live process restarts inside 300 seconds that timer
  has never fired. The writer takes effect there once that cycle is fixed.
