---
name: gridiron-pr-tdd-sweep-2026-09-20
description: Which open Gridiron HQ PRs carried a docs/tdd/ evidence file on 2026-09-20, which did not, and the merge-order trap in the scheduler stack
metadata:
  type: project
  modified: 2026-09-20T01:16:19.035Z
---

Swept all 30 open PRs (excluding #6) at ~01:00Z on 2026-09-20 against the rule
in [[gridiron-tdd-defect-injection]]. Method: per head,
`git merge-base origin/main <head>`, then the commit list and the diff of
`docs/tdd/` and `test/` against that base. Every branch's merge-base was
`791b131`.

**Carried an evidence file at their own head (5):**
- #36 wiring map — `wiring-map-template-literal-uses.tdd.md`, literal RED/GREEN
- #42 fantasy plan — `team-outlook.tdd.md`, literal RED/GREEN
- #51 Google sign-in — `admin-grant-convergence.tdd.md`; one squashed commit,
  but the file carries verbatim RED output (3 of 5 cases failing against
  unmodified `account-link.js`) and names the two cases that pass in both states
- #61 scheduler — `boot-restart-cycle.tdd.md`, nine injections
- #63 scheduler — extends that same file by 14 lines for its own change
- #54 wiring map — added after the sweep, `availability-basis-payload.tdd.md`

**RED/GREEN commits but no evidence file (1):** #44 fantasy plan
(`947d184`/`68b57d4`, `896a215`/`3deb9da`). Nearest to compliant; wants a
write-up, not new work.

**Tests present, no evidence file, no RED/GREEN (22):** UI #43 #46 #53 #58 #60 ·
scheduler #45 #50 #52 #56 #59 · feature audit #55 #57 #62 #64 · fantasy plan
#38 #40 · Trade Brain #41 · Google sign-in #48 · chat sync #47.

**No test at all (3, plus #54 before the repair):** #39 scheduler
(`scripts/lint.mjs` adds a lint rule that can fail a build and nothing pins it)
· #49 scheduler (`fly.toml`, one line) · #15 (two measurement scripts).
**Rule does not apply:** #35 (release plan, `docs/` only).

**Why:** a fresh Claude asked "is this PR compliant" will otherwise re-derive
all of it, and will likely read the rule more strictly than CLAUDE.md states.

**How to apply — the merge-order trap.** #56 and #59 have their evidence, but
the file lands only on **#61's** head. Merged in the planned order
#56 -> #59 -> #61, `main` carries two scheduler fixes with no evidence file for
two merges and gets the file on the third. Nothing is missing and nobody has to
write anything: the file needs to travel with #56, or the three land together.
The same shape will recur on any stacked trio.

Two heads moved during the sweep and are newer than the board in MEMORY.md:
#35 `b1f8452`, #43 `e36ad08`, #48 `f108ca94`, #58 `cabd95c`. Two PRs are new:
**#63** (scheduler, timer-tier off-thread) and **#64** (feature audit, the last
seven week reads). Always re-read heads live; do not trust a board for a sweep.

Related: [[gridiron-tdd-defect-injection]] · [[gridiron-pr-board-2026-09-19-night]]
· [[gridiron-actions-outage-2026-09-20]]
