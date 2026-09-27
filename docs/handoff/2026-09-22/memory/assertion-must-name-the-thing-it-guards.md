---
name: assertion-must-name-the-thing-it-guards
description: Five of twenty-one mutations survived their first pass on 2026-09-20 and all five were test defects of one shape — the assertion named something adjacent to the guarantee, so deleting the guarantee left it passing.
metadata:
  type: feedback
  modified: 2026-09-20T07:37:11.585Z
---

**An assertion that still passes when the thing it names is removed is not an
assertion about that thing.** On 2026-09-20, across the valuation panel, the chat
as-of block and the cross-account security probe, twenty-one mutations were run
and five survived the first pass. Every one of the five was a hole in the test,
not in the code, and all five were this shape.

**Three sub-shapes, all seen the same night:**

1. **Asserting on the field while claiming a guarantee about the sentence.** The
   chat block's absent-corpus state had to *say* which path it looked at. The
   test asserted `body.chat.path === env`, which is a different field. Removing
   the path from the sentence changed nothing. Fixed by asserting
   `reason.includes(path)`.
2. **A regex loose enough to match a neighbour.** The same sentence had to name
   `POST /api/league-chat/upload`. The test matched `/upload/i`, and the adjacent
   clause says "uploaded", so deleting the route name still passed. Fixed by
   matching the route.
3. **Asserting the shape of an answer rather than which answer it is.** A test of
   an unpriced player asserted its `reason` was a long string. Two different
   absences — a player nobody priced and a layer never built — both produce long
   strings, and so does the route's own crash handler. Fixed by asserting the two
   absences differ from each other, and that neither is the error path.

**How to apply.** After writing an assertion, ask what single edit to the code
would make the guarantee false, and check the assertion fails on it — that is
what the mutation harness is for ([[mutation-evidence-must-show-applied]]). Where
the guarantee is about user-facing words, assert on the words. Where it is about
which of several states was reached, assert the states are distinguishable rather
than pinning one's wording.

**An assertion about an IMPORT proves what was imported, never what was used.**
The defeating shape is to import the right thing and use the wrong thing, which
an import-line assertion passes unchanged. Catching it needs the forbidden
identifier asserted ABSENT FROM THE CODE with comments stripped — necessary
precisely when the file header and the evidence file discuss that function by
name. Instance: the fantasy plan thread's C7 row on 430cba3, 2026-09-20.

**A hand-kept list is the same defect with a delay.**
`test/cross-account-league-access.test.js` named thirteen routes to probe for a
cross-account leak. Deleting five of them turned a security assertion into a 404
— red for the right reason, once. The danger is the other direction: add a
league-scoped route, forget this file, and it goes green while unprobed. It is
now derived from the router's own stack with a floor on how many it found, so an
empty derivation cannot pass. **Any security list a human maintains by hand will
eventually pass for the wrong reason.**

Related: [[mutation-sweep-finds-vacuous-tests]] (fixtures that cannot produce the
signal), [[unreachable-branch-no-assertion]] (branches no test can enter),
[[gridiron-test-fixture-traps]].
