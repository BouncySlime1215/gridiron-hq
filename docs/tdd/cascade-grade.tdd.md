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

| mutation | result |
|---|---|
| `if (found.weeks.has(week))` → `if (!found.weeks.has(week))` — look for the starter among the week's rows | **1 pass / 4 fail**; absences 5 instead of 1 |
| the `week < first \|\| week > last` span bound deleted | **3 pass / 2 fail**; absences 3 instead of 1 (weeks 1 and 2 scored as misses) |
| `if (w >= week)` → `if (w > week)` in `priorUsage` — the graded week leaks into its own baseline | **3 pass / 2 fail**; the week-6 spike reaches the baseline |

Each mutation was reverted immediately after its run; the file in this commit is
the unmutated one, and the suite is green.

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

## 5. A defect the grading surfaced

`cascades()` publishes an unbounded multiplier. On the 2025 rows:

> Jordan Whittington (WR) behind Puka Nacua: **×26.38** on a 0.11 base.

A multiplier is a ratio, and the denominator is the beneficiary's opportunity
per game *while the starter played*. `contingency.js` skips a pair only when
both sides are under 0.5 (`if (base <= 0.5 && boosted <= 0.5) continue;`), so a
beneficiary who was essentially unused alongside the starter keeps a tiny
denominator and the shrink toward 1 cannot tame it at four or five observed
games. The `gain` field is bounded by the observed without-starter mean and is
not affected; the `multiplier` field is.

This is a finding, not a change. `contingency.js` belongs to no thread's file
allocation tonight and the fix — a floor on the denominator, or a cap — is a
proposal, not something to apply while a release train is mid-merge.

## 6. Reproducing

```
node scripts/grade-cascade-multipliers.mjs --json out.json --rows rows.json
node --test test/cascade-grade.test.js
```

`GRIDIRON_DB_PATH` selects the database. The script writes nothing to it.
