---
name: gridiron-claude-md-tasks-md-claim-stale
description: CLAUDE.md line 61 claims TASKS.md is not on main; verified false on 654ff93 — it is tracked on origin/main, added by d9b4a90d.
metadata:
  type: project
  modified: 2026-09-22T07:19:21.136Z
---

**Verified 2026-09-22T07:20Z by the auditor thread, on a fresh clone at origin/main
654ff9339832f3727f99db263abedf3e1227a9b3.**

`CLAUDE.md:61` says: "**The live task list is not in this branch.** `TASKS.md` exists
only on `cursor/betting-model-audit-fixes-1c85` (PR #6), not on `main`."

That is false. Commands and output:

- `git ls-files --error-unmatch TASKS.md` → tracked on main.
- `git cat-file -e origin/main:TASKS.md` → exists, 51,465 bytes.
- `git log -1 -- TASKS.md` → `d9b4a90d` "Plans, TDD records and the audit documents,
  without the research artifacts", 2026-09-19.
- `git merge-base --is-ancestor d9b4a90d origin/main` → true.

**Why it matters:** CLAUDE.md is loaded automatically by every session on this repo,
so every session is told to go looking on a branch for a file that is in front of it.
The paragraph's actual point still stands in weaker form — the copy on main is stale:
its own header reads "Last updated: 2026-09-19, new cloud session on
`cursor/betting-model-audit-fixes-1c85` (at `de82ee2`)". So the correct statement is
"the copy on main is behind the one on that branch", not "it is not on main".

**How to apply:** when CLAUDE.md is next edited (owner of that file decides, not the
auditor), replace the claim with the staleness version above. Until then, do not
re-derive "TASKS.md is missing" from CLAUDE.md — read `git show origin/main:TASKS.md`.

See [[gridiron-auditor-thread-standing-2026-09-22]].

**Correction 18:50Z 2026-09-22 (for memory):** `TASKS.md` IS on main since d9b4a90d (2026-09-19) and is byte-identical to the cursor branch as of 654ff93; CLAUDE.md's "CI had never once completed on main" is now scoped to "through 2026-09-15" (CI has completed on main since #7). Any memory line saying TASKS.md is absent from main is wrong. [[gridiron-state-1275-2026-09-22]]
