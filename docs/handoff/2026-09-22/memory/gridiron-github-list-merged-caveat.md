---
name: gridiron-github-list-merged-caveat
description: Reference — the GitHub MCP list_pull_requests endpoint reports merged:false even for merged PRs; read merge state per PR (pull_request_read / merged_at), never from the list
metadata:
  type: project
  modified: 2026-09-22T18:49:00.000Z
---
**Observed (Evidence Auditor, 18:46Z 2026-09-22):** `list_pull_requests` returned `merged: false` for #63 and #86, both merged (#86 at 16:59Z, 7eca9a8b). The list payload's `merged` field is not populated; `state: "closed"` with a `merged_at` timestamp is the truthful signal, and only the per-PR read (`pull_request_read` / `get`) carries it reliably.

**How to apply:**
1. Never derive "merged" or "not merged" from the list endpoint; do a per-PR read and check `merged_at`.
2. A PR body that says "stacked on #N" is checked against #N's `merged_at` AND against the PR's own `base.ref` — #77 still targets `claude/project-thread-o3wt2p-timer-tier` although #63 merged, so merging it would land on a feature branch ([[gridiron-state-1274-2026-09-22]]).
3. The PR board records merges from the merge sha reported by the merging thread, not from a list call.
Pairs with [[gridiron-contradiction-test-rule]] (a "false" from a tool earns one known-true case) and [[gridiron-evidence-citation-rule]].
