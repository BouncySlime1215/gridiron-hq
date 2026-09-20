# Six fantasy ingests off the request thread, and a register for the rest

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

## The thirteen that did not, and why that is now written down

`ON_REQUEST_THREAD` is **not** a second allow-list. `MAIN_THREAD_ONLY` names
jobs that must not go into a worker. This names jobs that simply have not, and
keeping them apart is the point: an entry here is an admission and is meant to
read as one.

Eleven are betting- or model-evidence-side and out of scope for this thread.
One (`manager_signals`) already computes in its own worker via
`refreshManagerSignalsOffThread` (`scheduler.js:647`), so flagging it would
wrap a worker in a worker. One is `trade_asset_universe_warm`, which is in the
other list.

The rule the suite now enforces is that there is no fourth option: a growth or
metered job is off-thread, or it must not be, or it says why it is not.

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

## What this file does not settle

Whether the worker spawn cost is worth it for the 6-hour job. Each off-thread
run imports the whole scheduler module graph in a fresh thread, and that cost
has not been measured on the deployed machine — only reasoned about against a
cadence. The read that would settle it is the recorded duration of
`nfl_offseason_depth_injury` before and after, which needs a machine that stays
up long enough to run it twice.

And whether any of these six ever completes on the live box. None of them has
run once on this build: the process has not survived past the first background
pass. That is what the scheduler stack (#56, #59, #61, #63) is for, and it is
measured by the deploy, not here.
