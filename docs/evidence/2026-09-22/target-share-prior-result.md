# The target-share prior, graded: +0.1044 targets of MAE on weeks played, and a null once missed weeks are counted

**Read section 5 before quoting the headline.** The pre-registered primary is a
real win. A second metric, added afterwards at the auditor's instruction, is a
null — and the reason the two disagree is the most useful thing this unit
found.

**Read `target-share-prior-preregistration.md` first.** It was committed
(`d2f04ff4`) before this grade was run, and it fixed the metric, the split, the
incumbent, the controls and the decision rule in advance. Nothing below was
chosen after seeing a number.

**Source label, and it governs every figure here: SCRATCH DATABASE — a rebuild
from nflverse weekly CSVs, 45,693 REG player-weeks over 2018-2025 and 1,483
distinct players.** That is a narrower player list than the full league
universe; another thread's rebuild of the same shape carried 8,294. The live
database was never opened.

---

## 1. The result

Held-out **2025**, REG weeks 5-17, **2,367** graded player-weeks over **288**
players. Both arms are the same code one flag apart, scored on the intersection
of the rows each produced.

| arm | MAE, projected targets per game | mean signed error |
|---|---|---|
| legacy single 0.06 prior | 1.9005 | −0.9764 |
| **per-position prior** | **1.7961** | **−0.3165** |
| **legacy − fitted** | **+0.1044** | level moved 0.6599 toward zero |

The signed errors are there because a prior shrinks toward a mean, so it moves
the level by construction and a MAE gain alone cannot say whether anything was
learned. Section 5 separates the two.

Paired bootstrap clustered by player, 2,000 iterations, seed 20260922, house
convention (`pairedBootstrapDiff(arm, baseline)`, so the interval is
`baseline − arm` and positive means the arm wins):

```
mean_diff +0.1052   90% CI [+0.0680, +0.1437]   significant: true
```

**Pre-registered branch 1: the interval excludes zero in favour of the fitted
prior, so it ships as the default.** That is what the code does.

## 2. The controls, which are the reason to believe the harness

Both were declared before the run, and both are *exactly* zero rather than
merely small:

| control | result |
|---|---|
| carries, mean absolute difference between arms | **0.000e+0** |
| QB targets, mean absolute difference between arms, over 232 QB rows | **0.000e+0** |

The change cannot touch the carry share, and it cannot reach a quarterback
because `targets` is forced to 0 for QBs. If either had moved, the pre-registration
says the primary result is void until it is explained. Neither did.

## 3. Where the gain comes from, and the one place it costs

Descriptive, not a second test:

| position | n | legacy | fitted | difference |
|---|---|---|---|---|
| WR | 967 | 2.5474 | 2.3529 | **+0.1945** |
| TE | 410 | 2.2715 | 2.1007 | **+0.1707** |
| RB | 758 | 1.4484 | 1.4629 | **−0.0146** |
| QB | 232 | 0.0259 | 0.0259 | +0.0000 |

**The whole gain is receivers and tight ends, and running backs pay a little.**
That is the shape the mechanism predicts and it is worth stating plainly rather
than burying: 0.06 was already close to the backs' own mean of 0.0647, so
moving them to their measured mean is a rounding change that happened to land
slightly the wrong way on this season. The receivers and tight ends were the
ones being pulled toward roughly half and two-thirds of their positions'
workload respectively, and they are where the error was.

RB −0.0146 is not separately tested and should not be quoted as a measured
harm; it is one cell of a descriptive split. What is tested is the total.

## 4. The secondary, which was declared in advance so it could not be promoted

Rows with 3-5 prior games, where `K.share = 6` puts six sevenths of the weight
on the prior and any effect should be largest: **554 rows, 262 players,
+0.1740, 90% CI [+0.1052, +0.2403]**.

It is larger than the primary, in the direction and for the reason the
mechanism says. **It is reported because it was pre-registered, not because it
is bigger.** Had the primary come back null, this would not have been the
result.

## 5. The metric that does not agree, and why that is the finding

The pre-registered primary scores only the weeks a player has a usage row —
`weekly-backtest.js:177`, `if (!played) continue`. That metric is blind to
availability. The repository's own availability-inclusive metric,
`decision_including_dnp` (`weekly-backtest.js:170`), keeps a player in the
population if he played the week before and scores a week he missed as a real
**0**. Graded on the same two arms, same seed, same gate:

| metric | n | legacy MAE | fitted MAE | legacy − fitted | 90% CI | significant |
|---|---|---|---|---|---|---|
| conditional on played (**pre-registered primary**) | 2,367 | 1.9005 | 1.7961 | **+0.1044** | [+0.0661, +0.1460] | yes |
| `decision_including_dnp` (**not pre-registered**) | 2,427 | 2.0352 | 2.0488 | **−0.0136** | [−0.0499, +0.0225] | **no** |

**On the availability-inclusive metric the change is a null, not a win.** That
is stated here as the second line of the result rather than as an appendix.

### The level/information decomposition, which says why

Squared error splits exactly into a level term and an information term,
`MSE = ME² + Var(error)`. Both arms, both metrics:

| metric | arm | mean signed error | level (ME²) | information (variance) | de-biased MAE |
|---|---|---|---|---|---|
| conditional | legacy | −0.9764 | 0.9533 | 6.5651 | 1.9780 |
| conditional | **fitted** | **−0.3165** | **0.1002** | **6.0908** | **1.8511** |
| incl. DNP | legacy | −0.4003 | 0.1603 | 7.6716 | 2.0921 |
| incl. DNP | **fitted** | **+0.2486** | **0.0618** | **7.5388** | **2.0440** |

"De-biased MAE" removes each arm's *own* mean error before scoring, so what is
left is the part of the error the level cannot explain. On that measure the
fitted prior wins under **both** metrics, and significantly:

```
conditional   de-biased legacy − fitted  +0.1273  90% CI [+0.0965, +0.1573]  significant
incl. DNP     de-biased legacy − fitted  +0.0482  90% CI [+0.0249, +0.0713]  significant
```

So the two results are not in conflict; they are measuring different things.

- **The prior carries information.** After both arms are level-corrected it is
  ahead on every metric tried. On the conditional metric the de-biased gain
  (+0.1273) is *larger* than the raw gain (+0.1044), which means the legacy
  arm's level error was partly flattering it on MAE rather than costing it —
  what MAE rewards on a right-skewed target distribution with mass at zero is
  not the mean.
- **What the DNP metric exposes is not this prior.** The legacy constant
  under-projected everyone (ME −0.9764 on weeks played). A projection that is
  systematically too low is, by accident, a hedge against the weeks a player
  does not play at all. Raising the pass-catchers to their measured share
  removes the accident, and the DNP-inclusive metric charges for it: the fitted
  arm's level flips to +0.2486. **The model has no availability term, and the
  old constant was quietly standing in for one.**

That is a defect worth its own unit — an availability model — and it is not one
a shrinkage prior should be asked to fix by staying wrong about the population.

### What this does to the decision

The pre-registered decision rule was written against the pre-registered
primary, and on that metric branch 1 fired. Nothing below back-dates it:

- The DNP-inclusive metric was **not** declared in advance. It is reported
  because the auditor asked for it, and it is reported whichever way it came
  out.
- It is a **null**, not a measured harm. Its interval's lower bound, −0.0499,
  sits just inside the −0.05 tolerance the pre-registration had already fixed
  for a straddling interval, which is close enough to the edge to say out loud
  rather than round away.
- **This does not ship on the strength of the primary alone.** It goes to the
  auditor with both metrics on the table, and the claim it may carry is the
  narrow one: *better projected targets on the weeks a player plays, no
  measured improvement once missed weeks are counted, and an information gain
  under both.*

## 6. The auditor's gate-1 criteria, answered

**(i) Fit population = serving population.** Both read the same rows of
`player_week_usage` through the same window, and the conditioning set is
identical: every week with a **non-null** `target_share`, zero-target weeks
included. Measured on the rig for the 2021-2024 fitting window:

| position | known-share weeks | of which zero-target | mean |
|---|---|---|---|
| WR | 9,787 | 1,252 | 0.1322 |
| TE | 4,825 | 532 | 0.0972 |
| RB | 6,112 | 1,851 | 0.0647 |
| QB | 2,615 | 2,588 | 0.0004 |

Rows with a NULL share, excluded from fit and from serve alike: **none on this
rig**, so the null branch is untested here rather than verified. The grading
gate (≥3 prior games, ≥3 opportunities) is a **grading** gate only — the prior
is served to every player, ungated — so it narrows what is scored, not what is
fitted or served.

**(ii) What the QB 0 is.** It is **measured, and it is also a structural zero**,
and the two agree. Measured: 0.0004 over 2,615 weeks, of which 2,588 are zero.
Structural: `projections.js:578` sets `targets = a.pos === 'QB' ? 0 : …`, so no
target-share prior of any value can reach a quarterback's projection. The
quantity is therefore not a shrinkage target that does work; it exists so the
`??` fallback at `positionalPriors()` cannot silently hand a quarterback a
pass-catcher's prior. The QB control coming back at exactly `0.000e+0` is the
check on that, not a claim that the 0 was estimated well.

**(iii) Held-out 2025 graded with `decision_including_dnp`.** Done — section 5.
The conditional metric is **not** defended as sufficient; both are reported and
they disagree.

**(iv) Mean signed error beside MAE on every arm, and the level/information
decomposition.** Done — section 5, both metrics, both arms.

**(v) Power.** **No power check was declared before the run.** That is a real
miss and is recorded as one rather than back-filled: what follows is post-hoc
and cannot be read as a pre-registered gate. From the bootstrap interval,
SE ≈ **0.0243** on the conditional metric and **0.0220** including DNP, so at
the auditor's 1.78 multiplier the smallest effect this sample could have called
at 80% power on a 90% interval is **±0.0432** and **±0.0392** targets per game.
The conditional effect (+0.1044) is about 2.4× that floor. The DNP-inclusive
null is *informative* rather than merely underpowered: the interval
[−0.0499, +0.0225] is narrower than a ±0.0432-scale effect on one side, so a
gain of the size seen on the conditional metric would have been detected there
and was not.

**(vi) The incumbent, stated as behaviour to beat.** Before this change
`projections.js` held `const targetSharePrior = 0.06;` at the call site and
shrank every position's observed target share toward it with `K.share = 6`
(`shrinkSafe(tgtShareObs, 0.06, n, k)`), so a pass-catcher with thin evidence
was pulled toward 0.06 whatever his position. That behaviour is still reachable
and is the arm scored above, as `buildProjections({ sharePrior: 'legacy' })` —
the same code, one flag, not a re-implementation.

**Rig defect to declare: `players.espn_id` is NULL for all 1,483 rows.**
`qbrTrailingForPlayer` returns `null` on a null id (`nfl-qbr.js:129`), so the
QBR nudge is **silently off** on this rig. It is off identically for both arms
and it reaches quarterbacks only, whose projections here differ by exactly
`0.000e+0`, so it cannot move this comparison — but any figure from this rig
that depends on the QBR arm is invalid, and nothing keyed to ESPN ids should be
graded on it until the builder populates that column.

## 7. What this does not say

**It does not say `K.share = 6` is right.** The prior and the weight it carries
interact — a weaker `k` reduces how much any prior matters — so this is a result
about the prior *at the shipped weight*, not about the pair. The fitter says
`K.share` should be nearer 0.4; that is a separate unit and neither may be
tuned on 2025.

**It does not say the change helps a decision that has to account for
availability.** Section 5 measures that directly and it comes back null. The
claim is scoped to weeks the player plays.

**It does not transfer to the points metric.** The measured unit is targets per
game. Whether 0.1 targets moves fantasy points, and by how much, is a different
measurement on a different baseline, and no conversion is offered here.

**It does not speak for players outside the scratch database's 1,483.** The
narrower list is stated in every source label above.

**It is not a claim that the old constant was mistuned.** It was wrong about the
population: 0.06 is not the mean of any position measured here. That is why the
fix is a measurement rather than a search, and why there is no selection to
correct for.

## 8. Reproduction

`grade-share-prior.mjs`, scratchpad, run against the scratch database under
`GRIDIRON_DB_PATH`. It builds both arms per week through the shipped
`buildProjections` with `roleRecency: WEEKLY_ROLE_RECENCY`, gates on raw usage
only (≥3 prior in-season games, prior mean ≥3 targets+carries), scores the
intersection, and uses the repository's own
`backtest-significance.js#pairedBootstrapDiff` with `groups` set to the player
id.

The grade was run twice, with the two arms passed to the bootstrap in both
orders. The figures mirror exactly (`+0.1052` against `−0.1052`,
`[+0.0680, +0.1437]` against `[−0.1435, −0.0678]`), which is the check that the
sign convention is being read the right way round rather than assumed. The
reported orientation is the repository's own, matching
`scripts/grade-opportunity-vs-baseline.mjs:139`.

## The five questions

- **Well built?** The two arms differ in one expression rather than in an
  implementation, the gate reads no model output, the fitting window ends before
  the graded season, and the decision rule was written down first. The two
  controls came back at exactly zero, which is what makes the primary readable.
- **Stats or made up?** Stats. Priors are means of 23,339 rows from 2021-2024;
  the grade is 2,367 player-weeks over 288 players on held-out 2025, paired
  bootstrap clustered by player.
- **How do we know?** Because the incumbent is the same code with one flag, so
  nothing but the prior differs; because carries and quarterbacks — which the
  change cannot reach — moved by exactly zero; because the bootstrap was run in
  both argument orders and mirrored; and because the one metric that disagrees
  with the headline is reported in section 5 with its own interval rather than
  left out.
- **Pointed anywhere else on the platform?** Yes, and that is why it is gated:
  it changes live projections for every pass-catcher. It goes to the auditor
  before any merge.
- **What was missed?** No power check was declared in advance (section 6(v)),
  and the availability-inclusive metric was not pre-registered either — it had
  to be asked for. Both are recorded as misses, not repaired retrospectively.
- **How does it unify?** It closes an open note that had sat in the file since
  2026-09-17 with its own numbers already in it, and it records the estimand —
  count the quiet weeks — that made the material the code was already
  collecting unusable.
