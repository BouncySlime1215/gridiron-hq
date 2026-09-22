# The target-share prior, graded: +0.1044 targets of MAE on held-out 2025

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

| arm | MAE, projected targets per game |
|---|---|
| legacy single 0.06 prior | 1.9005 |
| **per-position prior** | **1.7961** |
| **legacy − fitted** | **+0.1044** |

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

## 5. What this does not say

**It does not say `K.share = 6` is right.** The prior and the weight it carries
interact — a weaker `k` reduces how much any prior matters — so this is a result
about the prior *at the shipped weight*, not about the pair. The fitter says
`K.share` should be nearer 0.4; that is a separate unit and neither may be
tuned on 2025.

**It does not transfer to the points metric.** The measured unit is targets per
game. Whether 0.1 targets moves fantasy points, and by how much, is a different
measurement on a different baseline, and no conversion is offered here.

**It does not speak for players outside the scratch database's 1,483.** The
narrower list is stated in every source label above.

**It is not a claim that the old constant was mistuned.** It was wrong about the
population: 0.06 is not the mean of any position measured here. That is why the
fix is a measurement rather than a search, and why there is no selection to
correct for.

## 6. Reproduction

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
  change cannot reach — moved by exactly zero; and because the bootstrap was run
  in both argument orders and mirrored.
- **Pointed anywhere else on the platform?** Yes, and that is why it is gated:
  it changes live projections for every pass-catcher. It goes to the auditor
  before any merge.
- **How does it unify?** It closes an open note that had sat in the file since
  2026-09-17 with its own numbers already in it, and it records the estimand —
  count the quiet weeks — that made the material the code was already
  collecting unusable.
