---
name: gridiron-effw-never-wired-efficiency-fits
description: VERIFIED 2026-09-22 on 654ff93 — shrinkage-fit.js's efficiencyWeightFor is dead code, so every efficiency k the promotion scripts ever produced was fit with raw opportunities and all seasons equal, violating the file's own stated invariant.
metadata:
  type: project
---

Whole-repo grep for `efficiencyWeightFor|effW` returns exactly two lines:
`server/services/shrinkage-fit.js:99` (the definition) and `:323`
(`const effW = efficiencyWeightFor(through);`, never used). **The function is
dead, not just the variable.** Its docstring claims "efficiency and availability
call sites"; there are none. Availability does get season weight, but through
`SEASON_WEIGHT` at `:300`.

**The defect.** `efficiencyObservations` (`:194-204`) takes no weight function at
all — signature `(log, position, oppField, valueFn)`, hardcodes `weight: opp`. So
every efficiency spec at `:355-373` (ypt, ypc, ypa, catch_rate, rec/rush/pass td
rate, int_rate) is fit with **raw opportunities, all seasons equal**. Production's
denominator is `w * (u.targets ?? 0)` at `projections.js:495` under `RECENCY`
(seasonDecay 0.35, weekHalfLife null) — **season-weighted**. This violates the
invariant `shrinkage-fit.js:63-72` states verbatim: the fit must be trained under
the recency weighting the model applies the k under, "or the k it produces is
optimal for a decay curve that doesn't exist in production."

**It is the same defect the file says it already fixed.** `:318-322` — "Training
them under RECENCY was the defect this pair of weight functions fixes." The
VOLUME half (`roleWeightFor` → `recencyObservations`) shipped. The EFFICIENCY
half was written, assigned to a variable, and never wired.

**THE FIX IS A PRODUCT, NOT A SUBSTITUTION.** The two sides are not symmetric:
- Volume: production's n is `a.tgtShareW += roleW` — pure recency, no
  opportunity. `recencyObservations` weights by `weightFn` alone. Matches.
- Efficiency: production's n is `Σ w·opp` — recency TIMES opportunity.
Correct weight is `effW(u.season, u.week) * opp`. Passing `effW` in place of
`opp` breaks it further; `fitK`'s contract (`:121-124`) says weight is "the
amount of opportunity the observation represents", and k is compared against n
in `shrink(observed, prior, n, k)`, so k must be estimated in n's units:
season-weighted opportunity.

**Blast radius — not a lab script.** `fitAllK` (`:382-383`) calls
`buildFitSpecs`, and `fitAllK` is imported by
`scripts/promote-weekly-ensemble.mjs:53`, `scripts/fit-shrinkage-weekly.mjs:25`,
`scripts/fit-shrinkage.mjs:25` — the promotion paths.

**Measured effect (free nflverse data, Data & techniques R&D 2026-09-22):**
unfixed fitter gives ypt WR 125.79 / TE 138.19 / RB 175.71, ypc RB 265.73;
applying the decay moves it to **40.62 / 32.92 / 35.62**, near the incumbent
`K.yards_per = 34`.

**Consequence for `projections.js:88-92`.** That comment rejects the fitter's
efficiency k because the MoM between-player variance is "inflated" — which makes
k too SMALL. The UNFIXED fitter is far larger, so the mechanism appeared not to
reproduce; the FIXED fitter (33-41) is *below* the empirical optimum (50-70), so
the sign agrees. Correct statement: **no longer contradicted, still not
confirmed** — the gap sits inside the curve's flatness.

**Why it survived: `buildFitSpecs` has NO test.** The only test importing the
module is `test/mlb-nrfi-shrinkage.test.js:29`, exercising `fitK` alone on
synthetic observations. An unused-variable lint or one assertion on a spec's
weights catches it.

**How to apply:** the fix needs a RED test asserting efficiency spec weights
equal `recencyWeight × opportunity`. Do not treat any previously fitted
efficiency k as evidence. Ruling and full reasoning:
/mnt/project-files/audit-unit-7-yards-per-k-final-gate-2026-09-22.md.
See [[fit-stores-default-to-not-live]], [[gridiron-auditor-thread-standing-2026-09-22]].
