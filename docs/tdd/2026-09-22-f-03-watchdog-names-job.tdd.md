# F-03 — the loop watchdog names the job it killed

PR #97, branch `claude/project-thread-o3wt2p-watchdog-names-job`.

## Why

On 2026-09-22 the watchdog killed a real-data local server twice with
`the event loop has not turned for 62s ... being killed` and did not say which
job was blocking. The culprit, `nfl_decision_ledger`, showed up only in the
next boot's `did not report back` line. The kill line has to name the running
job or jobs, or say plainly that no job was running when a request path
blocked the loop.

## Audit of #97 as it stood (`c5603079`)

- Merged `origin/main` (`7a9d75f6`) into the branch with no conflicts
  (merge commit `2fd994f6`).
- #97 adds a shared-memory job marker the watchdog worker reads while the main
  thread is blocked. The scheduler marks each job before running it and clears
  it in a `finally`. #97 already has a test for the case where no job is marked.
- **Gap found:** the marker had **one** slot, and `clearJobRunning()` cleared it
  without checking which job's name was in it. The live tier and the background
  tier run on separate `setInterval` timers (`server/services/scheduler.js`,
  `tier(...)`), and two boot one-offs run beside them. So jobs overlap. When job
  B finished while job A was still running, B's clear erased A's name, and the
  kill line said "No job was marked as running" while A held the thread. The
  "no job" line then pointed the reader at the request path, which was the
  wrong suspect. That false no-job report is the step-4 case, so it was fixed
  test-first.
- **Second gap:** off-thread jobs were marked too. A worker-thread job cannot
  block the main thread. If a request path blocked the loop while one was
  running, the kill line would have named that worker job.
- The worker had a bare `catch { return null; }` around a non-fatal
  `TextDecoder.decode`. That call cannot throw, so the catch could only hide a
  bug. It was removed.

## RED / GREEN

| | commit | subject |
|---|---|---|
| RED | `4471806f` | test: RED - the kill line names every running job, and clearing one leaves the rest |
| GREEN | `47a95944` | fix: GREEN - the kill line names every running job, and clearing one leaves the rest |

The RED commit failed 5 of 14 tests across `test/loop-watchdog.test.js` and
`test/watchdog-job-marker.test.js`. Its headline failure was the bug itself:

```
not ok 9 - a job that finishes does not erase the name of one still running
  the still-running job must be named; got: [watchdog] the event loop has not
  turned for 1s (threshold 1s). No job was marked as running. The process is
  serving nothing, so it is being killed ...
```

GREEN: 14/14 in those two files, and 68/68 with `test/scheduler*.test.js`
added.

One test-side change needs flagging. `watchdog-job-marker.test.js` previously
asserted the literal `clearJobRunning()`. It now asserts
`clearJobRunning(name)`. The old assertion encoded the bug: clearing without a
name is what erased the other job's marker.

## Liveness

These ran in a scratch worktree, never on the branch.

1. **#97's own test on the unfixed code.** Only
   `server/platform/loop-watchdog.js` was reverted to `origin/main`. Then
   `the kill line names the job that was running` failed:
   `expected: 'SIGKILL'` — the child died with `SyntaxError: The requested
   module '../../server/platform/loop-watchdog.js' does not provide an export
   named 'markJobRunning'`. That proves the test is live, though it fails at
   the import, not at the wording.
2. **The same test, with only the worker reverted.** It failed on the content
   assertion itself: `the kill line must name the marked job; got: [watchdog]
   the event loop has not turned for 1s (threshold 1s). The process is serving
   nothing, ...`
3. **On the branch**, both files pass (see GREEN).

Mutants, run on the GREEN tree:

| Mutant | Killed by |
|---|---|
| M1: the kill line drops the job names (`jobSentence({ names: [], more: 0 })`) | 3 tests: names the job; does not erase; names every job |
| M2: `clearJobRunning` ignores its argument and wipes every slot (the #97 behaviour) | `a job that finishes does not erase the name of one still running` |
| M3: the scheduler marks off-thread jobs too | `an off-thread job is not marked, because it cannot block this thread` |

## Not proven by the suite (round 1; superseded by round 2 below)

- The overflow path (more than 8 jobs marked at once, reported as
  `N more the marker had no slot for`) has no test. Today at most about four
  jobs can be running inline at once.
- The write order (name bytes first, then the length) is still unproven, as
  #97's own comment says.
- The scheduler wiring tests read `scheduler.js` as text. They check where the
  calls sit in the source. They do not run a job.

## Round 2: skeptic findings on `a4e938ad`

Two independent skeptics reviewed head `a4e938ad` (tree `0993835d`) and found
three blocking issues. All three are fixed below. Every test run in this
section used Node 25.9.0, targeted test files only, and
`SCHEDULER_DISABLED=1 GRIDIRON_DB_PATH=<mktemp> NODE_OPTIONS='--import ./test/offline-guard.mjs'`.
They ran in the local worktree `/Users/nick_matta/gridiron-local/wt/verify-97-fix`,
except RED and the mutation sweep, which each ran in a scratch worktree
checked out at the commit named.

| # | Skeptic finding | Fix |
|---|---|---|
| 1 | Unit mutant U7 survived: a `clearJobRunning` that ignored its argument and cleared the most recently marked slot passed all 10 tests in `test/loop-watchdog.test.js`. Only reverse-order finishing was tested. | New test: the job marked first finishes first, and the other job stays named. |
| 2 | Call-site mutant C3 survived: `if (offThread) clearJobRunning(name)` (inline runs never cleared) passed all 4 wiring tests, which read `scheduler.js` as text. No test ran a scheduler job under the watchdog. | The four text tests are replaced by behavioural tests that run jobs through the real `runIfStale -> runJobNow` path in a child process that the real watchdog kills. |
| 3 | After a timeout, the kill line blamed a request path, or it named the wrong job. | Implementation fix, test-first (below). |

### The defect (finding 3), cited on `a4e938ad`

- `withJobTimeout` (`server/services/scheduler.js:1773`) is a `Promise.race`.
  At the budget it stops waiting for the job. It does not stop the job, whose
  code carries on on the main thread.
- `runJobNow` cleared the marker in its `finally`
  (`server/services/scheduler.js:1980-1986`, `clearJobRunning(name)` at
  `:1985`) as soon as that race settled.
- So when an abandoned job's code later blocked the loop, the kill line either
  printed "No job was marked as running on this thread, so the block came from
  outside the scheduler -- a request path, most likely", or it named only
  whichever job the tier had started next.
- This path is real. `scheduler.js:1386` records `evidence_daemon` on the
  deployed app with 29 runs, every one "exceeded its 120s budget and was
  abandoned", and `:1426` records `nfl_reports` with the same error. Both
  have since moved off-thread. `nfl_decision_ledger`, the job behind the
  2026-09-22 kills that started F-03, still runs inline on the default
  budget. The skeptic's `ledger.mjs`, run on `08d8d35e`, printed
  `{"tier":"growth","offThreadFlag":null,"timeoutMs":"default 120000","resolveOffThread_timerPath":false}`.
- The incumbent, reproduced on `a4e938ad` with the skeptic's probe
  (`node probe.mjs <worktree> timeout`): exit 137, and the kill line read
  `No job was marked as running on this thread, so the block came from outside the scheduler -- a request path, most likely.`

### The fix

- `server/platform/loop-watchdog.js`: a slot now belongs to one run, not to a
  job name. `markJobRunning(name)` returns a handle. `clearJobRunning(handle)`
  clears that run only. The new `markJobAbandoned(handle)` records when the
  budget gave up on the run, on the heartbeat's clock. `JOB_SLOTS` goes from 8
  to 16, because abandoned runs now keep their slot longer. Sixteen is a
  hand-set guess.
- `server/platform/loop-watchdog-worker.js`: an abandoned run is printed as
  `'X' (abandoned at its budget Ns ago, still running)`. The age lets a reader
  tell a job that has just blocked from one that has been stuck on a network
  read for hours. The no-job sentence now says that an abandoned job stays
  marked, and it hedges its inference with "most likely".
- `server/services/scheduler.js`: `inlineRunMarker` holds the marker for two
  holders, the job's own promise and runJobNow's bookkeeping. It clears only
  when both are done. `withJobTimeout` calls `onAbandon` before it rejects.
  `job.run()` is wrapped in `new Promise` so that a synchronous throw still
  settles the promise the marker holds on to.

### RED / GREEN

| | commit | subject |
|---|---|---|
| RED | `d5795deb` | test: RED - an abandoned inline job stays named until its own code returns |
| GREEN | `29844ea1` | fix: GREEN - an abandoned inline job stays named until its own code returns |
| pin | `08d8d35e` | test: a job that throws before returning a promise is not named by a later stall |

RED on `d5795deb`, whose `server/` is identical to `a4e938ad`
(`git diff --stat a4e938ad d5795deb -- server/` is empty): 16 of 19 pass and 3
fail across `test/loop-watchdog.test.js` and `test/watchdog-job-marker.test.js`.
All three fail on the kill line itself:

```
not ok 16 - a job abandoned at its budget is named when its own code blocks, and a finished job is not
  the abandoned job's code is what blocked, and it must be named as abandoned; got: [watchdog] the event
  loop has not turned for 1s (threshold 1s). No job was marked as running on this thread, so the block
  came from outside the scheduler -- a request path, most likely. ...
not ok 17 - a job abandoned at its budget is named beside the job the tier moved on to
  got: [watchdog] ... The job running when it stopped was 'synthetic_bystander'. ...
not ok 18 - a re-run of an abandoned job does not erase the copy that is still running
  got: [watchdog] ... No job was marked as running on this thread, so the block came from outside ...
```

RED was run three times. The first draft failed the same three tests for an
unrelated reason: the child exited with code 13, because nothing ref'd kept
its event loop alive while it waited. The fixture now holds an interval open,
the way a server's socket does. The second run failed on the kill line. The
third run came after the one assertion change (the label gained "Ns ago"),
and the result above is from that run.

GREEN: on `29844ea1`, 20 of 20 in the two watchdog files. On `08d8d35e`, the
marker file passes 9 of 9 with the synchronous-throw case added.

### Liveness: mutants

The sweep ran on `08d8d35e` (tree `f9b26243`). Each mutant ran against both
watchdog test files (21 tests). A spec had to match its target text exactly
once, or it was refused rather than run. The harness restored every file
after each mutant, and `git status --porcelain` was empty after the sweep.
The U and W rows mutate the unit. The C rows and M3 mutate the call site in
`scheduler.js`.

| Mutant | What it changes | Result | Killed by |
|---|---|---|---|
| U7 | `clearJobRunning` ignores its handle and frees the most recently marked slot (skeptic U7) | killed, 1 fail | the first-marked job finishes first |
| U5a | a run with no slot is never counted (skeptic U5) | killed, 1 fail | runs beyond the last slot are counted |
| U5b | a cleared run with no slot is still counted | killed, 1 fail | runs beyond the last slot are counted |
| U-name | slots keyed by job name again | killed, 1 fail | a re-run of an abandoned job |
| U-abandon | `markJobAbandoned` stores nothing | killed, 3 fail | the three abandoned-job tests |
| W-flag | the worker ignores the abandoned cell | killed, 3 fail | the three abandoned-job tests |
| W-names | the kill line drops every name (round 1's M1) | killed, 10 fail | every test that expects a name |
| C3 | runJobNow never releases an inline run (skeptic C3) | killed, 5 fail | returned, threw, threw before a promise, abandoned-then-next, re-run |
| C-old | the marker clears when runJobNow finishes: the `a4e938ad` behaviour | killed, 3 fail | the three abandoned-job tests |
| C-flag | `withJobTimeout` is not given `onAbandon` | killed, 3 fail | the three abandoned-job tests |
| C-sync | `Promise.resolve(job.run())` instead of `new Promise(...)` | killed, 1 fail | threw before returning a promise |
| M3 | off-thread runs are marked too (round 1's M3) | killed, 1 fail | an off-thread job in flight |
| C-late | the mark is written a microtask after `job.run()` is called | killed, 1 fail | blocks before its first await |
| S1 | designed survivor: the name length is stored before the name bytes | survived, 21 pass | nothing, by design: the write order is untested |
| N1 | not-applied control: the skeptic's literal C3 target, `clearJobRunning(name);` | refused, 0 matches | not run |

The skeptics' recorded runs on `a4e938ad` show why the new tests were
needed: U7 passed 10 of 10 in `test/loop-watchdog.test.js`, and C3 passed 4
of 4 in the old `test/watchdog-job-marker.test.js`.

### The skeptics' own commands, on the fixed tree

Each command below ran on `08d8d35e` (tree `f9b26243`) with its own temporary
database. The kill line is shown from its job sentence onward.

| Command | Exit | Kill line |
|---|---|---|
| `probe.mjs <wt> timeout` (abandoned, then blocks) | 137 | The job running when it stopped was 'f03_probe_abandoned' (abandoned at its budget 1s ago, still running). |
| `probe.mjs <wt> done` | 137 | No job was marked as running on this thread, and a job abandoned at its budget stays marked until its own code returns, so the block most likely came from outside the scheduler, such as a request path. |
| `probe.mjs <wt> threw` | 137 | the same no-job sentence |
| `probe.mjs <wt> job-blocks` | 137 | The job running when it stopped was 'f03_probe_wedge'. |
| `kill.mjs B` | 137 | The job running when it stopped was 'synth_abandoned' (abandoned at its budget 2s ago, still running). |
| `killC.mjs` (scenario C) | 137 | The jobs running when it stopped were 'synth_c_culprit' (abandoned at its budget 2s ago, still running), 'synth_c_bystander'. |
| `reap.mjs` after `killC.mjs` | 0 | `{"reaped":["synth_c_bystander"]}`, unchanged (see "Not covered") |
| `watchdog-subject.mjs 1000 4000 served '+nfl_decision_ledger,+player_rosters,-nfl_decision_ledger'` | 137 | The job running when it stopped was 'player_rosters'. |

On `a4e938ad`, my own `probe.mjs timeout` run printed the no-job sentence
that blames a request path. The skeptic recorded the same sentence for
`kill.mjs B`, and 'synth_c_bystander' alone for `killC.mjs`. RED reproduces
both failures through the test suite.

### Regression checks on `08d8d35e` (tree `f9b26243`)

- Every test file that imports `scheduler.js` or `loop-watchdog.js` (25
  files, from `grep -lE 'services/scheduler\.js|platform/loop-watchdog' test/*.test.js`),
  plus the two watchdog files that reach the code through fixtures, with
  `--test-concurrency=1`: 27 files, 303 tests, 303 pass, 0 fail.
- `node scripts/wiring-map.mjs --check`: exit 0, "no missing-feed findings".
- `node --check` on every changed file: clean.
- `npm run check` was not run here: the 8 GB machine rule allows targeted
  tests only. CI runs the full check on Node 22 against the pushed head.

### Test-side changes, flagged

- `test/watchdog-job-marker.test.js`: all four text tests were replaced.
  1. "the marker is cleared in a finally" required `clearJobRunning(name)`
     inside runJobNow's `finally`. That placement IS the defect: it clears the
     marker while an abandoned job is still running. This test was wrong.
  2. "marks the job as running before it runs it" checked the source order.
     Replaced by "blocks the loop before its first await is named", which
     kills a mark written after the job has started (mutant C-late).
  3. "an off-thread job is not marked" matched one exact line of source.
     Replaced by a run of a real worker job in flight while the main thread
     blocks (kills M3).
  4. "both marker functions are imported" is covered by every behavioural
     test, since the scheduler cannot load without the import.
- `test/fixtures/watchdog-subject.mjs`: marker steps keep the run handle and
  clear by handle, because `clearJobRunning` now takes one. No assertion in
  `test/loop-watchdog.test.js` changed.
- The no-job sentence changed. The existing test's assertions
  (`/No job was marked as running/`, `/outside the scheduler/`) still hold, and
  they were not edited.

### Nick's five questions (round 2)

1. **Well built?** Each run gets its own shared-memory slot and handle, so two
   copies of one job and out-of-order finishes cannot erase each other. The
   marker is released only when the job's own promise has settled and
   runJobNow's bookkeeping is done. Nothing new runs on the request path. The
   cost is one small handle and one extra promise callback per inline run.
2. **Stats or made up?** Neither. The line reports what the scheduler marked.
   One hand-set constant: `JOB_SLOTS = 16`, a guess.
3. **How we know:** child processes are blocked and then SIGKILLed by the real
   watchdog, and the tests read the kill line from their stderr. RED fails on
   the unfixed code. See the mutant table for which mutants die and which
   survive by design.
4. **Pointed anywhere else?** It changes the watchdog's log line, the marker
   API (used only by `scheduler.js`), and runJobNow's marker lifetime. It
   touches no routes, schema or data. Job scheduling and timeouts behave as
   before.
5. **How it unifies:** the kill line is the one producer of "which jobs were
   running when the loop stopped", and it now covers abandoned runs, which
   `sync_log` records as finished errors.

- **Defect fixed:** `server/services/scheduler.js:1980-1986` on `a4e938ad`
  cleared the marker when the budget's race settled, not when the job
  returned.
- **Incumbent, by command:** `node probe.mjs <worktree@a4e938ad> timeout` →
  the no-job line blaming a request path, for a stall caused by the abandoned
  job.
- **Not covered:**
  - The next boot's reaper (`reapAbandonedRuns`, `server/services/scheduler.js:157`
    on both `a4e938ad` and `08d8d35e`) names only jobs whose `sync_log` row
    still says `running`. An abandoned job has
    already recorded `error`, so the reaper never names it. On the skeptic's
    scenario C it names the bystander. The kill line is the only place that
    names the abandoned job.
  - Work a job starts and never awaits (a detached promise or timer) is not
    marked. A stall inside it gives the no-job line, which is why that line
    says "most likely".
  - When several runs are in flight, the line lists all of them. It cannot
    tell which one holds the thread.
  - `runIfStale`'s in-flight guard (`server/services/scheduler.js:1892` on
    `08d8d35e`) still lets a job start again beside its abandoned copy,
    because the guard ends when the budget gives up. That is older than this
    PR. The overlap is now named
    correctly, but it is not prevented.
  - The write order (name bytes first, length last) is still untested
    (mutant S1 survives by design).
- **What would make it wrong:**
  - A job whose promise settles before its synchronous work is done (it
    resolves early and keeps working in a callback) would be cleared too
    soon.
  - An abandoned run that never returns stays named in every later kill line.
    The "Ns ago" age is there so that it reads as a leftover.
  - More than 16 runs in flight lose their names. They are still counted.
