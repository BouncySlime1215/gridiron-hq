# Forecast combination, stage 2: a real bake-off against the incumbent blend

Giant Plan section 7.2 item 2, second stage. **Measurement only — no weight, blend,
gate or forecast in the production path was changed.** Nothing here is wired into
`ensembleLine`.

Date: 2026-09-12
Branch: `model-2026-09-12-bigbuilds` (continues stage 1's `1958aeb`)

---

## The short version

On the only data this session could legally run — a synthetic fixture whose market
is near-oracle by construction, which is the situation the real ensemble is in —
**the incumbent won, and no candidate beat it by a Diebold-Mariano test.** Equal
weights and inverse-MSE weights, the two baselines the literature says usually win,
both lost *significantly*.

That is a real result and it is reported as the headline rather than buried, because
the incumbent is nearly the market itself and "nothing beat the market" is the
expected honest answer.

It is also, on its own, an uninformative result — a market that cannot be beaten
cannot distinguish a working combiner from a broken one. So a control was run on
the identical league with the market quote made noisy and nothing else changed. In
that control, seven of ten candidates beat the incumbent at p < 0.05 and the winner
beat plain equal weighting at p = 0.016. The machinery finds signal when signal is
there, and declines to manufacture it when it is not.

**The real ensemble's number is still not known.** See "What was NOT measured".

---

## What was built

| File | Purpose |
| --- | --- |
| `server/services/forecast-combination.js` | The reduction, ten candidate combination methods, the walk-forward harness, and DM-gated comparison. |
| `scripts/forecast-combination-report.mjs` | CLI that runs the bake-off and persists a report. |
| `test/forecast-combination.test.js` | 27 tests, most of them known-answer. |
| `server/services/forecast-comparison.js` | Group m5's Diebold-Mariano + HLN implementation, taken unchanged from `a406a76`. |
| `test/helpers/seed-ensemble-fixture.js` | One added parameter, `marketNoise`, inert at its default (verified byte-identical below). |

m5's DM implementation was taken as a file, **not** cherry-picked as a commit: that
commit also replaces the ensemble's own gate statistic, which would have changed the
incumbent this stage exists to measure against. The tool was needed; the gate change
belongs to m5's branch.

## The three commitments, and where each is enforced

**1. Reduce first.** The greedy independent basis from stage 1 is refit at every
cutoff on the training block only, in market-residual space, and cut at the first
step already explained by more than 0.90 by prior picks (cap 6). Feeding 31
near-collinear columns to an estimated-weight combiner produces large
opposite-signed weights that do not survive a new season; `equal_weight_all` is kept
in the table as the no-reduction control and is the worst method in every run.

**2. The simple baselines are candidates, not controls.** Equal weights (Clemen
1989) and inverse-MSE weights are first-class entries, and the report's final line
is explicitly "is the best method distinguishable from plain equal weighting?" —
with the recommendation going to the simple one when the answer is no.

**3. Nothing is called better without a test that allows for dependence.** Every
comparison is Diebold-Mariano with the Harvey-Leybourne-Newbold correction,
**clustered so one weekly slate is one forecast period** (51 periods, not 408
observations). The naive paired t is printed beside it, never instead of it.

## The candidates

| Method | Free parameters | What it is |
| --- | --- | --- |
| `market_only` | 0 | The closing line. The yardstick. |
| `incumbent_market_residual` | per-component slope + gate | **The baseline.** Production's blend, replayed. |
| `equal_weight` | 0 | Mean of the reduced forecasts. |
| `equal_weight_all` | 0 | Mean of all 31, no reduction. |
| `inverse_mse` | K variances | w ∝ 1/MSE. |
| `ols_granger_ramanathan` | K + 1 | Unconstrained regression combination (Granger & Ramanathan 1984). |
| `constrained_ls` | K | Weights ≥ 0 summing to 1 (Bates & Granger 1969). |
| `shrunk_to_equal` | K + λ | Stock & Watson (2004) shrinkage of estimated weights toward 1/K. |
| `market_anchored_combination` | **1** | market + β·(equal combination − market). The market-anchored variant. |
| `residual_ols` | K | market + Σ bⱼ·departureⱼ, jointly fit, no intercept. |
| `residual_constrained` | K | The same with b ≥ 0, Σb ≤ 1. |

`residual_ols` is the honest generalisation of the incumbent, and the comparison
between them is the structural point of this stage. The incumbent fits one slope per
component **in isolation** and then averages those slopes with exponential weights.
That is only the right answer if the departures are uncorrelated, and stage 1
measured that they are the opposite of uncorrelated (mean |r| 0.65 in exactly this
space). Fitting the K coefficients jointly is what accounts for six components
saying the same thing being one piece of evidence rather than six.

---

## Validation

### The load-bearing test

A bake-off that mis-states the incumbent produces a flattering number for whatever
is proposed. So `fitIncumbentMarketResidual` is asserted to reproduce
`fitEnsemble`'s own output, component by component, on the same cutoff: out-of-fold
row count, fit-block row count, slope, residual RMSE, RMSE gain, paired t, gate
decision and blend weight — 27 components compared, all exactly equal, including the
3-decimal rounding the production blend actually reads.

If that test fails, no number in this document means anything. It is named
`LOAD-BEARING` in the file for that reason.

### Known-answer tests

| Case | Expected | Result |
| --- | --- | --- |
| OLS on noiseless data | recovers the generating coefficients | < 1e-6 |
| Constrained LS, truth `[0.6, 0.1, 0.3]` | recovers it, sums to 1 | < 0.05 |
| Residual combiner, truth `[0.5, 0, 0.25, 0]` | recovers it | < 0.06, and explicitly asserted *not* equal-weights |
| Constrained residual, truth summing to 0.4 | budget respected, total ≈ 0.4 | ≤ 1, within 0.1 |
| Inverse-MSE, errors 1 pt vs 2 pt | weights ≈ 0.8 / 0.2 | < 0.02 |
| Simplex projection | Duchi et al. identity + sums to 1 | exact |
| Sub-simplex of an all-negative vector | the origin — "stay on the market" | exact |

The recovery tests all use a true weight vector that is **not** equal weights, so a
combiner that always returned 1/K would fail them.

### Leakage

Two separate tests, because the default cadence is weekly:

- **Season cadence** — turning one component into a perfect oracle across the whole
  held-out season changes no chosen basis and no fitted parameter.
- **Week cadence** — an oracle appearing from week 9 onward cannot change any
  forecast made in weeks 1–8. (The season-wide check rightly *fails* at weekly
  cadence, because earlier weeks of the test season genuinely are in the past for
  later weeks. Asserting the wrong one of these would have hidden a real bug or
  invented a fake one.)

### The two controls that make a null result readable

- **Signal exists** → `residual_ols` beats `market_only`, DM p < 0.01. If this ever
  fails, a "nothing beat the market" finding is uninterpretable.
- **No signal exists** (all departures pure noise) → *no* method is reported as
  beating the market at p < 0.01.

### Regression

- 27/27 new tests pass.
- Stage 1's fixture report is **byte-identical** after the `marketNoise` parameter
  was added (the PRNG draw count is unchanged, so scores, features and weather are
  bit-identical across settings — which is what makes the two fixture runs below a
  properly controlled pair).
- Full suite: 1756 tests, 1716 pass, 1 fail. The one failure is
  `nfl-execution-pipeline.test.js` "resolveQuoteBasis: prefers the real multi-book
  quote tape", which fails identically in isolation and shares no import with
  anything added here. **Pre-existing on `build-2026-09-12-v2-integration`, not
  caused by this work.**

---

## Results

Walk-forward, refit **weekly** — matching production, where `ensembleLine` calls
`fitEnsemble({ beforeSeason, beforeWeek })` for the specific week it forecasts. 51
weekly cutoffs across three held-out seasons (2022–2024), 408 games scored, pooled
on the games every method produced a forecast for.

### Run 1 — near-oracle market (the fixture's default, and the real ensemble's situation)

| Method | RMSE | cover-Brier | DM* vs incumbent | p | verdict |
| --- | --- | --- | --- | --- | --- |
| `market_only` | **9.8096** | 0.25134 | −1.000 | 0.161 | — |
| **`incumbent_market_residual`** | **9.8105** | **0.25140** | — | — | **baseline** |
| `market_anchored_combination` | 9.8128 | 0.25180 | 0.136 | 0.554 | — |
| `constrained_ls` | 9.8300 | 0.25261 | 0.675 | 0.749 | — |
| `residual_constrained` | 9.8350 | 0.25242 | 0.912 | 0.817 | — |
| `residual_ols` | 9.8553 | 0.25280 | 1.100 | 0.862 | — |
| `shrunk_to_equal` | 9.8875 | 0.25293 | 1.833 | 0.964 | worse |
| `ols_granger_ramanathan` | 9.8919 | 0.25363 | 1.838 | 0.964 | worse |
| `inverse_mse` | 10.2777 | 0.26553 | 3.039 | 0.998 | worse |
| `equal_weight` | 10.4279 | 0.26934 | 3.514 | 0.9995 | worse |
| `equal_weight_all` | 11.1031 | 0.27928 | 4.787 | 1.000 | worse |

**The incumbent won.** No candidate beat it; five lost significantly. The four
closest (`market_anchored_combination`, `constrained_ls`, `residual_constrained`,
`residual_ols`) are statistically indistinguishable from it.

Two things are worth reading off this table rather than the summary:

- The incumbent's gate was **empty at every cutoff** — nothing cleared
  (n ≥ 250, gain ≥ 0.03, t ≤ −1.645) — so the incumbent is, to three decimals, the
  market. It loses 0.0009 RMSE to `market_only` only because the gate opened in a
  handful of weeks. Stage 1 found the same thing and it reproduces here.
- **Cover-Brier is ~0.251 for everything, against 0.25 for a constant coin flip.**
  No method has any cover skill at all in this run. That is the correct reading, and
  it applies to the incumbent as much as to the candidates.

### Run 2 — the control: identical league, noisy market (nothing else changed)

| Method | RMSE | cover-Brier | DM* vs incumbent | p | verdict |
| --- | --- | --- | --- | --- | --- |
| `constrained_ls` | **10.3156** | **0.21981** | −2.944 | 0.0025 | **better** |
| `residual_constrained` | 10.3262 | 0.21993 | −2.923 | 0.0026 | better |
| `residual_ols` | 10.3482 | 0.22042 | −2.821 | 0.0034 | better |
| `shrunk_to_equal` | 10.3487 | 0.22034 | −2.744 | 0.0042 | better |
| `ols_granger_ramanathan` | 10.3498 | 0.21987 | −2.747 | 0.0042 | better |
| `market_anchored_combination` | 10.4969 | 0.22377 | −2.496 | 0.0080 | better |
| `inverse_mse` | 10.5500 | 0.22474 | −1.830 | 0.0366 | better |
| `equal_weight` | 10.5849 | 0.22535 | −1.645 | 0.0531 | — |
| `incumbent_market_residual` | 10.9779 | 0.23397 | — | — | baseline |
| `equal_weight_all` | 11.1736 | 0.23262 | 0.642 | 0.738 | — |
| `market_only` | 11.7669 | 0.25188 | 4.005 | 0.9999 | worse |

The winner is distinguishable from plain equal weighting (DM* −2.216, p = 0.016).

**This run also exhibits the exact pathology the structural critique predicted.**
With a beatable market the incumbent's gate opens and admits **26 components**,
handing each a weight of 0.03–0.05 with individually-fitted slopes all clustered
around 0.5 — twenty-six near-identical restatements, averaged. The jointly-fit
constrained combination instead puts 0.58 on one component (`series_sustain`), 0.13
on the market anchor, and zero on three of the six, and beats the incumbent by 0.65
RMSE. That is what "estimate one number per component and then average" costs when
the departures are correlated.

### On the forecast-combination puzzle

It did **not** hold in the form the literature usually states it, and the reason is
worth recording. Equal weighting assumes the candidate forecasts are of broadly
comparable accuracy. Here they are not: the market is far more accurate than any
model component, so averaging 31 forecasts of which two are market-derived dilutes
the best forecast in the set. `equal_weight_all` is the worst method in *both* runs.

Where the puzzle does show up is in the shape of the winners. The methods that held
up are the constrained ones — weights bounded, budget capped, no intercept — and the
single-parameter `market_anchored_combination` sat within noise of the incumbent in
run 1 while beating it at p = 0.008 in run 2. Its fitted β was **0.092–0.099** across
all three seasons: the data's own answer to "how far should the blend move from the
market" is about a tenth of the way, estimated stably, from one coefficient instead
of thirty-one.

### The skill screen

Both runs were repeated with a second reduction arm that screens components by their
own out-of-fold residual skill before the independence basis — stage 1's caveat 1
made operational ("a component that is perfectly independent and perfectly wrong
raises the rank without helping anything"). On the near-oracle run it made the
raw-forecast-space methods substantially **worse** (`equal_weight` 10.43 → 10.81,
`constrained_ls` 9.83 → 10.40), because the screen ranks the market components
poorly — their departure from the closing line carries no gain — and evicting the
market anchor from the basis is exactly what raw-space averaging cannot survive. The
residual-space methods barely moved (`residual_constrained` 9.835 → 9.830).

The screen is therefore **not** recommended as written. The finding is that skill
and independence are the wrong two axes to combine greedily when one of the
candidates is the market itself.

---

## What was NOT measured

**The real ensemble's numbers were not measured, and nothing above should be read as
that measurement.**

Same constraint as stage 1, unchanged: the only populated database is
`server/data.sqlite`, which this session was instructed never to open (a live
process is capturing real games into it), and every run was required to point
`GRIDIRON_DB_PATH` at a fresh `/tmp` path. There is no other real-history source in
the tree — `docs/evidence/historical/` holds prose, and `test/fixtures/nfelo-*.csv`
are six-row test fixtures.

So both runs above are on a synthetic league. What they establish is about **code**,
not about football:

- the harness is walk-forward and leak-free at both cadences (tested);
- the incumbent it compares against is provably the real incumbent (tested);
- the comparison detects real signal and refuses fake signal (tested);
- ten combination methods are implemented and recover known weights (tested).

What they do **not** establish is which method wins on NFL history. One command
answers that:

```bash
cp server/data.sqlite /tmp/combo-read-only.sqlite     # a human, against a quiesced DB
GRIDIRON_DB_PATH=/tmp/combo-read-only.sqlite SCHEDULER_DISABLED=1 \
  NODE_OPTIONS='--import ./test/offline-guard.mjs' \
  node scripts/forecast-combination-report.mjs --test-seasons 2023,2024,2025
```

Test seasons must be at or after 2022, the ensemble's calibration boundary, or the
component forecasts themselves are not cutoff-safe for that season.

---

## Recommendation

**Do not replace the incumbent blend on this evidence.** It won its own bake-off and
nothing beat it by DM.

If the real-data run reproduces run 1's shape — an empty gate, the blend equal to
the market — then the finding is not about combination methods at all: there is
nothing to combine, and the next question is why 31 components produce no departure
that clears a gate, not which weighted average of them to use.

If it reproduces run 2's shape — a gate that opens and admits twenty-odd correlated
components — then `market_anchored_combination` and `residual_constrained` are the
two to promote into a proper challenger, in that order. The first is one parameter
and was never significantly worse in either run; the second was within noise in run
1 and near the top in run 2. Both are constrained so that "the market is right"
remains reachable, which is the property that made them degrade gracefully in the
run where there was nothing to find.

## Caveats this analysis carries

1. **RMSE is not the betting objective.** A method can lower RMSE while picking
   worse sides, because bets are placed on the sign and size of a departure, not on
   squared error. Cover-Brier is reported for exactly this reason and in run 1 it
   says no method has cover skill. `replaySeason` grades the policy objective
   (units, ROI, CLV) and is the right next harness for anything promoted here.
2. **Three held-out seasons is 51 weekly clusters.** That is the sample size the DM
   statistic actually has, and it is small. The naive paired t is printed beside
   every comparison so the reader can see how much of the apparent evidence came
   from treating 408 correlated games as independent.
3. **The basis churns.** 8 distinct components rotated through a 6-slot basis within
   a single season (`basis_churn` 1.33). A reduction that changes weekly is a
   reduction with a variance problem of its own, and it is reported rather than
   smoothed away.
4. **Cover-Brier carries a known bias against the flexible methods.** Each method's
   cover probabilities are read off its own *in-sample* training residuals, so a
   method with many free parameters understates its error spread, comes out
   overconfident, and pays for it in Brier. The penalty falls on the
   estimated-weight methods and not on the market or the incumbent — it is
   conservative for the conclusion reported here (the incumbent won) but it must be
   discounted before reading any flexible method's Brier loss as evidence against
   it. A proper fix needs an inner cross-validation fold inside each training block.
5. **The fixture's market is a design choice, not a measurement.** Run 1's market is
   deliberately near-oracle because that is the real ensemble's situation; run 2's
   is deliberately beatable so the machinery can be seen to work. Neither is
   evidence about how beatable the real NFL closing line is.
