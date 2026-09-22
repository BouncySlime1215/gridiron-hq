# Pre-registration: the target-share prior and the availability multiplier, graded together

**Committed before anything in it was run, including the confirming check in
section 2.** It exists so the decision rule cannot be adjusted to fit whatever
comes back, and so the power declaration cannot be derived from the standard
error it is supposed to have anticipated — which is the criterion the previous
unit in this line missed.

## 0. Why this is one unit and not two

`target-share-prior-result.md` §5 measured that the legacy `0.06` prior
under-projected every pass-catcher (mean signed error −0.9764 targets on weeks
played) and that correcting it is a **null** on the availability-inclusive
metric (−0.0136, 90% CI [−0.0499, +0.0225]) while winning on the conditional one
(+0.1044). The diagnosis: a systematically low projection is an accidental hedge
against the weeks a player does not play, and the model has no availability term.

So the prior alone removes a hedge with nothing to replace it, and an
availability multiplier alone, applied over a still-biased prior, discounts a
projection that is already discounted by accident. **Neither ships alone.**

## 1. What the multiplier actually is today — read off the code, not assumed

On `main` (`ac31922d`) `gradedAvailabilityMultiplier` **does not exist**. It lives
only on branch `shrinkage-efficiency-weighting` at `1a70355`:

- Defined `nfl-player-context.js:525`, with **zero call sites anywhere in
  `server/`**. It is built and ungraded: there is **no applying line today**, so
  "where in the projection path it multiplies" has no answer yet and this
  pre-registration must specify the site rather than describe one.
- **Serve side is as-of**: `valueAsKnown(entity, 'injury_report', decisionAt)`
  (`:528`), reading `nfl_feature_revisions`.
- **Fit side**: `fitGradedAvailability` (`:424`), refit under R19.6 to each
  entity's earliest revision (CTE `:441-449`, commit `cfab134`), so fit and serve
  share one as-of set on that branch.
- **Population**: players with a real usage row in a prior week, bucketed by the
  earliest `injury_report` revision for the following week (`:452-469`); `minN`
  30 pools to 1.0; seasons as passed minus the in-progress one (`:425`).

Every citation in this unit is to that branch at that commit, never to `main`.

## 2. The three-support mismatch, which is prior work this grade must not repeat

The shrink at `projections.js:599` interpolates `tgtShareObs` toward
`targetSharePrior` with weight `n/(n+k)`. Those three quantities sit on **three
different supports**:

| quantity | line | zero-target weeks |
|---|---|---|
| observation `a.tgtShare / a.tgtShareW` | `projections.js:515` | **included** |
| prior `positionalPriors()` | `projections.js:408` | **included** (since 2026-09-22; gated `> 0` before) |
| `k` for `target_share` | `shrinkage-fit.js:329-330` | **excluded** |

**Exactly one of the three has always been on a different support; the
2026-09-22 change moved which one, it did not create the mismatch.** Before it,
prior and `k` agreed and the observation was the odd one out; now observation and
prior agree and `k` is.

**The sharp form, and it is the reason this is not cosmetic.** `n` is
`a.tgtShareW`, a sum of role weights over weeks with a *known* share — so a
player who misses games carries a smaller `n` and is shrunk harder toward the
prior. **`n/(n+k)` is therefore already doing an unintended availability
weighting**, and because `k` was fitted on a zero-excluded support its value is
calibrated against a different `n` scale than the one it is divided into. **The
contamination is n-dependent, not a uniform 0.0059**, and a multiplier laid on
top of it would be pricing availability twice at an unknown, player-varying rate.

### The confirming check, run before the grade and reported either way

Correlate each player's **understatement** (his zero-included mean share minus
his zero-excluded mean share) against his **n**. A uniform contamination predicts
no relationship; the n-dependent account predicts a negative one. Result goes
here before anything below is run. *(Pearson and Spearman, n reported, on the rig.)*

## 2b. Which side of the 2026-09-22 estimator change every number ran on

**Blocking requirement, and it governs every figure this unit carries in.**
`positionalPriors()` changed on 2026-09-22 (commit `25de210e`, reversed to
default-off in `a2fd9daa`): before it, the accumulator gated `target_share > 0`;
after it, the gate is `target_share != null`. **Figures from before and after
that change are not on the same estimator.** A number from one side and a number
from the other differ by the estimator as well as by whatever was being tested,
so **a pre/post comparison is not a candidate-versus-incumbent delta and must
never be reported as one.**

Every figure carried into this unit therefore states its side, in the same
sentence as the number:

| figure | value | side |
|---|---|---|
| positional means, zeros included | WR 0.1322 / TE 0.0972 / RB 0.0647 | **post** |
| positional means, zeros excluded | WR 0.1516 / TE 0.1093 / RB 0.0928 | **post** (computed directly, not via the accumulator) |
| conditional MAE, legacy vs fitted | 1.9005 / 1.7961, +0.1044 | **post**, both arms |
| `decision_including_dnp` MAE | 2.0352 / 2.0488, −0.0136 | **post**, both arms |
| mean signed errors | −0.9764 / −0.3165, −0.4003 / +0.2486 | **post**, both arms |
| `k` for `target_share` | as fitted in `shrinkage-fit.js` | **pre** — fitted on the zero-excluded support and never refitted |

The last row is the one that bites: **`k` is a pre-change quantity in use on a
post-change estimator**, which is the same fact section 2 states as the support
mismatch, seen from the estimator side. Every arm in section 4 is run on the
post-change code so that no comparison inside this unit crosses the boundary;
the only pre-change quantity anywhere in it is `k`, and that is declared here
rather than discovered later.

## 3. The pre-registered default arm, and the alternative it must be able to reject

**DEFAULT: exclude the zeros from the prior, and price availability in the
multiplier.** The prior becomes each position's mean share **over weeks with
targets** (measured 2021-2024: WR 0.1516, TE 0.1093, RB 0.0928), and the
multiplier carries availability explicitly.

Three reasons, stated before any result:

1. **The multiplier is explicit and gradeable.** An availability term that lives
   in a named function with an as-of fit can be measured, argued with and turned
   off. One that lives inside a prior's estimand cannot.
2. **Excluding changes one site; including changes two plus a `k` refit.** With
   zeros excluded, observation and prior can both be moved to the conditional
   support and `k` already sits there. With zeros included, `k` must be refit as
   well.
3. **The cost is asymmetric, because `k` is not identifiable from `mu`.** Getting
   the support wrong while also refitting `k` on it produces a pair that fits the
   fitting window and transports to nothing.

**ALTERNATIVE, stated so the grade can reject the default rather than confirm
it:** keep the zero-included prior shipped on 2026-09-22 and apply **no**
multiplier — the arm whose conditional win and availability-inclusive null are
already measured. If it beats the default arm on the primary metric below, the
default is wrong and this document says so.

## 4. The grade

### Arms — three, same code, flags apart

| arm | prior | multiplier | role |
|---|---|---|---|
| **(a)** | legacy `0.06`, zeros irrelevant | none | **incumbent** — what ships today |
| **(b)** | per-position, **zeros excluded** | applied | **the default hypothesis** |
| **(c)** | per-position, **zeros included** | none | **the alternative**, already measured |

Arm (c) exists so this grade can **reject** the pre-registered default rather
than only confirm it. If (c) beats (b) on the primary metric, section 3's
reasoning was wrong and this document will say so in those words.

### Primary metric

**`decision_including_dnp` MAE of projected targets per game**
(`weekly-backtest.js:170` — in the population if the player had a usage row the
week before; a week he did not play scores as a real `0`).

**The conditional metric is reported beside it and cannot decide this unit.** It
is the metric that produced a win on the previous unit which the
availability-inclusive metric then refused, and the whole point of the coupled
design is that availability is the thing being modelled. A result that is
positive on the conditional metric and null on the primary is a **null**.

### Split

Held out, ending before any season used to fit either the prior or the
multiplier. The multiplier's fit excludes the in-progress season by construction
(`:425`); the prior's window ends at 2024. **2025 is the graded season and is
read by neither fit.**

### Significance

Paired bootstrap **clustered by player** (`backtest-significance.js#pairedBootstrapDiff`),
2,000 iterations, seed `20260922`, 90% interval, house argument order
(`(arm, baseline)`, so positive favours the arm).

### POWER, DECLARED HERE, BEFORE THE FIRST RUN

The criterion the previous unit missed. Nothing in this subsection may be
rewritten after a number exists.

- **Smallest effect worth calling: 0.05 targets per game.** Not invented for
  this document — it is the project's own established scale for this quantity,
  the same `−0.05` the previous pre-registration fixed as the bound below which
  a measurement cannot rule out a real harm. Half the conditional effect already
  measured on the prior alone.
- **Detection rule.** At 80% power on a 90% interval an effect must be at least
  **1.78 × SE**, so 0.05 requires **SE ≤ 0.0281**.
- **Is that reachable?** Planned from the previous unit's measured SE, which is
  what a prior study is for: **SE 0.0220 at 294 clustered players** on the
  availability-inclusive metric. SE scales about as `1/√(clusters)`, so
  SE ≤ 0.0281 needs roughly **≥ 180 players**. The available population is ~294.
  **The design is adequately powered for a 0.05 effect, with margin.**
- **The caveat, stated now rather than discovered later.** Arms (a) and (b)
  differ in *two* things (the prior's support and the multiplier), so the paired
  differences may be more variable than the single-change comparison this
  projection is built from. **The realised SE is reported with the result**, and
  if it exceeds 0.0281 the unit is declared **underpowered for 0.05** and no
  null in it may be read as evidence of no effect.

### Controls, declared now

- **Carries must not move** between any pair of arms. The target-share path
  cannot touch the carry share.
- **Quarterbacks must not move.** `projections.js:605` forces QB targets to 0.
- **A player with no `injury_report` revision must receive multiplier exactly
  1.0**, and his arm-(b) projection must be bit-identical to the same player's
  under the same prior with the multiplier disabled. This is the control on the
  multiplier's wiring, and it is the one most likely to catch a mistake, because
  the multiplier has no existing call site to copy.

Any control moving voids the primary until it is explained.

### The decision rule, fixed in advance

1. **(b) beats (a), interval excluding zero, and (b) is no worse than (c)** →
   the coupled change ships: per-position prior on the conditional support, with
   the multiplier, wired at the site this unit specifies.
2. **(b) does not beat (a)** → neither ships. The incumbent stays, and the
   finding is written up as a negative. **The correctness argument that `0.06`
   is not the mean of any position is explicitly NOT sufficient to override
   this** — that argument already lost once, on the previous unit, and it does
   not improve by being repeated.
3. **(c) beats (b)** → section 3's default was wrong. The zero-included prior is
   the better estimand, availability does not belong in the multiplier at this
   site, and this document records that its own reasoning was rejected.

In branches 2 and 3, no result is promoted from the conditional metric or from
any subgroup to rescue the primary.

## 5. Limits fixed now

- Every figure grades a **replay** predictor on a rig holding a subset of
  production's tables; equivalence to the serving predictor is unestablished.
- The multiplier has **no call site**, so arm (b) specifies one. That is this
  unit's own construction and any result is about the site it chose.
- `K.share = 6` against the fitter's ~0.4 stays untouched and open.

## The five questions

- **Well built?** To be judged after the fact. What is fixed now is that the
  arms differ in flags rather than implementations, that the power declaration
  is written before the first run instead of derived from its standard error,
  that the alternative arm exists so the default can be rejected, and that the
  one pre-change quantity in the design is named in section 2b rather than
  discovered later.
- **Stats or made up?** Stats. The priors are means of the 2021-2024 fitting
  window; the multiplier is fitted as-of against `nfl_feature_revisions`; the
  grade is a paired bootstrap clustered by player on a held-out season neither
  fit reads.
- **How do we know?** Because the incumbent is the same code with flags
  changed; because carries and quarterbacks cannot be reached by the change and
  must come back flat; because a player with no injury revision must be
  bit-identical across the multiplier arms; and because the primary metric is
  the one that refused the previous unit rather than the one that flattered it.
- **Pointed anywhere else on the platform?** Yes — it would change live
  projections for every pass-catcher, which is why it is pre-registered, gated
  and default-off until graded. It also specifies a call site for a function
  that currently has none, so it constructs the thing it measures, and that is
  stated as a limit rather than a feature.
- **How does it unify?** It takes two findings that looked separate — a prior
  that is wrong about the population, and an availability term that was built
  and never wired — and treats them as one, because the measurement showed the
  first was only tolerable while the second was missing. It also carries the
  standing lesson from the unit before it: **read what production does with the
  quantity, off the applying line, before fitting anything against it.**
