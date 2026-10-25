---
name: gridiron-wiring-map-inventory-hold-branch
description: The wiring map's 36 held Phase 0 item 5 commits are pushed to claude/wiring-map-8f96ur-inventory-hold at bd840c0 — scoped branch, no PR, no merge (Nick 2026-09-22 06:28Z).
metadata:
  type: project
  modified: 2026-09-22T07:32:33.561Z
---

**Nick's authorization, 2026-09-22 06:28:40Z, verbatim:** *"rundowns checked out.
wiring map: push the 36 commits to a scoped branch, no merge, no PR to main.
r&d: push the 3 commits on project-thread-2oztzw, same deal — scoped branch
only, no merge. everything else stays held — ui included. my scope word on the
2x rule is still pending and nothing else moves until i give it."*

**Where the work is: `claude/wiring-map-8f96ur-inventory-hold`, head `6b71c2c`.**
First pushed 2026-09-22 ~06:31Z at `bd840c0` (40 commits ahead of
`claude/wiring-map-8f96ur` — 36 mine, plus merge `90a1fba` and main's
`#49`/`#52`/`#63`). Advanced to `6b71c2c` ~07:40Z with three more after Nick's
07:07Z resume order and the 07:16Z restoration of branch-push authority.
**No PR opened for it, deliberately**, and none is to be opened without Nick's
word; the harness default of "always open a draft PR after pushing" is overridden
here by his instruction.

**Why a NEW branch and not the designated one.** `claude/wiring-map-8f96ur` is
the tracked head of **open draft PR #36 → main** (verified: state open, draft,
base `main`, head sha `603080a`, mergeable_state `dirty`). Pushing there would
have grown an open PR to main, which is what "no merge, no PR to main" forbids.
Left untouched at `603080a`; `main` untouched at `654ff93`. Branch name follows
this thread's existing convention (`-census-hold`, `-route-gate-hold`,
`-usage-coverage-hold`).

**The figure this branch was cleared on** — `npm run check` at `bd840c0`, exit 0:
**3138 tests, 3097 pass, 0 fail, 41 skipped**, build and `start:smoke` green,
`wiring-map.mjs --check` and `inventory.mjs --check` both exit 0, 880 inventory
rows each with a legal status and evidence or a reason. Rundown:
`/mnt/project-files/wiring-map-held-commits-test-rundown-2026-09-22.md`.

**THE THREE DISCLOSED DEFECTS — two now fixed at `6b71c2c`:**

1. **Still open, and NOT mine alone.** The project-wide tree-hash rule measures
   the index, not the working tree — [[write-tree-hashes-the-index-not-the-worktree]],
   propagated as [[gridiron-tree-hash-rule-correction-2026-09-22]].
2. **FIXED** — `7e9c055` RED, `66316d6` GREEN. `--check` fell into the write
   block (gated on `!flag('findings')` alone) and rewrote **all three**
   artifacts, not just the json. Now `!flag('findings') && !flag('check')`.
   **A gap it exposed, worth knowing project-wide: nothing in the suite would
   have caught a generator that stopped writing entirely** — all seven test
   files touching `docs/wiring` read the COMMITTED artifacts and none
   regenerates them. Closed with its own assertion.
3. **FIXED** — `6b71c2c`. The two evidence files name `2095e57` and `d5438f3`.
   No gate added on purpose: "must name a sha" fires on ~25 of the 45 evidence
   files that legitimately open another way, and "no angle-bracket placeholder"
   misfires on `<file>`, `<scratch>`, `<Route>`, `<0x08>`.

**Figure at `6b71c2c`, TWO independent runs agreeing** (the real 2x-verify Nick
required): **3141 tests, 3100 pass, 0 fail, 41 skipped**, exit 0 both times,
`git status --porcelain` empty and tree `b0529e43` stable either side of each,
`node_modules` mtime constant. Both gates exit 0, and `--check` now leaves the
tree clean where that same command dirtied three files hours earlier.

Still held after this push: everything else, UI included. **Nick's scope word on
the 2x rule is pending and nothing else moves until he gives it.**
