---
name: unreachable-branch-no-assertion
description: A code branch no test fixture can reach is protected by no assertion, however many assertions are written about it — found four times in one night on Gridiron HQ by mutation testing.
metadata:
  type: feedback
---

**The rule.** A branch a fixture cannot reach is a branch no assertion protects.
Mutation testing is what finds it; a green suite never will.

**Why:** a test can assert confidently about a rule whose code path its fixture
never enters. The assertion passes for the wrong reason, and the mutation that
breaks the rule survives. Every instance below was a fixture defect, not a code
defect, and each was fixed in the test.

**Four instances, Gridiron HQ, 2026-09-19/20, all in one night:**

1. **A gate tested at its own boundary from the wrong side.** G9e's fixture used
   luck `n = 4` against `min_n` 4, so `4 < 4` is false and the test never
   reached the branch it claimed to protect.
2. **A stamp fixture where every row shared one second.** `MIN` and `MAX` return
   the same value, so a MIN-for-MAX mutation is invisible. Happened twice, once
   per store (`league_transactions_raw`, then `manager_archetypes`).
3. **An "absent" case tested on a league that had the data.** The "no rows" test
   used a league with signals, so hanging the block off `available` changed
   nothing asserted.
4. **A whole early-return path with no test in any file.**
   `counterparty-pricing.js#selfRead`'s `me == null` branch — every fixture
   league in both test files defaults `my_team_id` to `'1'`, so nothing had ever
   entered it.

**How to apply.** Before trusting a test of a rule, ask what value in the fixture
makes the code enter that branch, and whether a second fixture value would make
it leave. Two unequal values where the rule compares two things; a value strictly
past a threshold, not at it; and one fixture per early return. Then run the
mutation — a NO-OP injection is a defect in the injection, and a surviving
APPLIED one is a defect in the fixture until proven otherwise.

Related: [[gridiron-a-cited-proof-is-not-a-proof]],
[[trade-brain-transactions-as-of]], [[gridiron-failure-modes]].
