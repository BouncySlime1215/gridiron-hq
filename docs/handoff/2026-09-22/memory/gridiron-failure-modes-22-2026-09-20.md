---
name: gridiron-failure-modes-22-2026-09-20
description: Page 22 of the gridiron-hq "healthy-looking and not working" catalogue and rules; entries from 13:05Z 2026-09-20 on (216 onward), all from the Coach thread's union-of-reds pass.
metadata:
  type: project
---

Continues [[gridiron-failure-modes-21-2026-09-20]] (earlier pages: [[gridiron-failure-modes]],
[[gridiron-failure-modes-2-2026-09-20]] to [[gridiron-failure-modes-20-2026-09-20]]).

**Catalogue (cont.), all found by the union-of-reds check on the Coach suites (13:05Z, hold 3ba9ec4):**

(216) A rounding allowance loosened into a **tolerance** with no test on the boundary: Coach's
grounding check matched a claim's number against a cited cell "at the precision the claim stated
it to"; widening that to "within one at that precision" turned nothing red, so 12 targets against
a row holding 11 would have shipped **with a citation attached** — worse than an uncited number,
because the cite makes it look checked. Rule: every allowance (rounding, percentage form,
unit conversion) needs a test one step outside it, or it is a tolerance nobody bounded.

(217) A test that **proved the outcome, not the mechanism**. "values are bound, so a value that
looks like SQL stays a value" asserted that `'; DROP TABLE players; --` returned no rows and that
the table still held two. Both are true when the parameters are pasted into the SQL instead of
bound, because the connection is read-only and SQLite compiles only the first statement — so the
injection survived. Rule: when a guard's outcome is also produced by the failure it guards
against, assert something only the guard produces (here: a value that changes what the query
MEANS if pasted in, the placeholder still in the statement that ran, the parameter kept beside
it).

(218) An assertion that **cannot fail at any behaviour of the system**: `assert.doesNotMatch` over
action phrasings, run against a paragraph the test itself wrote, through a route that returns the
model's wording verbatim. Only editing the fixture could turn it red. Rule: if no change to the
code can make an assertion fail, it is documentation; assert the guarantee that exists (here the
response shape and the audit's `wording_only`) and write down what is not guaranteed.

(219) Three mutation rows reported **NOT APPLIED** because the files had moved under them
(a signature gained a parameter, a return grew a field). Without the anchor check all three would
have scored zero failures and read as "tests that notice nothing". Rule: a sweep re-run after any
edit to its target files, and an anchor miss is a loud status, never a zero.

(220) A **count in a code comment** ("eleven tables") that a later repo-wide scan contradicted
(nineteen). Replaced with a pointer to the measured breakdown rather than a fresh number. Rule:
a count belongs where it is measured, not in prose that nothing re-measures.

**Rule (cont.):** the mutation harness runs the project's own test command
(`--experimental-test-module-mocks`, the offline guard, a temp database); a suite that mocks a
module will not load under a bare `node --test`, and a suite that will not load scores zero
failures, which reads exactly like an injection the tests survive.

(221) A **source that cannot say which point in time it describes**, used where the caller has not
established that point independently. `off_depth_chart` is documented as opening-week ordering
only, so a panel rendering it unlabelled shows a March chart — before free agency and the draft —
as if it were this week's. `off_sleeper_players` has no season column, so defaulting the current
season to the season being asked about makes a live snapshot eligible for ANY season and answers a
request for 2023 with today's chart. Rule: such a source may be used ONLY when the caller has
established the point in time independently. The shape is a listing presented as belonging to a
time it does not belong to (both 2026-09-20).
