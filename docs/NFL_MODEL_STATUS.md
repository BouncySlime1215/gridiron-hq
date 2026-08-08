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

## Rules for changing this model

1. Judge changes by **out-of-sample R² against the market residual**, not by
   backtested win rate. Win rate over a few hundred bets cannot distinguish a
   2% edge from noise; R² can.
2. A filter that improves ROI on holdout is not validated if the underlying
   signal correlation is zero. Check the correlation first.
3. Abstention is a valid, and usually correct, output.
4. Report CLV once it is available. It is the only fast feedback signal in
   sports betting.
