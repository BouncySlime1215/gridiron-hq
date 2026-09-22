# The main-thread allow-list, and the one job that cannot ever leave the request thread

Evidence for `fix: make the main-thread allow-list hold on every path`
(`server/services/scheduler.js`, `MAIN_THREAD_ONLY` / `resolveOffThread`).

## Why this file has no RED commit

Two changes here, and neither has a state a failing test could be written
against honestly.

The first is that `MAIN_THREAD_ONLY` was consulted only by `bootOffThread`.
A RED test would assert that an allow-listed job on the heavy tier stays on the
main thread — but no allow-listed job is on the heavy tier, so the test would
have had to invent one, and inventing the subject is not the same as catching
the bug. The mutation sweep below does the honest version: it puts the real
entry on the heavy tier, in the real registry, and shows the rule failing
without the fix.

The second is the `trade_asset_universe_warm` entry, which is a finding rather
than a code change. The job is correct today. What was missing is anything
saying it has to stay that way.

Retroactive form, precedent `docs/tdd/week2-numbers.tdd.md`. Its standard —
*a test that no mutation can fail proves nothing* — is what the sweep pays,
and this time it collected twice (see the last two sections).

## Finding 1: the allow-list held by coincidence

`MAIN_THREAD_ONLY` names jobs that must not run in a worker, because they keep
state in module scope that is persistence rather than a memo — `_providerBackoff`
and `_directBookLastSeen` in `book-feeds.js`, shared deliberately across the
three book-feeds jobs so they cannot double-write the same book.

It was read in exactly one place:

```js
export function bootOffThread(name) { return !MAIN_THREAD_ONLY.has(name); }
```

…and `bootOffThread` is passed as the override by the boot pass alone. Every
other path — the tier timer, a hand-run `runIfStale`, a future caller — went
through `resolveOffThread(job, override)`, which never looked at the map.

It looked like it held. All three entries are `live`-tier with no `offThread`
flag, so `job.offThread ?? job.tier === 'heavy'` answered `false` for them
anyway and nothing ever reached the gap. **That is a coincidence, not a
guarantee.** Flag one of them, or move one to the heavy tier — which goes
off-thread by default precisely so nobody has to remember the flag — and it
would go to a worker with the allow-list sitting right there saying it must
not.

Same shape as the defect #63 fixed one layer up: a fix that holds until the
next tick is not a fix. `resolveOffThread` now consults the map on every path,
ahead of both the flag and the override, because the allow-list names a
correctness constraint and those two express a preference.

The lookup is by identity against `JOBS` rather than by a name parameter, so
every existing caller is covered without a signature change and without a
caller being able to forget to pass the name.

## Finding 2: one job's entire product is in-process memory

`trade_asset_universe_warm` (`refreshTradeAssetUniverse`, every 20 minutes,
growth tier) calls `assetUniverse(lg, formatKey)` for each league someone has a
membership in. It writes nothing. Its whole purpose is that the answer is
already in `compute-cache.js`'s `store` when the next person opens Trade Lab,
instead of them waiting 5–6 seconds for a cold build.

`compute-cache.js:24` is `const store = new Map()`. Nothing else. No table, no
`INSERT`.

A worker gets a fresh module graph and exits when the job returns. Off-thread,
this job would do every second of that work, fill a Map in a thread that is
about to disappear, post `{ leagues_warmed: 5 }`, and exit. The job succeeds.
`sync_log` reads `ok`. Not one request is served any faster. **It is the
healthy-looking-and-not-working shape this scheduler keeps producing, and it
would be introduced by a change that looks like an obvious improvement.**

This is a structural limit, not a flag to get right. A cache that lives in one
process cannot be warmed from another. There are two honest options and this PR
takes the first:

1. **Name it, so nobody moves it.** What is here. The job stays on the request
   thread, the allow-list says why, and the suite refuses the contradiction.
2. **Persist the asset universe.** `report-cache.js` already does exactly this
   for the reports that used to block the same thread — it writes to
   `nfl_cached_reports` (`report-cache.js:179`), which is what lets
   `nfl_reports` run off-thread today with its label saying "computed
   off-thread (worker) and served from SQLite". The asset universe is a much
   larger payload than a report and the fingerprint key would have to be
   stored alongside it, so this is a real piece of work, not a follow-up line.
   It is the fix that would actually take those 5–6 seconds per league off the
   request thread, and until it happens option 1 is the truth.

Worth being plain about what option 1 does not do: this job still blocks the
request thread for seconds at a time, every 20 minutes, and that is the freeze
the rest of this work exists to end. Moving it is not a smaller version of
fixing it — it is a way of making the symptom disappear from the job's own
status while the users still wait.

## The rules, and the mutation that breaks each one

Nine guarded rules in `test/main-thread-only-holds.test.js`. Baseline:
**9 pass, 0 fail.** The harness reports whether each substitution actually
changed the file, because a no-op injection reads as a green sweep and is a
stronger false claim than running none.

```
=== BASELINE ===
# pass 9
# fail 0
### allow-list-not-consulted [applied] -> 7 pass / 2 fail
    not ok 2 - the allow-list beats the heavy tier, which goes off-thread by default
    not ok 4 - the allow-list beats an explicit override, on the boot path
### allow-list-checked-after-the-override [applied] -> 8 pass / 1 fail
    not ok 4 - the allow-list beats an explicit override, on the boot path
### warm-job-entry-removed [applied] -> 8 pass / 1 fail
    not ok 7 - the asset-universe warm job is allow-listed, for the reason it is
### warm-job-reason-emptied [applied] -> 7 pass / 2 fail
    not ok 1 - every allow-listed name is a real job, with a reason
    not ok 7 - the asset-universe warm job is allow-listed, for the reason it is
### allow-list-names-a-job-that-does-not-exist [applied] -> 6 pass / 3 fail
    not ok 1 - every allow-listed name is a real job, with a reason
    not ok 2 - the allow-list beats the heavy tier, which goes off-thread by default
    not ok 6 - no job is both allow-listed and flagged off-thread
### warm-job-also-flagged-offthread [applied] -> 8 pass / 1 fail
    not ok 6 - no job is both allow-listed and flagged off-thread
### everything-becomes-main-thread [applied] -> 7 pass / 2 fail
    not ok 3 - the heavy-tier precondition is real, on a job that is not allow-listed
    not ok 5 - a job that is not allow-listed is unaffected
### compute-cache-persists-after-all [applied] -> 8 pass / 1 fail
    not ok 8 - the premise still holds: compute-cache keeps its store in memory only
### warm-job-starts-persisting [applied] -> 8 pass / 1 fail
    not ok 9 - the job really does warm that cache and persist nothing
```

- **allow-list-not-consulted** — the new check deleted, i.e. the state this PR
  found. Both of the rules that exercise a real path fall.
- **allow-list-checked-after-the-override** — the check moved below
  `if (override != null) return override`. A caller could still send an
  allow-listed job to a worker, which is the half of the bug that survives the
  obvious fix.
- **everything-becomes-main-thread** — the check replaced by a bare
  `return false`. The regression guard: without it, deleting the allow-list's
  *effect* and disabling off-thread entirely would look identical.
- **warm-job-entry-removed** / **warm-job-reason-emptied** — the finding
  deleted, and the finding reduced to a listing with no reason. An allow-list
  entry is only as true as the reason beside it.
- **allow-list-names-a-job-that-does-not-exist** — one key misspelled. Silently
  protects nothing while reading as though it does.
- **warm-job-also-flagged-offthread** — `offThread: true` added to the job the
  allow-list names. `resolveOffThread` resolves this in favour of the
  allow-list, but a contradiction in the tree means one of the two is a mistake
  and nobody knows which, so the suite refuses it rather than picking.
- **compute-cache-persists-after-all** and **warm-job-starts-persisting** —
  these pin the *premise*, not the conclusion. If the cache ever persists, or
  the job ever writes, the allow-list entry becomes wrong and the job can move.
  Better that the suite says so than that the entry quietly outlives its reason.

## The first version of rule 2 passed with the fix deleted

`the allow-list beats the heavy tier` was originally written against a spread
copy:

```js
const asHeavy = { ...job, tier: 'heavy' };
```

The lookup matches by **identity** against `JOBS`, so a spread copy is a
different object and is never allow-listed. The test's real assertion was on
the untouched entry, which is `live`-tier, and therefore resolved main-thread
whether the allow-list was consulted or not — the exact coincidence this PR
exists to remove, reproduced inside the test written to catch it. It reported
`7 pass / 0 fail` against a deleted fix.

It now mutates the real entry in `JOBS` and restores it in a `finally`, and
`the heavy-tier precondition is real` asserts the other half, so the pair
cannot both pass for the wrong reason.

## Two mutations in this sweep silently did nothing

`warm-job-entry-removed` and `warm-job-reason-emptied` first reported a clean
`8 pass / 0 fail`. Neither had changed the file: the substitution patterns did
not match the wrapped, escape-containing entry text. Rewritten and re-run, both
fail their target rule.

This is the second time tonight an injection has read as green because it never
applied. **A mutation result is evidence only if the mutation was applied.**
The harness now hashes the files before and after and prints `applied` or
`NO-OP` per injection, and that check is what caught these two.

## The suite refused the new entry, which is what it is for

`boot-path-off-thread.test.js` carries a ratchet — `assert.deepEqual` on the
allow-list's exact keys — written so the list cannot grow without someone
editing that line. It fired on the fourth entry and failed the full run.

That is the test working, not a test in the way, so the line was updated rather
than relaxed. The comment beside it now records that the entries are there for
two different reasons: the three book-feeds jobs come off if their state is
persisted, and `trade_asset_universe_warm` comes off only if the asset universe
itself is persisted — never because someone decides the risk looks acceptable.

## What this file does not settle

Whether `trade_asset_universe_warm` is *worth* its cost on the request thread.
It blocks for 5–6 seconds per league every 20 minutes, against 5 leagues. The
measurement that would settle it is how often Trade Lab is opened against a
cold cache, which needs a live read this suite cannot make.
