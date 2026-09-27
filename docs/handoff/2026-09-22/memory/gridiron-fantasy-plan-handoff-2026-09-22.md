---
name: gridiron-fantasy-plan-handoff-2026-09-22
description: Where the Fantasy plan thread's full 2026-09-22 handoff lives, and the four things a cold session gets wrong without it.
metadata:
  type: project
  modified: 2026-09-22T18:02:50.417Z
---

The Fantasy plan thread (session_01U2PQK2qw4VrXdytNqpq5an, branch
`shrinkage-efficiency-weighting` = PR #106) wrote its full handoff to
**`/mnt/project-files/handoff/fantasy-plan-2026-09-22.md`** at 18:03Z on
2026-09-22. Read that file before touching #106, Plan 01's availability
multiplier, or the R25 decomposition — it carries the shas, the file:line
targets, the guard results and the five unbuilt findings with owners.

The four things a cold session gets wrong without it:

1. **Control was NOT promoted.** Its pooled-MAE advantage over the shipped
   `WEEKLY_ENSEMBLE_WEIGHTS` is 62% level / 38% information on 2024, the
   information share's own 90% interval includes zero, and on 2022 the
   comparison reverses significantly in shipped's favour. Do not rebuild a
   promotion case on the pooled figure without explaining 2022.
2. **CI has never run #106's test phase.** `check:wiring` runs before the
   tests in `ci.yml`, so every test number on that branch is from the local
   guard, not CI. Do not read a red run there as a test failure.
3. **A guard test's RED must be committed inline fixtures** over a
   `{path, source}` scanner, plus a test pinning the real tree clean — a
   committed production violation and a working-tree demo are both refused
   (Auditor R54.3). Strip comments AND string bodies before scanning.
4. **The `docs/wiring/annotations.json` grant is spent.** One entry was
   granted and applied at `af60024`; the file belongs to the Wiring map
   thread and needs a new grant before any further edit.

Related: [[gridiron-state-index-2026-09-22]], [[gridiron-five-questions-rule]],
[[gridiron-file-allocation]], [[gridiron-verify-once-and-model-by-weight]].
