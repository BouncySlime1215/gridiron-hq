---
name: gridiron-comment-right-assert-wrong-lesson
description: Lesson (Wiring map, 17:39Z) — a test can hold the correct reasoning in its comment and the wrong claim in its assert; when a guard run fails on a pinned test, read the comment against the assertion before touching either
metadata:
  type: feedback
  modified: 2026-09-22T17:41:00.000Z
---
**Why:** Wiring map's gate fix (c3527d4a) failed its own first guard run on one test: `test/wiring-map.test.js` pinned "an unrecognised nflDb receiver falls through to the 'app' handle". The comment above the assertion explained correctly why the fallthrough was a false-positive source; the assertion nevertheless pinned the fallthrough as the wanted behaviour. The fix reversed the assertion, kept the comment's reasoning as the reason, 90/90, new head ae84ac6d ([[gridiron-state-1259-2026-09-22]]). Auditor asked to rule on the reversal.

**How to apply:**
1. When a guard run fails on a pinned test, read the test's comment and its assertion as two separate claims; decide which one the evidence supports before editing.
2. Reversing a pin is a behaviour change, not a fix: say so in the commit subject, keep the old assertion in the evidence file as "incumbent behaviour to beat", and route it to the Auditor when the pinned surface is model/projection/trade/lineup code (same bar as Feature audit's `trade-evidence.test.js` rewrite, Auditor R50).
3. Never push a head whose own guard is red.
Pairs with [[assertion-must-name-the-thing-it-guards]] and [[a-duplicated-guard-hides-a-missing-test]].
