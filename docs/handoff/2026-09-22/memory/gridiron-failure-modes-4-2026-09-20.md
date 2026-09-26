---
name: gridiron-failure-modes-4-2026-09-20
description: Page 4 of the gridiron-hq "healthy-looking and not working" catalogue and rules; entries from 06:46Z 2026-09-20 on that did not fit on page 3.
metadata:
  type: project
---

Continues [[gridiron-failure-modes-3-2026-09-20]] (pages 1-2: [[gridiron-failure-modes]], [[gridiron-failure-modes-2-2026-09-20]]).

**Catalogue (cont.):** (20) a field's test runs in the state where the field is never evaluated (test/projection-fit-meta.test.js runs with no active fit, so projectionFitMeta is null and the three #58 fields never evaluated), so the field is deletable with the suite green (fantasy plan, 06:46Z; rule: a "we have a test for that field" claim names the state the test runs in); (21) a payload builder handed a ready-made description can describe a build with arguments the build never saw (tradeImpact computed simProjectionBasis and returned no basis or fit meta; rule: derive the description from the same opts the build used).

**(22)-(24), feature audit 06:48Z:** (22) a column-writer sweep that reads INSERT column lists cannot see a schema DEFAULT (draft_pick_corrections.applied_at is a DEFAULT at core-and-fantasy.js:579, reported "written nowhere"; rule: defaults and triggers are writers); (23) throwing after the fetch still refuses and still writes nothing and is still wrong, because a request left the process (espn-market.js e3, caught only by a counting fetch stub; rule: assert on the recorded call list, not the outcome); (24) a test that fails only when two branches are both present turns main red between two green merges (the local DEFAULT_ACTIVE_PROBABILITY tripwire; rule: no cross-branch tripwire; sequence the PRs instead).

**(25), Opportunity 06:50Z:** one exported name in two modules with different meanings (buildSeasonRows in opportunity-model.js and preseason-model.js), routed around by comments in three files and by a docstring that disagreed with the code; fixed by rename (buildOpportunityRows). Rule: a comment that disambiguates a symbol by module is a rename waiting to happen.

**(26), wiring map 06:54Z:** a checker written the obvious way (same-name-two-modules without guards) returns 1,895 rows and dies of being unreadable; with three guards (exactly two modules, different arguments or tables, neither imports the other) it returns 31 and finds gameScriptFor() with swapped arguments. Rule: a rule's filter is part of the rule; pin the guards in a test (test 64).

**(27)-(29), 06:56Z-07:00Z:** (27) a grep count that includes comment mentions reports consumers that do not exist (Trade Brain: five not nine, the manager-archetypes shape again; rule: read every hit; split dials from mentions; the split is now a list column); (28) a state-writing route with refs 0 can silently behave like its neighbour and pass every test (POST /api/auth/logout-all as logout, 2,984 green; rule: a zero-reference route that writes state gets a behavioural test before any verdict; the zero-reference column is a finding generator, not just a deletion list); (29) a list titled "dead routes" with no status column is read by its title (nine kept auth routes would have been cut, incl. the invite the morning plan uses; rule: any list that drives deletion carries a per-row verdict, never a heading-level one).

Continues (entries from 07:03Z on): [[gridiron-failure-modes-5-2026-09-20]].
