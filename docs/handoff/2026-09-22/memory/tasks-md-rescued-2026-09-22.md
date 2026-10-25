---
name: tasks-md-rescued-2026-09-22
description: PR #6 was closed 2026-09-22 03:12:48Z; TASKS.md lived only on its branch, so the tip was shallow-fetched and the file copied out — but neither copy is durable and it still needs a real home.
metadata:
  type: project
---

`TASKS.md`, the live Active / Waiting-On list, exists **only** on
`cursor/betting-model-audit-fixes-1c85` (tip **ff215a8**, blob **802d71a**,
755 lines, 51,465 bytes). Not on main, not on any other branch.

**PR #6 was closed unmerged 2026-09-22T03:12:48Z** (draft, 375 commits, 1,128
files), the fourth of four closes in 99 seconds: #61 03:11:09Z, #56 03:11:23Z,
#59 03:11:34Z, #6 03:12:48Z. **The branch survived** -- 151 remote heads before
and after, nothing deleted. See [[o3wt2p-local-branches-2026-09-22]].

**Insurance taken (all local, nothing pushed):**
- `git fetch --depth=1` of that branch, tagged locally `rescue/tasks-md-ff215a8`
- file written to `/mnt/project-files/TASKS-md-rescued-from-ff215a8.md`

**Why this is NOT solved:** `/mnt/project-files` is intermittently unreadable
and the local tag lives in a container reclaimed on inactivity. Neither copy is
durable. For TASKS.md to be actually safe it has to reach main or a branch
someone intends to keep -- which is a push, and needs Nick's word or the
coordinator's call.

**How to apply:** never delete `cursor/betting-model-audit-fixes-1c85` while it
is the only home of that file, closed PR or not -- a closed PR is reversible and
a deleted branch is not. Also note the file's own header says it was last
updated at `de82ee2` while the tip is `ff215a8`, so the rescued copy is at or
ahead of what the header claims; do not read that header's SHA as current.
