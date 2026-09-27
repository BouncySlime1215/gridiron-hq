---
name: health-uptime-brackets-every-read
description: GET /api/health is unauthenticated and returns uptime_s — bracket every live read with it, and tell a wedge (zero-byte hang) from a 503 from a 502.
metadata:
  type: reference
---

**Cheap restart detector:** `GET /api/health` is unauthenticated and returns
`uptime_s`. Bracket every read with it; if the end `uptime_s` is smaller than the
seconds the read took, the process restarted during it and the read is void.
During a wedge requests HANG WITH ZERO BYTES (blocked loop, connection on the
listen backlog), a 503 is the same wedge caught by the health handler, and a 502
is the edge with no instance — three different facts.

A restart also busts the unfingerprinted memos at `routes/model.js:404`, `:426`
and `:443`, so a read that straddles one is served from two memo generations with
no marker where the seam is. That is not a noisy read, it is an internally
inconsistent one, and the seam falls mid-list where it reads as a real effect.
Void it and re-take rather than keeping it.

Essential for the step 8 restart, where the after-reads must sit entirely on one
side of it. See [[wal-mode-changes-the-wedge-diagnosis]].
