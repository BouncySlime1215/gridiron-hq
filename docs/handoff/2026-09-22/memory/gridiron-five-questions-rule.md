---
name: gridiron-five-questions-rule
description: Nick's 2026-09-20 standing rule — before calling any number, feature or page done, answer in writing whether it is well built, stats or made up, how we know, where else on the platform it should point, and how it unifies.
metadata:
  type: feedback
---

Nick, 2026-09-20 01:21Z, in the Model evidence audit thread, verbatim:

"You need to seriously consider ok is this well built: is this based on stats, is this just made up. How do we know this. Audit the structure. Audit the overall build. Ask if this data should be pointed anywhere else on the platform. How can we unify everything. ASK YOURSELF THAT EVERY TIME."

**Why:** the same evening he asked whether opportunity, trade fairness/acceptance/value and team strength are "fr tested" or guessed. He wants the model smart, not plausible.

**How to apply:** every PR body and every docs/tdd evidence file carries a five-line block:

1. Well built?
2. Stats or made up?
3. How we know: backtest (seasons, metric, number), hand-set constant, or nothing.
4. Pointed anywhere else on the platform?
5. How it unifies.

Say "guess" plainly when it is one. Verify the consumer, not the producer. Cite file:line on origin/main.

Added to project instructions at 01:23Z and sent to every running thread.

Related: [[gridiron-failure-modes]], [[verify-the-consumer-not-the-producer]], [[gridiron-decision-routing]].
