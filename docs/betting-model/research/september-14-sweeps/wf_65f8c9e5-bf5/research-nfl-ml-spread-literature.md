**NFL spread/total/ATS literature: what has beaten the closing line, and whether to model the residual**

I built on these earlier reports: F17 (Stern 1991 and Glickman & Stern 1998, read in full there), F15 (Ragain et al. 2018 on shrinkage), F02 (stacking and the forecast-combination puzzle; its audit of `nfl-ensemble.js`'s `market_residual` blend) and F04 (CLV). I don't repeat their details here.

## 1. Classic work: team-strength models against the line

- **Harville (1980), JASA 75(371):516-524** ([T&F](https://www.tandfonline.com/doi/abs/10.1080/01621459.1980.10477504)). A mixed-linear-model team-strength predictor. It picked 70% of winners in 1971-77; the betting market picked 72%. ATS record not reported. The numbers come from Stekler's review ([GWU RPF WP 2007-001](https://www2.gwu.edu/~forcpgm/2007-001.pdf), p.20), which I read. I could not open the JSTOR original.
- **Stern (1991).** Margin minus closing spread is roughly N(0, ~13.9). The standard test is the regression margin = a + b·spread. Most studies cannot reject a=0, b=1, meaning the line is an unbiased forecast (Stekler review p.18).
- **Glickman & Stern (1998), JASA** ([pdf](https://www.glicko.net/research/nfl.pdf); detail in F17). A state-space team-strength model. On 110 held-out 1993 games its MSE was 165.0 vs the line's 170.5. The authors say the gap is "not large enough to generalize". This is the only classic direct model with a nominal win over the line, and the sample is tiny.
- **Boulier & Stekler (2003), IJF 19(2):257-270** ([SD](https://www.sciencedirect.com/science/article/abs/pii/S0169207001001443)), 1994-2000. The betting market was the best predictor, then probit on NYT power scores, then experts. Power scores picked 61% of winners, the market 66%.
- **Song, Boulier & Stekler (2007), IJF 23(3):405-413** ([SD](https://www.sciencedirect.com/science/article/abs/pii/S0169207007000672)). About 31,000 real-time forecasts, 2000-01. Statistical systems and experts both picked about 62% of winners, the line 66%. Against the spread both were about 50%; most systems did no better than a coin flip.

## 2. "Profitable" findings that later failed

- **Zuber, Gandar & Bowers (1985), JPE** found a profitable fundamentals model. **Sauer, Brajer, Ferris & Marr (1988), JPE 96(1):206-213** ([EconPapers](https://econpapers.repec.org/article/ucpjpolec/v_3a96_3ay_3a1988_3ai_3a1_3ap_3a206-13.htm)) tested it out of sample: 59% in 1983, 39% in 1984, and 73-81% in-sample R² did not help (Stekler review p.20). This is the canonical overfit case.
- **Sauer (1998), JEL 36(4)** ([RePEc](https://ideas.repec.org/a/aea/jeclit/v36y1998i4p2021-2064.html)): profitable wagering rules "are occasionally reported, but often disappear on subsequent investigation."
- **Gray & Gray (1997), JF 52(4)** ([Wiley](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.1997.tb01129.x)). Probit strategies on home/favorite/recent form were significant in-sample, but "some inconsistency" out of sample. They also found favorites slightly over-priced and overreaction to recent results, 1976-94.
- **Home-underdog effect.** The only numbers I found (58.1% in 1973-79, 52.5% in 1981-96, 53.5% in 2002-11) come from low-grade sources: a UNI student paper and an unrefereed arXiv note ([Szalkowski & Nelson 2012](https://arxiv.org/abs/1211.4000)). Treat the decay as plausible but not rigorously shown.
- **Paul & Weinbach (2002), JSE 3:256-263** ([SAGE](https://journals.sagepub.com/doi/10.1177/1527002502003003003)). A "bet unders on very high totals" rule, 1979-2000, in-sample. **Shank (2018), JEF 42(4)** ([Springer](https://link.springer.com/article/10.1007/s12197-018-9431-4)) still finds statistically significant biases in spreads and totals. From the abstract alone I could not verify whether they are profitable out of sample after vig.
- **Walsh & Joshi (2024), MLWA 16** ([arXiv 2303.06021](https://arxiv.org/abs/2303.06021)). NBA, not NFL: +34.7% ROI when models are selected on calibration. A later corrigendum ([SD](https://www.sciencedirect.com/science/article/pii/S2666827025000106)) admits errors in the feature-engineering pipeline and says the conclusion stands. I could not read the corrected numbers (403).
- **Clegg & Cartlidge (2023)** ([arXiv 2306.01740](https://arxiv.org/abs/2306.01740)). Tennis: a published "buzz" betting edge came mostly from one bad-odds bet and made nothing after 2020.
- **Kapoor & Narayanan (2023), Patterns** ([Cell](https://www.cell.com/patterns/fulltext/S2666-3899(23)00159-9)). Leakage affects at least 294 ML papers; once fixed, claimed ML superiority often disappears. Recent NFL "ML" papers reporting 80-95% winner accuracy (search summaries of Uzoma 2015, Juuri 2023) are far above the market's ~66%. That is a leakage red flag by itself; I did not read those papers.

## 3. Modern practitioner benchmarks (none beats the close)

- **538 Elo, 2018 season (256 games)** ([trevorData/538NFL](https://github.com/trevorData/538NFL)): RMSE 13.57 vs Vegas 13.10, below 50% ATS. One season only.
- **kshreyan/nfl-predict** ([GitHub](https://github.com/kshreyan/nfl-predict)), walk-forward 2010-25 with leak tests. Spread MAE 10.33 vs closing 10.08 (n=4,069), ATS 50.7%. Totals MAE 10.61 vs 10.45. Its README says it "does not beat the market outright on any metric." Unvetted: created 2026-09-13, no license, 0 stars.
- **nfelo "market regression"** ([article](https://www.nfeloapp.com/analysis/using-market-regression-to-improve-prediction-accuracy-in-the-nfl/)). Says model-plus-market beats the market on Brier. It gives no sample, no numbers and no out-of-sample protocol, so it is an opinion, not evidence.
- **Baker & McHale (2013), IJF 29(1)** ([RePEc](https://ideas.repec.org/a/eee/intfor/v29y2013i1p122-130.html)). A point-process score model that uses spread and total as inputs is "marginally outperformed by the betting market" on outcomes and about equal on exact scores.
- **Moskowitz (2021), JF 76(6)** ([SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2635517)). Across NFL/NBA/MLB/NHL, momentum and value push prices from open to close and are then fully reversed by outcomes. The returns do not cover transaction costs. So the close is slightly overreactive but not exploitable, which supports grading on CLV.

## 4. Combining with the market and the residual framing

- **Benter (1994)** ([annotated](https://actamachina.com/posts/annotated-benter-paper)). Horse racing, 3,198 races. Pseudo-R²: public odds 0.1218, fundamental model 0.1245, combined 0.1396. The combination is c ∝ exp(α·log f + β·log π), with α and β fit on a separate partition from the fundamental model. The gain comes from the combination, not from beating the public alone. Stekler's review (p.11) reports the same pattern in the horse-racing literature: model plus market odds beats either.
- **Hubáček, Šourek & Železný (2019), IJF 35:783-796** (PDF read in full). NBA 2006-14, Pinnacle closing odds, 9,093 games.
  - Loss = MSE − c·(p̂ − 1/odds)², which rewards disagreeing with the bookmaker.
  - Models were less accurate than the bookmaker (about 67.5% vs about 69%), yet were profitable only when decorrelated (0.4 ≤ c ≤ 0.8).
  - Over 2007-14 the strategy chosen by max-Sharpe made +1.63 budget units. Without decorrelation and thresholding it went bankrupt.
  - Caveat: settings were chosen across a grid, so there is a multiplicity risk.
- **Fair & Shiller (1990), AER 80(3)** ([pdf](https://fairmodel.econ.yale.edu/rayfair/pdf/1990a200.pdf)). The encompassing regression: actual = a + b₁·F₁ + b₂·F₂. This is the right test of whether the model adds information beyond the line.
- **Lopez, Matthews & Baumer (2018), AoAS 12(4)** ([arXiv 1701.05976](https://arxiv.org/abs/1701.05976)). A Bayesian state-space model fit to betting-market probabilities rather than scores. It shows the market can be the data for team strength.
- **Goto, Takeishi & Yairi (2026)** ([arXiv 2604.17194](https://arxiv.org/html/2604.17194)). Soccer, 90,014 matches. Features added to odds give only tiny log-loss gains (about 1.003 vs 1.005). Under market efficiency, extra features mostly re-learn what the odds already contain.

**Assessment: direct margin prediction vs residual (margin − line).**
1. **Direct prediction.** Fifty years of evidence says it does not beat the close. It is useful only as an independent input to a combination. Gridiron's RMSE of 14.8 vs 13.55 is worse than simple Elo relative to the market (538: +0.47; kshreyan: +0.25 MAE). That points to defects in the components, not just the approach.
2. **Residual target with shrinkage to zero.** Same as fitting with the market as an offset (coefficient fixed at 1). Regularization then pulls toward "the market is right," which the a=0, b=1 evidence supports as the prior. It is decorrelated by construction (Hubáček). The bet signal is simply the predicted residual.
3. **Pitfalls.**
   - The offset must be the line available when the bet is placed. Offsetting on the close is lookahead for betting, although it is the correct test of "information beyond the close."
   - Also include market terms (line, |line|, favorite indicator) as features so b≠1 can be learned (Gray & Gray favorite over-pricing; Benter's α, β).
   - Any model-derived feature must be out-of-fold (Benter's two partitions).
4. **Why the bar is so hard (my arithmetic, not from a source).**
   - Cutting RMSE from 13.55 to 13.45 means an MSE drop of 2.7 pts², i.e. finding real signal with SD ≈ 1.6 points. That would be very profitable, and nobody has published it robustly.
   - Detecting it takes time. For a correction d with SD ~3, the per-game squared-error difference has SD ≈ 2·3·13.5 ≈ 81. The standard error is ≈ 4.9 pts² (≈0.18 RMSE) per 270-game season and ≈ 0.07 RMSE over about 2,000 games.
   - For ATS, showing 54% vs 50% at 2σ needs about 625 bets.

## (A) KEY FINDINGS
1. No peer-reviewed statistical or ML model has robustly beaten the NFL closing spread out of sample. Harville, Boulier & Stekler, and Song et al. show the market ahead on winners (66-72%) and systems at about 50% ATS. Glickman & Stern's small win (110 games) was explicitly not generalizable.
2. Reported inefficiencies decay or fail replication: Zuber → Sauer (59% → 39%), Gray & Gray's out-of-sample inconsistency, Sauer (1998), and the Clegg & Cartlidge correction.
3. Documented edges come from combining with or decorrelating from the market, not replacing it (Benter 1994; Hubáček 2019). Even these gains are small and show selection risk.
4. The close is near-efficient; open-to-close moves overshoot, but not enough to profit after costs (Moskowitz 2021).
5. Evidence on totals is weaker and mostly in-sample (Paul & Weinbach 2002; Shank 2018).
6. Implausible accuracy (above ~70% on winners, above ~56% ATS) almost always means leakage (Kapoor & Narayanan 2023).

## (B) RECOMMENDATIONS for Gridiron
1. **Target.** r = margin − L_d, where L_d is the line snapshot at decision time. Keep a diagnostic head on margin − L_close to test for information beyond the close; expect ≈0.
2. **Model.** Ridge or elastic-net regression on r in plain JS: a closed-form weighted solve (XᵀWX + λI)⁻¹XᵀWy, about 100 lines, no dependencies, cross-checked with numpy offline.
   - Features are all point-in-time: F08 state-space ratings, EPA and QB-change differentials, rest, weather, injuries, plus L_d, |L_d|, and a favorite indicator.
   - Pick λ and the recency half-life by season-blocked walk-forward (reuse `margin-distribution.js`'s 6-season half-life pattern).
   - Consider shallow boosting with a market offset (depth 2, learning rate ≤0.02, min leaf ≥50) only if ridge shows a non-zero out-of-sample gain.
3. **Candidate inputs.** Treat the existing 20 formula components as out-of-fold candidate features in the same ridge fit (a Fair-Shiller / Benter-style joint fit). Do not gate them in or out one at a time (F02).
4. **Evaluation.** Expanding window, week by week. Report paired MSE difference vs L_d and vs L_close with week-clustered standard errors, and cover log-loss using the key-number margin distribution from `margin-distribution.js`. Log every configuration in the F06 trial registry.
5. **Bet decision.** Size stakes continuously, e.g. fractional Kelly × a posterior-shrunk estimate of edge from trailing out-of-sample paired gain, going to zero when the edge is ≈0. No binary inclusion gates. Grade by CLV (F04).
6. **Leak alarm.** Automatically flag for investigation any backtest above 55% ATS or beating the close by more than 0.15 RMSE.
7. **Expectations.** The realistic goal is information beyond the decision-time line, measured as CLV. This is consistent with Gridiron's own −2.28 CLV finding and the finding that the nfelo-vs-opener favorites signal is its only positive-CLV one.

## (C) ADOPTABLE CODE/REPOS
- **fivethirtyeight/nfl-elo-game** (MIT): an Elo baseline and its game CSV, as a benchmark feature.
- **conorwalsh99/ml-for-sports-betting** (MIT): a calibration-based model-selection harness to port as logic (NBA, Python). Note the corrigendum.
- **Lisandro79/BeatTheBookie** (GPL-3.0): consensus-odds logic, ideas only; GPL makes copying code into the app a problem.
- **kshreyan/nfl-predict** (no license, brand new): borrow only the ideas behind its list of 27 leakage tests. No code.
- **greerreNFL/nfelo and nfeloqb, trevorData/538NFL**: no SPDX license detected, so ideas only.

## (D) OPEN QUESTIONS / RISKS
- Could not read: Harville and Stern originals (paywalled), the Walsh corrigendum numbers, Shank's profitability, and the ThePredictionTracker tables (403).
- Post-2018 legalization and market maturity may have removed the historical biases. No rigorous NFL study covering 2019-2025 was found.
- About 270 games per season makes detection hard: a real 1.6-point signal needs several seasons to confirm. Point-in-time injury and news features are the most plausible edge and also the most likely to leak.
- The line snapshot tape covers only recent seasons. The L_d offset may have to fall back to the opener for older years, which mixes regimes.