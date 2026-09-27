---
name: gridiron-skill-registry-snapshot-lesson
description: Lesson (Feature audit, 18:27Z) — a session's skill registry is a snapshot taken at session start; a skill Nick saves afterwards (gridiron-token-efficiency, 18:17:52Z) does not load in sessions started before the save, even with the prefix; fresh restarts pick it up
metadata:
  type: project
  modified: 2026-09-22T18:33:00.000Z
---
**Why:** `anthropic-skills:gridiron-merge-gate-v2` (saved 18:13:38Z) loads in Feature audit's session, but `anthropic-skills:gridiron-token-efficiency` (saved 18:17:52Z) does not — the session started before that save and its skills list is a snapshot. Opportunity's session had the same gap 18:27Z; the gist was relayed inline. This is not the prefix problem ([[gridiron-skill-prefix-lesson]]): the name is right, the registry is stale.

**Rule:** a skill saved after a session started is applied by relaying its text inline until the session restarts; a fresh session from the handoff ([[gridiron-restart-fresh-from-handoff-rule]]) sees it. Handoffs name the skills the restarted session must load. When a new skill matters to every thread, that is one more reason to restart fresh sooner rather than later. Origin [[gridiron-state-1293-2026-09-22]].
