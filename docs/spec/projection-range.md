# Spec: a weekly projection range, measured rather than assumed

Nick's decision, 2026-09-22: **keep the point projection and add a range
alongside it** — not replace one with the other.

This spec gives the method, the calibration evidence, the serving contract and
the display rules. Every number in it is measured on 25,323 out-of-sample
player-week predictions from a purged walk-forward over 2018-2025, WR/TE/RB.
It is a spec, not an implementation: **no server file is changed by this
document**, and the integration points below belong to other owners.

---

## 1. Why a fixed band would be wrong

Two measured facts rule out the obvious implementations.

**The spread scales with the projection.** Residual RMSE by projection decile
runs 3.525 in the bottom decile to 9.015 in the top — a **2.56x ratio**. A
fixed `±N` band would be far too wide for a 2-point projection and far too
narrow for a 20-point one.

| projection decile | yhat range | mean abs residual | residual sd |
|---|---|---|---|
| 1 | -0.4 – 2.9 | 2.324 | 3.500 |
| 5 | 6.3 – 7.6 | 4.649 | 5.925 |
| 10 | 14.2 – 26.9 | 7.103 | 9.014 |

**The outcome is not symmetric.** Fantasy points are floored at zero with a long
right tail. In the bottom four deciles the empirical 10th percentile of the
actual outcome *is* 0.0, so a symmetric `mean ± k·sd` band puts its lower edge
below zero for most players and still understates the upside. The model's mean
is well calibrated — bias is -0.039 (WR), +0.068 (TE), -0.155 (RB) — so the
problem is purely the shape of the spread, not the centre.

**Therefore: conditional empirical quantiles.** Read the band off history,
conditioned on the projection and the position. Do not derive it from a normal.

## 2. The method

For a projection `yhat` for a player at position `pos` in season-week `(s, w)`:

1. Take all scored player-weeks from **strictly earlier** season-weeks. The band
   must be fitted causally, exactly like the model it wraps — a band fitted on
   the week it describes reports its own training data back as coverage.
2. Bin that history by position, then into 8 projection bins by `yhat`
   (equal-count edges). If a position has fewer than `8 × 150` prior rows, pool
   across positions until it does.
3. In the player's bin:
   - `lo` = empirical 10th percentile of the actual outcome, floored at 0.
   - measure `f_lo`, the actual fraction of prior outcomes below `lo`.
   - `hi` = quantile at `1 − (0.20 − f_lo)`.
4. Serve `[lo, hi]` as an **80% range**.

Step 3 is the part that matters and it is the fix for v1 of this work, which
over-covered at 84.76%. Because the outcome is floored, the lower tail *cannot*
hold 10% of the mass in low bins — more than 10% of outcomes are at or near
zero. Splitting the 20% miss evenly between two tails is therefore impossible
there. Targeting total coverage and letting the tails be asymmetric is both
achievable and honest.

**The band is deliberately asymmetric and must stay that way.** Measured tail
split: below 5.37% / above 14.18% (WR), 3.80% / 15.25% (TE), 7.75% / 11.21%
(RB). Anyone "fixing" this to be symmetric will break the calibration.

## 3. Calibration evidence

23,137 player-weeks scored with a causally-fitted band. **Stated 80%, actual
80.74%**, mean width 13.63 PPR.

It holds where it has to hold, not just on average:

| cut | coverage |
|---|---|
| WR (n=11,010) | 80.45% |
| TE (n=5,586) | 80.95% |
| RB (n=6,541) | 81.04% |
| projection bin 1 (lowest) | 81.83% |
| projection bin 6 | 78.90% |
| projection bin 8 (highest) | 79.85% |
| 2019 … 2025, by season | 79.90% – 81.56% |

Worst deviation across every cut is 2.2 percentage points. v1, which assumed
symmetric tails and pooled positions, over-covered at 84.76% overall and 88.33%
for TE — the comparison is the reason for step 3.

**The band is wide.** Mean width 13.63 PPR against a mean projection near 8.
That is the honest width of a weekly fantasy projection, and it is the whole
argument for showing it.

## 4. What this replaces: a judgement the repo already flagged

`server/services/lineup-brain.js:252-258` says, in its own words:

> Weekly fantasy projections carry a mean absolute error in the region of five
> to six points for a starter. … **This is not fitted — it is a judgement**,
> stated here in one place so it can be argued with rather than buried inside a
> comparison.

**The judgement is confirmed.** Measured MAE for a startable projection
(`yhat >= 8.0`, n=11,910) is **6.085** — WR 6.190, TE 5.488, RB 6.175. "Five to
six points for a starter" was right, and whoever wrote it deserves to know that
a measurement now backs it.

### The start/sit threshold table that was here is WITHDRAWN

An earlier version of this section carried a decision curve and used it to argue
that `CLEAR_THRESHOLD` should move from 4.0 to about 6.0 points. **Do not use
it.** It was wrong twice over:

1. It was a **sample** of 43,200 pairs, and its smallest-margin bin read 48.4%,
   which implies the projection is *anti*-informative at small margins. Full
   enumeration of the same universe — 2,993,309 pairs — gives 51.4%.
2. More seriously, it was computed over **all pairs**, including comparisons
   nobody makes (a 20-point WR1 against a 2-point WR5). A start/sit decision is
   between two players you would actually start.

Re-derived on the 656,705 pairs where both projections clear 8.0,
`CLEAR_THRESHOLD = 4.0` buys **72.6%**, and an 80% call needs about **7.15**
points, not 6.0. `TIE_THRESHOLD = 1.5` survives unchanged at 52.9%.

The replacement, with every definition stated and the tail rates a threshold
actually depends on, is
**`docs/evidence/2026-09-22/start-sit-decision-curve.md`**. Read that. The
figure above (6.085 startable MAE) is unaffected by the error and still stands.

## 5. Serving contract

For each projected player-week, alongside the existing point projection:

```
projection        REAL     the existing point estimate, unchanged
range_lo          REAL     lower edge, >= 0
range_hi          REAL     upper edge
range_coverage    REAL     0.80 -- state it, never imply it
range_basis       TEXT     'empirical-quantile'
range_fitted_at   TEXT     ISO timestamp of the quantile table
range_n           INTEGER  prior rows in the bin the band came from
```

Rules for whoever implements it:

- **`range_coverage` is stored, not assumed.** A consumer must be able to read
  what the range claims. A band whose coverage is implied is a band nobody can
  check.
- **`range_n` travels with the band** so a thinly-fitted bin is visible rather
  than silently trusted. Below 20 prior rows, serve no range at all rather than
  a fabricated one — the same discipline as the rest of this codebase: absent
  beats invented.
- **Never clamp `range_lo` above 0 to make it look tighter**, and never
  symmetrise. Both destroy the calibration in §3.
- **Recalibrate, do not hardcode.** The tables in this document are the *current*
  measurement, not constants. Ship the fitting procedure; if the model changes,
  the band must be refitted and its coverage re-measured. A stale band is worse
  than no band because it looks maintained.
- A range must never be shown for a player with no projection. `Lineup.tsx`
  already distinguishes "not compared" from "only option" and that distinction
  must survive.

## 6. Display guidance (for whoever owns the UI)

- The point projection stays primary. The range is secondary, per Nick.
- Frame it as **floor and ceiling**, which is how the decision is actually made,
  not as "±" or as a statistics term.
- State the coverage in words once, somewhere the user can find it: 4 weeks in 5,
  not "80% CI".
- Show the asymmetry honestly. The upside tail is genuinely longer; a symmetric
  graphic would be a lie about the data.
- The start/sit margin labels should come from the win-rate curve in
  `docs/evidence/2026-09-22/start-sit-decision-curve.md`, not from the
  withdrawn table in §4. That file's own conclusion is that **showing the
  measured win rate beats keeping the word**: there is no margin at which a
  weekly start/sit call is near-certain, so "clear" overclaims at any threshold.

## 7. Provenance, limits, and one reconciliation

**Model.** Ridge regression, purged walk-forward by season-week, features from
prior weeks in-season only, fixed feature divisors so no test statistic leaks
through scaling. The container has no numpy, pandas or sklearn.

**The baseline is a research baseline, not the production model.** It knows
prior targets, receptions, receiving yards, prior PPR, snap share, games and
position.

*Corrected 2026-09-22 after tracing the wiring* — an earlier draft of this
section said the production model has "strictly more information" because it
has `opp_adj_def_epa`. **It does not.** That feature reaches the betting surface
only; no fantasy service references it
(`docs/evidence/2026-09-22/opp-adj-def-epa-wiring-audit.md`). The real
difference is that the fantasy model has `vegasLift`, a betting-line
game-script multiplier (`lineup-brain.js:275`), which this baseline lacks, while
neither model has an opponent-defence-quality feature. Which is stronger is
therefore an open question, not a safe assumption. The method in §2 is
unaffected either way, but **§3's widths must be re-measured against the real
production model before they are quoted to a user** — that matters more now, not
less, because the direction of the difference is no longer known.

**Signal share, reconciled.** Two independent measurements of how much weekly
scoring is stable player skill looked contradictory and are not:

| measurement | value |
|---|---|
| raw between-player share of variance (this thread, first report) | 45.48% |
| same data, ANOVA variance components (shrinkage-corrected) | 38.54% |
| same correction, restricted to 479 player-seasons by volume | 29.30% |
| R&D via the repo's own `shrinkage-fit.js`, 479 players | 26% |

The raw share is biased upward: a player's mean over ~8.8 noisy weeks carries
`within-variance / n` of its own noise, which the raw ratio miscounts as signal.
Correcting for that drops 45.48% to 38.54%, and matching R&D's population size
drops it to 29.30% against their 26%. **The two methods agree once the
population is matched**; the earlier 45.48% should be cited as a raw share, not
as signal.

Note the ceiling result in
`docs/evidence/2026-09-22/weekly-ceiling-the-model-is-already-there.md` does not
rest on that figure — it rests on a leave-one-out oracle comparison, which is
an empirical benchmark and unaffected by this correction.

## The five questions

- **Well built?** A spec with its calibration measured and its v1 failure shown
  rather than hidden. Not yet implemented, and not by this thread.
- **Stats or made up?** Stats. 25,323 out-of-sample predictions, 23,137 scored
  bands, 43,200 sampled pairs, every coverage figure stated by cut.
- **How do we know?** The band is fitted causally and its coverage is verified
  out-of-sample by position, projection level and season.
- **Pointed anywhere else on the platform?** Intended for the projection surface
  and `lineup-brain.js`'s margin labels — both owned elsewhere, hence a spec.
- **How does it unify?** It replaces a stated judgement with a measurement, in
  the one place the codebase already asked to be argued with.
