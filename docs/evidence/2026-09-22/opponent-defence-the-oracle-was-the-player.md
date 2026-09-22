# Opponent defence, reopened and now closed: the oracle was the player

**Verdict: declined, and this time on its own ceiling rather than on a
forecasting failure.** Even a hindsight measure of the opponent's pass defence
in the very week being predicted — the best any opponent-defence feature could
ever be — does not detectably improve a weekly fantasy projection, once the
player's own targets are removed from that measure.

The finding that matters beyond this feature: an earlier version of the same
oracle showed a large, clean, 5-of-5-seasons lift. It was correlated **+0.953**
with the honest version. Essentially all of its lift came from the 5% of
variance that is the player leaking back into his own feature.

---

## 1. Why this was reopened

`phase-a-ol-vs-dl-lift-proof.md` declined an opponent term for two reasons.

One died on 2026-09-22. The wiring trace in `opp-adj-def-epa-wiring-audit.md`
showed `opp_adj_def_epa` reaches the betting surface only — no fantasy service
references it — so "the model already has opponent-defence information" was
false for the product this work is about.

The other was weak. The replication was a single split: train 2018-21 / test
2022-25, then the reverse. **Era and training-set size moved together**, so a
failure could have been either one. That is not a result a feature should be
killed on.

The coordinator approved a cleaner design. This is it.

## 2. The design

**Rolling origin with a fixed training span.** Test season `S` is predicted by a
model trained on exactly seasons `[S-3, S-1]`. Every replicate has a training
window of the same *length*; only the era moves. Five replicates, 2021 through
2025.

Training sizes, printed rather than assumed:

| test season | training span | n_train | n_test | baseline R² |
|---|---|---|---|---|
| 2021 | 2018-2020 | 8,879 | 3,268 | 0.3092 |
| 2022 | 2019-2021 | 9,265 | 3,297 | 0.3085 |
| 2023 | 2020-2022 | 9,644 | 3,384 | 0.3561 |
| 2024 | 2021-2023 | 9,949 | 3,324 | 0.3414 |
| 2025 | 2022-2024 | 10,005 | 3,352 | 0.3300 |

Training size still drifts 12.7% across the five, because rosters and snap-share
coverage grow. It is not perfectly constant and is not claimed to be. Against
the old split-half, where the two halves differed by the whole span, it is a
different order of confounding.

Everything else follows the standing method: features from the player's earlier
weeks in the same season only, training seasons strictly earlier than the test
season, fixed feature divisors so no test statistic leaks through scaling,
paired bootstrap resampled **by player** on squared error.

**The treatment** is the opponent's mean pass EPA allowed over the opponent's
own earlier weeks in the same season — what a human means by "he draws a soft
defence this week", computed causally. 25,492 player-weeks, WR/TE/RB, 2018-2025.

## 3. The contamination

The first pass used the obvious positive control: the opponent's **actual** pass
EPA allowed in the week being predicted. It fired enormously — +1.5496 MSE,
95% CI [+1.2140, +1.8945], better in 5 of 5 seasons.

That control is contaminated. A receiver who goes for 30 points **is part of
what made that defence look bad that week**. The feature can see the target
through the defence's own box score.

So it was rebuilt from play-by-play, leaving the player out: the opponent's pass
EPA allowed that week over the plays *not thrown to this player*
(`build_defloo.py`, 4,316 team-weeks and 34,686 team-week-receiver contributions
from `pbp_2018..2026.csv`).

The two versions are nearly the same number:

| | |
|---|---|
| corr(naive oracle, leave-player-out oracle) | **+0.9530** |
| mean abs difference | 0.0681 EPA/play |
| spread of the truth (sd) | 0.3387 EPA/play |

And they behave completely differently:

| oracle | ΔMSE | 95% CI | seasons improved | verdict |
|---|---|---|---|---|
| naive (contaminated) | **+1.5496** | [+1.2140, +1.8945] | 5/5 | DETECTED |
| leave-player-out | +0.0533 | [-0.0065, +0.1156] | 3/5 | no detection |

**A feature correlated 0.953 with a legitimate one carried 29x the lift.**
Around 97% of what the naive oracle appeared to be worth lived in the 5% of its
variance that is the player's own week.

This is the trap, stated generally so it is not walked into again: **any feature
built from a same-week team aggregate contains the player's own contribution to
that aggregate.** Team passing volume this week, team red-zone trips this week,
opponent yards allowed this week — all the same shape. The correlation between
the contaminated and clean versions will look reassuringly high and will tell
you nothing.

## 4. The results

Baseline: 16,620 pooled out-of-sample predictions, R² 0.32957, MSE 39.1348.
Var(y) = 58.373, so ΔMSE 0.0584 ≈ ΔR² 0.001.

| arm | ΔMSE | 95% CI | seasons improved | verdict |
|---|---|---|---|---|
| TREATMENT prior-weeks defence | +0.0265 | [-0.0303, +0.0831] | 4/5 | no detection |
| CONTROL shuffled within season-week | -0.0036 | [-0.0108, +0.0039] | 2/5 | null, as required |
| CONTROL no-op (duplicate column) | -0.0002 | [-0.0017, +0.0014] | 3/5 | null, as required |
| SYNTH forecast r=0.10 | -0.0050 | [-0.0153, +0.0061] | 2/5 | no detection |
| SYNTH forecast r=0.20 | -0.0037 | [-0.0188, +0.0124] | 2/5 | no detection |
| SYNTH forecast r=0.30 | +0.0202 | [-0.0123, +0.0523] | 4/5 | no detection |
| SYNTH forecast r=0.40 | +0.0194 | [-0.0187, +0.0570] | 4/5 | no detection |
| SYNTH forecast r=0.60 | +0.0186 | [-0.0185, +0.0560] | 3/5 | no detection |
| ORACLE leave-player-out (r=1.0) | +0.0533 | [-0.0065, +0.1156] | 3/5 | no detection |
| ORACLE naive (contaminated) | +1.5496 | [+1.2140, +1.8945] | 5/5 | detected, and meaningless |

Both controls are null, so the harness is not manufacturing lift from a column
width or from the feature's marginal distribution.

The SYNTH rows were built to answer "how good would a defence forecast have to
be before it is worth wiring?" — synthetic forecasts with a *known* correlation
to the clean truth. The sweep answers the question by refusing to bend:
**nothing detects at any correlation, because the ceiling itself does not
detect.** The question was the wrong one.

For the record, the measured forecast skill of the causal estimator is
**corr(prior-weeks estimate, clean truth) = +0.1219**. Low, and now beside the
point.

## 5. What this actually means

The most favourable reading available — the top of the clean oracle's confidence
interval — is ΔMSE +0.1156, which is **+0.00198 R² on a baseline of 0.32957, or
0.3% of the model's error.** That is the *optimistic* end of a perfect-hindsight
feature. The point estimate is +0.00091 R² and the interval contains zero.

**Corrected 2026-09-22.** An earlier version of this paragraph cited
`weekly-ceiling-the-model-is-already-there.md` as putting the model at 98.9% of
a hindsight oracle with total headroom of +0.0037 R², and argued that an
opponent term claiming a quarter of that headroom was never plausible. **That
ceiling figure is withdrawn** — see that document's v2, which measures the
headroom at about +0.067 R² instead. Against the corrected figure the oracle
here claims roughly 3% of the headroom, not 25%.

**The result above is unaffected**, because it never rested on the ceiling
number. It rests on its own leave-player-out hindsight oracle measured on these
rows: +0.00198 R² at the optimistic end of the interval, point estimate
+0.00091, interval containing zero. A feature whose *perfect-hindsight* form
cannot clear its own confidence interval does not become viable because there
is more headroom elsewhere.

**The honest limit of this result.** What is dead is *team-level pass defence
quality* as a weekly fantasy feature. A team-week EPA average is coarse. It does
not test a specific cornerback-on-receiver matchup, or scheme-level coverage
rates against a player's route tree. Those are different features that this
experiment says nothing about — and both are behind paid feeds
(`docs/data/missing-data-register.md`). What can be said is that the free,
team-level version has had its ceiling measured and the ceiling is not there.

## 6. Reproduction

Scratchpad, not the repo; pure Python 3, no numpy/pandas/sklearn in this
container.

- `build_defloo.py` — reads `pbp_<season>.csv` 2018-2026, writes per-team-week
  pass EPA totals and per-receiver contributions. ~13 s.
- `oppdef.py` — part 1: rolling origin, treatment, shuffled, no-op, naive
  oracle. ~10 s.
- `oppdef2.py` — part 2: adds the leave-player-out oracle and the synthetic
  forecast sweep. ~30 s.

One data note carried honestly: 1 of 4,316 team-weeks in `defq.json` (a 2021
week) has a null pass EPA. It is dropped, not imputed.

## The five questions

- **Well built?** Yes, and it corrected its own positive control mid-experiment
  rather than reporting the number that flattered the feature.
- **Stats or made up?** Stats. 25,492 player-weeks, 16,620 out-of-sample
  predictions over 5 held-out seasons, 2,000-iteration paired bootstrap
  resampled by player, two null controls and a swept synthetic forecast.
- **How do we know?** The ceiling was measured directly: a hindsight feature the
  model could never have, cleaned of the target, still does not move the error.
  Both controls returned null on the same harness that detected the
  contaminated oracle at 29x, so the harness demonstrably has the power to see
  an effect of that size.
- **Pointed anywhere else on the platform?** No production code changes. The
  contamination finding in §3 points at every future feature built from a
  same-week team aggregate.
- **How does it unify?** Sixth deep feature tested, sixth declined, and the
  sixth consistent with the weekly ceiling: the weekly model is close to what
  weekly information can support, and the remaining error is the week itself.
