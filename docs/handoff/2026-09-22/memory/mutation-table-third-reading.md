---
name: mutation-table-third-reading
description: How to read a hash mismatch when independently reproducing another thread's mutation table, and the verified verdict on the two tables checked 2026-09-20.
metadata:
  type: project
  modified: 2026-09-20T11:10:23.263Z
---

Reproducing another thread's mutation table independently (Player opportunity did this
2026-09-20 for fantasy plan's two files, ahead of Model audit's queue). Report:
`/mnt/project-files/mutation-reproduction-2026-09-20-opportunity.md`.

**Verdict, so it is not redone.** Both tables are sound.
- `docs/tdd/espn-weekly-scores.tdd.md` at 6b77382, base `f95fd277b867`: 12/12 fail counts
  match, 10/12 after-hashes byte-identical, every named test really fails. The withdrawn
  "5 fail" on E1 is correctly withdrawn (it fails exactly 1).
- `docs/tdd/player-week-memo-fit.tdd.md` at 761af34, base `51fe17160436`: 6/6 counts match,
  3/6 hashes exact. M4's zero is a genuine equivalent mutation, not a gap.

**Why:** a hash mismatch is not by itself a discrepancy, and reading it as one produces a
false accusation against a correct table.

**How to apply:**
1. A mutation whose text is **free text** — a reworded comment, a replaced error sentence —
   has no derivable hash. Any wording is a valid application. Expect the hash to differ and
   judge the row on fail count and named test instead. That accounted for both espn misses.
2. A **higher** measured fail count than claimed usually means your edit was stronger, not
   their row weaker. Reproducing memo-fit's M1 at the call site collapsed the null/undefined
   split as well as the fit id and gave 4 against their 3; applying it inside `memoKBasis`
   gave their exact hash and exactly 3. Try the narrower edit before writing up a mismatch.
3. Report the base hash check first. If the base does not match, no row below it means
   anything.
4. Say what you did **not** cover. A targeted-suite sweep never verifies the file's
   `npm run check` numbers, and never verifies a cross-file structural claim like
   memo-fit's M5 (54 files failing on `memoKBasis is not defined`) — that needs the full run.

The canonical shape a table must meet is [[mutation-evidence-canonical-shape]].

Runner kept at `scratchpad/mutate.mjs`: applies one mutation per clean base, records
sha256 first-12 before/after, parses `not ok` titles out of TAP, reports **NO-OP** when a
pattern fails to match rather than letting it read as green. See
[[gridiron-failure-modes]].
