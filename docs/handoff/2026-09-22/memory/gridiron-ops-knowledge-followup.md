---
name: gridiron-ops-knowledge-followup
description: Queued follow-up for after the 2026-09-19 deploy — get that evening's operational findings out of thread messages and into the repository's own docs.
metadata:
  type: project
---

Queued 2026-09-19 by the coordinator session, to start **after** the release
train (PR #35) is merged and deployed. Not during the merge window: a new
branch in that window is the collision Nick asked to avoid.

The work: a lot of operational knowledge from that evening exists only in
thread messages, where a newcomer will never find it and will rediscover it the
hard way. Get it into the repository's docs as a follow-up pull request
**outside the train**.

Named items to cover:

- The cold start.
- The two separate causes of the wedging (they are distinct; do not merge them
  into one explanation).
- That a failing Fly health check does not restart a machine.
- The availability tables reaching the shared projection engine.
- The simulate route's uncleared cache.

Verify each against the threads and the code before writing it down rather than
paraphrasing from memory — several of these were themselves corrections of an
earlier wrong diagnosis. This is the thing the `CLAUDE.md` work points at:
a rules or docs file is read as fact by whoever it briefs, so a wrong cause
recorded there is how a fixed bug gets rediscovered.

See [[gridiron-claude-rules-location]] and [[gridiron-decision-routing]].
