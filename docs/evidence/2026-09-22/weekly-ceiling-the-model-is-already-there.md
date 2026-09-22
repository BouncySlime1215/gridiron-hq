# The weekly ceiling: what the model has left, re-derived

> **REVISED 2026-09-22 after audit. The headline figure of the first version —
> "the model captures 98.9% of the oracle's R², leaving +0.0037" — is
> WITHDRAWN.** It compared the model against a *noisy estimate* of a ceiling and
> read the agreement between two noisy estimates as proof there was nothing
> left. The real headroom is **about +0.067 R², roughly eighteen times what was
> claimed**, and the model sits at **82.7% of the ceiling, not 98.9%** — the
> ANOVA figure §2 tells readers to cite, not a rounded stand-in.
> Revision history at the end. Do not quote the old figure; it has been cited
> elsewhere and those citations need correcting.
>
> **Adjudicated 2026-09-22 and settled.** The ceiling is **0.385-0.401** across
> two independent methods; **carry 0.3854, the conservative end**, which puts
> the model at **82.7%** with **+0.0668 R²** of headroom. A competing derivation
> used the raw 0.4548 as denominator and put the model at 70.1%; the audit
> accepted this document's derivation after the bias term reconciled to four
> decimals (§2.1), and noted that its own check had passed only because two
> errors cancelled.

Measured 2026-09-22, after four features from Nick's deep predictive set were
tested and all four declined. This document asks how much room those features
were competing for. The first version answered "almost none", and was wrong
about it for a reason worth understanding.

## 1. The defect in the first version

The first version compared the model against a **leave-one-week-out average of
each player's own season**, called that a hindsight oracle, and treated its R²
as a ceiling.

**A leave-one-week-out average is not a player's true level. It is a noisy
estimate of it**, built from about eight other weeks of a quantity whose
week-to-week variance is larger than its between-player variance. So the
comparison was not model-against-ceiling. It was one noisy predictor against
another noisy predictor of the same underlying quantity, and their agreement
measured their shared noise, not the absence of headroom.

The tell was in the document itself. Its own variance decomposition reported a
between-player share of 0.4548 while its "oracle" scored 0.3223 — a predictor
that supposedly knew the player perfectly, scoring far below the share of
variance that knowing players perfectly is worth. That gap was the noise, and it
went unremarked.

## 2. The corrected numbers

Identical rows: **24,801** out-of-sample player-weeks across **2,804**
player-seasons with at least three scored weeks, mean **8.84** scored weeks per
player-season. **These 24,801 are 522 rows fewer than the 25,323 saved
predictions**, and the gap reconciles exactly: 178 player-seasons with one
scored week (178 rows) and 172 with two (344 rows) are dropped by the
three-week minimum. The minimum is not cosmetic — the leave-one-out centre is
undefined at `m = 1` and is a single other week at `m = 2`, where the
within-player component cannot be estimated. **The filter is not neutral and
the document should not pretend it is:** the model's MAE on the 522 dropped
rows is 3.2946, against 4.8062 on the kept rows and 4.7750 across all 25,323,
because a one- or two-week season is usually a low-usage or injured player
whose weeks are easy. **Every figure in this document — model, oracle, σ²w,
floor, headroom — is computed on the same 24,801 rows.** No quantity here
subtracts one population from another.

**Sample total variance `SST/n` = 60.3836**; the sum of the
fitted components `σ²b + σ²w` = **60.3945**. The two differ in the hundredths
because one is a raw sample moment and the other uses the mean-square
denominators. Both appear below; each is labelled where it is used.

| predictor | R² | MAE | RMSE | what it is |
|---|---|---|---|---|
| the model — prior weeks only, strictly causal | 0.3186 | 4.8062 | 6.4146 | what ships |
| leave-one-week-out season mean | 0.3223 | 4.7167 | 6.3973 | **a noisy estimate, not a ceiling** |
| shrunk leave-one-out mean (`k = σ²w/σ²b = 1.59`) | 0.3317 | 4.7763 | 6.3523 | a better estimate; a **lower bound** on the ceiling |
| in-sample season mean | 0.4548 | 4.2122 | 5.7379 | **overfit** — it saw the week it predicts |

**That last row is the punchline.** The "between-player share of variance"
published as 0.4548 in the first version *is* the R² of a predictor that cheated
— the group-mean predictor scored on the rows that built it. `SSB/SST` and "the
R² of the in-sample group mean" are the same arithmetic. It is biased upward and
cannot be the ceiling either.

The unbiased ceiling is the between-player **variance component**, measured two
independent ways:

| estimate of the true-level ceiling | value | model's share | headroom |
|---|---|---|---|
| ANOVA variance components (σ²b = 23.2744, σ²w = 37.1200) | **0.3854** | **82.7%** | **+0.0668 R²** |
| implied by the leave-one-out oracle's own R² and the observed week counts | **0.4012** | **79.4%** | **+0.0826 R²** |
| *(raw `SSB/SST`, biased up — for reference only)* | *0.4548* | *70.1%* | *+0.1362 R²* |

The two unbiased estimates agree to within 0.016 and they bracket the answer.
**The figure to cite is the ANOVA one: the model sits at 82.7% of the ceiling
for player-level information, with +0.0668 R² still on the table — and the
ceiling is `for player-seasons with at least three scored weeks`, which is part
of the claim and not a footnote.** σ²w, σ²b and therefore the ceiling are all
estimated on the restricted sample, and the restriction is selective on
predictability (§2: the dropped rows are easier). It excludes only **2.06% of
rows but 11.1% of player-seasons** — 350 of 3,154 — and those thin-sample
player-seasons are exactly the cases where weekly features would plausibly
matter most, since there is almost no player history to lean on. **The ceiling
does not speak for them.** The first
version claimed +0.0037.

### 2.1 The reconciliation that settled it

The raw share is not merely "biased up" as a matter of principle — **its exact
value is predicted by the variance components**, which is what closed the
question:

```
E[SSB/SST] = (G-1)(σ²w + n₀·σ²b) / (N · var_total)
           = 2803 × (37.1200 + 8.8445 × 23.2744) / (24801 × 60.3836)
           = 0.454766
```

against the **0.4548** actually measured. The raw share is therefore fully
accounted for as the unbiased ceiling *plus the known inflation term*, to four
decimal places. There is nothing left in it for the ceiling to be, and 0.3854 is
the number the 0.4548 decomposes into.

On the error scale: the true-level RMSE floor is `√σ²w = 6.0926` against the
model's 6.4146, so **+0.3220 RMSE** of headroom.

### 2.2 The MAE floor, measured instead of assumed

**The first derivation of the MAE headroom is withdrawn.** It scaled the RMSE
floor by the leave-one-out oracle's MAD-to-RMSE ratio, which holds only if the
error distribution keeps its shape all the way down to the floor. That is an
assumption, not a measurement, and it is worth 0.37 of the answer: under a
Gaussian shape the same algebra gives a floor of 4.8612 and headroom of
**−0.055**, i.e. the model already past the floor. A claim that flips sign on an
unstated assumption is not a claim. Audit unit 12 was right to gate it.

**Measured directly, with no shape assumption at all**, on the same 24,801 rows:

| centre used for the player's level | mean &#124;y − centre&#124; | bias |
|---|---|---|
| his own season mean (fitted on the row it scores) | **4.2122** | biased **low** |
| his leave-one-out season mean (unbiased centre, noisy) | **4.7167** | biased **high** |
| the model | 4.8062 | — |

**The floor lies between 4.2122 and 4.7167, so the MAE headroom lies between
+0.0895 and +0.5940.** **It is positive at both ends, so the MAE headroom claim
cannot collapse** — the worst case is that it shrinks back to what v1
published, not that it reverses.

**That pessimistic end is not a second method agreeing with v1. It IS v1**,
identically: `model − LOO oracle` = 4.8062 − 4.7167, the same subtraction of the
same two numbers. It must never be presented as corroboration of v1; it is v1
re-labelled as one end of a bracket.

**The Gaussian branch is refuted by these rows, not argued away.** A Gaussian
error would show MAD/RMSE = 0.7979. Measured here:

| residuals of | MAD/RMSE |
|---|---|
| the model | 0.74926 |
| the in-sample season mean | 0.73411 |
| the leave-one-out season mean | 0.73731 |

Three different predictors, all near 0.74, none near 0.798. Weekly fantasy
scoring is floored at roughly zero and has a long right tail, so its
within-player error is leptokurtic relative to a Gaussian and always will be.
The −0.055 scenario requires a shape the data does not have.

**One honest correction to the bracket itself:** its two ends are not
independent measurements. `y − LOO mean = (y − own mean) × m/(m−1)` exactly, so
the two rows above are one quantity seen through two lenses. The bracket is
still a valid bracket — the biases genuinely run in opposite directions — but it
is not corroboration.

**A point estimate inside the bracket, and how it was calibrated.** Rescaling
each deviation to the floor's variance is exact algebra and preserves shape:
`var(y − own mean) = σ²w(1 − 1/m)`, so scaling by `√(m/(m−1))` lands on σ²w.
That gives **4.4558 — and the step carries an assumption of its own, which must
be stated wherever this number or 4.3804 appears: it assumes MAD rescales in
proportion to SD.** That is the same *class* of assumption just withdrawn from
the RMSE-ratio derivation, at much smaller magnitude but not zero. It still
overstates, because a deviation from a fitted
centre is the error mixed with a mean-of-others term, and that mixture is closer
to Gaussian than the error itself — which raises MAD/σ. Simulating seasons with
the measured shape and the real week counts sizes that inflation and iterates it
to a fixed point (×1.0265, ×1.0180, ×1.0172):

```
MAE floor    = 4.4558 / 1.0172 = 4.3804   (MAD-scales-as-SD assumption applies)
MAE headroom = 4.8062 − 4.3804 = +0.4258   95% CI [+0.3948, +0.4538]
               (cluster bootstrap by player, 1,000 iterations)
```

**+0.4258 is an estimate inside the bracket [+0.0895, +0.5940]; the bracket is
what may be cited, and the two travel together in the same sentence, always.**
The confidence interval is not the uncertainty here: it is 0.059 wide against
the bracket's 0.5045, **8.6 times narrower**, because it measures sampling noise
in one estimator and not the choice of estimator. Quoting the CI alone would
misrepresent how well this is pinned down by a factor of nearly nine.

The withdrawn +0.3141 was too small rather than too large, and sat inside the
bracket throughout.

**And the true floor is lower still, for a reason worth stating.** The MAE-optimal
constant for a player is his *median* week, not his mean, and weekly scoring is
right-skewed. Centred on the season median the in-sample figure is **3.9979**
against 4.2122 on the mean — both biased low in the same way, but the 0.2143 gap
is real and runs in one direction. A true-level predictor aiming at the mean is
not the best a true-level predictor can do, so **+0.4258 — inside the bracket
[+0.0895, +0.5940] — is a floor on the headroom, not a ceiling on it.**

**This is the sixth instance of one recurring defect across this project's
evidence work, and the general form is worth carrying:** any MAE-optimal
quantity is a **median**-type statistic, so deriving one from a mean or from a
variance decomposition is a category error. The RMSE-ratio scaling and the
mean-centred floor are both that same mistake, in different clothes.

Correspondingly the within-player share is **61.5%** (`σ²w/(σ²b + σ²w)` =
37.1200/60.3945, the component sum; the oracle-inversion method gives 59.9%), not the 54.5% the
first version published, which was the complement of the same biased number.

**Read that as the opposite of a demotion.** The headline correction says the
model has more room left than was claimed, which sounds like bad news about the
model. This says the week-to-week pool is *larger* than published. **So "aim at
the week, not the player" gets stronger, not weaker.** Nearly 62% of weekly
fantasy scoring is a player varying against himself, and that is the part no
amount of knowing *who* he is can reach.

## 3. The four features: the arithmetic changes, the verdicts do not

**What the denominator means, before any share is read.** The floor is the best
**player-constant** predictor — one number per player-season. The four features
below are *weekly*: they live inside σ²w, the part a per-player constant cannot
reach at all. So "0.73% of the headroom" means **"closed 0.73% of the gap
between the model and a perfect per-player constant"**. It is a normaliser for
comparing four small effects on one scale, **not** a share of what is
achievable, and it must not be read as one.

**4.8062 is this harness's model MAE on these 24,801 rows and is never
comparable with the R&D rig's 4.757** — different harness, different population.

**Both columns are on the MAE scale**, not the R² scale §2 uses — a feature's
gain was measured in MAE, so its share has to be taken against MAE headroom. The
denominator is the MAE headroom of §2.2: the bracket **[+0.0895, +0.5940]**
with **+0.4258** estimated inside it. The intermediate +0.3141, derived by
scaling and now withdrawn, is not used here at all.

**The absolute gain is the measurement. The share is a derived normaliser, and
it inherits the bracket** — a share of 0.4258 is only as pinned as 0.4258 is, so
each one is given as a range across the bracket's ends with the estimate inside.

| feature | **measured gain (MAE)** | share of the gap to a per-player constant |
|---|---|---|
| depth-chart rank | **+0.0031** | 0.73% est., **0.52%–3.46%** across the bracket |
| practice participation | **+0.0007** | 0.16% est., **0.12%–0.78%** |
| route share | **+0.0008** | 0.19% est., **0.13%–0.89%** |
| red-zone touches inside 10 | **+0.0004** | 0.09% est., **0.07%–0.45%** |

The range's wide end is the share against v1's +0.0895, which is the bracket's
pessimistic end and the same subtraction v1 made. **Quote the gain; the share is
context for it, not a second measurement of it.**

**All four still failed, and they failed on their own evidence** — none cleared
its own confidence interval, and that is a fact about each feature's measurement
which this correction does not touch.

**What changes is the explanation.** The first version said they were competing
for a ninth of a fantasy point and there was essentially nothing to win. They
were competing for about a third of a point, and they won almost none of it.
That is still a clear negative on each feature. It is no longer evidence that
the category is empty.

The depth-chart observation survives unchanged: rank 1 averages 10.91 PPR, rank
2 5.73, rank 3 4.23, and the feature still adds nothing, because the gradient is
already inside `targets` and `offense_pct`.

## 4. What this does and does not say

**It does not say the model is good.** R² 0.3186 on weekly points is a modest
model, and a projection this uncertain should never be displayed as a bare
number. That was true before the correction and is true after it.

**It does not say the player-descriptive category is exhausted.** The first
version did say that, and **that claim is withdrawn.** With ~+0.067 R² of
player-level headroom measured, "a fifth player-descriptive feature is not worth
harness time" no longer follows from this document. Four specific features
failed; the category has room left in it that none of them reached.

**Week-specific features remain a distinct and well-motivated class**, because
no season-long average of a player can contain information about what makes
*this* week different for him:

- **opponent matchup**, including the OL-vs-DL item, week-specific by
  construction
- **teammate availability** — the target that opens when the other receiver is
  out, which `contingency.js`'s availability build already has the raw material
  for
- **game script and pace as an opponent-adjusted pairing**, not a team's own
  season tendency
- **weather and venue**

That case stands on its own logic and never depended on the withdrawn number.
What it no longer carries is the corollary that the player-descriptive class
should be abandoned.

## 5. Recommendations, revised

1. **Week-specific features are still the better bet, but "drop the
   player-descriptive remainder" is SUSPENDED.** It rested on a headroom figure
   that was too small by a factor of eighteen. Re-derive the ordering against
   the corrected headroom — **+0.0668 R², and on MAE a bracket of
   [+0.0895, +0.5940] with +0.4258 estimated inside it** — before dropping
   anything. OL-vs-DL first is unaffected
   — it was first on its own merits.

2. **Ship the uncertainty, not just the projection. Unchanged, and
   strengthened.** With **61.5%** of weekly variance irreducible from player
   identity — more than the 54.5% first published — a model at R² 0.32 printing
   "11.4 points" is making a claim the data does not support. A range earned
   from the measured residual spread tells the truth and is more useful for a
   start/sit decision. This is a product decision and the correction only adds
   to its case. Spec: `docs/spec/projection-range.md`.

Nick's bar is "no feature gets in on vibes". The symmetric reading is what the
first version got wrong: **a feature does not get *excluded* on vibes either,
and a headroom figure nobody had checked is exactly that.**

## 6. Method, so this can be checked or overturned

- Population: 24,801 out-of-sample player-weeks, 2018-2025, WR/TE/RB, active
  weeks only, player-seasons with ≥3 scored weeks, from the same purged
  walk-forward that produced every other number in this series. Features from
  prior weeks in-season only; fixed feature divisors so no test statistic leaks
  through scaling.
- Variance components by one-way ANOVA on player-season groups with the
  unequal-group correction `n₀ = (N − Σmᵢ²/N)/(G − 1)`; `n₀ = 8.8445` here.
  `σ²b = (MSB − MSW)/n₀`, ceiling `= σ²b/(σ²b + σ²w)`.
- The independent check inverts the leave-one-out oracle instead: used directly
  as a prediction, its R² is `1 − W·(1 + 1/(m−1))` averaged over the observed
  week counts, which solves for `W` and so for the between share. It uses no
  ANOVA assumption about group means, and it lands at 0.4012 against ANOVA's
  0.3854.
- **Where the first version's arithmetic went wrong, stated for the record.**
  Inverting the oracle *with the biased 0.4548 substituted in* returns an
  implied 5.11 scored weeks per player-season. The data has **8.84**. That
  mismatch is the signature of the bias, and it is a second, independent way to
  have caught this.
- **Stated limit:** ridge regression, and this container has no numpy, pandas or
  sklearn. A tree ensemble could extract interactions this cannot. The ceiling
  argument itself is model-free — it is a variance decomposition, and no
  predictor built only from player identity can explain within-player
  week-to-week variance.
- **Stated limit, new:** the ANOVA components assume within-player variance is
  homoscedastic, and in fantasy scoring it grows with a player's level. That is
  the most likely source of the 0.3854-vs-0.4012 gap, and it is why the ceiling
  is quoted as a range rather than a point.
- Reproduction: `ceiling2.py`, `ceiling3.py` and — for §2.2's measured MAE
  floor — `ceiling_mae.py`, `ceiling_mae2.py` and `ceiling_mae3.py`, scratchpad,
  pure Python 3,
  reading the 25,323 saved walk-forward predictions. Both reproduce every figure
  in the first version exactly — model 0.3186/4.8062, oracle 0.3223/4.7167, raw
  between share 0.4548, n = 24,801 — which is how the rows were confirmed
  identical before anything was changed.

## 7. Revision history

- **v1, 2026-09-22.** Published "the model captures 98.9% of the oracle's R²;
  headroom +0.0037 R² and +0.0895 MAE", and recommended dropping the
  player-descriptive feature class on the strength of it.
- **v2, 2026-09-22.** Headline withdrawn. Adjudicated the same
  day: the audit accepted this derivation over a competing one that kept the
  raw 0.4548 as denominator, on the strength of the §2.1 reconciliation, and
  recorded that its own check had passed because two errors cancelled. The oracle was a noisy
  estimate of a ceiling rather than a ceiling, and the 0.4548 offered as the
  variance ceiling was the R² of an overfit in-sample predictor. Corrected
  headroom ~+0.067 R², model at ~80% — the adjudication below pins both to
  +0.0668 R² and 82.7%, which are the figures to quote. The four feature
  declines stand on their
  own evidence; the recommendation to drop the category is suspended; the
  recommendation to ship a range is unchanged and strengthened.

- **v3, 2026-09-22, this version.** Audit unit 12 confirmed the R² and RMSE
  work and gated the MAE headroom, correctly: +0.3141 was scaled from the RMSE
  floor on an unstated shape assumption worth 0.37 of the answer, with a
  Gaussian shape giving −0.055. §2.2 replaces it with a direct measurement —
  an assumption-free bracket of [+0.0895, +0.5940] whose pessimistic end is
  still positive, a measured MAD/RMSE of ~0.74 on three predictors that rules
  the Gaussian branch out, and an estimate of **+0.4258 MAE** inside it.
  Accepted on review with five binding labels, all applied: +0.0895 is v1
  itself and never corroboration of it; the `√(m/(m−1))` step carries its own
  MAD-scales-as-SD assumption and says so wherever 4.4558 or 4.3804 appears;
  the CI travels with the bracket because it is 8.6× narrower and measures
  something else; §3's denominator is a normaliser against a per-player
  constant, not a share of what is achievable; and 4.8062 is never set beside
  the R&D rig's 4.757. The 25,323-vs-24,801 gap is reconciled in §2 (178
  one-week and 172 two-week player-seasons, 522 rows), with the filter's own
  non-neutrality stated. The four verdicts are untouched, as they rest on each
  feature's own interval and not on any denominator. Also labelled 60.3836
  (sample total variance) against 60.3945 (component sum).
- **v4, 2026-09-22.** Both gated conditions discharged and §3 cleared to quote,
  with two labels applied here: each share is given as a range across the
  bracket behind the absolute gain, which is the measurement; and the ceiling
  is scoped to player-seasons with at least three scored weeks, a restriction
  that is selective on predictability and excludes 11.1% of player-seasons
  while excluding only 2.06% of rows. Verdicts unchanged at every step.

**Anything downstream of v1's number needs re-deriving**, in particular any
argument that leaned on "there is no room left in player-level features".

## The five questions

- **Well built?** The first version was not, and the defect was visible inside
  its own tables — a stated ceiling of 0.4548 next to an "oracle" scoring
  0.3223. This version states its assumptions and gives the ceiling as a range
  from two independent estimators.
- **Stats or made up?** Stats. 24,801 out-of-sample predictions, variance
  components measured two ways that agree to 0.016, every v1 figure reproduced
  before anything was changed.
- **How do we know?** Because the correction is checkable four ways: the overfit
  predictor's R² equals the raw between share exactly, the two unbiased
  estimators bracket each other, inverting the oracle with the biased figure
  returns 5.11 weeks where the data has 8.84, and the bias term predicts the
  raw share to four decimals (§2.1). The last of those is what the audit
  accepted.
- **Pointed anywhere else on the platform?** Recommendation 2 is, and stands —
  an interval on every projection surface, spec'd at
  `docs/spec/projection-range.md`. Recommendation 1 is suspended pending
  re-derivation.
- **How does it unify?** It replaces a comparison between two noisy estimates
  with a variance decomposition that says what is reducible and what is not, and
  it does so in the same units the projection-range spec already uses — which is
  where the same upward bias was caught once before, in that spec's §7.
