---
name: availability-basis-module-is-not-wired-yet
description: server/services/availability-basis.js is correct and mutation-tested but four of its six exports have zero production consumers; grade it decoration-with-tests, not wired, until a serving path asks SERVABLE_AVAILABILITY_BASIS.
metadata:
  type: project
---

Measured 2026-09-22 02:31Z on `claude/project-thread-w45mur-wiring-names-hold`
at 80b7538, by the thread that wrote the module, reporting against itself.
Consumers counted with `grep -rn "\bSYMBOL\b"` over `server client scripts`
versus `test`, excluding the defining file:

| export | production | test |
|---|---|---|
| AVAILABILITY_FIT_BASIS | 3 | 0 |
| DEFAULT_DURABILITY_PRIOR | 2 | 4 |
| AVAILABILITY_BASIS | 0 | 10 |
| SERVABLE_AVAILABILITY_BASIS | 0 | 4 |
| DEFAULT_ACTIVE_PROBABILITY | 0 | 2 |
| isAvailabilityBasis | 0 | 1 |

One file in the app imports it at all, `contingency.js:22`, taking two of six.

**Why this matters more than the count.** It is
[[basis-fields-served-never-rendered]] one level deeper: there a server field was
added and no client read it; here a vocabulary was written and no serving path
asks it. `SERVABLE_AVAILABILITY_BASIS` exists specifically to stop a consumer arm
(`unfitted_position`, `unrecognised`, `unvouched`) being printed on a row as
though it were a served basis, and nothing calls it — so the defect it names can
still ship. A high test count on the module reads like wiring and is not; the
tests only prove the vocabulary is internally consistent.

**How to apply.**
1. Grade it **decoration with a test suite** in the honest inventory, not wired.
   Do not let the 10 vocab tests or the mutation evidence move that grade.
2. The grade changes when a serving path calls `isAvailabilityBasis` /
   `SERVABLE_AVAILABILITY_BASIS` before putting a basis on a row — not before.
3. Wiring it is a Phase A-shaped change and was deliberately not started during
   Phase 0. It needs the consumers in other threads' files, so it goes through
   the coordinator, not thread-to-thread ([[gridiron-five-questions-rule]],
   question four: pointed anywhere else on the platform).

**Scope, reconciled 2026-09-22 02:52Z.** The file does not exist on 654ff93 —
it is new on the thread branch (+135 lines vs origin/main), so it gets no row in
the tree-wide inventory until that branch merges. It is also not a duplicate of
the existing `server/services/player-availability.js`: that file defines no
basis vocabulary (`grep -i "basis|unfitted|unrecognised|servable"` on main
returns nothing) and is unchanged on this branch. `contingency.js` imports both
— `player-availability.js` at line 21 for `espnStatusById`, the new module at
line 22 — so line 22 is an addition, not a replacement.
