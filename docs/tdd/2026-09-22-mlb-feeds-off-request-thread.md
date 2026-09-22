# The three MLB feeds stop blocking the request thread

2026-09-22. Branch `claude/project-thread-o3wt2p-mlb-offthread`, from
`origin/main` **f620a120**.

RED `d11e1692` · GREEN `579e522f`

## What was wrong

`mlb_schedule`, `mlb_probables` and `mlb_boxscores` were named in
`ON_REQUEST_THREAD` with one reason each:

> `MLB feed; the fantasy half of this app never reads it`

That sentence is true. It was also the wrong conclusion, and the gap between
the two is the whole unit. `node:sqlite`'s `DatabaseSync` is fully synchronous,
so while one of these parses a season of games and writes them, the process is
not answering anybody — about baseball, about football, or about anything else.
Whether a row is ever read has no bearing on what writing it costs. The excuse
explained why nobody NEEDED the data. It never claimed the job was free, and it
was read for weeks as if it had.

The production log said so in the scheduler's own words, on the deployed image:

```
[scheduler] 'mlb_schedule' took 1.5s — every request was blocked for that long while it ran
```

That is not cosmetic wording left over from the off-thread work. `scheduler.js`
branches on `offThread` at the slow-job warning and prints
`in a worker thread — requests were served normally throughout` for the worker
case; the sentence above is reachable only from the inline branch. It is a
measurement.

## Why these three, and not the rest of the list

`ON_REQUEST_THREAD` is not a to-do list. Most of its entries name a real
blocker, and this unit does not touch them:

| Entry | Why it stays |
| --- | --- |
| `nfl_line_snapshots` | betting side, out of scope; `odds-api.js:63` `_lastHold` is module-level and a worker resets it every run |
| `nfl_sgo_snapshot` | betting side, out of scope; `sportsgameodds.js:36` `_lastCallAt` paces the feed from module scope |
| `polymarket`, `polymarket_line_watch`, `prediction_markets`, `nfl_play_by_play` | 3-minute cadence, where a module graph per run stops being free and has not been measured |
| `nfl_lines` | betting side, out of scope. Explicitly left alone |
| `manager_signals` | already computes in its own worker via `refreshManagerSignalsOffThread` |
| `trade_asset_universe_warm` (`MAIN_THREAD_ONLY`) | its product IS in-process memory; a worker would warm its own Map and exit |

The three MLB feeds have none of those properties, and that was checked rather
than assumed:

- **No module-level mutable state anywhere in the chain.** `server/services/mlb.js`
  has exactly one top-level binding, `const BASE = 'https://statsapi.mlb.com/api/v1'`,
  a string. `server/services/date-util.js`, its only other import besides
  `db/index.js`, has no top-level bindings at all.
- **Their whole product is rows.** `syncSeasonSchedule` writes `mlb_games`,
  `syncProbableStarters` writes `mlb_probable_starters`, `syncFinalBoxscores`
  writes through `syncGameBoxscore`. Every reader goes back to SQLite:
  `starterFor` (`mlb.js:142`) is a `rows(...)` query, as is `coverage`
  (`mlb.js:287`), as are the routes.
- **Their return values survive the worker boundary.** `job-worker.js` posts
  `JSON.parse(JSON.stringify(value))`. The three return `{ season, games, upcoming }`,
  `{ from, to, confirmed }` and `{ date, games, hydrated, failed }` — strings
  and numbers.
- **Their cadences are 30, 60 and 90 minutes.** A worker costs a module graph
  per RUN, not per tick, because `runIfStale` only runs a job that is actually
  stale. At those intervals the trade is not close.

## The strongest evidence: they already run in a worker

`BOOT_JOBS` lists all three. `bootOffThread(name)` returns true for anything
not in `MAIN_THREAD_ONLY`. So the deployed app **already runs these three in a
worker thread at every boot**, and has since #59.

Ninety seconds later the live timer calls `runIfStale(name)` with no override,
`resolveOffThread` falls through to `job.offThread ?? job.tier === 'heavy'`,
and they run inline — and every 90 seconds after that, forever.

This is #63's defect exactly, on the tier #59's fix does not reach. It is the
shape `growth-jobs-off-thread.test.js`'s "the boot pass and the live timer
agree about the same job" test was written to catch, and these three were
excused from it by being on the list the test skips.

So this change does not introduce a worker path for them. **It removes the half
of the day they were not using the one they already have.** Whatever risk a
worker carries for these jobs, production has been taking it at every boot for
weeks.

## A second effect, on a request path

`server/routes/mlb.js:61` and `:126` call `refreshInBackground(...)` on a page
load and do not await it. The comment above it says the request returns
immediately "with whatever is stored", and blocking a page render on a network
sync "would make the app feel broken".

That was true of the request that fired it and false of every other request in
flight. `refreshInBackground` yields at its `await runIfStale(j)` and then runs
the job's synchronous SQLite writes on the one thread serving all of them.
Fire-and-forget is only fire-and-forget once the work is somewhere else. Test 5
pins the default argument for that reason.

## Counts

| | tests | pass | fail |
| --- | --- | --- | --- |
| RED `d11e1692`, `mlb-jobs-off-thread.test.js` | 5 | 1 | 4 |
| GREEN `579e522f`, same file | 5 | 5 | 0 |
| GREEN + test 6 (added after the sweep) | 6 | 6 | 0 |
| `growth-jobs-off-thread.test.js`, GREEN | 6 | 6 | 0 |

The one test green at RED is "the three keep the by-name worker path, and
nothing else about them changes" — a pin on cadence, tier and the absence of a
`worker` descriptor, which is meant to be green either side.

Related suites, all green on the GREEN tree: `boot-path-off-thread` 7/7,
`main-thread-only-holds` 9/9, `scheduler-blocking-jobs` 8/8,
`timer-tier-off-thread` 4/4, `league-roster-schedule` 3/3, `wiring-map` 90/90.

## The ratchet

`growth-jobs-off-thread.test.js` bounds the count and asserts its arithmetic.
Both numbers were measured on the GREEN tree rather than reasoned about:

```
accountable: 51
onThread total: 26
   live 13
   metered 6
   growth 7
ON_REQUEST_THREAD: 22 MAIN_THREAD_ONLY: 4 sum: 26
```

Was 29 (16 live), `ON_REQUEST_THREAD` 25. The bound is edited 29 → 26 in the
same commit, which is what that file's own comment asks for.

## Mutation sweep

Seven mutations, each verified applied by md5 before the run and verified
restored by md5 after it — never by grep. Run against
`mlb-jobs-off-thread.test.js` + `growth-jobs-off-thread.test.js`.

| | mutation | md5 | verdict |
| --- | --- | --- | --- |
| M1 | drop `offThread` from `mlb_schedule` only | `48393a6d → 130d85c9` | KILLED by 6 tests |
| M2 | flag set, but the excuse put back in `ON_REQUEST_THREAD` | `48393a6d → 6888e561` | KILLED by "nothing is both moved and excused"; "the excuse is gone from both lists" |
| M3 | `offThread: false` on `mlb_boxscores` | `48393a6d → 95328b83` | KILLED by 6 tests |
| M4 | `mlb_probables` parked in `MAIN_THREAD_ONLY` instead of moved | `48393a6d → db41aac0` | KILLED by "the excuse is gone from both lists, not moved between them" |
| M5 | cadence changed (90 → 30) while moving the thread | `48393a6d → 3b61ded7` | KILLED by "nothing else about them changes" |
| M6 | explicit `worker: { module, fn, args }` descriptor added | `48393a6d → 7b712245` | KILLED by "the by-name worker path" |
| M7 | ratchet bound left stale (`<= 26` → `<= 99`) | `d9e7fe1b → fe6dc931` | **SURVIVED** |

**M7 survived and cannot be killed by a behavioural test.** A loose upper bound
has no behaviour to assert against, and the companion assertion
`ON_REQUEST_THREAD.size + MAIN_THREAD_ONLY.size === onThread` does not catch it
because both sides move together when a job is added to a list. Test 6 was
added afterwards and does not kill it either — it covers the *consequence*: with
the bound left stale, a job quietly added to `ON_REQUEST_THREAD` raises the
count and nothing over there notices, and an exact `onThread === 26` here does.
That distinction is written into the test's own comment rather than left as a
claim in this file.

## What this does NOT establish

- **No latency was measured on the deployed app by this unit.** The 1.5 s
  figure is one production log line for `mlb_schedule`, quoted as it was
  printed. It is not a distribution, a p50 or a p99, and nothing here claims
  the saving is 1.5 s per tick. What is established is the sign: three jobs
  that blocked now do not.
- **The three sync functions were not executed.** They fetch from
  `statsapi.mlb.com`, which is out of reach here and would be a paid-free but
  live third-party call either way. The worker-safety argument rests on source
  audit plus the fact that production already runs them through this exact path
  at boot — not on a run.
- **This says nothing about the betting entries.** They were read and left
  alone. `nfl_lines` in particular stays exactly as it is.
- **It does not measure worker cost.** The claim is that 30/60/90-minute
  cadences amortise a module graph per run. That is the same reasoning the
  fantasy jobs moved on; it has not been benchmarked here, and the four
  3-minute jobs are still excused on exactly that unmeasured ground.

## Five questions

**Is it well built?** It is three flags and three deletions. The design work was
deciding which entries on that list were excuses and which were blockers, and
the answer is written into the code comment rather than only here, so the next
person reading `ON_REQUEST_THREAD` sees why these three left and the others did
not.

**Are the numbers real stats or made up?** There are no statistics. Every number
is either a test count copied from a run in this file, an md5 from the sweep, or
the job census printed by the script quoted above. The one production number,
1.5 s, is a single log line and is labelled as one.

**How do we know?** The RED commit failed 4 of 5 and the failing names are
listed. The counts 26 / 13 / 6 / 7 / 22 / 4 were printed by executing the
shipped module, not derived from the comment they replace. The "no module-level
state" claim is a grep of top-level declarations in `mlb.js` and
`date-util.js`, with the one binding found named. The "already runs in a worker"
claim is `BOOT_JOBS` plus `bootOffThread`, both exported and both asserted in
test 2.

**Is this pointed anywhere else?** Yes, at the rest of `ON_REQUEST_THREAD`. The
list mixes two things that read alike — "this job cannot move" and "nobody has
moved this job" — and the MLB entries were the second kind wearing the first
kind's sentence. The four 3-minute betting jobs are excused on an explicitly
unmeasured worker cost; that is a measurement someone could do, not a blocker.

**How does it unify?** Same shape as the ingest-error unit earlier today: a true
sentence written down in good faith, doing duty as a conclusion it never
supported. There the guard caught an error and no surface said so; here the list
recorded a reason and no one re-read it against what it actually licensed. Both
were found by asking what the written-down thing proves, not whether it is true.
