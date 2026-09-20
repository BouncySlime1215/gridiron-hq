# Grading the shipped cascade multipliers — TDD record, 2026-09-20

`contingency.js:cascades()` publishes, for every starter, a list of teammates
and a claim about each: when the starter sits, this teammate's opportunity goes
from `base_opportunity` to `opportunity_without`, a `multiplier` of `m`.
`handcuffValue()` turns that claim into an expected-points figure.

Nothing in this repository had ever checked the claim against a season the split
was not fitted on. This is that check. It changes no shipped behaviour:
`contingency.js` is untouched, and the two new files are a service and a driver.

## Is it well built, is it based on stats, how do we know, where else should it point, what does it unify

**Is it based on stats.** It grades the published numbers against real
absence weeks in seasons the split never saw: the cascade for season *s* is
built with `through: s - 1`, and `cascades()` reads only `season <= through`.
The baseline comes from the graded player's own earlier weeks of the graded
season, which the cascade never saw either.

**How do we know.** Two tests were written before the first run, and the bar
was fixed before the first run in the shape the volume-shrinkage gate uses: a
win in both graded seasons, with the 90% player-clustered bootstrap interval
excluding zero. What changed after the run was which of the two tests is
primary, and section 3 is the record of why.

**What is not evidence.** The in-sample gain scale (0.18 for 2024, 0.58 for
2025) is fitted on the graded rows themselves. It describes this sample and
forecasts nothing. The two numbers also disagree with each other by a factor of
three, which is its own argument against shipping a fixed correction.

**Where else this should point.** The absence-detection construction, not the
grader. Any surface that asks "who is out and who inherits" — Start/Sit's weekly
volume, the waiver board, News fantasy impact — is exposed to the same defect,
and it is silent when you hit it.

**What it unifies.** It puts the repository's two teammate-absence estimators
under one evidence standard. `opportunity-model.js` was graded and refused;
`cascades()` had never been graded at all. Now both have been, by the same bar,
and both are refused.

## 1. What is guarded

Three claims, each with a mutation that fails the suite. Test file:
`test/cascade-grade.test.js`. Fixture: one team, weeks 1–8, a starter who joins
in week 3 and misses week 6 only, and a backup who plays every week and spikes
to 30 carries in week 6.

1. **An absence is found although the starter has no box-score row that week.**
   A player who is ruled out has no row. Four earlier attempts at this question
   in this repository looked for absent teammates among the players who *have* a
   row in the graded week, found nobody, and measured an effect of exactly zero.
2. **Weeks outside the starter's roster span are not absences.** Without the
   bound, every week before he was signed and after he was traded scores as a
   game he missed, which manufactures cascades between players who were never
   teammates.
3. **The baseline is strictly prior.** The graded week's own box score must
   never reach the number that predicts it.

## 2. RED — the mutations, run and shown failing

Recorded 2026-09-20 by injecting each defect into
`server/services/cascade-grade.js` and running
`node --test test/cascade-grade.test.js`. Clean, the suite is 5 pass / 0 fail.

**Each injection was verified to have been applied before its run was counted.**
A substitution whose pattern silently fails to match produces a run of the
unmutated file wearing the mutation's name, which looks exactly like a passing
guard and is worth nothing. Every injection below was confirmed by a SHA-256
change of the file plus the presence of the mutated text in it, and a fourth
injection using a pattern that does not exist was run deliberately as a control
to show the check reports a no-op rather than a result.

| mutation | injection | result |
|---|---|---|
| `if (found.weeks.has(week))` → `if (!found.weeks.has(week))` — look for the starter among the week's rows | **applied** `4ed96ef709c5` → `23a0dc59dbcf` | **1 pass / 4 fail**; absences 5 instead of 1 |
| the `week < first \|\| week > last` span bound deleted | **applied** `4ed96ef709c5` → `1bb69754cd2c` | **3 pass / 2 fail**; absences 3 instead of 1 (weeks 1 and 2 scored as misses) |
| `if (w >= week)` → `if (w > week)` in `priorUsage` — the graded week leaks into its own baseline | **applied** `4ed96ef709c5` → `b5d5b3427d0b` | **3 pass / 2 fail**; the week-6 spike reaches the baseline |
| control: a pattern that does not appear in the file | **NO-OP, not applied** | no result recorded — the point of the control |

Each mutation was reverted immediately after its run; the file in this commit is
the unmutated one, and the suite is green.

The fix in section 5 has its own RED, recorded as a commit rather than as a
mutation, which is not exposed to the no-op failure mode at all: the test file
was added and ran, and a test that did not run would report as missing rather
than as passing. `test/cascade-multiplier-denominator.test.js` was committed
first (ed96531) and failed 2 of its 4 tests against the unfixed `contingency.js` — the thin pair
published ×21.5 and `denominator_opportunities` did not exist. The other two
tests passed before the fix and are the guards on not breaking what worked: the
gain survives, and a large multiplier resting on a well-estimated divisor is
kept.

## 3. Which test is primary, and why that changed

Both tests were written before the first run. Neither was added afterwards and
neither was dropped.

**Test A, on its own terms** — `opportunity_without` against
`base_opportunity`. Both predictions come straight out of the cascade, so it
isolates the estimator. **This is the primary.**

**Test B, incremental** — the beneficiary's own recent usage, against that same
number multiplied by `m`. This was written as the primary. Running it showed why
it cannot be: for a backup who has already taken over, own-recent-usage *already*
reflects the starter's absence, so multiplying again double-counts. In 2025, 37
of 77 graded rows are quarterbacks, which is exactly that population. Test B
measures a use error mixed with the estimator.

It is kept, and reported, because it is the shape a consumer would most likely
reach for, and the double-counting trap is worth showing rather than asserting.

## 4. The numbers

`node scripts/grade-cascade-multipliers.mjs`, against a database rebuilt from
the public sources the app uses, seasons 2021–2025. Full output:
`docs/evidence/2026-09-20/cascade-grade.json`.

| | 2024 | 2025 |
|---|---|---|
| starters with a cascade entry and a roster spot | 79 of 107 | 80 of 102 |
| absence weeks found | 192 | 160 |
| graded rows (distinct beneficiaries) | 49 (14) | 77 (21) |
| **Test A** `base_opportunity` MAE / bias | 5.771 / −1.919 | 5.024 / −3.692 |
| **Test A** `opportunity_without` MAE / bias | 6.781 / **+2.444** | 5.123 / **+3.303** |
| Test A improvement | −17.50% | −1.97% |
| Test A 90% interval (without − with) | [−1.099, +3.141] | [−1.231, +1.207] |
| Test B own recent usage MAE / bias | 5.415 / −2.291 | 4.297 / −0.760 |
| Test B own recent × multiplier MAE / bias | 5.582 / +0.279 | 7.233 / +5.654 |
| Test B 90% interval (scaled − own) | [−0.693, +1.005] | [+0.576, +6.399] |

**Verdict: refused.** Test A does not improve in either season and its interval
straddles zero in both.

**The bias split is the informative part.** In both seasons `base_opportunity`
reads low on an absence week and `opportunity_without` reads high. The published
numbers bracket the truth. The direction of the effect is right — which agrees
with the vacated-share coefficients measured separately in
`docs/OPPORTUNITY-FINDINGS-2026-09-19.md`, positive in every position and every
season — and the published size is too large.

**Read the n before quoting any of this.** 49 and 77 rows, over 14 and 21
distinct players. At that size "the interval straddles zero" is partly a
statement about power. This does not prove the cascade multiplier is worthless.
It establishes that the repository has never had evidence it works, that the
first look does not find any, and that the published number is biased high.

## 5. A defect the grading surfaced, and the fix

`cascades()` published an unbounded multiplier. On the 2024 fit:

> Jordan Whittington (WR) behind Puka Nacua: **×26.38** on a 0.11 base.

**The mechanism.** The multiplier is `shrink(boosted / base, 1, without.n, 4)`.
`shrink` is handed `without.n` — the number of games the starter *missed* — and
never the sample size of the divisor, which is the quantity that actually makes a
ratio unstable. `contingency.js` skips a pair only when *both* sides are under
0.5, so a beneficiary who was barely used alongside the starter keeps a tiny
divisor that the shrink toward 1 cannot touch. Whittington's whole with-starter
sample held about one observed target.

**Why not a cap.** Because a large multiplier is often correct. Joe Flacco behind
Joe Burrow publishes ×7.49 off a 3.67 base built from **eleven** observed
attempts, and a backup quarterback really does go from mop-up duty to a starter's
workload. A cap would replace a correct number with a wrong one. What separates
the two cases is not the size of the result; it is how much opportunity the
divisor was estimated from.

**The bound, and where it comes from.** A mean rate estimated from a count of *k*
observed events carries a relative standard error of about 1/√k, and a ratio
inherits its divisor's error directly. Nine is where that relative error reaches
one third — below it a ×2 and a ×3 are not distinguishable from the sample the
divisor was built on, so the ratio is not a measurement. `cascades()` now reports
`multiplier: null` when the with-starter side carries fewer than nine observed
opportunities, and publishes `denominator_opportunities` so the basis is visible
rather than implied. `gain`, `base_opportunity` and `opportunity_without` are
unchanged: the gain is bounded by the observed without-starter mean and stands on
its own.

**The line is not clean, and is not described as one.** Mac Jones behind Brock
Purdy sits at eight observed attempts against the threshold of nine, so his
×10.24 is withheld by a single opportunity.

**What it changes on the real fits.** 15 of 203 beneficiary multipliers in each of
2024 and 2025 — 7.4% — and the largest surviving ratio falls from ×26.38 to ×4.37
and from ×10.57 to ×7.49.

**Reach.** `multiplier` has no numeric consumer anywhere. It is served raw on
`GET /api/model/cascade/:playerId` and carried through `handcuffValue()` into
`paths[].multiplier` (`contingency.js:1079`); `expected_gain` and
`expected_points` are computed from `gain`, not from it, so the handcuff ranking
does not move. `client/src/pages/Model.tsx:478` reads `paths` but only `starter`
and `starter_miss_rate`. `draft-assist.js` reads neither. Both routes sit behind
`Model.tsx`, which has no `<Route>`. So a null is safe everywhere it can reach.

### Before and after

Test A does not move, and that is by construction, not a null result:
`base_opportunity` and `opportunity_without` are published for every row either
way, and the fix changes only the `multiplier` field.

| | 2024 before | 2024 after | 2025 before | 2025 after |
|---|---|---|---|---|
| Test A improvement | −17.50% | −17.50% | −1.97% | −1.97% |
| Test B rows | 49 | 46 | 77 | 76 |
| Test B improvement | −3.10% | −6.86% | −68.32% | −46.72% |
| Test B 90% interval | [−0.693, +1.005] | [−0.422, +1.199] | [+0.576, +6.399] | [+0.142, +4.574] |
| largest multiplier among graded rows | ×1.71 | ×1.69 | ×26.38 | ×2.37 |

**The interval still straddles zero on Test A in both seasons, and still excludes
it the wrong way on Test B in 2025.** The fix removes predictions that were
absurd on their face — the worst 2025 row no longer claims 77 opportunities for a
player averaging 2.9 — and it cuts the 2025 damage by a third, but it does not
rescue either test. The remaining 2025 gap is the double-counting described in
section 3, not outliers. Nothing here promotes the cascade to a surface.

### A limit worth writing down

`cascades()` bounds each starter's window to his own first and last appearance on
that roster, which is right — otherwise the weeks before he was signed score as
games he missed. The consequence is that a **season-ending absence contributes
nothing**: there is no later appearance to close the window. The fixture in
`test/cascade-multiplier-denominator.test.js` had to put its absences in weeks
7–10 for exactly this reason. Anyone reading a cascade as "what happens when this
player is out" should know it is built only from absences that a return bracketed.

## 6. Reproducing

```
node scripts/grade-cascade-multipliers.mjs --json out.json --rows rows.json
node --test test/cascade-grade.test.js
```

`GRIDIRON_DB_PATH` selects the database. The script writes nothing to it.
