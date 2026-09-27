---
name: injected-predicate-hides-the-wiring
description: "A rule that tests a function taking a predicate is not a rule about the predicate — mutate the call site, not just the unit."
metadata:
  type: feedback
  modified: 2026-09-22T17:46:28.186Z
---

When a function takes a predicate, comparator, or any injected dependency, a
test that passes its own predicate in pins **the unit** and says nothing about
**which predicate the caller actually hands it**. Export the real predicate and
pin it directly.

    // Tests entrySplit. Says NOTHING about what the ladder passes it.
    entrySplit({ perFile, isRouteEntry: e => mounted.has(e) && !isBetting(e) })

    // Pins the wiring.
    export function routeEntryPredicate(mounted) { ... }
    assert.equal(routeEntryPredicate(mounted)('server/routes/nfl-betting.js'), false)

**Why:** 2026-09-22, `scripts/reach-ladder.mjs`. The entry split first
reported 227 route / 1 script-only against a frozen 214 / 14 — route-reach
counted any mounted route where the definition excludes betting entries. After
fixing it, **mutation M1 (deleting the betting exclusion from the call site)
survived the entire suite.** The suite would have signed off on the exact bug
just repaired. Exporting `routeEntryPredicate` and pinning it killed M1.

**How to apply:**
- Mutate the **call site**, not only the function body. A mutation run that
  only edits the unit cannot see this class at all.
- Dependency injection makes this shape easy to write and invisible to a
  mutation count — the more injectable the design, the more call-site
  mutations matter.
- A surviving mutation is a finding about the *tests*, not a nuisance.
  Record it as survived, with what repaired it, rather than quietly fixing
  the suite. `docs/tdd/reach-ladder.tdd.md` keeps M1 in its table as
  "survived, then killed by".
- Related: a fixture drawn from the bug is not automatically a test of the
  fix — the same lesson from `enclosingDeclaration` in
  `docs/tdd/symbol-reach.tdd.md`.

See also [[falsy-return-read-as-a-real-negative]] — both are cases where a
check ran green while measuring less than it appeared to.
