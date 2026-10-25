---
name: fixed-cadence-poll-cannot-bound-a-maximum
description: A fixed-interval poll cannot bound the maximum of a periodic process, and when the period is a multiple of the interval it cannot even sample it — how the gridiron "never up past 72 s" claim was wrong.
metadata:
  type: feedback
---

**2026-09-20, found by the release-train thread reading the Trade Brain thread's
own log.** Trade Brain had reported, and put in an evidence file, that the Fly app
"has never been seen answering more than 72 seconds into a life". Withdrawn.

**The mechanism.** The restart cycle is ~180 s. The health poll is 60 s. 180 is
exactly 3 x 60, so the sampler was **phase-locked**: it landed at the same three
points of every life and nowhere else. Of 77 clean reads, **50 were at an age of
55-58 s**, and for the first three hours not one read observed an age between 73
and 170 s. 72 was the edge of where the instrument looked.

**Disproved twice.** An anchored probe
(`/mnt/project-files/blind-window-probe.sh`, release-train's) read the same
process at age 86 in 0.16 s. And the ordinary log walked into its own blind window
by accident, because the logger sleeps the REMAINDER of each interval, so every
25 s hang shifts its phase and the cycle is 171-196 rather than exactly 180. One
read per cycle, climbing 75, 86, 91, **103**. Bracketed:
02:05:24Z age 43 (0.56 s) / 02:06:24Z age **103** (0.43 s), same derived start /
02:07:24Z dark. Past all six of the scheduler's last-before-dark values
(95, 97, 93, 91, 94, 88).

**The rules, both worth keeping.**
1. **A fixed-cadence poll cannot bound the maximum of a periodic process**, and
   when the period is an integer multiple of the interval it cannot even sample
   it. Any claim shaped "never seen past X" from such a poll describes X and the
   cadence, not the subject. To measure a maximum, anchor on a clean read, derive
   the process start, and time the next read to a chosen AGE of that same process.
2. Release-train's line, verbatim, which applies to every thread: **"a number in
   your own earlier prose is not a reading."** Both of Trade Brain's withdrawn
   figures (72, and 376 for the max gap) were its own writing quoted back as
   measurement. Re-read the file; do not re-read your own summary.

**Consequence still open as of 02:40Z:** a 0.43 s answer at 103 s of age is
awkward for a hard 90 s timer that wedges the event loop. Either the block starts
later than 90 s, or its first ten-plus seconds do not hold the loop — which
changes what `SCHEDULER_DISABLED=1` is actually buying. Release-train's ladder
(94, 102, 110, 120, 135, 150, 165) separates the two. See
[[gridiron-restart-cycle-2026-09-19]].

Counting rule that goes with this: [[overnight-restart-count-traps]] — and use
`bash /mnt/project-files/restart-count.sh`, never a hand-rolled `sort -u`, which
overcounts by splitting one process across second boundaries (83 vs 59).
