---
name: gridiron-fit-against-the-served-prior
description: "Standing gate-1 item (Auditor R34): before fitting a constant, read the applying line and state what production actually does with the quantity, then fit against THAT — not against a convenient pooled version."
metadata:
  type: feedback
---
Registered by the Auditor, 2026-09-22 (R34), after it ended Explorer's `K.yards_per` finding.

**Before fitting anything, state what production does with the quantity, read off the applying line, and fit against that.**

**Why:** Explorer fit `K.yards_per` against a **pooled** prior mu = 7.3515 because the source file (`targets.jsonl`) had no position column. `projections.js:562` shrinks toward `prior.ypt` **per position**. The prior fitted was not the prior served, and the k-mu sensitivity table showed a one-yard move in mu takes the train-chosen k from 64 to 35 — the incumbent — and deletes the advantage entirely. **That mismatch alone ended the finding**, independently of the identified-set and interval problems. It was checkable before a single number was computed.

**How to apply:** the gate-1 checklist for any constant proposal now opens with three lines — the applying line as `file:line`, what it shrinks/compares/divides against in production, and confirmation that the candidate fit uses the same thing. If the evidence source cannot supply it (no position column, no team split), that is a **blocker to state up front**, not a limitation to note at the end.

Companions kept from the same package, also mandatory: the **identified-set method** (report the set of values the data cannot distinguish from the best, not a point) on every constant proposal, and a **sensitivity table** for any parameter jointly fitted with another. [[gridiron-k-yards-per-heldout-2026-09-22]] [[gridiron-burned-seasons-rule]]
