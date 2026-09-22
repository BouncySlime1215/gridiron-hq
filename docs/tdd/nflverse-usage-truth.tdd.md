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
