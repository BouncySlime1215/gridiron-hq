# TDD evidence (retroactive): availability-capture restart guards, PR #41

**What this is.** PR #41 (`claude/project-thread-3xqh5l-baseline-fix`, on `main`
at `791b131`) fixes four ways `scripts/capture-availability-baseline.mjs` could
return a successful-looking capture that had measured nothing. The last two of
those — a capture that spanned a restart, and a restart inside a single slow
read — ship with ten tests in `test/capture-span-guard.test.js` against the
predicates in `scripts/lib/capture-span.mjs`. The tests were written alongside
the code and each was checked against the defect it names, but that checking
lived in the session only. This file is the record, in the retroactive form of
`docs/tdd/week2-numbers.tdd.md`.

**Why the script had no test before.** `capture-availability-baseline.mjs` is a
top-level-await module: it runs its capture on import and calls `process.exit(2)`
when no token is set. Nothing inside it could be exercised without going to the
network, which is how a script this load-bearing came to have no test at all.
The predicates were extracted to `scripts/lib/capture-span.mjs` for that reason
and for no other.

**How the retroactive RED was shown.** The code already works, so a test written
now passes at HEAD. Each test was therefore run against a mutated copy of the
source with one guarded rule reverted. A test that no mutation can fail proves
nothing. Ten mutations were run; every one of the ten tests is failed by at
least one, and every mutation is caught by at least one test. The source was
restored and verified byte-identical afterwards, and the suite re-run green.

Harness: `/tmp/claude-0/tdd/mutate.py` (session scratch, does not outlast the
session — the output below is pasted verbatim rather than referenced).

## The guarded rules

| # | Rule | Test |
|---|------|------|
| 1 | A capture whose derived process start moved by more than the tolerance spanned a restart | 1 |
| 2 | Two readings of one process disagree by seconds; that is jitter, not a restart | 2 |
| 3 | The boundary is the tolerance exactly, not near it | 3 |
| 4 | A failed health read is `known: false` and never claims one process | 4 |
| 5 | A capture with no span at all is unestablished, not clean | 5 |
| 6 | A process reporting less uptime than the request's own flight time did not answer that request | 6 |
| 7 | `uptime_s` is `Math.round`ed, so a one-second margin — but a `0` answering a 1.5s request is a real crossing, not rounding | 7 |
| 8 | A missing or non-numeric reading is never a crossing | 8 |
| 9 | A crossed read is a detection (`known: true`), not a failure to detect | 9 |
| 10 | A clean span states `crossed_restart: false` rather than omitting it | 10 |

Rule 9 is not hypothetical. The first version of this code had the crossed
check ordered after the `read` check, so a read whose own response proved a
restart was filed as "could not tell" — the opposite of what it had
established. Test 9 is what found it, before the commit.

Rule 7's second half is the one that looks like a false positive and is not.
`uptime_s: Math.round(process.uptime())` (`server/platform/health.js:45`) means
a reported `0` is a true uptime under half a second, so a `0` that answered a
1.5-second request really did start after the request was sent. `Math.round`
rather than `Math.floor` is load-bearing here.

## Mutation run, pasted verbatim

```
BASELINE (no mutation): pass 10, fail 0
M1  tolerance widened to ten minutes
    -> pass 9, fail 1 | caught by: test 1 (a restart in the middle of a capture is not a comparable capture)
M2  tolerance dropped to zero (no jitter allowance)
    -> pass 8, fail 2 | caught by: test 2 (round-trip jitter within one process is not a restart); test 10 (a clean bracket reports no crossing rather than leaving the field absent)
M3  span boundary comparison made strict
    -> pass 9, fail 1 | caught by: test 3 (the boundary is the tolerance, not somewhere near it)
M4  an unknown span claims one process
    -> pass 9, fail 1 | caught by: test 4 (a failed health read is unknown, never a pass)
M5  a missing span treated as clean
    -> pass 9, fail 1 | caught by: test 5 (a capture taken before this guard existed is unestablished, not clean)
M6  crossed-read comparison inverted
    -> pass 8, fail 2 | caught by: test 6 (a process younger than the request that reached it did not answer that request); test 7 (whole-second uptime rounding is not treated as a restart)
M7  the one-second rounding margin removed
    -> pass 9, fail 1 | caught by: test 7 (whole-second uptime rounding is not treated as a restart)
M8  non-numeric readings coerced instead of refused
    -> pass 9, fail 1 | caught by: test 8 (a missing or non-numeric reading is never a crossing)
M9  crossed check ordered after the read check
    -> pass 9, fail 1 | caught by: test 9 (a crossed read is a detection, not a failure to detect)
M10 crossed_restart omitted from a clean span
    -> pass 9, fail 1 | caught by: test 10 (a clean bracket reports no crossing rather than leaving the field absent)

SOURCE RESTORED BYTE-IDENTICAL: True
AFTER RESTORE: pass 10, fail 0
```

## One RED in full (M9, the ordering bug that actually happened)

Mutation: move the `crossed_restart` check in `processSpan` from before the
`!before?.read || !after?.read` branch to after it. A crossed read returns
`read: false`, so it then falls into the "could not tell" branch.

```
not ok 9 - a crossed read is a detection, not a failure to detect
  ---
  duration_ms: 1.065604
  type: 'test'
  location: '/home/user/gridiron-hq/test/capture-span-guard.test.js:105:1'
  failureType: 'testCodeFailure'
  error: |-
    a crossed read tells us a restart happened

    false !== true

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: 'strictEqual'
```

## Live readings the tests are built on

Not invented numbers. Taken against `https://gridiron-hq.fly.dev/api/health`
on 2026-09-19 while the app was restarting about every 160 seconds:

| issued | status | flight | `uptime_s` | verdict |
|--------|--------|--------|-----------|---------|
| 22:28:15Z | 200 | 23.4s | 65 | valid |
| 22:38:59Z | 200 | 29.1s | 13 | crossed |
| 22:44:04Z | 200 | 15.6s | 12 | crossed |
| 22:49:20Z | 200 | 23.3s | 19 | crossed |

And the confirmation that a crossed read's timestamp is still sound: 22:53:06Z
crossed (`uptime_s` 13 after 17.4s) and 22:54:06Z clean (`uptime_s` 57 after
0.35s) derived the same process start, 22:53:10Z, to the second.

## What is deliberately not covered

The two guards are tested; the capture script's wiring to them is not. Four
lines in `capture-availability-baseline.mjs` call `processIdentity()` at each
end and set the exit code, and exercising those still needs the network for the
same reason the script had no test before. The extraction moved the logic that
can be tested, not all of it.

## Is this well built? (the five questions, asked of this change)

Nick's standing rule, 2026-09-20: every PR body and evidence file answers these.

**1. Is it based on stats, or is it made up?** Two thresholds, and they are not
the same class.

- The **1-second rounding margin** in `readCrossedRestart` is definitional, not
  chosen: `server/platform/health.js:45` rounds `uptime_s` with `Math.round`, so
  a reported 1 can be a true 0.5. Change the rounding and this number changes
  with it.
- The **60-second `RESTART_TOLERANCE_MS`** was hand-set from latency
  arithmetic. It is now measured, against tonight's log
  (`/mnt/project-files/restart-health-log.tsv`, 152 reads at a 60-second
  cadence, 2026-09-19T22:53Z to 2026-09-20T01:24Z): 46 clean reads yielded 46
  distinct process starts, and all 45 consecutive pairs were **at least 177
  seconds apart** (median 180, max 376). A 60-second tolerance therefore cannot
  merge two real lives in this data — the margin is about 3x.

**2. How do we know?** 10 tests in `test/capture-span-guard.test.js`, each
killed by a distinct mutation (the run is pasted above); 4 live readings, also
above, three of them crossed reads taken while the app was cycling. The
mutation table is the load-bearing part: a test no mutation can fail proves
nothing, which is the standard `docs/tdd/week2-numbers.tdd.md` set.

**3. What is NOT known.** The tolerance is measured in one direction only. The
drift it exists to absorb — two clean reads of the *same* process disagreeing by
a few seconds — was **never observed tonight**, because the app never answered
two clean health reads inside one life. 46 clean reads, 46 different processes.
So the false-positive side of that threshold still rests on arithmetic, and the
number to re-measure once the app is stable is the drift between two clean reads
60 seconds apart in one life.

**4. Structure.** The predicates live in `scripts/lib/capture-span.mjs` rather
than in the capture script because the script is a top-level-await module that
runs on import and `process.exit(2)`s without a token, so nothing in it was
reachable from a test. Four wiring lines in
`scripts/capture-availability-baseline.mjs` still need the network and are named
under "What is deliberately not covered".

**5. Should this point anywhere else, and what would unify it?** Yes, and there
is a duplication to close. The crossed-read rule is not specific to the
availability capture: Fly's edge replays a held request into the machine that
comes up, so **every** read of this app can be answered by a process that did
not exist when the request was sent. The rule is currently implemented twice —
once in JavaScript at `scripts/lib/capture-span.mjs:40` and once in `awk` at
`restart-health-log.sh:49` — and the two agree only because they were written
from the same sentence. The unification is one predicate with one test, called
by both; the shell copy exists because the logger must survive this container
and cannot depend on the repo. That is a real constraint, not an oversight, so
the honest next step is a tiny Node one-liner the shell calls when the repo is
present and the `awk` fallback when it is not, with the fixture that already
covers the JavaScript side asserted against both.
