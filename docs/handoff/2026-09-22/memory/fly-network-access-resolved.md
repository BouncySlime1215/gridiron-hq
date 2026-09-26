---
name: fly-network-access-resolved
description: Network egress for the GridIron HQ environment was fixed on 2026-09-19 by switching the policy from Trusted to Full; Fly and the data feeds are reachable from sessions started after 15:12 UTC.
metadata:
  type: project
---

**Resolved.** Do not treat this as an open blocker.

The "GridIron HQ" environment (env_018JCMxcnhDtud9VXS1CW51B) ran on the
**Trusted** network policy until 2026-09-19 15:12 UTC. Trusted is a narrow
allowlist covering package registries only, so it denied CONNECT with 403 for
`gridiron-hq.fly.dev`, for every data feed, and for unrelated hosts like
`example.com`. Only `github.com`, `raw.githubusercontent.com`, npm, PyPI and
the Anthropic API got through. Several probes failed under Trusted; none of
them were evidence that opening access wouldn't work.

Nick switched the policy to **Full** (unrestricted outbound) at 15:12 UTC.
Full was chosen over Custom because Custom requires listing ~33 domains and any
omission fails silently with the same 403.

Verified from a session started after the change: `gridiron-hq.fly.dev` returns
200 and serves the real app. ESPN public and fantasy, Sleeper, FantasyCalc and
the open-meteo archive are all reachable. The odds API returns 401, which is
that API wanting a key, not a proxy denial.

**The gotcha that cost four failed probes:** a policy change only reaches
sessions created after it is saved. A running session stays on the old policy
permanently, so re-probing from it always fails and proves nothing. The fix is
a fresh session, never more debugging. Never work around a 403 — no alternate
proxy, no disabling TLS verification.

Next gate after this one is authentication, see [[gridiron-fly-login-token]].
