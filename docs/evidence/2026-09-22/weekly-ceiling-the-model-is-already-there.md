# The weekly model is already at the ceiling of player-level features

Measured 2026-09-22, after four features from Nick's deep predictive set were
tested and all four declined. This document is why they declined. It is the most
important result of the four runs and it should be read before anyone builds
feature five.

## The number

Compared on **identical rows** — the 24,801 out-of-sample player-weeks the
walk-forward model actually scored, for player-seasons with at least three
scored weeks:

| | R² | MAE |
|---|---|---|
| the model — prior weeks only, strictly causal | 0.3186 | 4.8062 |
| a **hindsight oracle** that knows each player's own season mean | 0.3223 | 4.7167 |

The oracle is given each player's average score across their whole season,
leave-one-week-out so it never sees the week it is predicting. It is not a
model anyone could build: it uses future weeks. It is the answer to "how well
could you possibly do if you knew exactly how good this player is, and nothing
else about the week".

**The model captures 98.9% of that oracle's R².** The entire remaining headroom
for any feature that describes a *player* is **+0.0037 R² and +0.0895 MAE.**

And the variance decomposition on the same rows:

```
between-player share of variance   0.4548
within-player, week to week        0.5452   <- no player-level feature can touch this
```

Fifty-four percent of weekly fantasy scoring is a player varying against
himself, week to week. That is the game, not a gap in the feature set.

## Why four features failed, in one sentence

Each of them described a player, and the model already knows the players as
well as perfect hindsight does.

| feature | measured gain | share of the 0.0895 MAE headroom |
|---|---|---|
| depth-chart rank | +0.0031 MAE | 3.5% |
| practice participation | +0.0007 MAE | 0.8% |
| route share | +0.0008 MAE | 0.9% |
| red-zone touches inside 10 | +0.0004 MAE | 0.4% |

None cleared its confidence interval. They were not competing for a large
prize; they were competing for a ninth of a fantasy point, and the baseline's
prior-weeks averages had already taken almost all of it.

This also explains a result that looked strange on its own: depth-chart rank
separates production enormously in the raw data — rank 1 averages 10.91 PPR,
rank 2 5.73, rank 3 4.23 — and still adds nothing. The gradient is real. It is
simply already inside `targets` and `offense_pct`.

## What this does and does not say

**It does not say the model is good.** R² 0.3186 on weekly points is a modest
model, and a projection this uncertain should never be displayed as a bare
number.

**It does not say feature engineering is over.** It says one *class* of feature
is exhausted: anything that describes a player's role, volume, availability, or
depth position. To beat the hindsight oracle, a feature has to carry
**week-specific** information — something that makes *this* week different for
this player, which a season-long average of him cannot contain:

- **opponent matchup** — including the OL-vs-DL item still on Nick's list, which
  is week-specific by construction and is therefore the one remaining item of
  the seven with a live case
- **teammate availability** — the target that opens up when the other receiver is
  out, which `contingency.js`'s availability build already has the raw material for
- **game script and pace as an opponent-adjusted pairing**, not as a team's own
  season tendency, which is just another player-invariant average
- **weather and venue**, not on the original list

Those are the features worth harness time. A fifth player-descriptive feature
is not, and the number above is the reason to say so before spending the time
rather than after.

## The recommendation this implies

Two things, and the second is a decision above this thread.

1. **Test only week-specific features from here.** Re-order the remaining set
   accordingly: OL-vs-DL first, teammate availability second, opponent-adjusted
   pace third, and drop the player-descriptive remainder.

2. **Ship the uncertainty, not just the projection.** With 54.5% of weekly
   variance irreducible from player identity, the honest surface for a weekly
   projection is an interval, not a point. A model at R² 0.32 that prints
   "11.4 points" is making a claim the data does not support; the same model
   printing a range, with the range *earned* from the measured residual spread,
   is telling the truth and is more useful for a start/sit decision. This is a
   product decision, not a modelling one.

Nick set the bar at "no feature gets in on vibes". The same standard applied
symmetrically says: with the headroom measured at 0.0037 R², continuing to add
player-descriptive features *because the list says so* would itself be the vibes
answer.

## Method, so this can be checked or overturned

- Population: 24,801 out-of-sample player-weeks, 2018-2025, WR/TE/RB, active
  weeks only, from the same purged walk-forward that produced every other number
  in this series. Features from prior weeks in-season only; fixed feature
  divisors so no test statistic leaks through scaling.
- Oracle: per player-season mean of the scored weeks, leave-one-week-out. R² is
  computed against the same grand mean for both models so the two are
  comparable.
- The oracle is deliberately *weak* in one respect and strong in another: it
  knows nothing about the week, and it knows the player perfectly. That is
  exactly the contrast this document needs.
- **Stated limit:** ridge regression, and this container has no numpy, pandas or
  sklearn. A tree ensemble could extract interactions this cannot. But note the
  ceiling argument is largely model-free: it comes from a variance
  decomposition, and no model of player-level features can explain within-player
  week-to-week variance.
- One asymmetry worth naming: the oracle's MAE advantage (0.0895) is
  proportionally larger than its R² advantage (0.0037), because MAE rewards
  getting the middle of the distribution right. That is why the MAE headroom is
  quoted as the budget features compete for.

## The five questions

- **Well built?** This is a measurement, not a build. Nothing shipped from it.
- **Stats or made up?** Stats. 24,801 out-of-sample predictions against an
  explicitly-defined oracle on identical rows.
- **How do we know?** The oracle is reproducible in a dozen lines from the same
  player-week table; the variance decomposition is arithmetic on the same rows.
- **Pointed anywhere else on the platform?** Not yet, and recommendation 2 is a
  proposal that it should be — as an interval on every projection surface.
- **How does it unify?** It tells every future feature where to look: at the
  week, not at the player.
