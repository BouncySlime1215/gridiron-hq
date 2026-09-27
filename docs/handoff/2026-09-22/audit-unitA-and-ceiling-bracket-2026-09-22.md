# Auditor — Unit A (Unit 18 closure) and the ceiling MAE-floor bracket
2026-09-22 ~11:30Z. Both ACCEPTED with conditions. Nothing here authorises a build.

# PART 1 — UNIT A. ACCEPTED. Plan 05's sharp prediction is REFUTED and I record it
# as a failed pre-registered prediction of mine, not a widened one.

## A.1 The refutation is accepted ON THE MECHANISM (claim 3), not on claim 1
Claim 3 is not a fit, it is an identity. Minimising `Σ|aᵢ − m·pᵢ|` over m is
`Σ pᵢ·|aᵢ/pᵢ − m|`, whose minimiser is the **pᵢ-weighted median of aᵢ/pᵢ**.
No free parameters. It predicts 0.742/0.478/0.000 against measured
0.740/0.480/0.000, and 1.087 against a grid-searched 1.085. That is a derivation
reproducing four numbers it was not fitted to. **Accepted.**

Why it kills `p < m* < 1`: the zero rows occupy the bottom of the weighted mass,
so the weighted median falls to roughly the 37th percentile of the played ratio
distribution (indicative: (0.5−(1−P))/P = 0.367 at P = 0.7895; the weights are
pᵢ, not counts, so treat that as the shape of the argument, not a figure). A
right-skewed ratio distribution puts that well below 1, and **nothing places it
above P(played)**. My prediction assumed a mean-type quantity and m* is a
median-type quantity. That is a category error, and it is mine.

**FAILED PREDICTION, LOGGED, NOT WIDENED** — alongside the 40-100 k band.

## A.2 The negative control (claim 2) is the right control and it is decisive
On played rows only, MAE-optimal flat multiplier **0.915** while
mean(actual)/mean(pred) = **1.0464**. Same rows, opposite sides of 1. The sub-1
optimum is right skew, not availability. Accepted. It also explains claim 5:
on the #14 carries baseline the MAE optimum is 1.085, **above** 1, on a different
baseline and population. **The multiplier's side of 1 is baseline-dependent and
carries no information about availability. Nobody may cite it as such again.**

## A.3 My 18.4 arithmetic test — RUN, and I was mis-posed
`1/mean(pᵢ)` restricted = 1.2198 against the target 1.0548: distance **0.1650**,
worse than the 1.1775 it was meant to improve on (0.1227). The restricted set is
absent MORE often (19.88% vs 18.63%). And `f = den0/den` is referenced to
`p_none`, not to 1, so `1/p_none` was the wrong inversion. 1.0302 vs 1.0548 is
Jensen. **My test is withdrawn; the answer it was reaching for is A.1.**

## A.4 Claim 5 self-correction — ACCEPTED
#14's baseline is not "5% under-scaled". 1.0548 was the committee mean used as a
flat control; measured MAE optimum 1.085 (8.5%), mean-matching 1.2485 (24.9%).

## A.5 Claim 6 — the predA list is the artifact Unit 18 asked for. ACCEPTED, and
## here is the consequence, which is binding.
Through predA: **#13 sf-test, #14 rf-test, #15 gs/gt-test, #16 dc-test, #17 first
run cs-test**; all multipliers **downward-only**. Unaffected: #10, #11, #12,
#17-final, #18-#22. #17's −0.0700/−0.0719 are from `cs-decision.mjs:18` on
`_decision_rows`, not predA.

A downward multiplier shrinks both arms toward zero and **compresses** the gap
between them, so measured effects are deflated. Therefore, in #13/#14/#15/#16/
#17-first:
- a **NULL is VOID as a null** — the effect may exist and be compressed below
  detection. It must be re-run un-multiplied before "no effect" is claimed.
- a **POSITIVE is CONSERVATIVE** and survives as a lower bound.

**This is Condition B's failure mode arriving a second time by a different
mechanism: an instrument that reports "no effect" when it means "cannot tell".
Any unit killed on a null from those five is un-killed until re-run.**

## A.6 Claims 1 and 8 CONFLICT IN SIGN. One labelled table before either is quoted.
Claim 1: m* − P(played) = **−0.0495** (none) and **−0.1770** (Questionable).
Claim 8: m* − P(played) = **+0.0036** [−0.0135,+0.0213] and **+0.0113**
[−0.0052,+0.0288], i.e. indistinguishable and, if anything, positive.
These cannot both stand as written. Note also that **claim 8 does not refute
`p < m* < 1`** — its intervals do not exclude m* > p. The refutation rests on
claim 1 and on the mechanism at A.1. Different populations or splits is the
likely explanation; say which, in one table with n on every row. Same requirement
as 12.4 item 3, third occurrence.

## A.7 Claim 7 — MY RECORD IS NOT BACKWARDS. No correction is due.
Verified verbatim, `audit-units-12-13-14-2026-09-22.md:30`: *"it moved the
absolute level from 4.757 to 4.514 while the repo records 4.921, i.e. away from
production"*. Memory `gridiron-offline-rig-evidence-line.md:29`: *"adding those
rows moved the rig's absolute 2024 level from 4.757 to 4.514, i.e. FURTHER from
the repo's 4.921"*. That is the Explorer's statement exactly. **We agree on every
number and on the direction.**

The collision is the word "fix". `audit-unit-11:32` used "the fix" for the
**augmentation**; Unit A uses "the fixed rig" for the **unaugmented** one. Unit 11
is already withdrawn, so nothing needs editing.

**NAMING RULE, binding on everyone from now: `unadjusted rig` and
`absence-augmented rig`. The word "fixed" is banned on this instrument.**

Claim 7's figures otherwise accepted: 2023 conditional 4.622 n=4,306 / decision
5.152 n=4,443; 2024 conditional 4.757 n=4,343 / decision 5.261 n=4,471, row count
stated beside every decision figure. Condition A's precondition is discharged.
**Condition A itself stays directions-only** — one calibration point, 3.3% low,
is not two.

## A.8 Disposition
**Rule and correction, no build. Correct.** Blindness statement accepted
(`nfl_injuries` empty, so `role-scenario-engine.js:127` is "cannot tell", not
"no effect").

---

# PART 2 — THE CEILING GATE. ANSWERED WELL. +0.4258 accepted as an estimate,
# the BRACKET is what may be cited.

## B.1 The gate is met and the Gaussian branch is closed by measurement
Measured MAD/RMSE on these rows: **0.74926 model, 0.73411 in-sample, 0.73731
LOO** — none near √(2/π) = 0.79788, residuals leptokurtic. My −0.055 branch is
dead, killed the right way: by measuring the thing I said was assumed. **The
withdrawal of +0.3141 is accepted and so is the reason for it.**

Note in passing: those three ratios span **2.06%**, which is exactly why
ratio-scaling was unsafe. The measurement vindicates the objection while
answering it.

## B.2 The bracket, verified
`4.8062 − 4.7167 = 0.0895`; `4.8062 − 4.2122 = 0.5940`. Floor ∈ [4.2122, 4.7167],
headroom ∈ [+0.0895, +0.5940]. Upper end of the floor sits below the model, so the
claim **shrinks, it does not reverse**. Correct.

**But +0.0895 is not a second method agreeing with v1 — it IS v1, identically.**
v1's headroom was `model − LOO oracle` = 4.8062 − 4.7167. The bracket's lower end
is that same subtraction. Do not present it as corroboration.

## B.3 Self-finding (1) is the best thing in the submission and I endorse it
`y − LOO mean = (y − own mean)·m/(m−1)` exactly. The two bracket ends are **one
statistic through two lenses**, with opposite biases — not two methods. (Check:
m̄/(m̄−1) = 1.1275 and 4.2122 × 1.1275 = 4.7492 against LOO 4.7167, the residual
being per-player variation in m.) **They found the defect I would have raised,
before I raised it. Credited.**

## B.4 The point estimate — ACCEPTED AS AN ESTIMATE, with the assumption named
`var(y − ȳ) = σ²w(1 − 1/m)` is exact. Going from `E|y − ȳ|` to `E|y − μ|` by
√(m/(m−1)) is **not** — it assumes MAD scales as SD, i.e. shape invariance.
**That is the same class of assumption just withdrawn, at much smaller
magnitude** (a 6.2% correction inside a bracket already measured, rather than an
extrapolation 18× its span). Proportionate, and therefore acceptable — **provided
it is labelled as an assumption every time 4.4558 or 4.3804 appears.**
Verified: 4.4558/1.0172 = 4.3805, headroom 0.4257.

## B.5 BINDING PRESENTATION RULE: the CI is not the uncertainty
[+0.3948, +0.4538] is **0.059 wide**; the bracket is **0.5045 wide — 8.6×**. The
CI is sampling error conditional on one estimator choice. Quoting +0.4258 with its
CI and without the bracket understates the real uncertainty by nearly an order of
magnitude. **Every appearance of 0.4258 carries the bracket in the same
sentence.**

## B.6 Self-finding (2) is right and it converges with Unit A
The MAE-optimal centre is the player's **median** week, not the mean (in-sample on
the median 3.9979 vs 4.2122), so +0.4258 is a **lower** bound on headroom.

**This is the same discovery as Unit A's claim 3, reached independently by a
second unit on a different problem. Promote it to a standing principle:**

> **Any MAE-optimal quantity is a median-type statistic. Deriving one from a
> mean- or variance-based decomposition is a category error.**

It retires three errors at once: Plan 05's `p < m* < 1` (mine), the ratio-scaled
MAE floor (theirs), and the mean-centred floor (theirs). **Add to the recurring
defects list as defect #6.**

## B.7 Two conditions before §3's shares are quoted again
1. **RECONCILE 24,801 vs 25,323 — 522 rows.** Almost certainly player-seasons with
   m = 1, where LOO is undefined; say so and confirm. **The load-bearing check is
   that the model's 4.8062 is computed on the SAME 24,801 rows.** If it is on
   25,323 the headroom subtracts two populations — the exact error I committed in
   Unit 12.4 and it is now the fourth occurrence of cross-population subtraction
   in this project.
2. **Label the denominator.** The floor is the best **player-constant** predictor.
   §3's features — depth-chart rank, practice participation, route share,
   red-zone inside-10 — are **weekly** features that live inside σ²w and are not
   bounded by this decomposition. So "0.73% of headroom" means "closed 0.73% of
   the gap between the model and a per-player constant", which is a normaliser,
   **not** "captured 0.73% of what is achievable". Changes no verdict — all four
   failed on their own CIs — so this is presentational and binding.

## B.8 Also binding
4.8062 is **not** the rig's 4.757. Different harness, different population. They
must never appear in one comparison.
Labels 60.3836 = SST/n and 60.3945 = σ²b + σ²w: accepted, that was my minor.
Guard pair not run: acceptable, it runs on the tree that pushes.

## The five questions
1. **Well built?** Both, now. Unit A's claim 3 and the ceiling's self-finding (1)
   are the strongest work either unit has submitted.
2. **Stats or made up?** Stats. One remaining assumption, named at B.4.
3. **How we know:** every figure above recomputed independently from the
   submissions' own inputs; the two sign conflicts (A.6) and the row-count gap
   (B.7) found that way.
4. **Pointed anywhere else?** Defect #6 governs every future MAE-optimal claim.
   The predA null/positive asymmetry (A.5) re-opens five packages' nulls.
5. **How it unifies:** two units converged independently on the median/mean
   category error; it explains a refuted prediction of mine and a withdrawn
   derivation of theirs with one sentence.

---

# ADDENDUM 11:35Z — rulings on (b) and (c)

## R1. #16 — ACCEPTED AS VOID. The Explorer is right and my rule was too coarse.
My 11:30Z rule had one channel: a sub-1 multiplier shrinks both arms and
**compresses** their difference, so nulls are void and positives conservative.
There is a **second, directional channel** I did not state — the **level**. If the
predA multiplier pushes the baseline off its own MAE-optimal level, then any
candidate moving the level further that way is penalised, and any candidate moving
it back is rewarded, **independent of whether the term carries information.**

The Explorer's evidence for that channel is its own: **#15's first run showed
+0.0414 [+0.0157,+0.0763] that was the bucket fit correcting the baseline's
level** — the level channel caught in the act, paying out as a false positive.
The same channel run in reverse is what makes #16's harm unsafe.

**Replaces my 11:30Z rule. Classify by the direction the CANDIDATE term moves
predictions relative to its arm's baseline, then:**

| candidate term | measured HELPFUL | measured NULL | measured HARMFUL |
|---|---|---|---|
| lowers predictions | conservative, survives | VOID | **VOID** |
| raises predictions | **VOID** (inflated) | VOID | conservative, survives |
| two-sided, mean-preserving | second-order, survives | VOID | second-order, survives |

Nulls are void in every row — that is the compression channel, which is
direction-free.

**#16 is prediction-lowering (depth rank enters as a multiplier below 1 for
backups) and measured harmful: top-right of row 1. VOID. Un-killed, re-run.**
Noted that the Explorer argued this against its own interest.

**CONSEQUENCE I MUST CORRECT: my acceptance of #13 and #14 as "conservative lower
bounds" was unverified.** It holds only if their terms are prediction-lowering or
two-sided. **Classify #13, #14, #15 and #16 by candidate direction and state it.**
If #13 or #14 is prediction-raising, its positive is inflated and it joins the
re-run queue.

**CONDITION ON THE RE-RUNS.** Removing the multiplier only removes the level
confound if the un-multiplied baseline is itself near its own MAE optimum, and
per defect #6 that is a median question, not an assumption. **Each re-run reports
the baseline's own MAE-optimal flat multiplier** — the prediction-weighted median
of actual/prediction from Unit A claim 3, one pass, no new data. If it is far from
1, the same confound is back at a different size and the re-run does not settle
the unit.

## R2. Order — CONFIRMED, with one thing moved earlier.
A defect in a **published** package outranks re-running two units that are already
marked void: published work is in circulation and may be cited, voided work cannot
do harm while it waits. **#20 re-reports write-up first, then the #15/#16
un-multiplied re-runs.**

**Do now, not after:** record the VOID marks on #15 and #16 where anyone reading
them will see them. That closes the citation window for free.

## R3. (c) — ACCEPTED, and the conflict was MINE.
Claim 1 is `m* − P(played)`, a unitless parameter difference on the 2022 fit
season. Claim 8 is `MAE(m* arm) − MAE(P arm)` in fantasy points on held-out
seasons. **Different quantities in different units on different seasons. I
compared a parameter difference to a performance difference and called it a sign
conflict.** My A.6 is withdrawn; the table is what I asked for and it resolves it.

Their framing is right and I endorse it: the refutation of `p < m* < 1` rests on
the fit-season parameter and claims nothing out of sample, and **a multiplier
sitting below P while scoring the same is itself the finding.**

One line to add to it, because it explains the flatness rather than just reporting
it: `Σpᵢ|rᵢ − m|` is piecewise linear in m with slope = (weighted mass below m) −
(weighted mass above m), so it is **locally flat around the weighted median** for
any dispersed ratio distribution. m* is therefore weakly identified by
construction. **That is why a sharp prediction about where m* sits was a poor gate
in the first place — mine.** Same root as defect #6.

## R4. Standing note
Two kills in this project have now been traced to the instrument rather than the
evidence: Condition B's empty tables, and predA's level channel. **No unit may be
killed on a null, or on harm from a prediction-lowering term, without a statement
of what the instrument could have shown.**

## R5. Ceiling — both conditions DISCHARGED. Shares CLEAR, with two labels.
Reconciliation verified and internally exact: 178 + 344 = 522 rows, 178 + 172 =
350 groups, 3,154 − 350 = 2,804 player-seasons. It is m = 1 **and** m = 2, not
m = 1 alone — I guessed m = 1 and was wrong about the cause while right about the
kind. The same-rows check is the one that mattered and it is confirmed in the code
path: all arms score the post-filter `kept` list, so 4.8062, the oracle, σ²w, the
floor and the headroom come off one population. **B.7(1) discharged.**

Their volunteered filter finding cross-checks exactly:
`(24,801 × 4.8062 + 522 × 3.2946)/25,323 = 4.7750`, matching their stated
all-rows figure to four decimals, lift **0.0312**. Volunteering it was right.

**Q1 — do §3's shares clear? YES, with one addition.** A share of 0.4258 is a
share of a point estimate whose bracket is [0.0895, 0.5940], so the share itself
ranges **0.52% to 3.47%** for depth-chart rank. "0.73%" reads as negligible;
"3.47%" does not. **Quote the ABSOLUTE MAE gain first (depth rank = 0.0031 MAE)
and the share second with its range.** Absolute numbers do not move with the
denominator. Changes no verdict — all four failed on their own CIs.

**Q2 — does the 0.03 need more than the §2 statement? ONE LABEL MORE.** The §2
statement covers exporting the baseline. It does not cover scope: the filter is
selective on predictability (dropped rows are 1.5 MAE easier), and σ²w, σ²b and
therefore the ceiling are all estimated on the restricted sample. **So this is the
ceiling for player-seasons with ≥3 scored weeks** — 2.06% of rows but **11.1% of
player-seasons** — **and the excluded thin-sample cases are where weekly features
such as depth rank and participation would plausibly matter most.** Label the
ceiling with that population. Nothing further.

## R6. #20 re-reports — ACCEPTED, with one unverifiable claim and one attribution refused.

**Leading with a defect in its own published package is the right order and I
credit it.** The correction makes every figure better, which is the harder
direction to report honestly.

**R6.1 — I CANNOT VERIFY THE DEFECT ON THE TREE I CAN REACH, and there is a
mechanism question.** `/mnt/project-files/cp-test.mjs` is presumably post-fix.
On it, **`:181` builds `byWeek` from `r.week` off `ev.rows`, and `:184` filters
the same `ev.rows` on `r.week < w`.** If `grab()` stripped `week` from those rows,
`:181` collapses to a single `undefined` key and **the rolling loop runs ONCE, not
once per week** — which is not "every week calibrated on the prior season alone".
Either the description or my reading is off. **Supply the pre-fix diff and say
which rows `grab()` stripped.**

**R6.2 — VALIDATE THE FIX BY MECHANISM, NOT BY THE IMPROVEMENT.** A bug whose
correction improves every number is the case where checking stops early. Print the
calibration-set size per week and show it **grows within season**. One line,
decisive.

**R6.3 — R1's seed correction is RIGHT and MY UNIT 16b RULING IS CORRECTED.**
Verified `weekly-backtest.js:91`: `withRandomSeed(opts.seed ?? 20260826, …)`. The
gate's seed was the default all along; "no stated seed" was my error. **The other
two differences stand — 200 vs 300 draws and 2023-24 vs 2025 — so the conclusion
that #20 never ran the repo's gate survives on those.**

**R6.4 — MY CHEAPEST TEST IS ANSWERED, AND I REFUSE THE ATTRIBUTION.** I asked
whether the coverage offset was the draw setting. Result: 200 → 300 moves coverage
**+0.009 (2023) and +0.008 (2024)**. Their own R4 measures coverage noise at
**±0.007** at n ≈ 4,300. **The draw-count effect is barely outside their own noise
band on one re-run each, so "a rig property, not draw count" is not established —
neither component is separated.** What *is* established: 2024 sits **0.011 below
the 0.78 floor at 300 draws, 1.57× the noise band** — real, small, and not
explained. **G1 UNESTABLISHED stands, and this strengthens it rather than changing
it.**

**R6.5 — R3's "all six in band" is weaker than it reads. Restate it.** R4's
±0.007 is at n ≈ 4,300; these buckets are n = 1,196-1,637, so the band scales to
**±0.011 to ±0.013**. Measured against the nearest gate edge: 0.005, 0.004, 0.011,
0.014, 0.010, 0.009. **Five of the six sit within one noise band of an edge.**
Carry the per-bucket band on every bucket figure.

**R6.6 — R4 IS THE MOST VALUABLE SECTION AND REACHES PRODUCTION. Promote it.**
Randomized PIT makes coverage and calibration error depend on RNG stream position:
**±0.008 cal.err, ±0.007 coverage at n ≈ 4,300** over 40 re-draws, and it
reconciles the published 0.065/0.055 inside the prior-only bands. This is an
empirical confirmation of the repo's own warning at
`scripts/fit-weekly-coverage.mjs:26-31`, which asserted it without quantifying it.
**Consequence for production tooling:** that gate is `TARGET=0.80,
GATE=[0.78,0.82]` — ±0.02, only **2.9×** the noise band — so a single draw can
flip a true value near either edge. **Candidate unit for the coordinator: evaluate
the gate as a median over k re-draws rather than one.** I do not authorise builds;
this is a recommendation to queue.
Their G2 margins (0.040 vs 0.090) are far outside the band, so G2 is unaffected.

**R6.7 — R5 ACCEPTED, and the discipline is the point.** Statement written before
numbers, 3/5/8 bins, not switching from 5. **8 bins is marginally better on 2024
CRPS (−0.084 vs −0.080) and the pre-registration holds anyway — that is the case
where pre-registration costs something, which is the only case that proves it is
real.** Record it that way.

**R6.8 — Order CONFIRMED as proposed:** #21 restatements (published, therefore
first, same rule as R2), then the #15/#16 un-multiplied re-runs under R1's
condition, then partial pooling. **Partial pooling is new work and must not start
while a void is outstanding** — the proposed order already satisfies that.

## R7. Direction refinement — ACCEPTED. My R1 matrix is SUPERSEDED, and the rule
## it replaces it with is not the final form either: PRICE, don't classify.

**My R1 rule assumed m0 = 1** — that the un-multiplied baseline sat at its own MAE
optimum, so a sub-1 predA left the arm under-scaled. **Measured, both halves are
false.** The #14-family base optimum is **0.910** (the base over-predicts by 9.9%)
and the predA arm's optimum is **1.085** (under-predicts by 8.5%), so the
multiplier **crossed** the optimum instead of walking away from it. My matrix had
the sign backwards for that arm. **Superseded.**

Their proposed rule — direction relative to m0, computed and never inferred from
above/below 1 — is correct and strictly more general. **Accepted.**
Their self-correction on #16 is also accepted: `dc-test.mjs:94` with the pooled
ratio divided out at `:72` gives multipliers **0.9810-1.0645 straddling 1**, so
#16 is the two-sided case, void for the second-order reason, not the lowering one.

### R7.1 The better rule is the one their own measurement demonstrates: PRICE IT
They did not just classify, they **priced** the channel, and the pricing is
strictly better than any direction rule because it returns a number instead of a
sign. Verified: base 3.1529 at 1.000 and 3.1069 at optimum (headroom 0.0460);
predA 3.1212 / 3.0884 (headroom 0.0328); measured gain **0.0317**, level component
**0.0132 = 41.6%**, **information remainder 0.0185**.

**REQUIREMENT on all four re-runs: report the decomposition — total, level,
information — not the direction.** Direction is the fallback for arms that cannot
be priced. Each arm priced on its own rows with the weighted median beside the
grid, as they did here.

### R7.2 Three conditions on the pricing
1. **The level component needs an interval.** 0.0132 is a difference of two
   estimated optima; reporting the remainder as if exact repeats defect #5 one
   level down. Cluster bootstrap on player, same machinery as everything else.
2. **41.6% IS NOT PORTABLE.** It is one arm, n = 2,727, carries. Do not carry it
   to #13, #15 or #16 — **price each on its own rows.** The note's phrase "roughly
   40%" is already one step from becoming a project constant.
3. **Mean-preserving must be measured, not asserted.** For a per-row candidate,
   report the prediction-weighted mean of its multiplier and the arm's m0 before
   and after. A weighted mean of 1.01 is not mean-preserving, and the toward/away
   rule then applies at that size.

### R7.3 One narrative claim the numbers do not support
"Crosses the optimum and **lands slightly closer**, so the level channel pays" is
not carried by 0.085 vs 0.090. Headroom fell **28.7%** (0.0328/0.0460 = 0.713) for
a distance change of **5.6%**; linear in distance predicts 0.944, quadratic 0.892,
both far above 0.713. **The two arms' MAE-vs-multiplier curves have different
shape** — unsurprising, since predA shrank every prediction and changed the spread
of the ratios. **The pricing stands; drop the distance narrative.**

### R7.4 HOLDOUT LEDGER — one line needed
The arm was priced on **2024-2025** rows. Pricing a baseline's own level is a
measurement of the incumbent, which is in the class I said costs no holdout — but
**state explicitly that no 2025 row entered a selection decision, and log the
use.** 2025 is a protected asset and its ledger only works if every touch is
recorded.

### R7.5 Consequence — ACCEPTED
"#13/#14 survive as lower bounds" is **WITHDRAWN** (mine, twice corrected now).
Both LOWER predictions, both sit on an arm whose level channel pays a positive, so
their positives are **UPPER bounds**. **Four re-runs: #13, #14, #15, #16.**

### R7.6 Order — CONFIRMED
#21 restatements, then the four re-runs, then partial pooling. Unchanged from R2
except two becomes four.

## R8. §R6 closures and #21 restatements — ALL ACCEPTED. Two additions.

**R6.1 DISCHARGED and verified by me directly, not taken on report.**
`cp-test.mjs:53-54` maps `_predictions` to `{pred, actual, position, player_id}`
— **no `week`**; `weekly-backtest.js` puts it on every row; `cp-rerun.mjs:55`
adds `week: p.week`. The defect is real, still present in `cp-test.mjs`, and the
mechanism is the collapsed loop: one `undefined` key, one pass, `undefined <
undefined` false, one arm from `priorRows` over all 4,343 rows. Numbers unchanged.
**One addition: mark the DEFECT ON THE FILE, not only in the spec banner.**
`cp-test.mjs` sits in the same directory as the spec that cites it; the next
reader runs it.

**R6.2 DISCHARGED, and it cross-checks.** 2024 w18 calibration 8,320 = prior
season 4,306 + 4,014 rows from weeks 5-17, leaving **329** for week 18 against a
14-week average of 310. Internally consistent, and "week 5 equals the prior season
exactly" is the right invariant to have shown.

**R6.4** accepted, attribution withdrawn.

**R6.5 — their MEASURED bands beat my scaled ones, and my count was wrong.**
I scaled R4's ±0.007 by 1/√n and got ±0.011-0.013; measured per bucket it is
±0.008-0.011. My "five of six" rested on that over-estimate; **four of six is
correct on the measurement.** Measuring beats scaling — accepted.
**One addition: two sets of bucket coverages are now in circulation on IDENTICAL
n** (2024 was 0.785/0.816/0.791, now 0.787/0.811/0.785). Same rows, so the
difference is pure re-draw noise — a live demonstration of R4, and exactly why
**one set must be marked canonical.**

## R9. #21 restatement 1 — ACCEPTED, and the refutation is stronger than stated
## and needs no asymptote at all.
Closed form verified: `(1 − 0.35^W)/(0.65W)` against measured W=1..5 —
1.0000/1.0000, 0.6659/0.6750, 0.4895/0.4908, 0.3737/0.3788, 0.3067/0.3061, worst
deviation **1.36%**. Delta ratios from the closed form are 0.567, 0.608, 0.650,
0.689 — rising toward 1, so 1/W decay, not geometric, and the inferred limit is an
artifact. Correct.

**THE STRONGER FORM: `W = 6` gives 0.2559, already BELOW the claimed 0.27-0.28
convergence — one season past the data, no limit argument required.** Use that.

**AND DROP "falls like 1/W to zero".** A false asymptote was corrected by
asserting a different asymptote, and the second is as far outside the data as the
first. It also invites the mirror-image error. **State the range: over W = 1..5
the ratio falls monotonically 1.00 → 0.31 with no asymptote in range, and W = 6 is
already 0.256.** Note too that the closed form assumes **flat volume**; it is
validated to 1.4% on W = 1..5 and is scoped there.
*Minor:* the quoted successive ratios 0.44/0.56/0.64/0.69 reproduce neither the
closed form (0.567/0.608/0.650/0.689) nor the measured series. State which series.

## R10. #21 restatement 2 — ACCEPTED, and it makes the published figure a best case
`nratio.mjs` applies no week filter, so **0.307 is the end-of-season value**.
Trajectory 2024: w1 0.1452, w5 0.1971, w9 0.2441, w13 0.2722, w18 0.3067.
**There is no single n-ratio — it is a trajectory. Replace the single 0.307 with
the trajectory, or at minimum the range 0.197-0.307, and say which week any
quoted figure is at.** The operative number where the weekly replay starts is
**0.197**, so #21's finding is larger than published, as they say.

**Question to route, not a finding:** a weighted n at one fifth of raw in week 5
is the same region Unit 1's early-week blend occupies. Worth one check whether
these are the same phenomenon seen from two sides. I have not read NRATIO-SPEC in
full and am not ruling on it.

**Holdout ledger accepted** — multipliers fitted 2022-2023, no 2025 row entered a
selection decision, use logged. **R7 pricing rule and the order stand:** four
re-runs, then partial pooling.

## R11. The four re-runs — ALL ACCEPTED. Method sound, arithmetic exact.
Every figure recomputed: #13 total 0.0926 = level 0.0285 (30.8%) + information
0.0641; #14 total 0.0704 = level 0.0228 (32.4%) + information 0.0475; implied
ceilings 0.4410 and 0.6277, information shares **14.54%** and **7.57%**.
**Re-estimating m0 inside every resample is the right construction** and removes
the plug-in bias I would otherwise have required.
**My 41.6% non-portability condition is vindicated:** measured 30.8% and 32.4%,
not "roughly 40%". Price each arm, as ruled.

### R11.1 Plan 01 criterion 1b — YES, RESTATE IT TO THE INFORMATION SHARE.
**1b becomes 14.6%; 21.02% is superseded wherever it appears.** The level
component is capturable by a **flat multiplier computed in one pass with no new
data**, so it is not attributable to the feature. Leaving 21.02% in creates both
failure modes at once: an implementation capturing the information but not the
rescale fails its own gate, and a bare flat rescale banks ~31% of the credit
without the feature. **#14's 11.2% → 7.6% by the same rule, wherever it gates.**

### R11.2 THE LEVEL FINDING IS REAL BUT IT IS NOT WHAT IT LOOKS LIKE — my own
### ruling from an hour ago applies to me here.
base m0 = **0.870** (#13) and **0.879** (#14), and 1/m0 = 1.149 / 1.138. **Do not
say the baseline over-predicts by 15%.** Unit A's claim 2 is the negative control
for exactly this: a sub-1 MAE optimum arose there from **right skew alone**
(optimum 0.915 while mean(actual)/mean(pred) was 1.0464). Defect #6.

**Defensible:** a flat 0.870 reduces MAE by 0.0290 on that arm, 1.9% of its MAE,
with no new data. **Not established:** that predictions are biased high.
**Before any flat-rescale unit is proposed, measure mean(actual)/mean(pred)
beside m0.** And note the product consequence: **a flat rescale that improves MAE
while introducing mean bias is not free** — anything needing unbiased levels
(trade valuation, projections shown to a user) pays for it. That trade-off is a
decision, not a measurement.

### R11.3 #15 — accepted as a NULL, and the word matters.
Mean-preserving confirmed by measurement (weighted mean 1.0016 / 1.0014, range
[0.9705,1.0414]). Information +0.0013 **[−0.0040, 0.0068]** straddles both signs.
**That is "no detectable effect", not "negative".** Closing it as negative asserts
harm the interval does not carry. **VOID LIFTED — correct, because the re-run has
no predA, so the compression channel is gone.**

### R11.4 #16 — accepted, and the decomposition is what makes it safe.
Level **−0.0039 [−0.0091, 0.0010]** straddles zero, consistent with the measured
near-mean-preserving 0.9998 / 0.9972; information **−0.0204 [−0.0269, −0.0139]**
excludes zero. **The harm is information, not level.** VOID LIFTED, harmful
confirmed, on both plays and carries.

### R11.5 The misclassification admission is the argument for the pricing rule.
Direction was read off write-up tables and was wrong on **both** #15 and #16;
pricing did not depend on it. **STANDING RULE: a direction or mechanism claim
cites the APPLYING LINE, never a write-up table.**

### R11.6 Delta series — reconciled, and one thing to stop quoting.
`(W/(W+1))²` gives 0.250, 0.444, 0.562, 0.640, 0.694 — **that is the 0.44/0.56/
0.64/0.69 exactly.** Mystery closed, and it confirms the 1/W² delta order
analytically.
**But drop the measured delta ratios entirely.** From the relayed series
(1.0000, 0.6659, 0.4895, 0.3737, 0.3067) I compute **0.528, 0.656, 0.579** — not
the 0.537/0.500/0.423 reported, and either set fails to rise toward 1 the way the
exact ones do. Differencing a noisy series to infer asymptotic order **is how the
original error was made.** The levels validate (1.4% agreement); the exact ratios
argue. The measured deltas do neither.

### R11.7 "Ceiling" now names three different quantities
0.4258 (fantasy-point headroom), 0.4410 (#13 targets), 0.6277 (#14 carries).
**Every share states which ceiling.** `k = 34` annotation verified: 110.9 raw
targets at week 18, 172.5 at week 5.

**Partial pooling may proceed — every void is closed.**

## R12. Partial pooling NULL accepted; ceiling discrepancy resolved AGAINST ME.

### R12.1 Ceilings — THEIRS IS CANONICAL, mine was never a measurement
0.4405 / 0.6265 stand. **My 0.4410 / 0.6277 were inversions of the rounded shares
21.0% and 11.2%** — a back-computation that cannot be more precise than three
figures, and it should not have been presented as a check. Theirs reproduce the
published **21.02%** and **11.22%** exactly, which settles it. My restatements are
unchanged at that precision: information shares **14.55%** and **7.58%**.

### R12.2 The over-prediction reading — killed by measurement, and there is a
### validation in it nobody has stated
mean(actual)/mean(pred) = **1.0217** (#13 base) and **1.0225** (#14): both arms
**slightly UNDER-predict in the mean** while wanting a 13% down-scale under MAE.
That is Unit A's control reproducing exactly; the sub-1 optimum is pure right
skew, and the "baseline over-predicts by 15%" reading is dead. My caution stands.

**The validation nobody stated, and it is what makes 0.0641 trustworthy:** at
their respective MAE optima both arms sit at nearly the same mean bias —
base 1.0217/0.870 = **1.1744** vs candidate 1.2056/1.020 = **1.1820**, a gap of
**0.65%**; #14 is 1.1633 vs 1.1835, **1.74%**. **The information comparison is
bias-matched.** Add it to the record; it is the check that rules out the
information gain being bought with bias.

### R12.3 A product decision, routed — not mine and not Nick's
At the MAE optimum either arm ships projections **~17-18% low in the mean**. That
is larger than "slight" and it is a real trade: MAE is the wrong sole metric for a
surface a user reads. **Whatever ships reports mean signed error beside MAE.**
Which to optimise is a data/product call, which under the standing routing belongs
to the coordinator, not to Nick and not to me.

### R12.4 Partial pooling — NULL ACCEPTED, and the real finding is that the design
### could not have detected its own best case
2024 diff +0.0007 **[−0.0097, +0.0111]**, point estimate on the wrong side. Clean
null, pre-registered, k frozen on 2023, 2025 untouched, rolling calibration sizes
printed. All correct.

**But the fit season's WHOLE k range is 0.0103** (4.3488 at k=∞, which equals
control by construction, down to 4.3385 at the optimum) **against a test-season CI
half-width of 0.0104 — a ratio of 0.99.** A perfect result was indistinguishable
from zero before the test was run.

**NEW GATE-1 CRITERION, effective now on every pre-registration: state the maximum
achievable effect and show it exceeds the test's resolution.** A pre-registration
that cannot pass its own best case is not a test.

**k = 4 and k = 8 TIE at 4.3385** and k = 8 was taken. More shrinkage is the
conservative tie-break and I accept it, but **state the tie-break rule and
pre-register it next time.**

**Decomposition not run per criterion — honouring the pre-registration is CORRECT
and I do not override it.** But a null total can hide offsetting level and
information components, and a null is exactly where they are most informative.
**Mandatory in every future pre-registration regardless of the primary's outcome.**
Optional here as a clearly-labelled post-hoc diagnostic.

**Also:** mean signed error moved **−0.4954 → −0.5462** while MAE stayed flat —
another MAE-flat change moving bias, the same theme as R12.3.

### R12.5 The trap — refusal to quote is CORRECT. Affirmed, not softened. And
### escalated in the only form that is legitimate.
`nfl_snaps`, `nfl_qbr_weekly` and `nfl_depth` are empty, so **Condition B binds:
the rig's answer is "cannot tell", not "the shipped weights are worse".** Ruling
the comparison out in advance was right.

**Escalate it as a QUEUED PRODUCTION READ, not a rig claim** — same class as
Unit 1's Gate-1 live read, still the standing blocker. If it holds in production
it means shipping weights beaten by a trivial baseline, which is precisely what
this seat exists to surface.

**And reconcile it against a fact I hold and the Explorer may not:
[[gridiron-no-promoted-fit-has-ever-run]] — production has never served any
promoted weekly fit.** If no promoted fit has ever run, "shipped weights" may be a
hypothetical about weights production is not using. That makes the trap either
moot or worse, and the coordinator now holds both halves.

### R12.6 Next pick — APPROVED with gate-1 criteria
The Unit 1 early-week question is cheap and connected. Conditions:
(a) state whether the week-5 n-ratio and the early-week blend act on the **same**
weighted-n quantity or two different ones — I raised this as a question, not a
finding, and have not read NRATIO-SPEC in full;
(b) the incumbent is `EARLY_WEEK_MAX_PRIOR_WEEKS = 3`, **whose own CIs straddle
zero per Unit 1 — it may never be described as evidence-backed**;
(c) Condition B blindness statement; (d) no 2025.

## R13. UNIT 17b — GATE MET. CLOSES, with three conditions on how it is written up.

My missing gate was: run the REAL in-file `fitAllK`/`buildFitSpecs` and reproduce
#22's five k values and both MAE deltas. **Done, and it reproduces.**
k deviations: **0.23, 0.80, 0.61, 1.13, 0.01 percent** — no structural outlier,
which is what a faithful mirror looks like. Deltas: 2024 **+0.0000
[−0.0039, 0.0039]** against spec +0.0010, both indistinguishable from zero;
2023 **+0.0160 [0.0076, 0.0238]** against spec +0.0150, **both excluding zero.**

**The load-bearing finding survives on the real code: 2023's effW arm is STILL
significantly worse than the hardcoded 34.** Wiring effW does not make the fitted
efficiency k safe to serve.

### C1 — State the fresh-CSV limitation
The original CSV directory is gone, so the rig was rebuilt from fresh nflverse
pulls. **This is same-code / near-same-data, not same-data**, and a 0.2-1.1%
spread cannot separate small mirror infidelity from an nflverse revision. The
evidence is still strong — five independent k values, no outlier — but the
limitation belongs in the write-up, not in my head.

### C2 — The harm-removed percentage: label it or drop it. Prefer drop.
98.0% / 63.4% are **#22's figures on #22's data**. Recomputing with the
reproduced effW delta against #22's raw delta gives 100% / **61.0%** — a
cross-rig subtraction, the error I have now ruled on four times. **Either
re-measure the raw-fit arm on the new rig so the ratio is internally consistent,
or drop the percentage.** It is a share against an undeclared denominator
(defect #5) and it is decoration here.
**The shippable statement is the absolute delta: after wiring effW, 2023 is
+0.0160 [0.0076, 0.0238] worse than the hardcoded 34, and 2024 is
indistinguishable.**

### C3 — The "live read" relabel is MANDATORY, not cosmetic
A "live read" that is a **local dev sqlite** (`shrinkage_fits` 1 row, active=0) is
the misrepresentation class this seat exists to catch. The relabel must carry
**"this proves nothing about production."** It is *consistent with*
[[gridiron-no-promoted-fit-has-ever-run]] but is not evidence for it, and must
never be cited as such.

### Accepted without condition
Plan 07 RED tests 3 and 4, mutation-verified — **test 4 guards exactly the scope
boundary I flagged** (`K.share` is path-independent; swapping `roleW` for `effW`
at the target_share call site would ship to all twelve callers). Good test.
Suite measured on the pushed tree, guard-verified twice, 0 failures.

### One line still owed
**2,989 / 2,948 / 0 / 41 — what are the 41 skips?** "0 fail" is only as strong as
the skip list, and the total has moved from the ~3,020-3,037 seen on other
branches. One line naming the skipped files.

### Scope, restated for the PR body
The efficiency k **is not applied in production**, so this unit changes no shipped
number. **PR #106 is a correctness fix** — the file's stated invariant at
`shrinkage-fit.js:60-67` versus the dead `effW` at `:323` — and must not be
written as a model improvement.

## R14. Ceiling derivation ACCEPTED; early-week stand-down ACCEPTED; a pattern
## across four units escalated as a standing finding.

### R14.1 Ceiling derivation — verified, one label required
Recomputed: #13 1.512160 − 1.071708 = **0.440452**, share **21.013%**, information
**14.55%**; #14 1.069260 − 0.442805 = **0.626455**, share **11.226%**, information
**7.58%**. Same rows, difference of two arm MAEs. Clean.
**No in-sample-oracle problem:** the ceiling arm substitutes `actualOf`, a known
future quantity, not a fitted constant scored on its own rows. Defect #1 does not
apply.
**LABEL REQUIRED: this is the OPPORTUNITY-FORECASTING ceiling at fixed share, not
a model ceiling.** It is the right denominator for #13 and #14 because both are
volume features; a share-side feature is not bounded by it. Fourth ceiling in
circulation — the label is not optional.

### R14.2 Early-week — UNIDENTIFIABLE. Correct stand-down, pre-registered.
**My routed question is ANSWERED, and the answer is no.** #21's quantity is a
decay-weighted opportunity count against `K.yards_per` inside the structural head;
the blend keys on `prior_weeks`, in-season graded weeks, no decay, no
opportunities. **Two different quantities that co-move with week-in-season.** The
flag was worth raising; it does not survive.
Non-identifiability is properly demonstrated: worst-pair IQR overlap **0.015**
against a registered threshold of 0.25, and every low-bucket cell in evidence
quintiles 2-4 at n < 100 — no common support. Gate-1 (a)-(d) all met.

**THE POWER CHECK WAS DONE BETTER THAN I SPECIFIED, AND I ADOPT THEIR FORM.**
I asked for "the maximum achievable effect"; they operationalised it as an
**oracle candidate fitted on the eval season's own answers**, beating control by
0.0030 against a CI half-width of 0.0039, **ratio 0.77**. That is the strongest
form of the criterion. **And the in-sample oracle is the CORRECT choice here
precisely because its bias is upward** — an upward-biased maximum makes the
stand-down conservative. Defect #1 inverted into a correct tool by direction.
**This is now the canonical form of the gate-1 power check.**

*Minor:* "4+ is 88% of rows" computes to **86.79%** from the stated n
(7,437 / 8,569). One line.

### R14.3 ESCALATED AS A STANDING FINDING: MAE-flat changes move signed error, in
### four independent units now.
- #13 / #14: at the MAE optimum either arm ships **~17-18% low in the mean**.
- Partial pooling: MAE flat, signed error **−0.4954 → −0.5462**.
- Early-week: MAE moves **0.02** while signed error worsens **−0.50 → −0.71** as
  arms get more flexible.

**This is not three coincidences. Optimising MAE on this data systematically
moves the mean low, because the MAE optimum is a median-type quantity on a
right-skewed target (defect #6).** It is a product risk on every surface a user
reads a number from, and it is larger than any feature effect in the queue.
**Not a unit for me to open — routed to the coordinator as a standing finding
with the same recommendation: mean signed error reported beside MAE on
everything, and the choice of what to optimise made deliberately.**

### R14.4 "Shipped weights" correction ACCEPTED, and it sharpens the trap
The arm is `weeklyEnsemblePrediction(context, WEEKLY_ENSEMBLE_WEIGHTS)`, the
hardcoded constant at `weekly-ensemble.js:59-64`, the α = 0 endpoint of the
control's own family. **Since no promoted fit has ever run, that constant IS what
production serves** — so the gap is about live behaviour, not a hypothetical.
Condition B still makes it "cannot tell" on the rig; **queued production read
stands.**

**ONE THING BEFORE THAT READ IS DESIGNED: break the comparison out BY POSITION.**
`WEEKLY_ENSEMBLE_WEIGHTS` is per-position (structural head QB 0.40 / RB 0.50 /
WR 0.60 / TE 0.80, `weekly-ensemble.js:59-63`; the complementary history exposure
is 60/50/40/20 — writing the latter and calling it structural was my error), so a pooled
ordering can hide three positions being fine and one being bad — which changes the
fix entirely. It is an ordering claim, permitted under Condition A, and it makes
the production read far more targeted.

### R14.5 Next pick — NO OBJECTION, three conditions
Conformal bin-cut variable (predicted level vs evidence count) is a fair target:
it is #20's one unjustified choice.
1. **The resolution it must clear is the PIT noise band (±0.007 coverage,
   ±0.008 cal.err at n ≈ 4,300), not a bootstrap CI alone.** For a coverage
   metric that band is the binding floor. Oracle bound in R14.2's form.
2. **Quantify "not collinear" with the same overlap statistic the early-week unit
   died on.** Do not assert it.
3. **#20's G1 is still UNESTABLISHED**, so this cannot be framed as improving a
   validated instrument. And no 2025.

## R15. Item 2 ruled (the blocking one), items 1/3/4 accepted with conditions.

### R15.1 RESOLUTION FOR A CRPS-PRIMARY UNIT — NEITHER, as posed.
**The Explorer is RIGHT that the PIT band does not govern CRPS.** The randomised
PIT is a diagnostic transform for coverage and calibration error; it does not
enter CRPS. **I do not impose it as a floor on CRPS-primary units.** Their
reasoning is accepted.

**But the bootstrap CI alone is NOT the resolution either.** The bootstrap
resamples **rows with the simulation frozen**. It answers *"would other players
have given a different answer"*. It does not answer *"would another simulation
have given a different answer"* — and the predictive distributions here are Monte
Carlo (`runs` = 200/300). **CRPS therefore has its own draw-dependent noise, from
the same root as R4's PIT band: different statistic, same cause, never measured.**

**REQUIRED, once: measure CRPS's own re-draw band exactly as R4 measured the PIT
band** — same rows, same draw count, k different stream positions, report the
spread. Then **resolution = the two combined in quadrature**, or the larger if one
dominates. If the CRPS band returns an order of magnitude below the bootstrap CI,
record that and use the bootstrap CI for CRPS-primary units thereafter. **One
measurement retires the question permanently.**

**THE RULE TO REGISTER: the resolution of a gate is the noise of the WHOLE
pipeline that produces the number, not of one component. A bootstrap with the
simulation frozen is a LOWER BOUND on resolution.**

The binvar stand-down is unaffected: 0.0026/0.0168 = **0.155**, and it fails
against any larger resolution too.

### R15.2 Item 1 — ACCEPTED. One flag, and one pattern worth naming.
Gate 1.2 fails decisively and the stand-down is correct.
**FLAG: gate 1.1 passed MARGINALLY** — same-bin share 59.1% against a 60%
threshold, while Spearman 0.895 / 0.904 says the two cut variables are highly
correlated. Two statistics pointing opposite ways. Had 1.2 not failed, I would
have re-opened the identifiability call. Moot, but **record it so "identifiability
passed" is never cited later as a clean result.**

**CREDIT, and add it to the template:** bounding `CONFORMAL-SPEC` weakness 2 above
by **0.0026 CRPS** is the best possible outcome of a stand-down — a unit that
fails its power gate still produced a published bound. **When a power gate fails,
convert the oracle bound into an upper bound on the weakness it was testing.**
Arm E labelled a by-product and not a finding: correct.

### R15.3 Item 3 — ACCEPTED, one reconciliation owed
Labels in five spec files and the 86.79% correction withdrawn-in-text rather than
overwritten: both right.
**RECONCILIATION: the mae-flat memory.** The file in team memory is **mine**,
written 11:59Z, citing #13/#14, partial pooling, and early-week — three *measured*
instances. Theirs cites pooling, `weekly-ensemble.js:44-53` (convex vs LAD),
`weekly-ensemble.js:69-77` (per-season negative bias), and #15 as converse — two
*mechanism* citations I have not verified, plus a control I want kept.
**Two evidence sets for one finding is the duplication the memory rules exist to
prevent. Send me the two `weekly-ensemble.js` citations and I will merge into one
file** — mechanism and measurement belong together, and #15-as-converse is a
useful control.

### R15.4 Item 4 — FRAMING ACCEPTED with one correction; it DOES change the read.
**VERIFIED, and this is the check that makes the cancellation claim safe:** the
n-weighted candidate−control reconstructs the pooled null exactly —
(486×−0.0020 + 1112×−0.0255 + 929×−0.0075 + 1816×+0.0216)/4343 = **+0.000675**
against the reported +0.0007, and the four n sum to **4,343**. **State that
reconstruction in the addendum**; it is what turns "cancellation" from an
assertion into arithmetic.

**CORRECTION: "no per-position magnitude quoted" is not accurate.** Per-position
MAE **levels** are quoted and levels subtract to magnitudes — I just did it.
Write instead: *levels shown as the basis for the ordering; no per-position effect
is claimed*, and carry the rig label. Consistent with the existing label rule.

**IT DOES CHANGE THE PRODUCTION READ, favourably.** shipped−control is positive on
**all four positions** (+0.0346 QB, +0.0530 RB, +0.0891 TE, +0.0540 WR; n-weighted
+0.0591). **The shipped-weights gap is UNIFORM, not concentrated in one
position**, so the production read needs no per-position stratification to detect
it. That is exactly what R14.4 asked and it is settled.

**STILL OWED:** the trap as originally posed is *plain `season_to_date` beating
shipped*, and this addendum breaks out shipped vs **control** (a fitted α), not vs
`season_to_date`. **Break out `season_to_date` by position too** before the read
is designed.

**Condition A unchanged: ordering only. No magnitude leaves the rig.**

## R16. Package.json scripts and the betting-only test — (c), with a correction
## that reverses its default.

**I agree with the coordinator's (c)-documented-per-(b), and (c) as posed has a
hole that has to be closed before it is adopted.**

### R16.1 Why not (a) or (b)
**(a) scripts are never betting** is safe in the right direction but wrong: it
tells the Phase A plan there is more fantasy surface than there is.
**(b) classify on the header** is wrong as a *criterion*. A header is the author's
self-description of intent, not a fact about reach, and headers go stale. **It is
the same error as reading direction off a write-up table instead of the applying
line, which I ruled on an hour ago.** Keep (b) as the documentation format — the
quoted header beside each listed script — never as the test.

**(c) is right because it is the SAME test, applied to the right surface.** A
route file's reach is its routes; a script's reach into the product is **what it
writes**. Same "every way in" logic, different door.

### R16.2 THE HOLE: (c) as posed defaults an UNPROVEN NEGATIVE to betting-only
"A script is betting when nothing it writes is read by a fantasy surface" grades
on a negative that nobody has yet established. **The error is not symmetric.** A
false *wired* costs some scope. A false *betting-only* silently removes a module
from the fantasy plan's view — and the plan is the consumer.

**REWRITE (c): a script is betting-only when EVERY durable output it produces has
been traced and none is read by a fantasy surface. Untraced output → WIRED.**
An unproven negative is not a betting-only grade.

### R16.3 Three sub-cases (c) must name, or it will be applied inconsistently
1. **No durable output at all** (a diagnostic printing to stdout —
   `diagnose-passing-components.mjs` reads like one). It has no reach into *any*
   surface. Grading it "betting" is as arbitrary as grading it "fantasy".
   **THIRD BUCKET: `no-surface-reach`, reported separately, not folded into
   betting-only.** Forcing a binary here is where the false precision enters.
2. **Output read only by another script.** **Follow it transitively**, exactly as
   the route test follows call chains — one hop is not enough. The `nfl-features.js`
   defect was found down a six-hop chain, which is the proof that script reach is
   real and transitive.
3. **Output read by a fantasy surface.** Wired, full stop, whatever the header says.

### R16.4 Evidence bar per script, before any grade moves
(a) invocation path, `package.json` script name → entry `file:line` — they have it;
(b) **every durable write enumerated with `file:line`** — DB tables and filesystem
paths only; **stdout does not count as an output**;
(c) for each output, the **reader** at `file:line`, and whether that reader sits on
a fantasy surface, traced the same way the route test traces;
(d) an explicit **"no durable writes"** statement where that is the case, which
sends the script to bucket 3 rather than to betting;
(e) the header line **quoted as intent, marked explicitly as not the criterion.**

### R16.5 Report the figure as a BRACKET until all 13 are traced
**233/55 and 220/68 are bounds, not alternatives.** Publish both, and the bracket
must reach the **Phase A plan**, not stop at CONTRACT.md — a plan reading "233
wired" sizes work differently from one reading "220-233 wired, 55-68 betting-only,
31 unreached of 319". Same discipline as the ceiling bracket.

### R16.6 A pattern, third occurrence
**13 of 14 files turn entirely on a default.** That is an instrument answering
"no effect" when it means "cannot tell" — after Condition B's empty tables and
predA's compressed nulls. **A default that decides 13 of 14 cases is not a
default, it is the finding.** Opportunity recording it as a named gap and changing
no grade was exactly right.

*(The 14th file has no betting path, so it stays wired on any rule.)*

## R17. Scheduler import-reach and the six scripts. (c), with the brake flag
## EXCLUDED from the criterion, and a correction to my own R16 bucket 3.

### R17.1 MY R16 BUCKET 3 WAS TOO NARROW. Widening it, and it moves two scripts.
I defined bucket 3 as **"no durable output"**. Scripts 2 (`build-evidence-dataset.mjs`)
and 6 (`build-role-scenario-lab.mjs`) **do** produce durable output —
`server/data/evidence-datasets` and `server/data/role-scenario-lab` — but the only
reader of each is **its own writer** (`nfl-evidence-dataset.js:44`,
`role-scenario-lab.js:32`). No surface reads either.

Grading those betting-only would be wrong for the same reason bucket 3 exists:
**betting-only means every entry point that reaches it is a betting surface, and
here NO surface reaches it at all.**

**BUCKET 3 IS REWRITTEN: `no-surface-reach` = no durable output OR durable output
that no surface reads.** So **four of six** land there — 2, 3, 4, 6 — not two.

### R17.2 The two that move
**Script 5, `run-news-event-impact.mjs` → BETTING-ONLY.** Traced exhaustively:
four named readers, all betting, and `trade-proposals.js:46` correctly identified
as a **comment naming the table, not a query**. That is the applying-line
discipline doing its job. My R16 default (untraced → wired) does not block it,
because the negative here is **proven, not assumed** — which is the bar working as
intended rather than as an obstacle.

**Script 1, `nfl-blind-audit.mjs` → BETTING-ONLY on request reach, with a
job-reach caveat recorded.** Three betting-only readers plus
`nfl-candidate-findings.js`, and on B below that contact is job reach, not request
reach. **Answering the direct question: NO, `nfl-candidate-findings.js` is not a
fantasy reader for the purpose of script 1.**

### R17.3 SEPARATE, NOT A GRADING MATTER, AND I AM NOT LETTING IT PASS
`run-news-event-impact.mjs:3` says it **makes real billed Anthropic calls**. The
standing rule is **R&D: NOTHING PAID, ever.** A `package.json` script that bills
money on invocation needs a guard or a documented gate, and it belongs on the
morning list as its own item. Not part of the inventory ruling.

### R17.4 IMPORT REACH THROUGH `scheduler.js` — (c), and the flag stays OUT of it
Opportunity's own sentence is the ruling: the grader answers **"can the module be
loaded from an entry point"**, which is an upper bound on **"does the entry point
call it"**. One import of `recordSync` at `gamescript.js:21` pulling **357
modules** into reach is the tell — that number has no product meaning.

**There are two different kinds of reach and they must not be summed:**
- **REQUEST REACH** — a handler actually calls into the module.
- **JOB REACH** — the module executes because a scheduled job runs it.

Both are real; they differ in what work they imply and in what can switch them
off. So **(c), with the bucket named by MECHANISM, not by file: `job-reach only`**
(reached only through a job body, never from a request handler). Naming it
`reach via scheduler only` breaks the day a second scheduler exists.

**THE BRAKE FLAG IS EXCLUDED FROM THE CRITERION.** `SCHEDULER_DISABLED=1` is
operational state, not architecture, and it is **not in `fly.toml`, so a deploy
can drop it**. Grading on it means the inventory changes when someone edits an env
var, which is not what an architecture inventory is for. Job-reach earns its own
bucket on **architectural** grounds alone; **the flag is reported BESIDE it as a
live-state note.** That keeps the inventory stable and still tells the plan what
it needs.

**Bracket widens to 205-233 wired** (205/81/10/23 and 233/55/0/31, both summing to
319). The coordinator's recommendation is right and the width is **28 files, 8.8%
of the inventory** — too large for the plan to read a point.

### R17.5 A LIVE-BEHAVIOUR CONSEQUENCE, routed as a question not a finding
`nfl-auto-picks.js:12` imports **`promotedFindingVeto`** from
`nfl-candidate-findings.js`, reachable only through
`scheduler.js:1064`'s lazy job-body import — **and the scheduler is braked on the
live app.** It follows from their own facts that **the veto is not executing in
production today.** I do not know what it gates, so this is a question, not a
finding — but it is the "a layer goes inert and the surface says nothing" pattern
CLAUDE.md names, and it should be answered before the brake is lifted or left
down.

### R17.6 The `player-week-engine.js` note — acknowledged, no objection
A four-line field unread by anything on 213b09d, dropped, branch tests all against
`weekly-weight-store.js`. Dropping dead code is right. One confirmation only: that
the grep was run on the **pushed tree**, per the standing "real means measured on
the tree being pushed" rule.

## R18. R17 grades CONFIRMED on the enumeration. Two consequences of the
## `routes/mlb.js` correction that go past the one file.

**Scripts 1 and 5 STAND.** The write enumerations meet the R16 bar: script 1 at
`nfl-blind-audit.js:223/:926/:940/:866/:937/:955` (four tables, inserts and
updates); script 5 at `nfl-news-events.js:83/:109/:302/:305/:352/:372` plus
`nfl-news-event-impact.js:324-325` (both DB and filesystem), readers
`nfl-t60-packet.js:435` and `nfl-research-lab.js:132` — the other two modules
named earlier being the **writers**, not readers, which is the right reading.

**My R17 answer on `nfl-candidate-findings.js` survives and no longer depends on
the job-reach ruling.** With `routes/mlb.js` in hand it reaches no fantasy route on
the request path at all. Stronger, as they say.

### R18.1 THE TAXONOMY NOW HAS AN UNNAMED CATEGORY AND IT IS BEING ABSORBED SILENTLY
`/api/mlb` is **not** on the five-file betting-surface list. So a module whose only
request reach is `routes/mlb.js` is **not** betting-only by the definition — "every
entry point that reaches the module is a betting surface" is simply false of it.
It is not fantasy either. **Folding it into betting-only records a false fact in a
document the Phase A plan reads**, and it hides the category that is arguably the
most droppable of all: MLB is not in the approved product at all.

**FIX: add `routes/mlb.js` to the explicit surface list with its own label
(`mlb`), following the five-file precedent.** The alternative — renaming
betting-only to "non-fantasy-surface-only" — loses information and the old name is
already in circulation. Applies to script 5's trace too
(`nfl-t60-packet` reaches the three betting routes **and** `/api/mlb`).

### R18.2 THE REAL ISSUE IS THE METHOD, NOT THE FILE
"Every one of the 13 paths runs through `scheduler.js`" was **generalised from the
three shortest paths**, and the generalisation was wrong. That is a **method
error, not a one-file error.**

Two consequences:
1. **`nfl-candidate-findings.js` should come OUT of the job-reach-only bucket** —
   it has request reach, just from a non-fantasy surface. So the **28** is already
   known to be wrong by at least one.
2. **Re-derive all 28 exhaustively, not just this one.** If shortest-path
   generalisation was used once it may have been used throughout, and every member
   of that bucket is a file the plan is being told to ignore.

Recording the correction as dated in CONTRACT.md was right. **The bracket stays
205-233 until the re-derivation lands**, and the upper end may move.

## R19. Inventory method CONFIRMED with one check; stale_findings ruled; Plan 01
## accepted as built-ungraded with a look-ahead redirect.

### R19.1 Method — CONFIRMED, and it is the right kind of fix
Replacing path enumeration with a **set operation over the whole graph** (entry
points on full graph > 0 AND on request graph == 0) removes the class of error
entirely rather than patching the instance. All-paths by construction. Both
figure columns verified to sum to 319. The 27 and the `nfl-candidate-findings.js`
exclusion follow.

**THE ONE CHECK I WANT, and it could move the lower end back UP.** The request
graph is the full graph minus the **function-body import edge class** — 240 edges
of 1,927 (12.5%). That is a **syntactic** class, and not every function-body
import is a *job*-body import: a handler may lazily import for startup cost.
Removing the whole class would then delete **real request reach** and push files
wrongly into job-reach-only. **Count how many of the 240 sit in a function that is
itself reachable from a route handler.** If that is nonzero, 172 is too low.

### R19.2 Surfaces and the bracket
Six labels with every other mounted route defaulting to **fantasy** is the right
default direction — unproven counts as product, per R16. "One fantasy route
outweighs any number of off-product ones" is the definition applied correctly.

**Carry 172-228 to the plan, with two riders.**
1. **It is NOT a confidence interval. It is TWO DEFINITIONS** — 172 = request
   reach only, 228 = request + job reach. Label each end with its definition or it
   will be read as uncertainty. Same distinction as the ceiling bracket vs its CI.
2. **A monotone revision sequence is evidence of a still-biased estimator, not of
   convergence.** The lower end has gone 205 → 196 → 172 and the upper 233 → 228;
   **every revision moved the same way.** 172 is the current estimate, not a
   demonstrated floor. Name what could move it further (R19.1 is one such thing,
   and it moves it *up*) before the plan sizes on it. Width is **56 files, 17.6%
   of the inventory.**

I have **not** verified the 27-member list or the figures against the bundle —
only their internal consistency and the method's logic. Stated so nobody reads
this as an independent recount.

### R19.3 Veto question (R17.5) — ANSWERED, closed
`promotedFindingVeto` (`nfl-candidate-findings.js:328`) → `nfl-auto-picks.js:158`
→ published at `:188`, can only push an eligible NFL spread pick to abstain;
surface is the betting decision board and tape. **No fantasy surface either way**,
and per `:156-157` zero findings have ever been promoted, so it is inert twice
over. My question is closed and the answer is "betting-side and a no-op", not a
live-behaviour risk.

### R19.4 `stale_findings` — A REAL DEFECT, LOGGED, NOT QUEUE-JUMPED, WITH A TRIGGER
**It is a confirmed defect, and I will not soften that because it is betting-side.**
Collected at `:350/:355/:358`, the comment at `:345-349` commits to reporting it,
and it is reported nowhere — `nfl-auto-picks.js:188` publishes only `segment_key`
and `reason`. That is CLAUDE.md's named pattern exactly: *if a layer goes inert,
the surface must say so.*

**Disposition: LOG for Nick's list. It does not jump the queue.** Phase A is
fantasy, the order is standing, and the defect **cannot currently fire** —
scheduler braked and zero findings ever promoted. Nothing is being hidden today.

**But it is not log-and-forget. Record the trigger with it: the moment EITHER the
brake is lifted OR a finding is promoted, the silent path goes live.** Tie it to
the brake decision, which is already pending.

**One thing that should happen now regardless of side, and costs nothing: FIX THE
COMMENT.** `:345-349` asserts "It is reported" and nothing reports it. That is an
active falsehood in the codebase and the **second found today** after
`weekly-ensemble.js:5-12`. A true comment naming the open gap is strictly better
than a false one. It rides any PR touching the file; it is not a betting-side
feature change.

**RULE REGISTERED, third instance today: a comment asserting a behaviour is a
claim to be verified, and where it is unmet THE COMMENT IS A DEFECT IN ITS OWN
RIGHT**, independent of the underlying behaviour.

### R19.5 Plan 01 — ACCEPT AS BUILT-UNGRADED. Not a redirect.
The format's auto-redirect on missing (c)/(d) exists to stop **unsupported
claims**. Here the claim is explicitly "built and population-verified, NOT
graded", and (c)/(d) are **declared absent rather than faked**. Redirecting it
would punish the honesty the rule exists to produce. Their own sentence —
*"verifies code correctness, not predictive value"* — is the right one and must
survive verbatim into any PR body.

**Conditions:**
1. **STAYS UNMERGED**, and for a specific reason: it is a **multiplier on
   projections**, and per [[gridiron-mae-flat-changes-move-bias]] a multiplier
   that shifts the level moves mean signed error on a user-read surface. An
   ungraded multiplier is precisely that risk. (If `gradedAvailabilityMultiplier`
   is called by nothing today, it is also dead code on merge — same answer.)
2. **The grade IS queued as a named unit** to Explorer's rig-with-absences strand:
   `decision_including_dnp` walk-forward (**never** the conditional metric —
   `weekly-backtest.js:177` makes it structurally incapable of showing an
   availability term), row count beside every decision figure (+137/+128, ~3%),
   **mean signed error beside MAE**, the **level/information decomposition** per
   R7, and the **R14.2 power check declared before running**.
3. **TWO BUCKETS, STILL BINDING.** Doubtful n=335 on the *injuries* population
   does **not** lift the Unit 12 ruling, which was set on the **graded** population
   where Doubtful was n=20. **The retention floor applies where the term is
   graded, not where it is fitted.** And it costs nothing: Out 0.001 and Doubtful
   0.004 are indistinguishable from each other and from zero.
4. **Say "local dev sqlite", not anything stronger** — same relabel I required on
   17b. And reconcile against Unit A before the two ever sit in one table: Unit A
   measured Questionable P(played) **0.6570 (n=207)** on the rig's
   production-faithful rows; Plan 01 reports **0.561 normalised** against a 0.737
   baseline (n=2,868), implying ~**0.4135** absolute. Different populations and
   definitions, so not a contradiction — **state the mapping, because someone will
   subtract them.**

### R19.6 THE ONE REDIRECT, and it must land BEFORE the grade
**The fit population and the serving path are conditioned differently, by their
own description.** They fit against `nfl_injuries` — which **UPSERTs in place and
therefore holds only FINAL designations** — while serving reads as-of-decision-time
through `nfl_feature_revisions`.

So the fitted Questionable ratio is computed on players whose **final** status was
Questionable, **excluding those who deteriorated to Out**. A decision-time
Questionable includes them. **The fit therefore OVERSTATES availability for the
population it will actually serve, biasing the multiplier optimistic.**

**Required: fit on as-of status from `nfl_feature_revisions` as well, so fit and
serve share a conditioning set. This lands BEFORE the grade, not after** — grading
a look-ahead-contaminated fit produces a number that cannot be trusted in either
direction.

Credit where due: using `nfl_feature_revisions` on the serving path, and writing a
look-ahead safety test at all, is why this was findable. The trap was half-avoided;
the other half is the fit.

## R20. CRPS re-draw band ACCEPTED with one addition; position read STRATIFIED;
## one unit registered; and the 60/50/40/20 withdrawal is itself half-wrong.

### R20.1 §R8 — ACCEPTED AS REGISTERED, arithmetic reproduced
Every figure checked and reproduces.
- sd ratio: 1/sqrt(runs) predicts sd(200)/sd(300) = sqrt(1.5) = 1.2247; measured
  0.00467/0.00392 = 1.191. At n=40 the sd of an sd is ~1/sqrt(2*39) = 11.3%, so
  the ratio carries ~16%; 1.19 vs 1.22 is well inside. Mechanism confirmed, not
  merely asserted.
- Quadrature: 2024 0.0225/1.645 = 0.013678, sqrt(0.013678^2 + 0.00392^2) =
  0.014229, x1.645 = 0.02341 -> 0.0234, +4.0%. 2023 0.0180/1.645 = 0.010942,
  sqrt(...+0.00366^2) = 0.011538, x1.645 = 0.01898 -> 0.0190, +5.4%. Both
  intervals exclude zero. **R1-R3 verdict STANDS.**
- Band vs bootstrap SE: 0.01368/0.00392 = 3.49x. "Not an order of magnitude, so
  carried" is the right call at that ratio.
- **The hash split is the load-bearing move and it is correct.** A conformal
  arm's sample is quantiles of calibration residuals, so delta = conformal -
  simulated inherits the simulated arm's draw noise EXACTLY, which is why
  quadrature is the right combination rather than a doubling. Deterministic
  demonstrated by hash, not by argument: that is the standard, keep it.

**THE ONE ADDITION, and it is not a caveat, it is a different error mode.**
Every gate evaluates the incumbent at the SAME default seed 20260826. The draw
error `e` is therefore **common-mode across gates, not independent**.
Consequences, both of which have to be in the rule or it will be misapplied:
1. **N gates at one seed are NOT N independent confirmations.** They all inherit
   the same `e`, in the same direction, for that season. Never aggregate them as
   independent evidence of an incumbent's standing.
2. **Contrapositive, and it is a gift:** for two candidates graded against the
   same incumbent draw, `delta_g - delta_h` carries ZERO draw noise — `e`
   cancels. **Candidate ORDERING against a common incumbent needs no band at
   all; only the margin-vs-incumbent does.**
So: the band inflates a per-gate CI, and is a common-mode shift across gates.
Registered as the operative form of §R8.

Their volunteered point is exactly right and is the reason the above matters:
20260826 is one draw, not the centre (2024/300 reads +0.00374 = 0.95 sd high,
2023/300 -0.00217 = 0.59 sd low). It flatters 2024 by ~5% of the effect and
understates 2023. Both inside the band, no verdict moves, and volunteering it
unprompted is the behaviour the gate format exists to produce.

### R20.2 Production read design — STRATIFIED BY POSITION. Ruling (b): yes, both.
Table reconciles row for row. All four columns rebuild the pooled figure from the
position means and n (4.5251 / 4.4976 / 4.4660 / 4.4667, n 486+1,112+929+1,816 =
4,343), and the n-weighted std-minus-shipped is -0.027465 = pooled -0.0275
exactly. shipped-minus-control is +0.0346 / +0.0530 / +0.0891 / +0.0540, same
sign on all four, pooled +0.0591: uniform, R14.4 reconciled.

**Stratify, and the reason is stronger than "a sign reverses":**
**a pooled statistic taken across a sign reversal is MIX-DEPENDENT.** The rig's
position mix (486/1,112/929/1,816) is not production's roster mix, so -0.0275 is
not transportable to the surface it is meant to inform — it would move with the
mix alone, with no behaviour changing. That argument does not depend on the
reversal being real, which is why the design decision can be made now.

**But the CLAIM is not established, and must not be written as one.** +0.0378 on
QB at n=486 arrives **with no per-position interval**. Paired arms this similar
have small paired SE, so it may well hold, but (c) requires the interval and it
is absent. **Per-position paired-bootstrap CIs before "QB reverses" is stated
anywhere.** Until then: "pooling is unsafe here" is supported; "QB behaves
differently" is not.

Their "not claimed" on structural exposure is correct and I verified the
non-monotonicity myself: by exposure QB 0.40 / RB 0.50 / WR 0.60 / TE 0.80 the
gaps run +0.0378 / -0.0245 / -0.0190 / -0.0817, which is not monotone (RB to WR
moves the wrong way). Condition B applies; declining to explain it is right.

### R20.3 Ruling (c) — ONE unit, and it is the read design
**Register the read design. Do NOT register the conformal-vs-incumbent gate.**
That gate's verdict SURVIVED the band (R20.1); re-stating a surviving verdict as
a fresh unit spends Opus time to re-confirm what is already ruled, and Nick's
standing order is essential checks only. **§R8 is a record amendment to the
existing R1-R3 verdict, and it is already written. It is done.**
Rule registered: **a verdict that survives a new instrument is amended, never
re-opened as a unit.**

The read design is the right pick because it has a decision attached and is
deliverable offline. Note for the queue: the read itself needs Nick (no live
network in these sessions; the 08:04Z read was his). Design it to be one
paste-able read, as that one was.

### R20.4 THE WITHDRAWAL IS HALF-WRONG, AND I AM CORRECTING MY OWN CORRECTION
Asked to withdraw "60/50/40/20" in my three audit-* files in text. **Two of the
three are correct as written and a blanket withdrawal would replace a true
statement with a false one.**

Off `weekly-ensemble.js:59-63` against `:56-58`:
QB 0.40 structural, history 0.45+0+0.10+0.05 = **0.60**; RB 0.50, history
0.20+0.10+0.15+0.05 = **0.50**; WR 0.60, history 0+0+0.10+0.30 = **0.40**;
TE 0.80, history 0.20+0+0+0 = **0.20**.

**60/50/40/20 QB/RB/WR/TE is the exact HISTORY-head exposure. 40/50/60/80 is the
structural exposure. They are complements, which is precisely why I confused
them.** My error was never the sequence; it was attaching it to the word
*structural*.

Done, in text:
- `audit-unitA-...:763` said "`WEEKLY_ENSEMBLE_WEIGHTS` is per-position
  (60/50/40/20 QB/RB/WR/TE)" — reads as the vector itself, i.e. structural.
  **CORRECTED** to the structural figures with the complement named.
- `audit-unit-1-early-week-blend-...:113` and
  `audit-unit-1-gate3-live-read-resolved-...:30` both say **"history exposure"**
  and are **CORRECT**. Not withdrawn; each now carries the complement and a line
  saying which statement was the withdrawn one.

**POOLING-PREREG-2026-09-22.md:190-191 needs one fix.** Its structural reading
(QB 0.40 / RB 0.50 / WR 0.60 / TE 0.80) is right and well-sourced. But it
withdraws the *ordering* outright and gives as its reason that it "gives TE a
figure that appears nowhere in the file" — **0.20 is TE's second weight and is
TE's history share; the reason is false and the blanket withdrawal is too wide.**
Narrow it to: withdrawn *as a structural-head reading*; correct *as the
history-head complement*.

**This is the third instance today of the registered rule — a statement asserting
a behaviour is a claim to be verified — and this time the unverified statement
was a withdrawal of mine.** A correction is a claim. Corrections get checked
against the applying line like anything else, and a withdrawal wide enough to
delete a true reading is its own defect.

## R21. The production read — GOES TO NICK, with ONE BLOCKING CHANGE to the
## command and five changes to the pre-registered readings.

### R21.1 What is right, and it is most of it
Every figure reproduces. n-weighted position points rebuild each pooled point
exactly: std−shipped −0.027506 → −0.0275, control−shipped −0.059081 → −0.0591,
candidate−control +0.000686 → +0.0007. Every power ratio reproduces off its own
interval (pooled 0.0591/0.0209 = 2.83, WR 2.02, TE 1.95, RB 1.15, QB 0.50).

Four things are the standard I want other units held to:
- **"QB reverses" withdrawn on its own interval** ([−0.1033,+0.1657], half-width
  3.6× the point). That was my R20.2 condition and it was met by measuring, not
  arguing.
- **The trap withdrawn with it.** Pooled std−shipped spans zero, so
  "season_to_date beats shipped" is not a measured fact on this rig at this n.
  Retiring the question that motivated the unit is the hardest thing to do
  honestly and they did it unprompted.
- **The four empty-table row counts printed FIRST.** That turns Condition B from
  a rule someone must remember into a guard the output enforces: a rig copy
  cannot be mistaken for the read.
- **The control run reproduces POOLING-PREREG to four decimals before the
  instrument is trusted on an unknown.** Same calibration standard that got the
  rig adopted. Keep demanding it.

### R21.2 BLOCKING — the `cp` is wrong and would under-report silently
`cp /data/data.sqlite /tmp/read.sqlite` copies an sqlite database **that the app
may be writing**, and copies **only the main file**. If the DB is in WAL mode,
`-wal` and `-shm` are left behind, so the copy is missing every committed
transaction still in the WAL, and a concurrent write can tear it. **The failure
mode is a LOW ROW COUNT, not an error** — precisely the shape this read exists to
rule on, and it would be indistinguishable from the real answer.

**Required: do not copy. Open the production database READ-ONLY and read it in
place** (`node:sqlite` `DatabaseSync(path, { readOnly: true })`). That is a
stronger no-write guarantee than a copy, it is WAL-consistent, and it does not
put a second copy of the database on the machine's disk. If a copy is wanted
anyway, it must be a WAL-aware snapshot (`VACUUM INTO` or `.backup`), never `cp`.

This is the same defect class as the rest of today's: a layer that goes partly
inert and the surface prints a number as if nothing happened.

### R21.3 The power check — admissible, but it is NOT the R14.2 check
Registered so the two are never conflated: **R14.2 is an ORACLE power check** (a
candidate fitted on the eval season's own answers, whose upward bias makes a
stand-down conservative). **This is a SPECIFIED-ALTERNATIVE power check** (effect
= the whole shipped-vs-control gap disappearing). Both are admissible; they
answer different questions; **a submission must say which it ran.**

Three changes:
1. **STATE THE THRESHOLD AS A NUMBER.** YES/NO is currently not derivable by a
   reader. For a 90% interval, half-width ≈ 1.645 SE, so 80% power needs
   effect/half-width ≥ **1.78**. Their split lands where that predicts (pooled
   2.83 → ~100%, WR 2.02 → 95%, TE 1.95 → 94%, RB 1.15 → 60%, QB 0.50 → 20%),
   so the classification is right; register the 1.78 so it is reproducible
   rather than inferred.
2. **THE HALF-WIDTHS ARE RIG MAGNITUDES, used as a design input.** Condition A
   bars rig magnitudes from claims; this is a sizing estimate, not a claim, so it
   is allowed — but it must be labelled, because it assumes production's SE
   resembles the rig's, and production's n and residual structure are the very
   things being read.
3. **RE-CLASSIFY ON THE PRODUCTION INTERVALS AFTER THE READ**, by the rule
   registered now. Pre-registration fixes the decision rule, not the answer, so
   applying the fixed rule to the realized SE is still pre-registered — and it
   removes the dependence on a rig magnitude entirely.
   **GUARD, or this becomes the observed-power fallacy: the EFFECT stays the
   pre-registered rig figure (0.0591 / 0.0540 / 0.0891 / 0.0530 / 0.0346). Only
   the SE is updated.** Substituting the observed production gap for the
   hypothesised one makes the calculation a restatement of its own p-value.

"QB and RB nulls are reported as unresolved, never 'no difference'" is correct
and is Condition B generalised past the four empty tables. Keep it.

### R21.4 Multiplicity bites two exclusions that are being leaned on
Twelve unregistered 90% comparisons; ~1.2 nominal exclusions expected under a
global null. Stating that and claiming nothing was right. Two consequences that
have to be written down, because the numbers are already in circulation:
- **TE std−shipped [−0.1680, −0.0009] is NOT carried as an exclusion.** An upper
  bound 0.0009 from zero among twelve comparisons is exactly the one expected by
  chance. It is not evidence that season_to_date beats shipped on TE.
- **The candidate−control opposing-sign result does not survive multiplicity
  either.** RB [−0.0492,−0.0019] is marginal; WR [+0.0050,+0.0375] is ~2.2 SE,
  nominal but not after twelve.
  **The withdrawal of the addendum sentence is UPHELD, and its reason is
  corrected.** The sentence ("the pooled null is not concealing a position where
  the candidate wins decisively") asserted an **absence that was never tested**;
  that is why it goes, and it would go even if RB and WR had spanned zero. It
  does not go because opposing effects were measured — they were not, at this
  multiplicity. Same error class as my own R20.4, and the same fix: withdraw on
  the untested claim, not on a reason reached for afterwards.

Distinguish clearly, because multiplicity does NOT dissolve everything here:
**control−shipped survives.** RB, TE and WR all exclude zero, same sign, similar
magnitude, and QB spans zero at the same sign and magnitude. A coherent
sign-and-scale pattern across four positions is not the one-in-twelve. Explorer's
own qualification ("sign-and-scale, qualified, not four confirmations") is the
right strength.

### R21.5 Per-position before pooled, on EVERY arm, as the default
The pooled-null-conceals-position-structure shape has now come up **twice in one
package** — suspected on std−shipped, and the reason the candidate−control
addendum had to go. Promote it from a caution to the default: **on this rig,
report per-position first and the n-weighted pooled beneath as a derived figure,
on every arm, not only where a reversal is suspected.** A pooled figure taken
across a possible sign change is mix-dependent, and the rig's position mix
(486/1,112/929/1,816) is not production's roster mix.

### R21.6 Ruling
**The read GOES TO NICK as morning-list item 17, after R21.2.** It is one
paste-able command, only he can run it, it writes nothing, touches no network and
prints no ids, names, env values or key material — that last is the standing
secrets rule met, and it should stay written into the script rather than trusted
to the operator.

R21.3 items 1-2 and R21.4-R21.5 are record changes and do not hold the read.
**R21.2 does** — a `cp` of a live sqlite file can hand Nick a wrong answer that
looks exactly like a right one, and he only runs this once.

## R22. 109/178/228 — yes, with the QUESTION named and 109 tagged unchecked;
## 190 is not a ceiling; and I WITHDRAW the R19.4 edit order.

### R22.1 The R19.1 check did its job, and note WHICH way it moved
172 → 178 (12 non-scheduler edges added back; 9 of 21 are `scheduler.js`'s
`startScheduler`, imported by `server/index.js` at boot — job reach wearing a
request-shaped proxy, correctly excluded). **The sequence 205→196→172→178 finally
broke its monotone drift, and it broke UPWARD, which is the direction the check
predicted.** That is weak evidence the drift was method bias rather than
convergence, and it is the reason the check was worth running. **178 is still not
a floor.**

### R22.2 190 IS NOT A CEILING — the criterion has an under-count channel
"Request reach lies between 172 and 190, 178 the best placement" is the right
KIND of statement — a range induced by a definitional ambiguity the import graph
cannot resolve, labelled as such, not an uncertainty interval. Same rider as
172/228.

**But 190 is not demonstrated as the upper end.** The criterion is *"a
function-body import sitting in an EXPORTED function of a route-reached module"*.
A function-body import inside a **non-exported** function of a route-reached
module is excluded by that wording, and it can be genuine request reach — the
enclosing module is request-reachable, and a private function is called from
inside it. **Count those too before 190 is written as the top.** The known error
runs both ways: exported-but-never-called inflates (the 9 scheduler edges are
exactly that), non-exported deflates.

**And the instrument may already exist.** Script 1's (b) was settled with
`scripts/symbol-reach.mjs`, a symbol-level reach tool. If it resolves symbols,
point it at the 21-of-240 question instead of declaring the import graph
insufficient. **I could not reach that file from main (654ff93) or the mount, so
I take its existence on their report** — if it does not do symbol-level call
reach, say which tool "cannot tell them apart" refers to, because "an exported
function a route-reached module imports is not a function a route handler calls"
is a call-graph statement and needs a call-graph tool to close.

### R22.3 The ladder — CARRY 109 FIRST, with two conditions
Three definitions, and the split is right: 109 = reachable when a person uses the
app; 178 = any non-betting entry point including the command line; 228 = plus job
reach. 34.2% / 55.8% / 71.5% of 319. **A package.json script is not the fantasy
product** and labelling script-only reach "reached from the fantasy product via
scripts/…" was a real defect in their own tool, found by checking their own
labels. That is the behaviour I want.

**Condition 1 — NAME THE QUESTION BEFORE THE NUMBER.** Which figure leads
depends on what the plan is sizing. "How much of this must work for a user" →
109. "How much must be maintained, tested and migrated" → 228, because a job
that breaks at 3am still breaks. The plan is scoping fantasy Phase A work, so
**109 leads**, with 178 and 228 beside it, each carrying its definition. The
number without its question is what produced the 55% read in the first place.

**Condition 2 — 109 IS SINGLE-PASS AND UNREVIEWED, and must say so.** It is
newer and smaller than 178, which will make it read as more refined; it is
neither. It comes from the **same tool whose labelling was found wrong today**,
and nothing independent has checked the corrected labels. **Hand-check ten of the
109 and ten of the 69 and report how many labels survive.** Cheap, and it is the
only thing standing between a fresh figure and the drift the last four revisions
showed.

**The 69 are not a discard pile.** Script-only reach is the ops surface — a human
runs `scripts/refresh-live-data.mjs`. Out of "reachable when a person uses the
app", in scope for maintenance. §2a's queue is the right home; do not let "not
the fantasy product" become "not ours".

### R22.4 I WITHDRAW THE R19.4 EDIT ORDER. The decline is right.
I wrote "fix the comment now regardless of side". **That was wrong and I am
withdrawing it.** `nfl-candidate-findings.js` is betting-side (three betting
routes and `/api/mlb`, no fantasy route), allocated to no thread, and Nick's own
precedent covers this exact shape — `nfl-ai-replay.js`, "betting-side: findings
recorded, NOT edited (fantasy-only scope)".

**My authority is kill and redirect on evidence quality. It is not to move the
build scope Nick set.** "It is only a comment" does not change whose file it is:
it still lands as a diff in a scoped-out file, in a PR he reviews, under a rule
he wrote. Opportunity's disposition — replacement text written and ready to
paste, item 21 on his list, carrying the trigger — is strictly better than the
order I gave.

**What survives unchanged is the FINDING RULE:** a comment asserting a behaviour
is a claim to be verified, and where it is unmet the comment is a defect in its
own right. That is a rule about what counts as a defect, not about who may edit
what. The defect stands, at full strength, on the list, with its trigger. **The
scope rule delays the fix; it does not downgrade the finding.**

Second time today I converted a correct finding into an instruction that outran
its warrant (R20.4 was the first). Registering it as a pattern to watch in
myself: **the finding and the remedy are separate rulings, and the remedy is the
one that has to respect an allocation.**

### R22.5 Script 1 (b) — no objection
Import-time seed tables (`model-governance.js:68` → 32 rows
`model_feature_contracts`; `:90` → 11 rows `model_registry`; bare top-level calls
`:88-89`, `ON CONFLICT DO NOTHING`), readers resolved at symbol level, no fantasy
reader, `nfl-betting.js:665` a name collision. Grade unchanged, and resolving a
name collision by symbol rather than by grep is the right standard.

## R23. VACUUM INTO SATISFIES R21.2 — my remedy was unreachable and I withdraw
## it. Two operator conditions. db/index.js registered as a finding. R22.2
## corrected on Wiring map's census.

### R23.1 My R21.2 remedy was wrong. Theirs is right.
Verified on main 654ff93, `server/db/index.js`, all at import time: `:20`
`new DatabaseSync(DB_PATH)` with no options (read-write); `:22-27`
`PRAGMA journal_mode = WAL` (a write); `:45-50`
`CREATE TABLE IF NOT EXISTS schema_migrations`; `:184-187` the legacy migration
if its marker is absent, via `backupBeforeMigration`; `:194-198`
`CREATE TABLE IF NOT EXISTS db_health_checks` and a persisted health-check row.
**So any script importing `weekly-backtest.js` opens production read-write and
writes to it before the caller gets a say. `{ readOnly: true }` is unreachable
for the replay**, and changing the repo to take a read is the wrong order of
operations. Withdrawn.

**VACUUM INTO from a read-only connection SATISFIES R21.2.** I named it
acceptable and it is the right instrument: read-only with respect to the source,
transactionally consistent, WAL-inclusive, and the import-time writes land on the
snapshot. Their precision is the standard — "writes nothing to the source" is
true of the main file, and the separate statement that a read-only open of a WAL
database attaches to (and on an idle database can create) the `-shm` and a
zero-length `-wal` is the honest qualification, not a hedge.

And their observation is right and worth keeping: **the unsafe `cp` was the thing
accidentally protecting production from those writes.** VACUUM INTO gets the
consistency AND the isolation.

### R23.2 TWO OPERATOR CONDITIONS before item 17 posts
**(a) THE WAL CAN GROW DURING THE SNAPSHOT, AND THIS REPO HAS BEEN BITTEN.**
`db/index.js:28-42` records `server/data.sqlite-wal` reaching **~3.3 GB over 2.5
days (2026-09-13)** because 60-90s report replays overlapping the write cadence
made a clean checkpoint moment rare. `journal_size_limit = 67108864` caps the
file **after** a checkpoint, not its growth during an active read transaction. A
VACUUM INTO of a database the file itself describes as past 2 GB (`:189-190`)
holds a read transaction far longer than 90s, so checkpointing is held back for
the whole window and the `-wal` grows by whatever the app writes meanwhile.
**The free-space check runs BEFORE; this consumer grows DURING, on the same
volume.** A single up-front check does not cover it.
**The mitigation already holds: `SCHEDULER_DISABLED=1` is on, so write volume in
the window is at the floor.** That is what makes this safe to run now — and means
**it must not be re-run casually once the brake lifts without re-checking. Tie it
to the brake decision**, same as the `stale_findings` trigger.

**(b) THE ITEM TEXT NICK READS MUST CARRY THE OPERATOR FACTS**, because he runs
it on the live machine: the snapshot is **at least the size of the database**;
**which filesystem it lands on** and how much free space is required; that the
script **aborts rather than proceeds** when short; and the exact `rm`. Destination
is not a detail — a >2 GB snapshot into a small root filesystem can take the app
down, and into `/data` it eats the volume production writes to. Also say **the app
stays up**: a read-only connection in WAL mode does not block writers. He should
not have to guess at that.

### R23.3 The four row counts are clean — recorded so nobody re-derives it
The bootstrap writes touch `schema_migrations`, `db_health_checks` and PRAGMA
state only. **None touches `nfl_snaps`, `nfl_injuries`, `nfl_qbr_weekly` or
`nfl_depth`**, so the Condition B guard counts are unaffected by running against
the snapshot. On a production snapshot the legacy marker is present, so `:185`'s
`backupBeforeMigration` does not fire — and if it ever did it writes beside the
**snapshot**, not production, so the standing never-delete rule on
`/data/data.sqlite.pre-migration-<stamp>.bak` is not implicated.

### R23.4 `db/index.js:20-194` — REGISTER AS A FINDING, graded precisely, and I
### am NOT ordering a remedy
**It is not a defect and I will not call it one.** Every step is deliberate and
documented: `mkdirSync` because a fresh Fly volume is an empty directory and
`DatabaseSync` throws synchronously at import; the WAL and `journal_size_limit`
carrying an empirical war story; migrations centralised so no service file can
create schema again, with `scripts/schema-snapshot.mjs` as the standing proof;
the health check persisted so a >2 GB integrity scan does not run per process.

**The finding is narrower and it is real: THERE IS NO READ-ONLY PATH TO THE
PRODUCTION DATABASE.** Importing the data layer — including from a diagnostic
whose only purpose is to read — opens read-write and writes first. `:9`'s
`GRIDIRON_DB_PATH` is the anticipated hatch and it **REDIRECTS, it does not
DOWNGRADE**: the design foresaw offline diagnostics against a *separate*
database, not read-only access to the real one. That gap cost this unit a round
and will cost the next one.

Class: the same family as today's others — **a layer acts without the caller's
say**. Severity: **design gap with an operational cost**, not an active
falsehood, and **it does not gate item 17**, which works around it correctly.

**Remedy SHAPE, not an order:** an exported factory or opt-in flag that opens
read-only and skips the bootstrap. `server/db/index.js` is a shared core file
with an owner, and per R22.4 the allocation is not mine to set. **Route the
remedy decision; the finding is mine and it stands.**

### R23.5 R22.2 CORRECTED — and the correction makes my point BIGGER
I framed the under-count as "non-exported functions". **Wiring map's census shows
that dichotomy does not partition the code.** Of 274 non-test function-body
dynamic imports on 1161c16: **110 in route or mount handler callbacks, 121 in
module-private named functions, 22 in exported named functions, 21 other.** The
largest group is handler callbacks, which are **neither** — and they are the ones
**most likely to be genuine request reach, because they ARE route handlers**. So
"an exported function of a route-reached module" is a far narrower criterion than
I credited, and the under-count channel is bigger than I said.

**DO NOT COMBINE THE POPULATIONS.** Wiring map's 274 of 411 dynamic (2,250
static, 2,661 total) is **not** Opportunity's 240 of 1,927. **The shape
transfers; the counts do not.** Opportunity re-runs the classification on its own
population before any number moves. I made exactly this cross-population error
today and withdrew it; it is not being repeated here.

**Attribution corrected: the 172-190 criterion and `scripts/symbol-reach.mjs` are
Opportunity's, not Wiring map's.** My R22.2 asks route to Opportunity; Wiring map
owes nothing on them, and its map never filters on exportedness (route and job
reach follow every edge, only script reach is restricted to load edges), so the
channel does not exist in its map at all.

Two things of theirs worth keeping. **Importing a module does not execute
function bodies, confirmed BY EXECUTION** — `model-governance.js:88-89` seeds 43
rows at import, `audit:nfl` wrote them, `diagnose:nfl-passing` wrote nothing.
32 + 11 = 43 reconciles with R22.5's figures from a **different thread and a
different method**; two independent routes to one number is the standard. And
they caught their **own** first pass mis-attributing 38 `betting-hub.js` handler
imports by walking to the nearest column-zero declaration, fixed it with bracket
matching, and reported it unprompted.

## R24. 183 carries AFTER one reconciliation; the fresh twenty is NOT the right
## check; and "floor" is the wrong word for either end.

### R24.1 Everything sums, and one thing does not
Reconciled: four-way 114+85+23+14+4 = 240; sites 240+1,687 = 1,927 and
1,644+43 = 1,687; columns 183+80+6+17+10+23 = 319; split 123+60 = 183 (was
109+69 = 178). The ladder is internally coherent — 172→176 adds 4 to wired while
taking 23 out of unreached, the other 19 landing in the betting/mlb/offproduct
columns, which is what an edge-addition should look like.

**THE ONE THING THAT DOES NOT RECONCILE, and it points at the floor being
inflated.** The four-way says **85 module-private-named, 77 of them
`scheduler.js` job bodies.** The ceiling step attributes **86 edges to
scheduler's job bodies.** Both can hold only if **9 scheduler edges are
classified outside module-private-named.** The floor steps excluded scheduler
explicitly from exported-named and other — but **not** from the 114
handler-callbacks, which were added whole.

**Name which bucket those 9 sit in, and confirm none was inside the 114.** If any
were, **183 carries scheduler job reach — the exact error the 172→178 revision
existed to remove** (the 9 `startScheduler` edges: job reach wearing a
request-shaped proxy). A callback registered with a scheduler is handler-shaped
and job-reached. This is a count, not an investigation, and it must land before
the paragraph moves, because it can move 183.

### R24.2 "FLOOR" IS THE WRONG WORD, and this changes how Planner writes it
**Import reach is an UPPER bound on call reach** — their own statement, and it is
right. Carry it to its conclusion: **every figure in the ladder is an import-reach
figure, so none of them is a floor on what a request actually calls.**
- **228 is the only genuine bound**: all non-test edges, so true request call
  reach ≤ 228.
- **172 and 183 are EDGE-CLASS DEFINITIONS, not floors.** 172 omits an edge class
  that contains real reach (so it under-counts), and every edge it does count is
  still only an import (so it over-counts). A figure that errs in both directions
  bounds nothing.

So the rider stands and strengthens: **two definitions, not an interval — and
drop the word "floor" from both ends.** "Corrected floor 183" overstates what was
measured. The honest sentence is: 183 is reach through every non-job entry point
by import; 228 is the same plus job reach and is an upper bound; the true figure
is not bracketed by them. Closing it needs a call graph nobody has, which they
state plainly and which I accept.

### R24.3 The fresh twenty is NOT required, and it is not the right check
**What the 20/20 validated was the LABELLER, and that transfers.** The hand-check
was asked for (R22, condition 2) because `surfaceLabel` had been found returning
"fantasy" for script-only reach. That is a property of the labelling code given
reach — **graph-independent**. What changed between 109/69 and 123/60 is the
reach graph, not the labeller. Opportunity's caveat is honest and its conclusion
("will not quote 20/20 as validating the corrected split") is right, but the
remedy it implies is wrong.

**What was NOT sampled is the DELTA, and the delta is the whole new risk.** Reach
is monotone in edges, so 109 ⊆ 123 and the difference is exactly **14 files: 9
promoted from script-only, 5 newly wired** (69 − 9 = 60 ✓, 109 + 9 + 5 = 123 ✓).
**Check those 14, not a fresh random twenty.** The 9 matter most: a file that was
"reachable only from the command line" is now claimed "reachable when a person
uses the app", which is a materially different claim about the product, and it
rests entirely on the newly added handler-callback edges — the youngest and least
checked part of the graph. Fourteen targeted checks beat twenty random ones and
cost less.

### R24.4 Rulings
1. **Planner's paragraph moves ONCE, after R24.1.** Since the scheduler
   reconciliation can move 183, moving now risks the second move the paragraph
   was promised it would not need. Resolve the count first — it is minutes — then
   write **183 leading, 123 and 60 beneath it, 228 beside**, each with its
   definition and neither called a floor.
2. **The fresh twenty is not required. The 14-file delta check is, and it
   replaces it.** The mechanism carries the rest: containing-range attribution
   from the TypeScript parser, with the nearest-declaration mis-attribution
   killed and pinned as a test (`docs/tdd/symbol-reach.tdd.md`).

### R24.5 Two corrections, one of them to the correction
**Mine, accepted:** I told them to aim `symbol-reach.mjs` at "which exported
functions a route handler calls". It resolves import reach at symbol granularity
and **builds no call graph**, so it cannot answer that. The pointer was wrong;
their reading of their own tool is right.

**Theirs, not accepted as stated:** "'21 of 240' crossed populations; 21 is
Wiring map's exported-named count on 274." It is not. Three different numbers
under three different definitions are in play:
- **21** — Opportunity's own R19.1 count, on its own 240, under the criterion *an
  exported function of a route-reached module*;
- **23** — exported-named on the 240, a broader criterion (no route-reach
  requirement);
- **22** — Wiring map's exported-named on its 274.

21 and 240 are both Opportunity's, so **my phrase did not cross populations**;
what it did was carry a criterion-specific count under a looser label, which is
worth fixing for a different reason. The proposed correction mixes 21 with Wiring
map's population, which is the error it is trying to prevent. Say which of the
three is meant wherever the number appears.

Credit where it is due: using a **surviving mutant** to find a real method error,
then pinning the fix as a test, is the shape CLAUDE.md asks for, and my R22
sharpening landing exactly where the error was is what the hand-check was for.

## R25. PRODUCTION READ — ADD TO PLAN as a measured result, with one gate before
## it moves any weights, and one discriminating check the agreement demands.

### R25.1 VERDICT: ADD TO PLAN
The read answers what it pre-registered, its classification survived, and QB/RB
came back **unresolved rather than null**. Accepted as a measured result. **It
does NOT by itself authorise a weight change** — see R25.5.

### R25.2 The pre-registered re-classification, run on the production SEs
Per R21.3(3): effect held at the pre-registered RIG figure, only the SE updated,
threshold 1.78.

| arm | effect | prod half-width | ratio | power | verdict |
|---|---|---|---|---|---|
| pooled | 0.0591 | 0.02165 | 2.73 | ~100% | YES |
| WR | 0.0540 | 0.02770 | 1.95 | 94% | YES |
| TE | 0.0891 | 0.04755 | 1.87 | 92% | YES |
| RB | 0.0530 | 0.04540 | 1.17 | 61% | NO |
| QB | 0.0346 | 0.06895 | 0.50 | 21% | NO |

**Identical to the pre-registered classification.** That is the cleanest outcome
a pre-registration can have: the rule was fixed in advance, applied to data it
had not seen, and did not move. The observed-power guard held — no production
effect was substituted for a hypothesised one.

### R25.3 Production reproduces the rig arm for arm — AND THAT IS A QUESTION
Every production point sits inside its rig interval: pooled −0.0632 vs −0.0591
(Δ 0.0041), WR −0.0542 vs −0.0540 (0.0002), TE −0.0866 vs −0.0891 (0.0025), RB
−0.0708 vs −0.0530 (0.0178), QB −0.0340 vs −0.0346 (0.0006). Half-widths barely
move (0.02165 vs 0.02085 pooled); n 4,419 vs 4,343 is +1.75% and bought nothing.

**THE AGREEMENT IS NOT AUTOMATICALLY REASSURING.** The rig is **blind** to
`nfl_snaps`, `nfl_injuries` and `nfl_qbr_weekly` (Condition B). Production holds
**128,146 / 28,411 / 574** rows in them. A blind instrument and a sighted one
returning the same answer to three decimals means one of two things:
1. the comparison genuinely does not depend on those tables, or
2. **the production path does not read them either.**

(2) is this project's known shape — live code, dead path, as with `news_items`
where `trades.js:466` wants `importance = 3` and all 914 rows are 2.
**ONE DISCRIMINATING CHECK, and it is cheap: do the shipped and control arms read
those three tables at all?** If yes, the agreement is a real result and Condition
B is lifted for this comparison. If no, **this read did not lift Condition B for
anything touching them** — that belongs in the qualifier, and the dead-path
question becomes a finding of its own.

### R25.4 `nfl_depth = 0` is a PRODUCTION FINDING, and `nfl_qbr_weekly = 574` is thin
**`nfl_depth` is empty in production today.** That is more than a qualifier on
this unit. Register it and answer one question: **does anything read it?** If yes,
a layer has gone inert with the surface silent — CLAUDE.md's named pattern, and
the third instance today. If nothing reads it, it is dead schema, a different and
smaller thing. Name which; both are on Nick's list, at different weights.

**574 rows in `nfl_qbr_weekly` is THIN, which can be worse than empty**, because a
partial table covers some rows and not others silently while an empty one fails
uniformly. QB is also the arm that came back unresolved. Not a claim — a cheap
check: **which seasons and weeks do the 574 rows cover?** If coverage is partial
across the compared rows, QB features are inconsistent within the comparison
itself.

### R25.5 THE GATE — control wins on BOTH, and that is exactly when the
### decomposition decides what the finding is
Control beats shipped on the metric (−0.0632, CI excludes zero) **and** carries
the better level: mean signed error **−0.4898 vs −0.5136**, 0.0238 less negative.
Per [[gridiron-mae-flat-changes-move-bias]] the usual pattern is the opposite — an
MAE win bought by pushing the level low — so a both-ways win is the interesting
case, and **0.0238 of level against a 0.0632 gap is the right order of magnitude
to be a material share of it.** Until level and information are separated we do
not know whether control carries signal or is merely better centred.

**I am NOT redirecting for this.** I registered "level beside MAE on all arms"
for this read and they delivered exactly that. The full level/information
decomposition was registered for the Plan 01 grade, not for this read.
**Pre-registration binds the auditor too; adding a requirement after seeing the
numbers is the thing the format exists to prevent.** So the decomposition is the
NEXT unit, not a defect in this one.

**But it gates the use: the result goes in the plan; no weight change rides on it
until level and information are separated.**

### R25.6 The level itself, measured in production for the first time
All three arms sit 0.46-0.51 points low, consistent with `weekly-ensemble.js:69-77`
(−0.26 to −0.58 across 2021-2025) and at the worse end of it. **Over nine
starters the shipped arm inherits −4.62 points.** Lineup totals, playoff points
and trade deltas all sum these. This is the first *production* measurement of a
bias the repo has only ever recorded from backtests, and it belongs on Nick's
list **separately from the weights question** — it is true of the shipped arm
whatever happens to control.

## R26. Sample B's 10/10 → 2/10 is not a labeller failure. It is the definition
## boundary, and it changes what the 60 MEANS.

### R26.1 The labeller still stands; R24(2) is unchanged
Sample B surviving 10/10 at the request-reach definition and 2/10 once scheduler
job edges are folded in is **exactly what a correct labeller does at a definition
boundary**. A file reached only by a scheduled job and a script IS script-only at
183 and IS job-reached at 228. Nothing mislabelled. So **R24(2) stands: the
labeller is validated, the fresh twenty is not required, the 14-file delta is the
check.**

### R26.2 But "SCRIPT-ONLY" IS NOW A MISLEADING NAME FOR THE 60
Eight of ten sampled script-only files are scheduler-reached. "Script-only" reads
as *a developer runs it by hand*; if that ratio holds, most of that bucket is
**the scheduled pipeline's own machinery** — production code, not tooling. Parking
it in a §2a queue on the strength of the word "script" would under-weight it
badly, and my own R22.3 line ("the 69 are the ops surface, a human runs
`scripts/refresh-live-data.mjs`") is too generous as a description of it.

**DO NOT SAMPLE THIS — COUNT IT.** The 60 is small enough to enumerate: **how
many of the 60 are reached by a scheduler job edge?** A count, not an estimate,
and it lands with the R24(1) scheduler reconciliation since both are the same
theme: scheduler edges crossing definitional boundaries unannounced. If it is
near 80%, the plan renames the bucket — *reached by a script or a scheduled job,
never by a request* — before it carries it.

Note also **sample B was drawn from the 69, and 60 ⊂ 69** (69 − 9 promoted = 60),
so up to two of the ten sampled may sit among the promoted 9 and not in the 60 at
all. Another reason the answer is a count.

**And a live consequence worth one line to Nick:** with `SCHEDULER_DISABLED=1`
on, that machinery does not execute. If ~80% of the 60 is scheduler-reached, most
of that bucket is **inert in production today and becomes live the moment the
brake lifts.** That belongs beside the brake decision, not in a file-count
paragraph.

### R26.3 The 14-file delta check gains one required column
**9 of the 14 were promoted OUT of script-only** — precisely the population we now
know is heavily scheduler-reached. So a scheduler-edge leak, if there is one,
would surface here first. For each of the 9, the check must say: **is the
promoting edge a genuine request edge, or a job edge wearing a request shape?**
That is the same question as R24(1)'s 9 unaccounted scheduler edges, asked at the
file level instead of the edge level, and the two answers must agree.

## R27. R24(1) ANSWERED and it clears 183. R24(2)'s remedy unchanged. But NINE
## OF THE TEN PROMOTED FILES ARE BETTING-NAMED, and that is now the live question.

### R27.1 R24(1) — resolved, negative, and the arithmetic closes
77 module-private + 9 object-literal = **86**, exactly the gap. The 9 are arrow
functions in `scheduler.js`'s job table (`:1312-1373`), so they land in **other**,
and the floor step excluded scheduler from *other*. And the decisive part:
**zero of `scheduler.js`'s function-body imports are handler-callbacks** — all 114
sit in route files and the list sums to 114 (59+39+5+3+3+2+2+1). **183 does not
carry scheduler job reach through the bucket I was worried about.** Concern
discharged on a count, which is what I asked for.

One thing to carry: **77 all-specifier / 74 relative-only, 86 / 83.** Two counting
conventions are live. State which one the 319-file columns use, every time.

### R27.2 R24(2)'s remedy is UNCHANGED; my input was wrong, not my method
The delta is still 14 files, so **check the 14** stands. The composition moved
10+4 instead of 9+5, which shifts one file into the *higher-risk* half, so the
emphasis goes up, not down. My "9 + 5" came from `69 − 60` and `109 + 9 + 5`; the
old script-only side was **70**, not 69, so 70 − 60 = 10. **The derivation was
right and the input was not**, because 178 was handed to me as 109/69.

**Accept: every old-side figure is SUPERSEDED, not one end of a comparison.**
179 (= 109 + 70) is what the columns rebuild; 178 was a hand-correction that never
reconciled with them and survived several rounds of reporting anyway.
**RULE REGISTERED: every figure in the ladder must be reproducible from the tool's
own output. A hand-corrected number is not carried.** Same class as the
`surfaceLabel` defect — a number nobody could rebuild from the instrument.
Superseding the old figures does **not** supersede the checks they motivated: the
delta check exists because the graph changed, and that is still true.

### R27.3 THE THING THAT MATTERS MOST IN THIS ROUND
The ten promoted files: `book-feeds`, `line-shopping`, `nfl-capture-dispatch`,
`nfl-execution-edge`, `nfl-execution-validation`, `nfl-quote-clock`,
`nfl-quote-tape`, `nfl-shopping-board`, `nfl-weekly-feature-store`, `odds-api`.

**Nine of the ten are betting-named, and they have just been promoted into
"reaches a real fantasy route" — the 123.** Only `nfl-weekly-feature-store` is
fantasy-shaped, and that one is independently plausible (it is already the feature
audit's unit).

**And 98 of the 114 newly added handler-callback edges are in `nfl-betting.js`
(59) and `betting-hub.js` (39) — BETTING route files.** Adding betting-route edges
should grow the **wired-betting-only** column (the 80), not the fantasy half of
the 183. A file reached only from `nfl-betting.js` is betting-only by the
definition in use.

So one of two things is true, and they are very different:
1. **A real fantasy route pulls betting infrastructure.** That is a genuine and
   important finding in its own right — fantasy surfaces depending on the betting
   stack — and it belongs in the plan as such, not buried in a file count.
2. **The promotion is a labelling artefact** of the newly added betting-route
   edges, which would be the **second** surface-labelling defect in this tool in
   one day.

**R26(4)'s required column is widened, and this replaces it: for EACH of the ten,
name the FANTASY ROUTE it now reaches and the edge path to it.** Request-versus-job
is no longer the discriminating question — R27.1 settled that. **Request-from-WHICH-
SURFACE is.** If the path runs through `nfl-betting.js` or `betting-hub.js`, the
file is betting-only and the label is wrong.

**Nothing in the ladder moves until that list exists.** A figure whose movers look
wrong is not carried on the grounds that the columns sum.

### R27.4 R26's other count still stands
The scheduler-reached share of the 60 is unaffected by any of this and is still
owed. Two items gate the Planner paragraph now: **that count, and the ten-file
fantasy-route paths.**

## R28. A range is acceptable. THIS range is not, because its two ends are
## measured to different standards. And 112 does not reconcile.

### R28.1 112 does not follow from what was stated
"Only 2 of the 10 promoted can be confirmed reached by a web request" gives
123 − 8 = **115**, not 112. The stated reason does not produce the stated bottom.
It reconciles if **1 of the 4 newly wired is also unconfirmed** (109 + 2 + 1 =
112, so 11 unconfirmed = 8 promoted + 3 new) — but that is my reconstruction, not
their statement. **Say what the 11 are.** A figure nobody can rebuild from the
stated reason is the same defect R27.2 registered one round ago.

### R28.2 A RANGE IS FINE. A RANGE BUILT FROM TWO STANDARDS IS NOT.
I have already ruled the ladder is definitions rather than intervals, so a stated
range with both ends labelled is honest and I have no objection in principle.

**The objection is that the standard was applied to 14 files and not to 109.**
"Can the tool confirm a web request reaches this file" was asked of the delta and
not of the inherited base — **and the 109 were built by the same tool, which by
their own statement cannot confirm web-request reach for anyone.** So the 109
fails the new standard too, untested. Holding new files to a stricter bar than
the incumbent base is precisely the asymmetry that manufactures drift.

**Required, and it is cheap: apply ONE standard to ALL 123.** Then either
- the tool can confirm for some and not others → report **confirmed /
  unconfirmed as a partition of all 123**. That is a legitimate and genuinely
  useful second column, and a range with both ends on one standard; or
- it cannot confirm for anyone → **123 is a single import-reach figure and 112 is
  not the bottom of anything.** Do not report it.

### R28.3 This is not a fifth revision. It is a different question.
179 → 183 → 123 → 112 are **not four estimates of one number.** They answer: which
files are reachable by a non-job entry point; which reach a fantasy route by
import; which can be *confirmed* reached by a web request. **A figure that moves
because the STANDARD changed is not a revision, it is a different figure**, and
calling it the fifth move of one number hides that.

And the substance underneath is not new: **R24(3) already established that import
reach is an upper bound on call reach and that nothing in the ladder is a floor.**
"Only 2 of 10 confirmable" is that same instrument limit, now measured at file
granularity. Measuring it was right. Letting it produce a mixed-standard range is
not.

### R28.4 DO NOT WAIT FOR THE DIFFERENT ANALYSIS, AND DO R27.3 FIRST
Waiting means the plan carries **no** fantasy-scope figure, and the analysis named
is a call graph nobody has (R24.2). That is not a wait, it is an indefinite hold.

**Order of work: R27.3's ten fantasy-route paths FIRST.** It is cheaper than a
call graph, it is already asked, and **it very likely dissolves the range**: nine
of the ten promoted are betting-named, only two are confirmable, and if the
unconfirmable eight are the betting ones then they do not belong in the fantasy
count at all and the question was never about confirmability. **The two questions
are converging on one answer — get that answer before commissioning anything
new.**

R27.3 stands unchanged and still freezes the ladder. It asks which **surface**,
not whether reach is confirmable; an unconfirmable file still has a claimed path,
and the path is what names the surface.

## R29. (B) Condition B check ACCEPTED — best-formed submission of the day, with
## an expiry and two additions. (A) Bucket split ACCEPTED, better than what I
## asked for. And nfl_depth is now a CONFIRMED inert layer.

### R29.1 (B) ACCEPTED. The method change is the reason.
Answering by **execution** — patching `db.prepare` and recording the statements a
real `replaySeasonWeekly(2024)` over 4,343 rows actually prepares — instead of
reasoning over a 205-file import closure is a **category improvement**, not a
better argument. It produced something no amount of graph reasoning would have:
**a fifth rig blindness, `players.espn_id` entirely NULL**, which silently
short-circuits `nfl-qbr.js:129` (`if (espnId == null) return null`, verified).
And their own rule — **"a trace proves a statement did not run, not that it
cannot"** — is exactly right and is theirs, not mine.

The verdict is correctly scoped: Condition B lifted **for this comparison only**,
on the footing that the window's QBR table is empty, **not** that the code never
looks; not lifted for anything through `player-week-engine.js`.

**ADDITION 1 — THE LIFT HAS AN EXPIRY, AND IT MUST BE RECORDED AS ONE.** "The
window's QBR table is empty" is a fact about **production data today**, not about
code. **If `nfl_qbr_weekly` is ever backfilled for 2021-2024, the code fires and
this comparison changes — silently**, because neither the rig nor the read would
notice. Register the trigger beside the brake triggers: *this lift holds only
while `nfl_qbr_weekly` has no rows in the evaluation window.*

**ADDITION 2 — 572 vs 574. Two rows are unaccounted** (540 for 2025 + 32 for 2026
wk1 = 572; production reports 574). Small, but the entire argument is "empty in
the window", and two in-window rows would be two counterexamples to it. **Name the
two.** That also finishes my R25.4 coverage question.

**AND A CORRECTION TO MY OWN R25.3 DICHOTOMY.** I posed it as either/or: the
comparison does not depend on those tables, *or* production does not read them
either. **The answer is a third thing, and the taxonomy needs all three:**
1. **not reachable on the path** — `nfl_snaps`, `nfl_injuries`, `nfl_depth` here;
2. **reachable, data absent** — `nfl_qbr_weekly` here;
3. **reachable, data present, predicate dead** — the `news_items` `importance = 3`
   case.
These have different fixes and different expiries. My two-way split would have
collapsed 2 and 3.

**AND ONE FINDING THEY DID NOT DRAW: `nfl_snaps` holds 128,146 rows in production
and the weekly projection path never touches it.** A well-populated table with no
reader on the surface that most needs it. Not a defect — possibly by design — but
it is exactly the kind of thing that answers "what could improve projections",
and it belongs on the opportunity list rather than in a trace appendix.

### R29.2 `nfl_depth` — QUESTION ANSWERED, FINDING CONFIRMED, severity precise
My R25.4 asked whether anything reads it. **It does:**
`player-week-engine.js:516-518`, `activeDepthRoster`, on the fantasy projection
path — Phase A scope. With the table at **0 rows in production**, that reader
returns nothing on every call.

**But this is NOT the disaster shape, and I will not call it one.** The code
handles it: `:526-539` falls back to a strictly pre-kickoff roster built from the
last four team games in `nfl_player_week_features`, with a stated reason ("safer
than the app's current roster table, which otherwise lets modern players leak
backward"), and `teamProjectionSet:552-554` adds a join guard — *"A populated
chart is authoritative only if identities actually join. A broken provider join
must remain visible rather than erasing the offense."*

**The defect is that the degradation is GRACEFUL but SILENT.** Nothing records
which roster source ran, so a projection built from the fallback is
indistinguishable from one built from a real depth chart. That is CLAUDE.md's
named pattern in its milder form — and **this repo has already solved exactly this
problem once, in the same subsystem**: `weeklyEnsembleMode()` exists precisely so
an audit record "can say so instead of inferring 'ensemble ran' from
`context != null`". **The fix is that pattern applied here: report the roster
source.** Cheap, in-repo precedent, fantasy-side, and it does not change a single
number.

**AND ONE MORE COMMENT WHOSE PREMISE PRODUCTION CONTRADICTS.** `nfl-qbr.js` states
*"confirmed by join: 5285/5294 rows match `players.espn_id`"* — but production
holds **574** rows in `nfl_qbr_weekly`, about a ninth of that. **Name which
database the 5,294 was measured on.** If it was production, the table has lost
rows or never received the backfill; if it was a dev database, the comment reads
as a production claim and is the fourth comment-premise defect today. Either way
it strengthens the R25.4 "thin table" flag considerably.

### R29.3 (A) R26(1) — SPLIT ACCEPTED, and it beats the rename I asked for
**46 of 60 = 76.7%** scheduler-reached. I wrote "if it is near 80%, rename", and
76.7% **is** near 80% — I am not hiding behind a threshold I stated loosely.
**But their proposal is better than mine: split the bucket rather than rename it.**
46 files that are scheduled-pipeline machinery and 14 that are
evidence/diagnostic/reasoning modules are two genuinely different things, and one
name over both would be wrong whichever name won.

Carry them as two lines: **46 = reached by a scheduled job, never by a request**
(inert today under `SCHEDULER_DISABLED=1`, live the moment the brake lifts — the
R26(3) trigger applies to these 46 specifically, not to the whole 60); **14 =
developer-facing evidence, diagnostic and reasoning modules**. One note on the
14: several are betting-side by name (`nfl-blind-audit`, `pick-reasoning`,
`nfl-passing-diagnostic`), so that line will want a product split of its own
before it reaches a plan. Not a blocker.

### R29.4 (A) R26(2) — my R27.3 is PARTLY ANSWERED, and it answers branch (a)
Two of the ten confirm on static plus handler-callback edges alone:
`nfl-capture-dispatch` and `odds-api`, **both via `routes/news.js`**. So for those
two the R27.3 answer is **branch (a), not a labelling artefact** — a real product
route pulling betting infrastructure, the news surface depending on the odds API.
**That is a finding in its own right and belongs in the plan as one**, not as two
rows in a file count. Confirm `routes/news.js` is one of the eight nav tabs and
say so beside it.

The other eight stay open on R27.3. Their refusal to call those eight job edges is
**correct** and their own counterexample proves it: `manager-archetypes` via
`routes/trades.js:558` → `managerSignalsPayload:456` → `import:501` is genuine
request reach through exactly the unclassifiable class. **Unclassifiable is not
absent.**

### R29.5 The bracket — form accepted, R28.2 NOT yet met, and expect the bottom
### to fall
"Both definitions, no single number" is consistent with R24(3) and I accept the
form. **But R28.2 still is not satisfied: the strict standard has been applied to
the 10 and not to the 109**, and the 109 were built by the same tool that cannot
confirm web-request reach for anyone. **Recompute the confirmed/unconfirmed
partition over all 123** — the same computation, just over 123 rows instead of 10.

**Say now, so nobody reads it as drift: the correctly computed bottom will almost
certainly land BELOW 112**, because the 109 inherited files have never been
tested against this standard. **That is not a sixth revision. It is the first time
the bottom is computed on one standard** — R28.3's rule, applied in advance
instead of after the fact.

## R30. NEITHER (a) NOR (b). Seven of the nine come out on CALL REACH, verified on
## main, and no per-branch model is needed. Plus a live finding underneath.

### R30.1 Verified on main 654ff93, not argued
`routes/news.js:40` — `const { enqueueRecentNewsTriggers } = await import('../services/nfl-capture-dispatch.js')`, inside the POST handler, result returned as `capture_triggers`.
`nfl-capture-dispatch.js:7` — `import { hasKey, usage } from './odds-api.js'`, **static**, module scope.
`nfl-capture-dispatch.js:84` — `const { snapshotLines } = await import('./line-shopping.js')`, **inside `dispatchTriggeredCapture()`**.
`enqueueRecentNewsTriggers` (`:35-55`) — reads two tables, INSERTs into
`nfl_capture_triggers` with `state='pending'`, returns `{reviewed, queued}`. **It
never calls `dispatchTriggeredCapture`.**
Callers of `dispatchTriggeredCapture`: `polymarket-lines.js:271` and
`nfl-espn-line-watch.js:129` — **both scheduler jobs, both in the nine
object-literal job-table entries from R27.1.**

### R30.2 THE RULING: split the nine 2/7 on call reach
- **Loaded by a news request: 2.** `nfl-capture-dispatch` (imported) and
  `odds-api` (its static module-scope import). These genuinely execute on a
  fantasy request.
- **NOT loaded unless `dispatchTriggeredCapture()` runs: 7.** `line-shopping`
  and everything beneath it — `book-feeds`, `nfl-quote-tape`,
  `nfl-shopping-board`, `nfl-execution-edge`, `nfl-execution-validation`,
  `nfl-quote-clock`. Its only callers are scheduler jobs. **These are JOB REACH.
  They belong at 228, not in the 183's fantasy half.**

**This is import reach masquerading as call reach — R24(3)'s distinction, and this
time it is a real leak, found at file granularity.** And the two analyses agree
independently: the 2 that survive here are exactly the 2 Opportunity confirmed on
static plus handler-callback edges alone. **Two methods, one answer.**

**So the §2c per-file → per-branch rewrite is NOT needed and should not be made.**
Seven of the nine leave on a mechanical call-reach fact. For the remaining two,
(a) is right — they really are pulled in by a fantasy route — carried with the
note that both rest on `news.js:40`.

Result: promoted **10 → 3** (`nfl-capture-dispatch`, `odds-api`,
`nfl-weekly-feature-store`), fantasy split **123 → 116**, script-only **60 → 67**,
**183 unchanged** (the seven keep their prior script reach). Opportunity confirms
the arithmetic; I am giving the shape, not the recount.

**If a SECOND cross-surface call site is ever found, revisit per-branch then** —
with two instances there is evidence the general model is needed. One instance,
resolved mechanically, is not a reason to rewrite the contract.

### R30.3 THE FINDING UNDERNEATH, which is worth more than the count
`enqueueRecentNewsTriggers` **enqueues; it does not capture.** The drain is
`dispatchTriggeredCapture`, whose only callers are scheduler jobs. **With
`SCHEDULER_DISABLED=1` on, nothing drains the queue.** So a fantasy news POST
fills `nfl_capture_triggers` with `state='pending'` rows that nothing will ever
process, **and returns `capture_triggers: { reviewed, queued }` to the caller** —
a positive count that reads as work started.

The design is deliberate and the file says so at `:1-4`: *"Triggers are durable: a
closed laptop or exhausted quota defers work instead of silently losing the
news/movement event."* That is the right design. **But deferral with no drain is
indefinite**, and the surface reports a queued count either way. CLAUDE.md's named
pattern again, in its reporting form.

**Good news on the one thing I was going to raise and am not:** the news route
spends **no** metered odds credits. The external call lives behind
`snapshotLines`, past the drain. **No paid burn from a fantasy request.** Checked
before raising it.

Trigger for the list: **the moment the brake lifts, the accumulated backlog
drains at once.** Same brake trigger as `stale_findings`, the snapshot re-run and
the 46 job-reached files — that is now **four** items hanging off one decision.

## R31. Kicker/efficiency K — EVIDENCE ACCEPTED, REMEDY REDIRECTED. The constant
## is doing three jobs and the evidence gives them different answers.

### R31.1 Format met, and one thing in it is the best signal in the package
(a) (b) (c) (d) all present; consumer count self-corrected two → three; the
earlier `EFFICIENCY-K-SPEC.md` 115 withdrawn. **And the procedure REFUTES its own
prior proposal** — train-chosen 134 for ypc loses to 34 on held-out 2024 (0.75853
vs 0.73889). A method that kills its author's earlier claim is the strongest
available evidence that it is not fishing. The pre-registered two-part rule
(held-out argmin > 34 AND held-out wMSE at the **train-chosen** k below k=34's)
is correctly specified and correctly applied: **condition 2 exists precisely to
stop the held-out argmin being read as an achievable target**, and ypc is the case
that proves it — its held-out argmin is 57 (> 34) yet nothing chosen on train
beats 34. They got that subtlety right.

### R31.2 THE REDIRECT: one constant, three consumers, three different answers
`projections.js:97` `yards_per: 34` is read at `:562` (ypt), `:570` (ypc) and
`:575` (ypa). The evidence says: **raise it for ypt; do NOT raise it for ypc
(refuted by their own procedure); nothing at all for ypa.** Those three
requirements **cannot be satisfied by one shared value.**

So the finding is not "set 34 to 64". It is: **this constant is doing three jobs
and they need different values.** The ypc arm failing is what proves it — same
constant, opposite conclusions, measured. **Unit: split the constant per
consumer, then grade.** Changing the shared value on ypt's evidence would move
ypc against its own measured evidence and ypa with none.

### R31.3 What must be added before any value is adopted
1. **A PLAYER-CLUSTERED PAIRED INTERVAL. It is absent.** The split is per-player,
   so the clustering unit is **140 players**, not 17,013 targets. A 5.2% wMSE gap
   with no interval is an unqualified point estimate, and every other unit today
   has been held to this.
2. **THE DIRECTION IS WELL-SUPPORTED; THE VALUE IS NOT IDENTIFIABLE.** 34 → 64
   moves wMSE 0.15637, while the whole span 64 → 115 moves **0.01841** — 8.5×
   smaller. **34 sits on the steep part and the optimum region is flat.** Report an
   identified range, never a point; "64" carries false precision, exactly as the
   earlier "150" did.
3. **THE LEVEL COST IS REAL AND THEY REPORTED IT: ypt mean signed error −0.029 at
   k=34 → −0.116 at k=70, a 4× increase in bias for a 5.2% loss gain.** Shrinking
   harder pulls every player toward the pooled mean, so this is
   [[gridiron-mae-flat-changes-move-bias]] again. It matters because consumers
   **sum**: for ranking it is free, for summed totals it is not. Their own stated
   weakness — *no projection-level improvement shown* — is what decides it, and it
   must be closed before adoption, not after.
4. **k AND mu ARE JOINTLY FITTED.** The prior is the 2023 **pooled** mean, not
   positional (no position column in `targets.jsonl`, stated). Yards per target
   differs sharply by position, so a positional prior would move the optimal k —
   **tuning k against a pooled mu bakes in a coupling that a later prior change
   silently invalidates.** Record it with the number.

### R31.4 A HYGIENE RULE THIS UNIT EXPOSES, and it is bigger than this unit
The withdrawn `EFFICIENCY-K-SPEC.md` figure was in-sample **and had read 2025**.
It is withdrawn — but **withdrawing a result does not un-read the data.** 2025 is
therefore **no longer a pristine held-out season for k selection on these
quantities**, and a later "confirmed on 2025" would be weaker than it reads.
**RULE REGISTERED: a season read by ANY analysis of a quantity — including a
retracted one — is no longer clean for that quantity. Track which seasons each
question has burned.**

## R32. My prediction was wrong. Three methods converge on the same seven. And
## `server/data.sqlite` is not a mystery — it is the default local dev database.

### R32.1 MY R29.5 PREDICTION FAILED, and the failure is instructive
I said the correctly computed bottom would "almost certainly land BELOW 112". It
landed at **114** on the 123 tree. **Wrong, and reported plainly against me,
which is the behaviour I have been asking for all day.**

**Why I was wrong, because the error class matters:** I reasoned that the 109
inherited files had never been tested against the strict standard, and treated
*untested* as *likely to fail*. **That is the same error I have been correcting in
others — assigning a value to an unmeasured quantity.** The right move was
theirs: measure it instead of arguing about it. Registered against myself.

### R32.2 THREE INDEPENDENT METHODS NOW AGREE ON THE SAME SEVEN FILES
The 9 unconfirmed are `book-feeds`, `line-shopping`, `manager-archetypes`,
`nfl-execution-edge`, `nfl-execution-validation`, `nfl-quote-clock`,
`nfl-quote-tape`, `nfl-shopping-board`, `nfl-weekly-feature-store`.

**Seven of those nine are exactly the seven I ruled job-reach in R30**
(`book-feeds`, `line-shopping`, `nfl-execution-edge`, `nfl-execution-validation`,
`nfl-quote-clock`, `nfl-quote-tape`, `nfl-shopping-board`). Arrived at by three
independent routes: my call-reach trace on main, the R28 one-standard partition,
and the R30 surface analysis. **"Unconfirmed" and "job reach" turned out to be
the same set** — which is evidence both instruments are measuring the thing they
claim to measure. That is the calibration standard the rig was held to, met here
by accident and worth keeping on purpose.

### R32.3 THE PARTITION IS CONSERVATIVE BY TWO, NOT ONE
They flagged `manager-archetypes` as conservative (read end to end:
`trades.js:508` → `managerSignalsPayload:342` → `import:402`, merged-tree lines).
**`nfl-weekly-feature-store` is the second, and by the same chain**: it is a
**static** import at `manager-archetypes.js:56`. If `manager-archetypes` is
request-reached, everything it statically imports is request-reached with it.
The partition cannot classify the `:402` edge, so both fall out; **both are in
fact request reach.**

So: **confirmed 116, unconfirmed 7**, and 116 is exactly the figure R30 derived
independently. **Four numbers from three methods, one answer. Carry 116.**

Every figure carries its commit, as they now do — **the 123 tree is b0c1616d and
the merged tree is 9b9d2111, and 5 files leave when main moves.** That is a real
and easily-missed property: **the inventory is tree-dependent, so a figure
without a commit is not a figure.** Register it beside the reproducible-from-the-
tool rule.

### R32.4 `server/data.sqlite` IS THE DEFAULT LOCAL DEV DATABASE — correcting the
### framing, because it changes the conclusion
"Measured on neither production nor the rig, names a database that exists nowhere
reachable" is right in effect and wrong in kind. **`db/index.js:10`:
`process.env.GRIDIRON_DB_PATH || path.join(__dirname, '..', 'data.sqlite')`, and
`__dirname` is `server/db`, so the default path IS `server/data.sqlite`. It is
gitignored (`.gitignore:11-13`).** It is not an unknown artifact — it is the
app's own default local database, real and in use: `db/index.js:38` records
`server/data.sqlite-wal` reaching ~3.3 GB over 2.5 days.

**So the numbers came from a developer's working database, and the defect is
REPRODUCIBILITY, not mystery.** Which changes the conclusion for the better:
- `nfl-qbr.js:24-39` cites a live two-row Geno Smith case (`player_id` 15864,
  `team='LV'` fetched 2026-09-10 beside `team='NYJ'` fetched 2026-09-14) that
  nobody else can reproduce — but it is an ordinary local-DB observation, and the
  fix it justifies (`deleteStaleTeam`) is sound on its own reasoning.
- **The substantive finding is the gap: the local dev database holds ~5,294
  QBR-crosswalk rows where production holds 574 total, about 9×.** That is not a
  fictional number — **it points at a production backfill that never ran.** Put it
  on the list as that, which is far more actionable than "unreproducible".

**And the standing rule still bites, fifth instance today:** a comment asserting a
measured fact must name the database it was measured on, and `server/data.sqlite`
is not a citation anyone else can follow. **Cite production or the rig, or say
"local dev database, not reproducible" in the comment itself.**

### R32.5 (B) otherwise — no objection
The expiry as an executable query trigger (`SELECT COUNT(*) FROM nfl_qbr_weekly
WHERE season BETWEEN 2021 AND 2024` = 0 on production, plus rig
`COUNT(espn_id) FROM players` = 0) is better than the prose trigger I asked for:
**a trigger that can be run is a trigger that will be.** The 574-vs-572 two rows
cannot be named from a bare `COUNT(*)` — correct, honestly stated, and the next
read now prints qbr-by-season and the crosswalk, which settles it. Rig control
unchanged after the patch (POOLED −0.0591 [−0.0795, −0.0378]), which is the
required re-validation and it was run unprompted. `nfl_snaps` reach as the next
unit, gate-1 first: right pick, and it is the R29.1 finding turned into work.

## R33. Fix the tool NOW. Paragraph writes on the post-fix numbers, once.

### R33.1 Recount confirmed
Route **116**, script **67**, wired **183**; the 7 moved and the 3 kept are the
ones R30 named; tally 183+80+6+17+10+23 = 319. Script-only splits **53 / 14**
(46 + the 7 = 53, same 14 developer-facing as before). Tool-produced on b0c1616d,
tree 500bab36, commit carried — that is now being done correctly.

**They named their own error including its DIRECTION: "presented an import chain
as a call chain, in the direction that made its number bigger."** A
self-diagnosis that names which way its own bias ran is the strongest form of the
admission, and it is rarer than the admission itself.

### R33.2 PROCEED WITH THE FIX NOW. Holding it is the wrong instinct.
Holding a tool fix "so as not to change the tool under an active ruling" is
considerate and wrong here. **My ruling is on the NUMBERS, which are already
produced and confirmed by three independent methods. A tool known to be defective
is fixed immediately** — leaving it broken risks a third party using it, and the
figures are fixed at their commit regardless of what the tool does next.

TDD as proposed, RED first with an `import * as` fixture. Two conditions:
1. **Re-run after the fix and report whether any figure moves.** If one does, that
   is **new information, not a revision** — R28.3.
2. **The defect is a LOWER-BOUND defect, so this is a derivation and not a
   guess:** `importersOfSymbol` missing namespace importers can only *omit*
   edges, so fixing it can only *add* them, so **every reach figure is
   non-decreasing** — 183 and 116 can rise or stay, never fall. (I am stating
   this as a derivation because my last prediction, R32.1, was a guess dressed as
   one, and it failed.)
3. Re-run the model-governance cross-check against Wiring map afterwards. Its
   agreement with an **independent method** is what makes "probably unaffected"
   reasonable — not the absence of namespace imports, which nobody checked.

### R33.3 The paragraph: write it on the post-fix numbers
The fix is small and its direction is known, so **run it, re-run, then write —
once.** That converts "moves once" from a promise into a fact for the cost of
minutes. **If the fix runs long, write on 116 / 53 / 14 with the commit
(b0c1616d, tree 500bab36) and the fix named as a pending item that can only move
the figures up.** Do not hold the plan open indefinitely for it.

### R33.4 A RULE, because this is the SECOND tool defect today
`surfaceLabel` returning "fantasy" for script-only reach, and now
`importersOfSymbol` missing `import * as`. **Both were found by checking the
tool's OUTPUT against a different mechanism — not by reading the tool.** I found
the `dispatchTriggeredCapture` callers with a plain text search, which is the only
reason the namespace-import gap surfaced at all.

**RULE REGISTERED: a figure from a bespoke tool is not carried until one
independent cross-check by a DIFFERENT mechanism has been run against it.** Grep
counts as a different mechanism. Two runs of the same tool do not.

## R34. §R31 SUPERSEDED. The k finding does not survive its own intervals, and
## the prior it was fitted against is not the one production uses.

### R34.1 My "self-refutation" credit was wrong. Accepted and withdrawn.
ypc 34 − 134 = −0.01964 **[−0.11402, +0.06830], spans zero.** So the procedure
**declined to confirm** its earlier yards-per-carry proposal; it did not refute
it. I credited it as a refutation, which **overstated the evidence in the
direction that flattered the submission** — and reading a null as a negative
finding is the exact error I have been policing all day. Withdrawn.

**What survives, and it is the good half:** the pre-registered condition 2 still
**correctly stops 134 being adopted** — nothing chosen on train beat 34. *The
DECISION stands; the CLAIM does not.* A rule that blocks your own earlier
proposal on a null is still doing its job, which is most of why I credited it.

### R34.2 THE FINDING DOES NOT SURVIVE. 34 IS INSIDE ITS OWN IDENTIFIED SET.
Identified set — every k whose clustered interval against the held-out argmin
contains zero: **ypt [31, 232], ypc [13, 294], and 34 is inside both.** No
identified value for either metric.

That is decisive. **We cannot reject that 34 is already optimal.** The ypt
interval against k=64 (+0.15636 [+0.01753, +0.29121]) excludes zero, but its
lower bound is **11% of the point estimate** — "real at 90%, not robust" is their
own phrase and it is the right one. Against the most favourable possible
reference, the held-out argmin 81, the interval **includes zero**
(+0.16735 [−0.01773, +0.34657]).

**ONE CLARIFICATION REQUIRED, because as stated the two intervals are in
tension.** The comparisons are paired on the same resamples and
wMSE(81) < wMSE(64) < wMSE(34), so 34 − 81 is pointwise LARGER than 34 − 64
(+0.16735 > +0.15636) — yet its interval is **33% wider** (0.3643 vs 0.27368) and
crosses zero. **That is only coherent if the argmin is RE-SELECTED INSIDE EACH
RESAMPLE**, which makes it a random quantity and correctly inflates the variance.
If 81 is instead held fixed across resamples, the two intervals contradict each
other and one is wrong. **Say which was done.** If it is per-resample
re-selection — which "selection-contaminated reference" suggests — then the
construction is right, conservative, and the identified set is a genuine
confidence set for the optimal k.

### R34.3 THE PRIOR IS THE WRONG PRIOR, AND THAT ALONE ENDS IT
My R31.3(4) said k and mu are jointly fitted. **It is now measured, and the
sensitivity is larger than I expected:** perturbing the pooled prior 7.3515 by
±1.00 — a **13.6%** move — swings the train-chosen k across **35, 49, 57, 64, 69,
68, 51**, non-monotone, a 2× range. At mu − 1.00 the chosen k is 35 with a
held-out advantage of **0.0011, i.e. nothing.** **A 13.6% change in the prior
makes the entire finding vanish.**

**And `projections.js:562` shrinks toward `prior.ypt` PER POSITION. Production
does not use a pooled prior at all.** So the fit was performed against a prior the
serving path does not use, in an estimator where the optimal k is acutely
sensitive to exactly that prior.

**VERDICT REVISED: DO NOT ADD. No change to `K.yards_per` is supported.**

### R34.4 My R31.2 redirect is HALF-RETRACTED
I wrote that the constant "is doing three jobs and they need different values."
**The second half is withdrawn** — it rested on ypt-yes / ypc-no, which is now
null / null. **The first half stands**: one k at `projections.js:97` is read at
`:562`, `:570`, `:575` for three quantities on different scales, and `:562`
shrinks toward a per-position prior. **That is a live structural question with no
evidence either way**, which is a different and smaller thing than what I said.

### R34.5 WHAT THIS UNIT ACTUALLY PRODUCED — three things, all worth keeping
1. **The identified-set method.** A confidence set for a tuning constant, built
   against a re-selected argmin. Use it on every constant proposal from here.
   It is what turned a 5.2% headline into "no identified value", and nothing else
   would have.
2. **The k-mu sensitivity table.** `k` is **not separately identifiable from mu**
   in `stats-util.js:17`, with numbers. That is a reusable fact about the
   estimator, not about kickers.
3. **A THIRD fit-population / serving-population mismatch today** — pooled prior
   fitted, per-position prior served. The others: Plan 01 (final `nfl_injuries`
   designations fitted, as-of `nfl_feature_revisions` served) and the early-week
   weights question. **Three instances is a pattern, not a coincidence: analyses
   are being fitted against a simplified version of what production does.**

**PROMOTED TO A STANDING GATE-1 ITEM, on the strength of those three:**
**before any fitting, state what production actually does with the quantity, read
off the applying line, and fit against that.** It goes beside the power check and
the level/information decomposition in the kickoff criteria.

### R34.6 On the correction itself
They corrected their own submission **in the two places I had credited it**.
Undoing praise is the hardest direction to self-correct in — there is no pressure
to do it and nobody would have checked. Noted, and it is why the identified-set
method can be trusted on the next constant.

## R35. Target-share prior — EVIDENCE ACCEPTED. Do NOT ship alone. It and Plan 01
## are the same finding from two sides.

### R35.1 The gate, criterion by criterion
(i) MET — fit and serve read the same rows on the same condition, zero-target
weeks in. One open branch: **no NULL-share rows on the rig, so that path is
untested. Does production have NULL-share rows?** Cheap, and if yes the branch
runs untested in live code.
(ii) MET, and in the best possible way: QB 0 is **measured** (0.0004 over 2,615
weeks) **and** structural (`projections.js:578` forces QB targets to 0), and the
two agree. I asked which; they answered both and showed the agreement.
(iii) MET, and the answer is disconfirming: **the headline does not survive
`decision_including_dnp`** — −0.0136 [−0.0499, +0.0225] against the pre-registered
primary +0.1044 [+0.0661, +0.1460]. **Put in the second line of the result and in
the doc title.** Burying it would have been easy and invisible.
(iv) MET, and it is the reason this unit is not a null — see R35.2.
(v) **MISSED. No power check declared in advance, recorded as a miss and NOT
back-filled.** Refusing to back-fill is right (a back-filled power check is the
observed-power fallacy). Not on my auto-redirect list, so it is a recorded miss,
not a redirect — **but it is declared in advance on the coupled grade.** Their
post-hoc statement is correctly constructed: smallest callable ±0.0432 / ±0.0392
against realized SE, compared to the **pre-specified** conditional effect 0.1044,
not to the observed DNP effect. That is the R21.3(3) guard, applied properly, and
it makes the DNP null **informative**: the design could have seen a
conditional-sized effect and did not.
(vi) MET — `shrinkSafe(tgtShareObs, 0.06, n, K.share=6)`, reachable as
`sharePrior: 'legacy'`.

### R35.2 THE DECOMPOSITION EARNED ITS KEEP, and this is why I required it
Raw DNP: −0.0136, spans zero. **De-biased DNP: +0.0482 [+0.0249, +0.0713],
excludes zero.** So the fitted prior carries **real information** that the raw
decision metric hides, because it also carries a **worse level** for that
population (legacy ME −0.9764 targets on weeks played, fitted −0.3165; on the DNP
metric fitted flips to **+0.2486**).

**Without the level/information split this unit would have been recorded as a
null and the information thrown away.** That is the strongest vindication the
requirement will get, and it cost them work to produce.

### R35.3 THE RULING: the legacy bias is an ACCIDENTAL AVAILABILITY HEDGE
Their interpretation is right and I will sharpen it. A systematically low
projection reduces error on weeks a player does not play, because the outcome is
zero. **Legacy's −0.9764 under-projection is buying unavailability insurance with
a target-share constant.** Raising pass-catchers to their measured share removes
the hedge, and the DNP metric charges for it.

**So the hedge is real, unprincipled, and load-bearing.** It couples two unrelated
quantities: how many targets a player gets, and whether he plays. Ship the fitted
prior alone and you remove a hedge nothing replaces — projections go
systematically high for players who miss games.

**AND THE REPLACEMENT ALREADY EXISTS AND IS ALREADY GATED: Plan 01's availability
multiplier is exactly the missing availability term.** These are **one finding
from two sides**. Neither ships alone:
- fitted prior alone → hedge removed, nothing replaces it;
- availability multiplier alone, over the biased prior → the hedge is
  double-counted.

**VERDICT: ACCEPT the evidence, DO NOT SHIP AS DEFAULT, stays unmerged, and the
COUPLED grade becomes the unit.** That grade is now the highest-value item in the
queue, because it can convert a measured null into a measured win — the
information is already demonstrated (+0.0482, excludes zero), it is only being
absorbed by a level term that has a principled replacement.

Carry the R19.6 redirect into it: **Plan 01 must be refitted on as-of status from
`nfl_feature_revisions` first.** Grading a look-ahead-contaminated multiplier
against this prior would confound both.

### R35.4 The −0.0499 against a −0.05 tolerance
**It passes. Pre-registration binds both ways, and a tolerance fixed in advance is
met when it is met.** But it passes by **0.0001**, and **naming that rather than
rounding it is the single most disciplined thing in the submission.** Binding:
that figure never appears as "within tolerance" without the number beside it. And
Nick sees it if this ever ships — the worst case consistent with the data sits
exactly on the limit that was set as the largest acceptable regression.

### R35.5 Independent confirmation worth recording
`players.espn_id` NULL for all 1,483 rig rows — **the fifth blindness, found
independently by a second thread**, and they checked it against their own
comparison rather than only noting it: QBR nudge off in both arms, QB projections
differ by exactly 0, so it cannot move this result. That is the right way to
handle a known blindness: show it cannot reach your arms.

## R36. Fantasy plan's pre-registration — ACKNOWLEDGED with TWO required changes.
## Run after them; do not wait for another round.

### R36.1 What is right, and some of it is better than what I asked for
Locked before measurement, binding itself to my condition. **One run per season**
by reading `candidate_heads.active_champion` off the same `_predictions`
(`weekly-backtest.js:157`, computed unconditionally) is genuinely clever: it
yields a **fully paired** comparison from a single replay and **makes the n
identical by construction**, so there is no n to reconcile — the failure mode I
had to withdraw a finding over this morning. 2023-bias-applied-to-2024 avoids
test leakage in the centring step. Explorer's caveats carried **verbatim**,
including the fifth blindness. It reuses the repo's own `_centred` idiom
(`offseason-model.js:1624-1643`) rather than inventing one. And §5.3
pre-registers **what a null would mean** — "a CI that excludes zero on raw but
includes zero on de-biased would itself be the finding" — which is the part
almost everyone leaves out.

### R36.2 CHANGE 1 — CENTRE ON THE MEDIAN, NOT THE MEAN
The loss is MAE. **Minimising Σ|aᵢ − (pᵢ + c)| over c gives the MEDIAN of the
residuals, not the mean** — [[gridiron-mae-optima-are-medians]], recurring defect
#6. Subtracting each arm's **mean** signed error does not move it to its
MAE-optimal level; it moves it somewhere neither arm wanted, and weekly fantasy
scores are right-skewed so the mean-median gap is material.

It does **not** cancel in the delta: the two arms have different residual
distributions, so their mean-median gaps differ and the mis-centring is
asymmetric. `debiased_delta` would then not be "the gap with level removed."

**Required: centre on the median of the 2023 residuals.** And since it is one
extra line, **also report the multiplicative form I registered in R7** —
`headroom(X) = MAE(X) − MAE(X × m0(X))` with `m0` the prediction-weighted median
of actual/pred — because for right-skewed non-negative scores the natural level
parameter is a scale, not an intercept. Reporting both additive-median and
multiplicative-median makes the decomposition robust to that choice instead of
resting on it.

### R36.3 CHANGE 2 — 2024 IS INSIDE CONTROL'S FIT. THE TEST SPLIT IS CONTAMINATED,
### ASYMMETRICALLY, IN CONTROL'S FAVOUR.
The document states control's own provenance and does not follow it through:
**control is fit-1's vector, "fit on pooled 2023-2025" — so 2024 IS IN CONTROL'S
TRAINING DATA.** Shipped's fallback is "fit on 2023 only, architecture selected
on 2024" (`weekly-ensemble.js`, provenance block).

So on a 2024 test split, **control is evaluated in-sample while shipped is
evaluated on a season used only for architecture selection.** The contamination
is **asymmetric and it favours the arm that wins.** Some unknown share of the
0.0632 is in-sample advantage — and this applies to the production read too,
which was a 2024 comparison.

**Required: add 2021 and 2022, which are outside BOTH arms' fitting data and are
already loaded on the rig** (2020-2024 REG, 29,428 player-weeks, ~6s/season).
Keep 2024 as the figure being decomposed, since it is what production measured —
but **the clean comparison is 2021/2022, and if control's win does not reproduce
there, the decomposition is explaining an artefact.**

### R36.4 Minor
Line citations (`:75-80`, `:172-177`, `:4-17`) are branch-tree lines; on main
654ff93 `WEEKLY_ENSEMBLE_WEIGHTS` is `:59-63` and `weeklyEnsembleWeightsFor` is
`:156-161`. §6(b) already commits to citing main `1a136145` in the report — **do
the same in the pre-registration, or say which tree its own citations are on.**
Same rule as figures carrying their commit.

**Run after 36.2 and 36.3. Do not hold for another acknowledgement.**

## R37. The 4-vs-23 question is the most important one raised today. REGISTER IT,
## but narrow it to ONE comparison. And it forces a retro-correction to R25.3.

### R37.1 `nfl_snaps` registered answer — ACCEPTED, with a taxonomy refinement
CLASS 1 on both paths. The catch that earns it is the census: `nfl-engine-registry.js:38`
runs `COUNT(*)` and `MAX(week)` over nine tables identically and **never reads
`offense_pct`**. **A statement that TOUCHES a table without reading its signal is
not reach**, and the taxonomy needs that as a named sub-case of class 1 or the
next trace will re-litigate it. Package #12's 0.44-target ceiling is what the
reach is worth; no objection.

Keep `nfl_snaps` and `player_week_snaps` strictly apart. `nfl_snaps` (128,146
production rows) is untouched on both paths — R29.1 stands. **`player_week_snaps`
is a different table and IS read on the live path** (`offense_pct` via
`role-changepoint.js:49`) and not in the replay. Its production count is unknown
and correctly on the next-read list.

### R37.2 REGISTER THE 4-vs-23 QUESTION. It is a unit, and it outranks the queue.
28 statements over 23 tables live, 3 over 4 tables in the replay. **If the replay
grades a different predictor than production serves, then every MAE figure this
project has ever produced describes the replay's predictor, not the shipped one**
— today's 0.0632, the 4.7233/4.4867 early-week figures, the ceiling bracket, all
of it.

**Raised against their own registered reading 1, marked exploratory and untested,
limits stated first.** That is how a finding that undercuts your own instrument
should arrive.

**This is the FOURTH fit/serve mismatch today** — Plan 01's injuries, the kicker's
pooled prior, the early-week weights, and now the measurement apparatus itself.
The pattern I promoted to a gate-1 item one ruling ago turns out to apply to the
rig, not just to units run on it.

### R37.3 NARROW IT TO ONE COMPARISON — a general trace is the wrong unit
Do **not** commission "trace everything". The weekly ensemble is
`structural` plus four heads computed off the player's own prior fantasy points
(`weekly-ensemble.js:170-195`), and the history heads are arithmetic over
`priorWeeks` — they cannot differ if the inputs match. **Structural carries 0.40
to 0.80 of the weight by position. So the whole question reduces to:**

> **Does the replay's `structural` input equal production's, for the same
> player-week?**

Everything else — news signals, game-line timing, `offense_pct` — matters only
through that. One comparison, decisive, and it makes the unit finishable.

**GATE 1, and it is cheap and OFFLINE: does `replaySeasonWeekly` obtain
`structural` by calling the same code production calls, or by a
reimplementation?** That is a code question answerable today, and it decides
everything:
- **same code path** → they can only differ if the DATA differs, and the question
  becomes a data question (below);
- **a reimplementation** → they can differ regardless of data, and **that is the
  finding**, answerable now, no production read needed.

Do gate 1 before anything else.

### R37.4 IT CANNOT BE FINISHED ON THE RIG, BY CONSTRUCTION
On the rig `player_week_snaps`, `nfl_news_signals`, `game_lines` and
`nfl_engine_artifacts` are **all 0 rows**. **The rig's blindness is exactly
co-extensive with the difference being asked about** — a sixth blindness, and the
most consequential, because it means the rig can never answer this question about
itself. They stated this as a limit before the finding, which is the right order.

So after gate 1, the data half needs production or the local dev database, as one
paste-able read. Fold it into the next production read rather than commissioning
a separate one.

### R37.5 DO NOT FREEZE GRADING. Downgrade the claim scope instead.
Freezing every rig grade until this resolves would stop the project for a
question that may turn out to be plumbing. Instead, **every rig result from now
until this is answered carries one line: it grades the replay predictor, whose
equivalence to production's is unestablished.** Cheap, honest, and it costs no
throughput.

**That line applies to the R36 decomposition too** — a third rider, not a new
block. Fantasy plan runs as ruled.

### R37.6 RETRO-CORRECTION TO R25.3, and I should have seen it
In R25.3 I found it striking that production reproduced the rig arm for arm — WR
differing by 0.0002 — and turned it into a question about which tables were read.
**The simpler explanation is that both ran the same replay code.** The agreement
was never evidence that the rig resembles production's model; it was evidence
that identical code gives identical answers on similar rows.

**And it follows that the "production read" did not measure production's
predictor.** It ran `replaySeasonWeekly` over production's DATA — the replay
predictor on production rows. **R25's verdict is narrower than I wrote it:** it
establishes that the control-vs-shipped ordering holds for the replay predictor
on production data, not that it holds for what production serves. Amend R25 to
say so; the ADD-TO-PLAN verdict survives with that scope, and the weight-change
gate was already in place.

### R37.7 Next unit — approved, but AFTER R37.3
The `ros-projection` / `season-sim` / `ceiling-lineup` trace is good work and
correctly proposed with gate-1 first. **But it is lower value than the
structural-head equivalence question and it is downstream of it** — if the
replay's structural differs from production's, every one of those three inherits
the same problem and the trace would have to be redone. **Do R37.3 gate 1 first;
it is hours of work at most and it may dissolve or sharpen everything after it.**

## R38. Coherence point SETTLED against me. No re-selected run — and the reason
## it is not needed makes their negative finding stronger.

### R38.1 I was wrong to say "only coherent if re-selected"
The reference is FIXED (`kband.mjs:89`, `best.k` computed once on the full
held-out sample, passed as a scalar, both arms at fixed 34 and fixed 81 in every
resample, identical resamples). **The table reproduces exactly at n = 140:**
t = 2.086 / 1.901 / 1.758 / 1.526 / 0.994 for k = 57 / 64 / 70 / 81 / 115, which
are their 2.09 / 1.90 / 1.76 / 1.53 / 0.99 to the last digit.

So the mean and the SD both grow as the reference moves away from 34, and the SD
grows faster — 64→81 is **+7.0% on the point and +33.3% on the SD** — so t falls
monotonically and the interval crosses zero at 81 while excluding it at 64.
**That is an ordinary property, not a contradiction.** My inference assumed the
variance would be roughly stable across nearby k. It is not, and the mechanism
they give is exactly why: the opportunity-weighted per-player difference grows in
size *and* in spread together, because moving k toward mu moves low-n players a
great deal and high-n players barely at all. **Objection withdrawn; the
construction is sound.**

### R38.2 NO RE-SELECTED RUN. The selection bias runs the useful way.
The reference was chosen as the argmin **on the held-out sample**, so its
performance is optimistically biased and the measured 34 − 81 gap is **inflated**.
An inflated gap is MORE likely to exclude zero, so it is more likely to push 34
**out** of the identified set. **34 is in the set anyway.**

**So the set is wide despite a selection bias that should have narrowed it**, and
a per-resample re-selected run could only widen it further. It cannot rescue the
finding, only bury it deeper. Not worth a run — and that is a statement about
direction, not about cost.

### R38.3 One thing in their table worth keeping
**t peaks at k = 57 (2.09), away from the argmin at 81 (1.53), while the point
estimate peaks at 81.** The most "significant" comparison and the best-performing
reference are different k's. That is a compact demonstration of why a reference
picked by point estimate is the wrong instrument, and it is an independent
argument for the identified-set construction over "compare to the best". Carry it
with the method when it is reused.

They accepted R34's verdict without reservation and recorded the finding as not
surviving. Nothing further owed on this unit.

## R39. Three supports in one estimator — FOLD INTO THE COUPLED GRADE. Yes to
## both questions, plus the sharpest statement of the defect, which is n-dependent.

### R39.1 The structural defect is real and does not depend on the zeros question
`shrink = (n·observed + k·prior)/(n+k)` (`stats-util.js:17`) combines three
quantities estimated on **three different populations**: the observation
(`projections.js:492`, via `history()` at `:294-300` selecting `u.*` with **no
snap filter**) includes zero-snap weeks; the positional prior (`:395`) gates on
`> 0`; the k fit (`shrinkage-fit.js:330`) gates on `> 0`.

**The estimator's algebra assumes `observed` and `prior` estimate the SAME
quantity on the SAME population, and that k calibrates how much to trust n
observations OF THAT QUANTITY.** None of those three holds here. This is the
R31.3(4) k-mu coupling finding again, now at the level of supports rather than
values — and it is its most compact instance yet: **three supports inside one
estimator, one file apart.**

### R39.2 THE SHARPEST STATEMENT, AND IT IS n-DEPENDENT
As n grows, `observed` dominates; as n shrinks, `prior` dominates. **`observed`
includes zeros and `prior` excludes them. So the estimator interpolates between
two DIFFERENT quantities, and the interpolation weight n/(n+k) doubles as an
unintended availability-weighting.**

**Two players with identical true share-when-playing get systematically different
estimates purely from how many weeks they have** — the high-n player converges to
the zero-inclusive value, the low-n player sits near the zero-exclusive prior.
That is a describable bug, not a modelling preference.

**It also means the contamination is NOT the uniform 0.0059 their mean reports.**
A mean over 113 players cannot see an n-dependent effect. **Cheap confirming
check: correlate the per-player understatement with that player's n. If it rises
with n, confirmed.** Add it before the grade; it changes what the fix is worth.

### R39.3 RULING: yes and yes
**(1) The three-support mismatch folds into the coupled-grade unit.** Model
evidence audit owns `projections.js` and already owns the target-share prior;
splitting this out would put two owners on one estimator.
**(2) The observation support IS decided there**, because **it is the same
decision as the coupled grade, seen through a third lens**:
- availability priced in a **separate multiplier** (Plan 01) → target share is
  *share when playing* → **exclude** zeros → all three supports agree at `> 0`;
- availability priced **into the share** → **include** zeros → `:395` and `:330`
  must change too, and **k must be refit**.

Both are coherent. **What is incoherent is the current mixed state.**

**Planner is right to decline to call the zeros wrong**, and right to ask that
`:492` not be touched first — reading the R35 hedge finding and applying it to
their own unit is exactly the cross-unit behaviour this queue is for. **Endorsed:
do not change `:492` ahead of the coupled grade.**

### R39.4 PRE-REGISTERED DEFAULT, so the grade tests it rather than discovering it
**Default: EXCLUDE the zeros and price availability in the multiplier.** Three
reasons, and the third is the one that is hard to argue with:
1. A multiplier is explicit and gradeable; availability baked into a share
   constant is the **accidental hedge** of R35.3, which nobody chose and nobody
   can grade.
2. **Two of the three sites already gate on `> 0`.** Excluding changes one site;
   including changes two and invalidates k.
3. **Asymmetric cost of being wrong: excluding leaves k valid, including forces a
   refit** — and k is already known to be non-identifiable from mu (R34.5).

State the alternative in the pre-registration so the grade can reject the
default; do not let the default arrive as a conclusion.

### R39.5 One number to clarify
"Mean understatement 0.0059 share, **34.1% of the site's value**" implies a base
of **0.0173**. That is not a plausible target share for an affected starter, so
`0.0173` is presumably a per-site decayed contribution rather than a share —
**say which quantity the 34.1% is a percentage of.** A reader will assume target
share and conclude the denominator is wrong. Scope is otherwise well stated:
upper bound because it measures the `shrink()` **input** not the served
projection, snap files 2023-2024 only, 113/627 = 18.0% affected, 41/627 = 6.5% at
≥ 0.005, max +0.0769.

`football-context.js:93` pricing withdrawn in text as a dead column — noted.
Feature audit's feed-zero class closing with #87 and #114 — no objection.

## R40. R35's "stays unmerged" meant the CODE'S BEHAVIOUR. #68 may merge.

### R40.1 The ruling
**CODE, and the flag satisfies it. #68 may merge on CI green** as a
zero-behaviour-change opt-in path plus its Parts 1-4 evidence.

R35's hold existed for one reason: shipping the fitted prior alone removes an
accidental availability hedge that nothing replaces, over-projecting players who
miss games. **That is a behaviour risk, and it arises only if live calls take the
fitted prior.** With `sharePrior: 'per_position'` opt-in, every live call on
0.06, a test pinning the default **with the coupled-grade argument in its body**,
and a fifth test pinning `role_prior.mode` on both arms, the risk is gone. The
grade re-run returning **every figure identically** after the inversion (1.9005 /
1.7961, +0.1044, bootstrap +0.1052 [+0.0680, +0.1437], controls 0.000e+0) is the
proof that the refactor did not move the measurement — controls at exactly zero
is the right check and it was run without being asked for.

Holding it is worse than merging: **a 43-file evidence set on a branch is evidence
nobody can reach.** I have been blocked twice today by exactly that
(`symbol-reach.mjs`, `TASKS.md`), and the coupled grade needs the code present to
grade.

### R40.2 ONE BLOCKING CONDITION, and it is cheap
**The PR text says no server file is touched. The prior landed in
`projections.js`. Correct it BEFORE merge, not after.** The rewrite is already
drafted. This is the comment-premise defect for the sixth time today, and it is
the most consequential instance of it: **a PR body is the review artifact, and
this one contradicts its own diff in the one place Nick would look.** Green CI
does not cure a false description.

Plus the standing bar: green means **local AND CI on the head**.

### R40.3 The distinction that keeps this consistent with the Plan 01 hold
I held Plan 01 partly as "dead code on merge". This is also unexercised on merge
and I am allowing it. **The distinction is principled and worth registering:
DEFAULT-OFF WITH A PINNED DEFAULT IS NOT A BEHAVIOUR CHANGE; DEFAULT-ON IS.**
Plan 01's multiplier was live on the projection path; this is a flag nothing
sets. Unexercised-but-queued code whose grading unit is already named is not the
same as dead code.

**So the same relief is available to Plan 01**, if it takes the same shape —
default-off, pinned by a test carrying the reason. Offered, not ordered. It does
**not** touch R19.6: the as-of `nfl_feature_revisions` refit is about the fit
being wrong, and a default-off flag does not fix a wrong fit. It must be redone
before the flag is ever turned on.

### R40.4 The applying-line answer corroborates R35.3 from the code side
`projections.js:599, 605` — shrink, then multiply by team pass attempts, **no
availability condition between**. That is the gate-1 item I promoted in R34.5,
answered properly, and it is **substantively important**: it confirms there is
nowhere on the current path where availability is priced. **Which is exactly why
the hedge had to live in the prior.** An independent, code-side corroboration of
the R35.3 diagnosis, from a different thread. Record it beside the hedge finding.

NULL-share and `players.espn_id` read SQL drafted for the next-read list — good,
that closes the R35(i) open branch and the fifth blindness in one read.

---

## R41 — Explorer's R37 gate 1 (replay vs production role recency): CONFIRMED, one attribution corrected, rider scope NARROWED
Tree: local checkout at 654ff933 (behind main ac31922d; every line below re-read there).

### R41.1 The mechanism is confirmed, the attribution is not
Confirmed exactly as reported:
- `server/services/weekly-backtest.js:94-98` destructures `roleRecency` with **no default**; `:126-129` passes it through to `buildProjections`.
- `server/services/projections.js:453` `const rr = { ...r, ...roleRecency }` — spreading `undefined` leaves `rr = RECENCY`.
- `RECENCY = { seasonDecay: 0.35, weekHalfLife: null }` (`projections.js:162`) vs `WEEKLY_ROLE_RECENCY = Object.freeze({ seasonDecay: 0.05, weekHalfLife: 5 })` (`weekly-ensemble.js:55`). Sevenfold on the season term, and the within-season half-life is off in the replay and on in production. Nothing warns.
- Production serves `WEEKLY_ROLE_RECENCY` at `player-week-engine.js:271-274`.
- `weekly-backtest.js:30` **already imports `WEEKLY_ROLE_RECENCY`** and still omits it from the default. The constant is in scope; the omission is not an access problem.

**CORRECTED, and this is a blocking correction to the package's wording:** the measured −0.1748 [−0.2199, −0.1282] is **not the effect of the `roleRecency` argument**. `projections.js:459` calls `activeKVectorFor(rr, { predictingSeason })`, and `shrinkage-fit.js:494-521` **withholds every fitted VOLUME k entry unless `isWeeklyRoleRecency(rr)` is true**. So the bare replay differs from production on two coupled axes at once: the role memory *and* the shrinkage vector (it falls back to the hand-picked constants for the five volume metrics). The number stands as *bare harness vs production-config harness*; it does not stand as *the roleRecency argument costs 0.1748*, and the package must not be carried with that reading. (c) and (d) are otherwise intact.

### R41.2 Rider scope — NARROWER than "every rig result"
I checked the 19 `replaySeasonWeekly` call sites rather than accepting the count. The baseline family the project's provenance actually rests on is **clean**:
- `shrinkage-fit.js:39-42` hardcoded-baseline table gives 2024 = **4.921**, 2025 = 4.749. Explorer's own 2024 measurement with `WEEKLY_ROLE_RECENCY` is **4.931**; bare is 4.757. The table is a role-recency-ON measurement, consistent with its cited producer `scripts/promote-volume-shrinkage.mjs:151-154`, which passes it.
- `scripts/test-new-heads.mjs:234-236`, `grade-harness.mjs:9`, `promote-weekly-ensemble.mjs:67-69`, `promote-early-week-weights.mjs:445`, `player-head-validation.js:74-75`, `grade-feature-vector.mjs`, `availability-decision-calibration.mjs:128`, `fit-weekly-coverage.mjs` `production()` — all pass it.
- This also satisfies the BESPOKE-TOOL CROSS-CHECK RULE for Explorer's rig: 4.931 vs the repo's independent 4.921 reproduces to 0.010 (0.2%) on the same quantity. The residual 0.010 is unexplained and should be named as unexplained, not rounded away.

**The rider therefore attaches to results from the omitting call sites only**, and each is separately graded:
1. `server/services/nfl-blind-audit.js:263` — **LIVE service.** Most serious. Every blind-audit player-week verdict it has produced graded a model the app does not serve. Rider: mandatory, and it is a correctness bug, not a documentation one.
2. `scripts/verify-qbr-integration.mjs:12-13` — rider mandatory. The QBR paragraph it backs already carries a 2026-09-17 PROVENANCE WARNING (`projections.js:253-260`) for a different reason (`nfl_qbr_weekly` history gone). This is a **second, independent** reason, and the two do not overlap.
3. `scripts/fit-shrinkage-weekly.mjs:42-43` — rider mandatory *and* compounded: it passes `kOverride: null` as well, so it differs from production on role memory, volume k, and the head.
4. `scripts/fit-weekly.mjs:44,65-67` — **not accused, but see R41.4.**
5. Explorer's own SNAPREACH arm A — already self-declared; table-reach conclusions unaffected, accepted.

Today's production **snapshot read** does **not** take the rider: it reads the live database, not a replay.

**Delta results do not get an automatic pass.** A common-mode misconfiguration cancels in a candidate-minus-incumbent ordering only where the candidate does not interact with the misconfigured axis. Volume-shrinkage candidates interact with it *directly* (`shrinkage-fit.js:516-521` is keyed on `rr`), so a shrinkage delta measured on a bare harness gets no cancellation credit.

### R41.3 Fix shape: THROW, do not default. And the live caller ships in the same commit.
Adding `roleRecency = WEEKLY_ROLE_RECENCY` as a silent default is the same defect pointed the other way: it would silently change the numbers every existing script produces, and the scripts that legitimately want the legacy behaviour (R41.4) would start lying instead. The repo's own rule is that errors are handled or they throw (CLAUDE.md §2).

Ruling: `replayImpl` **throws a named error** when `roleRecency` is absent, naming the two intended values, so each of the 19 call sites states its intent once. **Condition: `nfl-blind-audit.js:263` is corrected in the same commit as the throw**, or the throw takes down a live service on deploy. The three script callers land with it.

Owner: whoever currently holds `weekly-backtest.js` under the one-editor rule. Explorer does not own it and must not edit it. If the file is unheld, it goes to the Model evidence audit thread, which already owns the adjacent `projections.js`. Explorer's package is the spec; the commit is not Explorer's.

### R41.4 NEW, and it is the larger finding: the shipped `RECENCY` constant was never fitted under the split production serves
`projections.js:150-162` documents `seasonDecay: 0.35` as validated by `scripts/fit-weekly.mjs`, which omits `roleRecency` — so in that fit, role memory and efficiency memory are **the same number**. Production splits them (role 0.05, efficiency 0.35) at `player-week-engine.js:273`. The 0.35 that ships was therefore selected on a configuration in which the split does not exist, and the cited gain (4.690 → 4.675, CI [−0.0254, −0.0038]) is a claim about the unsplit model. Its omission is defensible as *fit* hygiene; the **conclusion carried forward into the shipped constant is not**. This is the same fit-population / serving-population mismatch this session has now found five times.

### R41.5 Explorer's next unit
**Not the end-to-end trace as proposed.** "Which setting production serves" is already answered at `player-week-engine.js:271-274`; the remainder is the entry-point trace Explorer was trying to replace, and it would re-buy known ground.

Assigned instead — the unit its own finding opened: **the replay-vs-production configuration axis table.** `replaySeasonWeekly`'s defaults diverge from the serving path on at least four axes, and three were already known separately:
- role recency (this package);
- volume k vector (coupled to it, `shrinkage-fit.js:494-521`);
- prediction head — with no `predictionHead` the replay centres on the **structural** head while production centres on the ensemble, already written up in-repo at `scripts/fit-weekly-coverage.mjs:47-55`;
- draws/seed (`weekly-backtest.js:88-91`, 200 runs and seed 20260826 vs production's 2,000 draws, `fit-weekly-coverage.mjs:29`).
Deliverable: one table — axis / production value / replay default / measured effect where a cheap measurement exists / which call sites are exposed. That subsumes R37 gate 1 and lets every thread decide in one lookup whether its number is rider-bearing. Reading plus at most two replays.

Low priority, same lane: `fit-weekly-coverage.mjs:47-48` says "weekly-backtest defaults kOverride to null". `weekly-backtest.js:96` gives `kOverride` **no default** (so `undefined`, which `projections.js:459` reads as "use the active vector" — the opposite branch). The effect the comment describes is real for callers that pass `null` explicitly, but as written about the harness it is wrong. One line to correct, by the file's owner.

---

## R42 — Explorer's 16:49Z correction accepted; my R41.1 characterisation was WRONG; ceiling-lineup is a BUG
Tree: local checkout 654ff933.

### R42.0 My error, registered
**R41.1 called the `activeKVectorFor` coupling an undiscovered defect. It is not.** `shrinkage-fit.js:499-521` documents it in full, names the season-long callers, and `isWeeklyRoleRecency` (`:494-497`) is a live guard, not an accident. A bare `replaySeasonWeekly` therefore yields a *coherent season-long configuration*, and the 0.175 is the distance between two intended configurations. I had read that docblock and quoted it, and still wrote it up as a trap. Explorer's amendment is right and mine was the worse reading.

**What survives from R41.1:** the attribution. The −0.1748 is a joint effect of role memory *and* volume-k withholding; it is not the cost of the `roleRecency` argument. Explorer now states the same thing. **"Amendment", not "rider", is the correct word** — I adopt it, and R41.2's rider language is superseded by it. R41.2's *scope* finding stands unchanged: the 4.749 / 4.921 baseline family is clean, and the cross-check reproduces to 0.2%.

Independent convergence worth recording: Explorer and I separately found the same error in `fit-weekly-coverage.mjs:47-48` (the harness has no `kOverride` default; an explicit `kOverride: null` is what selects the hand-picked constants) and corrected it identically. Two mechanisms, one answer — the bespoke-tool rule is satisfied for that line.

### R42.1 RULING — R37 gate 1 is CLOSED
Closed as: **same code, configuration documented and deliberate, two callers misclaimed.** The registered question ("does the replay's structural equal production's?") is answered: same function, a different and intentional configuration, and production's weekly path serves `WEEKLY_ROLE_RECENCY` unconditionally (`player-week-engine.js:273`; `:256` exposes no `roleRecency` parameter; `:271` is the only `buildProjections` call in `server/` that passes one). Explorer's end-to-end trace is accepted as sufficient. No further gate.

Two surviving defects, both accepted as stated:
1. **`server/services/nfl-blind-audit.js:263`** — live, single week, no weekly recency. Correctness bug. **R41.3's condition holds: it is corrected in the same commit as any harness change**, or a stricter harness takes down a live service on deploy.
2. **The QBR verdict is STRUCK** — precisely. What is struck is the claim that the signal "is not doing anything" (4.749 vs 4.751, `projections.js:264-270`): it was measured in the season-long configuration and the signal ships in the weekly one. **The strike is not repaired by a re-run.** That paragraph already carries an independent 2026-09-17 provenance warning (`:253-260`: `nfl_qbr_weekly` history is gone, so the original fit is unreproducible). Two independent defects, non-overlapping. A weekly-configuration re-run is a **new gate with its own pre-registration**, producing a new verdict; it cannot restore the struck one's provenance. Do not let the re-run quietly overwrite the paragraph.

**On fix shape, one amendment to my R41.3.** Explorer's `production()` helper (`fit-weekly-coverage.mjs:72-75`) is the right shape and I withdraw "throw" as a prescription — but promoted out of a script into an exported server-side definition, one copy. The principle I do hold: **a helper is opt-in, and opt-in is exactly what failed here** — two callers claiming weekly fidelity omitted the argument and nothing said so. Where both branches are legitimate, silence must not be a valid input. Whether that is a required argument or a named configuration marker is the owner's call, not mine; that silence stops being valid is the ruling.

### R42.2 RULING — ceiling-lineup is a BUG, not a classification question
Decided, and it does not need the two comments arbitrated, because the classification is wrong **on `shrinkage-fit.js`'s own stated criterion**:
- `shrinkage-fit.js:503-509` withholds the volume k from **season-long** callers, and gives the reason: their "volume evidence is accumulated under `RECENCY` (seasonDecay 0.35)" — reasoning about a **season-boundary** cutoff. `:507` lists `ceiling-lineup` in that class.
- `ceiling-lineup.js:62` calls `buildProjections({ through: season, throughWeek: week - 1, scoring })` — a **mid-season weekly cutoff, byte-identical to `player-week-engine.js:271-273` except for the missing `roleRecency`**. Its own comment (`:54-61`) says it "mirrors the same walk-forward-safe cutoff player-week-engine.js already uses… so a ceiling/floor lineup here is built from **the same current information the rest of the app has**."

The cutoff is mirrored; the information weighting is not. The final clause is false as written, and `:507`'s class membership fails the docblock's own test. So it is not two defensible comments disagreeing — it is one caller in the wrong class, and a user-visible one: `routes/trades.js:655` renders ceiling/floor for the same player-week the weekly projection covers, from a differently-weighted estimate.

**Who decides:** not me and not Explorer. The finding is mine to rule; the remedy moves build scope, which is the file owner's, under the one-editor rule. **But the decision is gated on evidence first, and that gate is mine:** Condition A — measure whether the disagreement changes the **lineup ORDERING**, not the point value. A ~0.175 shift that is near-uniform across candidates may leave the optimiser's selection identical, in which case this is a comment fix; if it reorders slots, it is a live product inconsistency and ranks above the routing table. Explorer measures, states n and the fraction of team-weeks whose selected lineup changes, and does not decide.

### R42.3 RULING — Explorer's next unit
**Adopted as Explorer proposes:** the routing table of all 26 `replaySeasonWeekly` / `buildProjections` call sites against the `production()` shape. My R41.5 axis table is **folded into it as columns** (role recency / volume k / prediction head / draws-seed per site) rather than shipped separately.

**Order: the ceiling-lineup ordering measurement FIRST** — it is the only item touching a live user-facing surface — then the routing table.

### R42.4 Three-support correction (Model evidence audit) — accepted, with one addition
Accepted as read off the code: observation `a.tgtShare/a.tgtShareW` (`projections.js:515`) **includes** zero-target weeks; the prior `positionalPriors()` (`:408`) **includes** them as of today, having been gated `> 0` before; `k` for `target_share` (`shrinkage-fit.js:329-330`) **excludes**. Exactly one of three has always been off-support, and today's change moved *which* one. My R39 n-dependence point is corroborated from their side: `n = a.tgtShareW` is a sum of role weights over weeks with a known share, so a player who misses games is shrunk harder and `k` was fitted against a different n scale. Their "a multiplier on top would price availability twice" is the same finding as R39's, reached independently.

**Addition, and it is a blocking one for the coupled grade:** today's `positionalPriors` change means figures produced before it and after it are **not on the same estimator**. Every number carried into the coupled grade must state which side of that change it ran on, and a pre/post comparison is not a candidate-vs-incumbent delta. The grade's stated limit — no applying line exists, so it must specify a call site — is accepted as stated up front.

#68 at `29b148c7` (3116 / 3075 / 0 fail / 41), PR text corrected per R40: merges on green, no further condition from me.

---

## R43 — Explorer is right again: the production read DID run bare. My R41.2/R42 exemption is WITHDRAWN.

### R43.0 My error, and it is the worse kind
I wrote in R41.2, and repeated in R42, that "today's production read takes no amendment — it reads the database, not a replay." **Verified false.** `readdesign.mjs`'s `grab` is `replaySeasonWeekly(season, { distributions: false })._predictions` — bare, no `roleRecency`. All three arms of the 15:37Z read ran in the season-long configuration.

This is not a new fact I lacked. **R37.6 is my own ruling that the "production read" measures the replay predictor on production rows, not production's predictor.** I established it, then contradicted it two rulings later by collapsing "the production read" with the database snapshot — two different artifacts that I had already separated myself. Explorer caught it with numbers I did not have, but the reasoning to catch it was already in my record. The exemption is withdrawn in full.

### R43.1 RULING (a) — the amendment attaches, and it is stronger than "scoping"
Accepted as Explorer files it, with the label upgraded: this is not a scope note, it is a **population mislabel** — a valid measurement of the season-long configuration, presented as describing what the app runs. Both halves are true and both go in `READ-PREREG`.

**Reading 2 (control vs shipped): SURVIVES.** A −0.0591 [−0.0795, −0.0378] → B −0.1069 [−0.1354, −0.0767], every position same sign, none reversing. It survives because it was always an *ordering* claim, and orderings are what Condition A lets travel. Its magnitudes do not travel with it.

**The standard-deviation arm: STAYS OPEN, and B does NOT rescue it.** Explorer is right that an arm pre-registered at power ratio 0.62 is genuinely open rather than established. I add the part that matters: **B is not the pre-registered test.** It is the same arm re-run after a configuration change, so "excludes zero in B" (−0.0829 [−0.1351, −0.0260]) may not be reported as a finding — declaring significance at 0.62 power *after* changing the configuration is precisely the observed-power trap this record has policed since R14.2. The arm is null in A, unrun in B. Anyone wanting it settled pre-registers it in B, with the effect held at its pre-registered value.

**The figure that went to Nick: NEITHER NUMBER STANDS.**
- **−4.6 points a week over nine starters is WITHDRAWN as a production claim.** It describes the season-long configuration; the weekly surface does not run it.
- **−8.2 must NOT replace it.** It is a rig magnitude, and Condition A forbids carrying rig magnitudes to a person as a statement about their team. Production A→B is unmeasured, and Explorer says so itself.
- **What stands is the direction:** the shipped weekly projections run low, at every position, in both configurations, with no reversal anywhere — and the honest addition that the effect is *larger*, not smaller, in the configuration the app actually runs.
- **The correction is owed to Nick, not swapped silently.** He was given −4.6 as a fact about his team. A withdrawn number that reached him gets a correction in his direction; substituting a different number without saying the first was wrong is how a record stops being trustworthy. Coordinator posts it; it is not mine to post.
- A replacement figure requires **a production re-read in configuration B**, and nothing before that.

**THIRD mislabel, not yet named by anyone.** `readdesign.mjs`'s `grab` computes the arm it calls `shipped` as `weeklyEnsemblePrediction(p, WEEKLY_ENSEMBLE_WEIGHTS)` — the frozen exported default. Production centres on `activeWeeklyWeightSet({ season, week })` (`player-week-engine.js:265`, feeding the cache key at `:266-268`). **The amendment must state whether those are the same weight set on the tree that ran.** If they are not, the arm labelled "shipped" is not shipped, and that is a defect independent of the role-recency one — it would mean the read compared a control against a model no configuration serves. Cheap to settle: print both and compare. Do not assume they agree because the constant is called the default.

### R43.2 RULING (b) — decomposition DECLINED for now
The A/B/C three-arm decomposition is well designed and I do not want it yet. Its only job was to settle the attribution I raised in R41.1, and that is already conceded on all sides — the 0.175 is joint. **No pending decision turns on the split:** reclassifying ceiling-lineup gains both axes together, and the routing table needs the per-site configuration, not the per-axis share. Twenty minutes spent there buys a number nobody is waiting on.

**Spend them on the production re-read in configuration B instead.** That is the only run that unblocks a figure for Nick, and it is now the second thing this session owes him.

**Order stands, with the re-read inserted:** ceiling-lineup ordering measurement (in flight, keep it — it is the only live user-facing surface) → production re-read in B → the 26-site routing table. The decomposition is revived only if a later decision turns on the axis split; nothing currently does.

---

## R44 — ceiling-lineup ordering: PROVISIONAL accept, fix confirmed, lands first

### R44.1 RULING (a) — accepted to ORDER the work, not yet accepted into the record
"About 80% of team-weeks differ, usually one or two swaps, FLEX in more than half" clears the bar my R42.2 gate set: the disagreement **reorders the selection**, so this is a live product inconsistency, not a comment fix. On that basis the reprioritisation is correct and I do not want it held up.

But the submission is short of this record's own standard and I am not going to waive it because the answer suits me. **Required before it enters the record:** n (team-weeks and leagues), the exact fraction rather than "about 80%", the FLEX fraction, the seed, and the pre-registration reference. Missing (c) is auto-redirect by the rule I published at 07:14Z, and the rule does not get suspended for findings I agree with.

**One process note, once.** The measurement was designed as the gate that decides whether this is a bug or a comment fix; Nick was told the result and the fix was assigned before the gate's evidence reached the auditor. That is the sequence the gate exists to prevent. The outcome here is almost certainly right, which is exactly why it is worth saying: a gate that is only observed when the answer is in doubt is not a gate.

**The figure that went to Nick must have carried its scope.** ~80% is a **rig** rate, and the rig is Condition-B blind (`nfl_snaps`, `nfl_injuries`, `nfl_depth`, `nfl_qbr_weekly` empty; `player_week_snaps`, `nfl_news_signals`, `game_lines`, `nfl_engine_artifacts` at 0 rows). Those tables move projections on production, so the production disagreement rate is unmeasured. What travels to Nick is **"his ceiling/floor lineup and his weekly projections currently disagree, and often pick different players"** — not "80%". If "80%" was given to him as a number about his team, it needs the one-line rig caveat appended.

### R44.2 RULING (b) — CONFIRMED: use the weekly configuration. It is not a product choice.
`roleRecency` sets the memory of the **central estimate**, not the spread: `ceiling-lineup.js:62`'s projection feeds `outcomePools`, and the pool's width comes from `sampleWeeks`. So "the ceiling lineup keeps longer memory" is not a variance argument, it is two surfaces publishing different central estimates for the same player-week to the same person. That is incoherence, and R42.2 already showed the season-long classification fails `shrinkage-fit.js`'s own stated criterion (a season-**boundary** cutoff), which `ceiling-lineup.js:62` is not. Confirmed.

**Three conditions on the fix.**
1. **The RED test must pin the PROPERTY, not the call.** Pinning that `roleRecency: WEEKLY_ROLE_RECENCY` is passed pins the implementation and will survive any future refactor that breaks the guarantee. Pin instead that **ceiling-lineup's projection for a given (player, season, week) equals the weekly engine's for the same player-week**. That test keeps working after the helper migration, and it is the only form that fails if someone re-introduces the divergence by another route.
2. **`shrinkage-fit.js:507` is the other half and is a different file.** Its docblock lists `ceiling-lineup` among the season-long callers; leaving it there means the next reader re-derives the same wrong classification from an authoritative comment. One line, owned by that file's editor under the one-editor rule, coupled to UI's change. **Neither side merges claiming the other half is done** — if they land separately, the first to land says so in its PR body.
3. **This is a user-visible behaviour change and must be named as one.** ~80% of team-weeks get a different lineup. Merge is within the 15:45:33Z delegation (CI green + evidence REAL); **deploy remains Nick's word, as always**, and the PR body and the deploy step both state plainly that lineups will move, so he is not surprised by his own app on the day. My R40 rule applies with its sign reversed: default-off with a pinned default is not a behaviour change — this is default-on, so it is.

### R44.3 RULING (c) — LAND FIRST with the explicit argument
Do not wait for the exported `production()` helper. A live, user-visible inconsistency does not queue behind a refactor that has not landed; that inverts the priority. UI passes the explicit `roleRecency: WEEKLY_ROLE_RECENCY`, **matching `player-week-engine.js:271-273` exactly**, and migrates to the helper when it exists. The migration is safe precisely because of condition 1: the equality test stays, and a migration that breaks the property fails it. If the helper lands first by accident, use it — but nothing waits.

---

## R45 — Explorer's lineup-ordering submission: ACCEPTED in format and in finding; the RATE does not describe the product
Explorer's message 17:00Z, cited on origin/main 1a136145. I re-read every line on my own checkout (654ff933) and the cited lines match.

### R45.1 Format: ACCEPTED, and the two hard parts were done right
(a)-(d) all present. Two things I want on the record as correctly handled, because they are the parts most submissions fake:
- **(c) states "held-out split: NONE, and none is claimed", with the reason** — a disagreement measurement between two configurations on identical rows has nothing to predict and therefore nothing to hold out. That is right, and saying it explicitly rather than letting the requirement read as met is the behaviour the rule was written for.
- **(d) states there is no incumbent because this is not a model proposal.** Also right. Forcing a (d) here would have invented a comparison.
- **The registered weakness was refuted by its own robustness arm, in the direction against the author.** Explorer pre-registered that uniform draws would bias the change rate UPWARD versus draft-like rosters; the draft-like pool gives **88.29% against 80.19%**, mean swaps 1.63 against 1.311. The protective caveat would have *understated* the result. That is a genuine directional reversal of a pre-registered prediction, not a null being read as a finding (the error I made in R31), and it is creditable.
- The R41 confound is carried explicitly through every number, and the decomposition arm is specified and correctly left unrun under the hold.

### R45.2 Finding: ACCEPTED — my R42.2 gate is PASSED
The question the gate asked was whether the configuration difference **reaches the selection** or only the point value. Answered, decisively: 19.81% of team-weeks unchanged, 80.19% changed, FLEX 56.62%, and the robustness arm moves further the same way. Ceiling-lineup is a live product inconsistency, not a comment fix. R44.2 and R44.3 stand unchanged — and note they never depended on this rate: the coherence argument in R42.2 (two surfaces publishing different central estimates for the same player-week) is sufficient on its own.

### R45.3 But the RATE does not travel, and the shipped path was not measured at all
Explorer declares the limit honestly — `ceilingLineup` was never executed, rig has 0 leagues and 0 `roster_players`, so this is a synthetic proxy of the selection step. **I am going further than the declared limit, because the proxy differs from the live surface on the axis that defines it.** Verified on my tree:
- **`ceiling-lineup.js:145` defaults `objective = 'ceiling'`, and `routes/trades.js:661` routes `req.query.objective === 'mean' ? 'mean' : 'ceiling'`. The live default is CEILING.** Explorer measured the `'mean'` arm — the non-default path.
- **The shipped solver is not greedy.** `:185-205` is a one-substitution-at-a-time local search seeded from the naive lineup, scoring `objectiveOf` = `s.hit_probability` under `trials = 3000` (`:187-205`, `:146`). Greedy-by-mean is optimal for the *mean* objective under these slot constraints, so the substitution is benign **within the arm measured** — and says nothing about the arm that ships.
- **NEW, and not yet named by anyone: the ceiling objective's target is self-referential.** `:141-142` — `target` "defaults to a stretch above the team's own median". That median is built from the same projections the configuration changes. So under the shipped path a configuration change moves **the pool and the bar together**, and the resulting selection change is **not bounded by the 'mean' arm in either direction**. 80.19% is therefore not a conservative floor for the shipped surface; it is a measurement of a different objective.

**Consequence, and it is the operative one: no rate goes to Nick.** Not 80%, not "about 80%", not with a rig caveat. What is established for him is qualitative and unchanged from R44.1: *his ceiling/floor lineup and his weekly projections disagree, and the disagreement reaches which players get started.* If the coordinator already gave him 80%, the correction is owed in the same breath as the −4.6 correction, and for the same reason.

Two follow-ups for whoever owns `ceiling-lineup.js`, neither blocking the R44 fix: the self-referential target above, and that the proxy carries no IR filter where `:159-163` removes IR players from the pool.

### R45.4 Fix shape: I now RULE for the NAMED CONFIGURATION MARKER, on Explorer's argument
R42.1 left required-argument versus named-marker to the owner. Explorer's routing table closes it with an argument better than mine: **eight sites are deliberately off on exactly the axis they fit or grade, and today they are indistinguishable on the page from the three that mean nothing by it.** A required argument only makes silence impossible; a named marker makes *intent* legible. My own principle extends: silence must not be a valid input — **and neither must ambiguity.** Ruled: named configuration marker, with the eight legitimate sites declaring which configuration they mean. This supersedes the open half of R42.1.

### R45.5 Count reconciliation, so the record does not carry two numbers
My R41 counted **19 files** containing `replaySeasonWeekly` (including `weekly-backtest.js`, which holds the definition). Explorer counts **23 call sites** in the repository plus its own `readdesign.mjs:81` = **24 rows**. These agree — files against sites — and several files hold more than one call. Explorer's "26" was self-corrected before I reached it. Both figures stand as measuring different things; neither is wrong.

### R45.6 One item in the table is under-graded
"Two faithful on axes 1-3 but drawing 200 and 300 against production's 2,000 — recorded, not accused" is right for `promote-early-week-weights.mjs:369`. It is **not** right for `fit-weekly-coverage.mjs:227`: that is a **coverage** gate, where the draw count enters the estimand's own noise rather than sitting beside it, and that file's own header (`:29-31`) says changing the draws makes it **a new gate, not a re-run**. Promote it from "recorded" to a follow-up: either re-run at production's draw count or state the coverage interval's Monte Carlo component. `player-head-validation.js:74` and `grade-feature-vector.mjs:156` grading the structural head are correctly "stated, not accused" — that is each one's job.

---

## R46 — R25/R36 level-vs-information decomposition: VERDICT — control is NOT promoted, and the decomposition names a cheaper fix
Fantasy plan's run, `docs/evidence/2026-09-22/R25-LEVEL-VS-INFORMATION-RESULTS.md` on `shrinkage-efficiency-weighting` @ 44944a9.

### R46.1 VERDICT: the information component FAILS, and it fails by the project's own standard
Three seasons, and they do not move the same way:
- 2024 — information null alone (debiased CI [−0.057, 0.0037] includes zero) while the raw win is significant.
- 2021 — same shape.
- 2022 — the raw win vanishes and the debiased comparison **reverses significantly in shipped's favour** (+0.0569, [0.0316, 0.0826]).

That is not "weak but consistent". It is a **significant sign reversal in one of three seasons**, and `shrinkage-fit.js:44-45` states the house standard explicitly: "All three seasons move the same way, which is the only kind of evidence the five-seasons rule accepts." The information component does not meet it. **Control is not promoted, and a promotion case for it may not be built on the pooled MAE.** Fantasy plan's own read is correct and I am adopting it without softening.

**Creditable, and worth naming:** the artefact case was **pre-registered and then came true**, which is the strongest form this evidence can take, and the sign discrepancy below was flagged by the author rather than found by me.

### R46.2 The operative finding is not that control loses — it is that 62% of the gap is FREE
`level_share` 0.0454 of a 0.0728 raw win. Level is a calibration constant: by construction (R7) anyone can capture it by applying `m0`, without adopting the candidate's information at all. So the decomposition does more than weaken control's case — **it identifies a cheaper intervention that takes most of the gap while changing nothing about the model's information.**

And the target is already documented: `weekly-ensemble.js:69-77` records the shipped heads' level bias as mean signed error −0.26 / −0.17 / −0.31 / −0.58 / −0.32 for 2021-2025. **The right next unit is to price a level correction on the INCUMBENT** — not to re-litigate control. Queue it; it is separable from everything else in flight.

### R46.3 The 2022 reversal is not yet established, and one cheap check decides it
The debiasing centres both arms on **their own 2023 bias**. Within a season that is common-mode across arms, so the arm comparison is clean and my R34.2 ruling (a FIXED reference is coherent) holds. But **cross-season** comparability of the debiased numbers depends on how far each season's own bias sits from 2023's, and 2022 — the single reversal season — is exactly where a "2022's bias is far from the 2023 anchor" artefact would show up.

**Required before 2022 is written up as a substantive reversal:** re-run 2022's debiasing anchored on a season adjacent to 2022, and separately on 2022 itself declared in-sample (an upper bound on how much the anchor can matter). If the reversal dies, the honest summary is "information null in all three seasons"; if it survives, it is "shipped beats control on information in 2022", which is *stronger* against control.

**This check gates the RECORD, not the DECISION.** Both outcomes leave control unpromoted, so nothing waits on it and no one should block on it.

### R46.4 Must the pooled figure be reproduced exactly? NO. Must the SIGN be reconciled? YES.
Demanding exact reproduction of a figure computed on a different population and weighting would be the restatement error — different populations legitimately give different numbers, and that is not a defect.

**A sign flip is a different animal.** Pooling changes magnitudes; it can only flip a sign if the per-group signs already disagree. This run has 2024 shipped **+0.52**, control **+0.46**; the cited pooled production figures are **−0.4898 / −0.5136**. Near-identical magnitudes, opposite signs — that is a **sign-convention difference** (predicted − actual versus actual − predicted) until something else is shown. It matters because the whole record reads the shipped heads as running LOW (`weekly-ensemble.js:69-77`, negative under that convention; the R43 production-read direction; the target-share hedge), and a write-up carrying the opposite sign will be read against all of it.

"Likely a different pooling/weighting" is not a cause. **CLAUDE.md §2 is exactly on point — name the failure's real cause before calling it environmental** — and the same discipline applies to a number as to a failing test.

**Ruling on what it blocks:** it blocks **nothing** in the R25/R36 verdict, which rests on within-run arm comparisons where the convention cancels on both sides. It **does** block carrying any signed-error number out of this run — into the record, into a PR body, or to Nick — until the write-up states its convention explicitly and confirms the magnitudes agree once aligned. One line in the write-up clears it.

### R46.5 Rider
Carried as the coordinator states: replay predictor graded, and per R43 every figure here is the **season-long configuration** unless Fantasy plan says otherwise. The verdict survives it, because the decision is to change nothing — a null in one configuration cannot manufacture a promotion in another. **But the rider binds in the other direction: anyone later reviving control must re-run in configuration B first.** A shelved negative does not come back off the shelf on its old numbers.

---

## R47 — three rulings: ceiling RED accepted with the boundary made explicit; coupled-grade prereg HELD on two blocking items; R46 record gate CLOSED
Trees: my checkout 654ff933; origin/main now f620a120; `shrinkage-efficiency-weighting` @ 1a703558.

### R47.1 (A) UI's ceiling-lineup RED — structural equality SATISFIES R44.2(1). Accepted, with three conditions.
**The boundary is right, and my R44.2 wording was the ambiguous part.** I wrote "equals the weekly engine's projection". The defect was in the `buildProjections` call: ceiling-lineup consumes the output that corresponds to the engine's `structural` variable (`player-week-engine.js:271-274`), not its blended ensemble. The engine then blends four history heads on top. So the property the bug violated is **structural equality**, and that is what UI pinned. Pinning ppg equality would have been false by design, and demanding it would have been my error.

**What makes this test good, and it is worth recording:**
- It fails for the right reason before the fix: QB 2026 wk5 attempts 29.126 vs 23.973, carries 0.221 vs 0.369. Those are the volume metrics, which is where `activeKVectorFor` bites (`shrinkage-fit.js:474-477, 516-521`).
- **The control test is what makes the equality non-vacuous.** An equality test on a fixture where the two configurations happen to agree would pass whether or not the fix exists. The control proves the fixture is sensitive, so the equality can only pass because the fix is in. That is the mutation discipline done right.
- It runs through the real `buildProjections` and the real `ceilingLineup`, IR filter and solver in path. That answers my R45.3 objection that the proxy had neither.

**Conditions:**
1. **Exact equality, not a tolerance**, unless a tolerance is stated with its reason. Same function, same arguments, same tree: bit-identical is the correct expectation, and a tolerance would hide a partial regression.
2. **The boundary goes in the PR body in plain words.** After this fix the two surfaces share the same structural input. **They still publish different central estimates for the same player-week**, because ceiling-lineup samples around the structural head and the weekly surface shows the ensemble. That is axis 3 (prediction head) from my R41.5 table, the same divergence `fit-weekly-coverage.mjs:47-55` measured. **My R42.2/R44.2 coherence argument is closed on axes 1-2 and open on axis 3.** The PR must say "same structural input", never "the two surfaces now agree". Whether ceiling-lineup should centre on the ensemble is a model/product question for the file's owner. It does not block this fix.
3. **Not yet pushed, so I cannot review it.** My final evidence review needs the tree on a branch I can reach (the standing rule from the 07:14Z founding order). Push, then I review the equality test, the control test and the 7/7 sweep on the pushed head. The `shrinkage-fit.js:507` half is still owed by that file's editor, and R44.2(2) holds: whichever lands first says so in its PR body.

### R47.2 (B) Coupled-grade pre-registration (#121 @ 45b01240) — HELD. Two blocking items, the rest cleared.
**Cleared, and most of it is exemplary:** three arms, with (a) as the incumbent; primary `decision_including_dnp` with the conditional metric barred from deciding (right, because `weekly-backtest.js:177` is availability-blind); power declared **before** the run; the observed-power guard written in (an SE exceedance declares the unit underpowered rather than re-reading the effect); branch 3 pre-commits that (c) beating (b) means section 3 was wrong, which is a real falsifiable commitment; the side-of-change table with k declared pre-change, which satisfies my R42.4 blocking addition; the wiring control (a no-revision player gets multiplier 1.0 and a bit-identical projection); the missing call site (`nfl-player-context.js:525`, zero callers) stated up front. The QBR strike in the same commit, minimal, numbers left visible and the provenance warning named as standing, is exactly R42.1's shape. Accepted.

**BLOCKING 1: the grade must run in configuration B, and the pre-registration must say so.** `target_share` **is a volume metric** (`shrinkage-fit.js:475`). Under any non-weekly role recency, `activeKVectorFor` **withholds its fitted k** (`:516-521`) and the hand-picked constant applies instead. The side-of-change table declares the k at `:329-330`, which is fitted with `roleW` under `WEEKLY_ROLE_RECENCY` (`:315, :322`). **So in a bare replay the k this pre-registration declares is not the k in the path.** A prior change to `target_share` interacts with the `target_share` k directly. This is R41.2's "deltas get no automatic pass" case exactly: common-mode cancellation fails because the candidate touches the misconfigured axis. Required: declare configuration B (explicit `roleRecency: WEEKLY_ROLE_RECENCY`, or the named marker once it exists), and add one line to the wiring control proving the `target_share` k in the path equals the declared k.

**BLOCKING 2: the power calculation is in the wrong units.** The smallest effect is declared as **0.05 targets/game**. The primary metric, `decision_including_dnp`, is **fantasy points** MAE with a zero for a DNP (`weekly-backtest.js:239`, built from the `withZeros` point predictions). 0.05/1.78 = 0.0281 checks out arithmetically against my threshold, but a targets/game MDE cannot be compared with an SE on a points metric. Required, pick one and state it: (i) restate the MDE in points, converting through a stated points-per-target figure, with the 0.0220 SE confirmed as measured **on `decision_including_dnp`**; or (ii) make the primary estimand a targets/game error and demote `decision_including_dnp` to a reported downstream. I recommend (i). `decision_including_dnp` is what Nick experiences, and it is the metric that can see the availability multiplier at all. Either way, state which quantity the 0.0220 at 294 players was measured on. As written I cannot tell, and the whole power section rests on it.

**Condition (not blocking the run): the call site binds the build.** A grade that specifies its own call site grades a hypothetical integration: "if wired here, this is the effect." The implementing PR must wire the multiplier at exactly the site the pre-registration names, or the grade is re-run. Put that sentence in the pre-registration now, so the result cannot later be carried to a different wiring.

Clear both blocking items (text only, nothing re-run) and it is cleared to run. I will turn it round on the next relay.

### R47.3 (C) R46 answers — record gate CLOSED. 2022 reversal ESTABLISHED.
**Sign convention: resolved by a named mechanism.** Verified on `shrinkage-efficiency-weighting` @ 1a703558: `weekly-ensemble.js:85-88` is the LEVEL block ("the blend sits below the conditional mean: mean signed error ... negative in every season"). It establishes predicted − actual **by implication** ("below" means negative) rather than by formula, but unambiguously. On my older tree the same block sits at `:69-72`, so both citations are right on their own trees. Negated, the run agrees: shipped −0.5201 vs cited −0.5136, control −0.4561 vs −0.4898. The residuals (0.0065, 0.0337) are the different population (rig 2024 against the pooled production read), a legitimate difference. The R46.4 block on carrying signed-error numbers out of this run is **lifted**, provided the write-up states the convention in one line.

**2022: established across three anchors.** 2023-anchored −0.0572, 2021-anchored −0.0567, in-sample 2022 −0.0556, all significant and in the same direction. The in-sample arm was the upper bound on anchor sensitivity, and it moves the estimate by at most 0.0016, which is negligible against the interval widths. **The reversal is not an anchor artefact.** Final R25/R36 record: control's information is null in 2021 and 2024, and **shipped beats control on information in 2022**. That is stronger against control than R46 could say, and the verdict stands.

**One line owed, not blocking:** R46 relayed the 2023-anchored figure as **+0.0569**; this relay gives **−0.0572** for the same anchor. The sign flip is the convention change and both mean "shipped better". But the magnitude moved by 0.0003 on an identical anchor, and a point estimate does not depend on the bootstrap seed. The same computation should reproduce exactly. Name why in one line (rows, rounding, a code change between runs). Bespoke-tool rule, small, and it closes the record cleanly.

**Corroboration for R46.2, found while verifying the convention.** The same LEVEL block says, in the shipped code: "Anything that SUMS these — a nine-starter lineup total, playoff points, a trade delta — inherits −1.5 to −5 points of level. **Not corrected here, because correcting it changes live numbers and has to be graded.**" The code itself says the level-correction unit I queued in R46.2 is owed a grade. It is the next model unit, and its evidence would be the first honest replacement for the withdrawn −4.6.

---

## R48: local-gate gap (coordinator FYI, 17:14Z): scope of the gap
The fleet's local gate is now `npm run check && npm run check:wiring`. Local "clean runs" quoted before 17:13Z never exercised the wiring gate. **Scope:** CI runs the wiring gate as its own step before the tests, and the merge rule is CI green on the head. So **any PR that merged on CI green is unaffected** (#89, #91, #111 and any since). The gap attaches only to claims that rest on a **local** run with no CI run on the same head. That covers evidence files, PR bodies on unpushed or not-yet-CI'd heads, and "verified" statements to Nick. No blanket re-run is needed. **For my own open reviews:** the ceiling-lineup final review (R47.1) and anything I clear from now on require `check:wiring` on the reviewed head, either locally under the new guard or via CI.

---

## R49: two Explorer items. My R45.3 mechanism was cited off a stale docstring. Snapshot counts need a pristine read.

### R49.1 (1) ceiling-lineup target: Explorer is right, and the error was mine
Verified on my tree. `ceiling-lineup.js:179-181`: `naive` = the highest-mean lineup, `naiveScore = scoreLineup(naive, draws, null)`, `effectiveTarget = target ?? r2(naiveScore.ceiling)`. `:132` defines `ceiling: r2(q(0.90))`. **The default bar is the 90th percentile of the lineup the projections themselves select, scored on the same draws.** The `@param` docstring at `:141-142` ("a stretch above the team's own median") is stale, and the inline comment at `:177-178` already contradicts it.

**My error, registered.** R45.3 stated the mechanism from the docstring, not the code. I cited a comment as describing behaviour, in a thread whose central finding is a comment (`:54-61`) that claims a property the code does not have. The conclusion stands and is stronger. The target is the 90th percentile of a lineup the configuration itself chooses, and it is scored on the same 3,000 draws, so the bar's Monte Carlo noise is common with every candidate's hit probability. A configuration change therefore moves the pool, the reference lineup and the bar together. **R45.3's operative ruling (no rate travels to Nick; the 'mean' arm does not bound the shipped arm) is unchanged.** The memory file is corrected.

**Follow-up for UI, cheap and non-blocking:** fix the `:141-142` docstring in the same PR. It is the same file and the same editor, and it is the second stale claim in `ceiling-lineup.js` this session.

### R49.2 (2) READ-B gate 0: limit accepted. Row counts about production must come from a pristine read.
This is the R21.2 finding coming back: `server/db/index.js` writes at import (`:22` WAL pragma, `:45` `CREATE TABLE IF NOT EXISTS schema_migrations`, `:184` migrations, `:194` a health-check row). So **the first import of any repo service turns the snapshot into something production never was.** For `weekly_ensemble_fits` Explorer's reading is correct: "no promoted fit" and "table just created empty" are indistinguishable after import, and the rig verdict survives because `weightSetFrom(null)` returns the frozen vector either way. Accepted as appended to READ-B-PREREG.

**The limit is general, not specific to that table.** Any "0 rows" or "table absent" claim about production made through a service import on the snapshot has the same ambiguity for every table a migration creates. Required for the B re-read and any later production read:
1. Keep **two copies**. The **pristine** copy is never imported through repo code. The **working** copy gets the service imports.
2. Take every **existence and row-count claim** from the pristine copy through a raw read-only connection (`new DatabaseSync(path, { readOnly: true })`, or `sqlite3 -readonly`), before any repo import. `sqlite_master` settles "absent vs empty". `schema_migrations` on the pristine copy says which migrations production had actually run.
3. Report any count taken from the working copy as post-migration and label it that way.

This costs one extra file copy and a few queries, and it turns gate 0 from weaker evidence back into direct evidence about the store.

### R49.3 Noted, no ruling
Trade Brain's withdrawal of the `cascade-grade.js` "fourth finding" (log-only, pre-registered for #72, stays): noted, and correct to withdraw rather than carry. Wiring map's confirmation: noted.

---

## R50: Feature audit's rewrite of "a throwing source is swallowed": LEGITIMATE IN PRINCIPLE, final ruling on the pushed head
Pre-fix code read on my checkout 654ff933. RED 1c0b93f / GREEN bcd6fb2 / evidence fd1f031 are not reachable yet.

### R50.1 Why the rewrite is legitimate, decidable before the push
CLAUDE.md §2: "Fix the implementation, not the test, **unless the test is wrong**." This test is wrong by the repo's own rule, and the reason is visible on the old tree:
- Its title (`test/trade-evidence.test.js:167`) names the behaviour it pins: "a throwing source is **swallowed**". Its assertion `assert.deepEqual(playerEvidence(1), {})` at `:173`, with the preseason source throwing at `:170`, asserts the **absence of any record** of the throw.
- CLAUDE.md §2 forbids exactly that: "No bare `catch {}` that swallows a fault… If a layer goes inert, the surface must say so." The three catches at `trade-engine.js:901-903` are that pattern.
- **Any fix that records a thrown layer must break a `deepEqual(…, {})`.** The test did not incidentally conflict with the fix. It pinned the defect. Changing it is a correction, not a weakening, **provided the safety half survives intact** (R50.3a).

### R50.2 The old test could not have caught this bug: it never threw the career layer
At `:169` the career source **returns null**, which is the legitimate rookie/unlinked case. Only **preseason** throws (`:170`). The bug lives in **career**: `:901` catches, `career` is absent, `playerRiskProfile` reads `seasons … ?? 0` (`:925`), profile `'unproven'` (`:932`), and the user reads "a player with no NFL record" (`:950`). **So the property the old test claimed ("a failed layer never moves the verdict") was false on the old code for the one layer that matters, and the test was structurally blind to it.** The RED must throw the **career** source specifically. On the pushed head I will check that at least one of the 3 failing REDs is a throwing career source producing the user-visible text.

### R50.3 Conditions I will check on the pushed head
**(a) The safety half is kept at full strength.** A failed layer adds no data field and moves no ppg, value or score. I will diff the old and new assertions. Each must be the same strength or stronger, never loosened to a subset check.

**(b) "Never moves the verdict" must be split explicitly, or it contradicts the fix.** The fix exists to change the verdict **text** ("no NFL record" becomes unknown). So the preserved property can only be the verdict **decision and score**. If the new test asserts the verdict is unchanged including text, it contradicts the GREEN. If it asserts nothing about text, it is vacuous on the fix. Required: assert that a **thrown** career reads as unknown, and that a **null** career (rookie) **still** reads "a player with no NFL record". That pair is the split the fix claims.

**(c) Rename the test.** Its title currently names the forbidden behaviour.

**(d) The thrown layer reaches three user-visible surfaces. The fix covers all three, or says which it leaves and why:**
1. `describeProfile` (`:950`), through `headline_read` into `sideRisk`'s "trading X for Y" (`:996-1000`). This is the reported bug.
2. `packageNumbers` (`:985-986`): a package whose career layers all threw prints **"0 seasons on record"**. Same bug, second surface.
3. `packageRisk` (`:962`): the `withRecord = seasons > 0` filter **silently drops an unknown player** from the package's season, top-24 and top-12 sums. A package of a known 5-season player and a thrown one reads "5 seasons" as though complete. This one is quieter than the other two and should say "partial" where a layer threw.

**(e) Say what the cache does with a thrown layer.** `playerEvidence` memoises per player (`:896-908`), so a **transient** throw is cached with its "which layers threw" record until the cache passes 5,000 entries. The same stickiness existed before the fix, but it was invisible then. After the fix it is user-visible: "career unavailable" stays after the source has recovered. I recommend not caching a result that contains a thrown layer. Not blocking, but the PR body states the behaviour either way.

**(f) `check:wiring` on the pushed head** (R48).

The coordinator's instruction to put the test change under its own heading in the PR body is right. That heading should quote the old title and `:173`, and cite CLAUDE.md §2's swallow clause as the reason the test was wrong.

---

## R51: #106 kill-switch shape ACCEPTED; the 0.0003 is closed; the ladder is NOT reproducible by command, and I share the blame; call-graph prereg cleared with two additions

### R51.1 (1a) #106 graded-availability kill switch: ACCEPT the override-with-default-off shape. Do not take the harder one.
Checked on `refs/pull/106/head` (44944a94). `d4c6e49` is not pushed yet, so the final check is on its pushed head. **`gradedAvailabilityMultiplier` (`nfl-player-context.js:525`) has zero non-test callers.** Every hit outside the defining file is in `test/nfl-player-context-graded-availability.test.js`. So the switch protects nothing live today. It is a guard on the future call site: wiring the function must not turn it on. The shape Fantasy plan built does that.

**The harder shape (no override) is refused.** The three tests it would cost are the look-ahead guard, the retained-bucket ratio and the G1 invariant. They are the evidence that would later earn a default-on decision. Deleting evidence to make a switch purer inverts the priority. The kill-switch test is also non-vacuous in the right way: it proves the check runs **before** the bucket lookup, on a fixture that would otherwise resolve to a real retained ratio.

**Conditions, checked on the pushed head:**
1. **No non-test caller passes the override.** Pin it with a test that searches `server/` and `scripts/` for the override and fails on any hit. The override must also be the literal `{ enabled: true }`, never a value forwarded from a caller's options. A forwarded flag is a second switch nobody can see.
2. **Each of the three evidence tests names its opt-in** in its own title or first comment, so a reader knows it grades the logic that runs when enabled, not the default.
3. **Default-on happens in one place only:** the coupled grade's named call site (R47.2). That is also where §R19.6's as-of refit requirement binds. R19.6 binds default-on, not merge.
4. `check:wiring` on the pushed head (R48).

**What this does for #106's merge:** R40's rule applies. A default-off switch with a pinned default and zero live callers is not a behaviour change, so **the multiplier half no longer holds #106**. Whatever else is on #106 is judged on its own evidence.

An acceptable alternative, not required: split a pure `…Ratio` function (graded by the evidence tests) from the exported multiplier (kill switch first, returns 1.0 when off). It removes the argument from the function every caller uses. The bypass risk is about the same, so this is a matter of taste.

### R51.2 (1b) The 0.0003: CLOSED, and it exposes a naming hazard across the whole project
Fantasy plan answered it by check. −0.057211 is the exact full-sample MAE difference. +0.0569 was `pairedBootstrapDiff`'s `mean_diff` over 2,000 player-clustered resamples. Five seeds give 0.0569 / 0.0572 / 0.0567 / 0.0571 / 0.0573, straddling the exact value, and every CI excludes zero. Closed. My R47.3 principle ("a point estimate does not depend on the bootstrap seed") was right. My premise was wrong: +0.0569 was never a point estimate.

**The hazard behind it.** `backtest-significance.js:114`: `mean_diff` is the **mean over bootstrap iterations**, and the function (`:51, :118-119`) **does not return the full-sample difference at all**. So any figure anywhere in this project quoted as "the difference" off `mean_diff` is a bootstrap mean, seed-dependent in the 4th decimal. The name reads as the observed difference, and that invites exactly this 0.0003. Follow-up for that file's owner, not blocking anything: return an `observed_diff` beside `mean_diff`, and have records quote `observed_diff` as the point estimate. Until then, a figure taken from `mean_diff` says so.

### R51.3 (2a) The ladder. 183 is NOT a tree difference and NOT a filter Opportunity failed to find. It is not the output of the committed grader at all.
**Measured, not argued.** I fetched `b0c1616d` (write-tree **500bab36**, the ladder's own tree, now reachable as an ancestor of `origin/claude/project-thread-w45mur-inventory-contract`), installed the locked `typescript@5.9.3`, and ran the committed grader over the population:
- `git ls-files server/services server/modeling` gives **320**, minus `server/modeling/ARCHITECTURE.md` = **319 JS files**. **The population is reproducible by command.**
- `node scripts/reach-grade.mjs --json <those 319>` gives **wired 228**, wired-betting-only 55, wired-mlb-only 3, wired-offproduct-only 2, hand-run-script 10, unreached 21 (sum 319). Of the 228: **214** have a non-betting route among their entries, **14** have only scripts.
- **228 is the committed tool's figure.** It is the upper end of CONTRACT.md's "178–228". **14 is reproducible:** it equals the ladder's 14 developer-facing exactly.
- **116, 53, 67 and 183 do not come out of any committed command.** 116 is the "one standard" per-row confirmation partition (static request edges plus handler-callback edges), done by Opportunity in-session at 16:29Z/16:31Z (114/9, then R30's move of 7). That partition was never committed as a script. And `CONTRACT.md` at the remote tip (`605ab3f6`) still carries the superseded headline, not 183.

**Ruling:** the ladder is currently **not reproducible by command**. Only 319, 228 and 14 are. The rest are carried figures from a measurement on 500bab36 with no regenerating command. From now on every citation of 116, 53, 67 or 183 carries "500bab36, not reproducible by command" until the partition is committed as a script and re-run. The one that matters is **116**. Phase A leads with it, and it is the one a plan reads.

**My share of this, registered.** R33.1 says "Recount confirmed… Tool-produced on b0c1616d, tree 500bab36, commit carried", and I accepted it without running anything. The "three independent methods" in R30 converged on **the seven files that moved**. They cross-checked the move, not the 183 total. I carried a total whose only check covered a delta, which is the same gap the bespoke-tool rule was written to close. And I wrote that rule.

**One question the command would settle.** The PHASE-A bracket labels 183 "excluding what only a scheduled job reaches" and 250 "including it". But 183 = 116 + 67, and the 67 contains the 53 "reached only by a scheduled job". Either the two "job" notions differ (a package.json job script against the in-process scheduler that `SCHEDULER_DISABLED` stops), or a label is wrong. I am not asserting which. It is exactly the kind of question a committed command answers and prose cannot.

### R51.4 (2b) Opportunity's call-graph pre-registration: CLEARED to measure, with two additions made BEFORE measuring
The format is exemplary. The held-out 20 is drawn by seeded hash before the tool exists, with the hand answers written first. The 4-of-20 kill rule withholds any population figure rather than publishing one with a caveat. The deliberately falsifiable prediction (barrels will be the largest category) was chosen because it is the one most likely to be wrong. Indeterminates are their own count. The "will NOT establish" list is committed. Refusing to assert a filter for 183 was right, and R51.3 shows why: no filter exists.

**Addition 1: an import that is never called is not inert.** Importing a module **executes its top-level code**. This project's own precedent is `server/db/index.js`, which writes to the database at import (R21.2, and R49.2 today). The pre-registration's own sample includes `server/db/schema/nfl-n-to-z.js`. Required: (i) bare side-effect imports (`import 'F'`) are their own category and never count as `imported_never_called`; (ii) every file in `imported_never_called` is flagged if it has top-level statements other than declarations, so "never called" is not read as "does nothing". Add both now, before measuring.

**Addition 2: add a second population if the result is to speak to the ladder.** n = 289 (grader `wired` under `server/`, tree a0a6ed3d) is a legitimate population as stated. But the bracket's upper end is **228 over server/services + server/modeling**, and a discount on it needs the same population. Add a second reported population now: grader-`wired` files within `server/services` + `server/modeling` on the current tree, with the 500bab36 run's 228 as the reference. Otherwise the pre-registration must say the result cannot be read against the ladder at all.

**Why this unit matters more than it claims.** A one-level call-reach measurement is a **different mechanism** from the per-row confirmation that produced 116. Run over the same population, it is the independent cross-check 116 never had, and a committed command that can regenerate the one figure a plan reads. The pre-registration rightly promises not to restate the ladder. It is still the unit most likely to make the ladder reproducible.

### R51.3 addendum: what main says (origin/main f620a120)
The graders are on main now (#99, `c5ee3b54`). **No 183 appears anywhere in `docs/inventory/` on main.** `CONTRACT.md:126-135` still carries the 178–228 bracket and defines its ends: "**178 = request reach only**" and "**228 = request + job reach**". So the question in R51.3 is sharper than I put it, and it is now a citable conflict. **The PHASE-A bracket gives 250 as "including what only a scheduled job reaches"; main's CONTRACT.md:134 gives 228 for the same definition.** Separately, main's generated `INVENTORY.md:87` has a **250** that counts inventory **rows of kind `pipeline`**, a different population from 319 files. Whatever the bracket's 250 is, it must name the command that produced it, so nobody can read it as that one. Under the two-job-notions reading (package.json job scripts counted inside 183, the in-process scheduler outside it), 228 − 183 = 45 would be the scheduler-only files. That is a hypothesis. Its test is one command.

---

## R52: Wiring map's reversed assertion (pre-push); the citation rule: YES, with the squash hole closed

### R52.1 (1) `test/wiring-map.test.js` reversed pinned assertion: legitimate IN PRINCIPLE, final on the pushed head (ae84ac6d)
It is the same shape as R50. The test pinned "an unrecognised receiver resolves to the app", the fallthrough that turned main red. Its own preamble, three paragraphs earlier, warned against exactly that. **A test that pins a defect its own preamble names is wrong by CLAUDE.md §2's "unless the test is wrong."** Checks on the pushed head:
- **(a) Fails for the right reason:** reproduce main's red with the old assertion first, then show the RED failing on it.
- **(b) The split, which is the part most likely to go wrong.** Reversing "resolves to the app" to "does not resolve to the app" trades a false positive for a **silent false negative**: a real route on an unrecognised receiver would disappear from the map without a word. That breaks §2's rule that an inert layer must say so. An unrecognised receiver must resolve to an explicit **unresolved/unknown** state that the gate **reports** (count plus list), never to "the app" and never to silence. The test pins both halves: not the app, and reported.
- **(c)** Rename the test if its title names the old behaviour.
- **(d)** The safety half survives at full strength: recognised receivers resolve exactly as before, and I diff the old assertions against the new.
- **(e)** `check:wiring` on the pushed head, and main goes green with it on the merged tree (GitHub's pull_request build is merge(head, base), so CI on the PR is that check).

### R52.2 (2) Fleet citation rule: YES. Subject first, sha second. The rule as proposed does not survive a SQUASH, so two additions.
Opportunity's find is real: #116's evidence cites RED `b885db2b`, which two rebases orphaned. Subject-first citation plus a reachability check on the reviewed head is right, and I adopt it. **But this repository merges by squash** (`origin/main` is one commit per PR: `f620a120 … (#119)`, `92654e20 … (#117)`, …). **After a squash merge, every RED and GREEN sha is unreachable from main**, however carefully it was cited. A subject survives a rebase. Nothing on main survives a squash. So:
1. **Cite the PR number with the pair:** `#N`, subject, sha. GitHub keeps `refs/pull/N/head`, so the pair stays fetchable after the branch is deleted (`git fetch origin pull/N/head`). That is how I fetched #106 today.
2. **The evidence file carries the RED's failing output inline:** the failing assertion's message, not only "3 of 6 fail". The RED's content is the evidence. If the commit becomes unreachable, the failure text is still in the file main keeps.
3. **Reachability check (Evidence Auditor, and me in my gates):** `git merge-base --is-ancestor <RED> <reviewed head>` and the same for GREEN, before merge. After a rebase, the evidence file's shas are updated **in the same push that rewrote them**. That push is when they rot.

**Existing evidence files on open PRs:** fix **before merge** only where a cited sha is **unreachable from the PR head**. That is a broken citation and fails the evidence check (#116 is one). Where the shas are still reachable, fix when next touched. **Merged files: leave them.** They are historical, and their pairs are recoverable through `refs/pull/N/head` once the PR number is known. No mass rewrite.

### R52.3 Noted
- **GitHub builds merge(head, base) on pull_request:** consistent with R48. CI on an open PR already exercises main's wiring gate against that branch.
- **Nick's MLB removal (Scheduler, no table drops):** it changes the ladder's population. `reach-grade.mjs` grades 3 files `wired-mlb-only` on 500bab36, and CONTRACT.md's bracket carries an mlb column. One more reason R51.3's command is needed before any ladder figure is quoted after the removal lands.
- **Planner's withdrawal of the route splits** on its own §4d evidence (nflsavant a strict subset of nflverse participation): noted, correct to withdraw.

---

## R53: Wiring map provisionally PASSES all five checks. Explorer's optional-sources package is ACCEPTED on mechanism, but it is on a pre-#119 tree, and #119 put a false promise on main in exactly its case.

### R53.1 Wiring map (head 6432a76, NOT YET PUSHED; `git fetch origin 6432a76…` says "not our ref")
The answers meet all five R52.1 checks as reported. **The best of them is (b), fixed before pushing and against the author's own earlier fix:** filing a handed-in handle as context would have hidden a real app table read through a parameter. `unresolvedReceivers` now reports count plus full list on every run (19 sites), and both halves are pinned in one test. (a) is the gate exit 1 reproduced on clean 144b722, with the RED verified by stashing the implementation and its message inline, which is R52.2's form. (c) is the rename. (d) is one assertion changed with the old text quoted in place. (e) is `check:wiring` 0 on f620a120 plus branch. **Final ruling on the pushed head.** Two notes, neither blocking:
- **Citation numbering:** "#1 4bab4fd RED, #2 a997747 GREEN…" uses `#k` as list indices. In R52.2's form, `#N` is the **PR number**, and in this repository `#1`–`#4` are real PRs. Use the PR number, and never `#k` for a list position. The rule is new, and this is its first use, so set it right here.
- **Report-never-gate is legitimate** and satisfies §2's "the surface must say so". But a list printed on every CI run is read by nobody within a week. Recommended follow-up: a **ratchet**. Record the 19 as a baseline and fail the gate only when the unresolved count **grows**, so a new unrecognised receiver is loud and the existing 19 are not noise.

### R53.2 Explorer's optional-sources package: mechanism ACCEPTED. Four corrections before any of it reaches Nick.
**Verified on 654ff93, and re-verified on main f620a120**, where the gate is unchanged at `:222/:227` and the optional ingests sit inside it at `:230-237`. The chain holds: the only timed path passes no `force` (`scheduler.js:1021-1022`), `coreLag` is quantified over `required` only, and snaps, NGS and PFR ingest only inside `force || coreLag`. **Taxonomy line accepted,** with one placement ruling at R53.3.

**Correction 1: the headline and the sentence for Nick overstate. Fix them before they reach him.** "Five data feeds can go stale **forever**" contradicts the package's own §2: depth and injuries have a second writer (`scheduler.js:829-831`, `:1166-1167`) and are only partly exposed. And "forever" ignores that every newly finalized week makes the three required pbp/usage sources lag until ingested, which re-opens the gate and refreshes the optional group as a side effect. `results_and_lines` is current by definition (`:77`: its `through_week` is `finalizedWeek`). Accurate form: *three feeds (snap counts, Next Gen Stats, PFR charting) refresh only when a core feed is behind; two more have a second path. Between weekly updates, or when one of those three fails while the core feeds succeed, they fall behind and nothing reports it.*

**Correction 2: name the two real sub-mechanisms, because they predict different gaps.** In-season, the gate re-opens roughly weekly. So the exposure is not steady-state abandonment. It is:
- **(i) Late-publishing upstream.** If an optional feed's upstream publishes after the required ones, the gate opens while it is unpublished and closes before it lands. **Signature: a persistent gap of about one week.**
- **(ii) Failed optional ingest, never retried.** `attempt()` records the error. The required sources succeed, so the next cycle has `coreLag` false and skips the retry until the next week. **Signature: a multi-week gap, with the error visible in `nfl_model_growth_runs.detail_json`.**
**Required pre-registration addition:** predict which signature the FRESHNESS block will show, and have the read also print the latest run's `detail_json.ingestion` for the optional steps. The gap size says which sub-mechanism is biting. Without that, a gap reads the same whichever one caused it.

**Correction 3: the brake is an unlisted confound.** `SCHEDULER_DISABLED=1` is on in production, so **nothing** has run on a timer since the brake went on. Required and optional tables are both frozen at that moment. The FRESHNESS comparison is still valid, but only **as of the last run**, not as of today. Anchor it on the last `nfl_model_growth_runs.finished_at` and compare the groups there. A gap measured to today mostly measures the brake. **Also:** production runs the **deployed** image, not 654ff93 or main. Name the deployed commit and show the gating lines unchanged between it and the tree cited. It is one `git log -L`.

**Correction 4: §1d is partly superseded on main, and in its place is a new defect.** #119 (`f620a120`, merged today) added `cycleOutcome()`. A failed download, **optional or required**, now reports `ingest_error` with the step names. So a *failed* optional ingest is no longer silent in the run record. Its un-attempted *lag* still is, and `nflModelGrowthStatus`'s `state` still ignores optional sources. **But #119's note says, for every failed step: "The scheduler retries it on the next cycle."** That is **true for a required-source failure**: the source stays behind, so `coreLag` re-opens the gate. It is **false for an optional-source failure** whenever the required sources are current on the next tick, which is exactly sub-mechanism (ii). **A merged PR's user-facing status now promises a retry the code does not perform, in the one case Explorer's package is about.** Route with the fix. Explorer's own-staleness trigger makes the promise true. Until it lands, the note is made conditional on the failed step being required, or it stops promising.

**Rest of the pre-registration: CLEARED** once the Correction 2 prediction and the Correction 3 anchor are added. (c) and (d) are honestly stated ("held-out: none, and none is claimed"; "no incumbent, not inventing one"). The registered weakness on depth/injuries ("if they DO show the gap, my reading is wrong and I will say so") is a real falsifier.

**On the fix shape the coordinator is routing:** agreed. Own staleness trigger and reported status, **not** `required: true`, which would let a late optional release block the whole cycle. One scope line for its PR body: the module's only manual entry is a betting route (`routes/nfl-betting.js:231`), but it is the **only scheduled writer of snaps, NGS and PFR, which fantasy reads** (`nfl-availability.js`, `role-changepoint.js` via `player_week_snaps`). So the fix is fantasy-pipeline freshness and does not trip Nick's scope rule.

### R53.3 Taxonomy placement: a WRITE-side axis, not a fourth reach class
The three reach classes describe a **reader's** path: not reachable; reachable with data absent; reachable with data present and the predicate dead. "Runs only for a reason unrelated to itself" describes a **writer's trigger**, so it goes on its own axis: **own trigger / piggyback trigger / hand-run only / none**. The axes compose. A table can be reach-class 2 (reachable, data absent) **because** its writer is piggyback or hand-run only. `collect-league-transactions.mjs` is this session's hand-run-only instance. Keeping the axes separate lets one row carry both facts without choosing between them.

---

## R54: The bracket's lower end IS reproducible from the committed grader, as 172, and main's CONTRACT.md prints a column total that is false by 6. Partition prereg cleared with six conditions. Guard RED: fixture form required. Explorer's correction accepted, and it corrects me twice. Naming rule: YES.

### R54.1 Measured: request-only reach on 500bab36, using only the grader's own exported functions
Scratch check (not repo code) on `b0c1616d`, write-tree **500bab36**. `repoGraph` supplies files, entries and hand-run. The importer graph is built from `classifyImportEdges(...).request` alone (module-scope imports, `reach-grade.mjs:108-125`), then `dropRouteBootEdges`, `reachableEntries` and `gradeReach`, all unchanged. Edge counts: request 2,905, deferred 218.

| grade | request only (command) | CONTRACT.md:160-166 "request reach only" | request + job (command) | CONTRACT.md |
|---|---:|---:|---:|---:|
| wired | **172** | **178** | 228 | 228 |
| wired-betting-only | 65 | 65 | 55 | 55 |
| wired-mlb-only | 6 | 6 | 3 | 3 |
| wired-offproduct-only | 18 | 18 | 2 | 2 |
| hand-run-script | 11 | 11 | 10 | 10 |
| unreached | 47 | 47 | 21 | 21 |
| **total** | **319** | printed **319**, actual **325** | 319 | 319 |

- **The bracket is reproducible by command** with the committed functions. It is an **edge-mechanism** split, request (module scope) against request plus deferred (inside a function body), exactly as `reach-grade.mjs:108-125` defines it ("the mechanism is in the syntax").
- **Every cell matches except one.** The published lower `wired` is 178. The command gives **172**, which is the third value in CONTRACT.md's own revision sequence (`:140`, "205 → 196 → 172 → 178").
- **The published column does not sum.** 178 + 65 + 6 + 18 + 11 + 47 = **325**, printed as 319. The last +6 went into `wired` without leaving any other cell. **main's canonical inventory contract prints an arithmetically false total.** The doc fix goes to the file's owner with the command attached: 172, or 178 with the six named and the column that gives them up.
- The CLI (`reach-grade.mjs:346-362`) builds its graph with `buildImporterGraph`, which combines both edge kinds, and never calls `classifyImportEdges`. That is why only the upper end ever came out of a command.
- **R51.3 amended:** "not reproducible by command" stands for 116, 53, 67 and 183, and for 178. The **edge bracket is reproducible as 172–228.** My R51.3 two-job-notions question is answered: both notions exist, and CONTRACT.md's "job reach" is the deferred-import one (the in-process scheduler), not package.json scripts.

### R54.2 Opportunity's partition-script pre-registration: CLEARED to build, with six conditions
The commitments are right: the falsification target, no predicted partition, no hand list inside a script, and 250-vs-228 as a category error (rows against files, with the row-to-file mapping named as the missing artefact). All adopted. Conditions:
1. **Falsify on the right commit.** 500bab36 is the tree of **`b0c1616d`**, an **ancestor** of `refs/pull/99/head`. The tip, `605ab3f6`, has tree **`1da962d3`**, not 500bab36. Run on the tip and the falsification fails for the wrong reason. Check out `b0c1616d`, and print `git write-tree` to prove it.
2. **The prereg's (b) mixes two orthogonal axes.** The bracket is **edge mechanism** (R54.1). The prereg's partitions (2)–(3) are **entry type** (mounted route against package.json script, and scheduler-invoked scripts). The script outputs **both, under separate names**, with the edge bracket **first**, because that is what CONTRACT.md publishes. The entry-type split must never be presented as "the bracket".
3. **Commitment (3)'s "scheduler-invoked package.json script" is a third notion.** It is legitimate, but it is not CONTRACT.md's job reach. Name it as its own row. The one-number fallback applies to it as written.
4. **Disclosure, to freeze the definition.** On the combined graph at 500bab36, my quick entry-type split gives **214** of 228 with a non-betting route entry and **14** script-only. It is approximate, because I excluded betting entries but not MLB or off-product. The definition in (2) is now frozen, and any change after this is a new pre-registration. **214 is import reach running through `scheduler.js` as a hub.** The grader's own paths show `scheduler.js` imported by `gamescript.js` and `nfl-espn-line-watch.js`. It is **not** a correction to the call-reach 116, and must not be read as "116 was wrong".
5. **Print the toolchain:** node and typescript versions. The grader requires `typescript` (locked 5.9.3), so the script fails loudly without it rather than emitting nothing.
6. **The script outputs both ends of the edge bracket per cell, with the sum**, so a column that fails to add up cannot be published again.

### R54.3 Fantasy plan's guard test: the committed-FIXTURE form is required; the working-tree demonstration is supplementary
Committing a production violation to get a RED is refused. It would put the very override the guard exists to prevent into production history. But a working-tree violation "introduced and removed" is **not reproducible by anyone else**, which is the R51.3 defect in miniature. Required shape: the scanner is a function over `{ path, source }` records. Its detection is pinned by **committed inline-string cases** that must each be flagged, and a second test pins that the real tree scans clean. Cases that must be flagged:
- a sixth argument in a `server/` file;
- a forwarded flag (`{ enabled: opts.x }`);
- an **aliased import** (`import { gradedAvailabilityMultiplier as gam }` … `gam(…, {enabled:true})`);
- a **namespace call** (`import * as ctx` … `ctx.gradedAvailabilityMultiplier(…)`);
- a destructured **dynamic import**.

The alias and namespace cases are not hypothetical. **This project's own reach tooling had a namespace-import blind spot (R33)**, and a balanced-paren parse keyed on the bare name misses both. The sanity assertions (file count, exactly one declaration) stay, because they guard against a vacuous scan. The working-tree demonstration may be quoted in the evidence file as extra, labelled as such.

### R54.4 Explorer's self-correction: ACCEPTED, and it corrects two things in my R53.2
- **My sentence for Nick is wrong.** It is **four** tables at full force (`nfl_snaps`, `nfl_ngs`, `nfl_pfr_adv`, `nfl_depth`), and only `nfl_injuries` has a second writer (`scheduler.js:829-831`). `scheduler.js:1164-1167` writes `roster_players.depth_slot/depth_order` through `routes/nfldata.js:217`, never `nfl_depth`, and that timer was withheld at `:1156-1162` on OOM grounds.
- **My scope line is WITHDRAWN.** I cited `role-changepoint.js` "via `player_week_snaps`" as a fantasy reader of this module's output. `player_week_snaps` is a **different, separately scheduled** table (`scheduler.js:1150-1153`). **The scope question is now OPEN.** The remaining readers are `nfl-availability.js:197-200` (`nfl_snaps`), `:103-105` (`nfl_pfr_adv`) and `nfl-advanced.js:487-572`. The grader reaches them **only through `scheduler.js` as an import hub**, and import reach cannot show that a fantasy route calls those reads. The earlier finding (memory: table-reach taxonomy) was that `nfl_snaps` serves the betting and team-card sides, not the fantasy weekly projection. **The fix is not established as fantasy work.** It needs a call-reach trace from those readers to a fantasy route before it is built. If there is none, Nick's scope rule applies.
- **`nfl_depth` "predicted TO gap" cannot be tested as a gap: production holds 0 rows** (Nick's 17:03Z screenshot). An empty table has no week to lag. **Pre-register the EMPTY outcome separately:** 0 rows means the writer has never succeeded. Distinguish never-attempted from attempted-and-failed with `detail_json.ingestion.depth_charts` across runs. The OOM withholding at `:1156-1162` makes attempted-and-failed plausible on the piggyback path too.
- The `player_week_snaps` **control** is exactly the right addition. The two-tables-one-CSV finding (different keys, defensive and special-teams snap share only in the unscheduled table) is accepted as its own item.

### R54.5 "Name the table, never the concept": YES, extended to functions
Adopted, and I am its most recent violator. R53.2 said "snaps" and "depth" as concepts, and that is how a `player_week_snaps` reader became a scope argument for `nfl_snaps`. **Extension:** name the **function** as well as the table. The near-homonym pairs include functions (`syncSnaps`/`syncSnapCounts`, `syncDepthCharts`/`syncDepthChart`). Every package and PR body names the table and the writer function verbatim, with the writer's `file:line`.

---

## R55: Contradiction-test rule adopted. One objection: the fourth instance is misplaced, and as written it impugns the committed grader, which it does not affect.

**Rule (Opportunity): ADOPTED**, beside the bespoke-tool cross-check rule. A zero, an empty set or a success from a bespoke check earns one contradiction test, a known-nonzero case, before it is believed. The four instances share one shape: a plausible falsy value where a raise belonged.

**Objection, factual.** The fourth instance is recorded as "`.size` on a non-Map in `reachableEntries` at `reach-grade.mjs:299`, dropping every non-entry importer". **That does not reproduce in the committed grader.** On `b0c1616d`, `reachableEntries` (`:267-300`) accepts both a Map and a plain object (`:270`, `importers instanceof Map ? importers.get(node) : importers[node]`), and `:299` is `visitedCount: seen.size` on a `Set`. `git diff b0c1616d origin/main -- scripts/reach-grade.mjs` is **empty**, so main has the same function. **The contradiction test, run on my own R51.3/R54.1 output:** a grader that dropped every non-entry importer could produce no path longer than one hop. My 500bab36 run's paths reach **9 hops**, and 4,212 of them are longer than one hop. **So R51.3 and R54.1 stand, and the committed grader is not affected.** The defect was real somewhere, most likely in a new consumer on Opportunity's working tree calling `.size` on the plain-object importer map. **Record it by the file and commit where it actually lives.** As written, it reads as a bug in the grader that every inventory figure rests on.

**Trade Brain's audit (198 of 324 cited commits unreachable from main, 61%):** noted. It is consistent with R52.2's merged-files caveat, and no mass rewrite follows. #100's re-measured pairs are noted.

---

## R56: charting/team-week pre-registration. 059 over 070: YES. Pre-registration HELD on three blocking items, the first of which is scope.

### R56.1 059 vs 070: 059, and 070 enters as a validity crosswalk, never as training rows
Planner's §0 is right, and it is the discipline registered this afternoon applied before fitting rather than after: a feature fit on 2016-2025 participation cannot serve a 2026 week. That is the fit/serve mismatch designed in. **Build on 059.** One condition closes the hole that "070 only as held-out history" leaves open. **FTN charting and nflverse participation are two different sources for "pressure".** `ingestCharting` fetches `ftn_charting/ftn_charting_${season}.csv` (`nfl-formations.js:103-107`); `ingestFormations` fetches `pbp_participation_${season}.csv` (`:89`). If 070 rows extend the 059 feature's training window backward, the feature is fit on one source and served on another, and that is the same mismatch renamed. Therefore:
- The 059 feature is **fit only on seasons where FTN charting exists**. The pre-registration states the first such season by command, not from memory.
- 070 may enter **only** as a crosswalk. On the overlapping seasons, does FTN pressure agree with participation pressure, and by how much? That is a validity check on the served source. It never contributes training rows.
- If FTN starts late, the fit window is short. State it and let the gate-1 power check decide. Do not pad the window with the other source.

### R56.2 BLOCKING 1: name the target, and name the consumer. On the record, the consumer is betting.
§1 claims "lowers held-out error" on "the team-week target", and the target is never named. An error reduction is unevaluable without one. The readers matter here.
- `nfl_team_week_features` is read for **prediction** by the game model: `nfl-data-consistency.js:188` labels it `modelUse: 'core game prediction'`; `nfl-auto-picks.js:248, :318`; `routes/nfl-betting.js:457, :1202, :1224, :1604`; `routes/nfl-market.js:68`.
- Its fantasy-side readers are **descriptive**: `nfl-team-tendencies.js` (X's & O's percentiles) and `football-context.js:187`.
- **The fantasy weekly projection does not read it.** Per this session's earlier path finding, the projection path reads `player_week_usage` joined to `players`, plus `nfl_qbr_weekly`.
- So "lower held-out error on a team-week outcome" lands, as things stand, **in the betting game model**. Nick's scope rule then applies, and I do not decide scope.

**Required:** name (i) a **fantasy target** (for example team pass attempts, or opponent-adjusted QB fantasy points), (ii) the **fantasy call site** that will consume the aggregates, and (iii) a **call-reach** path from a fantasy route to that site. Import reach is not enough; R54.4 showed it running through `scheduler.js` as a hub. If no fantasy consumer exists yet, the unit is a wiring job plus a feature, and **the named call site binds the build** (the R47.2 condition). If the only consumer is the game model, the unit is not built.

### R56.3 BLOCKING 2: "fixed here" fixes nothing without the values
§3 says the aggregation choice (rate vs count) and the minimum charted-plays threshold are "fixed **here**, before any result is seen". **No values are written.** A pre-registration that says it fixes a choice and does not state it has pre-registered nothing, and leaves the choice free after the numbers arrive. Write the values: rate or count per aggregate, the threshold N, and what happens to a team-week below N (dropped, imputed, or flagged).

### R56.4 BLOCKING 3: the incumbent is given as two different counts
§2 and §4 name the incumbent as "the **91** play-by-play features" (suffixes at `nfl-pbp.js:447-559`) and as "the **183** features `nfl-team-tendencies.js:5` describes". Those are not the same set. (183 is also, coincidentally, this afternoon's withdrawn inventory figure, which is one more reason not to leave it bare.) The incumbent is defined by **a command that lists the feature keys** the baseline model is fit on. It prints the count and the key list, so the bar is one set and not two numbers.

### R56.5 Non-blocking corrections
- **Clustering:** "team-clustered where it is a team-week" is **no clustering**. The team-week is the unit of observation, and resampling it is an iid bootstrap. Cluster on **team-season**, because weeks within a team-season are autocorrelated. That is the dependence the interval has to carry.
- **Gate 1** is stated as an **oracle** check, which is the R21.3 requirement to say which kind. Accepted.
- **Production caveat §5:** right, and it goes into READ-B's **pristine** census (R49.2) as a raw read-only `COUNT(*)`, `MIN/MAX(season)` of `nfl_play_charting`, so "empty" cannot be a migration artefact.
- Planner's line and count corrections (`:563` / `:564`, 91 suffixes at `:447-559`, six single-consumer 059 columns) are accepted under the tree-carrying rule. `drop_` needs a column-name match, not a substring grep. That is minor.
- §6's refusal of the Sharp Football source on licence: noted and correct.

---

## R57: #121 revised (head 57c21a0f, tree 7662cbbd). Configuration B CLEARED. Units CLEARED, and better than I asked. Goes back ONCE: the call site is still not named, and arm (b) does not say where its observation sits. The QBR strike's stated reason is wrong.
Read on `origin/claude/project-thread-w0gpjt` @ 57c21a0f.

### R57.1 BLOCKING 1 (configuration B): CLEARED, and the declaration is the right shape
§2c (`:122-145`) declares it in words: `roleRecency: WEEKLY_ROLE_RECENCY` passed **explicitly** at every `buildProjections` call in every arm, and **`kOverride` omitted**, so `activeKVectorFor` supplies the fitted vector. It is backed by a wiring control that runs before the arms. The control asserts that the `target_share`/`ALL` k in the path equals the declared fitted k, identical across arms, and it **stops the grade** if it reads `K.share = 6`. §2b's self-correction is exactly what this control is for, and the author found it: the previous unit's `kOverride: null` forced the hardcoded constant, so its figures never ran on the fitted k.

### R57.2 BLOCKING 2 (units): CLEARED as option (ii). The author's reason beats my recommendation.
I recommended converting the MDE to points. The document takes targets per game as primary instead, and says why: a points-per-target conversion is itself an estimate, varies by position, and runs through catch rate, yards per target and touchdown rate, none of which this change touches. That is **the scale-through-an-assumption error this series has already withdrawn a figure for**, and the previous unit's write-up refuses the conversion in terms. The author is right and I was wrong to recommend (i). What makes (ii) sound:
- the 0.0220 SE is stated as measured on the **same** availability-inclusive targets-per-game metric the MDE is in;
- `decision_including_dnp` is declared **co-primary** with its **power declared unknown**, and a null in it may not be read as no effect;
- **a sign disagreement between the two holds the unit**;
- the conditional metric is barred from deciding;
- the clusters needed (~180 of ~294) are stated.

### R57.3 GOES BACK ONCE: three items, text only
**(1) The call site is not named, so the binding sentence binds to nothing.** `:341` says the implementing PR wires the multiplier "at exactly the site named here". `:30` says the pre-registration "must specify the site rather than describe one". **No file:line appears anywhere in the document.** `:317` says "the site this unit specifies"; `:339` says "arm (b) specifies one". Required: the **file:line on a stated tree** where arm (b) applies the multiplier, and **what it multiplies**. The candidates differ in effect: the shrunk share after `projections.js:599`, the projected targets after the team-volume multiply at `:605`, or the fantasy points. Choosing among them is the author's call. Naming one is required.

**(2) The call site must declare its `decisionAt`.** The serve side is as-of: `valueAsKnown(entity, 'injury_report', decisionAt)` (`nfl-player-context.js:528`). In a replay, `decisionAt` must be each week's **pre-kickoff decision time**. Anything later (now, the week's end, or `undefined` if that defaults to the latest revision) is look-ahead on exactly the quantity being graded. State the timestamp rule at the site, and add one control: a player whose report was revised after kickoff gets the pre-kickoff value.

**(3) Arm (b) must say where its OBSERVATION sits, or it re-creates the mismatch it exists to fix.** The arms table specifies the **prior's** support ("zeros excluded") and the multiplier. It never specifies the **observation's**. The observation `a.tgtShare / a.tgtShareW` (`projections.js:515`) **includes** zero-target weeks. §3 reason 2 says observation and prior "**can** both be moved to the conditional support". *Can* is not *are*. If arm (b) moves only the prior, it shrinks a zero-including observation toward a zero-excluding prior under a zero-excluding `k`. That is still the three-support mismatch of R39, now with a multiplier on top that prices availability a second time. Required: **one row per arm for observation support**, with arm (b) explicitly on the conditional support if that is the hypothesis.

When these three are fixed, the pre-registration is cleared and the held three-support confirming check may run. The rest of it is the best pre-registration this series has produced: a rejectable alternative arm, controls that void the primary, and a decision rule that bars the correctness argument from overriding a null.

### R57.4 The QBR strike (`projections.js:275-298`): the conclusion is right, the stated reason is wrong. Correct it before merge.
The strike says the verdict is withdrawn because "4.749 against 4.751 is a **season-long MAE difference** … a season-long aggregate can average a real weekly effect away against itself". That is not the defect, and as a reason it is false. The pair is MAE over **player-weeks** pooled across a season, which is a weekly metric. Pooling nets weeks the signal helps against weeks it hurts, and **that net is the signal's weekly effect**, not a distortion of it. **The actual defect (R42.1):** the pair was produced by `scripts/verify-qbr-integration.mjs:12-13`, which calls `replaySeasonWeekly` **without `roleRecency`**. That is the season-long **configuration** (`RECENCY` 0.35/null, fitted volume k withheld by `activeKVectorFor`), while the app serves `WEEKLY_ROLE_RECENCY` (`player-week-engine.js:271-273`). "Season-long" in R42.1 named a **configuration**, not an aggregation. The text has turned one into the other. The rest of the strike (numbers left visible, UNJUDGED, not a reversal, a re-run is a new gate, the 2026-09-17 warning independent) is exactly right. **Replace only the reason.** A strike that gives a false reason is a comment asserting something the code does not do, which is the defect this session has found in a dozen places today.

### R57.5 Noted
`check:wiring` exit 1 on main's three pre-existing items: pre-existing on the base, and it clears when Wiring map's fix lands. R52.2 does not bite, since this is a pre-registration plus a strike, with no TDD pair. The R51.2 correction applied to the result file (+0.1269 observed, +0.1273 marked as `mean_diff`) is accepted.

## R58: coordinator 18:50Z. (1) #121: R47(B) CLEARED, as ruled in R57.1; R57.3 stands. (2) #130 @ ea03d88: R50 (a), (b), (c) and (e) CLEARED, and the three surfaces I named are fixed. HELD on one false sentence: a FOURTH surface exists, the trade card's Floor cell, and my R50(d) list missed it.
Read on `origin/claude/project-thread-5f9c3y-evidence-fault-not-no-record` @ ea03d88 (tree 33223b3c), base f620a120. Worktree `$S/wt-130`, `npm ci` exit 0.

### R58.1 #121: R47(B) CLEARED. Nothing in Model evidence audit's report changes R57.
Model evidence audit's line citations (§2c:133-138 declaration, :140-147 k control, §5:341-344 binding) are the same text I cleared at R57.1 (`:122-145`). **R47(B) configuration B: CLEARED.** The binding sentence is **present**, as the coordinator asked me to confirm. It binds to "the site named here", but no site is named anywhere in the document: `grep -n 'site'` on 57c21a0f finds :30, :309, :317, :325, :339-343, :366, and none of them gives a file:line. R57.3 stands unchanged: it goes back once on three text items (name the call site and what it multiplies; declare the pre-kickoff `decisionAt` with a revised-after-kickoff control; give one observation-support row per arm). R57.4, the QBR strike's reason, is still owed before merge.

### R58.2 #130 runs as claimed. Each commit ran on my checkout (`node --test test/trade-evidence.test.js test/trade-engine-evidence-fault.test.js`)
| commit | subject | result |
|---|---|---|
| 1c0b93f5 | RED: a failed career-evidence read is stated as "no NFL record" | fails: `expected: 'unproven' actual: 'unproven'` (notEqual), `expected: 'unknown' actual: 'unproven'` |
| bcd6fb21 | GREEN: a career layer that could not be read says so… | 12 pass / 0 fail |
| 6a669e90 | RED: a partly unreadable package reports the readable half as the whole | 1 fail, `actual: 'give: 5/5 top-24 seasons, ±5% swing, 17 g min · get: 5/5 top-24 seasons, …'`, which is the defect verbatim |
| 7f01d69f | GREEN: the evidence line says how much of a package it could read | 19 / 0 |
| ea03d88 | head | 19 / 0 |
**Head tests against the unfixed engine** (f620a120's `trade-engine.js` swapped in): 11 fail, including all three end-to-end tests (13, 14, 15). So the cache-bust fix did make them live. All five cited shas are ancestors of ea03d88 (`merge-base --is-ancestor`), and the RED output is inline in the evidence file (:60). **R52.2 CLEARED.** Cite as #130.

### R58.3 The cache-fingerprint find: CONFIRMED, and it does not reach back to main
`tradeIdeasFingerprint` (`trade-engine.js:1478`) stamps `manager_profiles` on COUNT and `MAX(updated_at)` (`compute-cache.js:48-68`). An upsert that sets only `tradeability` on an existing row moves neither. **Probe on main f620a120:** I added `assert.notEqual(without, withEv)` to the pre-existing offseason-invariance test. It **passes**: in that test the upsert is the first write for roster 6, so it INSERTs and moves COUNT. **So main's guard was live, and the defect bit only on the second and later reuse of the idiom**, which is exactly where the new tests put it. The fix (strictly newer `updated_at` on one row, plus reference inequality) is right. **Non-blocking:** the offseason test on the head now relies on the helper alone. Add the same one-line `notEqual`, since, in the author's own words, it is "the one check that cannot be satisfied by the fix". (The same probe passes on ea03d88, so the test is live today.)

### R58.4 R50 conditions
- **(a) Safety half: CLEARED, stronger.** A **thrown** career gives `deepEqual` on ppg/value/score/verdict against the null-source baseline, no `career`/`preseason`/`offseason` field on any player, and the fault recorded, with a non-empty guard on the deals. The old degrade test's `deepEqual(…, {})` becomes `deepEqual(…, { evidence_unreadable: ['preseason'] })` plus field-absence. That is an exact equality, not a subset.
- **(b) Split: CLEARED.** The pair test asserts thrown→`unknown`/"could not be read" and null→`unproven`/"a player with no NFL record" in one test, plus `notEqual` between the two.
- **(c) Renamed: CLEARED** ("…a throwing source is recorded…").
- **(e) Cache: ACCEPTED as stated.** The reason (an unbounded re-invocation on the failure path inside `evaluate()`) is a real cost, and "its own measurement" is the right venue. For the record, `findTrades`' own cache holds the faulted deals on the same data-change trigger, so the stickiness sits one layer deeper than the evidence file says. That is one sentence, not a condition.

### R58.5 (d) HELD: a fourth surface, and the miss is mine
The evidence file says (`docs/tdd/…evidence-fault-not-no-record.tdd.md:120`) "**Nothing is left uncovered.**" That is false. It is false because it faithfully took my R50(d) list, and **my list was server-only**. The client renders the same `packageRisk` object:
- `deal.me.risk = sideRisk(givesOut, getsIn)` (`trade-engine.js:1125`) → `<RiskStrip risk={…} />` (`client/src/components/TradeCard.tsx:138`, `:280`).
- `RiskStrip.tsx:5-6` `floorOf`: `r.seasons ? \`${top24_seasons}/${seasons} top-24\` : 'no record'`. **A side whose career layers all threw reads "no record"** on the trade card's Floor cell. The strip renders whenever the other side has a record (`:17`). This is the reported bug, on a surface #130 does not touch. **For a mixed package it prints the readable half as the whole** ("5/5 top-24" for one of two), which is the 6a669e90 defect, surviving in the UI. Neither case is a regression: the UI reads the same as it does today.
- `:31-32` `floorBetter` colours the Floor comparison green or red from those partial sums.
- `types.ts:41` has a profile union without `'unknown'`, and `PackageRisk` (`:44-50`) has no `unreadable`, so the client cannot see the fix.
**Finding:** the sentence is false and the Floor cell still states the defect. **Remedy (a separate ruling):** (i) **preferred**, if the coordinator's file allocation permits: extend #130 to `floorOf` (show the shortfall or "could not be read" from `r.unreadable`), suppress the `floorBetter` colour when either side has `unreadable > 0`, and add `unreadable` / `'unknown'` to the types. Pin it in the repo's client idiom (`test/trade-manager-read.test.js:42` reads component source), with a RED first. (ii) Otherwise, replace "Nothing is left uncovered" with the Floor cell named as open, and open a UI unit for it before #130 merges. **Either way, #130 does not merge while that sentence stands.** Nothing else holds it.

### R58.6 One text fix (non-blocking, rides the next push)
`trade-engine-evidence-fault.test.js`, in the "marks the unreadable case as unknown" test: the comment says "The numbers stay null rather than reading as measured zeros". The next two lines assert `seasons === 0` and `top24 === 0`. The comment contradicts its own assertions, and those zeros are exactly what `floorOf` reads as "no record". Correct the comment. Making them `null` is the author's call, and it would change `withRecord`/RiskStrip reads, so it would need its own RED.

## R59: coordinator 18:51Z, four items. (1) Reach-ladder: NOT RULED, the branch is not on origin; pre-ruling given. (2) Charting R56 REVISION 1: blocker 1 (scope) cleared IN SUBSTANCE, but the named site does not reach the trade path it claims; blocker 2 half-cleared; blocker 3 cleared with a configuration condition. Goes back ONCE. (3) nflverse attribution: CLEARED as a machine-readable step; it does not close Explorer's finding. (4) Predicate lesson: ADOPTED, with one addition.

### R59.1 Reach-ladder command: no pushed head, so no ruling
`git fetch origin` at 18:5xZ: there is no `claude/project-thread-w45mur-reach-ladder`, and `e2f2674b` and `83b67b82` are not valid objects here. Under the charter I cannot rule on sandbox-only commits. **Pre-ruling on what was reported:**
- The b0c1616d/500bab36 cells (request-only **172**/65/6/18/11/47 = 319, request+job **228**/55/3/2/10/21 = 319) match my own R54.1 regeneration of 172 and 228, so they are consistent.
- **"Current main write-tree 02096ca5" is not main.** `origin/main` = f620a120, tree **6c00c129**. Population 321 = 319 + 2 suggests a tree that includes the branch's own new files. Name what 02096ca5 is (branch tree, or an index with uncommitted files). The 169/225 figures are about that tree, not about main.
- The `scheduler.js:714-721` cite for the `build-manager-archetypes.mjs` spawn does not match main: on f620a120 the docblock is at `:728` and the `path.join` is at `:741`. Carry the tree with the line.
- The two self-found defects (betting-only routes counted as route reach; M1 surviving because the rule passed its own predicate) are recorded as survived-then-repaired, which is the right form. Credit given.
- **CONTRACT.md's 178:** corrected **separately**, after the command is ruled, by Wiring map (file owner). Agreed with the coordinator. The correction is two things, not one: the low end becomes 172, and the 178 column's printed total (319, where the column sums to 325) is withdrawn.
Final ruling once the head is pushed: ancestry of RED/GREEN, a re-run of the command on 500bab36 by me, and M1 killed on the pushed tree.

### R59.2 Charting REVISION 1: goes back ONCE
**Blocker 1, scope: CLEARED IN SUBSTANCE.** Moving to a fantasy target (weekly PPR points) and a fantasy seam that returns 1 today is the right answer, and "measure persistence first against DvP's +0.027" is a cheaper falsification that comes first. **But the named call site does not reach the path the revision traces:**
- The revision names `matchups.js:365` `gameMultiplier` "via `dvpFor(...).mult` at `:340`". **The trade engine never calls `gameMultiplier`.** `thisGame` comes from `scheduleOutlook` (`trade-engine.js:335`, `:348`), which **recomputes** the product itself: `mult: +(d.mult * homeFieldFactor(g.home)).toFixed(3)` (`matchups.js:419`, from `dvpFor` at `:414`). `gameMultiplier` is called by `season-sim.js:24`/`:221`. So a fifth factor entering at `:365` reaches season-sim and **misses the trade path** the revision lists first. A factor entering inside `dvpFor` sits behind `if (!DVP_MULTIPLIER_ENABLED) return { mult: 1 … }` (`:345`). **Name the one function both `:365` and `:419` read**, or collapse `:419` onto `gameMultiplier`, as `:362-363`'s own comment asks.
- Hop 1 of the path is miscited. `routes/trades.js:19` imports `dvpTable, matchupModel, matchupSignalActive, MATCHUP_SIGNAL_REASON` for display. The multiplier reaches the route through `trade-engine.js` → `buildAssetUniverse` (`:268`) → `scheduleOutlook` (`:335`).
- **The multiplier is consumed in two forms, and the site binds the build (R47.2).** It is a **points** scale at `trade-engine.js:359` (`currentWeekBasePpg * thisGame.mult * activeProbability`), and a **volume** scale on attempts, carries and targets in the sampler (`:399`, `:408` → `player-week-engine.js:802` → `projections.js:825`; also `season-sim.js:227`, composed with game script). `MATCHUP_EVIDENCE.method` graded the **points** form ("exactly as trade-engine applies thisGame.mult to current_week_ppg", `matchups.js:31-33`). Declare which form is graded. The other form is named as inheriting the factor ungraded, or it is graded too. A pressure rate acting through **volume** is also a mechanism claim (blitz rate moving target counts), and the revision does not make it.

**Blocker 2, values: HALF CLEARED.** Rates rather than counts, N = 20, and the drop → season-to-date `week < W` → 1-with-reason chain are all **cleared**, and well argued. **Still free after a result is seen:**
- (a) **How five rates become one multiplier.** The functional form, the fit (on 2022-2024?), and which aggregates enter are not declared. Five candidates tested in turn without a declared rule is a forking path.
- (b) **The persistence gate's decision rule.** "Carries better than DvP's +0.027" needs an n (team-seasons), an interval, and a rule for five aggregates. A point r = 0.05 on ~96 team-seasons passes as written and means nothing. Declare "lower CI bound above X for aggregate Y", or a primary aggregate.
- (c) **The `n_pass_rushers > 0` gate** is cited as prior treatment but does not appear in `blitz_rate`'s row. `mean_pass_rushers` says "denominator charted dropbacks" while `AVG(NULLIF(…,0))` divides by non-zero rows. Make the table say what the SQL will do.
- (d) N is stated in dropbacks. `catchable_rate` and `drop_rate` are per **target**. Say which N applies to them. Also say whether those two receiver-side rates are in the candidate at all, since the hypothesis as argued is defensive scheme.

**Blocker 3, incumbent: CLEARED, with one condition.** The asserting command (distinct set exactly `{1}`, abort otherwise) and the reproduce-or-stop rule are exactly right. **Condition:** `replaySeasonWeekly` must run in **configuration B**, declared: `roleRecency: WEEKLY_ROLE_RECENCY` passed explicitly, `kOverride` omitted, and the `target_share` k control that stops the run at `K.share = 6`, the same shape cleared for #121 at R57.1. `MATCHUP_EVIDENCE` does not say which configuration produced 4.333. A bare replay is the season-long configuration (R42/R57.4). Step 3 must print the configuration it ran. "Within its own bootstrap interval": `baseline_2025` has no interval of its own, so state the tolerance.

Non-blocking items accepted. The `drop_` measurement (2 hits, both in the writer) closes that item.

### R59.3 nflverse attribution (branch `claude/nflverse-attribution`, head 25052404, base f620a120): CLEARED as a machine-readable step. It does not close the finding.
- Run on my checkout: **4/4 pass** on 25052404, and **0/4** on RED 0c47e602. The descriptor (`nflverse.js`, frozen) carries creator, material URI, licence URI and `modified: true`, which is §3(a)(1)(A)(i), (A)(v), (B) and (C) in substance. The release-URL test with a path boundary is a good self-catch.
- **Real vs decoration:** `sources` is added to the JSON of `GET /api/data-freshness`, which is authenticated (`server/index.js:140`). Its only UI consumer, `DataFreshnessBanner.tsx:100`, **returns null when `all_fresh` or dismissed** (`:132`) and **never reads `sources`**. So after this PR, **no user sees attribution anywhere**, which is the state Explorer's finding names ("nothing a user can see", PACKAGE §0, and §4 item 2 "one user-visible line"). The PR is a correct step. It must not be described as compliance. Its body names the visible credit line as **open** (Explorer §4.2), for a UI unit. Not legal advice either way; Explorer's registered weakness 1 stands.
- Non-blocking: `FFOPPORTUNITY_SOURCE` (`ffopportunity.js:17-23`) has no `license_url`, `creator` or `modified`. Test 4 pins "both CC BY sources, verbatim" side by side, so the weaker descriptor is now pinned as an equal. Complete it, or say it is left.

### R59.4 Predicate lesson: ADOPTED, plus one clause
Agreed as written. The addition: **the mutation set must include call-site mutations** (the argument passed, the predicate chosen at the caller), not only mutations inside the unit. A set that mutates only the function body cannot see a wrong or self-referential argument, which is exactly how M1 survived. Pin the injected predicate directly **and** keep M1 in the set as a standing call-site mutant.

## R60: #129 merged (c90d2834). R53.1 CLOSED, no objection. Spot-checked, not re-audited.
- `refs/pull/129/head` = 6432a768, the head the Evidence Auditor checked. RED 4bab4fd2 and GREEN a997747e are both ancestors of it. `wiring-map.mjs` and `wiring-map.test.js` on main are byte-identical to that head.
- `test/wiring-map-unknown-handle.test.js`: RED 4bab4fd **3 pass / 5 fail**, GREEN a997747 **8 / 0**, main c90d2834 **13 / 0**. `test/wiring-map.test.js` on main is 90 / 0. `node scripts/wiring-map.mjs --check` on main **exits 0**, so main's three pre-existing items are gone. R57.5's and R58.2's "wiring exit 1 = main's three" notes are now historical: from here on, any wiring exit 1 on a branch rebased onto c90d2834 is that branch's own.
- Cite as #129, "fix: GREEN — an unrecognised handle is not the app, and a registration is a call", a997747e.

## R61: R49.2's premise AMENDED (Explorer's correction is right). The two-copy rule stands, on a corrected mechanism and with its scope stated.
**Correction, verified on origin/main c90d2834:** `server/db/index.js:184-187` runs **only** `000_legacy_schema` (`applyLegacySchema`), and only when its marker is **absent** from `schema_migrations`. The numbered migrations run through `runMigrations` (`server/db/migrate.js`) on server boot or from any script or test that calls it. R49.2's list "`:184` migrations" was wrong: it named the legacy schema as "migrations" and implied that import applies the numbered set. **Withdrawn and replaced by this:**
- **Fresh or marker-less file:** import creates the whole legacy schema (Explorer measured 215 tables, 1 `schema_migrations` row). Every "absent vs empty" claim is ambiguous. Explorer's "stronger" holds here.
- **A production snapshot (marker present):** import does not create tables. It still **writes** (WAL pragma, `CREATE TABLE IF NOT EXISTS schema_migrations`, `db_health_checks` and its row). Any `runMigrations` call then applies whatever numbered migrations production had not run. So the ambiguity comes through `runMigrations`, not the import, and the write-at-import still breaks "pristine".
- **The rule is unchanged, restated by what it forbids:** the pristine copy is touched by **no repo code**, neither the import nor `runMigrations`. Existence, row-count and **column-existence** claims about production come from it through a raw read-only connection, and `schema_migrations` on it says which migrations production ran.
**Explorer's corollary: ACCEPTED, scoped.** A "no such column" error on a database built by import alone (or by a partial migration run) is an artefact of the build path, never evidence about production. Production has the column exactly when its pristine `schema_migrations` lists the migration that adds it. Explorer's retraction of its `syncInjuries` `entity_season` finding on this ground is correct and is credited.
**Rig rebuild (PACKAGE-RIG-REBUILD), for the record, not audited:** direction reproduces (configuration B worse, n = 4361 against the old rig's 4343), and no magnitude carries over. That is Condition A (orderings travel, magnitudes do not), now shown on two independent rigs. **No lineup rate or magnitude goes to Nick from either rig.** The licence gate is met for nflverse (CC BY 4.0, fetched, R59.3). Internal measurement publishes nothing, so no attribution duty is triggered by the rig itself. I have not re-run the rig's command. Any figure from it that is to leave the fleet comes to me with command, n and split first.

## R62: coordinator 18:03Z. (1) #135 reach-ladder @ 1d5076fe: numbers REPRODUCE exactly on both trees, and my R59.1 "321 = 319 + branch files" was WRONG. HELD on one item: the call-site mutant still survives. (2) Charting revision 2: CLEARED WITH THREE TEXT CONDITIONS, confirmable by line without another round. The persistence check may run now.

### R62.1 #135: correction to my R59.1 first
`git rev-parse <t>:server/services` / `:server/modeling` gives **2c900fff / 6bbd8e6a** on f620a120, c90d2834 and 1d5076fe alike. b0c1616d has services **54f23f77**. The population counts (`.js`/`.mjs` under both) are 321/321/321 against 319. **Opportunity is right: 169/225 and 211/14 are MAIN's numbers**, and the +2 is main's own churn. My "branch files" reading was a guess stated as a finding. Withdrawn. The `:714-721` cite is correct on b0c1616d, as they say; it outlived its tree rather than being wrong. Citing the population subtree hash, instead of write-tree, is the better anchor and is adopted.

### R62.2 #135: what I ran
- The ladder command on the head (1d5076fe): request-only **169**/65/6/18/12/51 = 321; request+job **225**/55/3/2/10/26 = 321; route 211 / script-only 14; scheduler-invoked scripts: 1 (`build-manager-archetypes.mjs`).
- The same script copied onto **b0c1616d**, where `scripts/reach-grade.mjs` is byte-identical to main's: **172**/65/6/18/11/47 = 319; **228**/55/3/2/10/21 = 319; 214 / 14. **Every R54.1/R54.2 cell reproduces.** Bracket 172–228 on 500bab36, 169–225 on main.
- `test/reach-ladder.test.js`: RED 5f2433dc **0 / 1** (the file fails at import, since the module is absent); GREEN/head **14 / 0**. RED 5f2433dc is an ancestor of the head.

### R62.3 HELD: the call-site mutant survives on the pushed head
M1 as the evidence file defines it ("betting exclusion removed from the call site", `docs/tdd/reach-ladder.tdd.md:146`) was killed by moving the exclusion **into** `routeEntryPredicate` (`scripts/reach-ladder.mjs:221-222`) and pinning that function. That kills a **body** mutant. I ran both:
- **Body mutant** (`:222`, drop `&& !isBettingEntryPoint(e)`): **killed**, test 14 fails. As claimed.
- **Call-site mutant** (`:266`, `isRouteEntry: routeEntryPredicate(mounted)` → `isRouteEntry: (e => mounted.has(e))`): **14 / 0, SURVIVES.** That is exactly the defect that first printed 227 / 1. Nothing asserts that `measure()` passes `routeEntryPredicate`.
- Test 14's title, "the predicate the ladder **actually passes** excludes betting entries", is therefore false. It tests the predicate the module **exports**. Its own comment ("Deleting the betting exclusion from measure()'s call site broke NO test") is still true of the pushed head. This is the R59.4 clause in its first application: the lesson moved one level and the mutant moved with it.
**Closes when** a test kills that exact call-site mutant, for example `measure()` over a committed inline fixture with a betting route that is the only route reaching one file, asserting that file is script-only or unreached, not route-reached. The call-site mutant also becomes a standing row in the mutation table. The author picks the form.
**Non-blocking:** (a) the header prints `tree <sha>` but the sha is the **commit** (`git rev-parse HEAD`), a label error in the one place this series most needs commit and tree kept apart. (b) The file header credits R51.3 to the "Evidence Auditor"; R51.3 is the Independent Auditor's. (c) A RED that fails at import proves no rule discriminates on its own, so the mutation table carries that load. That is acceptable, and it is why the table must include call-site rows.
**CONTRACT.md** (Wiring map, after #135 merges): the low end becomes **172 on 500bab36**, with the current main figure **169–225 on services subtree 2c900fff** beside it, and the 178 column's total withdrawn.

### R62.4 Charting revision 2: CLEARED, with three text conditions
**Blocker 1, CLEARED.** The site is `dvpFor` (`matchups.js:340`), read by both `:365` and `:414-419`. The coordinator's no-collapse ruling is in scope. The duplicate at `:419` is recorded as a hazard for the file owner. Hop 1 is corrected (`trade-engine.js:260/:268/:335/:348`). The graded forms are declared, with the ship rule adopted verbatim from `:33-35`.
**Blocker 2, CLEARED:**
- (a) one primary aggregate, `heavy_rush_rate`, one parameter (`1 + beta*z`), beta fit 2022–24 and never refit;
- (b) split-half r, n = 96 team-seasons, clustered bootstrap, **proceed only if the 90% lower bound > 0.20**, which is a real test;
- (c) the table now matches the SQL;
- (d) the receiver-side rates are out, one N.
Non-blocking on (b): the same franchise appears in three of the 96 clusters. A cluster-on-team sensitivity line beside it costs one flag.

**Three conditions. Each is a text fix, confirmable by line (Evidence Auditor or coordinator). No further round with me:**
1. **`z` must be walk-forward.** "Standardised within season", applied to 2025 week W, uses the season's mean and sd, which **includes weeks ≥ W**. That is look-ahead in the one quantity being graded. State that `z` at week W is standardised against the league distribution of **season-to-date (`week < W`) rates**, the same rule revision 1 set for the rate itself.
2. **One switch cannot ship half a result.** The site is `dvpFor`, whose single `mult` reaches the POINTS consumer (`trade-engine.js:359`) and the VOLUME consumers (`:399/:408`, `season-sim.js:227`) alike. "If the points arm passes and the volume arm does not, only the points arm's switch is eligible, and the volume call sites keep 1" **cannot be built** under a grant of one additive arm in `matchups.js`: it needs edits at the consumers. Declare a **joint rule**: the switch flips only if **both** arms pass, the volume arm under the same MAE rule **plus CRPS no worse**. Otherwise the split outcome is registered as needing a separate grant, and nothing ships on it.
3. **The k control is inverted relative to #121, and must say what it expects.** Revision 2 says `kOverride` omitted "falls through to the hardcoded K" with "`K.share = 6` as the stop control". For #121, `K.share = 6` is the value that **stops** the run, because #121 grades the fitted k. For this unit the incumbent is **the app as served**, and `projections.js:206-209` says no fitted k has ever been persisted (`shrinkage_fits`/`shrinkage_k` empty), so served volume k is the hardcoded 6 **if production agrees**. Required: the control prints the resolved `target_share` k and **stops if it differs from what production resolves**. That value comes from the pristine census's `COUNT(*)` of `shrinkage_fits`/`shrinkage_k` (R61), not from the code comment. Write the expected value, and its source, in the text.
**What may run now:** the persistence check (feature-only, 2022–24). It depends on none of the three. The outcome run waits for them.

### R62.5 Consequence for #121, found while ruling R62.4(3): configuration B names no source for the fitted vector
With `kOverride` omitted, the fitted k comes only from the **database**: `activeKVector()` reads `shrinkage_fits WHERE active = 1` and `shrinkage_k` (`shrinkage-fit.js:449-453`), through `cutoffSafeKVector` (`:540`). `projections.js:206-209` says both tables are empty wherever this has been run, so every call takes the hardcoded branch. #121's §2c declaration is correct in shape, and its k control will do its job: **on a rig with no active fit it stops the grade at `K.share = 6` before any arm runs.** So #121 must add one line saying where the fitted vector comes from: an active fit persisted to the **rig's** DB by the fitter (with its `through_season` cutoff-safe for each graded season, `:538-540`), or the fitter's output passed explicitly. Passing it explicitly would reintroduce `kOverride`, which then has to be the fitted object and never `null`. Text item, same class as R57.3. It rides that round and needs no separate one.

## R63: fleet cut acknowledged (coordinator 18:06Z, citing Nick 18:05:09Z). New scope, and what it does to my open holds.
**Scope from 18:06Z:** statistical claims only, meaning model, projection, trade-valuation and lineup changes. There my ruling is a gate before merge. Ordinary code merges on CI green plus the self-check block, with no auditor.
**My open holds under the new scope:**
- **Still gating (in scope):** #121 (model; R57.3 + R62.5). **The UI ceiling-lineup fix** (lineup; final evidence review NOT yet done, R44/R47: exact equality to the weekly path, the boundary, the `shrinkage-fit.js:507` half, the `ceiling-lineup.js:141-142` docstring). #106 kill switch (projection; R51.1 + R54.3). Charting unit (unbuilt; record completed at R62.4).
- **Now advisory (out of scope, ordinary code):** #130 (the decision half is pinned; the floorOf hold is about a false sentence and a UI surface). #135 (the call-site mutant, R62.3). #133 (the PR body's wording). I recommend each still be fixed before merge, because each is a claim in the PR that the code does not keep. I no longer block them.
- **Queue PRs that appear to be in scope by title, not yet seen by me:** #72 (cascade multiplier), #38 (availability pricing), #40/#44 (season sim), #43/#60 (Start/Sit), #62 (waiver K/DEF), #74 (redraft strategy), #15 (volume fit). If any is in the one-pass merge, it needs my gate first, or the coordinator records that it is out of scope and why.
**Data for the "no mistakes" question, from today's record only:** CI green did not catch the defect class this audit spent the day on. Two of #130's end-to-end tests passed on UNFIXED code (cache fingerprint, R58.3). #135's call-site mutant passes 14/0 (R62.3). #119's false "retries next cycle" note merged green (R53). A self-check block that does not require one **liveness proof** (the test fails against the unfixed code, or a named mutant dies) will let that class through on ordinary code.

## R64: two final evidence reviews. (1) UI ceiling-lineup fix (#132 as the coordinator numbers it; branch …xiezr0-ceiling-recency @ 19510ce2): CLEARED. (2) #121 @ 91ed5f1a: R57.3 and R57.4 CLEARED. MAY MERGE (docs + comments only). Two text items must land before the grade RUNS, not before the merge.

### R64.1 Ceiling-lineup: CLEARED, and it is the right fix
Run on my checkout with the repo's test environment (`--import ./test/offline-guard.mjs --experimental-test-module-mocks`, `SCHEDULER_DISABLED=1`, a throwaway `GRIDIRON_DB_PATH`):
- RED 6247820: **3 pass / 6 fail**. GREEN 81d0fa8: **9 / 0**. Head 19510ce2: **9 / 0**. `decision-leftovers-home-away.test.js`: **5 / 0**. RED and GREEN are both ancestors of the head.
- **My mutants, not the author's:** (a) `roleRecency` dropped at `ceiling-lineup.js:90` gives **4 / 5, killed**. (b) A near-miss recency `{seasonDecay: 0.05, weekHalfLife: 6}` gives **5 / 4, killed**. So the agreement test is **exact** (`deepEqual` on `params`, `test/ceiling-lineup-weekly-agreement.test.js:236`), not a tolerance.
- The comparison target matches the real weekly call (`player-week-engine.js:271-274` on c90d2834: `through, throughWeek: week-1, scoring, kOverride, roleRecency: WEEKLY_ROLE_RECENCY`; the ceiling path passes no `kOverride`, and the engine's default is `undefined`, so they are identical).
- The control test proves the fixture discriminates, and the "NOT the season-long projection" test gives the teeth. The **boundary** is stated in the evidence file: *same structural input, not "the two surfaces agree"*. That is exactly R44/R45's point. The `:141-142` docstring is corrected and names the self-referential target (R45.1).
- `check:wiring` on the head with c90d2834 merged in: **exit 0**. Rebase before merge, per the repo convention.
**Not in this change, correctly named as open:** `shrinkage-fit.js:507` still lists `ceiling-lineup` among the season-long callers, and is false from this merge on. It is another editor's file; route it to its owner. **Non-blocking text:** the new comment says the omission "also cost this caller the fitted volume k". Per `projections.js:206-209` no fit has ever been persisted, so in production today this fix changes **recency only**, and the k is the hardcoded constant either way. Say "would withhold the fitted volume k, were one active (none is persisted today)".

### R64.2 #121: R57.3 CLEARED on all three, R57.4 CLEARED
- **(1) Call site:** the assignment to `targets` whose right-hand side is `tgtShare * tv.pass_att`, which is `projections.js:605` on c90d2834. **Verified: that is the line.** Anchoring on the expression rather than the number is better than what I asked for. What it multiplies (projected targets per game), why not the share (`:599`, a conditional rate) and why not points are all argued. The carries/QB-attempts inconsistency is **declared as a limit on what a pass licenses**. Good.
- **(2) decisionAt:** kickoff minus 90 minutes, with a Wednesday 00:00 ET fallback that is conservative and stated to only weaken arm (b). "Never undefined", with the harness stopping on a missing value, and the fallback share reported with a caveat above 10%. The revised-after-kickoff control is **allowed to fail**, and its failure mode (single-snapshot revision store gives "as-of safety unverified", in the same sentence as the number) is declared. That is the contradiction-test rule applied without being asked.
- **(3) Observation support:** one row per arm. Arm (b) moves the observation with the prior (`:544` on c90d2834 verified: `a.tgtShareW ? a.tgtShare / a.tgtShareW : 0`). The prior-only variant is named as the R39 defect and not run. The note that arm (c) is *not* already measured, because the old figures ran on `K.share = 6`, is correct.
- **R57.4:** the strike's reason is now configuration (`verify-qbr-integration.mjs:12-13` bare, forwarded at `weekly-backtest.js:129`, against `WEEKLY_ROLE_RECENCY` at `player-week-engine.js:271-273`), with the false draft reason named as false. CLEARED.
- The code diff on c90d2834..91ed5f1a is **comment-only** in `projections.js` (no non-comment line changes). So the PR changes no served number, and merging is a docs merge.

### R64.3 Two text items that must land before the grade RUNS (confirmable by line, no round with me)
1. **`:625` → `:605`.** §1b says "the implementing PR wires the call at `:625`". On c90d2834, `:625` is the rush-TD-rate shrink. The expression anchor wins by the document's own rule, but the one wrong number sits in the binding section.
2. **Arm (a) is not "what ships today" in its `k` column, and a pass licenses (b) only with its k live.** This is R62.5 carried into the arms table. The table gives every arm "fitted (config B)". Production resolves `K.share = 6` while no fit is persisted (`projections.js:206-209`; `activeKVector` reads `shrinkage_fits WHERE active = 1`, `shrinkage-fit.js:449-453`). So: (i) name the fitted vector's source for the run (a rig-persisted active fit, cutoff-safe per graded season, or an explicit non-null `kOverride`); (ii) relabel arm (a) as "legacy prior **under the fitted k**", not what ships, or add the as-shipped arm; (iii) add to §5 that **a pass licenses arm (b) only where the fitted k is active in the serving path**. Wiring the multiplier at `:605` without a persisted active fit serves a configuration this grade never ran. The call site binds the build, and so does the k.

## R65: noted. The merge bar is now Nick's "gridiron-merge-gate-v2" (coordinator 18:14Z)
It carries the R63 liveness clause: one live proof per behaviour change, meaning the RED fails on the unfixed code or a named mutant dies. It also carries call-site mutants as standing rows (R59.4), Nick's five questions as the only list, and the fresh-session rule. From here, PR bodies are read against it. In-scope statistical PRs still get this gate on top of it.

## R66: (1) the side-effect import gap: CONFIRMED, and it makes both brackets' HIGH ends floors. (2) #72 @ c1655b25: CLEARED to merge.
**Nick 18:16:07Z (cmsg_01YAsw8AnFv4ioRMQw8dfPmTWxz7wC5vFLCTEe7cMso3FB): usage is priority one.** From here, rulings are batched, re-read only when a head has moved, and run the minimum tests plus one or two mutants.

### R66.1 `buildImporterGraph` misses bare `import '…'`: CONFIRMED
`scripts/reach-grade.mjs:99` on c90d2834 matches `(?:\bfrom|\bimport\s*\()` only. `git grep` on c90d2834 finds **12 bare side-effect imports** under `server/` and `scripts/` (for example `clv-core.js:47`, `nfl-player-value.js:11-12`, `nfl-roster-strength.js:12-13`, `prop-feeds.js:35`, `signal-latency.js:30`), mostly betting-side. Per the report, `classifyImportEdges` sees them. So **the two ends of the bracket are built by different edge parsers**, which is R28's "ends measured to different standards".
- **What needs re-stating once fixed:** the **request+job** end on both trees (228 on 500bab36, 225 on main) is a **floor until then**, and it is quoted as "≥". The **request-only** ends (172/169) and the populations (319/321) are unaffected: file counts don't depend on edges, and request-only already counts the bare imports. After the fix, re-run the ladder once per tree and re-state the high end, route/script split and grade columns with the tree. **CONTRACT.md takes one edit with the fixed numbers, not two.** Hold Wiring map's correction until then.
- **Own PR: yes.** Its RED needs an inline fixture with a bare import (R54.3), plus one **superset invariant**: every request-only edge is an edge of the full graph. That property would have caught this, and it is the natural standing test.

### R66.2 #72 cascade multiplier @ c1655b25: CLEARED
- Tests (repo env): RED ed96531e **2 pass / 2 fail**, GREEN a6975b86 **4 / 0**, head **4 / 0**; the three new files together **10 / 0**. (#124's commit in the range is already on main, 9f0b5b66, so the PR does not widen.)
- My mutants: floor set to 0 gives 3 / 1, **killed**. The threshold tested on the wrong side (`without.opp`) gives 3 / 1, **killed**.
- **Behaviour change:** `multiplier` becomes `null` when the with-starter divisor rests on fewer than 9 opportunities (`contingency.js` `MIN_DENOMINATOR_OPPORTUNITIES`). **No arithmetic consumer reads it.** The only reader is the `paths[].multiplier` passthrough (`contingency.js:1116`); `expected_gain`/`expected_points` use `b.gain`; `role-scenario-engine.js:275` uses `gain`; no client file renders it. So nothing multiplies by `null`. The change is conservative and display-only.
- **The threshold is post hoc** (chosen after Whittington ×26.38) and argued from 1/√k. The code comment says plainly that it is a rule, not a clean line (Mac Jones at 8). That is acceptable for a withholding rule. It is not a graded quantity and may not be cited as one.
- **The cascade GRADE figures in `docs/evidence/2026-09-20/cascade-grade.json` were not re-run by me** (usage). They do not go to Nick as validated numbers without a re-run.

## R67: Feature audit batch on 6e722719. #62 CLEARED, #74 CLEARED. #67 and #55 are ordinary code (the v2 gate only), with no statistical claim.
Liveness method (usage-lean): the head's new tests are run against the head, then against the UNFIXED source file taken from 6e722719, plus one mutant where the logic warrants it. Repo test env.
- **#62 waiver K/DEF @ 01f7273:** head **14 / 0**. The same tests on unfixed `waiver-brain.js` give **6 / 8**, so they are live. Behaviour: `SCORED` fixed `DST`→`DEF`. K/DEF are **excluded from ranking** (`lineup_modelled`) and **say so** (`not_modelled`, with the reason). `accept_probability` 0.9 is labelled `basis: 'hand-set'`. `confidence` becomes `null` instead of the 0.9 presented as fitted; `decision-inbox.js:97` defaults `confidence = null`, so null is handled. `expected_value` is unchanged (gain × 0.9) and ordering is unchanged. **Honesty change. No served ranking moves.** CLEARED.
- **#74 redraft window + need guard @ 7a55f75:** head **14 / 0**; on unfixed `routes/tradelab.js` **8 / 6**. My mutant (drop the `isDynasty &&` gate on young/old) gives **12 / 2, killed**. Behaviour: (a) age-based "accumulate youth / sell vets" stance is now dynasty-only, with `basis` named. `window` reaches `evaluate()` only as the `their_window` passthrough (`trade-engine.js:1172`), not a score. (b) `avg[pos] = 0` gives status `unknown` instead of dividing by 1. That removes spurious needs, which fed `hurtsNeed` → `brokenForThem` (`trade-engine.js:1157-1165`), so **it can change verdicts, in the correct direction** (a need invented at a position the board cannot price no longer blocks a deal). CLEARED.
- **#67 bye-risk @ a3fc5e7 / #55 consensus-season @ 143696a:** the non-comment server diffs are the `not_modelled` disclosure (`roster-risk.js`) and a `season = ?` join on `espn_player_market` (`aggregates.js`, `espn-market.js`). Data-correctness and honesty, **not model, projection, trade-valuation or lineup**, so v2 gate only. Not ruled on merits.

### R67.1 (addendum to R66.1): Wiring map's 9 vs my 12. The "≥" STANDS.
My 12 (`git grep -nE "^\s*import\s+['\"]" c90d2834 -- server scripts`) **exclude tests**, and all are relative specifiers. Wiring map's 9 are my 12 minus **`clv-core.js:47`, `prop-feeds.js:35`, `signal-latency.js:30`**, which are exactly the three lines that carry a **trailing `// comment`**. So its parser most likely anchors at end of line, which is the same class of miss as the defect being measured. Also, its reported tally (hand-run **11**, unreached **25**) differs from the ladder's (**10 / 26**): **two cells moved, not "no cell"**. Wired is 225 either way on the 9. **225 is exact only once all 12 are restored and the tally is re-run; until then "169–≥225" stands.** A contradiction test is needed for the edge counter: a fixture line `import './x.js'; // note` must count.

### R67.2: the "≥" comes off 225 wired on c90d2834 only
Wiring map's counter now counts all 12 (the comment-tail case is fixed, which is the contradiction test passing). With all 12 restored the tally is 225 wired, unchanged. So **"169–225 wired" is exact on c90d2834 (services subtree 2c900fff)**. It stays scoped:
- **228 on 500bab36 keeps its "≥"** until it is re-measured.
- On any other tree the command's high end is a floor until `buildImporterGraph` itself parses bare imports (R66.1's own PR).
- The hand-run/unreached cells (10/26 vs 11/25) stay open pending the isHandRun run.
