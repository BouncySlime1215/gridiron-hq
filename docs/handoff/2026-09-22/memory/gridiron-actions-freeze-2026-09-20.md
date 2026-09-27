---
name: gridiron-actions-freeze-2026-09-20
description: Nick hit his GitHub Actions limit at 01:04Z 2026-09-20; total CI freeze, local work only, until he lifts it.
metadata:
  type: project
  modified: 2026-09-20T01:10:37.512Z
---

**Set by Nick at 01:04Z on 2026-09-20**, relayed by the coordinator: his GitHub
Actions limit is hit. **FREEZE** — no `git push`, no new PR, no workflow re-run,
no marking a draft ready, no base changes, nothing that triggers CI, until he
says otherwise. The coordinator is cancelling queued and running workflows
(including #42's) and disabling the workflows on the repo.

**Local work continues**: build, test and commit locally, hold the push.

**Why this bites harder than it looks:** the whole release plan was sequenced on
CI going green before merge, and about 26 PRs were mid-flight. Nothing on that
list can be marked ready or merged while the freeze holds, so any "waiting on CI"
state recorded before 01:04Z is now waiting on Nick, not on a runner. Do not
re-check CI on a schedule and do not report a red or missing check as a PR
failure — the checks were cancelled deliberately.

**How to apply:** when the freeze lifts, the held work needs pushing in an order
somebody chooses, not all at once, because each push spends Actions minutes he
has already run out of once. Ask before fanning out.

Work held in the fantasy-plan thread at the time of the freeze:
`claude/project-thread-f921do-season-list`, commits `5044317` + `989baf2`
([[nflverse-usage-stamp-lies]]). #42's CI at `1335098` was cancelled mid-run, so
its green is unknown, not failed.
