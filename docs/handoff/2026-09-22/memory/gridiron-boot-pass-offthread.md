---
name: gridiron-boot-pass-offthread
description: Moving the scheduler's boot path into workers — how the override works, what it costs, and the two pieces of in-memory state that keep three jobs on the main thread.
metadata:
  type: project
  modified: 2026-09-19T22:46:00.000Z
---

The real fix for [[gridiron-boot-restart-loop]]. PR state and caveats:
[[gridiron-boot-restart-loop-fixes]].

**The change is small.** `runJobOffThread(name, timeoutMs)` already runs ANY job
by name with no restructuring: `job-worker.js` imports `scheduler.js` in the
worker and calls that job's own `run()`. So the boot path only needs an
`offThread` override threaded from `runIfStale` into `runJobNow`, where the
resolution was `job.offThread ?? job.tier === 'heavy'`.

**THE COST, which is the half that gets forgotten.** Each worker is a fresh
module graph plus its own SQLite connection — roughly a second per job on top of
a pass that already takes minutes. The pass stays SEQUENTIAL, one worker at a
time and never twenty at once, and that is deliberate: **this machine has been
OOM-killed before** ([[gridiron-fly-ingestion-limits]]), and twenty concurrent
module graphs is the obvious way to reintroduce it. Anyone tempted to
parallelise the boot pass for speed should read that first.

**The audit's rule.** A worker gets a fresh module graph, so it can only LOSE
cached state, never corrupt it — losing a memo means redoing a query. The one
dangerous shape is state used as PERSISTENCE: a value held only in memory, used
to compute a delta or a coverage decision that is then written. In a worker that
starts empty every run.

**Swept and clean, 2026-09-19** — every module the 20 boot jobs reach, plus
`nfl_model_growth`'s whole ingest path. `scheduler.js` itself has only four
module-level mutable bindings (`running`, `inFlight`, `timer`, `liveTimer`), none
of them job state. All the caches found are memos of a query:
`gamescript.js:356`/`:357`, `nfl-live.js:47` `_sigma`, `mlb-auto-picks.js:45`,
`report-cache.js:79` `inflight`, and `nfl-advanced.js:285` `_historicalAvailability`
/ `:304` `_weekCache`. **`nfl-model-growth.js` holds no module-level mutable
state at all**, so moving that job — the one that matters — is
behaviour-preserving.

**The exception: `book-feeds.js`, and it is a real one.**

- **`:122` `_directBookLastSeen`** is the binding one. `mergeQuotes` (`:426`)
  uses it to drop the aggregator's copy of a book that has its own direct feed,
  and the comment above it says it is deliberately shared ACROSS capture calls on
  different cadences, "so the fast/slow/extra jobs cannot double-write the same
  book as if it were two independent sources". Three separate workers each start
  with an empty map, so that is exactly what would happen — a data change, not a
  wasted fetch.
- **`:388` `_providerBackoff`** (and `book-feeds-extra.js:230`) is exponential
  backoff held only in memory. Empty in every worker means a failing provider is
  retried at full rate instead of backing off.

So `nfl_book_feeds_fast`, `_slow` and `_extra` are named in `MAIN_THREAD_ONLY`
and stay put. On the night's evidence none of the three is the blocker — all
completed and were skipped as not-due in the failing lives. Persisting both maps
is the follow-up that lets them move; it was NOT folded in, because it is
betting-side capture logic rather than scheduling, and a fix that quietly
changed which quotes get written would be the worse outcome.

Note this state is already lost on every process restart, so while the app is
looping it is worthless either way. The regression would be against a stable app.
