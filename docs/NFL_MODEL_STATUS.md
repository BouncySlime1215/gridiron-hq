# NFL Betting Model — Status and Evidence

Measured 2026-08-07 against `game_lines` (1999–2026, 15,000+ team-rows, closing
spreads and totals with final scores).

Read this before changing the model. Every number here is out-of-sample.

## Where the model stands

Full replay, 2021–2025, ensemble weights and calibration fit strictly on
2015–2020:

| Season | Bets | W-L-P | Win% | Units |
|---|---|---|---|---|
| 2021 | 138 | 72-63-3 | 53.3% | +2.5 |
| 2022 | 193 | 88-103-2 | 46.1% | −23.0 |
| 2023 | 188 | 87-95-6 | 47.8% | −15.9 |
| 2024 | 143 | 80-61-2 | 56.7% | +11.7 |
| 2025 | 136 | 71-64-1 | 52.6% | +0.5 |
| **Total** | **798** | 398-386-14 | **50.8%** | **−24.2** |

After merging the governance branch (per-prediction weight refit, residual-skill
weighting, abstention gate) the model correctly bets far less — 203 bets instead
of 798 — but the remaining bets still lose: **47.0%, −19.7 units**.

Better engineering reduces volume. It does not manufacture edge.

## Why it loses — four independent tests

**1. The closing line is more accurate than the model.**

Margin RMSE: model **13.14**, market **12.66**. The market wins in all five
seasons individually, with no exception.

**2. The model's disagreement with the line carries no information.**

`corr(model edge, ATS outcome) = −0.005` over 1,424 games. By season: 0.007,
0.069, −0.011, −0.005, −0.096. That is zero.

**3. The best component model is the one that copies the market.**

Per-model margin RMSE, 2021–25:

```
market_anchor       12.66   <- ties the closing line
market_regression   12.67
epa_net             13.46
melo                13.50
success_rate        13.56
...
opp_adjusted        16.14
recent_form         16.17
MARKET (close)      12.66
```

Every genuinely independent model is worse than the line. Blending numbers that
are all worse than the line produces a number worse than the line.

**4. No blend can fix it.**

Ridge market-residual model over all 18 independent components (train 2021–23,
test 2024–25), target = `actual_margin − market_margin`:

```
lambda      out-of-sample R2
1           -0.0023
10          -0.0025
100         -0.0022
1000        +0.0005
10000       +0.0007
```

R² ≈ 0 at every regularisation strength. There is no linear combination of these
components that adds information the closing line lacks.

Win rate by model edge bucket is correspondingly non-monotonic — 51.2%, 51.1%,
50.8%, 46.0%, 44.0%, 58.1%. If the edge meant anything, this would rise. The
58.1% top bucket (n=129) is noise, and it is exactly the kind of artifact that
makes a dead model look alive.

### A correction that was noise

`nfl-replay.js` documents `maxDisagreement = 4.5` as a correction validated on
holdout (2022-23 discovery, 2024-25 holdout, −1.8% → +2.2% ROI). Given
`corr ≈ 0` in every season, that filter survived holdout by luck. Treat the
holdout-validation harness as necessary but not sufficient: with enough
candidate filters, one will clear any single holdout. Prefer pre-registered
hypotheses and out-of-sample R², which cannot be gamed the same way.

## What +30 units a season actually requires

Flat 1u at −110: `units = n × (1.909p − 1)`.

| Volume | Win rate needed for +30u |
|---|---|
| ~270 bets (every game, one side) | **58.2%** |
| ~540 bets (every game, spread + total) | **55.3%** |
| ~85 bets (5 picks/week) | **70.9%** |

For scale, on 540 bets/season: 53% → +6u, 54% → +17u, 55% → +27u. Documented
elite long-run NFL ATS handicapping is roughly 53–54%. Sustaining 55.5%+ against
closing lines every season is beyond what anyone has publicly demonstrated.

A model that reliably returns **+8 to +15 units a season** would be genuinely
excellent, and that is the target worth building toward.

## Staking: flat beats Kelly at realistic edges

Monte Carlo, 20,000 seasons per cell. 1 unit = 1% of starting bankroll.
Kelly = 0.25 fractional Kelly sized on live bankroll.

| Win% | n | Scheme | Median units | P(+30u) | P(losing season) | Mean max DD |
|---|---|---|---|---|---|---|
| 50.0 | 540 | flat | −24.5 | 0.7% | 86.1% | 37% |
| 50.0 | 540 | kelly | 0.0 | 0.0% | 0.0% | 0% |
| 52.4 | 540 | flat | +0.3 | 9.4% | 48.4% | 24% |
| 53.0 | 540 | flat | +6.0 | 14.5% | 37.2% | 22% |
| 53.0 | 540 | kelly | +1.7 | 0.0% | 40.8% | 8% |
| 54.0 | 540 | flat | +17.5 | 27.6% | 21.7% | 18% |
| 54.0 | 540 | kelly | +14.0 | 22.5% | 24.1% | 17% |
| 55.0 | 540 | flat | +27.0 | 44.1% | 10.7% | 16% |
| 55.0 | 540 | kelly | +38.4 | 58.6% | 14.0% | 23% |
| 57.0 | 540 | flat | +48.0 | 78.7% | 1.5% | 12% |

Conclusions:

- **At zero edge, Kelly stakes zero.** That is the correct answer, and it is why
  the abstention gate matters more than any sizing rule.
- **Flat outperforms fractional Kelly below ~55%.** At a realistic 53–54% edge,
  Kelly's stake is smaller than 1% of bankroll, so it under-bets. Kelly only
  wins once the edge is large.
- This simulation assumes the true `p` is *known*. In practice `p` is estimated,
  and estimation error makes Kelly materially riskier than shown — which
  strengthens the case for flat staking.
- **Recommendation: flat, 1u = 1% of bankroll.** Revisit only if a strategy
  demonstrates >55% over a large, genuinely out-of-sample sample.

## Where real edge is still available

Ranked by evidence, not by appeal.

**1. Line shopping — real, measurable, already partly instrumented.**

From 652 multi-book markets in `nfl_line_snapshots`: books disagree on the
number **20.9%** of the time, mean gap **0.225 points**, and taking the best
price is worth **+0.019 in decimal odds** (~1.5–2.5% ROI combined). This is the
one edge that does not require beating the market's opinion — only its price.

Caveat: only **2.7 books** quote each market in the current feed, and
DraftKings is 54% of all rows. Expanding book coverage is the direct lever, and
the captured value scales with it.

**2. Closing line value — the correct success metric, not yet measurable.**

`open_spread` and `open_total` are NULL for all 15,000 historical rows, and
`nfl_line_snapshots` holds a single capture timestamp (2026-08-05), so CLV
cannot be computed retroactively. Capturing lines on a schedule from now on
turns CLV into a leading indicator — it tells you whether an edge is real after
~50 bets instead of after two seasons of win/loss noise.

**3. Player props — softest market, highest upside, needs data first.**

Sides and totals are the most efficient NFL markets; props are materially
softer. But zero historical NFL prop results are stored, so nothing can be
validated yet. This starts as a data acquisition project.

**4. Beating the closing line on sides — direct but low odds.**

The gap to close is 13.14 → below 12.66 RMSE. The largest missing variable is
QB-adjusted team strength; injury data exists only for 2023–2025 (17,595 rows),
which is a thin base for fitting. Worth attempting, but the market prices all of
this, and the four tests above are what a failed attempt looks like.

## Three strategies that do not rescue a zero edge

All three are ways to bet a signal more efficiently. None of them create one,
and each was tested rather than assumed.

### Betting only a few games a week

Taking the model's highest-conviction picks each week, out of sample:

| Picks/week | Bets | Win% | Units | z vs 52.4% |
|---|---|---|---|---|
| 1 | 94 | 47.9% | −8.1 | −0.88 |
| 2 | 186 | 47.8% | −16.1 | −1.24 |
| 3 | 275 | **45.1%** | **−38.3** | −2.42 |
| 5 | 441 | 50.1% | −19.1 | −0.96 |
| all | 1152 | 51.0% | −31.4 | −0.98 |

The conviction picks are the *worst* ones. Top-3 at 45.1% is significantly below
break-even. Selectivity is not a filter on a signal that does not exist — it
concentrates whatever the model is most wrong about.

### Sizing by model confidence

Win rate by conviction bucket: 51.7%, 48.9%, 54.7%, 50.0%, 46.6%, 56.0%. No
trend. Confidence does not predict accuracy, so staking more on confident picks
raises variance without raising expected value — strictly worse risk-adjusted.

### Parlays

The usual claim that parlays carry a worse edge is not quite right at standard
payouts. Break-even win rate *per leg*:

| Legs | Payout | Break-even per leg |
|---|---|---|
| 1 | +191 | 52.38% |
| 2 | +260 | 52.70% |
| 3 | +600 | 52.28% |
| 4 | +1200 | 52.66% |
| 6 | +4600 | 52.64% |

Roughly the same threshold regardless of size. Parlays are neither a trick nor a
trap — they are **pure leverage on the edge you already have**:

| Per-leg win% | 1-leg EV | 2-leg EV | 3-leg EV | 4-leg EV |
|---|---|---|---|---|
| 50.0% | −4.54% | −10.00% | −12.50% | −18.75% |
| 52.4% | +0.04% | −1.15% | +0.71% | −1.99% |
| 54.0% | +3.09% | +4.98% | +10.22% | +10.54% |
| 57.0% | +8.82% | +16.96% | +29.64% | +37.23% |

At the model's actual 50%, three-leg parlays lose **12.5%** instead of 4.5% —
they triple the bleed. At a real 54% edge they would roughly triple the return,
but at much higher variance: simulated over a season at 54% legs, three-leggers
returned 8.6u against 8.0u for singles while the 10th-percentile outcome fell
from −12.3u to −20.0u.

Two caveats that make real parlays worse than this table: same-game parlays have
correlated legs that books price with far higher hold, and many books pay less
than the standard ladder above.

The conclusion is the ordering, not the arithmetic. Parlays are worth revisiting
*after* an edge is demonstrated, never as a way to manufacture one.

## Following the sharp money

The one approach that does not require out-forecasting anyone, and the most
promising thing in this document.

"The market" is not one number. A few books price for accuracy because they take
size from winning players; the rest price for volume, shade toward public
sentiment, and move late. That gap is free to observe.

Pinnacle — the reference price in this sport — was missing entirely, because
`gameOdds` could only request the `us` region and Pinnacle lives in `eu`. With
`us,eu` the board sees **pinnacle, lowvig and betonlineag**, and a first live run
found **19 recreational numbers stale against the sharp consensus** across 272
games, the largest worth ~4.2%.

`nfl-sharp.js` implements three reads:

- **`sharpDivergence`** — recreational books offering a number the sharp
  consensus has already moved off, priced with the same distribution CLV uses.
- **`steamMoves`** — several books moving the same direction at once, which is
  money arriving rather than a bookmaker adjusting.
- **`sharpScorecard`** — whether bets sourced this way actually closed better.

The last one is the point. Every divergence is a falsifiable claim that a book is
stale; if the claim is false, those bets will not beat the close, and the ledger
will say so within about fifty bets instead of two seasons.

## Player props

Correcting an earlier assumption: prop *results* are not missing. 
`nfl_player_week_features` holds 52,231 player-weeks for 2016–2025 including
`passing_yards`, `rushing_yards`, `receiving_yards`, `receptions` and touchdowns.
Only historical prop *lines* are absent — and live props work on the current API
tier (HTTP 200; yardage markets are simply unposted a month out, while anytime-TD
is already quoted). Recording lines from Week 1 builds the dataset for free.

Walk-forward projection accuracy, 2021–25:

| Market | n | MAE | RMSE | Bias |
|---|---|---|---|---|
| Passing yards | 2,928 | **70.4** | 90.4 | +2.6 |
| Rushing yards | 10,742 | 17.0 | 25.1 | +0.0 |
| Receiving yards | 21,009 | 18.9 | 26.3 | +1.2 |
| Receptions | 21,009 | 1.43 | 1.90 | +0.08 |

Passing yards at 70 MAE against a ~240-yard mean is not close to bettable.

The touchdown model has a larger and more specific problem — it is systematically
over-confident:

| Predicted | Actual | n |
|---|---|---|
| 34.7% | 28.3% | 2,899 |
| 44.6% | 36.2% | 1,968 |
| 54.7% | **41.9%** | 1,211 |
| 64.8% | **52.5%** | 904 |
| 75.0% | 71.1% | 765 |
| 84.9% | 80.3% | 854 |

Ten to thirteen points of over-prediction through the middle of the range.
Betting these overs would lose badly. This is a concrete, fixable defect rather
than an absence of signal: the ordering is monotonic, so a Platt or isotonic
recalibration fitted walk-forward should correct most of it. That is the first
thing to do before any prop is bet.

## Retrospective prop replay — the first real signal

`nfl-props-replay.js` grades every prop walk-forward, 2021–25. With no historical
prop lines, the bet has to be placed against something, and that choice decides
whether the answer means anything. The proxy is deliberately strong: a
recency-weighted trailing average of the player's own production, shrunk and
rounded to the half point. It was then checked for fairness — a biased proxy
would hand out a fake edge:

| Market | n | Under win% (50% = fair line) |
|---|---|---|
| Passing yards | 2,040 | 49.0% |
| Rushing yards | 4,350 | **43.7%** |
| Receiving yards | 12,255 | 49.5% |
| Receptions | 12,265 | **50.1%** |

Receptions is essentially a perfectly fair line; rushing yards is not, so its
result is discounted accordingly.

Graded at **−115** (typical prop juice, break-even 53.49%, not 52.38%):

| Market | Bets | Win% | Units | ROI | z vs break-even |
|---|---|---|---|---|---|
| Passing yards | 176 | 38.6% | −48.9 | −27.8% | −3.94 |
| Rushing yards | 1,491 | 45.5% | −223.4 | −15.0% | −6.19 |
| Receiving yards | 6,105 | 49.3% | −477.6 | −7.8% | −6.54 |
| **Receptions** | **6,973** | **54.2%** | **+94.0** | **+1.3%** | **+1.20** |
| Overall | 14,745 | 51.1% | −656.0 | −4.4% | −5.78 |

Props as a whole lose badly. Receptions is the exception, and it is the first
genuine signal found anywhere in this project:

- **z = 7.03 against a fair coin.** The model predicts receptions better than
  chance by seven standard errors. That is skill, not noise.
- **z = 1.20 against the −115 break-even.** The juice eats almost all of it.
- Positive in four of five seasons (+25, +9, +89, +12, −41).

There is a mechanism, which matters — this is not a black box result. The proxy
averages past receptions; the model projects targets separately from catch rate.
Targets are markedly more predictable than receptions, and catch rate is stable,
so decomposing the two genuinely forecasts better.

**Price is almost the whole story here:**

| Price | ROI |
|---|---|
| −115 | +1.30% |
| −110 | +3.49% |
| −105 | +5.84% |

Getting −110 instead of −115 nearly triples the return. This is where line
shopping stops being a rounding error and becomes the difference between a
strategy and a hobby.

**The caveat that prevents this from being a green light:** the proxy is not a
real book. DraftKings also prices targets times catch rate — it is not hanging a
naive trailing average. The edge measured here is over a weaker opponent than
the one you would actually face, and 2025, the most recent season, was negative.

The correct next step is not to bet it. It is to capture live receptions lines
from week 1, compare them to the proxy to see how much sharper a real book is,
and let the CLV ledger judge it.

## Rules for changing this model

1. Judge changes by **out-of-sample R² against the market residual**, not by
   backtested win rate. Win rate over a few hundred bets cannot distinguish a
   2% edge from noise; R² can.
2. A filter that improves ROI on holdout is not validated if the underlying
   signal correlation is zero. Check the correlation first.
3. Abstention is a valid, and usually correct, output.
4. Report CLV once it is available. It is the only fast feedback signal in
   sports betting.
