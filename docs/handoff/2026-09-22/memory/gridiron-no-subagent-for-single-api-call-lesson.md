---
name: gridiron-no-subagent-for-single-api-call-lesson
description: "Usage lesson (Feature audit, 18:20Z fleet rule) — a subagent spawned for one GitHub API call costs 50-70k tokens (four PR metadata reads 60,828; one PR state 50,359; three-PR status 71,121; ~60k per body update; ~400k total); call mcp__github__* directly, subagents only for parallel large work; push before the guard finishes so CI runs in parallel; mutation sweeps stay"
metadata:
  type: feedback
  modified: 2026-09-22T18:46:00.000Z
---
**Why (measured by Feature audit):** ~400k tokens went to subagents whose whole job was one GitHub API call each — 60,828 for four PR metadata reads, 50,359 for one PR state, 71,121 for a three-PR status pull, ~60k per body update. Each subagent re-reads its brief and the tool schemas before making the call the parent could have made in one turn. Under Nick's usage rule #1 ([[gridiron-usage-priority-rule]]) that is the single largest avoidable line item a builder thread has.

**Fleet rule 18:20Z:**
1. Call `mcp__github__*` directly from the thread; a subagent is for parallel, large work (a suite run, a multi-file sweep), never for a single request.
2. Mutant re-confirmation is one row, not a re-run of the whole set.
3. Push before the local guard finishes so CI runs in parallel with it; the merge still waits for both.
4. **Cheap reads (18:45Z):** `mcp__github__pull_request_read` method "get" ignores `fields` and returns the whole body (~7k tokens for six booleans). Shas: `git fetch origin main -q && git log --oneline -2 origin/main` or `git ls-remote`. CI: method "get_check_runs" (small). No cheap draft/merged call found yet — read state once, write once.
5. **Mutation sweeps stay** — they are not the cost problem and they catch what CI cannot: M6 on #130 survived a reverted fix because source-grep assertions could not tell fix from defect; fixed by extracting `floorOf` and running it (commit 71a1093). Pairs with [[gridiron-rerun-red-after-assertion-change-lesson]].
Origin [[gridiron-state-1290-2026-09-22]].
