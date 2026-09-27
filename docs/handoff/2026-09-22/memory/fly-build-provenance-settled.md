---
name: fly-build-provenance-settled
description: The deployed Fly build IS placeable in git — the apparent contradiction was an artifact of doing the archaeology against the squashed stack instead of the original lineage (settled 2026-09-19 20:45Z).
metadata:
  type: project
  modified: 2026-09-19T20:39:51.621Z
---

Supersedes the "PROVENANCE UNKNOWN" conclusion. No shell on the machine was
needed; three live probes plus history on the right branch were enough.

**Why it looked impossible.** On the stack branch, `lineup-brain.js`'s top-level
`availability_basis`, its `availability_note` and its per-warning
`availability_basis` all arrive in ONE commit, `cfa0e6f` — because that commit is
a squash of the split from PR #6. A build holding one field and not the others is
therefore impossible *against the stack*. On the original lineage
`cursor/betting-model-audit-fixes-1c85` they are TWO commits: `0a657f6` adds the
top-level `availability_basis` (and `unavailable`), and `78811b1` ("GREEN: a
failed availability read can no longer read as a healthy player") adds the note
and the per-warning basis. The deployed build sits between them.

**What the live app actually returns** (`GET /api/trades/1/lineup`, 20:44Z):
top-level keys include `availability_basis` and `unavailable`; `availability_note`
is ABSENT; and each warning has exactly `player`, `issue`, `slot` — no
`availability_basis`. That last one is the new probe that broke the deadlock.

**The window.** After `20a10a5` (which mounts `/api/league-chat`, explaining the
401) and before `78811b1`. `78811b1~1` already retires `/brain/plan` with the
"retired on 2026-09-18" body, which explains the 410. All three probes are
consistent with one clean commit in that range; only 11 commits in it touch
`server/`.

**Consequences.**
- Commit archaeology CAN place the build; it just has to be run against the
  original lineage, not the squashed stack. Check which branch you are searching
  before declaring a contradiction.
- Capturing the running image before deploying is still the safer rollback
  instruction, because "somewhere in an 11-commit window" is not a build.
- `fly ssh console -a gridiron-hq -C "ls -l /app/scripts/"` is no longer needed to
  settle provenance. It still answers what scripts are on disk.

See [[trade-brain-live-state-1919]] and [[availability-fit-before-after]].
