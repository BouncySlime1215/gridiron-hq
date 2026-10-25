---
name: gridiron-tdd-defect-injection
description: How Gridiron HQ accepts TDD evidence for already-shipped code, and the injection discipline that makes a retroactive test worth anything
metadata:
  type: project
  modified: 2026-09-20T01:16:01.944Z
---

CLAUDE.md on `791b131` lines 48-50 is the whole Tests rule, with no exemption
anywhere and no other rule file at that ref: "a RED commit, a GREEN commit, and
an evidence file under `docs/tdd/`."

**Retroactive evidence is already accepted here, by the repository's own
precedent.** `docs/tdd/week2-numbers.tdd.md` is titled "(retroactive)" and says
it plainly: the code shipped, so a test written now passes at HEAD, so each test
file was also run against scratch copies with the guarded line reverted — a
mutation. "A test that no mutation can fail proves nothing." It was 1 of 21
evidence files as of 2026-09-20. `docs/tdd/boot-restart-cycle.tdd.md` (PR #61)
is the strongest instance: nine injections, each with the test output it
produced, re-run in full against the tip rather than quoted from when written.

So a RED commit manufactured after the fact is theatre and should not be asked
for. What the precedent's own standard does require is that the injections were
**run and shown to fail, one per guarded rule**. That is a completeness
question, not a permission one.

**Why:** the sweep of all 30 open PRs on 2026-09-20 found the gap is a write-up
gap, not a testing gap — 20 of the 22 non-compliant PRs add real test files and
are missing only the `docs/tdd/` record. Routed as "write the evidence file you
already have the material for" it is small; routed as "your PR is
non-compliant" it reads as a rebuke of work that is largely fine.

**How to apply — the injection that does NOT bite is the one that teaches you
something.** Writing `test/availability-basis-payload.test.js` for PR #54:

1. Dropping `position` from the bare `/availability` rows left the suite at 8
   pass, 0 fail. The line was restating a field the spread above it already
   carried (`availability()` stamps `position` at `contingency.js:79`). A test
   an injection cannot fail is not guarding what its name says. **When the
   injection passes, suspect the test or the line, not the tool.**
2. The first fixture gave the K and the DEF no `player_week_usage` rows, so they
   were absent from the route for want of data — and widening
   `contingency.js:43` to include K still passed 8/8. Seeded with attendance for
   all four positions, the position filter is the only thing keeping them off
   the wire and the same injection fails two tests. **A fixture that makes the
   assertion true by omission describes the fixture, not the code.**
3. Record the injection that did not bite in the evidence file. It is the part
   that shows the instrument working rather than the part that flatters it.

Related: [[gridiron-author-is-the-worst-reviewer]] ·
[[gridiron-failure-modes]] · [[mocking-trade-engine-in-tests]] ·
[[gridiron-pr-tdd-sweep-2026-09-20]]
