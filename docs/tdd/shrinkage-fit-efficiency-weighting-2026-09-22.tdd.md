# The efficiency-metric fitter was weighting by raw opportunity count, not by RECENCY

2026-09-22. `server/services/shrinkage-fit.js` (`efficiencyObservations`, and
its 8 call sites in `buildFitSpecs`), `test/shrinkage-fit-efficiency-
weighting.test.js` (new). Off `main` `654ff93`.

## The defect (Auditor-verified, relayed by the coordinator)

`buildFitSpecs` (`:322`) computes `effW = efficiencyWeightFor(through)` — a
`(season, week) => weight` function under `RECENCY` — and never passes it
anywhere. A whole-repo grep for `efficiencyWeightFor|effW` returns only its
own definition and that one dead assignment. Every efficiency spec (`ypt`,
`catch_rate`, `rec_td_rate`, `ypc`, `rush_td_rate`, `ypa`, `pass_td_rate`,
`int_rate` — 8 call sites, 18 (metric, position) pairs) was built by
`efficiencyObservations(log, position, oppField, valueFn)`, which hardcoded
`weight: opp` — the raw opportunity count that week, with **no season
recency applied at all**.

That is not the unit production actually fits against. `projections.js`
accumulates `a.targets += w * (u.targets ?? 0)` where `w = rowWeight(u,
through, throughWeek, r)` under `RECENCY` (a season-old game counts 0.35x),
and that weighted sum is exactly the `n` `pickK()` receives for
`ypt`/`catch_rate` (`a.carries`/`a.attempts` likewise for `ypc`/`ypa`). A `k`
fit against raw, undecayed opportunity counts is the minimum-MSE constant
for a quantity production never computes — `sigma2_within`/`sigma2_between`
both come out scaled wrong, and `k = sigma2_within / sigma2_between` carries
that error into every efficiency shrink.

Why it survived: `buildFitSpecs` had no test. `test/shrinkage-fit.test.js`
only exercises `fitK` directly on hand-built `{group, weight, value}` rows —
never through `buildFitSpecs` or `efficiencyObservations`, so the missing
weight factor produced no visible failure anywhere.

## The fix

`efficiencyObservations` now takes a `weightFn` parameter and computes
`weight: weightFn(u.season, u.week) * opp` — recency times raw opportunity,
matching `projections.js`'s own `w * (u.targets ?? 0)` construction exactly.
All 8 call sites in `buildFitSpecs` now pass `effW`. No other function
changed; `roleWeightFor`/`recencyObservations` (the volume side) already did
this correctly — this fix brings the efficiency side to the same standard
the file's own header comment (`:73-80`) already claims for it.

## The numbers this actually moves

Re-ran `fitAllK(2024)` before and after, filtered to the 8 efficiency
metrics (18 rows). `ypt`, the metric this session has the most context on:

| position | k, before (raw opp) | k, after (RECENCY-weighted opp) |
|---|---:|---:|
| WR | 138.45 | 28.91 |
| RB | 272.74 | 24.07 |
| TE | 154.10 | 24.71 |

The coordinator's relayed baseline for this fix cited **125.79/138.19/175.71**
as the unfixed figures and **"~33-41 when fixed"** from a free-data proxy.
This container's real fit reproduces the same *qualitative* result — the fix
drops every position's `k` by roughly 5-11x, landing in the same rough
decade as the proxy's 33-41 — but the exact unfixed numbers measured here
(138.45/272.74/154.10) do not match the relayed triple, and the fixed
numbers (24-29) land somewhat below the proxy's 33-41 rather than inside it.
Both readings are real measurements, not typos of each other, most plausibly
because the two fits ran against different states of this container's
shared `server/data.sqlite` (other threads have been writing to it
throughout this session) or a different `through` season. Reported as
measured rather than adjusted to match the relayed figures.

**No constant in `projections.js` moves as a result of this number.**
`projections.js` is Fantasy plan's file under the one-editor rule, and per
the coordinator's instruction this unit's job is the fitter's correctness,
not a promotion decision — the Auditor's ruling, not this file's.

## Mutations

Base `shrinkage-fit.js` = `333eb70997b1`. Each row applied alone from a
clean base via the sweep runner, hashed before/after, file restored at the
end. Test file carries three fixtures isolating both factors of the fix:
players 1/2 share opportunity counts but differ by season (tests the
recency factor), players 1/3 share season but differ by opportunity count
(tests the opp factor) — chosen because a mutation dropping the opp
multiplier would otherwise pass a recency-only assertion (the season ratio
is unaffected by whether `opp` is included, since it cancels in the ratio).

| # | mutation | result |
|---|---|---|
| M1 | drop the opp multiplier, keep only the recency factor | 1 fail |
| M2 | drop the recency factor, revert to raw `opp` (the original bug) | 1 fail |
| M3 | invert the positive-weight guard | 1 fail |
| M4 | swap the `season`/`week` arguments passed to `weightFn` | 1 fail |

4/4 caught, 0 survivors.

## Numbers

RED: 1 test, 1 failed (`ratio 1` where `0.35` expected — the bug reported
the prior-season and current-season rows as equal weight). GREEN: 1 test, 1
passed. Existing coverage of the module unaffected:
`test/shrinkage-fit.test.js` (20 tests, `fitK`'s own ICC/k arithmetic —
untouched, since this fix only changes what's passed *into* `fitK`, not
`fitK` itself), `test/nfl-metric-reliability.test.js`,
`test/mlb-nrfi-shrinkage.test.js` all still pass.

Full local check `npm run check`: exit 0, **3,056 tests, 3,015 passed, 0
failed, 41 skipped** (delta from `da5738e`'s 3,055/3,014/0/41: +1/+1/0/0,
exactly this unit's one new test). Atomic guard (single subshell,
`git status --porcelain` + `git write-tree` + `node_modules` mtime,
before/after): stable both sides, no other write landed mid-run.

## The five questions

**Is this well built?** One parameter added to one function, one line
changed at each of 8 call sites — the smallest change that closes the
recorded defect, nothing else touched.

**Is this based on stats, or is it made up?** The fix makes the fitter's
weighting match a specific, cited line of production code
(`projections.js`'s `a.targets += w * u.targets`) exactly, not a guess at
what "should" matter.

**How do we know?** RED before, GREEN after, 4 mutations with 0 survivors,
both halves of the fix (recency, opportunity count) isolated by separate
fixture players so neither factor could hide behind the other.

**Should this data be pointed anywhere else on the platform?** The new
per-position efficiency `k` values are reported here for the Auditor's
ruling, not applied — `activeKVector()`/`saveFit` are untouched by this
unit, so nothing here is live in production. The unfixed-baseline mismatch
(this run's 138.45/272.74/154.10 vs. the relayed 125.79/138.19/175.71)
should be reconciled before either number is treated as canonical.

**How does it unify?** Same pattern as this session's other fixes: a
component computed and never wired in (`effW`, like the discarded
`positionalPriors` share arrays found while answering Unit 2's criterion 3)
is exactly the kind of defect a bare `node --test` or a passing suite
cannot surface, because nothing failed — the fitter ran, just against the
wrong units, and the mutation sweep is what proves a test now actually
watches the wiring rather than merely exercising it.
