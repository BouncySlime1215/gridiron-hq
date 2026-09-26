---
name: what-a-thread-can-actually-read-live
description: A cloud thread session can reach https://gridiron-hq.fly.dev over plain HTTPS and read unauthenticated endpoints, but has NO flyctl, no Fly token and no /data/data.sqlite — so "ask a thread for a live read" only works for unauthenticated routes.
metadata:
  type: project
---

Measured 2026-09-22 ~04:53Z from the o3wt2p thread container, after the
coordinator asked it to run a SELECT against the live DB on the premise that it
was "the thread with that capability." It is not.

**Absent, not blocked:**

    command -v flyctl fly            -> nothing on PATH
    env | grep FLY_API_TOKEN|...     -> none set (checked by NAME, never value)
    ls /data/data.sqlite             -> does not exist in the container

So no `fly ssh console`, no `fly secrets`, no DB file. On top of that the
standing overnight rule is "reversible work only, NO live DB writes, NO flyctl",
so even with the binary this needs Nick's own word.

**Present and useful — plain HTTPS to the app works:**

    GET https://gridiron-hq.fly.dev/api/health      -> 200 {"ok":true,"uptime_s":141013}
    GET https://gridiron-hq.fly.dev/api/model/status -> 401 authentication required

`server/index.js:134` mounts `/api/model` behind `legacyAuthenticated`, so every
`/api/model/*` route is 401 without a session. Expect the same for other
authenticated routers; `/api/health` (`server/platform/health.js`) is the one
reliably open read.

**Why:** the existing note says the coordinator has no reliable live network and
that live readings come from a thread or Nick. True, but it reads as "a thread
can read the live system," which overshoots. The accurate split is: a thread can
read **unauthenticated HTTP**, and nothing else. Anything needing the database,
secrets, or an authenticated route is Nick or a session that actually has flyctl.

**How to apply:** before routing a live read to a thread, ask which surface
answers it. Unauthenticated endpoint -> a thread can do it now. DB query,
`fly secrets`, `fly ssh`, or any `/api/*` behind auth -> it cannot, and saying so
plainly beats producing a plausible answer. Check the capability before arguing
about the permission, per [[check-reachability-before-arguing-about-a-delete]].

**Bonus reading from the same probe:** `uptime_s` 141013 = 39 h 10 m, so boot was
~2026-09-20T13:43Z, matching the recorded restart-loop stop of 13:43:13Z to
within a minute. The app has been up on ONE life for 39 hours — independent
corroboration that the brake is holding, from a source that is not memory.
