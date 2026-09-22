# Thirteen fantasy jobs off the request thread, and a register for the rest

Evidence for `fix: take the audited fantasy ingests off the request thread`
(`server/services/scheduler.js`, six `offThread` flags plus `ON_REQUEST_THREAD`).

## Why this file has no RED commit

The change is a scheduling decision, not an implementation. A test asserting
"`espn_depth_chart` runs off-thread" fails before and passes after, which is
technically a RED/GREEN pair and proves nothing except that a flag was set. The
work here was the audit that decided *which six*, and the guard worth having is
not the flag but the rule the flags now satisfy.

Retroactive form, precedent `docs/tdd/week2-numbers.tdd.md`. Standard: *a test
that no mutation can fail proves nothing.* Sweep at the end.

## What was wrong

Nineteen growth and metered jobs ran on the request thread. `node:sqlite`'s
`DatabaseSync` is fully synchronous, so each of those is a stretch of
wall-clock during which the app answers nothing at all — "a slow job" and "an
outage" are the same event in this process.

Nineteen was also a number nobody could act on. It says how many without saying
which, or why any particular one is still there.

## What decides whether a job can move

`job-worker.js` gives each run a **fresh module graph** and the thread exits
when the job returns. So module-scope state falls into three kinds, and only
the third is a real blocker:

1. **A memo.** Cold in every worker. Costs CPU, changes no answer. Safe.
2. **Cross-run coordination** — a rate limiter, a backoff, a warn-once.
   Resets every run. A blocker when the interval matters.
3. **State that IS the job's product.** The job does the work, fills a Map in
   a thread about to disappear, and reports success. Never safe.

A transitive scan is useless for this. Across the nineteen closures it turns up
**1,460 mutated module-scope bindings in modules the main thread also imports**,
nearly all of them kind 1. The census had to be read rather than counted.

**Kind 2, in all nineteen: two.** `sportsgameodds.js:36 _lastCallAt` paces
calls, and `odds-api.js:63 _lastHold` records the last credit-reserve refusal.
The reserve itself is database-backed (`odds_usage`), so only the diagnostic in
`reserveStatus()` would go blank — but that diagnostic is what a person reads
to find out why a capture wrote nothing. Both betting-side, so recorded rather
than moved.

**Kind 3, in all nineteen: one.** `trade_asset_universe_warm`, in
`MAIN_THREAD_ONLY` with its own evidence file
(`docs/tdd/main-thread-only-holds.tdd.md`).

## The six that moved

All fantasy-side, all fetch-parse-write, all persisting to SQLite rather than
to memory, all at a 6-hour cadence or slower:

| Job | Cadence | Writes to |
|-----|---------|-----------|
| `espn_depth_chart` | 12 h | `routes/nfldata.js`, 8 write statements |
| `espn_season_stats` | 24 h | `routes/stats.js` |
| `sleeper_players` | 24 h | `routes/aggregates.js`, 15 write statements |
| `espn_rosters` | 24 h | `routes/nfldata.js` |
| `nfl_coaches` | 24 h | `nfl-coaches.js` |
| `nfl_offseason_depth_injury` | 6 h | delegates, then `recordSync` |

The cost is real and is why this did not go further: each run spawns a worker
that imports this file's whole module graph. At a 12-hour cadence that is
nothing against the seconds of request-thread time it buys back. At
`trade_asset_universe_warm`'s 20 minutes it would be the opposite trade, and
that job cannot move at all regardless.

## The live tier: #59's boot fix does not survive the first tick

This started as six growth jobs. Auditing the live tier turned up something
larger, and it is the reason the register covers every tier rather than the
background one.

#59 took the boot pass off the request thread. It does that by passing
`bootOffThread(j)` as an override:

```js
for (const j of bootJobs) await runIfStale(j, { offThread: bootOffThread(j) });
```

The live timer, ninety seconds later and every ninety seconds after that, calls
`runIfStale(j)` with **no override at all**. So `resolveOffThread` falls back
to `job.offThread ?? job.tier === 'heavy'`, which is false for a live job.

**Fourteen jobs went into a worker once, at boot, and ran on the request
thread every ninety seconds for the rest of the process's life.** Measured, not
inferred: 18 of the 20 `BOOT_JOBS` are live-tier, three of those are in
`MAIN_THREAD_ONLY`, one (`evidence_daemon`) carries its own flag, and the
remaining fourteen disagree between the two paths.

That is exactly the defect #63 found on the background tier for
`nfl_model_growth` — "a fix that only holds until it succeeds is not a fix" —
and fixing that single instance made the other fourteen *harder* to see, not
easier, because the shape now looked handled.

The cost that decides what moves: a worker costs a module graph **per run, not
per tick**, because `runIfStale` only runs a job that is actually stale. For a
job on a 15-minute cadence or longer the trade is not close. For the four on a
3-minute cadence it is genuinely unclear, and those are all betting-side, so
they are recorded with "worker cost unmeasured" rather than moved on a guess.

Seven more moved on that basis, all fantasy-side, all audited the same way:
`rss_news` (15 m), `espn_news` (30 m), `nfl_transactions` (30 m),
`league_rosters` (60 m), `nfl_news_signals` (60 m), `player_rosters` (180 m),
`nfl_injuries` (360 m). `league_rosters` took a detour through being reverted;
see below, because what it cost is worth more than the move.

### league_rosters: the tests were not in the way, the test SHAPE was

I moved `league_rosters`, watched two tests go red, reverted it, and wrote the
reason into the register. That was the right first move and the wrong place to
stop.

`test/league-roster-schedule.test.js` stubs `globalThis.fetch` on the main
thread and then drives the job through `runIfStale('league_rosters',
{ force: true })`, asserting real rows: that a renamed league's payload
refreshes, and that one league's 500 does not stop the next league syncing.
A worker has its own globals and its own connection, so the stub never reaches
it, the offline guard blocks the real call, and both go red.

The tempting read is "two tests are in the way of a fix". They are not. They
are the only thing standing between a per-league loop and a silent regression
where one bad league stops the rest — the exact failure this app keeps
producing. Deleting them to ship the move would have been the worst available
outcome.

What was actually wrong is that they asserted the behaviour **through the
scheduler**, which made them silently conditional on the job running inline.
The behaviour has nothing to do with which thread it happens on.

So `refreshLeagueRosters` is exported and the file is split, exactly as #45 did
for `ffOpportunitySeasons` and for the same reason — an off-thread job cannot be
reached from the main thread's test process, so test the work directly and the
wiring separately:

- `league_rosters is wired to the scheduler, on a tier, with a cadence` — the
  registry assertion, which is the regression the file was originally written
  for (a real trade never reached Trade Lab because nothing re-fetched
  `leagues.payload`). It deliberately does **not** assert off-thread; pinning
  that here is what coupled the tests to it in the first place.
- `a connected league's own roster payload is re-synced, not left stale` and
  `a per-league sync failure does not block other leagues from refreshing` —
  now call `refreshLeagueRosters()` directly.

Swept, to confirm the rewrite did not weaken them:

```
=== BASELINE ===
# pass 9
# fail 0
### one-bad-league-aborts-the-loop [applied] -> 8 pass / 1 fail
    not ok 9 - a per-league sync failure does not block other leagues from refreshing
### payload-never-refreshed [applied] -> 7 pass / 2 fail
    not ok 8 - a connected league's own roster payload is re-synced, not left stale
    not ok 9 - a per-league sync failure does not block other leagues from refreshing
### job-unwired-from-the-registry [applied] -> 7 pass / 2 fail
    not ok 3 - the audited fantasy jobs actually run off the request thread
    not ok 7 - league_rosters is wired to the scheduler, on a tier, with a cadence
### job-loses-its-cadence [applied] -> 8 pass / 1 fail
    not ok 7 - league_rosters is wired to the scheduler, on a tier, with a cadence
```

`one-bad-league-aborts-the-loop` re-throws inside the per-league `catch`, which
is the regression the original test existed to prevent; it still fails, now
without depending on the job's thread. `job-loses-its-cadence` sets
`maxAgeMinutes: 0`, which makes a job that is never stale and therefore never
runs — a wiring failure that looks exactly like a healthy registry entry.

### One of those looked like a blocker and is not

`refreshLeagueRosters` and `refreshPlayerRosters` both gate on
`liveDraftActive()`, and that function's own comment says the `drafts` table is
created at import time by `routes/drafts.js` rather than by a migration — with
a `catch` that reads "can't tell" as "no live draft". A worker that never
imports that route would therefore answer *false* and sync ESPN in the middle
of a live draft, over the same browser cookie the draft poller is using.

It does not, because the table is created in **SQLite**, not in memory. The
main process imports `routes/drafts.js` at startup, before any job runs, and
the worker opens the same database file. The guard reads the same rows.

Worth writing down precisely because the first reading was wrong and the wrong
reading is the plausible one. "Created at import time" sounds like process
state; it is a `CREATE TABLE IF NOT EXISTS` against a shared file.

## The rest, and why that is now written down

`ON_REQUEST_THREAD` is **not** a second allow-list. `MAIN_THREAD_ONLY` names
jobs that must not go into a worker. This names jobs that simply have not, and
keeping them apart is the point: an entry here is an admission and is meant to
read as one.

**29 jobs still run on the request thread**, and every one of them is in
exactly one of the two lists. The suite asserts that the two sizes sum to that
count, which is what stops the register drifting into a formality that is
technically satisfied and no longer true.

Most are betting- or MLB-side and out of scope for this thread.
`manager_signals` already computes in its own worker via
`refreshManagerSignalsOffThread` (`scheduler.js:647`), so flagging it would
wrap a worker in a worker. `trade_asset_universe_warm` is in the other list.

The rule the suite enforces is that there is no fourth option: a job is
off-thread, or it must not be, or it says why it is not.

## The rules, and the mutation that breaks each one

Five guarded rules in `test/growth-jobs-off-thread.test.js`. Baseline:
**5 pass, 0 fail.** The harness hashes the file before and after each
injection and prints `applied` or `NO-OP`, because an injection that silently
matched nothing reads as a green sweep.

```
=== BASELINE ===
# pass 5
# fail 0
### one-ingest-back-on-the-request-thread [applied] -> 2 pass / 3 fail
    not ok 1 - every growth and metered job is accounted for
    not ok 2 - the six audited fantasy ingests actually run off the request thread
    not ok 5 - the count is going down, not up
### all-six-back-on-the-request-thread [applied] -> 2 pass / 3 fail
    not ok 1 - every growth and metered job is accounted for
    not ok 2 - the six audited fantasy ingests actually run off the request thread
    not ok 5 - the count is going down, not up
### a-new-blocking-job-appears-unexplained [applied] -> 3 pass / 2 fail
    not ok 1 - every growth and metered job is accounted for
    not ok 5 - the count is going down, not up
### excuse-left-behind-after-the-job-moved [applied] -> 4 pass / 1 fail
    not ok 3 - nothing is both moved and excused
### excuse-with-no-reason [applied] -> 4 pass / 1 fail
    not ok 4 - the two lists stay separate, and every excuse is a sentence
### a-job-in-both-lists [applied] -> 4 pass / 1 fail
    not ok 4 - the two lists stay separate, and every excuse is a sentence
### excuse-names-a-job-that-does-not-exist [applied] -> 3 pass / 2 fail
    not ok 1 - every growth and metered job is accounted for
    not ok 4 - the two lists stay separate, and every excuse is a sentence
```

- **one-ingest-back-on-the-request-thread** and
  **all-six-back-on-the-request-thread** — the flags removed, i.e. the state
  before this change. The accounting rule catches it without anyone having to
  name the job, which is the property that makes it worth more than the six
  assertions.
- **a-new-blocking-job-appears-unexplained** — a new growth job added with no
  flag and no entry. This is the case the register exists for: the next job
  added cannot quietly join the majority.
- **excuse-left-behind-after-the-job-moved** — an `ON_REQUEST_THREAD` entry for
  a job that has already moved. A stale excuse reads exactly like a current
  one, which is the same defect class as a comment citing a proof that no
  longer exists.
- **excuse-with-no-reason** — a reason shortened to `'tbd'`. An entry whose
  reason is a placeholder is worse than no entry, because it looks settled.
- **a-job-in-both-lists** — `trade_asset_universe_warm` added to
  `ON_REQUEST_THREAD` as well. "Must not move" and "has not moved yet" cannot
  both be true, and a reader who finds it in the second list will eventually
  move it.
- **excuse-names-a-job-that-does-not-exist** — one key misspelled, so the real
  job silently falls out of the register while the register still looks full.

## The live-tier extension, swept separately

Baseline after widening the register to every tier: **6 pass, 0 fail.**

```
### live-news-job-back-inline [applied] -> 2 pass / 4 fail
    not ok 1 - every job is accounted for, on every tier
    not ok 2 - the boot pass and the live timer agree about the same job
    not ok 3 - the audited fantasy jobs actually run off the request thread
    not ok 6 - the count is going down, not up
### all-seven-live-jobs-back-inline [applied] -> 2 pass / 4 fail
    not ok 1 - every job is accounted for, on every tier
    not ok 2 - the boot pass and the live timer agree about the same job
    not ok 3 - the audited fantasy jobs actually run off the request thread
    not ok 6 - the count is going down, not up
### boot-override-diverges-with-no-note [applied] -> 3 pass / 3 fail
    not ok 1 - every job is accounted for, on every tier
    not ok 2 - the boot pass and the live timer agree about the same job
    not ok 6 - the count is going down, not up
### the-two-lists-stop-adding-up [applied] -> 4 pass / 2 fail
    not ok 4 - nothing is both moved and excused
    not ok 6 - the count is going down, not up
```

- **live-news-job-back-inline** and **all-seven-live-jobs-back-inline** — the
  flags removed. `the boot pass and the live timer agree about the same job` is
  the rule that would have caught the original fourteen, and it does.
- **boot-override-diverges-with-no-note** — one register entry deleted, leaving
  a job that a worker runs at boot and the request thread runs on every tick,
  with nothing saying so. That is the exact state the live tier was in before
  this change, reproduced one job at a time.
- **the-two-lists-stop-adding-up** — an already-off-thread job added to the
  register. The count assertion catches it, which is the point of asserting
  `25 + 4 = 29` rather than only asserting that nothing is unaccounted for: a
  register can be complete and still be full of entries that are no longer
  true.

## The five questions

Nick's standing rule of 2026-09-20 01:21Z: *"Is this well built. Is this based
on stats, is this just made up. How do we know this. Should this data be
pointed anywhere else on the platform. How can we unify everything."* Answered
here without softening, because the honest answer to one of them is "assumed".

**Well built?** The mechanism is. Which jobs moved, and which did not, is now a
rule the suite enforces rather than a set of flags someone remembered to set:
every job on every tier is off-thread, or must not be, or says why it is not,
and the two lists' sizes are asserted to equal the number that actually block.
A job added next month cannot join the quiet majority without writing a
sentence.

**Stats or made up?** **The per-job off-thread decision is reasoned, not
measured, and that is a real limitation.** Two things behind it *are* measured:
the mean interval between restarts (~177 s, from the overnight health log) and
`kona_player_info`'s payload size (17.6 MB, measured 2026-09-19). Everything
else is read from the source — each job's cadence, its tier, what it writes,
and what its module graph keeps in memory. **What nobody has is a measured
duration for any of these jobs on the deployed machine.** No job in this
registry has a recorded runtime, because the process has not lived long enough
to finish one. So "this job blocks the request thread for long enough to
matter" is an inference from what it does, not an observation of how long it
takes.

That is why the four 3-minute betting jobs were left alone with the cost
recorded as unmeasured rather than moved: at that cadence the worker spawn
could plausibly cost more than the block it avoids, and guessing in either
direction would be the same mistake.

**How do we know?** The structural claims are verified by reading the shipping
tree and by injection — every rule in this file has a mutation that was
actually applied (checked by hashing the file) and shown failing. The claim
that would be most damaging if wrong — that a worker cannot warm an in-process
cache — is pinned by asserting the premise (`compute-cache.js` keeps its store
in a module-level `Map` and writes no SQL) rather than the conclusion.

**Pointed anywhere else on the platform?** Yes, and it already is. The register
is the artefact: `ON_REQUEST_THREAD` and `MAIN_THREAD_ONLY` together are a
machine-readable statement of which jobs can block a request, which is exactly
what `source-registry.js` and any future freshness surface would need to
explain a stale number to a user. Nothing reads them that way yet. The obvious
next step, not taken here, is for the scheduler status endpoint to serve the
reason alongside the job so a person looking at a stale feed can see *why* it
is where it is.

**How does it unify?** By replacing three different ways of answering "does
this run in a worker" with one. Before: a flag on the job, an override on the
boot path, and a side table consulted by exactly one caller — which is how
fourteen live jobs ended up off-thread at boot and inline forever after.
`resolveOffThread` is now the single answer on every path, and the allow-list
outranks both the flag and the override because it states a constraint rather
than a preference.

**What would change the answers.** One measurement: the recorded duration of
any of these jobs on a machine that stays up. That is what `#61`'s start marker
makes possible for the first time — a job that dies now leaves a dated row
instead of nothing — and it is the input that would turn the reasoned half of
this into a measured one.

## What this file does not settle

Whether the worker spawn cost is worth it at the short end. Each off-thread run
imports the whole scheduler module graph in a fresh thread, and that cost has
not been measured on the deployed machine — only reasoned about against a
cadence. It is why the four 3-minute betting jobs were left where they are with
the reason recorded as "worker cost unmeasured" rather than moved on a guess.
The read that would settle it is the recorded duration of `rss_news`, on a
15-minute cadence, before and after — which needs a machine that stays up long
enough to run it twice.

And whether any of these six ever completes on the live box. None of them has
run once on this build: the process has not survived past the first background
pass. That is what the scheduler stack (#56, #59, #61, #63) is for, and it is
measured by the deploy, not here.

---

## Known collision: PR #89's `league_history` job (found 2026-09-22, before either merged)

PR #89 (`claude/project-thread-sytruo-asof-rebase` @ `b04c1ad`) adds a job this
branch has never seen:

    league_history: { run: refreshLeagueHistory, maxAgeMinutes: 12 * 60, tier: 'growth',
      timeoutMs: 300_000, label: 'League history: final standings and weekly scores ...' }

`tier: 'growth'` with no `offThread` flag, so `resolveOffThread` returns
**false** and the job runs **on the request thread with a five-minute budget**.
When both branches land, two tests in this file fail:

- *every job is accounted for, on every tier* — `league_history` is neither
  off-thread nor in either list.
- *the count is going down, not up* — `onThread` becomes 30 against the
  `<= 29` bound, and `ON_REQUEST_THREAD.size + MAIN_THREAD_ONLY.size` (29) no
  longer equals it.

**The fix is one line in #89, not here**, and it is `offThread: true` on that
job definition. Not an `ON_REQUEST_THREAD` entry: nothing in
`server/services/league-history.js` (as #89 ships it) holds state that a worker
would break. Its only module scope is `now` and `sleep` (`:55,56`), both pure;
its pacing is a `sleep()` **within** one run rather than a `_lastCallAt` that
must survive between runs, which is what forces `sportsgameodds.js` and
`odds-api.js` to stay inline; and every write is a parameterised
`INSERT ... ON CONFLICT` through the shared handle (`:117,148`), which is what
every off-thread job already does. A five-minute job that reads ESPN and writes
SQLite synchronously is the exact shape this list exists to keep off the
request thread.

**Nothing can be pre-registered on this branch to absorb it.** The test at
`:85` asserts every `ON_REQUEST_THREAD` name is a real job, so an entry for a
job that does not exist here fails immediately. That is the right behaviour and
is not worth weakening for one known collision.

**Why #89 arrived at `'growth'` is worth reading, because it was reasoning
carefully and still landed on the request thread.** Its own comment says
`'growth', not 'heavy'` so that "there is nothing here the `heavy` tier's
`AUTO_HEAVY_SYNC` gate should be deciding" — avoiding the "silently never runs"
failure. That reasoning is sound about the gate and silent about the thread,
because `resolveOffThread` couples the two: the only tier that goes off-thread
by default is the one behind the gate. Anyone avoiding the gate also leaves the
worker, and nothing in `JOBS` says so at the point of writing a job. The
failure message on the test above now says it outright.

**Left as a proposal, not done here:** flipping the default to off-thread
unless listed. It would have caught this without anyone reading a message, but
it re-decides the thread for all twenty-nine currently-inline jobs at once,
which is a change of its own with its own evidence, not a coordinating fix.
