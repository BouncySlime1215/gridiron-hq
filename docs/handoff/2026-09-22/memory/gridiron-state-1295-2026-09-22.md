---
name: gridiron-state-1295-2026-09-22
description: "18:27Z-18:46Z: #132 MERGED 94531b2 by Nick's own click ('did the thing' = the GitHub merges), 27 today, main 9d262adf; UI #118 cf60f5e3 one guard running; usage lesson: pull_request_read 'get' ignores fields (~7k tokens), use git log/ls-remote for shas and get_check_runs for CI; Wiring map #146 DRAFT receiver ratchet 6212253 merges itself on green; MLB comment correction a646ec6 held until f08bdf42, wiring-map.mjs:2164-2165 patterns STAY"
metadata:
  type: project
  modified: 2026-09-22T18:46:00.000Z
---
- **#132 MERGED 94531b2 at 18:27Z by Nick's own click** → 18:28:13Z "did the thing btw" RESOLVED = the GitHub merges (not the effort setting). Main order continues … 7a9982d4 (#123) → 94531b2 (#132) → 9d262adf (#127). **Merged today: 27.** UI: **#118 head cf60f5e3** (tree 78bb115e, main merged, zero file overlap), one guard running, merge on exit 0 + CI; two stale guard runs killed on purpose.
- **Usage lesson (added to [[gridiron-no-subagent-for-single-api-call-lesson]]):** `mcp__github__pull_request_read` method "get" ignores the `fields` parameter and returns the whole body (~7k tokens for six booleans). For shas use `git fetch origin main -q && git log --oneline -2 origin/main` or `git ls-remote`; for CI use method "get_check_runs" (small); no cheap draft/merged call found yet.
- **Wiring map #146 DRAFT** (receiver ratchet, head 6212253, branch claude/wiring-map-8f96ur-receiver-ratchet, check exit 0 3614/3573/0/41, tree 331f8a78 unchanged, v2 block incl. liveness proof + seven-row sweep) merges itself on CI green. **MLB comment correction a646ec6** held in a scratch worktree until Scheduler pushes f08bdf42; **wiring-map.mjs:2164-2165 patterns STAY** (mlb-model-misc.js tables survive with no writer/reader; excluded as abandoned product, not as betting; retirement condition = table drops on Nick's word); CONTRACT.md §2c notes mlb.js deleted and the 6/3 cells historical to c90d2834.
Prev [[gridiron-state-1294-2026-09-22]]. Next [[gridiron-state-1296-2026-09-22]].
