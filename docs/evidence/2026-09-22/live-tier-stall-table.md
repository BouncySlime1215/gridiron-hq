# Live-tier stall table — which jobs can block the event loop

**Phase 0 item 2.** Question it settles: which of the 24 `tier: 'live'` jobs can
block the event loop long enough to arm the #29 watchdog and get the process
SIGKILLed. Measured, not argued.

## The answer, stated before the table

**This run does not identify a killer, and the reason is structural rather than
reassuring.** The longest single stall across all 24 jobs was **1,835 ms**
(`polymarket`) — 33× below the 60,000 ms watchdog threshold. Nothing reached
even the 10 s "suspect" line.

**That is not a clean bill of health, and it must not be read as one.** Three
things bound it:

1. **The database was empty.** These jobs are dominated by synchronous
   `node:sqlite`. A query that is instant against 0 rows is the same query that
   blocks for a minute against 445 MB. The measurement below is a **lower
   bound**: a job over threshold here would be conclusively a killer, but a job
   under threshold here is only cleared *for this database*.
2. **Five jobs never did their work**, so they carry **no verdict at all** —
   four returned HTTP 403 without credentials and one threw before it started.
   Recording those as "clear" would be the exact mistake this project has made
   before: reading an absent credential as a passing grade.
3. **Five more did nothing**, with zero network calls and zero rows, because an
   empty database gave them nothing to act on (no leagues, no open tickets).

So 14 of 24 produced a meaningful number, all of them small, on a database that
cannot produce the failure being hunted. **The definitive run needs a
`VACUUM INTO` copy of production**; the command for it is at the bottom.

## What this run *did* establish

- **`polymarket` is the standout and the only job in a different class.** 1,835 ms
  of unbroken blocking, 10.5 s wall, 44 network calls and **13,640 rows written**
  — on an empty database. Every other job that did real work stayed at or below
  17 ms. Rows written is the term that scales with production data, so this is
  the first job to measure again against the real copy.
- **`evidence_daemon` is the heaviest by wall clock** — 5.7 s and 96 network
  calls — but only 17 ms of loop blocking, because its work is asynchronous.
  It is also the one live-tier job already marked `offThread: true`
  (`scheduler.js:1396`), so it is not on the request thread anyway.
- **`player_rosters` is broken on this build, independently of any of this.**
  It throws `Provided value cannot be bound to SQLite parameter 3.`
  (`scheduler.js:1196`, `refreshPlayerRosters`). That is a real defect in a
  live-tier job, not an artefact of the empty database or a missing credential:
  a bind-type error is a code fault. Flagged, not fixed — out of this item's scope.

## The table

`stall` is the **longest single** event-loop delay during the job, in ms, from
`monitorEventLoopDelay({ resolution: 10 })`. It is the number that matters:
the watchdog fires on one continuous stall, not on cumulative slowness. Read
`max`, never `mean` — a job that blocks once for 70 s and idles otherwise has a
mean in the milliseconds and is still fatal.

Thresholds (Nick, 2026-09-22): **over 60,000 ms = killer**, **over 10,000 ms =
suspect**, under = clear *on the database it ran against*.

| job | stall (ms) | wall (ms) | net | rows | outcome | verdict |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `mlb_schedule` | 17 | 519 | 1 | 2458 | ok | clear *on this DB* |
| `mlb_boxscores` | 10 | 42 | 1 | 31 | ok | clear *on this DB* |
| `mlb_probables` | 10 | 45 | 1 | 70 | ok | clear *on this DB* |
| `player_rosters` | 13 | 1434 | 1 | 1 | threw: Provided value cannot be bound to SQLite parameter 3. | **no verdict** — short-circuited |
| `league_rosters` | 0 | 3 | 0 | 0 | ok | **no verdict** — did nothing here |
| `nfl_lines` | 11 | 916 | 18 | 0 | ok | clear *on this DB* |
| `nfl_forward_settle` | 0 | 4 | 0 | 0 | ok | **no verdict** — did nothing here |
| `nfl_book_feeds_extra` | 12 | 4192 | 5 | 1 | ok | clear *on this DB* |
| `nfl_book_feeds_fast` | 11 | 605 | 3 | 0 | ok | clear *on this DB* |
| `nfl_book_feeds_slow` | 12 | 446 | 3 | 0 | ok | clear *on this DB* |
| `nfl_pick_watch` | 0 | 13 | 0 | 43 | ok | clear *on this DB* |
| `nfl_t60_runner` | 0 | 24 | 0 | 0 | skipped | **no verdict** — did nothing here |
| `polymarket_line_watch` | 0 | 2 | 0 | 0 | ok | **no verdict** — did nothing here |
| `espn_line_watch` | 10 | 102 | 1 | 1 | error: ESPN scoreboard 403 | **no verdict** — short-circuited |
| `nfl_play_by_play` | 10 | 38 | 1 | 0 | error: ESPN scoreboard returned 403 | **no verdict** — short-circuited |
| `prediction_markets` | 14 | 308 | 2 | 234 | ok | clear *on this DB* |
| `polymarket` | 1835 | 10473 | 44 | 13640 | ok | clear *on this DB* |
| `evidence_daemon` | 17 | 5663 | 96 | 1253 | ok | clear *on this DB* |
| `nfl_prop_clv_free` | 0 | 7 | 0 | 1 | ok | clear *on this DB* |
| `rss_news` | 10 | 145 | 1 | 0 | ok | clear *on this DB* |
| `espn_news` | 10 | 118 | 1 | 1 | threw: ESPN news API 403 | **no verdict** — short-circuited |
| `nfl_news_signals` | 0 | 1 | 0 | 0 | ok | **no verdict** — did nothing here |
| `nfl_injuries` | 10 | 198 | 1 | 1299 | ok | clear *on this DB* |
| `nfl_transactions` | 10 | 53 | 1 | 1 | threw: ESPN transactions API 403 | **no verdict** — short-circuited |

## What it ran against

| | |
| --- | --- |
| Source tree | `654ff93` (origin/main), tree `6944033` **before and after** the run |
| Isolation | **source-isolated** — dedicated worktree, `node_modules` symlinked to the main checkout; no `npm ci` ran in the window |
| Database | `/tmp/claude-0/stall-measure.sqlite`, built fresh by `node scripts/migrate.mjs` (63 migrations) |
| DB size | **2.8 MB** at the start, 9.7 MB after (the run itself wrote every row in the table above) |
| DB contents | **265 tables, 263 of them empty.** The only populated table at the start was `schema_migrations` (63 rows) |
| Production, for contrast | **~445 MB**, `player_week_usage` carrying 2021–2025 |
| Network | **live and reachable** — the jobs called real upstreams; the 403s are real refusals, not a blocked egress |

The empty-versus-445 MB gap is the whole reason this run is labelled LOCAL.

## Reproducing it

```
git worktree add --detach <dir> 654ff93
cd <dir> && ln -s <main-checkout>/node_modules node_modules
GRIDIRON_DB_PATH=/tmp/stall.sqlite node scripts/migrate.mjs
GRIDIRON_DB_PATH=/tmp/stall.sqlite node scripts/measure-live-tier-stalls.mjs
```

The harness is `scripts/measure-live-tier-stalls.mjs`. It refuses to run without
`GRIDIRON_DB_PATH`, because the jobs write for real and must never be pointed at
a live database. It reads `max` in nanoseconds and converts — reading that field
as milliseconds understates every stall by six orders of magnitude and would
clear every job on this list.

## The run that actually answers the question

Needs a copy of production, which only Nick's terminal can make. `VACUUM INTO`
is the right instrument: it takes a consistent copy without stopping the app and
without touching the original.

```
fly ssh console -a gridiron-hq -C "sqlite3 /data/data.sqlite \"VACUUM INTO '/data/stall-copy.sqlite'\""
fly ssh sftp get /data/stall-copy.sqlite ./stall-copy.sqlite -a gridiron-hq
fly ssh console -a gridiron-hq -C "rm /data/stall-copy.sqlite"
```

Then the same two commands as above against `./stall-copy.sqlite`.

**Two cautions to hand over with it.** The copy needs free space on the volume
equal to the database — check `df -h /data` before, since a migration deploy
already requires DB size plus 2 GB free. And the copy must be **deleted from the
volume** after transfer, which is why the third line is there rather than left
as an exercise.

**A note on credentials for that run.** Four jobs returned 403 here. If the
production run is made in an environment that also lacks those credentials, those
four will short-circuit again and still carry no verdict — the copy fixes the
data gap, not the credential gap. Say which of the two a given run answers.
