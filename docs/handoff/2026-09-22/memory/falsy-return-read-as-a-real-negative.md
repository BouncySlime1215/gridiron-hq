---
name: falsy-return-read-as-a-real-negative
description: "Four defects in one day shared one shape: a bespoke check returned a plausible falsy value instead of raising, and the zero was believed."
metadata:
  type: feedback
  modified: 2026-09-22T17:37:19.182Z
---

A zero, an empty set, or a "success" from a bespoke check is worth **one
contradiction test** before it is believed. The cheapest such test is a case
whose answer you already know to be non-zero.

**Why:** 2026-09-22, Opportunity thread, four separate defects with one shape.
None raised an error. Each returned a plausible value that read as a real
negative result:

1. `importersOfSymbol` returned **0 importers** for `dispatchTriggeredCapture`
   — it could not see namespace imports. A live symbol read as dead.
   [[gridiron-file-allocation]] · fixed in PR #116.
2. A SQL alias named `reason` silently resolved to the table's own `reason`
   column, collapsing two distinct outcomes into **one row with the wrong
   label**. [[sql-alias-colliding-with-a-real-column]]
3. `git rebase --onto <new> <branch-head> <branch>` printed "Successfully
   rebased", exited 0, and left the branch with **none of its commits**.
   [[empty-rebase-range-silently-empties-a-branch]]
4. A scratch helper called `reachableEntries(...).size`. That function
   returns `{entries, truncated, visited, visitedCount}`; the correct call is
   `.entries.size`. `.size` on the object was `undefined`, so `undefined > 0`
   dropped **every non-entry importer**. The defect was in the uncommitted
   helper only — `scripts/reach-grade.mjs` is correct and unchanged; do not
   re-audit it over this.

**How to apply:**
- Before trusting a zero from your own helper, run it on an input whose
  answer you know is non-zero. All four above would have died instantly.
- Prefer contradiction tests over inspection. Three of the four were caught
  by an internal impossibility (a file graded `wired` cannot have zero
  entry-reachable importers), not by re-reading the code — reading had
  already passed them.
- Destructuring a documented return shape beats a property access on an
  assumed one: `const { entries } = reachableEntries(...)` would have thrown.
- This matters most when the broken thing is the **independent standard** a
  tool gets checked against. Then the tool "disagrees", the tool gets blamed,
  and the real defect is invisible. Verify the standard first.

Related: [[npm-check-does-not-run-the-wiring-gate]] and
[[verify-the-merge-not-just-the-head]] — same family, where the check ran
cleanly and measured less than it appeared to.
