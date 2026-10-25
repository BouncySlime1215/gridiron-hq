---
name: gridiron-deployed-build-bracket
description: The gridiron-hq.fly.dev build that ran before the 2026-09-19 deploy was a clean commit in an eleven-commit window — and why the same archaeology against a squashed stack made it look impossible.
metadata:
  type: project
  modified: 2026-09-19T21:39:29.511Z
---

**Test file CONTENT, not ancestry.** Two rules, both paid for in hours:

1. **When commit archaeology produces a contradiction, check which branch it
   ran against.** A squash makes two commits look like one, and any build
   between them then reads as impossible.
2. **Never check a claim about deployed code against the plan branch.**
   `claude/release-train-2yv3x6` carries PR #35, the document, and its `server/`
   is `main`'s — `contingency.js` was 323 lines there against 1,093 on the
   merged tree. Verify against a PR head or a merged tree. See
   [[gridiron-cite-the-shipping-tree]].

## The bracket

**The window:** after **`20a10a5`** (mounts `/api/league-chat`, explaining the
live 401 there) and before **`78811b1`** (whose parent carries the retirement
body explaining the live 410 on `/brain/plan`). Three independent probes agree;
only eleven commits in it touch `server/`.

**How the contradiction arose.** Live `GET /api/trades/1/lineup` returned
`availability_basis` populated while `availability_note` was **absent from the
response entirely** — not null, absent. On the stack both keys are set in the
same object literal, so no build could have one without the other. But on the
original lineage `cursor/betting-model-audit-fixes-1c85` they are **two**
commits: `0a657f6` adds `availability_basis` with **zero** `availability_note`
lines, and `78811b1` a day later adds seven. `cfa0e6f` squashes both. On the
stack a build between them cannot exist; on the lineage it is ordinary.

**The technique that broke the deadlock:** the live warnings carried exactly
`player`, `issue`, `slot` and **no per-warning `availability_basis`** — a field
nobody had looked at. *When two probes contradict, find a third field the two
candidate commits treat differently.*

**The deployed binary was not `main`.** Live
`GET /api/model/availability?week=2` returned **13** keys from
`weeklyAvailability` against `origin/main`'s **9**. The extra four
(`designation`, `designation_source`, `espn_status`, `role`) came from
`cfa0e6f`, which is not on main. The machine was running branch work.

## What does not change

**Roll back to an image, not a commit.** "Somewhere in an eleven-commit window"
is not a build. Capture `fly image show -a gridiron-hq` before deploying over
it. The pre-deploy capture was
`registry.fly.io/gridiron-hq:deployment-01M2VZ9JRYSXVHCRWJ83V360QH`
(digest `sha256:caf1b40b…`), machine `84ed41eae1dd68`.

Note that for a deploy carrying migrations there is a *second*, more direct
database rollback: the pre-migration `VACUUM INTO` snapshot, which is never
deleted automatically. See [[gridiron-migration-snapshot-disk-gate]].
