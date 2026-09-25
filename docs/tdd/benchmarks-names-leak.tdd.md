# TDD record: BENCHMARKS gate + NAMES-LEAK (ONE-PLAN.md night 10)

Base: `main` a913ad8b (tree a090712b).

## Pre-registration

- **BENCHMARKS.** Metric: every row in `BENCHMARKS.md` has an id, a direction, a tolerance, a command,
  and a number or `unmeasured`; `scripts/check-benchmarks.mjs` exits 1 when any row with a baseline
  regresses past its tolerance, 0 otherwise, and never treats a missing or `unknown` value as a pass
  or as 0. Pass bar: `test/benchmarks.test.js` all green; the r50 rows reproduce their baseline on
  this tree. Fails it: a regressed value passing, an absent `number_health` read as 0 broken, or
  `--ratchet` changing any byte other than an improved row's baseline cell.
- **NAMES-LEAK.** Metric: name hits reported by `scripts/check-names-leak.mjs` against a denylist built
  at run time from plans.json's `teams` map. Pass bar: made-up names are found in every plans text
  field and in files, reports carry roster ids and never the name, a missing plans file fails closed
  (exit 2), and every committed plans-shaped fixture carries only placeholder team labels. Fails it:
  any report that prints a name, or a check that passes without a denylist.

## RED (8b730729)

`node --test test/names-leak.test.js test/benchmarks.test.js`: 2 files fail with
`ERR_MODULE_NOT_FOUND` (scripts not written yet). tests 2, pass 0, fail 2.

## GREEN

Same command: tests 12, pass 12, fail 0. The first GREEN run failed one test on a real fixture:
`producer-plans.json` names roster 2's manager `Manager B` (a synthetic placeholder, TEAM-NAMES).
`genericLabel` now accepts `Manager X` as well as `Team N`; the test was right about the shape and
the placeholder list was too narrow.

r50 rows: `node --test test/rb-title.test.js 2>&1 | node scripts/check-benchmarks.mjs --log -`
prints `PASS sim.se_ratio_median: 0.488` and `PASS sim.se_ratio_paired: 0.318` on tree a090712b
(two runs, identical: the harness is seeded).
