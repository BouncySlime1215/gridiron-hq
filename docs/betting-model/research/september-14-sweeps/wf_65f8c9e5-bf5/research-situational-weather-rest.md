**Situational factors vs the market line: what's priced, what's left over, what's noise**

Builds on prior reports N17 (weather/venue), F13 (Lopez & Bliss bye analysis), GF02 (nfelohfa HFA model), F08/F17 (team-specific HFA spread) and F06 (multiplicity). I also ran a **read-only** check against the app DB (`game_lines`, nflverse source, regular season, 1999–2025, 6,555 non-neutral games). Script: `/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/situational_resid.py`. It regresses (actual − line) on situational factors, with SEs clustered by season-week, split into three eras, plus a walk-forward refit each season from 2011 to 2025. Nothing in the repo was modified.

Two caveats on the local check:
- The nflverse `spread_line`/`total_line` field is described only as "The spread line for the game" ([nflreadr dictionary](https://raw.githubusercontent.com/nflverse/nflreadr/main/data-raw/dictionary_schedules.csv)). It is not confirmed to be the closing line.
- nflverse `temp`/`wind` are the conditions at the stadium on game day, not the forecast. Using them is lookahead.

---

### 1. Home-field advantage (HFA): real decline, and the market follows it

- **Lopez & Bliss (2024)**, Bayesian state-space model on 5,679 games (2002–2023). HFA fell from about **+2.69 points (2002) to +1.65 (2023)**. The market's implied HFA in 2023 was **+1.74**, so the market tracked the decline. [Frontiers](https://www.frontiersin.org/journals/behavioral-economics/articles/10.3389/frbhe.2024.1479832/full), [arXiv:2408.10867](https://arxiv.org/abs/2408.10867)
- **Higgs & Stavness (2021)**, *Scientific Reports* 11:14521, 2016–2020. Pre-COVID NFL HFA was about a 7.8% multiplicative boost to points (β mean 0.078). HFA "was already decreasing leading up to the 2020 season", and 2020 restrictions had "no significant impact". So it is a trend, not a COVID artifact. [PMC8282683](https://pmc.ncbi.nlm.nih.gov/articles/PMC8282683/)
- **Descriptive blog, not controlled** ([nflanalytic](https://nflanalytic.com/explainer-home-field-advantage.html)): average home margin +2.7 (1999–2018) vs +1.7 (2019–2025); 2020 was +0.2.
- **Local check.** The line's average home expectation was 2.54 / 2.31 / 1.54 across 1999–2010 / 2011–19 / 2020–25. Actual home margin was 2.46 / 2.39 / 1.75. The leftover home edge beyond the line was −0.54 / +0.42 / +1.10, all with |t| < 1.5. **Priced.** Any 2020+ leftover is not distinguishable from zero.

### 2. Bye week and rest differential: the one documented market mis-valuation

- **Lopez & Bliss:**

| Situation | True effect on margin | What the spread priced in |
|---|---|---|
| Bye, pre-2011 | +2.21 (95% CrI 0.61–3.80) | +0.39 |
| Bye, post-2011 | **+0.31 (−1.01 to 1.64)** | **+0.97 (0.65–1.28)** |
| Thursday "mini-bye" | +0.48 (not significant) | −0.06 |
| Off Monday night | +0.14 (not significant) | +0.37 (0.14–0.61) |

- Since the 2011 labor agreement cut bye-week practice, the market seems to **overvalue the bye by about 0.66 points**. The CrI on the true effect is wide, so this is a hypothesis, not an edge.
- **Local check.** 2011–19: home off bye −2.00 (se 1.36). 2020–25: home off bye −0.21 (1.02), away off bye +0.52 (1.33). Direction fits market overvaluation, but it is not significant.
- **Power problem.** About 32 team-games off a bye per season gives SE ≈ 13/√32 ≈ 2.3 points per season, and about 0.7 over 10 seasons. A 0.66-point mispricing cannot be confirmed with this app's data.
- **Murray (2018)**, *J. Sports Econ.* (2011–15): rest combinations affect home win probability and total points, moderated by familiarity and travel. I saw the abstract only; effect sizes not verified. [doi](https://doi.org/10.1177/1527002516672059)

### 3. Thursday games

- Lopez & Bliss: no significant effect on margin or spread (table above).
- Blog trend claims (e.g. road teams cover 55.7% on Thursdays, per [FanDuel Research](https://www.fanduel.com/research/thursday-night-football-nfl-betting-trends-historical-spread-over-under-analysis)) are uncontrolled, and the same source shows unders flipping from 63–65% (2021–22) to 31.6% (2023).
- **Local check (n = 311).** Thursday effect on margin is not significant in any era. On totals it is −2.15 (1999–2010) vs +2.35 (2020–25). **The sign flips: noise.**

### 4. Travel distance and time zones

- **Nichols (2014)**, *J. Sports Econ.* 15(1), 1981–2004. A visitor travelling west-to-east across at least one time zone raises home win probability, and bettors underestimate the home score. But the model "does not provide a profitable betting strategy out of sample". Abstract only. [doi](https://dx.doi.org/10.1177/1527002512440580)
- **Local check.**
  - Eastward time-zone crossings: +0.83 (1999–2010) vs −1.12 (se 0.67) in 2020–25. Sign flip.
  - Distance: not significant in every era.
- **Verdict: priced or noise.**

### 5. Circadian / primetime

- **Smith et al. (2013)**, *SLEEP*, 1970–2011. In 106 night games, West Coast teams covered 66% of the time, by 5.26 points on average; no effect in 293 day-game controls. [AASM summary](https://aasm.org/circadian-timing-may-give-edge-to-west-coast-nfl-teams-in-night-games/) (I did not read the full paper.)
- **Local check does not replicate it.** Pacific-time visitors at Eastern-time home teams with kickoff at 8pm ET or later: n = 30, **−5.08 (se 2.32)**, the opposite sign. My definition is narrower than Smith's. With tiny n and about 40 coefficients tested, **treat as noise.**
- **Primetime margin:** +1.89 (se 0.79) in 2011–19, −0.57 in 2020–25. Sign flip.
- **Primetime totals:** −1.93 (se 1.10) in 2020–25, −0.84 (0.50) pooled. Weak; consistent with a public lean to the over but unproven.

### 6. Divisional games

- nfelo says divisional HFA is "much smaller" but gives no numbers ([nfelo tracker](https://www.nfeloapp.com/tools/nfl-home-field-advantage-hfa-tracker/)).
- **Local check.** Margin: not significant. Totals: −0.73 / −1.50 (se 0.56) / −0.15 across the three eras, −0.79 (0.34) pooled. The effect is fading, so a weak leftover at best.

### 7. Weather and totals: the only factor with consistent sign across eras

- **Borghesi (2008)**, *Applied Financial Economics* 18(12):947–953, 1984–2004. Heat, wind and rain cut scoring and bettors underestimate it; a weather-based strategy won above 52.38% out of sample. Abstract only; the journal site returned 403. [EconPapers](https://econpapers.repec.org/article/tafapfiec/v_3a18_3ay_3a2008_3ai_3a12_3ap_3a947-953.htm)
- **Paul (2017)** on humidity: carried over from N17, abstract only.
- **Kelly & Chen**, *Research in Business & Economics Journal* 14 (read in full). Unders on totals of 47.5+ won 59.7% in 2001–09, and **the edge disappeared in 2010–18**. Their explanation is a change in how sportsbooks set prices. Documented market inefficiencies decay. [PDF](http://www.aabri.com/manuscripts/193138.pdf)
- **Local check (outdoor games with wind recorded).**

| Era | Total vs line, wind ≥ 15 mph | Total vs line, wind < 10 mph |
|---|---|---|
| 1999–2010 | −0.96 (n = 339) | +1.50 |
| 2011–19 | −1.62 (n = 187) | +0.78 |
| 2020–25 | −1.93 (n = 110) | +1.09 |

  - Linear slope: **−0.17 points per mph (se 0.05)** pooled; −0.24 (se 0.13) in 2020–25. A ≥15 mph threshold dummy adds nothing on top of the linear term.
  - Walk-forward 2011–25 totals RMSE: line alone 13.158, line + wind **13.133**.
  - **This is an upper bound.** Game-day wind includes the forecast surprise the market could not see. The true pre-kickoff signal is smaller.
- **Other weather and venue factors (local):**
  - Cold (<32°F), heat (≥85°F): not significant, signs flip.
  - Dome: −0.76 (se 0.56), not significant.
  - Games missing wind data: −2.08 (t −2.2). This suggests non-random data gaps. 2022 has wind for only 107 of 284 home rows.

### 8. Altitude (Denver)

- Press coverage of Lopez, Matthews & Baumer (2018, *Annals of Applied Statistics*, [arXiv:1701.05976](https://arxiv.org/abs/1701.05976)) reports Denver with the largest home advantage in the NFL. That comes from [MSU Denver](https://red.msudenver.edu/2018/advantage-altitude-exploring-the-largest-home-advantage-in-sports/); I did not verify it in the paper. Because that estimate is **derived from betting lines**, it is priced by construction.
- **Local check.** Denver home effect beyond the line: −1.52 / +1.34 / +1.13 by era, +0.13 (se 0.90) pooled. **Priced.**

### 9. Combined margin check

All situational features added to the line **made the margin worse** walk-forward: RMSE 12.906 → 12.930 to 12.945, depending on ridge penalty. That is direct evidence that situational factors are priced or noise for spreads.

---

## (A) KEY FINDINGS

1. **HFA declined from about 2.7 to 1.5–1.7 points, and the market tracks it** ([Lopez & Bliss 2024](https://arxiv.org/abs/2408.10867); [Higgs & Stavness 2021](https://pmc.ncbi.nlm.nih.gov/articles/PMC8282683/); local check).
2. **Bye after 2011:** true effect about +0.3, market prices about +1.0. This is the only published, market-controlled mis-valuation, and it is statistically underpowered (Lopez & Bliss).
3. **Thursday, Monday night, travel, time zones, primetime margin, circadian, altitude:** priced or noise. Signs flip across eras in the local check. Nichols (2014) found no out-of-sample profit.
4. **Wind on totals** is the only consistent-sign leftover: about −0.17 to −0.24 points/mph beyond the line in every era ([Borghesi 2008](https://econpapers.repec.org/article/tafapfiec/v_3a18_3ay_3a2008_3ai_3a12_3ap_3a947-953.htm); local check). It is inflated by lookahead.
5. **Market inefficiencies decay once published** ([Kelly & Chen](http://www.aabri.com/manuscripts/193138.pdf)).
6. **Multiplicity:** I tested about 40 coefficients, so about 2 with |t| > 2 are expected by chance (F06). Only the wind slope survives consistency across eras.

## (B) RECOMMENDATIONS FOR THIS APP

1. **Spreads: don't use situational factors as a source of edge.** In the redesigned model, include rest, bye, travel, time zone, divisional and primetime as ridge-shrunk features in the team-strength model. Priors should be centered near zero (bye about +0.3). Don't hand-code constants. The walk-forward test above is the acceptance gate: a feature stays only if it lowers out-of-sample RMSE against the line.
2. **HFA:** use a dynamic league-wide state (rolling or Kalman, the nfelohfa pattern from GF02), currently about 1.5–1.8. Add team-specific offsets with hierarchical shrinkage (F08). Retire any fixed 2.5–3 value.
3. **Totals and weather:**
   - Replace the `weather_total` constants in `nfl-ensemble.js` (+1.2 dome, −2.4 for wind ≥ 15, −1.6 for cold < 32; see N17) with one continuous wind slope, fitted walk-forward and shrunk.
   - Drop the dome and cold adjustments when working relative to the market; they are priced.
   - At decision time, use **only forecast wind** from `nfl_game_weather_forecast_history` at the lead matching the bet timestamp. Train on forecast wind wherever it exists (2022+). Treat game-day-wind coefficients as an upper bound.
4. **Bet gating:** register "market overvalues byes post-2011" and "forecast wind under the total" as the only two situational hypotheses (F06). Grade them on closing-line value, not win rate. Expect years before either can be confirmed.
5. **Fix the data before modeling:** 2022 wind coverage (107 of 284), and the missing-wind bias.

## (C) ADOPTABLE CODE/REPOS

- **`situational_resid.py`** (scratchpad path above; numpy only): residual regression with week-clustered SEs, split by era, plus walk-forward ridge. Port it to JS as the per-feature acceptance test.
- **`greerreNFL/nfelohfa`:** no license, so borrow the idea only. Rolling-regression base HFA with EMA smoothing, plus per-game bye/timezone/surface/divisional adjustments (GF02).
- **nflverse schedules:** fields `away_rest`, `home_rest`, `div_game`, `roof`, `temp`, `wind`, `gametime` (Eastern time). The nflreadr code is MIT; I did not verify the data license.
- **Lopez & Bliss:** I did not verify that replication code exists. Borrow their model structure: state-space team strength plus additive rest dummies, with a pre/post-2011 split.

## (D) OPEN QUESTIONS/RISKS

- Is nflverse `total_line`/`spread_line` the open, the close, or a mix? Check it against `nfl_nfelo_games.home_line_close`/`total_line_close`. The totals intercept (+0.72 pooled, +2.4 when wind is zero) may be a line-source artifact.
- How much of the wind leftover survives when using forecast wind? Only 2022+ forecasts exist, about 800 outdoor games, which is underpowered.
- Recent rule changes (17-game season, 2024 kickoff rule) break the stationarity assumption for totals.
- Smith et al.'s circadian result and Paul's humidity result are unverified beyond their abstracts or summaries.
- Priced-in values move over time (the bye pricing rose after 2011). Any leftover signal needs continuous monitoring, not a one-time fit.