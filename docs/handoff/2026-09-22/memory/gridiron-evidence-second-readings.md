---
name: gridiron-evidence-second-readings
description: Running log of Gridiron HQ evidence files the model evidence audit thread has re-run as second reader — what reproduced and what did not — so a file is not re-graded twice.
metadata:
  type: project
---

Standing second reader for each thread's TDD evidence file once its head lands
(coordinator, 2026-09-20). Method: detached worktree at the exact commit,
`node_modules` symlinked, test file re-run, mutations re-applied with SHA-256
before and after, full suite run. Nothing taken on report. The standard and the
first eight files: [[gridiron-evidence-file-standard-review]].

## `setup-status-usage-coverage.tdd.md` @ 52a55cc (wiring map)

**Everything reproduced**: RED 6/0/6 (at 84bae8a), GREEN 6/6, full suite
**2,969 / 2,928 / 0 / 41**, and all six injections against
`server/routes/model.js` from `bca51a0250ee` with their exact counts and
killed-by sets, control NO-OP. First whole sweep reproduced independently.

**The gap — the converse of the sixth part: no mutation kills its test 6**
(`once the season is held the disagreement clears`); the killed-by union is
{1,2,3,4,5}. All six break the check so it *misses* a lie; none forces a
disagreement on a healthy feed. It is killable, so this is a missing mutation,
not an untestable test: `if (usage_coverage.stamp_disagrees)` → `if (true)`
(`bca51a0250ee` → `5dd1178ded6d`) gives **3 pass / 3 fail**, red on 4, 5, 6.
It matters because this renders on every page through `DataSetupBanner`, so
test 6 is all that stands between a healthy feed and a false "reports success
but holds no rows". **Seventh part of the standard, from this: an unkilled TEST
is reported like an unkilled mutation.** Otherwise the strongest content in the
set — it discloses that its own RED is weak and rests the proof on the
mutations, which is the right call and the right disclosure.

## `availability-basis-vocabulary.tdd.md` @ dd84efa (Opportunity)

**Now a reference implementation alongside Google sign-in's, and it
reproduces.** It answered every finding against its 775e339 version: test FILE
named per row (two suites), both controls named and their jobs distinguished
(NO-OP vs KILL-CONTROL), the earlier survivor recorded and closed rather than
dropped, whole-suite line added. Base hashes exact (`contingency.js`
`28bffcd49d70`, `availability-basis.js` `6de130fcae48`, both byte-identical to
775e339, so e53ff1a changed only the test and the doc); baseline 12/12/0.
**The closed survivor reproduces exactly**: mislabelling the role arm as pooled
gives `28bffcd4` → `3d5a1175`, 1 fail, on the test that names it. Rows 1, 3, 6
and both controls reproduce hash-for-hash.

**Third reading confirmed, not taken on report.** Opportunity's independent
re-run of fantasy plan's two tables
(`/mnt/project-files/mutation-reproduction-2026-09-20-opportunity.md`) is
sound. Spot-checked its most consequential row: M4 at 761af34 gives
`9b794700`, 0 fail, as claimed, and a kill-control of mine (`{supplied:
kOverride}` → `'supplied'`, `51fe1716` → `74602a89`, 5/1) proves that suite can
fail on that function — so M4's zero is a real equivalent mutant. **The 52a55cc
table is this thread's, not Opportunity's.** Their one stated gap: M5's
cross-file claim (54 tests elsewhere) was never run.

**Proposed eighth part: quote the mutation's exact before/after text, never
describe it.** 5 of the 18 rows Opportunity re-ran had after-hashes underivable
from their description and 3 needed a second attempt; 3 of my 8 at dd84efa
diverged the same way. Every claim still held — but a described edit can only
be confirmed, not re-run, which is what the hashes exist for.
