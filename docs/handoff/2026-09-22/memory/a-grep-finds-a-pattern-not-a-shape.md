---
name: a-grep-finds-a-pattern-not-a-shape
description: A sweep driven by grep reports zero remaining sites while the same defect sits in a form the pattern cannot match; and the first place a new rule gets misapplied is the sibling of the example that produced it.
metadata:
  type: feedback
  modified: 2026-09-22T01:02:15.888Z
---

**Two halves of one rule, both measured on Gridiron HQ 2026-09-20.**

**1. A grep finds a pattern; the defect is a shape.** A sweep of hedged test
assertions searched for `assert.match` with a `|` in a literal regex. After two
passes the search returned **zero** across all sixteen of that thread's suites —
and one site with the identical defect was still there, because it was not an
alternation. `SIGNAL_SOURCES.tx.refreshed` was asserted by a bare fragment
(`/collect-league-transactions\.mjs/`) of a registry constant whose whole string
is the contract. No pipe, so no grep could see it.

Report a sweep's zero with what the grep could not have found, or the number
reads as an all-clear it has not earned.

**2. The first application of a new rule is where its own siblings get missed.**
The rule — *when the value under test is a registry constant, the whole string is
the contract and a fragment of it is not* — was stated from two sites in
`SIGNAL_SOURCES`. Applying it fixed `chat.refreshed` and left `tx.refreshed`,
three entries down the same frozen object, interpolated into the served `why` the
same way, with the same defect. **A rule stated from N examples is worth
re-running over the files that produced them, before it is carried anywhere
else.**

**How to apply.**
- After a grep-driven sweep reports zero, re-read the same files for the SHAPE.
  Cheap heuristic: list every assertion whose subject is an imported constant or
  a frozen-object field, and check each is an equality or an explicit disjunction
  of the valid strings, never a fragment.
- State a zero as "zero of the pattern", and name the class the pattern cannot
  match.
- When a new rule is written down, its first job is the file it came from.

**Related.** [[unreachable-branch-no-assertion]] is the same family from the code
side: there the fixture cannot reach the branch, here the search cannot reach the
site. [[tests-that-slice-on-a-common-token]] is the third: the assertion reaches
the wrong lines. All three pass for the wrong reason and only a mutation shows it.
See also [[mutation-evidence-canonical-shape]] and
[[gridiron-a-tombstone-is-earned]].
