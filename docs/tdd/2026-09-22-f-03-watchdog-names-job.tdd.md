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

## Not proven by the suite

- The overflow path (more than 8 jobs marked at once, reported as
  `N more the marker had no slot for`) has no test. Today at most about four
  jobs can be running inline at once.
- The write order (name bytes first, then the length) is still unproven, as
  #97's own comment says.
- The scheduler wiring tests read `scheduler.js` as text. They check where the
  calls sit in the source. They do not run a job.
