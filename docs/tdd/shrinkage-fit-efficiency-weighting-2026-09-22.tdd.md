# The efficiency-metric fitter was weighting by raw opportunity count, not by RECENCY

2026-09-22. `server/services/shrinkage-fit.js` (`efficiencyObservations`, and
its 8 call sites in `buildFitSpecs`), `test/shrinkage-fit-efficiency-
weighting.test.js` (new). Off `main` `654ff93`.

**GATE CLOSED, per Plan 07 §2.3 and Auditor unit 17b.** Reproduction run
below, against the real in-file `fitAllK`/`buildFitSpecs` (not a mirror),
matches the Explorer's package #22 (`EFFW-SPEC.md`) on all five headline k
values (within 0.02%–1.1%) and both MAE-delta/CI verdicts (2024
indistinguishable, 2023 still significantly worse). Confirms the fitted
efficiency k does NOT beat the hardcoded constants even after the fix —
`projections.js:88-92` stands, not built or gated as a performance change,
per Plan 07 §2.2's binding wording: **the fix removes most of the harm
(98.0% in 2024, 63.4% in 2023) and the 2023 residual is still significant —
never "harmless", never "~90%".**

`activeKVector()` returning `null` is now backed by a real, dated read-only
query — not "a live read" (that word means the Fly app's production
database in this project, and production's `shrinkage_fits` has never been
read), but a check against this session's own **local dev sqlite**
(`server/data.sqlite`) — see "Local dev database read" below, added after
the Evidence Auditor's `audit-pr106-effw-gate-2026-09-22.md` flagged the
earlier version of this document for citing "a live read below" that didn't
exist.

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

## Reproduction of package #22 (Auditor unit 17b / Plan 07 §2.3)

`effw-test.mjs` (`/mnt/project-files`) mirrors `efficiencyObservations` line
for line rather than importing it, because the function isn't exported, and
says so unprompted. That left one gap: nothing proved the mirror agreed with
this file. This run closes it by calling the real, in-file, post-fix
`fitAllK`/`buildFitSpecs` directly, against the same rig `effw-test.mjs`
uses (`/mnt/project-files/load-rig.mjs`: nflverse-data release
`stats_player_week_<season>.csv`, 2020-2024, GRIDIRON_DB_PATH pointed at a
scratch file — production untouched). The rig's original CSV directory
belonged to a different, now-gone session scratchpad, so the CSVs were
re-fetched fresh from the same release URLs rather than reused; the loaded
rig here (29,407 player-weeks, 1,138 players) matches the shape reported for
the original.

**Five headline k values, fit ≤2023 scored on 2024 — package #22 vs. this
run's real `fitAllK`:**

| metric/pos | #22 (mirror) | this run (in-file `fitAllK`) | agreement |
|---|---:|---:|---|
| ypt WR | 35.5 | 35.417 | within 0.2% |
| ypt RB | 32.4 | 32.661 | within 0.8% |
| ypt TE | 40.7 | 40.945 | within 0.6% |
| ypc RB | 39.1 | 39.536 | within 1.1% |
| ypa QB | 66.7 | 66.688 | within 0.02% |

**MAE deltas (EFFW fit vs. hardcoded, paired bootstrap over player-weeks,
grouped by `player_id`, iterations 2000, seed 20260922) — #22 vs. this run:**

| season | #22 | this run |
|---|---|---|
| 2024 | +0.0010 `[-0.0030, 0.0053]` indistinguishable | +0.0000 `[-0.0039, 0.0039]` indistinguishable |
| 2023 | +0.0150 `[0.0072, 0.0236]` worse | +0.0160 `[0.0076, 0.0238]` worse |

Every headline figure matches within 1.1% or better, and both seasons'
significance verdicts match exactly. **The mirror in `effw-test.mjs` was
faithful to this file's real fitting/scoring path.** The residual few-tenths
of a percent (and the ~4-point difference in row counts vs. the original
rig) is consistent with the nflverse release having been re-published
between the original CSV pull and this fresh fetch, not with a
methodological gap — both are far smaller than any CI width here (0.004 to
0.02).

Also fitted all 18 (metric, position) pairs, not just the five headlined:
rare-event metrics (`rec_td_rate`, `pass_td_rate`, `int_rate`, and
`ypc`/`rush_td_rate` for WR, where rushing attempts are rare) land well
above the 32-80 decade or at `Infinity` — expected for metrics with little
between-player variance to detect, and the reason package #22 headlined only
the five well-behaved receiving/rushing/passing-yardage metrics rather than
all eighteen.

**Reproduction commands** (both scripts kept off-repo, matching
`effw-test.mjs`'s own convention — recorded evidence run per Plan 07 §2.3,
not a suite test, since it needs a network CSV fetch and a full weekly
replay): `GRIDIRON_DB_PATH=<scratch>.sqlite node load-rig.mjs && node
effw-repro.mjs`. Full 18-fit output for both seasons, plus the RED-test-4
volume pin, is preserved in this session's scratchpad
(`rig/effw-repro-output.log`).

## Local dev database read: `activeKVector()` returns null

Read-only query on the **local dev sqlite** (`server/data.sqlite`, this
session, `DatabaseSync(..., { readOnly: true })`) — not production:
`shrinkage_fits` has exactly **1 row**, `active = 0`. That row is the Unit-1
volume-side CRPS-gate run (`fitted_at 2026-09-22T08:03:30Z`,
`through_season 2024`, `test_season 2025`, 4,532 player-weeks) — not an
efficiency fit, and its own `note` field claims "activated" while the
`active` column reads 0, the exact bug this session separately fixed in
`fit-shrinkage-weekly.mjs`'s note-text ternary. `activeKVector()` therefore
returns `null` against this local dev database today, confirmed directly
rather than inferred from `projections.js:198-201`'s comment.

**Production's `shrinkage_fits` has never been read.** The Fly deployment's
own database is a separate file this session has no route to; the 08:04Z
live read that morning covered `weekly_ensemble_fits` only, not
`shrinkage_fits`. Deploy has not happened this session (brake
`SCHEDULER_DISABLED=1`), so production's `shrinkage_fits` state is still the
unread morning-list item Plan 07 §2.4 names — this local-dev read does not
answer it.

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

4/4 caught, 0 survivors on the original fix's test.

**RED test 4** (Plan 07 §2.3, "the volume side does not move"): a
`target_share` fixture asserting the volume spec's prior-season weight
ratio stays at `WEEKLY_ROLE_RECENCY.seasonDecay` (0.05), not
`RECENCY.seasonDecay` (0.35) — `roleW` already reaches the volume specs
correctly, and this pins a future one-line edit from accidentally widening
`effW`'s reach into that call site. Mutation-verified by hand: swapping
`roleW` for `effW` at the `target_share` call site fails this test (`1
fail`); reverting passes it.

**RED test 3** (Plan 07 §2.3, "weekly MAE and Spearman unchanged... ships as
an ASSERTION IN THE SUITE"): asserts `activeKVector()` stays `null` across a
`fitAllK()` call, on a fresh DB. This is the structural guarantee behind
"no efficiency fit reaches production" — `fitAllK`/`buildFitSpecs` are pure
computation; only `saveFit()`+`activateFit()` (neither called here, or by
`fitAllK` at all) can write `shrinkage_fits.active`.

## Numbers

RED (original fix): 1 test, 1 failed (`ratio 1` where `0.35` expected — the
bug reported the prior-season and current-season rows as equal weight).
GREEN: 1 test, 1 passed. RED tests 3 and 4 (above): both pass on the fixed
code, both independently confirmed to fail on the relevant mutation. Test
file total: 3 tests, 3 passing. Existing coverage of the module unaffected:
`test/nfl-metric-reliability.test.js`, `test/mlb-nrfi-shrinkage.test.js`
still pass. (`test/shrinkage-fit.test.js`, cited in an earlier version of
this document as "20 tests, untouched," does not exist on this branch or on
`main` — it lives only on the separate, unmerged `effk` branch. Corrected
per the Evidence Auditor's `audit-pr106-effw-gate-2026-09-22.md` finding 4.)

**Full local check `npm run check`, measured on the tree actually pushed
(commit `609fa42`, off `main` `654ff93`), isolated worktree, hard-linked
`node_modules`, two independent runs:** exit 0 both runs, **2,989 tests,
2,948 passed, 0 failed, 41 skipped**, identical both runs. Reconciles
against main's own 2,986 (per the Evidence Auditor's independent
measurement) + 3 — this unit's three new tests (the original effW-weighting
test, RED test 4, RED test 3). **The earlier "3,056/3,015" figure in this
document was measured on `origin/effk` (branch `da5738e`), which is not an
ancestor of this PR's commits — a green figure quoted for a tree other than
the one pushed. Corrected per the same Evidence Auditor finding.** Atomic
guard v4 (worktree-isolated, `git status --porcelain` + `git write-tree` +
`node_modules` mtime, before/after, on both the primary tree and each
worktree run): stable across both runs and both before/after captures, no
other write landed mid-run.

## The five questions

**Is this well built?** One parameter added to one function, one line
changed at each of 8 call sites — the smallest change that closes the
recorded defect, nothing else touched.

**Is this based on stats, or is it made up?** The fix makes the fitter's
weighting match a specific, cited line of production code
(`projections.js`'s `a.targets += w * u.targets`) exactly, not a guess at
what "should" matter.

**How do we know?** RED before, GREEN after, 4 mutations with 0 survivors on
the original fix; RED tests 3 and 4 each independently mutation-verified;
and — closing the gap the earlier version of this document left open — the
real in-file `fitAllK` reproduces package #22's independent, out-of-repo
mirror to within 1.1% on all five headline k values and matches both
seasons' MAE-delta significance verdicts exactly.

**Should this data be pointed anywhere else on the platform?** No. The
efficiency `k` values are reported here and in the reproduction above for
the record, not applied — `activeKVector()` returns `null` against the
local dev database (read above; production unread), and RED test 3 now
pins that `fitAllK` cannot change that as a side
effect. Package #22 (Plan 07 §2.2) already settled that even a correctly
fitted efficiency k does not beat the hardcoded constants from three
independent directions; this unit adds a fourth (in-file reproduction) and
does not reopen a promotion question. The unfixed-baseline mismatch flagged
in an earlier version of this document (this run's 138.45/272.74/154.10 vs.
a differently-sourced relayed triple) is superseded by the reproduction
above, which used the same rig as the figure it's being checked against.

**How does it unify?** Same pattern as this session's other fixes: a
component computed and never wired in (`effW`, like the discarded
`positionalPriors` share arrays found while answering Unit 2's criterion 3)
is exactly the kind of defect a bare `node --test` or a passing suite
cannot surface, because nothing failed — the fitter ran, just against the
wrong units, and the mutation sweep is what proves a test now actually
watches the wiring rather than merely exercising it.
