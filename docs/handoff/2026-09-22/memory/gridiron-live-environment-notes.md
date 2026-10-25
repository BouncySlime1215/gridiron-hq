---
name: gridiron-live-environment-notes
description: Live Gridiron HQ environment facts as of 2026-09-22 — cold start timing, the five leagues, current week, known bugs, and coordinator egress limits. Linked from MEMORY.md "Live environment".
metadata:
  type: project
  modified: 2026-09-22T04:13:08.548Z
---

**Cold start**: 60-180s. Never call anything an outage under 300s of unresponsiveness.

**Leagues**: 1 Matta - Kodsi Annual, 2 DMV League 23-24, 3 "Transfer portal " (note the trailing space in the name, it's real), 4 My 2025 League, 5 My 2026 League. Currently 2026 week 2.

**Known bug**: `PLAYOFF_WEEKS` is wrong for league 4 — tracked as #40.

**Coordinator egress**: the coordinator's own network access 403s on CONNECT to gridiron-hq.fly.dev (observed twice on 2026-09-22); threads can reach it fine. This means live readings must come from a thread or from Nick directly, **never** a coordinator worker — a coordinator worker's "undetermined" result means the network policy blocked the request, and says nothing whatsoever about the app's actual state.
