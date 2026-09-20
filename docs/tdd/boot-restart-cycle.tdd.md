# TDD evidence: boot-restart-cycle (PRs #56, #59, #61)

Source: the live app restarting in a loop after the 2026-09-19 release (main at
791b131), found while auditing whether the scheduler keeps the app's fantasy data
current without anyone forcing jobs by hand. Nothing was deployed, no live
database was written, and no job was run against production. LLM spend: $0.

Line numbers below are at the tip of this stack (`7534ff1`) unless a row names
another ref; `main` at 791b131 is what was deployed and measured.

Runner (every JS command below):

    NODE_OPTIONS='--import ./test/offline-guard.mjs' node --experimental-test-module-mocks \
      --test --test-concurrency=1 <file>

Full suite is the same command over `test/*.test.js`. Run `npm ci` first — a
fresh clone fails the offline-guard tests with `ERR_MODULE_NOT_FOUND` and it
looks exactly like a regression.

## THIS FILE DOES NOT HAVE RED COMMITS, AND THAT IS THE POINT

Every other evidence file in this directory records a RED commit before a GREEN
one, because the work started from a specification. This one did not. It started
from a machine that was already broken in production, and the diagnosis came
from measuring it from outside rather than from a failing test. Writing a RED
commit afterwards would have been theatre: a test written to fail against code
already known to be wrong proves only that the author can write such a test.

So the RED evidence here is **defect injection against the shipped code**, which
is this project's own standing rule ("test every checker against a deliberately
broken copy"). Each row below is a real edit to the merged source, the exact
test output it produced, and a restore. That is a stronger claim than a RED
commit, because it proves each test fails for the specific reason it exists —
not merely that it failed once, at some point, against something.

## The measurement

`/api/health` polled continuously from outside, 22:16Z to 22:35Z on 2026-09-19.
The last `uptime_s` served before each dark window, over seven consecutive
lives of the process:

    95   97   93   91   94   88

and the next probe, 10 to 30 seconds later, dark every time. The app served for
about 100 seconds, went dark for about 60 — the #29 watchdog's own threshold,
which is what distinguishes this from an instantaneous OOM kill — and came
back. Starts about 160 seconds apart.

The block therefore begins at boot plus roughly 90 seconds, every life, never
at 66 seconds where the boot chain finishes and never scattered. The only thing
scheduled at boot+90s in the whole process is the `nfl_model_growth` timer —
`scheduler.js:1751` on `main` at 791b131, `:1948` at the tip of this stack — a
flat `Math.max(90000, bootDelayMs + 60000)` with `bootDelayMs` 20000.

## Discover -> audit -> decide

| System | What the audit found | Decision |
|---|---|---|
| `nfl_model_growth`'s delayed timer (`:1751` on `main` at 791b131) | `tier: 'growth'`, no `offThread`, so it ran on the request thread. `node:sqlite`'s `DatabaseSync` is synchronous, so its ingest blocks every HTTP response, not just its own. Two steps inside it block: `nfl-model-growth.js:194` `syncSnaps` writes a whole prior season in one `BEGIN`/`COMMIT` with no yield (`nfl-advanced.js:199-200`), and `:197-198` `syncVerifiedEventArchive({ includeWeeklyRosters: true })` inserts per row in nested synchronous loops with no `BEGIN` anywhere in `nfl-event-archive.js` (grepped), so autocommit per row. The file has no module-level mutable state. | **Re-engineer the invariant, not the job**: nothing on the boot path runs on the request thread unless it is named with a reason. PR #59. |
| `DEFAULT_JOB_TIMEOUT_MS` (`:1438` on `main` at 791b131, `:1520` here) | 120,000 ms against a 60,000 ms watchdog fuse: the budget is twice the thing that actually fires. And `withJobTimeout` (`:1448` there, `:1616` here) is a `Promise.race`, which cannot interrupt synchronous work at all. | **Leave the number alone and say why.** Lowering it would read as a guard while guarding nothing. Recorded in the code and in #59's body. |
| `record()` (`:79`) | Runs only after `job.run()` returns, so a job that kills the process records nothing — not an error, not a timestamp. The live read showed `consecutive_failures` stuck at **1** across all seven lives rather than climbing: not a job failing repeatedly, a job whose failure was never recorded once. Every guard in the file (`nextDueMinutes`' backoff, `confidence()`'s 0.1 floor, the diagnostic's erroring list) is downstream of a recorded outcome, so all of them are blind to it. | **Build new**: record the attempt, not only the outcome. PR #61. |
| `watchdogArmingMiddleware` | Armed on the first completed HTTP response of any kind. `fly.toml` polls `/api/health` every 15s, so on the deployed machine the first completed response is the platform's own probe, about 15s after `listen` and before the boot work starts. Circular, too: `/api/health` answers exactly when the loop is turning, which is the thing being measured. | **Extend**: exclude the liveness path by equality, and arm from the boot pass instead. PR #56. |
| `book-feeds.js` | `_directBookLastSeen` (`:122`) and `_providerBackoff` (`:388`) are module state deliberately shared between the fast, slow and extra jobs, so a worker's fresh module graph would silently double-write a book as if it were two sources. | **Named, not moved.** Three jobs stay on the request thread in an allow-list carrying that reason. Persisting the state is a follow-up, and it is betting-side. |
| The background tier's own call (`tier()` pass) | `runIfStale(j)` with NO override, every 5 minutes. `resolveOffThread` then falls back to `job.offThread ?? job.tier === 'heavy'`, which is false for a growth job — so `nfl_model_growth` would have gone straight back onto the request thread the first time its 6-hour cadence came due on a machine that stayed up. Found by auditing every job's tier and flag rather than by assuming the boot fix covered it. **A fix that only holds until it succeeds is not a fix.** | **Extend**: `offThread: true` on the job itself, with the reason written next to the flag. PR #62. |
| `tier()` (`:1972` here) and `fly.toml` | `setInterval` only, no leading call, so the first background pass is at t+300s. On lives of 160 seconds it never fired at all, which is why every growth, metered and heavy job had run zero times on this build. `auto_stop_machines = false`, `min_machines_running = 1`, so the machine is not being idle-stopped. | **No change.** Correct behaviour on a stable box; its zero-runs-ever is the restart cycle and nothing else. Recorded so nobody re-derives it. |

## RED -> GREEN, by defect injection

Each row: the edit made to the merged source, the test output, then restore.
Re-run in full at 23:20Z on 2026-09-19 against the tip of this stack, rather
than quoted from when each change was written.

| PR | Injected defect | Result |
|---|---|---|
| #56 | `loop-watchdog.js`: delete `if (req.path === LIVENESS_PATH) return next();` | `watchdog-arming-sources` 5 pass, 1 fail — "the host's liveness probe does not arm the watchdog" |
| #56 | `index.js`: drop `onBootComplete: armLoopWatchdog` from the `startScheduler` call | 5 pass, 1 fail — "the scheduler arms the watchdog when its boot pass finishes" |
| #59 | `scheduler.js`: delete `if (override != null) return override;` from `resolveOffThread` | `boot-override-off-thread` 1 pass, 2 fail; `boot-path-off-thread` 5 pass, 2 fail. **The control test still passes**, which is the whole reason the runtime pair exists: it measures real event-loop lag, so it distinguishes an override that is threaded through from one that is threaded through and then dropped. |
| #59 | `scheduler.js`: `runIfStale('nfl_model_growth', { offThread: true })` -> `runIfStale('nfl_model_growth')` | `boot-path-off-thread` 6 pass, 1 fail — "the two delayed boot timers run off-thread too" |
| #61 | `scheduler.js`: delete the `recordStart(name)` call | `abandoned-run-backoff` 7 pass, 2 fail |
| #61 | `recordStart` stamps `last_run_at` as well | 8 pass, 1 fail — the freshness assertion. A marker that advances that column makes a job which has produced nothing read as freshly synced for as long as it runs. |
| #61 | reaper sets `consecutive_failures = 1` instead of `+ 1` | 8 pass, 1 fail — "the second kill backs off further than the first" |
| #61 | reaper dates the attempt with `nowIso()` instead of the marker's start time | 8 pass, 1 fail — the backoff would be computed against an hours-old timestamp and would never bite |
| #61 | move `reapAbandonedRuns()` below the `SCHEDULER_DISABLED` early return | 7 pass, 2 fail — both ordering tests |
| #62 | `scheduler.js`: remove `offThread: true` from the `nfl_model_growth` JOBS entry | `timer-tier-off-thread` 3 pass, 1 fail — "the measured blocker runs off-thread with no override in sight" |
| #62 | flag `nfl_book_feeds_fast` off-thread while leaving it allow-listed as main-thread-only | 3 pass, 1 fail — the two would disagree about which path wins |
| #62 | strip the comment explaining why the flag is needed | 3 pass, 1 fail — the next reader needs to know the boot override does not cover this entry |

## Test specification

| File | Tests | What it pins |
|---|---|---|
| `test/watchdog-arming-sources.test.js` | 6 | The liveness probe arms nothing; an ordinary request does; a path that merely begins with the same characters does; an arm arriving before `startLoopWatchdog` is not lost; the scheduler wires `onBootComplete` and calls it in a `.finally`; `LIVENESS_PATH` equals the path `fly.toml` actually probes. |
| `test/health-route-single.test.js` | 3 | Existing. De-brittled: the assertion carried a line number, so any edit above the route broke it. Now matches file and path only, and was re-checked against a real duplicate registration. |
| `test/boot-path-off-thread.test.js` | 7 | The budget really does exceed the fuse; every boot job is off-thread or allow-listed with a reason; every boot name is a real job; the boot pass and both delayed timers pass the override; `resolveOffThread` precedence; the allow-list holds exactly the three book-feeds jobs. |
| `test/boot-override-off-thread.test.js` | 3 | Runtime, not source-shaped: measures event-loop lag while a job runs. A live-tier job without the override blocks the loop (control); the same job with it leaves the loop responsive; an explicit `offThread: false` keeps a heavy job inline. |
| `test/timer-tier-off-thread.test.js` | 4 | The measured blocker resolves off-thread with no override; the tier pass still passes none, so the job flag is the only thing deciding; a job cannot be both allow-listed as main-thread-only and flagged off-thread; the reason lives next to the flag. |
| `test/abandoned-run-backoff.test.js` | 9 | A job in flight is marked without being made to look fresh; a completed run leaves no marker; an abandoned run is recorded as the failure it was, dated by its start; the boot after a kill does not re-start the job; a second kill backs off further; recovery clears it; the reap happens before both the brake and the boot pass. |

Full suite at the tip of the stack: **2975 tests, 0 fail, 41 skipped.** Lint,
typecheck and `npm run start:smoke` clean.

## What this stack does NOT do

- It does not deploy. Nothing here has run against the live machine.
- It does not fix the three book-feeds jobs, which keep the hazard by name.
- **42 jobs still run on the request thread**, counted at the tip of the stack:
  23 live-tier (short, keyless and fast by design, the three book-feeds jobs
  among them), 13 growth and 6 metered. Only `nfl_model_growth` has been
  measured blocking past the fuse, and only it has been audited for module
  state, so only it was moved. Moving the rest needs the same per-module audit
  that named the three book-feeds jobs; guessing would trade a measured fault
  for an unmeasured one. The census itself is the useful part: 62 jobs, every
  one in a real tier, none orphaned, and no job whose cadence is shorter than
  the tick that drives it.
- It does not change the 120s-vs-60s budget mismatch, deliberately.
- `NFL_SEASON` in `fly.toml` is a separate change on its own branch off `main`,
  not part of this stack.
