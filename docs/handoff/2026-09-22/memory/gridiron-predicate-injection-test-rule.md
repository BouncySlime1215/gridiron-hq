---
name: gridiron-predicate-injection-test-rule
description: Fleet rule (Opportunity M1, 17:49Z) — a rule that tests a predicate-taking function is not a rule about the predicate; pin the injected predicate directly, because a unit-only mutation count cannot see a predicate that was deleted at the call site
metadata:
  type: project
  modified: 2026-09-22T17:57:00.000Z
---
**Why:** Opportunity's reach-ladder command ([[gridiron-state-1277-2026-09-22]]) ran 14 rules and 6 mutations. Mutation M1 deleted the betting exclusion at the call site — the production code stopped excluding betting-only routes — and every rule still passed. The rule for the exclusion called the predicate-taking function and handed it the rule's OWN predicate, so the test exercised the function's plumbing and never the predicate production actually injects. The same defect had already shown up as data: the first entry split read 227/1 because route-reach counted 13 betting-only route files. Fixed by exporting `routeEntryPredicate` and pinning it directly; M1 now dies. A companion bug in the same batch (`schedulerInvokedScripts` substring match) is of the same family: the test passed a shape, not the value the caller supplies.

**How to apply:**
1. When production wires `f(predicate)` (or any injected callback, comparator, filter, config), the tests need TWO rules: one on `f` with a fixture predicate, and one that imports the production predicate by name and pins its verdict on known-in / known-out cases.
2. If the injected value is not exported, export it for the test rather than re-declaring it inside the test — a re-declared predicate can only agree with itself.
3. Mutation counts: a mutation applied at the CALL SITE (delete the argument, swap the predicate, pass the identity) must be in the mutation set; a unit-only mutation set that never touches the wiring cannot see this class.
4. In the evidence file, state which predicate each rule pins and whether it is the production one or a fixture.
Pairs with [[assertion-must-name-the-thing-it-guards]], [[a-duplicated-guard-hides-a-missing-test]] and [[gridiron-contradiction-test-rule]].
