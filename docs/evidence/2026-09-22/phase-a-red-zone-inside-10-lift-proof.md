# Phase A, red-zone touches inside the 10 — the lift proof, and the verdict

Ran 2026-09-22, immediately after routes run. **Verdict: inside-the-10 usage
does not earn a place. Neither does inside-the-20.** Same harness, same
controls, same gate.

There is a structural finding underneath the two negatives, in §5, and it
matters more than either result.

## 1. The feature

From `play_by_play`, a touch inside a zone is a rush attempt credited to
`rusher_player_id` or a pass attempt credited to `receiver_player_id` with
`yardline_100` at or under the boundary. A target counts even when uncaught,
because the question is whether the coach pointed the ball at this player that
close to the line.

2018-2025, regular season: 34,982 inside-20 touches, of which 17,131 (49.0%)
are inside the 10. 17,536 of 40,601 player-weeks (43.2%) carry at least one.
Median prior inside-10 usage is 0.308 per game, maximum 5.75.

Nothing in the tree does this today. `grep -rn "yardline_100 <= 10|inside_10|rz_10|inside10" server/`
returns nothing, and the existing `red_zone_plays` at `nfl-features.js:61` is
*team*-level plays inside the 20, not per-player touches.

## 2. The gate

The baseline already knows prior targets, receptions, receiving yards, prior
PPR, snap share, games played and position. Target is the player's points that
week, and separately their touchdowns, since touchdowns are what red-zone usage
should actually drive.

| target | model | MSE | R² | gain vs baseline, 95% CI | verdict |
|---|---|---|---|---|---|
| TD | full baseline | 0.26595 | 0.0979 | — | — |
| TD | + inside-20 | 0.26570 | 0.0987 | +0.00025 [-0.00015, +0.00063] | not detected |
| TD | + inside-10 | 0.26579 | 0.0984 | +0.00015 [-0.00012, +0.00042] | not detected |
| TD | + both zones | 0.26577 | 0.0985 | +0.00018 [-0.00023, +0.00058] | not detected |
| PPR | full baseline | 40.74978 | 0.3218 | — | — |
| PPR | + inside-20 | 40.73043 | 0.3222 | +0.01966 [-0.01292, +0.05235] | not detected |
| PPR | + inside-10 | 40.75410 | 0.3218 | -0.00426 [-0.01584, +0.00642] | not detected |

On the original MAE instrument the inside-10 gate read +0.0004 PPR, 95% CI
[-0.0011, +0.0020] — the same answer.

Controls: shuffling inside-20 within season-week-position makes it slightly
*worse* on the TD target (-0.00010, CI [-0.00019, -0.00002]), which is the
expected behaviour of pure noise; the duplicated-snap-share no-op moves nothing
(-0.00000).

## 3. It is redundancy again, not absence

Against a deliberately weak baseline (prior PPR and games only), both zones are
real signal:

| feature added | MSE gain on TDs | 95% CI | verdict |
|---|---|---|---|
| inside-20 touches | +0.00123 | [+0.00048, +0.00203] | **DETECTED** |
| inside-10 touches | +0.00105 | [+0.00045, +0.00170] | **DETECTED** |

So red-zone usage genuinely predicts touchdowns. It stops paying the moment the
baseline knows targets and snap share, because those already carry it.

## 4. Non-linearity ruled out, as far as a linear model can

Three non-linear encodings of inside-10, all against the same full baseline,
none detected on either target: squared plus step-coded at 1 and 2 touches
(TD +0.00004, CI [-0.00039, +0.00048]); interacted with each position
(+0.00007, CI [-0.00038, +0.00049]); interacted with snap share (+0.00018, CI
[-0.00017, +0.00051]).

**Stated limit:** this is ridge regression. A gradient-boosted tree ensemble
could in principle find interaction structure that these hand-specified terms
do not, and this container has no numpy, pandas or sklearn. I probed the
obvious non-linear forms and found nothing; I cannot claim to have ruled out a
tree model. That is the one honest gap in this result.

## 5. The structural finding, which outlives both features

Two features tested, the same shape of answer twice:

- Route share: real signal, statistically indistinguishable from snap share.
- Red-zone touches: real signal, fully absorbed by targets plus snap share.

Both are **opportunity-volume proxies**, and this model's volume channel is
already saturated by `targets` and `offense_pct`. Weekly PPR R² sits at 0.3218
and did not move past 0.3222 for anything tried. Adding a third, fourth or
fifth way to measure how often a player was in position to be used should be
expected to return approximately zero, and the two experiments here are
evidence for that expectation rather than two unlucky draws.

If that reading is right, the remaining items on the deep predictive feature
set split cleanly, and only the second group is worth harness time:

- **Volume proxies, expect nothing**: team pace and play volume, routes run
  (done), red-zone touches (done).
- **Not volume proxies, worth testing**: practice participation (availability
  — a different axis entirely, and already built at `contingency.js:125-144`,
  so it should be measured rather than rebuilt); depth-chart change (role
  change, which volume features only see *after* it shows up); OL-vs-DL
  matchup (blocking quality, which changes the value of a touch rather than
  its count); coaching tendency conditioned on situation.

Recommendation: stop testing volume features and take practice participation
next, since it is already built and is the cleanest non-volume axis available.

## 6. Instrument faults found in this run

1. **MAE is degenerate on a zero-inflated count target.** Touchdowns average
   0.2651 per player-week with 22.1% non-zero, so predicting near zero for
   everyone is nearly MAE-optimal and the mean-absolute instrument cannot see a
   feature that sharpens the tail. Detected because a feature I expected to do
   *something* returned an implausible flat zero. Switched to squared error for
   that target; the PPR results keep MAE, where the instrument is shown to have
   power (prior targets +0.0184, CI [+0.0121, +0.0250]).
2. **A badly chosen positive control.** I used prior touchdowns per game as the
   positive control on the TD target. It is near-collinear with prior PPR,
   which is already in the baseline, so it correctly showed nothing — and for a
   few minutes I read that as the instrument failing. A positive control has to
   be a feature the baseline does *not* already contain.

## The five questions

- **Well built?** Nothing shipped, deliberately. Two features measured, both
  declined.
- **Stats or made up?** Stats. 25,523 out-of-sample player-weeks, 34,982
  red-zone touches, every interval stated.
- **How do we know?** Purged walk-forward by season-week, features from prior
  weeks in-season only, fixed feature scaling, paired bootstrap by player, and
  two controls per gate.
- **Pointed anywhere else on the platform?** No. It did not earn a consumer.
- **How does it unify?** It does not, and §5 is the useful answer: the volume
  channel is saturated, so unification has to come from a different axis.
