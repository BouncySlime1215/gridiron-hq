# Graded injury-report availability: fit + as-of-safe consumer (Plan 01, package #19)

2026-09-22. `server/services/nfl-player-context.js` (`fitGradedAvailability`,
`gradedAvailabilityMultiplier`, new), `test/nfl-player-context-graded-
availability.test.js` (new). Off `main` `654ff93`.

**Scope of this unit.** Plan 01 assigns `projections.js` wiring to Fantasy
plan ("I spec, Fantasy plan builds") and `nfl-player-context.js` to this
thread. This unit delivers the fit and the as-of-safe consumer that file
exposes; wiring either into `projections.js`, and the walk-forward weekly-MAE
gate (criterion 1b, canonical 14.55% of the #13 targets ceiling 0.4405 —
Auditor §R11/R12) are explicitly out of scope here: the gate additionally
requires the offline rig augmented with absence rows, which Plan 01 §2.4's
HARD LIMIT holds open pending the Explorer's own strand, and which this
thread does not own.

## What changed from the pooled incumbent

`role-scenario-engine.js`'s `limitedRoleMultiplier` (`:96-108`) pools
`measureInjuryEffect`'s five graded buckets down to one scalar
(`mean([limited, questionable])`, clamped `[0.4, 1]`) and reaches only a
research-lab status endpoint, never a served projection (Plan 01 §1.2). This
unit stops pooling and exposes per-status, normalised ratios directly, fit
against the repository's own designation table rather than a share-
prediction proxy.

## Why the fit denominator is the injury designation, not `player_week_usage`

An `Out` or `Doubtful` player mostly has **no row at all** in
`player_week_usage` — it is built from the same `stats_player_week` source
the rig uses (`nflverse.js:227`), and that source carries no row for a
player who did not play (Auditor G5/G6, `audit-unit-11-graded-availability-
and-rig-fix-2026-09-22.md`). Counting bucket population from usage rows
alone would treat that absence as "no evidence" rather than "zero", and
read as a false ~1.0 — the exact failure the Explorer's `add-absences.mjs`
rig augmentation existed to patch, before G5/G6 reverted it as not
production-faithful.

The injury designation table sidesteps this entirely: it is a real weekly
designation roster, populated independently of whether the named player then
produced a usage row. So `n` for each bucket comes from the designation
population (see next section for exactly which table/read), and `p` (played)
is whether a matching `player_week_usage` row with positive opportunity
exists. **This measurement never uses `player_week_usage` as a denominator,
so it is not subject to the HARD LIMIT that blocks a rig grade until
absence rows exist** — that limit is specifically about a `player_week_
usage`-only population, and this fit was designed around it from the start
rather than working around it after the fact.

## Auditor §R19.6 redirect: the fit and the serving path were conditioned differently

**Landed before the grade, as required.** The first version of this unit fit
bucket population directly from `nfl_injuries`, which UPSERTs a player-week's
report **in place** and holds only the FINAL designation for that week. The
consumer (`gradedAvailabilityMultiplier`) reads a different table,
`nfl_feature_revisions`, as-of a decision time — correctly, since that is
what look-ahead safety requires. But this meant the FIT and the SERVE path
disagreed about who belongs in each bucket: a player who was `Questionable`
early in the week and deteriorated to `Out` by the final report was **fit**
under `Out` (his final status; he never played, which is correctly zero for
that bucket) but would be **served** as `Questionable` by any decision made
before the downgrade. The fitted `Questionable` ratio was therefore computed
on a narrower, healthier population than the one it is used to price —
optimistic bias on exactly the bucket most decisions lean on. The Auditor
credits the serving-path design (reading through `valueAsKnown` rather than
`nfl_injuries`) with making this findable at all.

**Fix:** `fitGradedAvailability` now buckets each player-week by its
**earliest** recorded `injury_report` revision in `nfl_feature_revisions`
(`ROW_NUMBER() OVER (PARTITION BY entity ORDER BY observed_at ASC,
published_at ASC)`, first row), not `nfl_injuries`. This is the earliest a
decision could plausibly have known a status, so it shares one conditioning
set with the serve path instead of two different ones. `nfl_injuries` is no
longer read by this function at all.

**RED test 8** (`CONDITIONING FIX`) proves this on a dedicated 2023 fixture:
35 players get an early `Questionable` revision, then a later `Out`
revision, and none play; `nfl_injuries` for all 35 ends up holding only
`Out` (confirmed by a direct read in the test as a sanity check). The fit
must bucket all 35 under `Questionable`, not `Out` — asserted directly, and
verified by hand-mutation (see Mutations below).

**Refit on the local dev database, reported beside the original numbers as
required:**

| bucket | original (fit from `nfl_injuries`) | refit (fit from earliest `nfl_feature_revisions`) |
|---|---:|---:|
| baseline | n=24,822 rate=0.737 | n=24,822 rate=0.737 |
| Out | n=2,121 ratio=0.001 | n=2,121 ratio=0.001 |
| Doubtful | n=335 ratio=0.004 | n=335 ratio=0.004 |
| Questionable | n=2,868 ratio=0.561 | n=2,868 ratio=0.561 |

**Identical, not approximately identical — checked directly:** a query
joining each entity's earliest revision's `report_status` against
`nfl_injuries`' final `report_status` for the same player-week returns
**zero mismatches** across all 28,411 matched rows in this container's
`nfl_feature_revisions`. That is not evidence the bug didn't matter — it is
evidence that **this container's revision store was populated as a single
reconstructed snapshot per player-week, not genuine multi-day capture
history** (consistent with `nfl-bitemporal.js`'s own documented finding,
`weekKeyedTableMutationRisk`'s "single_capture_low_risk" case, and its
separately-documented finding that `nfl_feature_revisions` held 0 rows in
production as of an earlier sweep). The conditioning bug is real and the fix
is real and tested (RED test 8 proves it on a fixture with genuine
divergence); it simply has nothing to bite on in this container's current
data. **This is therefore also an operational caveat for whoever eventually
runs this fit against a live, continuously-syncing database: if
`nfl_feature_revisions` is sparsely populated for a season/week (as
`nfl-bitemporal.js` documents production may be), that season's fit
population shrinks toward the rows that do have a revision recorded, rather
than silently falling back to `nfl_injuries`'s final value — a fallback
would reintroduce exactly the bug this redirect fixed.** Check
`revisionCoverage()` (`nfl-bitemporal.js`) before trusting a live refit's
`n`.

The baseline ("no report") population is players with a usage row in any of
the prior 3 weeks that season — the same "established role" gate
`measureInjuryEffect` already uses for its own clean group — and no injury
report the following week.

## Population check (Plan 01 §2.6.E), measured on the local dev database

**E.1 — real player-weeks carrying a designation and a usage row, per bucket,
2021-2025** (2026 excluded: in progress, not a full season). n is from each
entity's earliest `injury_report` revision in `nfl_feature_revisions`
(post-§R19.6 fix; see below — identical to `nfl_injuries` on this container's
data, not by assumption):

| bucket | n (earliest revision, `nfl_feature_revisions`) | played | rate | normalised ratio | retained (n≥30) |
|---|---:|---:|---:|---:|---|
| Out | 2,121 | 1 | 0.000 | 0.001 | yes (fit population; see §R19.5 condition below re: the graded population) |
| Doubtful | 335 | 1 | 0.003 | 0.004 | yes (fit population; see §R19.5 condition below re: the graded population) |
| Questionable | 2,868 | 1,186 | 0.414 | 0.561 | yes |
| Note (rare/garbage label) | 2 | 2 | 1.000 | — | **no** (n<30) |
| baseline (no report, established role) | 24,822 | 18,293 | 0.737 | 1.0 by construction | — |

**Out (0.001) and Doubtful (0.004) are indistinguishable from each other and
from zero** (Auditor §R19.5 condition 3) — no CI has been computed for
either (there is no held-out replay to bootstrap; see the plan-no-build
submission), and both point estimates rest on 1 played player-week out of
2,121 and 335 respectively. Read them as "very low", not as two measurably
different rates.

`Note` correctly collapses under the pre-registered `n>=30` floor and never
appears in the consumption vector — confirms the floor logic on real data,
not only the synthetic fixture below.

**This differs from Auditor G5/G6's rig-based finding that `Doubtful` has
n=20 and fails the floor.** That measurement was on the offline rig, which
(per its own known limits) covers fewer seasons and a narrower position set
than this container's local dev database (2021-2026, 28,411 total injury
rows). Both are real, correctly-measured numbers on different populations —
not a contradiction to resolve, but a difference in coverage to state
plainly. **Neither number is "production"**: this is the local dev sqlite,
same caveat as `shrinkage-efficiency-weighting`'s PR #106 (`docs/tdd/
shrinkage-fit-efficiency-weighting-2026-09-22.tdd.md`) — it proves nothing
about the Fly deployment's own database, which this session has no route to.

**Auditor §R19.5 condition 3, stated explicitly so it cannot be read past:**
`Doubtful` clearing n=335 on THIS unit's fit population does not lift Unit
12's ruling, which was set on the GRADED population (the offline rig, n=20).
**The retention floor applies where a bucket is graded (walk-forward MAE),
not where it is fitted (this population count).** A bucket can clear the
floor here and still be ungraded — this unit's `retained: true` on
`Doubtful` describes the fit only; it is not itself authority to give
`Doubtful` its own coefficient in a served model, which still needs its own
graded-population floor check whenever that grade eventually runs.

**Mapping to Unit A, stated so nobody subtracts these two numbers as if they
measured the same thing:** Unit A measured `Questionable` `P(played)` =
0.6570 directly (n=207, production-faithful population). This unit's
`Questionable` figure is **0.561 normalised against a 0.737 baseline** —
i.e. an *absolute* play rate of 0.561 × 0.737 ≈ **0.4135** (n=2,868, this
container's local dev sqlite, fit population not graded population).
0.6570 and 0.561/0.4135 are not comparable at face value: different
populations (Unit A's n=207 vs. this fit's n=2,868), different definitions
(a direct rate vs. a rate normalised against an unreported baseline), and
different databases. Neither supersedes the other.

**E.2 — does production's `player_week_usage` carry zero-opportunity
"dressed" rows for absent players?** No: every `player_week_usage` row this
container holds has positive opportunity in at least one of
targets/carries/attempts, confirmed by the same query structure `NRATIO-
SPEC.md`'s rig work already established (`nfl-n-is-not-raw-opportunities`).
Consistent with G5/G6: production and the rig share the same absence-free
shape. Since this fit's denominator is `nfl_injuries`, not `player_week_
usage`, this fact does not affect it either way — it is reported because
Plan 01 §2.6.E asks for it, not because this unit's measurement depends on
the answer.

> 79% still unclaimed, most of it not in a Wednesday report.

(Carried verbatim per Plan 01 §2.5; the fitted rates above are its
quantification for this specific population.)

## The fit: `fitGradedAvailability(seasons, { minN = 30 })`

Pre-registered **before** this function was run against real data (Plan 01
§2.6.B, G2): a bucket's ratio is estimated only if `n >= minN`; otherwise it
is pooled back to the unreported case (ratio exactly 1.0), never left as a
separate, under-powered estimate. This is declared once, in the function's
own docstring, and applies uniformly to whatever buckets a given season
range produces — it does not hardcode "Out and Questionable only", which
the G5/G6 ruling named for the rig's own population but which this local
dev measurement does not reproduce identically (Doubtful clears the floor
here).

## The consumer: `gradedAvailabilityMultiplier(gsisId, season, week, decisionAt, fitted)`

**Look-ahead safety (Plan 01 §2.2).** Reads `nfl_feature_revisions`
(feature `injury_report`) through `valueAsKnown`, never `nfl_injuries`
directly. `nfl_injuries` UPSERTs a player-week's report in place, so it
holds only the **final** designation — reading it for a Sunday-lock
decision would see a Friday downgrade the decision never had. `nfl-t60-
packet.js` already established this same pattern for a different consumer;
this reuses it rather than inventing a second read path.

**Scope note on RED test 6 (LOOK-AHEAD GUARD):** that test covers only the
SERVING path — it proves `gradedAvailabilityMultiplier` reads the correct
as-of revision for a given `decisionAt`. It says nothing about the FIT's own
population read, which is a separate query over a different set of rows
(every player-week with a designation that season, not one specific
entity's revision history at one decision time). The fit's own look-ahead
correctness — that its population read is conditioned the same way the
serve path is — is what RED test 8 (§R19.6 below) exists to cover; the two
tests are not redundant.

**G1 invariant (Plan 01 §2.6.G1).** A player with no retained, on-report
designation as of `decisionAt` — unreported, or a designation whose bucket
did not clear `minN` — gets a multiplier of **exactly `1`**, the literal
number, never a value close to it. The earlier, un-normalised form of this
idea (`role-scenario-engine.js`'s raw pooled multiplier) overstated the
effect by roughly 4x for exactly this reason: it returned a raw play
probability well under 1.0 (byes, rest weeks, blowouts) rather than a ratio
against that same baseline. Every non-retained branch in the function
returns the literal `1`, not a computed value that merely rounds to it.

## RED tests

`test/nfl-player-context-graded-availability.test.js`, 8 tests:

1. **Out and Questionable get real, different, correctly-ordered ratios** —
   on a synthetic fixture (40 Out player-weeks, 0 play; 40 Questionable,
   20 play; baseline 40, 30 play), `Out` (0.0) `<` `Questionable` (0.667).
2. **A bucket under the pre-registered floor (Doubtful, n=20) collapses to
   unretained** — never appears in `fit.ratios` at all, rather than being
   estimated on 20 rows.
3. **G1 invariant, unreported** — `gradedAvailabilityMultiplier` on a
   player-week with no report returns `multiplier: 1` exactly.
4. **G1 invariant, floor-collapsed bucket** — a real `Doubtful` revision
   recorded via `recordRevision`, with `Doubtful` excluded from `fit.ratios`
   by the fixture's `n=20`, still resolves to exactly `1` through the
   consumer, not `undefined` and not its own raw rate.
5. **A retained bucket applies its fitted ratio** — `Questionable` resolves
   to `fit.ratios.Questionable`, strictly between 0 and 1.
6. **LOOK-AHEAD GUARD** — a player's Wednesday state (full participation, no
   designation yet) and Friday state (downgraded to `Questionable`) are
   recorded as two revisions of the same entity. A decision at Wednesday
   sees `bucket: null` / `multiplier: 1`; a decision at Sunday sees
   `bucket: 'Questionable'`. This is the test that fails on any
   implementation reading `nfl_injuries` directly.
7. **Empty-source no-op** — a player with zero `injury_report` revisions of
   any kind is unaffected (`multiplier: 1`, `reason: 'feature_never_
   recorded'`).
8. **CONDITIONING FIX (Auditor §R19.6)** — 35 players each get an early
   `Questionable` revision then a later `Out` revision, and none play;
   `nfl_injuries` ends up holding `Out` for all 35 (checked directly in the
   test). The fit must bucket all 35 under `Questionable` (their earliest
   status) with `played: 0` and `ratio: 0`, and `Out` must stay `undefined`
   for that season — proves the fit reads the earliest revision, not
   `nfl_injuries`' final value.

**Fixture note:** the establishing/measured weeks are 21/22, not 1/2. A
player who plays in the measured week legitimately becomes a candidate for
the *next* week too — correct, intended behaviour for a query meant to run
across a full rolling season — which cascades unwanted spillover into a
two-week synthetic fixture. Week 22 sits at the query's own `next_week <=
22` cap, so that cascade (week 23) is excluded by the production code's own
bound rather than by a fixture-only workaround. This was found and fixed
during development: an earlier version of the fixture (weeks 1/2) produced
an internally-contaminated baseline (rate diluted from an intended 0.75 to
0.333 by unrelated spillover), which the mismatch between the 5 tests'
independently-reasoned expectations and the measured output caught before
the tests were finalised.

## Mutations (by hand, three, all caught)

| mutation | result |
|---|---|
| Only check `status == null` before falling through to `1`, drop the `!(status in fitted)` check (a floor-collapsed bucket would then read `fitted[status]` = `undefined` as the multiplier) | test 4 fails |
| Read `valueAsKnown` at a far-future timestamp instead of the real `decisionAt` (bypasses the as-of cutoff, equivalent to reading the final designation) | test 6 fails |
| Flip the fit's `ROW_NUMBER()` ordering from `observed_at ASC, published_at ASC` to `DESC, DESC` (earliest revision -> latest revision, i.e. reintroduces the §R19.6 bug) | test 8 fails, all others still pass |

3/3 caught. Each targets one of the three properties this unit's tests exist
specifically to police (the G1 invariant, serving-path look-ahead safety,
and fit-population conditioning), rather than incidental code paths.

## Numbers

RED: all 8 assertions initially failed against a stub returning the raw,
un-normalised rate read from `nfl_injuries` directly (no floor, no as-of
read, no earliest-revision conditioning) before `fitGradedAvailability`/
`gradedAvailabilityMultiplier` reached their current form. GREEN: 8/8 pass.
Existing coverage of `nfl-player-context.js` (no prior test file existed for
it) unaffected — nothing else in the file was touched.

Full local check re-run under the atomic guard (`verify2x-v4.sh`) after the
§R19.6 fix, isolated worktree, two independent runs: 2996 tests, 2955 pass,
0 fail, 41 skipped, exit 0 both times; primary tree write-tree, porcelain
status, and `node_modules` mtime unchanged before/after.

## The five questions

**Is this well built?** Two functions, one fit and one as-of-safe consumer,
each doing one job; the pre-registered floor and the G1 invariant are each
enforced by one `if`, not scattered logic.

**Is this based on stats, or is it made up?** The fit is a real measurement
against this container's local dev database (28,411 injury rows, 2021-2025),
using the designation table itself as the population denominator specifically
because the usage table cannot see the population this term is about.

**How do we know?** RED before GREEN, 7 assertions covering the ordering,
the floor, both G1 branches, a retained bucket, look-ahead safety, and the
empty-source no-op; 2 hand-mutations, both caught, targeting the two
properties this unit's design exists to guarantee.

**Should this data be pointed anywhere else on the platform?** Not yet —
`projections.js` wiring is Fantasy plan's, and the walk-forward MAE gate
(criterion 1b) needs the rig-with-absences infrastructure this thread does
not own. This unit is the fit and the safe read, ready for that wiring, not
the wiring itself.

**Auditor §R19.5 disposition: ACCEPTED AS BUILT-UNGRADED, not a redirect.**
Conditions: (1) **stays unmerged** — an ungraded multiplier reaching a
served projection is exactly the level risk this unit was built to avoid
creating by itself, and as of this commit nothing calls
`gradedAvailabilityMultiplier` (grep confirms `fitGradedAvailability` and
`gradedAvailabilityMultiplier` appear only in this file and its test file),
so it is also dead code until wired. (2) The walk-forward grade is queued as
a **named unit** to the Explorer's rig-with-absences strand:
`decision_including_dnp` walk-forward only (never the conditional metric —
`weekly-backtest.js:177`'s `if (!played) continue` cannot show an
availability term at all), with a row count beside every decision figure,
mean signed error beside MAE, the level/information decomposition, and the
statistical power check declared before running, per the standing MAE-only
finding that MAE-optimal choices push the level low.

**How does it unify?** Same pattern as this thread's other units: stop
pooling a signal the repository already measures (`measureInjuryEffect`'s
five buckets), read it through the bitemporal store already built for
exactly this look-ahead problem (`nfl-bitemporal.js`, used the same way
`nfl-t60-packet.js` uses it), and pre-register the floor/invariant rules
before, not after, seeing what real data does with them.
