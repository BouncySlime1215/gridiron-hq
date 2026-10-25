---
name: gridiron-tree-hash-rule-correction-2026-09-22
description: Full detail for the 2026-09-22 ~06:23Z correction to THE TREE-HASH RULE in gridiron-suite-figure-rule.md — write-tree hashes the index, not the working tree.
metadata:
  type: feedback
  modified: 2026-09-22T06:35:55.944Z
---

Detail for the correction note atop [[gridiron-suite-figure-rule]]. Read
that first. Affected-thread list split out: [[gridiron-tree-hash-affected-threads-2026-09-22]].

**The error.** THE TREE-HASH RULE, as originally written, treated a
stable `git write-tree` hash before/after a run as sufficient proof that
nothing moved mid-run. Not sufficient alone: `git write-tree` hashes the
git **index** (the staged snapshot), not the working tree. An edit to a
tracked file that is never `git add`-ed never touches the index, so it
never touches the write-tree hash.

**Proof (Wiring map thread, ~06:23Z).** Deliberately dirtied
`docs/wiring/wiring-map.json` in the working tree without staging it, ran
`git write-tree` before and after. Both calls returned the **identical**
tree hash. An unstaged edit landing mid-run would pass this check
completely undetected.

**Corrected check, both parts required:**
1. `git status --porcelain` empty **before AND after** — proves no
   unstaged/untracked changes appeared or existed.
2. `git write-tree` stable before/after — proves the staged/committed
   state didn't move.

Part 1 catches what part 2 can't see (unstaged edits); part 2 catches
what part 1 alone doesn't guarantee (a stage-then-unstage round-trip
could leave `status` momentarily clean while the index still shifted).
Record both, every run — not either.

**Action for any thread still running a suite check tonight:** add
`git status --porcelain` (expect empty) alongside the existing
`git write-tree` capture, before and after, and state both in the
evidence file.
