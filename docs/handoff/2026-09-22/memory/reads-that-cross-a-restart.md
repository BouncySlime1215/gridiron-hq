---
name: reads-that-cross-a-restart
description: A read of the Fly app can be answered by a process that did not exist when it was sent; how to detect it from one response, and why a 5-minute log cannot count 160-second restarts.
metadata:
  type: reference
---

## One read can prove its own validity

Fly's edge holds a request against a machine going down and replays it into the
machine that comes up. So a read issued before a restart is answered after one,
**with a 200 and nothing in the body to say so**.

The tell: if the process reports less uptime than the request spent in flight,
it did not exist when the request was sent. Live examples 2026-09-19:
- issued 22:38:59Z → 200, `uptime_s` 13, after 29.1 s. **Crossed.**
- issued 22:44:04Z → 200, `uptime_s` 12, after 15.6 s. **Crossed.**
- issued 22:28:15Z → 200, `uptime_s` 65, after 23.4 s. Valid.

Implemented as `readCrossedRestart(uptimeS, elapsedMs)` in
`scripts/lib/capture-span.mjs` (PR #41). Margin is 1 s because `uptime_s` is
rounded to whole seconds at `server/platform/health.js:45`. A shell logger sees
the same thing more simply: **derived start later than the request's own
timestamp** means crossed.

**VOID FOR CONTENT, VALID FOR TIMELINE.** A crossed read cannot be attributed
to the process that was there when it was sent, so a capture must discard it.
But `uptime_s` on that response IS the new process's uptime at answer time, so
the derived start is a good timestamp. For counting restarts a crossed read is
*better* than a clean one: it pins a restart inside a known window.

**Two guards are needed, not one.** The single-read rule catches a restart
INSIDE one slow request. A before/after bracket around a multi-request capture
catches one BETWEEN requests. Either alone is blind to the other's case. Both
are on PR #41 with 10 tests.

## An instrument slower than its subject gives a floor, not a count

My health log sampled every 300 s against a restart cycle of ~160 s (≈90 s
serving, ≈60 s dark). Sampling slower than the period means missing events by
construction: 8 observed starts between 22:09:00Z and 22:44:08Z where the true
figure is nearer 13.

**Never hand over such a number as a count.** Say it is a floor and name the
instrument's interval, or tighten the interval below the period first. Reporting
a confident undercount is the same failure this project keeps finding in the
code. See [[memory-cut-removes-the-caveat]].
