---
name: gridiron-contradiction-test-rule
description: Fleet rule (Opportunity, 18:20Z) — a zero, an empty set or a success returned by a bespoke check is not believed until one contradiction test (a case known to be non-zero) has run against it
metadata:
  type: feedback
  modified: 2026-09-22T18:24:00.000Z
---
**Why:** four bespoke checks today returned a clean answer that was wrong, and each was caught only when someone tried a case known to be non-empty ([[gridiron-state-1268-2026-09-22]]):
1. `importersOfSymbol` returned zero importers because it missed namespace imports (#116).
2. A SQL query aliased a column as `reason` and read the alias, returning nulls that looked like "no reason recorded".
3. A rebase produced an empty commit range that looked like "already up to date" ([[gridiron-empty-rebase-range-lesson]]).
4. A helper on Opportunity's working tree called `.size` on the object returned by `reachableEntries` — always `undefined`, so a filter always passed. (CORRECTED 18:28Z, Auditor R55: this was NOT a bug in the committed grader — `reach-grade.mjs:267-300` accepts Map or object at `:270`, and `:299` is `visitedCount: seen.size` on a Set, identical on main and b0c1616d; the Auditor's own contradiction test, 4,212 paths > 1 hop, up to 9, clears the grader. The earlier ':299 … corrected to .entries.size' attribution is struck.)

**How to apply:**
1. Before a zero / empty / "all pass" from a home-grown script or query is written into a report, PR body or evidence file, run it once on an input known to produce a non-zero or failing result. If that also comes back clean, the check is broken, not the world.
2. The contradiction test and its result are recorded next to the figure (one line: "contradiction: X → n=7").
3. This is the cheap half of [[gridiron-bespoke-tool-cross-check-rule]] (independent mechanism); it does not replace it for figures that will be quoted to Nick.
4. Pairs with [[an-empty-read-must-not-reach-a-written-report]] and [[gridiron-production-read-two-copy-rule]].
