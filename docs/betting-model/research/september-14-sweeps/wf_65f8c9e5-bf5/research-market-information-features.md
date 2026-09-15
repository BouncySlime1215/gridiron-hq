# Market-information features: what's usable at decision time, what's lookahead, and which price is honest to backtest against

Prior research built on: F04 (CLV unification: Buchdahl CLV, Hubáček & Šír 2020 decorrelation), N14 (Simon 2024 summary), N18 (sharp-vs-rec framing), F05 (bitemporal), and the betting-model memory (−2.28 CLV, 78% adverse moves, Pinnacle-opener work).

## 1. Evidence

**Opening vs closing efficiency (academic)**
- **Moskowitz (2021), J. Finance 76(6):3153–3209.** [PDF](https://spinup-000d1a-wp-offload-media.s3.amazonaws.com/faculty/wp-content/uploads/sites/3/2021/08/AssetPricingandSportsBetting_JF.pdf). I read it in full via pdftotext.
  - Data: NFL 1985–2013, 7,035 games, Nevada and offshore books (Covers/SportsInsights).
  - Table II regresses the close-to-result return on the open-to-close return. NFL point spread β1 = −0.47 (t = −8.66); totals −0.50; all sports −0.51. About half of the open-to-close move is undone by the game result, which he reads as overreaction.
  - Opening prices were efficient with respect to momentum. Bettors pushed the close toward momentum, and trading on this is "easily wiped out by transactions costs."
  - My inference, not the paper's: under a simple signal-plus-noise model, β ≈ −0.5 means the open and close were about equally accurate in that era.
- **Avery & Chevalier (1999), J. Business 72:493–521.** [IDEAS](https://ideas.repec.org/a/ucp/jnlbus/v72y1999i4p493-521.html). Abstract only. Line moves were partly predictable from sentiment proxies known before the open. Betting against the predicted move was only "borderline profitable."
- **Simon (2024), Management Science 70(12):8583–8611.** [INFORMS](https://pubsonline.informs.org/doi/abs/10.1287/mnsc.2022.00456). Abstract only. MLB, 3,681 games, 4 books. Line changes were negatively autocorrelated (overreaction), and forecasts did not improve steadily toward first pitch.
- **Krieger & Davis (2024), J. Econ. & Finance 48:263–279.** [Springer](https://link.springer.com/article/10.1007/s12197-023-09656-5). Abstract only. NFL 2007–2021, 3,756 games. Less-visible games had more frequent and larger line moves.
- **Levitt (2004), Economic Journal 114:223–246.** [PDF](https://pricetheory.uchicago.edu/levitt/Papers/LevittWhyAreGamblingMarkets2004.pdf).
  - Data: 19,770 wagers on 242 games from a $250-entry contest with 285 entrants, so these are fixed contest spreads, not market closes.
  - In the median game about two-thirds of bets fell on one side. Books shade prices to exploit bettor biases rather than balancing action.
  - **Paul & Weinbach (2007, J. Prediction Markets)** confirmed this with Sportsbook.com betting percentages. I saw that only through search summaries.
  - Relevance: public-money imbalance exists, but it does not tell you when to bet.
- **Shank.** Abstracts only, no numbers verified.
  - 2018, J. Econ. & Finance 42:818–827: NFL spreads and totals were statistically inefficient, e.g. big home underdogs.
  - 2022, JBEF 36: [IDEAS](https://ideas.repec.org/a/eee/beexfi/v36y2022ics2214635022000806.html). No evidence books know more than bettors.
  - Fodor, Patterson & Shank (2025), Econ. Letters 250: [IDEAS](https://ideas.repec.org/a/eee/ecolet/v250y2025ics0165176525001259.html). Preseason Super Bowl odds predicted profitability in weeks 2–8, an anchoring effect.

**Pinnacle and CLV as the skill measure (mostly practitioner)**
- **Buchdahl, football-data blog.** [Link](https://www.football-data.co.uk/blog/pinnacle_efficiency.php). 87,960 Pinnacle soccer odds. Yield predicted from the ratio of odds taken to Pinnacle's close matched realized yield with a slope of about 1.00. F04 cites his 20,000-bet record: 3.4% realized vs 4.0% CLV-implied.
- **Buchdahl on anchoring.** [Mirror](https://www.sportstradingnetwork.com/article/how-to-solve-a-problem-like-efficiency-part-two/). Pinnacle fits about 10–20% anchoring of the close to the open, with a small random component. Recreational books show much more leftover inefficiency.
- **Data Golf.** [Link](https://datagolf.com/how-sharp-are-bookmakers). Golf, 106,204 wagers, 11 books.
  - Pinnacle's close showed a 1:1 relationship between expected and realized ROI; DraftKings showed almost none.
  - On big opener gaps, Pinnacle moved 54.7% of the way toward Betcris's opener, while Betcris moved only 15.6% toward Pinnacle's. Which books lead the move can be measured.
- **Kaunitz, Zhong & Kreiner (2017).** [arXiv:1710.02824](https://arxiv.org/abs/1710.02824). Soccer, about 32 books, 479,440 games.
  - The average de-vigged price across books was very well calibrated (R² = 0.999).
  - Betting when one book's odds sat far from that average returned +3.5% over 56,435 bets at closing odds and +9.9% over 6,994 bets 1–5 hours before kickoff.
  - Live betting returned +6.2% over 672 bets (p ≈ 0.09). About 30% of displayed prices were already stale, and the books limited their accounts.
- **Hubáček & Šír (2020).** [arXiv:2010.12508](https://arxiv.org/abs/2010.12508), via F04. Using the bookmaker's odds as a model input raises correlation with the market and lowers achievable profit. A model equal to the market has zero edge.
- **Goto, Takeishi & Yairi (2026).** [arXiv:2604.17194](https://arxiv.org/abs/2604.17194). Abstract only. A GLM with one favourite-longshot adjustment on top of the odds beat feature-rich GLMs on 90,014 soccer matches.
- **Opening limits.** Pinnacle limits reportedly start around 25% of maximum at open and rise toward kickoff ([pinnacleoddsdropper](https://www.pinnacleoddsdropper.com/blog/complete-guide-to-pinnacle-sports-betting-strategies-odds-and-tips-for-every-sport-2025)). This is a practitioner claim I could not verify.

**Reverse line movement and steam**
- **Francisco & Moore (2019), J. Econ. & Finance 43(4):813–827.** [IDEAS](https://ideas.repec.org/a/spr/jecfin/v43y2019i4d10.1007_s12197-019-09479-3.html). College football totals 2005–2016: following reverse line movement was generally not profitable.
- Beyond that I found only student theses and tout blogs. There is no peer-reviewed NFL evidence that steam or RLM survives the vig.

**Measured in Gridiron's own database (read-only, run today)**
- **Where `game_lines.spread` comes from.** Historically it is nflverse's closing line. It exactly equals the Pinnacle close in 649 of 1,122 games from 2022–2025, with a mean absolute gap of 0.26 points (1.35 from the opener). `closing_spread` is filled only for 2026.
- **What historical odds exist.** `nfl_odds_archive` has 2022–2025, 10–11 books. Each book has exactly two points, open and close. The median opener is posted 6.7 days before kickoff (10th–90th percentile 5.2–8.0), i.e. Sunday night. There is no historical midweek tape; dense snapshots start 2026-09-02.
- **Accuracy against actual margin, n = 1,122.**

| Season | Pinnacle opener RMSE | Pinnacle close RMSE |
|---|---|---|
| 2022–25 pooled | 12.74 | 12.44 |
| 2022 | 11.54 | 11.54 |
| 2023 | 13.42 | 13.19 |
| 2024 | 12.77 | 12.71 |
| 2025 | 13.07 | 12.19 |

- **Line moves.**
  - 904 of 1,122 lines moved. Mean absolute move 1.35 points, SD 2.07; 12.7% moved 3 or more points.
  - Moskowitz-style regression in points: β = +0.35 (SE 0.18). By season: −0.52, +0.69, −0.27, +0.77.
  - So there is no stable reversal at Pinnacle recently: the close is sharper and the moves look informative.
  - The SD of (margin − close) is 12.42, about six times the SD of the move. CLV is far less noisy than win/loss.

## 2. What is legitimate at decision time and what is lookahead

The app decides after Monday Night Football. Anything timestamped before that moment is allowed as an input; anything after it can only be used for grading.

**Legitimate inputs:**
- The Pinnacle opener, de-vigged, and every book's opener, provided each book's `book_updated_at` is before decision time.
- How far books disagree at the open, and the sharp-vs-rec gap at the open. Data Golf and Kaunitz support this; it is untested for NFL.
- Team ratings implied by past weeks' closing lines, preseason win totals and futures, the prior week's lookahead line, and against-the-spread momentum. Moskowitz and Shank suggest momentum mostly predicts sentiment moves, not outcomes.
- Visibility proxies, which predict the size of the move.

**Lookahead:**
- The current game's close, including `game_lines.spread` before 2026.
- Any "market anchor" component built from it.
- A per-book "opener" whose timestamp is after decision time.
- Betting percentages or RLM that were not recorded in time.

**Legitimate only for grading:** the close, as the CLV benchmark and forecast benchmark.

## 3. Which price is honest to backtest against

With only the open and the close, a Tuesday decision was never offered either price.
- **The opener is optimistic.** It is not executable: it was posted Sunday night with low limits, before Monday's information that the model's features already contain. The in-DB close-vs-open accuracy gap shows Monday–Sunday information matters.
- **The close is executable but conservative.** It is available at full limits.

The honest protocol has three parts:
1. **Primary (bet P&L):** assume every bet is placed at the close price, de-vigged. If there is no edge at the close, there is no bankable edge. This is the only fully clean historical test.
2. **Skill (CLV):** only valid if the decision is moved to the opener's time with Sunday-night information only. Features must be rebuilt strictly as of the opener timestamp. The measured CLV is then opener minus close.
3. **Tuesday price: sensitivity band only.** Estimate P_t = P_open + λ·(P_close − P_open), with λ (the share of the move done by decision time) fitted from 2026-forward tape.
   - Never promote a model on this.
   - The formula uses the close, and λ may correlate with the model's own signal.
   - Report results at the opener, at λ = 0.25/0.5/0.75, and at the close.

## A. Key findings
1. The close is at least as accurate as the opener. NFL 1985–2013: about half of each move later reversed (Moskowitz). Pinnacle NFL 2022–25: close RMSE 12.44 vs 12.74, with no stable reversal (my DB measurement).
2. Line moves are partly predictable from pre-open sentiment (Avery & Chevalier; Moskowitz; Krieger & Davis). Predicting a move is not the same as predicting the outcome, and profits after vig were borderline or absent.
3. At a sharp book, CLV tracks realized return about 1:1 (Buchdahl; Data Golf). Recreational-book closes do not.
4. De-vigged consensus prices across books are very well calibrated. Outlier prices at individual books are the one documented price-based edge, but it is execution-limited (Kaunitz 2017).
5. No peer-reviewed support for steam or RLM as profitable NFL signals (Francisco & Moore 2019 is negative for college totals).
6. Gridiron's historical "spread" column is the closing line, and there is no historical midweek price.

## B. Recommendations
1. **Hard-block lookahead features.** Tag every market field with its valid time (the `book_updated_at` timestamp). In training, reject any market input timestamped after decision time. `game_lines.spread` becomes a label or benchmark only.
2. **Train two targets with ridge or empirical-Bayes models in numpy or Node.**
   - (a) Margin, with the de-vigged Pinnacle opener as an offset. Score by log-loss/RMSE against the close.
   - (b) The move (close − opener) from opener-time features, graded by CLV.
   - Following Hubáček & Šír, feed the opener as an offset, not as a regressor that swamps the other features.
3. **Gate bets on continuous out-of-sample results.** Use the shrunken mean CLV against a declared Pinnacle close (F04's function) and the ROI-at-close bound. Use no binary gates. Stakes stay at zero until the lower confidence bound on CLV is above zero; at a per-bet SD of about 2 points, roughly 100 bets gives SE ≈ 0.2.
4. **Run the sentiment check every season.** Regress (margin − close) on each signal's predicted move. A negative β means the signal is a sentiment follower: it earns CLV but not ROI.
5. **Add opener disagreement features from `nfl_odds_archive`** (spread SD across books, Pinnacle minus the offshore median) and preseason futures. Test them under the trial registry (F06). Do not port RLM or steam until forward tape with betting percentages exists.
6. **Pull the decision earlier.** Capture every book's opener from 2026 on, and add a Sunday-night decision pass. That is the only way to earn opener CLV.

## C. Adoptable code and repos
- **[Lisandro79/BeatTheBookie](https://github.com/Lisandro79/BeatTheBookie)** (GPL-3.0, MATLAB/SQL). Borrow only the idea: the consensus probability and the rule to bet when best odds > 1/(p_cons − α). Reimplement it; don't copy code, because of GPL.
- **nflverse/nfldata** `games.csv`: a closing-line label source only. Its [DATASETS.md](https://github.com/nflverse/nfldata/blob/master/DATASETS.md) does not state whether lines are opening or closing; the DB comparison shows closing.
- **Existing Gridiron modules:** `nfl-devig.js` (Shin de-vig), F04's `computeClv` design, and the penaltyblog strict `<` date slicing (GF05). No new installs needed.

## D. Open questions and risks
- **Opener reliability.** Only Pinnacle and oddstrader opener timestamps have been checked. Per-book opener time and limits are unknown, and the 2021 openers are corrupt.
- **Sample size.** About 1,122 games of two-point history. The β estimate is unstable across seasons, so many seasons are needed to separate information from sentiment.
- **CLV validity depends on the close being efficient.** The Pinnacle evidence is mostly soccer and golf; NFL is untested beyond my quick measurement.
- **Unverified numbers.** Paul & Weinbach, Shank, Simon, and Krieger & Davis are abstract-level only. The opening-limits claim is a practitioner claim.
- **Execution.** Stale feeds (30% in Kaunitz) and account limits can erase paper CLV.

Scratch queries: `/private/tmp/claude-501/-Users-nick-matta-Claude-Artifacts/e22ddbdc-9d23-482e-a1cc-7bc1f39b77c6/scratchpad/mif/q4.mjs`