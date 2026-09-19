/**
 * TEST 6 — the corpus of recorded findings to be audited.
 *
 * Every entry is transcribed from docs/betting-model/research/EDGE-TEST-REGISTRY.md or the
 * F-series notes under docs/betting-model/research/advanced-methods-and-github/.
 *
 * RENDERING RULE, and it is the whole experiment: `state` describes the CLAIM and the METHOD
 * as the write-up describes them, in the write-up's own order, as flowing prose. It never says
 * "no placebo was run" or "prices were not used" — that would be me supplying the answer. If a
 * control is absent from the method narrative it is absent because the write-up does not
 * describe it, and Jev has to notice the absence itself.
 *
 * SCOPE. Only findings that make a QUANTITATIVE empirical claim about bettability, market
 * behaviour, or model performance are included. The F-series also record code-audit findings
 * ("this sign flip is wrong, grep-verified at line 475"); those are excluded because
 * has_placebo / is_price_aware are meaningless for them and scoring them would pollute the
 * ranking with trivially-false booleans.
 */

export type Finding = {
  id: string;
  source: string;
  recorded_verdict: 'accepted' | 'killed' | 'inconclusive' | 'blocked';
  headline: string;
  state: string;
};

export const FINDINGS: Finding[] = [
{
  id: 'R01', source: 'registry test 1', recorded_verdict: 'blocked',
  headline: 'Wong teaser legs hit 74.69%',
  state: `Claim: six-point teaser legs that cross both 3 and 7 — favourites of -7.5 or -8.5 and underdogs of +1.5 or +2.5 — win 74.69% of the time, with a 95% confidence interval of 72.41% to 76.98%.
Method: 1,391 individual teaser legs were identified from the closing point spread in the game_lines table across the 1999 through 2025 seasons. Each leg was graded as a win or loss against the final score with the six points applied. The observed rate was compared against the break-even rate implied by three candidate teaser prices: it beats -110 by 2.32 percentage points, which is 1.99 standard errors; it does not beat -120, which is 0.72 standard errors; and it does not beat -130, which is -0.42 standard errors.
Recorded conclusion: price-dependent. The project holds no teaser price data of any kind — the nfl_teaser_price_ledger table is empty and the Odds API tape carries only spreads — so whether -110 is obtainable cannot be answered from available data. The write-up also notes that this test and the three that follow it are four comparisons on one dataset, and that the 1.99 standard errors (p about 0.047) does not survive correction for them.`,
},
{
  id: 'R02', source: 'registry test 2', recorded_verdict: 'killed',
  headline: 'Teaser edge has not decayed across eras',
  state: `Claim: the Wong teaser leg win rate has not decayed as books became more sophisticated.
Method: the same 1,391 closing-spread teaser legs from 1999 through 2025 were split into three chronological eras of 475, 427 and 489 legs. The win rate in each era was 73.26%, then 75.41%, then 75.46%.
Recorded conclusion: no decay; the rate is stable or slightly improving over time.`,
},
{
  id: 'R03', source: 'registry test 3', recorded_verdict: 'killed',
  headline: 'Teaser legs stronger on low totals',
  state: `Claim, stated as a pre-existing hypothesis before the test was run: teaser legs crossing 3 and 7 perform better on games with low posted totals.
Method: the same closing-spread teaser legs were split into five buckets by the game total, with 417, 318, 313, 211 and 132 legs. Games with a total of 41 or lower hit 74.82%. The best-performing bucket was totals of 44.5 to 47 at 77.64%.
Recorded conclusion: not supported. The low-total bucket is no better than the middle buckets, and the best bucket is one of five and sits at 1.61 standard errors, which the write-up characterises as a cherry-pick.`,
},
{
  id: 'R04', source: 'registry test 4', recorded_verdict: 'killed',
  headline: 'Teaser legs stronger on a particular side',
  state: `Claim: teaser leg performance differs by which side of the game the leg is on.
Method: the same closing-spread teaser legs were split into four side buckets — home favourite, home underdog, road favourite, road underdog — with bucket sizes from 128 to 503 legs. Home favourites were worst at 72.18% and home underdogs best at 75.82%.
Recorded conclusion: not significant. No bucket clears 1.96 standard errors measured against a -120 break-even.`,
},
{
  id: 'R05', source: 'registry test 5', recorded_verdict: 'accepted',
  headline: 'Preregistered shadow tape shows +0.94pp closing line value',
  state: `Claim: a set of betting decisions frozen before kickoff produced positive closing line value of 0.94 percentage points.
Method: 56 decisions were written to a shadow_decisions table at 2026-09-03 at 21:01 UTC, days before week one kicked off, each recording a side, a book, an exact line, a price, an opener, and the signal that generated it, at zero stake and explicitly marked as to be graded by closing line value. Nothing could be tuned afterwards because the timestamps predate the games. The decisions were graded on 2026-09-17 by scripts/model-lab/grade_shadow_tape.py against nflverse closing lines. Closing line value is derived by applying the empirical margin and total distribution to the line, through a cover_prob function of the probability mass function and the line. Fifty-two decisions graded naively give +1.12pp at t = +2.61 with a 40.4% win rate and -23.3% notional profit and loss. Collapsed to 15 distinct games the figure is +0.94pp at t = +2.04; collapsed to 29 game-by-market cells it is +1.13pp at t = +2.97. Individual signals ranged from +0.71pp to +1.71pp, none significant alone. A sign-convention bug was caught during grading: shadow_decisions.line uses standard betting notation where negative means the home team is favoured, while the nflverse spread_line is a margin where positive means the home team is favoured; the first grader treated them alike and produced 18.5 points of closing line value, which is impossible on an NFL spread and is what exposed it.
Recorded conclusion: positive closing line value, not yet proof. t = +2.04 on 15 games is about p = 0.06 two-tailed. The 40.4% win rate has a confidence interval of 27% to 54%, so results carry no information at this sample size and closing line value is the only readable quantity. The write-up calls this tape the most valuable asset in the project.`,
},
{
  id: 'R05b', source: 'registry self-audit on test 5', recorded_verdict: 'killed',
  headline: 'Shadow tape closing line value does not cover the vig paid for it',
  state: `Claim: the shadow tape's line-based closing line value is measured without any price term, and a direct price check shows the edge does not cover the vig.
Method: all 56 week-one shadow decisions were matched to a Covers closing price, and the implied probability of the price actually paid was compared against the no-vig closing probability. Mean price paid was -104.8 against a mean closing price of -106.0. Paid versus no-vig close came out at -2.62 percentage points over 16 games at t = -8.57, against the +0.94pp of line-only closing line value at t = +2.04.
Recorded conclusion: explicitly not a refutation, because the two quantities are not commensurable — the price paid carries vig while the closing probability has vig removed, so the -2.62pp is dominated by roughly 2.4pp of half-vig paid rather than by the signal. shadow_decisions stores only our own side's price, so a genuine two-way de-vig at bet time cannot be computed. What it does establish is that 0.94pp of line closing line value does not cover the vig paid to obtain it.`,
},
{
  id: 'R06', source: 'registry test 6', recorded_verdict: 'killed',
  headline: 'teamrankings_vs_open beats the close by +0.29pp, after a look-ahead was removed',
  state: `Claim: a signal comparing teamrankings power ratings to the quotable line produces real but economically useless closing line value of 0.29 percentage points.
Method: scripts/model-lab/beat_close_backtest.py over the 2022 to 2025 seasons, graded on closing line value and collapsed to one observation per game. The first run reported +2.24pp at t = +7.71 on 795 bets and was wrong: the openers came from a rebuilt nfl_odds_archive whose opener is the minimum timestamp from Covers, a median of 11 to 12 days before kickoff with a tail to 276 days and a 134-day median for 2026 spring lookahead lines. Pricing a week-W rating against a line posted around week W minus two hands the rating two weeks of information the market had not yet seen, at a price no longer quotable; the 2025 season showing +5.53pp against 2022's +0.60pp was the tell. Repriced at a realistic decision point — the Wednesday of game week, taking the last quote at or before it, which gives a median lag of 3 days matching the live tape's 23-second opener-to-decision gap — the four seasons gave +0.06pp at t = +0.29 on 203 bets, +0.45pp at t = +2.20 on 202, +0.61pp at t = +3.17 on 214, and +0.02pp at t = +0.10 on 204, for +0.29pp at t = +2.71 across 823 bets with a 51.3% win rate. Closing line value is derived from the empirical margin and total distribution applied to the line; the script does not read a price column at all.
Recorded conclusion: real but not profitable. Removing the look-ahead cut the effect by 87%. 0.29pp of closing line value against roughly 4.5pp of vig, a 51.3% win rate against the 52.38% needed at -110, and two of four seasons at zero.`,
},
{
  id: 'R07', source: 'registry test 7', recorded_verdict: 'killed',
  headline: 'Kalshi per-minute quotes lead sportsbook lines',
  state: `Claim: Kalshi's per-minute prediction market quotes move before sportsbook lines do, which would be tradeable.
Method: 227,810 minute-bars were aligned between Kalshi candles and book quotes across 14 games, and lead-lag was tested at a range of lags. Only 306 of the Kalshi bars and 67 of the book bars were nonzero. The resulting closing line value was +0.08 percentage points with zero Kelly growth.
Recorded conclusion: no lead at any lag. The only thing in the result resembling an edge traced back to line shopping rather than to any lead.`,
},
{
  id: 'R08', source: 'registry test 8', recorded_verdict: 'killed',
  headline: 'Injury news moves the line and can be front-run',
  state: `Claim: injury news drives line movement and the timestamps are precise enough to identify who moves first.
Method: 185 injury events were matched to line movement using nfl_injuries.modified_at, a second-precision timestamp. The timestamps were verified as genuinely real rather than scrape artifacts: 77% land between 17:00 and 21:00 UTC on a Friday, which is the NFL final-report window. The result was +0.39 percentage points of closing line value with zero Kelly growth and a 55.1% win rate.
Recorded conclusion: cannot be validated out of sample, because the 2025 and 2026 seasons carry no injury timestamps at all, so there is no holdout period available.`,
},
{
  id: 'R09', source: 'registry test 9', recorded_verdict: 'killed',
  headline: '55 advanced team-week features versus the closing line',
  state: `Claim: a set of 55 advanced team-week features carries information the closing line has not priced.
Method: the features were fitted on the 2022 through 2024 seasons and tested on 2025, which is 237 games, for a total of 923 graded bets. The out-of-sample result was -0.30 percentage points of closing line value with zero Kelly growth and a 50.2% win rate.
Recorded conclusion: no edge. The write-up's own summary is that the features are real football signal and the market has already priced all of it.`,
},
{
  id: 'R10', source: 'registry test 10', recorded_verdict: 'blocked',
  headline: 'Divergence across books, Kalshi and Polymarket',
  state: `Claim: when the three venues disagree about the same game, the disagreement is tradeable.
Method: 558 observations were assembled and produced +0.09 percentage points with a Kelly figure of 0.067. The intended three-venue comparison was then checked for coverage: zero regular-season games have all three venues present. Kalshi candles begin on 2026-05-15 and Polymarket winner history ends on 2026-08-28, so the 42-game overlap between all three is entirely preseason.
Recorded conclusion: the test cannot be run on this data.`,
},
{
  id: 'R11', source: 'registry test 11', recorded_verdict: 'killed',
  headline: 'Kalshi order-book microstructure predicts outcomes',
  state: `Claim: microstructure features on the Kalshi order book — bid-ask spread widening and jumps in open interest — carry predictive information.
Method: 64 games were tested. A placebo control and a disjoint-book control were both specified before any grading was done. The result was -0.01 percentage points of closing line value with a Kelly figure of 0.01 and a 45.8% win rate.
Recorded conclusion: no signal survived the placebo and disjoint-book controls. The write-up separately logs that this test consumed part of the 2026 season, which was the project's last clean holdout, so 2026 is no longer virgin for Kalshi microstructure work.`,
},
{
  id: 'R12', source: 'registry test 12', recorded_verdict: 'killed',
  headline: 'Bet the laggard book after the consensus moves',
  state: `Claim: after the consensus moves, a book that has not yet repriced offers a stale number worth betting.
Method: 293 opportunities across 32 games were identified from the Odds API tape. The lag was measured and is real and large — DraftKings runs a median of 2,302 minutes behind, and the stale number sits up for a median of 675 minutes — so availability is not the binding constraint. Realised return on the opportunities was +0.71%.
Recorded conclusion: no edge; it simply does not pay.`,
},
{
  id: 'R13', source: 'registry test 13', recorded_verdict: 'accepted',
  headline: 'Perfect line shopping across 11 books still loses 1.82% per bet',
  state: `Claim: line shopping is a cost reduction and not an edge; the best price available across eleven books still returns -1.82% per bet, overturning the project's founding assumption that shopping reaches break-even and a model supplies the rest.
Method: 561,746 pre-kickoff quote opportunities across 260 games on the eleven-book Odds API tape, spreads only, measured from 2026-09-01 to 2026-09-17. Every quote's actual posted American price was used to compute expected value per bet under five execution policies. Best book returned -1.82%; best price on the consensus number -4.01%; the consensus -4.88%; a randomly chosen book -5.05%; the worst book -8.42%. The gain from shopping versus a random book is +3.23 points, with a median of +2.63. The agent's own headline is that the previously believed roughly +4 points claim is overstated by about 60%, that the real number is +2.5 to +2.6 points of return per bet, and that it is a cost reduction rather than an edge.
Recorded conclusion: perfect line shopping still loses 1.82% per bet and therefore cannot be the foundation a model adds the rest on top of. The write-up flags that this is one window and one market and should be re-measured on a second season before being treated as settled.`,
},
{
  id: 'R14', source: 'registry test 14', recorded_verdict: 'killed',
  headline: 'Cross-venue arbitrage between books, Kalshi and Polymarket',
  state: `Claim: simultaneous prices across sportsbooks, Kalshi and Polymarket permit riskless two-sided arbitrage.
Method: 110 candidate opportunities were examined across 275,238 minutes of aligned quotes. For every candidate the cost of the cheapest two-sided round trip was computed from the actual crossable prices at each venue including fees. The cheapest round trip found anywhere costs a median of 1.0375, meaning 3.75% is paid to own both sides. Only three minutes in six weeks beat the fees, and all three were traced to data errors. Windows during which a candidate persisted lasted a median of two minutes.
Recorded conclusion: no real arbitrage exists in this data. Separately recorded as a useful null: the tape contains no stale books in the sense of a quote left up by mistake — the maximum quote age across 1.91 million rows is 884 seconds and zero rows are older than an hour.`,
},
{
  id: 'R15', source: 'registry test 15', recorded_verdict: 'killed',
  headline: 'Middles and key-number straddles return -2.62%',
  state: `Claim: buying both sides of a game at different numbers to create a middle is profitable.
Method: 56,120 middle opportunities across 1,757 games were enumerated and graded at real posted prices on both legs. A model predicted -2.48% expected value in advance; the realised out-of-sample return was -2.40%, and the full sample returned -2.62%, with the t statistic computed with observations collapsed by game at t = -8.99. Middles hit 1.67% of the time against a vig that costs far more than that.
Recorded conclusion: no edge. A related cross-book middle measurement elsewhere in the project returned +0.562% at t = 0.41.`,
},
{
  id: 'R16', source: 'registry test 16', recorded_verdict: 'accepted',
  headline: 'Line shopping replication on a second sample, 2019-2025',
  state: `Claim: the finding that best-book expected value is negative replicates on an independent sample and independent source.
Method: scripts/model-lab/line_shopping_replication.py. The closing quote from each of four Covers books was taken for both sides of every game across the 2019 to 2025 seasons, realised returns were computed at the actual posted prices, and observations were collapsed by game. Best-book expected value by season was -4.87%, -5.31%, -5.96%, -5.35%, -4.47% and -4.32%, giving -4.61% overall against -4.00% for consensus, -5.26% for a random book and -6.45% for the worst book. A data-quality gate was required and mattered: mean cross-book disagreement is 7.97 points in 2019 with a 90th percentile of 18.5 and a maximum of 44.0, and 1.32 points in 2020, against 0.51 to 0.90 points in 2021 through 2025. Books do not disagree by eight points on a closing spread; left in, those rows produced a fake +32.6-point shopping gain and +26% best-book expected value for 2019. 452 side-observations above 3 points of dispersion were dropped, 330 of them from 2019.
Recorded conclusion: confirms the headline and explains its size. The shopping gain scales with book count — 0.66 points across four books versus 3.23 points across eleven — because four books disagree by only 0.52 points on average. Stated honest limit: best came out worse than consensus in 2021 through 2023, so this four-book sample cannot resolve the magnitude of the shopping gain, only its sign and its season-by-season consistency.`,
},
{
  id: 'R17', source: 'registry test 17', recorded_verdict: 'accepted',
  headline: 'Kalshi is cheaper than books for favourites, crossing at p = 0.57',
  state: `Claim: Kalshi charges less than the best of four sportsbooks for favourites and more for underdogs, with the crossover at an implied probability near 0.57.
Method: 78,604 minute-sides across 31 regular-season games. The quantity measured is the price paid per one dollar of payout, in cents, which requires no fair-value assumption. On Kalshi this is the crossable ask plus half the bid-ask spread plus the exchange fee of 0.07 times p times one minus p; at books it is the best of the four posted prices. Heavy favourites at 0.75 or above cost 82.63 cents at books against 81.53 on Kalshi, a difference of -1.094 percentage points at t = -4.70, with Kalshi cheaper in 92.3% of games. Moving through favourites, pick-em, underdogs and heavy underdogs, the difference goes -0.287, +0.383, +1.063 and +1.387 percentage points. The mechanism is derived structurally rather than fitted: a book's share of the overround is the implied probability times one minus the reciprocal of the sum of implied probabilities, which is mechanically proportional to the probability, while Kalshi's cost is half the bid-ask, flat at about 0.63 cents at every price, plus a fee humped at the money and near zero at the extremes. Proportional versus flat-plus-hump cross near p = 0.57. Measured book overround runs 4.11% at heavy favourites down to 0.95% at heavy underdogs; Kalshi's runs 1.40%, 2.17% and 1.59%. A maker version of the strategy that rests a bid rather than lifting the ask prints +2.5% expected value in every bucket, and the write-up rejects it on the grounds that an unfilled limit order is not a trade.
Recorded conclusion: real and structural but not an edge. Kalshi's best bucket is -1.88% expected value, which is worse than the -1.82% already available by shopping spreads.`,
},
{
  id: 'R18', source: 'registry test 18', recorded_verdict: 'accepted',
  headline: 'Totals line shopping returns -3.03% at the best book',
  state: `Claim: shopping the best available total across books does not reach break-even.
Method: 509,038 quote observations across 1,936 games, graded at actual posted prices, with the t statistic computed on game-collapsed observations. Best-book expected value is -3.03% with a shopping gain of +1.77 percentage points at t = -7.46.
Recorded conclusion: same shape as spreads and worse. This is the first time the totals market was measured in the project.`,
},
{
  id: 'R19', source: 'registry test 19', recorded_verdict: 'accepted',
  headline: 'Moneyline shopping returns -3.35% including underdogs',
  state: `Claim: shopping the moneyline, where price dispersion is largest, still does not reach break-even.
Method: 3,892 observations across 1,946 games at actual posted prices. Best-book expected value is -3.35% with a 95% confidence interval of -5.35% to -1.31% and a computed probability that expected value exceeds zero of 0.001. Dispersion does scale with price as expected: the shopping gain is +4.69 percentage points at implied probabilities of 20% or below against +0.90 percentage points above 80%.
Recorded conclusion: dispersion scales with price and the market still loses.`,
},
{
  id: 'R20', source: 'registry test 20', recorded_verdict: 'killed',
  headline: 'Closing-line inefficiency across 39 situational buckets',
  state: `Claim: the closing line is systematically inefficient in at least one of thirty-nine situational buckets — home underdogs, big road favourites, divisional games, primetime, low and high totals, and the key numbers 3 and 7 among them.
Method: 5,292 games were partitioned into 39 buckets and each bucket was tested against the closing line. The full family of 39 was enumerated and reported. A Bonferroni threshold of alpha = 0.00128 was applied, requiring an absolute t statistic of at least 3.220. Seven buckets reached nominal p below 0.05, against 2.0 expected under a pure null. Omnibus chi-squared tests were computed per market: spreads chi-squared = 21.18 at p = 0.012, totals p = 0.067, moneyline p = 0.174.
Recorded conclusion: zero of thirty-nine survive correction for having looked thirty-nine times.`,
},
{
  id: 'R21', source: 'registry test 21', recorded_verdict: 'inconclusive',
  headline: 'Kalshi live price versus ESPN in-game win probability',
  state: `Claim: when ESPN's in-game win probability model disagrees with Kalshi's live price, betting the ESPN side is profitable.
Method: scripts/model-lab/ingame_kalshi_vs_espn.py. Kalshi per-minute bid and ask were aligned to ESPN's per-play win probability through espn_plays.wallclock, which is a real UTC timestamp; the write-up notes that espn_probabilities.last_modified is an edit time and would misalign everything. The strategy buys the ESPN-favoured side at Kalshi's ask, paying the full bid-ask spread and the exchange fee of 0.07 times p times one minus p. All 560 observations across 14 games hit 50.2% for +1.02% return at t = +0.04. The 5 to 10 percentage point edge band, 424 observations across 14 games, hit 43.2% for +9.46% at t = +0.30. The 10 to 20 point band, 131 observations across 8 games, hit 74.0% for -9.90% at t = -0.23.
Recorded conclusion: inconclusive and cannot be powered this season. Fourteen games with a standard error of 28.71. Only sixteen games have been played in 2026, so that is the ceiling until more weeks land. Logged so it is re-run later.`,
},
{
  id: 'R22', source: 'registry test 22', recorded_verdict: 'killed',
  headline: 'Public betting percentages and sharp money',
  state: `Claim: fading the public, or following the money when the share of money diverges from the share of bets, is profitable.
Method: scripts/model-lab/public_money_splits.py over 2,112 completed games from 2018 to 2026 carrying both the share of bets and the share of money per side, which is the standard construction of sharp money. Twenty-two thresholds were enumerated and all twenty-two reported. The best cell for fading the public on spreads is public at 40% or below, hitting 52.37% for +0.18% at t = +0.05; on totals the best is public at 50% or below, hitting 51.49% for -1.50% at t = -0.57. Following the money on spreads with a gap of 15 percentage points or more hits 52.66% for +0.99% at t = +0.21; on totals with a gap of 20 points or more it hits 55.44% for +5.98% at t = +1.22. A bet-everything baseline that takes every side of every game was run and returns -4.27% on spreads and -4.38% on totals, which is precisely the vig. That baseline is the reason the result is trusted: a first run returned +567% on the same baseline, which exposed a naming trap in the an_public_splits table where spread_home holds the POINT SPREAD and spread_home_line holds the PRICE, the opposite of what the names imply, so a spread of 1.0 was being parsed as American odds worth a 33-times payout.
Recorded conclusion: no edge. Zero of twenty-two thresholds clear the corrected bar of absolute t at least 2.81, and the largest observed is 1.77. Fading extreme public sentiment is actively bad: at 20% public or below the return is -21.50%.`,
},
{
  id: 'R23a', source: 'registry test 23, as originally published', recorded_verdict: 'accepted',
  headline: 'Steam moves at a lagging book return +3.67% per bet',
  state: `Claim: when at least two of the four Covers books move the home spread the same way inside a time window by at least half a point in aggregate, betting the side the market moved toward at a book that has not yet moved and still shows a number on the wrong side of the movers returns +3.67% per bet.
Method: scripts/model-lab/steam_moves.py. Six parameter settings were run, varying the minimum number of moving books between two and three and the window between 30, 60 and 120 minutes. At two books and a 120-minute window, 18,667 bets across 1,659 games won 54.31% for closing line value of +0.73 points at t = +36.94 and expected value of +3.67% at t = +2.63. The other five settings gave win rates from 53.46% to 54.32% and expected values from +2.06% to +3.70%. Break-even is 52.38%. The write-up notes the result is stable across all six settings tried and is therefore not a threshold cherry-pick. An independent replication was run on a different source, the eleven-book Odds API tape, with different books and a different sampling design — a regular fifteen-minute grid where whether a book has moved is observed rather than inferred from the absence of a change row — and returned 58.90% and +7.81% at t = +0.93 on 15 games, the same sign and a similar magnitude. A second replication on the totals market with the same books and the same logic returned +5.04% to +5.57% at three books across all three windows. Requiring three of four books is positive in both markets at every window, while requiring only two of four collapses to zero on totals, which the write-up calls mechanically sensible because two of four books moving together happens by chance.
Recorded conclusion as published: the only positive expected value result of the night, stable across settings and replicated on a second source and a second market.`,
},
{
  id: 'R23b', source: 'registry test 23, refutation', recorded_verdict: 'killed',
  headline: 'Steam moves refuted three independent ways',
  state: `Claim: the steam-move result is an artifact and there is no edge.
Method: three attacks were run and a fourth independent data-artifact attack was commissioned. First, the script was audited and found to select the laggard book's home_price into a variable and then never use it — expected value was hardcoded at 100 divided by 110. The laggard's actual posted price averages -112.4 and 46.9% of laggard quotes are worse than -110. Re-graded at the price the script had already fetched, and counting the 211 pushes that a continue statement had silently dropped, the headline cell falls from +3.67% at t = +2.63 to +0.33% at t = +0.25, with a 2,000-replication bootstrap 95% interval of -2.34% to +3.00% and a one-sided p of 0.403. Second, a direction placebo was run: 200 shuffles randomising the steam direction reproduce the result, giving a null expected value of +2.78% with standard deviation 1.02 against a real +3.21% — the 65th percentile, z = +0.42 — and at three books a random direction does better than the real one, z = -0.46. The placebo reproduces the closing line value to three decimal places: null +0.729 against real +0.730, z = +0.10. Third, execution was examined: the laggard's price is worse than the movers' price on the same side 71.1% of the time, a median of five cents worse, and the juice scales with the apparent free points, from a mean price of -102.3 at zero closing line value to -119.6 at six points of closing line value. Collapsing 3.5 bets per game to one bet per game gives +0.34%. The bet multiplicity was then measured properly and is 11.25 bets per game, median 7, maximum 443 bets on a single game, and at three books 57.7% of games have every bet on the same side. A final stacked correction — real posted price, dropping 16 phantom season-mislabelled games and the corrupt 2019 and 2020 seasons, dropping cross-book gaps above 1.5 points, and one bet per game — walks the result from +3.66% at t = +2.62 down through +1.94%, +0.88%, +0.45% and finally -2.35% at t = -0.87 across 1,218 games. Restricted to 2021 and later at real prices it is -1.59%; the two best seasons in the sample at real prices are 2019 at +4.37% and 2020 at +5.39%, precisely the seasons with 7.97 and 1.32 points of cross-book disagreement. Multiplicity was stated: 22 prior hypotheses plus 12 steam settings is 34 comparisons, a Bonferroni alpha of 0.0015 requiring absolute t of at least 3.17, against a best observed of +2.64.
Recorded conclusion: refuted, fatally, three independent ways. The rule is a cross-book-dispersion harvester and the dispersion in this tape is largely scrape staleness. The fully corrected +0.80% matches the earlier stale-book test's +0.71%, closing the one open contradiction. Both replications were replicating the dispersion artifact rather than a signal, which is why they agreed. An earlier draft asserting the closing line value was real and correctly signed was explicitly overruled.`,
},
{
  id: 'R24', source: 'registry test 24', recorded_verdict: 'inconclusive',
  headline: 'Favourite-longshot bias in Kalshi prices',
  state: `Claim: Kalshi's NFL game prices show textbook favourite-longshot bias — longshots win less often than their price implies and favourites more — which would be exploitable by selling longshots without forecasting anything.
Method: scripts/model-lab/kalshi_calibration.py over 88,631 minute-quotes on KXNFLGAME markets that resolved to a completed 2026 game, bucketed by the no-vig mid price against the realised outcome. The 0.10 to 0.20 bucket, 2,938 quotes across 15 games, priced at 0.153 and realised 0.133. The 0.30 to 0.40 bucket, 21,774 quotes across 15 games, priced 0.358 and realised 0.267. The 0.60 to 0.70 bucket, 21,132 quotes across 15 games, priced 0.643 and realised 0.867, an error of +0.224 at t = +2.44 computed across games rather than across quotes. Every other bucket's t statistic computed by game is below 1 except one. Kalshi's fee of 0.07 times p times one minus p is near zero at the extremes where the bias would live, which helps.
Recorded conclusion: the shape is textbook but it rests on fifteen games and settles nothing. Minutes inside a game are near-perfectly dependent — a 30 to 3 blowout contributes hundreds of minutes all pointing the same way — so the effective sample is the game count, not the 88,631 quotes. The 0.90 to 0.98 cell's t of +19.94 is degenerate because all fourteen games won and variance collapses. Do not act on it; re-run once 2026 has 60 or more completed games with Kalshi coverage.`,
},
{
  id: 'R25', source: 'registry tests 25+', recorded_verdict: 'killed',
  headline: 'A registered family of 5,940 correlation tests, zero survivors',
  state: `Claim: among a large enumerated family of lagged team-week features, at least one correlates with a betting target strongly enough to be actionable.
Method: scripts/model-lab/mass_test_harness.py. 165 lagged features covering advanced team-week differentials on offence, defence and matchup, crossed with four targets — against-the-spread cover, total over, margin error and total error — and nine splits, for 5,940 tests on 1,646 games from 2016 to 2025. The family was enumerated mechanically in advance so that nothing could be dropped for being inconvenient, and every test was recorded. 393 tests reached nominal p below 0.05 against 297 expected under a pure null. The Bonferroni threshold is 8.42 times ten to the minus six, giving zero survivors; Benjamini-Hochberg at q = 0.10 also gives zero survivors. The strongest single result was matchup red-zone expected points added against margin error in the favourite-by-more-than-seven split, at r = -0.196 and p = 7.0 times ten to the minus five, still eight times short of the Bonferroni bar.
Recorded conclusion: zero survivors.`,
},
{
  id: 'R26', source: 'registry tests 25+, family sign test', recorded_verdict: 'accepted',
  headline: 'Teams that look stronger on recent advanced metrics underperform the spread',
  state: `Claim: teams that look stronger on recent advanced metrics systematically underperform the closing spread — the market prices recent form and slightly overshoots. Described as a real property of the market, not a fluke.
Method: within the 5,940-test family, a sign test was run on the direction of the correlations rather than on any single correlation, because a sign test is far more powerful. It was run on the all-games split only, on the grounds that the nine splits are nine views of the same games and are heavily dependent while the features are not — feature independence was measured, giving an effective rank of 39.7 by entropy and 24.5 by participation, with a mean absolute correlation between features of 0.104. For margin error, 123 of 165 features were negative, 74.5%, binomial p = 4.7 times ten to the minus ten, mean r = -0.0170. For against-the-spread cover, 113 of 165 were negative, 68.5%, p = 3.0 times ten to the minus six, mean r = -0.0144. For total over, 69 of 165 negative, p = 0.043; for total error, 91 of 165, p = 0.21. Three follow-up checks were then run. Magnitude: mean r of -0.017 means a one-standard-deviation feature move shifts cover probability under one percentage point against the 2.38 points needed at -110. Asymmetry: a walk-forward composite with signs and scaling fitted on prior seasons only, over 1,150 games from 2019 to 2025, gave top-quintile-to-home 54.78% but bottom-quintile-to-away only 49.57%, where a real signal works in both tails; the home base rate is 49.83% so the excess is +4.95 percentage points at a standard error of 3.30, about 1.5 standard errors. Monotonicity: cover rate across composite quintiles runs 50.43, 42.17, 52.61, 49.13, 54.78 — not monotonic, with the second quintile the worst bucket by eight points.
Recorded conclusion: a real directional property of the market that does not produce a usable ordering. Worth knowing and worth not betting. The write-up also corrects a prior belief recorded in the same document, that the effective rank was about 2.5, noting that figure applies to 35 collinear forecast signals rather than to raw descriptive features.`,
},
{
  id: 'R27', source: 'registry carried-forward prior results', recorded_verdict: 'killed',
  headline: 'Weekly ridge stacker over about 35 signals',
  state: `Claim: a weekly ridge regression stacking roughly 35 model signals produces an edge.
Method: recorded as measured in a 2026-09-16 audit before a data loss, and explicitly not re-litigated. The effective rank of the signal set is about 2.5, and the fitted ridge gives the market line itself between 35% and 52% of the weight.
Recorded conclusion: no edge.`,
},
{
  id: 'R28', source: 'registry carried-forward prior results', recorded_verdict: 'killed',
  headline: 'Confidence tiers and conviction sizing failed five ways',
  state: `Claim: sizing bets by the model's own confidence improves returns.
Method: recorded as measured in a 2026-09-16 audit before a data loss. The correlation between predicted edge size and correctness is -0.01. Component agreement sign-flipped. A meta-model trained to predict correctness scored an area under the curve of 0.489 on held-out 2024 data, which is below chance.
Recorded conclusion: failed five ways.`,
},
{
  id: 'R29', source: 'registry carried-forward prior results', recorded_verdict: 'killed',
  headline: 'Top-10% conviction tier hit 60%',
  state: `Claim: the highest-conviction decile of model picks hit 60%.
Method: recorded as measured in a 2026-09-16 audit. The 60% figure was traced to 127 fake Pinnacle placeholder openers in the underlying line data. After repairing those rows the tier hits 52.9%, and a preset rule built on the tier lost money in both 2024 and 2025.
Recorded conclusion: artifact.`,
},
{
  id: 'R30', source: 'registry carried-forward prior results', recorded_verdict: 'accepted',
  headline: 'Line shopping is worth about +4 points of expected value per bet and reaches break-even',
  state: `Claim: line shopping is the one measured positive in the project, worth roughly four points of expected value per bet, and it gets a bettor to approximately break-even, with models adding up to one point on top.
Method: recorded as measured in a 2026-09-16 audit before a data loss, carried forward into the registry so that nothing re-tests it and counts a rediscovery as a new finding. The write-up records the headline figure and the accompanying note that models add at most one point on top, which went negative in 2025. No sample size, book count, season range or grading procedure is recorded alongside the number.
Recorded conclusion: real, the only measured positive, and the assumed foundation on which a model would add the rest.`,
},
{
  id: 'R31', source: 'registry carried-forward prior results', recorded_verdict: 'killed',
  headline: 'Opener move direction is predictable',
  state: `Claim: the direction in which a line will move away from its opener is predictable.
Method: recorded as measured in a 2026-09-16 audit before a data loss and not re-litigated. Direction is recorded as predictable at the open; the recorded note is that it does not survive costs.
Recorded conclusion: predictable but not profitable.`,
},
{
  id: 'R32', source: 'registry carried-forward prior results', recorded_verdict: 'inconclusive',
  headline: 'Kalshi leads the sportsbooks by two to three hours',
  state: `Claim: Kalshi prices move two to three hours before sportsbook lines do.
Method: 36 games were observed with an apparent two to three hour lead. A preregistered test of the claim was written and is waiting for 150 games before it is run.
Recorded conclusion: open.`,
},
{
  id: 'R33', source: 'registry carried-forward prior results', recorded_verdict: 'killed',
  headline: 'Player props model, week one 2026',
  state: `Claim: the player props model has an edge on Underdog prop lines.
Method: 1,149 graded bets from week one of 2026 hit 50.0% with zero closing line value. Calibration was checked and is badly off: the 70% confidence bucket hit 48% and the 99% bucket hit 63%.
Recorded conclusion: no edge. The write-up adds a reproducibility note: this result can no longer be reproduced, because the deleted database held both the model's side selection and the Underdog closing lines, both of which are empty in the surviving copy, and 442 of the 443 surviving props carry both an Over and an Under, so re-settling them returns about 50% mechanically regardless of skill. The conclusion stands as recorded but is no longer checkable against data.`,
},
{
  id: 'R34', source: 'project graveyard, press conferences', recorded_verdict: 'killed',
  headline: 'Press conferences mark abnormal line movement',
  state: `Claim: the content of a coach's press conference marks a window in which the betting line moves abnormally.
Method: 482 press conference events with a real publication timestamp were used. Line movement in the window after each press conference averaged 1.438 points. A placebo was constructed by drawing matched windows at times with no press conference, which averaged 1.259 points. The difference gives t = 1.10.
Recorded conclusion: press conferences do not mark abnormal line movement. The write-up notes the test is underpowered at 482 timestamps but records this as the current evidence.`,
},
{
  id: 'R35', source: 'project graveyard summary', recorded_verdict: 'killed',
  headline: 'A graveyard-wide revivable signal of +0.64% per bet',
  state: `Claim: pooling across the whole graveyard of dead hypotheses leaves a residual revivable signal worth +0.64% per bet at t = 2.84.
Method: recorded as a graveyard-wide aggregate figure, measured against a stated cost to extract of 5.66%.
Recorded conclusion: real, and roughly five times too small for the vig.`,
},
{
  id: 'F01', source: 'F06 note, carried project finding', recorded_verdict: 'accepted',
  headline: 'Zero of 21 spread models beat 15,096 closing lines',
  state: `Claim: none of the twenty-one components in the spread ensemble beats the closing line through the project's promotion gate.
Method: at commit 73f930f dated 2026-08-27 the real spread-ensemble model list was evaluated against 15,096 real closing lines in the game_lines table, and zero of twenty-one components cleared the promotion gate. The F06 note records that this search was never filed in the project's own preregistration system: grep finds zero callers of preregister or runAudit outside the module and its test, and the audit_registry table is never populated for it. The evidence documents record that the individual per-component statistic behind the aggregate does not survive anywhere in the repository, git history or database — only the aggregate finding does — and each component is flagged as individual value not reconstructable and excluded from the Sharpe cross-section because there is no bet ledger.
Recorded conclusion: no real edge was ever demonstrated by the ensemble. This is recorded as the single most-cited finding in the project's history.`,
},
{
  id: 'F02', source: 'F06 note, carried project finding', recorded_verdict: 'accepted',
  headline: 'Nine signal families degraded under ablation',
  state: `Claim: nine of the model's signal families make the model worse when included — removing them improves performance.
Method: recorded in the project work log as an ablation study over signal families. The F06 note records that this finding, like the twenty-one-model one, was never filed in the project's preregistration system and carries no multiplicity correction of any kind; grep for multiplicity, Holm or Bonferroni in the experiments module returns zero hits, and no Holm-Bonferroni, deflated Sharpe ratio or combinatorially symmetric cross-validation implementation exists anywhere in the codebase.
Recorded conclusion: nine families degraded under ablation.`,
},
{
  id: 'F03', source: 'F06 note, carried project finding', recorded_verdict: 'killed',
  headline: 'Twenty-four candidates crossed with four statistics, zero survivors',
  state: `Claim: a search over twenty-four candidate signals crossed with four statistics produced no survivor.
Method: recorded in the project work log as twenty-four candidates times four statistics with zero survivors. The F06 note records that this search was never filed in the preregistration system either, and that the ninety-six-cell family carries no recorded multiplicity correction.
Recorded conclusion: zero survivors.`,
},
{
  id: 'F04', source: 'FIX_AND_ADD_ARCHITECTURE note', recorded_verdict: 'accepted',
  headline: 'The ensemble blend has -2.28 closing line value and is really three signals',
  state: `Claim: the twenty-component ensemble blend carries -2.28 points of closing line value, and the twenty models are really about three independent signals shrunk 63% toward the market line.
Method: recorded as a finding in a build-planning note synthesised from the research pass. The effective rank of the signal set was computed and is about 2.5 to 3 independent directions; the fitted blend weight on the market line is 63%. The same note records that five different modules in the codebase each compute closing line value with different mathematics, different sign conventions and different tables — one applies a totals-side inversion and another explicitly assumes lines are already expressed from the backed side's perspective and so does not — and that four different tables each store their own closing line value number in different units, points versus probability versus percentage. No shared function anywhere computes closing line value once.
Recorded conclusion: the blend is not a real combination, and nobody today can answer what the project's edge was with one number.`,
},
{
  id: 'F05', source: 'FIX_AND_ADD_ARCHITECTURE note', recorded_verdict: 'accepted',
  headline: 'The props module is the codebase\'s one area of proven skill, +27% Brier on 2+ touchdowns',
  state: `Claim: the player props module is the one area of measured skill in the codebase, evidenced by a 27% Brier score improvement on the two-or-more-touchdown market.
Method: recorded as a finding in a build-planning note. The figure is cited as the justification for prioritising a hierarchical count model over the existing touchdown regression, whose standard error is a Wald-normal heuristic of the square root of the expected value mislabelled as a Poisson standard error. The note records that two prior touchdown-model challengers already failed the same promotion gate, zero of three and zero of three, for a diagnosed problem with the grain of the data rather than the shape of the distribution.
Recorded conclusion: proven skill, and the area worth building on.`,
},
{
  id: 'F06', source: 'F01 / F17 notes', recorded_verdict: 'accepted',
  headline: 'The drive simulator manufactures a fake probability spike at margin 7',
  state: `Claim: the drive simulator's home-field advantage implementation manufactures extra probability mass at exactly the key number seven, which is the number the whole betting stack cares about most.
Method: the code was read directly. After both halves and overtime are already final, the simulator draws a single Bernoulli with probability equal to home-field points divided by seven and, if it hits, adds exactly seven points to the home score. The claim that this distorts the margin distribution is established by construction from the code rather than by fitting anything. It is cross-checked against the literature: every empirical source examined puts home-field advantage at a small continuous effect of roughly two to three points with a team-level posterior standard deviation of about 2.3, spread across the whole game through scoring rates, and no published win-probability model adds it as a post-hoc additive constant. Empirical key-number masses for the 2015 to 2023 epoch are cited as targets: the probability that the absolute margin is three is about 14.7%, seven about 8.9%, six about 7.3%.
Recorded conclusion: real, verified against the live file and line number, and a one-to-days fix. The proposed exit test is that there must be no anomalous spike in the 6.5 to 7.5 bin relative to neighbouring one-point bins.`,
},
{
  id: 'F07', source: 'F08 / F15 notes', recorded_verdict: 'accepted',
  headline: 'The team-strength blend is provably opponent-blind',
  state: `Claim: the blended team rating is blind to opponent strength — two teams with the same raw average margin against completely different schedules receive identical ratings.
Method: the code was read directly and the in-season component of the blended rating is a team's raw average margin, with no opponent adjustment anywhere in the path. The note states explicitly that this is checkable by construction rather than a claim requiring measurement. The proposed replacement is a closed-form paired-comparison ridge estimator from the Glickman and Stern literature, refit weekly, with the existing prior-season blend as the prior mean.
Recorded conclusion: real and provable. The proposed exit test is the existing team-strength walk-forward promotion gate, which requires at least two of three seasons significant before production.`,
},
{
  id: 'F08', source: 'N14 / N18 notes', recorded_verdict: 'killed',
  headline: 'Prediction-market arbitrage and social sentiment are not worth building for',
  state: `Claim: neither cross-venue prediction-market arbitrage nor live social sentiment is worth building execution infrastructure for.
Method: a literature pass across both areas. The best documented case for prediction-market arbitrage in the sources read is a Polymarket NBA study netting 210 to 560 dollars in total across an entire league-month. On sentiment, the one effect that replicates across the sources read is a bookmaker popularity bias which is already correctly priced rather than a standalone edge; a replication paper is cited alongside the original.
Recorded conclusion: thin-to-negative evidence even in its own best case. Do not build execution infrastructure for either.`,
},
];
