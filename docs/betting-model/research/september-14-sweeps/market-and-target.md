The market residual (actual margin minus the market's line) is the right thing to learn, but only if the market line is kept fixed as the baseline, not blended in as one more input. The price to learn against is the T-60 quote, not the open. Expectations need to be very low: in 2018-2025, nothing cheap and context-based added any value on top of the closing line. A realistic learned model moves RMSE by hundredths of a point, and no "prove it first" gate on a few hundred games can ever detect that.

## 1. How nfl-ensemble.js uses the market today

- **`market_anchor` (lines 918-925):** the margin is `-openSpread`, falling back to `-spread`, which is the close, when no opener exists. So the same component reads a price from a different time depending on the season.
- **`market_regression` (lines 926-933, fit at 1008-1016):** the margin is `b0 + b1 * (-close)`, fit on past games. The pooled 2018-2025 slope is 1.03, so this is the close again under another name.
- **`raw` blend:** the market components are just two columns in the ridge fit (1600-1631), with actual margin as the target. The fit clips weights to zero or above and rescales them to sum to 1 (1626-1629). That forces an average of all ~20 components, so noisy formulas always pull the forecast away from the market. This fits the audit numbers (14.8 vs 13.55).
- **`market_residual` (production, set at nfl-auto-picks.js:84 and :275):**
  - Each component gets a slope with no intercept (1739-1741), fit on an earlier block of weeks and scored on a later one (1734-1736).
  - The gate at 1887-1891 needs `residual_n >= 250`, an RMSE gain of at least 0.03, and a Diebold-Mariano p of 0.05 or less.
  - The weight formula at 1892-1896 only applies to components that pass.
  - The blend at 2054-2059 falls back to exactly the market when nothing passes, and `is_market_identity` flags that at 2075.
  - `residual_gate_passed` has passed in 0 of 848 fits (noted at 1897-1907).
- **Where the price comes from:**
  - History: `games()` (58-70) reads `game_lines.spread` (the nflverse close) and `open_spread`.
  - Live: `ensembleLine` reads the live `game_lines` row (1996-1999), unless a frozen T-60 packet supplies `marketOverride` (2008-2015).

## 2. Market data that exists, and when each price was known

| Source | Seasons | Time grain | Status at a T-60 decision |
|---|---|---|---|
| `game_lines.spread`, `total` (nflverse close) | 1999-2025 | one close per game | Close is a stand-in for T-60; see note (a) below |
| `game_lines.moneyline` | 2006-2025 (2006, 2008, 2009 partial) | close | Same as the close |
| `game_lines.spread_odds`, total odds (closing juice) | 2006+ (3,068 of 3,204 before 2018; 2,227 of 2,227 after) | close | Same as the close |
| `game_lines.open_spread` | 2013-2020: Westgate SuperContest (Wednesday contest lines, not a bettable market) | one value | See note (b) |
| | 2021: nflverse `initial_lines.csv` | one value | Lookahead lines, do not use. Move SD 4.41 vs ~1.5 in other years |
| | 2022-2025: Pinnacle opener, relabeled by migration 047 | median 162h before kickoff (p10 124h, p90 193h) | Safe to use |
| `game_lines.open_total` | 2021+ | one value | Safe from 2022 on |
| `game_lines.closing_spread` | 2026 only | | |
| `nfl_odds_archive` | 2022-2025: 267/285/285/285 games; 2026: 33 stale games | open and close only, per book (10-11 offshore books), spreads/totals/h2h | Safe. Pinnacle's last quote is a median 0.19h before kickoff (p90 2.1h). No intermediate quotes |
| `nfl_line_snapshots`, provider `archive:oddstrader` | 2022-2026 | the same open/close rows, keyed by the book's timestamp | Safe |
| `nfl_line_snapshots`, `free:*` providers | since 2026-09-02 | about every 15 min (Pinnacle: 1,369 captures, 26 events) | Live only |
| `nfl_quote_tape`, `the-odds-api` | Oct 2020 - Jan 2026, 168 batches | 2-3 snapshots per game, mostly 66-72h, ~138h and ~234h before kickoff; only 195 game-snapshots within 3h | Safe. Spreads/totals only, no moneyline, 11-22 books, ~190-238 of 285 games a season |
| `nfl_quote_tape`, `free-book-feeds` | 2026-09-02+ | 1,546 snapshots, 12 books, h2h/spreads/totals | Live |
| `espn_line_moves` | 2026 only | 90 rows, 16 events | |
| `nfl_nfelo_lines` | 2020-2025 | open and last spread | Ticket % in 2020 (262 games), ticket and money % in 2024-25 only; moneyline and total opens 2024-25 only |
| `nfl_signal_snapshots`, `nfl_t60_observations`, Kalshi quotes | 2026 only | | |

**(a) Using the close in place of the T-60 price:**
- The nflverse close matches Pinnacle's close exactly 57.8% of the time and within half a point 92.2% of the time (1,122 games).
- In 2026 Week 1, Pinnacle's T-60 line equalled its last pre-kickoff line in 15 of 15 games. The T-24h line was off by 0.17 points on average.
- So the close is a close stand-in for T-60, with a small optimism that isn't yet measured. It is real lookahead for any earlier decision.

**(b) Opener caveats:**
- The openers come from three sources with different timing, so an "open-to-close move" feature isn't consistent across eras.
- 17 games in 2022 still carry the old median opener (`unresolved_legacy_median_2022_2025`); exclude them.
- Weather in `game_lines` is the game-time observation, not a forecast. It is roughly fine at T-60 and lookahead for earlier decisions.

## 3. Numbers (2018-2025, completed games, residual = home margin + home closing spread)

**Residual by season (mean / SD / n):**

| Season | Mean | SD | n |
|---|---|---|---|
| 2018 | -0.26 | 13.02 | 267 |
| 2019 | -1.87 | 12.95 | 267 |
| 2020 | -0.96 | 12.68 | 269 |
| 2021 | +0.12 | 13.57 | 285 |
| 2022 | +0.29 | 11.50 | 284 |
| 2023 | +1.13 | 13.15 | 285 |
| 2024 | +0.68 | 12.72 | 285 |
| 2025 | +0.61 | 12.25 | 285 |
| Pooled | -0.01 | 12.75 | 2,227 |

- Standard error is 0.27 pooled and about 0.77 per season, so the season-to-season swings are noise.
- Home teams covered 48.9%.
- Actual margin on market margin has a slope of 1.03.
- The total residual has mean +0.54 and SD 13.18.

**Line movement (open minus close; positive means the home side got more favoured):**
- Pooled, the correlation with the closing residual is -0.001 (n=2,157).
- By era:

| Era | n | Corr. with close residual | Slope | Corr. with open residual |
|---|---|---|---|---|
| SuperContest 2018-20 | 763 | -0.068 | -0.58 | 0.049 |
| Initial lines 2021 | 272 | -0.045 | | 0.267 |
| Pinnacle 2022-25 | 1,122 | 0.058 | 0.35 | 0.22 |

- Single seasons range from -0.145 (2020) to +0.185 (2025). That instability means no dependable signal.
- Move buckets: every bucket's mean residual is within ±0.8 (SE 0.5-0.8), and cover rates run 46.3-52.1%.
- The close beats the open by about 0.3 RMSE points in the Pinnacle era (12.44 vs 12.74). The move is information the market has already priced in, not something it misses.
- the-odds-api snapshots about 72h out: mean distance to the close 0.77 points; correlation of the close residual with the snapshot-to-close move -0.016.
- Closing juice (no-vig cover probability, 2013-25, n=3,561): correlation 0.001 with the spread residual and -0.003 with the total residual.

**Rest (home minus away days):**
- Correlation -0.002.
- Home 3+ days more rest: +0.07. Away 3+ days more rest: -0.20.
- Home on a short week: -1.24. Away on a short week: -1.32 (SE ~1.04).
- Away team off a bye: +0.76 (SE 1.07).

**Division games:** correlation -0.001. Mean residual -0.03 for division games vs 0.00 otherwise, and mean absolute residual 9.80 vs 9.85.

**Weather** (1,397 of 2,227 games have values; most gaps are domes):
- On the spread it does nothing: correlation with wind -0.005, with temperature -0.018.
- On totals, wind is the one effect in this data with a t-statistic above 3:
  - Correlation -0.085, slope -0.225 points per mph.
  - Wind under 10 mph: +1.07. 10-15 mph: -1.48 (SE 0.67), unders 59.7%. 15+ mph: -1.83 (SE 1.02), unders 57.2%.
  - Dome or closed roof: +1.70 (n=664).

**Home favourite size (mean residual / home cover rate / n):**

| Bucket | Mean | Cover | n |
|---|---|---|---|
| Home fav 7+ | +0.68 | .499 | 459 |
| Home fav 3.5-6.5 | -0.05 | .462 | 463 |
| Home fav 0.5-3 | -1.14 | .458 | 443 |
| Home dog 0.5-3 | +1.21 | .505 | 377 |
| Home dog 3.5-6.5 | -0.89 | .491 | 291 |
| Home dog 7+ | -0.02 | .568 | 194 |

- No pick'em games in this window.
- Correlation of the residual with the spread: -0.015. With 7 buckets tested, this looks like noise.

**Trailing team residual** (each team's recent results against the spread, 8 and 17 games): correlations -0.004 and 0.022.

**Walk-forward test of all these features together** (ridge regression on 16 features, trained on 2006 through the prior season, tested on each season):
- Features: spread and spread², the move, rest, division, neutral site, dome, wind, temperature, both trailing-residual windows, the gap between moneyline and spread, and key numbers 3 and 7.
- λ=100, pooled 2018-2025: model RMSE 12.781 vs market 12.752. Correlation of prediction with residual -0.011, ATS 50.1%.
- λ=10 gave 12.786 and λ=1000 gave 12.771. Every setting was worse than the market.

## 4. What this means for the design

1. **Target.** Train on y = actual − market_at_decision, and serve market + f(x), with shrinkage pulling f toward 0.
   - The market is a fixed baseline, not a weighted column. That removes the forced averaging that costs over a point today.
   - Heavy regularization makes "no signal" come out as exactly the market, so no gate is needed.
   - Do the same for totals (y = total − market total).
   - Drop `market_anchor` (mixes open and close) and `market_regression` (the close again) as components.
2. **The honest historical price.**
   - Seasons with Pinnacle data (2022-25): use Pinnacle's last pre-kickoff quote from `nfl_odds_archive`.
   - Earlier seasons: the nflverse close as a T-60 stand-in, labeled as slightly optimistic.
   - Never feed the close in as a feature for a decision made before the close.
   - The opener is not the right decision-time price for a T-60 system. It is the right price only for an early-week system, and then only for 2022-25 Pinnacle, or the-odds-api snapshots from 2020 on.
3. **A second target for early bets.** Predict close − early price (closing-line value).
   - It has much more learnable variation: the move SD is 1.3-1.8 points, and the Thursday-to-close mean distance is 0.77.
   - It is graded in weeks, not seasons.
   - History for it only covers 2020/2022-2025.
4. **Realistic effect sizes.**
   - If ρ is the correlation between the model's prediction and the residual vs the close, the RMSE gain is about 12.75·ρ²/2, and the test statistic is about (ρ/2)·√n.
   - A plausible ρ of 0.02-0.06 gives a gain of 0.003-0.023 points and ATS of about 50.5-52.5% on the best-selected bets.
   - Today's gate (n≥250, gain≥0.03, p≤0.05) implicitly needs ρ≥0.21, which is not realistic against the close.
   - Detecting ρ=0.05 takes about 4,300 games, or roughly 1,100 for ρ=0.10, before accounting for within-week clustering.
   - So bet authority should come from continuous out-of-sample CLV and cover log-loss against the T-60 price, not an RMSE-vs-close proof test.
   - The only market-context feature with real support is wind on totals (roughly -0.2 points per mph of wind). Everything else is zero within noise.

Scripts (all read-only) are in `/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/mktarget_agent/`:
- `an1.mjs`: residual stats
- `an2.mjs`: Pinnacle and the-odds-api snapshots
- `an3.mjs`: walk-forward ridge test
- `an4.mjs`: 2026 T-60 vs close
- `an5.mjs`: closing juice