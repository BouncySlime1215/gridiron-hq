---
name: gridiron-fly-cold-start
description: The Fly machine auto-stops and its first request after idle takes about three minutes, so short client timeouts read as "the app is down" when it is only cold.
metadata:
  type: project
  modified: 2026-09-19T19:25:00.000Z
---

Measured on 2026-09-19 at 19:22Z, and independently by another session
minutes earlier. **Do not diagnose an outage on a short timeout.**

- First request after the machine has been idle: **200 in 178 seconds**
  (the other session measured 63.8 s on its own cold hit).
- Every request immediately afterwards, while warm: 6 to 28 seconds for heavy
  audit endpoints, well under a second for small ones.

Cause, per that session's read of the code: the deployed machine auto-stops,
and on cold boot `startScheduler` runs about twenty boot jobs sequentially on
the same thread that serves HTTP, where synchronous SQLite blocks the event
loop (`server/services/scheduler.js:1183-1191`, `1206-1215`). The first
request queues behind all of it. `fly.toml`'s tcp checks only prove the port
is listening, which stays true throughout, so Fly keeps routing to a machine
that cannot answer yet. The repo's own `fly.toml` already sets
`auto_stop_machines = false` and `min_machines_running = 1`, so the deployed
config is older than that file.

**Working practice:** warm the machine with one throwaway request on a long
ceiling, then do all the reads in one continuous session while it stays warm.

```
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' --max-time 200 \
  -H "Authorization: Bearer $GRIDIRON_FLY_TOKEN" \
  https://gridiron-hq.fly.dev/api/leagues
```

This is distinct from, and easily confused with,
[[gridiron-long-writes-block-the-app]] — that one is a real multi-minute
outage caused by a heavy sync, this one is just a cold boot. Tell them apart
by whether a long-ceiling request eventually returns 200.
