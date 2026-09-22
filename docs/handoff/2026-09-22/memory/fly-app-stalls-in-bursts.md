---
name: fly-app-stalls-in-bursts
description: On 2026-09-19 gridiron-hq.fly.dev was not down but stalling in multi-minute bursts — one clear window in twelve probes — which breaks any health check that waits for a response.
metadata:
  type: project
  modified: 2026-09-19T19:26:26.884Z
---

Measured 2026-09-19 between 16:08Z and 19:25Z. Worth recording because it was
misdiagnosed twice, once by this session, as the app being down.

**The shape of the failure:** the connection is accepted, TLS completes, the
HTTP request goes out, and the server then writes nothing at all, for minutes.
Not a 502, not a refused connection, not a slow response — no response. Fly's
edge only gives up at its 300-second idle timeout, at which point curl reports
"failure when receiving data from the peer".

**It is intermittent, not constant.** A probe every 20 seconds: attempts 1-11
returned nothing, attempt 12 at 19:22:54 returned 200 with a full payload, and
the next call 90 seconds later timed out again. Other sessions completed a 5 MB
upload in 18 seconds and saw a 429 in 0.33 seconds in the same period. All of
that is one machine serving normally in short windows and stalling in between.

**Cause, as identified by the scheduler thread:** AUTO_HEAVY_SYNC was switched
on, heavy-tier jobs run on the main thread, and `node:sqlite` is synchronous,
so a heavy job blocks the whole HTTP server while it runs.

**Two things this should change.**
1. A health check that waits for a response will hang rather than fail, and
   `[[services.tcp_checks]]` passes the entire time because the socket still
   accepts. Any liveness check must set a short client timeout and count the
   timeout itself as a failure. Otherwise this outage repeats and nothing
   reports it.
2. Never conclude "the app is down" from a run of timeouts in one session.
   Probe repeatedly over minutes, and compare with what other sessions see,
   before saying anything about the app rather than about your own requests.

Any job that reads a league payload and does CPU work on it belongs off the
main thread: measured on 1.41 MB payloads, the manager-signals build holds a
thread ~117ms per tick across five leagues even when nothing changed, and the
whole server stalls for that time if it runs in-process. PR #26 runs it in a
worker for this reason. See [[trade-brain-live-state-1919]].
