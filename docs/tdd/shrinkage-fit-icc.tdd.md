# fitK gains an ICC field

2026-09-22. `server/services/shrinkage-fit.js` (additive: `fitK` return gains
`icc`), `test/shrinkage-fit.test.js` (new). Off `main` `654ff93`, on branch
`effk`.

## Where this came from

Data & techniques R&D (`RELIABILITY-SPEC.md`, delivered 2026-09-22T04:38Z,
routed by the coordinator) measured intraclass correlation (ICC) for the
volume/share/efficiency metrics the fantasy model reads, using its own
standalone scripts (`icc.mjs`, `shares.mjs`) against free nflverse data —
201-479 players, 4,779-13,387 player-weeks per fit, 2022-2025 REG. Their
headline finding: PPR points in a week have ICC 0.259 — roughly three
quarters of a player's week-to-week point variance is not the player. Volume
and share are the solid ground (carry share 0.792, target share 0.611);
efficiency outcomes (catch %, cushion, YAC over expected) are mostly noise.

Their key implementation fact: `fitK` (this file, lines 120-164) already
computes `sigma2_within` and `sigma2_between` — the ICC is one line nobody had
taken, `icc = sigma2_between / (sigma2_between + sigma2_within)`. Their
scripts exist to produce reference numbers to check an in-repo implementation
against, not to be the implementation.

**Scope of this unit.** R&D's spec (§6) also calls for a `nfl_metric_reliability`
persistence table with a `weighting_scheme` column, fitted specs for ten+
metrics, and a gate proving shrinkage beats not-shrinking on held-out seasons
via `backtest.js`. That is real, separable work — persistence schema, a
migration, a fitting job, and a walk-forward ablation harness are each their
own unit under this session's small-units discipline. This unit is scoped to
exactly the "one line" R&D flagged: `fitK`'s return gains `icc`. Reported back
to the coordinator/R&D as its own step, not bundled with the larger build.

## What this adds

One field on `fitK`'s existing return object: `icc`, computed from the two
variance components `fitK` already produces, guarded the same way `k` already
is (a `sigma2Between > 1e-9` check) so a genuinely zero-variance fit returns
`icc: 0` rather than `NaN` from a `0/0` division.

**Not invariant to weighting, by design — R&D's own correction (`RELIABILITY-
SPEC.md` §4) is carried into this file's comment on the line itself:**
`sigma2_within` scales with the observations' weights while `sigma2_between`
does not, so two fits of the same metric at different weights are not
comparable. R&D's demonstration: target share reads ICC 0.611 at flat weight
and 0.041 weighted by team pass attempts on identical rows — a 15x swing from
weighting alone, which is what produced their retracted first-pass headline.
Any future caller persisting or comparing `icc` values must hold the weighting
scheme fixed, per R&D's `weighting_scheme` column requirement — not built
here, but the reason it exists is written into this file now so nobody
rediscovers it the hard way.

**Existing consumer checked, not just assumed safe:** `fitK` is reused outside
this file by `server/services/mlb-shrinkage-fit.js` (`fitTeamFirstInningK`,
`nrfiKs`), tested directly in `test/mlb-nrfi-shrinkage.test.js`. That consumer
only reads `.k` from `fitK`'s return and asserts no exact-shape/exact-keys
check anywhere in its test — confirmed by reading both files before adding
the field, not assumed. `test/mlb-nrfi-shrinkage.test.js` was re-run alongside
this unit's own suite and stayed green, confirming the addition is additive
and doesn't disturb the MLB reuse.

## Mutations

Base `shrinkage-fit.js` = `7a333e50e11c`. Each row applied alone from a clean
base via the sweep runner, hashed before/after, file restored at the end.

| # | mutation | result | first sweep |
|---|---|---|---|
| I1 | `icc` always reports 0 regardless of variance components | 2 fail | 2 fail |
| I2 | formula inverted (within/total instead of between/total) | 2 fail | 2 fail |
| I3 | the `sigma2Between > 1e-9` guard removed | 1 fail | **survived, 0** |
| I4 | `icc` dropped from the returned object entirely | 4 fail | 4 fail |

**I3 survived the first sweep at 0 fail, the same pattern established
repeatedly this session (S6/P9, F1/F3/F9, L8/L10, L13/L14 on other files):**
the only fixture exercising near-zero `sigma2_between` (all groups sharing the
same five values) still had nonzero *within*-group spread (`1,2,3,4,5` varies
inside a group), so `0 / (0 + positive)` already evaluates to `0` with or
without the guard — the guard's actual job, protecting `0 / 0`, was never
exercised. Closed with a second, narrower fixture where every single
observation across every group is the literal same number (`7`), making
*both* variance components exactly zero — an unguarded division there
produces `NaN`, which the new test catches directly. Re-swept: 4/4 rows
caught, 0 survivors.

## Numbers

RED (`014441e`): 4 of 6 tests failed as expected (`icc` undefined); the 5th
guard test and the pre-existing null-on-thin-data test passed unchanged,
confirming this was additive from the start. GREEN, before closing the I3
survivor: 5 tests, 5 passed. After adding the 0/0 test: **6 tests, 6 passed,
0 failed** in `shrinkage-fit.test.js`. `mlb-nrfi-shrinkage.test.js` (fitK's
other real consumer) re-run alongside: 4/4 passed, unaffected.

Full local check `npm run check` on `effk`, this commit (staged before the
run, `git write-tree` = `187de46d8f959918d4716487004a6370d0d89af6` immediately
before `npm run check` started): exit 0 — **3,016 tests, 2,975 passed, 0
failed, 41 skipped**; typecheck, lint and build clean; `start:smoke` passed on
an isolated database (32 teams). Delta from the prior full-check baseline
(3,010/2,969/0/41, this branch's `ccca336` commit): exactly **+6/+6/0/0**,
matching this unit's own new test count precisely.

**Isolation, stated rather than implied:** source-isolated — one working
tree, shared `node_modules`, no install during the run.

## The five questions

**Is this well built?** One field, additive, guarded against the same
edge case `k` already guards against, with the non-invariance-to-weighting
caveat written directly into the code comment rather than left only in a
spec file someone has to go find.

**Is this based on stats, or is it made up?** The formula is R&D's own,
cross-checked against `fitK`'s actual variance-component math by reading the
function before writing the test, not assumed from their spec text. The
arithmetic is pinned exactly (`assert.equal(fit.icc, expected)` against the
formula computed independently in the test), not just approximately.

**How do we know?** Four mutations, one survivor closed with a targeted 0/0
edge case; the existing external consumer (`mlb-shrinkage-fit.js` via
`mlb-nrfi-shrinkage.test.js`) re-run and confirmed unaffected rather than
assumed safe from reading the code alone.

**Should this data be pointed anywhere else on the platform?** Yes — this is
step one of R&D's three-step handoff (icc field → persisted
`nfl_metric_reliability` table with `weighting_scheme` → a shrink-vs-no-shrink
ablation gate via `backtest.js`). Steps two and three are separate units, not
started here.

**How does it unify?** Same variance decomposition `k` already used for
shrinkage now also answers "how reliable is this metric, in a 0-1 scale
anyone can read" — one estimator, two readings, no second implementation to
keep in sync.
