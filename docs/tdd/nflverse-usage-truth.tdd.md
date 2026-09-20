# TDD evidence — the nflverse usage feed cannot report 'ok' over a season it never wrote — 2026-09-20

**Why:** `player_week_usage` on the live app holds 2021-2025 and nothing for 2026,
while `source-registry.js` and every freshness surface read `sync_log` and see a
healthy `nflverse_weekly_usage`. That gap is what keeps `coreLag` true in
`nfl-model-growth.js`, which is what makes the growth job run its heavy ingestion
on every boot.

**The diagnosis that was wrong, and why it mattered.** The standing note said a
hardcoded season list ending 2025 meant 2026 was never requested. It is
requested. `nfl-model-growth.js:187` calls `syncAll([season])` with
`availableSeason()` — `NFL_SEASON`, else `MAX(season) FROM game_lines` — and that
call is gated on `before.finalized_week > 0 && (force || coreLag)`, so a missing
2026 is itself the trigger. The hardcoded `'2021,2022,2023,2024,2025'` defaults do
exist, six of them, but all six are in `server/routes/nfl-betting.js` — the
betting board, and not on this path. The request is made. The write does not
happen. The status row says it did.

**Files:** `server/services/nflverse.js`, `test/nflverse-usage-truth.test.js`.

| Stage | Commit | Evidence |
|---|---|---|
| RED | preceding commit | `usageSeasonOutcome`, `usageRunSummary`, `usageCoverage` absent; 11 tests, 11 failing |
| GREEN | this commit | 13/13. `nflverse.js` branches 97.44%. Everything uncovered is network: the CSV fetch and parse paths, and `syncAll`'s own orchestration. Every decision `syncAll` makes now lives in `recordUsageRun`, which is why it could be tested without a fetch at all |

Full local run on the GREEN head, taken in place of CI (the repository's only
workflow is disabled while the Actions allowance is exhausted): 2922 pass, 0 fail,
41 skipped, with `typecheck`, `lint`, `build` and `start:smoke` all clean.

## The two defects, both at `origin/main` 791b131

**1. One stamp per season, last one wins.** `syncAll` called
`recordSync('nflverse_weekly_usage', ...)` inside its season loop. `sync_log`
holds one row per `job`, so season six overwrote seasons one through five. Worse,
`record()` in `scheduler.js:79` resets `consecutive_failures` on any status that
is not `'error'`, so five failures followed by one success left the feed reading
fresh *and* with no accumulated backoff. Fixed by stamping once per feed after
the loop, from a whole-run summary.

**2. A green stamp for a season that inserted nothing.** `syncWeeklyUsage`
returns `{ season, rows, inserted, unmatched }` and throws only on a fetch or
schema failure. A season whose CSV downloaded cleanly but matched no player in
the crosswalk returns `{ rows: 4210, inserted: 0, unmatched: 4210 }` — no `error`
key — and `usage.error ? 'error' : 'ok'` stamped it green. Fixed by deriving the
outcome from what the season wrote.

## Decisions worth writing down

**`upstream_empty` is not `unmatched`.** Zero published records is not a failure
of ours: a season before its first regular-season game legitimately has none. It
is not a success either, so an all-empty run records `'skipped'` rather than
`'ok'` — `statusFromDetail`'s own vocabulary for did-no-work-but-did-not-fail.
Collapsing the two would have made the check fire on every clone in March.

**The status is derived by `statusFromDetail`, not by a new rule.**
`scheduler.js:117` already understands a countable batch: `failed` against a total
it finds among `leagues`/`attempted`/`seasons`/`total`. The summary is shaped
`{ seasons, failed, empty, per_season }` so that existing function decides —
`'ok'`, `'partial'`, `'error'` — rather than nflverse.js inventing a second
opinion about what a broken feed looks like. That header's own examples
(`refreshPlayerRosters` returning a string `skipped`, `refreshLeagueRosters`
returning `{ leagues: 5, failed: 5 }` as `'ok'`) are the same bug class as this
one, found twice before in this file.

**`usageCoverage` distrusts the stamp on purpose.** Every freshness surface in
the app reads `sync_log`, which is a claim the last run made about itself, and
both defects above are how that claim came to be false. So `usageCoverage` reads
`player_week_usage` directly and reports `stamp_disagrees` when the feed says
`'ok'` while a requested season has no rows. Staleness is the only failure the
existing surfaces can describe; a feed that is lying rather than stale had no
representation anywhere.

**`never_run` is not a disagreement.** A feed with no `sync_log` row has made no
claim to contradict. Without that carve-out the check reports a lying feed on
every fresh clone, which is the fastest way to teach everyone to ignore it.

## Mutation check

Each load-bearing line was reverted and the suite re-run, to prove the tests
bite rather than merely pass:

| Reverted to | Result |
|---|---|
| `usageSeasonOutcome` returning `'ok'` when `inserted === 0` | 4 of 13 fail |
| `recordSync` moved back inside the season loop | 1 of 13 fails — the `runs` delta test |

## Not changed

`syncSnapCounts` now returns `rows: records.length` alongside `inserted`, so one
rule covers both feeds. Nothing else reads that shape except `scheduler.js:1071`,
which hands it to `statusFromDetail`, and `nfl-advanced.js:557`, which wraps a
different function.

The six hardcoded season lists in `server/routes/nfl-betting.js` at `:706 :721
:733 :746 :1130 :1316` are left alone: they are the betting board, out of scope,
and — per the diagnosis above — not why 2026 usage is missing.

No consumer is wired to `usageCoverage` in this PR. `routes/model.js:596`'s
`/status` route is the natural one, beside the `usage_seasons: usageSeasons()` it
already serves, and that file belongs to another thread; the call to add there is
`usage_coverage: usageCoverage([SEASON - 4, SEASON - 3, SEASON - 2, SEASON - 1, SEASON])`.

## What this fix does NOT clear: `coreLag` — 2026-09-20

The scheduler thread asked which of `nfl-model-growth.js`'s four required sources
this fix makes current. **The answer is none, and the reason matters enough to
write down: `coreLag` never reads `sync_log` at all.**

`warehouseSnapshot` builds each source from the DATA (`nfl-model-growth.js:79-101`):

    { id: 'weekly_player_usage', table: 'player_week_usage', required: true,
      rows: count('player_week_usage', season),
      through_week: through('player_week_usage', season) }

then `current: finalizedWeek === 0 || source.through_week >= finalizedWeek`, and
`coreLag = before.sources.some(s => s.required && !s.current)` at `:181`. Currency
is `MAX(week)` in the table against the last week whose every game is final. **A
stamp cannot make a source current and a lying stamp cannot make it lag.** The four
required sources are `results_and_lines` (`game_lines`),
`team_play_by_play_features` (`nfl_team_week_features`),
`player_play_by_play_features` (`nfl_player_week_features`) and
`weekly_player_usage` (`player_week_usage`).

So this PR is a **diagnostic** fix, not an ingestion one:

- **Before:** the boot sync ran, wrote nothing for 2026, and `sync_log` said
  `nflverse_weekly_usage: ok`. `record()` resets `consecutive_failures` on any
  non-error status, so the counter stayed at 0 and no surface had any way to know
  the feed had been failing every boot for weeks.
- **After:** the same run stamps `partial` or `error` with a per-season breakdown,
  so `/api/model/status` shows a feed that ran and wrote nothing. Nothing about
  what is in `player_week_usage` changes.

**How the morning read tells which of the four actually lag:** the source view on
`/api/model/status` carries `through_week`, `lag_weeks` and `current` per source, so
the ones with `current: false` are readable directly. From project memory
`player_week_usage` holds 2021-2025 and no 2026 rows, so `through_week` is 0 and it
lags whenever `finalized_week > 0`; the other three are unknown from here, because
live reads stopped at 22:16Z and nothing in this PR is worth guessing them for.

**Two consequences nobody should be surprised by.** If a second required source is
also non-current, `coreLag` stays true after this merges, and the boot sync keeps
firing — which is correct behaviour, not a regression. And because this changes no
gate, **it does not affect the restart cycle**: the boot path still runs
`syncNflverse([season])` first under `before.finalized_week > 0 && (force || coreLag)`
at `:186`. Whoever reads the morning `/status` should expect the feed's status to
become honest, not the lag to disappear.

## The five questions

1. **Well built?** It replaces an unconditional `'ok'` with the file's existing
   `statusFromDetail` vocabulary rather than inventing a second opinion about what a
   broken feed looks like, and returns a summary the status route can print.
2. **Stats or made up?** Neither: it is a status derivation, and the honest answer to
   "is this fitted" is that there is nothing here to fit. The number it reports is a
   count of rows the run actually inserted.
3. **How do we know?** By reading the three files rather than trusting a relay —
   `nflverse.js`, `nfl-model-growth.js`, `scheduler.js` — which is also how the
   original diagnosis (a hardcoded season list ending 2025) was found to be wrong:
   2026 IS requested every boot, and the six hardcoded lists are all in
   `routes/nfl-betting.js`, the betting board, which is out of scope.
4. **Pointed anywhere else?** Yes: `usageCoverage()` is the consumer-facing half and
   `routes/model.js:596`'s `/status` is where it belongs, beside
   `usage_seasons: usageSeasons()`. That file belongs to another thread and the exact
   call was routed to them rather than written here.
5. **How does it unify?** One vocabulary for "this feed ran and wrote nothing",
   shared with every other countable batch job in `scheduler.js`, so an operator
   reads one kind of status row instead of one per feed.
