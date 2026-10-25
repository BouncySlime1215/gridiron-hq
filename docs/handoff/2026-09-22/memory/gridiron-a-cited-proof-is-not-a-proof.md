---
name: gridiron-a-cited-proof-is-not-a-proof
description: A test comment on gridiron-hq pointed at a proof in another file that did not exist; two sessions read it as cover. Injection caught it, reading did not.
metadata:
  type: feedback
  modified: 2026-09-20T01:45:00.000Z
---

**A comment that names where the real proof lives reads, to anyone checking,
exactly like the proof.** Verify the citation before you count it.

2026-09-20, in my own code. `watchdog-arming-sources.test.js` had a test called
"arming that arrives before the watchdog starts is not lost" whose body only
asserted that starting after an early arm does not throw. Its comment said:
"the observable proof is in the child-process test in loop-watchdog.test.js".
**There was no such test.** That file contained no reference to
`armLoopWatchdog` or `armedEarly` at all.

I wrote it, I reviewed it, and the wiring-map thread reviewed it. Both of us
read the comment and moved on. What caught it was deleting the guarded line
(`if (armedEarly) { Atomics.store(cell, 1, 1); armedEarly = false; }` in
`startLoopWatchdog`) and running the suite: **6 pass, 0 fail.** The rule was
unguarded and the test that named it could never have failed.

**Why it mattered here**: that replay is what keeps an arm issued before
`app.listen` — `startScheduler` calls `onBootComplete` synchronously under
`SCHEDULER_DISABLED=1` — from being dropped. With PR #56 also stopping Fly's
health probe from arming the watchdog, an app nobody visits would never be
armed again and a wedge would be permanent. Worse than the bug it started from.

**How to apply.**
- Counting coverage by reading test names or comments counts the wrong thing.
  The only number that means anything is rules with an injection that was RUN
  and FAILED, at the current tip, not described and not quoted from earlier.
- When a test's comment defers to another file, open that file and grep for
  the symbol. A deferral is a claim.
- Report the honest denominator. Mine was 16 of 32 when asked, and saying so
  is what produced the fix. See [[gridiron-author-is-the-worst-reviewer]] and
  [[verify-the-consumer-not-the-producer]].
- A control test is a legitimate exception: its only possible mutation is of
  its own fixture. Name it as a control rather than padding the count.
