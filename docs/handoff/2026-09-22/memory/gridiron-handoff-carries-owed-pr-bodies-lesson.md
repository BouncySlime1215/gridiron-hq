---
name: gridiron-handoff-carries-owed-pr-bodies-lesson
description: "Lesson (Feature audit, 18:39Z) — after a compaction a thread cannot compose the PR bodies it still owes from memory and pays one read + one append per PR (~30k tokens each); a handoff, and any compaction summary, must carry the bodies a thread still owes work on; goes into the token-efficiency skill's next revision and the handoff template"
metadata:
  type: feedback
  modified: 2026-09-22T18:41:00.000Z
---
**Why:** Feature audit's context compacted while it owed v2 self-check blocks on #55/#62/#67/#74 and the sha-table fix on #130. The compaction kept the PR numbers but not the body text, so each PR now costs one read + one append (~30k tokens) instead of one write. Accepted for today (five PRs), but it is exactly the cost the fresh-restart rule ([[gridiron-restart-fresh-from-handoff-rule]]) is meant to avoid: a restart from a handoff that lacks the owed bodies pays the same tax on its first turn.

**Rule:**
1. A thread's handoff section carries, verbatim, every PR body block it still owes (self-check block, evidence table rows, five-questions text), keyed by PR number and head sha — not just the list of PRs.
2. The same goes for a compaction: before compacting (or when a compaction is observed), the owed bodies are written to the handoff file first.
3. `anthropic-skills:gridiron-token-efficiency` next revision and the handoff template both get this as a section ("owed PR bodies"). Pairs with [[gridiron-no-subagent-for-single-api-call-lesson]] (one write each, no read). Origin [[gridiron-state-1294-2026-09-22]].
