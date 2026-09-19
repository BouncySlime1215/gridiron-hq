/**
 * The audit corpus: every recorded finding in EDGE-TEST-REGISTRY.md plus the empirical and
 * code-defect findings recorded in the F-series research docs, rendered as STATE.
 *
 * Each `state` is a faithful prose rendering of (a) the claim and (b) THE METHOD THAT PRODUCED
 * THE CURRENT RECORDED VERDICT. For an entry whose verdict is a kill, the method rendered is the
 * KILL's method -- so scoring the state scores the kill, which is the point: a strategy killed by
 * a weak argument is not actually dead.
 *
 * Deliberately NOT included in the state: the registry's own editorial judgement ("fatally",
 * "decisive", "the cleanest statement of the night"). The auditor is asked to judge the method,
 * not to agree with the author's adjectives.
 */

export type Kind = 'market_test' | 'kill_of_a_market_test' | 'code_defect' | 'literature_or_design';
export type Recorded = 'accepted' | 'killed' | 'blocked' | 'inconclusive' | 'withdrawn' | 'open';

export interface Finding {
  id: string;
  src: string;
  kind: Kind;
  recorded: Recorded;
  title: string;
  state: string;
  /** my own hand labels, written BEFORE running Jev, for the validation set only */
  mine?: {
    placebo: 0 | 1; price: 0 | 1; clustered: 0 | 1; baseline: 0 | 1; mult: 0 | 1;
    sound: 0 | 1 | 2 | 3 | 4; // 0 fatally flawed .. 4 exemplary
  };
}

export const FINDINGS: Finding[] = [
// ---------------------------------------------------------------- registry tests 1-4
{
  id: 'T01', src: 'EDGE-TEST-REGISTRY Tests', kind: 'market_test', recorded: 'blocked',
  title: 'Wong teaser legs hit 74.69%',
  state: `CLAIM: 6-point teaser legs that cross both 3 and 7 (favourite -7.5/-8.5, dog +1.5/+2.5) win 74.69% of the time, 95% CI [72.41, 76.98].
METHOD: 1,391 individual teaser legs drawn from closing spreads in the game_lines table, seasons 1999-2025. Each leg graded win/loss against the final score. The win rate is compared against the break-even rate implied by three candidate teaser prices: -110 (break-even 72.37%), -120 and -130. Result beats -110 by +2.32 percentage points (+1.99 standard errors) and does not beat -120 (+0.72 SE) or -130 (-0.42 SE).
NOTED BY THE AUTHOR: no teaser price data exists anywhere in the project. The nfl_teaser_price_ledger table is empty and the Odds API tape carries only straight spreads, so which of the three prices is actually obtainable cannot be determined from held data. Legs are counted individually; a two-leg teaser is one ticket. No shuffle or randomisation control was run. No bet-everything baseline was computed.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 1 },
},
{
  id: 'T02', src: 'EDGE-TEST-REGISTRY Tests', kind: 'market_test', recorded: 'killed',
  title: 'Teaser edge has not decayed across eras',
  state: `CLAIM: the Wong teaser leg win rate has not decayed as books wised up: 73.26% then 75.41% then 75.46% across three eras.
METHOD: the same 1,391 closing-spread legs split into three era buckets of 475 / 427 / 489 legs. Win rates compared across eras by eye; no test statistic for the trend is reported, no confidence interval per era, no correction for this being the second of four cuts on one dataset. No price is applied. No placebo. No clustering by game.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 0 },
},
{
  id: 'T03', src: 'EDGE-TEST-REGISTRY Tests', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Teaser edge is NOT stronger on low totals',
  state: `CLAIM BEING KILLED: teaser legs pay better in low-total games (a hypothesis that predated the data).
KILL METHOD: the same closing-spread legs split into five total buckets of 417 / 318 / 313 / 211 / 132. The low bucket (total <= 41) wins 74.82%, no better than the middle. The best bucket (44.5-47) wins 77.64% and is explicitly discounted by the author as a 1-of-5 cherry-pick at only +1.61 standard errors above the comparison price. The author counts this as one of four comparisons on one dataset and states that the headline Test 1 result does not survive correction for them. No price data. No placebo. No clustering.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 1, sound: 2 },
},
{
  id: 'T04', src: 'EDGE-TEST-REGISTRY Tests', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Teaser edge is not concentrated on a particular side',
  state: `CLAIM BEING KILLED: teaser legs pay better on one side type (home favourite, home dog, road favourite, road dog).
KILL METHOD: four side buckets of 128 to 503 legs. Home favourite worst at 72.18%, home dog best at 75.82%. No bucket clears +1.96 standard errors against a -120 price, so the kill is a failure-to-reject on a significance threshold that is itself uncorrected for the four buckets plus the three earlier cuts. No placebo, no clustering, no bet-everything baseline, no real teaser price.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 1 },
},
// ---------------------------------------------------------------- test 5, 6
{
  id: 'T05', src: 'EDGE-TEST-REGISTRY Test 5', kind: 'market_test', recorded: 'accepted',
  title: 'Preregistered shadow tape: +0.94pp closing-line value',
  state: `CLAIM: 56 betting decisions written to a shadow_decisions table at 2026-09-03T21:01Z, days before week 1 kicked off -- each carrying side, book, exact line, price, opener and the signal that produced it -- earned +0.94 percentage points of closing-line value, t = +2.04, when clustered by game across 15 games. Naive unclustered on 52 decisions it is +1.12pp at t = +2.61. Clustered by game-by-market on 29 units it is +1.13pp at t = +2.97.
METHOD: the decisions were frozen before kickoff, so no parameter can have been tuned after the fact; the author calls this the only genuinely out-of-sample forward test in the project. Graded by scripts/model-lab/grade_shadow_tape.py against nflverse closing lines, not against the preregistered settlement source (Pinnacle's last pre-kickoff line was never captured because the collector died). Standard errors are reported three ways -- naive, clustered by game, clustered by game-by-market -- and the clustered number is the one the author headlines.
The author states t = +2.04 on 15 games is p about 0.06 two-tailed, that no individual signal clears significance alone, and that the 40.4% win rate has a 95% confidence interval of 27-54% so results carry no information at this sample size.
LIMIT RECORDED SEPARATELY BY THE AUTHOR: the closing-line value is LINE-ONLY. grade_shadow_tape.py derives it from the empirical margin distribution applied to the line, with no price term at all. A direct price check on all 56 decisions found mean price paid -104.8 against mean closing price -106.0, and paid-versus-no-vig-close of -2.62pp over 16 games at t = -8.57; the author notes the two quantities are not commensurable because the price paid carries vig while the closing probability has vig removed. No shuffle or placebo control was run on the tape. No bet-everything baseline. No correction for the 20-plus hypotheses tested elsewhere in the project.`,
  mine: { placebo: 0, price: 0, clustered: 1, baseline: 0, mult: 0, sound: 2 },
},
{
  id: 'T06A', src: 'EDGE-TEST-REGISTRY Test 6 (first run)', kind: 'market_test', recorded: 'killed',
  title: 'teamrankings_vs_open backtest: +2.24pp CLV, t=+7.71',
  state: `CLAIM AS FIRST PUBLISHED: a team-ratings-versus-opening-line signal earned +2.24 percentage points of closing-line value, t = +7.71, on 795 bets, 2022-2025.
METHOD AS FIRST RUN: scripts/model-lab/beat_close_backtest.py priced each week's ratings against the "opener" in a rebuilt nfl_odds_archive table, where opener is defined as MIN(ts_utc) from the Covers tape. Graded on closing-line value, clustered by game. No price column is read anywhere in the script -- the closing-line value is computed on lines alone. No placebo. No bet-everything baseline.`,
  mine: { placebo: 0, price: 0, clustered: 1, baseline: 0, mult: 0, sound: 0 },
},
{
  id: 'T06B', src: 'EDGE-TEST-REGISTRY Test 6 (the kill)', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'The +2.24pp was a stale-opener look-ahead; repriced it is +0.29pp',
  state: `CLAIM BEING KILLED: teamrankings ratings versus the opening line earn +2.24pp of closing-line value at t = +7.71.
KILL METHOD: the "opener" was MIN(ts_utc) from Covers, which is a median 11-12 days before kickoff with a tail to 276 days and a 134-day median in 2026 because spring lookahead lines are in the tape. Pricing a week-W rating against a line posted around week W-2 hands the rating two weeks of information the market had not yet seen, at a price that is no longer quotable. The tell that prompted the check was 2025 showing +5.53pp against 2022's +0.60pp. The fix reprices at a realistic decision point -- Wednesday of game week, last quote at or before it -- which brings the median lag to 3 days, matching the live tape's observed 23-second opener-to-decision gap. Repriced, the effect drops 87% to +0.29pp overall at t = +2.71 on 823 bets, clustered by game, with a season breakdown of 2022 +0.06pp (t +0.29), 2023 +0.45pp (t +2.20), 2024 +0.61pp (t +3.17), 2025 +0.02pp (t +0.10) and win rates 47.5 / 54.4 / 52.6 / 50.7%. The author's verdict is that +0.29pp against roughly 4.5pp of vig and a 51.3% win rate against the 52.38% needed at -110 is real but economically useless, with two of four seasons at zero.
The author separately records that this backtest is still LINE-ONLY closing-line value with no price term read at all.`,
  mine: { placebo: 0, price: 0, clustered: 1, baseline: 1, mult: 0, sound: 3 },
},
// ---------------------------------------------------------------- tests 7-11
{
  id: 'T07', src: 'EDGE-TEST-REGISTRY Test 7', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Kalshi per-minute quotes do NOT lead sportsbook lines',
  state: `CLAIM BEING KILLED: Kalshi's per-minute prediction-market quotes lead sportsbook lines, so the book line can be predicted from Kalshi.
KILL METHOD: 227,810 aligned minute-bars across 14 games. Cross-correlation at a range of lags found no lead at any lag; closing-line value +0.08pp, quarter-Kelly growth 0. The decisive diagnostic is a data-density one: of the 227,810 minute-bars only 306 have a nonzero Kalshi move and only 67 have a nonzero book move, so the overwhelming majority of bars carry no information in either series. The author notes the only thing in the test that resembled an edge traced back to line shopping. 14 games. Graded on closing-line value and Kelly growth. No placebo reported. No bet-everything baseline reported.`,
  mine: { placebo: 0, price: 1, clustered: 1, baseline: 0, mult: 0, sound: 2 },
},
{
  id: 'T08', src: 'EDGE-TEST-REGISTRY Test 8', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Injury news to line movement: +0.39pp CLV, 55.1% -- killed for having no holdout',
  state: `CLAIM: injury news moves the line and the direction is predictable; measured +0.39pp of closing-line value at a 55.1% win rate on 185 bets.
KILL METHOD: the kill is not a statistical refutation of the +0.39pp. The author establishes that the timestamps are genuinely real -- nfl_injuries.modified_at is second-precision and 77% of rows land Friday 17:00-21:00 UTC, which is exactly the NFL final-injury-report window, so the timestamps are not backfilled -- and then kills the finding on data availability: 2025 and 2026 carry no injury timestamps at all, so there is no out-of-sample period to test on. The positive in-sample result is left unrefuted and unexplained. Graded on closing-line value and Kelly. No placebo run. No bet-everything baseline. No multiplicity correction. Sample 185 bets, game clustering not stated.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 1 },
},
{
  id: 'T09', src: 'EDGE-TEST-REGISTRY Test 9', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: '55 advanced team-week features vs the closing line: -0.30pp',
  state: `CLAIM BEING KILLED: 55 advanced team-week features carry information the closing line has not priced.
KILL METHOD: model fit on 2022-2024 and tested out of sample on 2025 (237 games), 923 bets total. Result -0.30pp of closing-line value, 50.2% win rate, quarter-Kelly growth 0. The author's reading: the features are real football signal and the market has already priced all of it. Out-of-sample design is genuine (fit and test periods are chronologically disjoint). Graded on closing-line value and Kelly growth. No placebo reported. No bet-everything baseline reported. No correction for the 55 features having been screened.`,
  mine: { placebo: 0, price: 0, clustered: 1, baseline: 0, mult: 0, sound: 2 },
},
{
  id: 'T10', src: 'EDGE-TEST-REGISTRY Test 10', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Three-venue divergence: the test cannot be run at all',
  state: `CLAIM BEING KILLED: divergence between sportsbooks, Kalshi and Polymarket predicts the closing line.
KILL METHOD: a coverage audit, not a statistical test. Zero regular-season games have all three venues quoting: Kalshi candles start 2026-05-15, Polymarket winner history ends 2026-08-28, and the 42-game overlap between them is entirely preseason. A two-venue version was run anyway on 558 bets and returned +0.09pp of closing-line value with quarter-Kelly growth 0.067. The author's verdict is that the three-venue test cannot be run. No placebo, no baseline, no multiplicity correction; the kill rests entirely on the coverage audit, which is verifiable from date ranges.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 2 },
},
{
  id: 'T11', src: 'EDGE-TEST-REGISTRY Test 11', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Kalshi order-book microstructure: -0.01pp, killed by pre-specified controls',
  state: `CLAIM BEING KILLED: Kalshi order-book microstructure (bid-ask spread widening, open-interest jumps) predicts the game outcome or the book line.
KILL METHOD: 64 games. Result -0.01pp of closing-line value, 45.8% hit rate, quarter-Kelly growth 0.01. The author states that a placebo control and a disjoint-book control were both SPECIFIED BEFORE GRADING, and that no signal survived either. The author also logs that this test consumed part of the 2026 season, which was the project's last clean holdout, so 2026 is no longer virgin for Kalshi microstructure work -- the test's own agent flagged this. Sample 64 games. Price awareness not stated. Multiplicity across the microstructure variants tried is not reported.`,
  mine: { placebo: 1, price: 0, clustered: 1, baseline: 0, mult: 0, sound: 3 },
},
// ---------------------------------------------------------------- tests 12-16
{
  id: 'T12', src: 'EDGE-TEST-REGISTRY Test 12', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Stale-book: bet the laggard after consensus moves -- +0.71%',
  state: `CLAIM BEING KILLED: after the consensus moves, betting the book that has not yet repriced is profitable.
KILL METHOD: 293 opportunities across 32 games on the 11-book Odds API tape. Realised expected value +0.71% per bet, which does not clear break-even against roughly 4.5pp of vig. The author separately establishes that the lag itself is real and large -- DraftKings' median quote is 2,302 minutes behind consensus and the stale number sits up a median of 675 minutes -- so availability is not the binding constraint; the number simply does not pay. Only 32 games. Whether real posted prices were used is not stated in this entry. No placebo. No bet-everything baseline in this entry. No multiplicity correction.`,
  mine: { placebo: 0, price: 0, clustered: 1, baseline: 0, mult: 0, sound: 1 },
},
{
  id: 'T13', src: 'EDGE-TEST-REGISTRY Test 13', kind: 'market_test', recorded: 'accepted',
  title: 'Line shopping is a cost reduction, not an edge: best book -1.82%',
  state: `CLAIM: perfect line shopping across 11 books returns -1.82% per bet, which is better than a random book's -5.05% but still loses money. The full ladder: best book -1.82%, best price on the consensus number -4.01%, consensus -4.88%, random book -5.05%, worst book -8.42%. Shopping is therefore worth about +3.23 points versus a random book (median +2.63), and the author's own headline is that the project's founding "roughly +4 points of expected value from shopping" claim is overstated by about 60% -- the real number is +2.5 to +2.6 points, and it is a cost reduction, not an edge.
METHOD: 561,746 pre-kickoff quote opportunities across 260 games. Every quote is a real posted price from the 11-book tape; expected value is computed per bet from those prices and the realised outcome, not from an assumed -110. The random-book and consensus arms function as an explicit baseline ladder, and the random-book arm coming in at -5.05% and consensus at -4.88% is itself a check that the pipeline reproduces the vig.
CAVEAT RECORDED BY THE AUTHOR: measured on a single window, 2026-09-01 to 2026-09-17, spreads only (the Odds API tape carries no head-to-head and no totals), 260 games. One window, one market. The author says it should be re-measured on a second season before being treated as settled. No placebo. Game clustering not stated for the headline number.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 1, mult: 0, sound: 3 },
},
{
  id: 'T14', src: 'EDGE-TEST-REGISTRY Test 14', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Cross-venue arbitrage: no real arb exists',
  state: `CLAIM BEING KILLED: books, Kalshi and Polymarket can be crossed for a riskless arbitrage.
KILL METHOD: 110 candidate opportunities scanned across 275,238 venue-minutes. The cheapest two-sided round trip found anywhere costs a median 1.0375, meaning you pay 3.75% to own both sides of the same event. Only 3 minutes in six weeks beat the fees and all three were traced to data errors. Arbitrage windows have a median life of 2 minutes. Prices are real two-sided quotes with fees applied, not mid-prices. The author records a companion null from the same tape: maximum quote age across 1.91 million rows is 884 seconds with zero rows older than an hour, so the "stale quote masquerading as arbitrage" failure mode does not exist in this dataset. No placebo (an arbitrage claim is arithmetic, not statistical). No multiplicity correction.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 0, mult: 0, sound: 3 },
},
{
  id: 'T15', src: 'EDGE-TEST-REGISTRY Test 15', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Middles and key-number straddles: -2.62%, t=-8.99 clustered',
  state: `CLAIM BEING KILLED: buying both sides across a gap between books (a middle) or straddling a key number is profitable.
KILL METHOD: 56,120 opportunities across 1,757 games. Realised -2.62% per opportunity, with the result clustered by game giving t = -8.99. The author states an a-priori model predicted -2.48% and the out-of-sample realisation was -2.40%, so the loss is predicted by the arithmetic rather than discovered in the data. Mechanism given: middles hit 1.67% of the time against a vig that costs far more. Large sample, game-clustered, out-of-sample agreement with a pre-stated model. No placebo. No explicit bet-everything baseline, though the arithmetic model plays that role.`,
  mine: { placebo: 0, price: 1, clustered: 1, baseline: 1, mult: 0, sound: 4 },
},
{
  id: 'T16', src: 'EDGE-TEST-REGISTRY Test 16', kind: 'market_test', recorded: 'accepted',
  title: 'Line-shopping replication on a second sample: best-book EV negative every season',
  state: `CLAIM: best-book expected value is negative in every season measured. 2019-2025 across 4 Covers books: best -4.61%, consensus -4.00%, random -5.26%, worst -6.45%, so the shopping gain is only +0.66 points. Season by season the best-minus-random gain is +0.52, +0.02, -0.39, -0.52, +0.46, +0.88 -- negative in three of six seasons. Against the 11-book 2026 sample's +3.23, this establishes that the shopping gain scales with book count: 4 books disagree by only 0.52 points on average.
METHOD: scripts/model-lab/line_shopping_replication.py. Closing quote per book, both sides of every game, realised returns at real posted prices, clustered by game. The random-book and consensus arms are an explicit baseline ladder.
A DATA-QUALITY GATE WAS REQUIRED AND IS REPORTED: Covers' early spreads are corrupt -- mean cross-book disagreement is 7.97 points in 2019 (p90 18.5, max 44.0) and 1.32 in 2020, against 0.51-0.90 in 2021-2025. Left in, those rows produced a fake +32.6-point shopping gain and a +26% best-book expected value for 2019. 452 side-observations above 3 points of dispersion are dropped, 330 of them from 2019.
HONEST LIMIT STATED BY THE AUTHOR: "best" came out worse than "consensus" in 2021-2023, and at 0.52-point dispersion the two are usually the same offer with a gap inside a couple of standard errors, so this 4-book sample cannot resolve the magnitude of the shopping gain -- only its sign and its season-by-season consistency. No placebo. No multiplicity correction.`,
  mine: { placebo: 0, price: 1, clustered: 1, baseline: 1, mult: 0, sound: 4 },
},
// ---------------------------------------------------------------- tests 17-21
{
  id: 'T17', src: 'EDGE-TEST-REGISTRY Test 17', kind: 'market_test', recorded: 'accepted',
  title: 'Kalshi is cheaper for favourites, more expensive for dogs, crossing at p=0.57',
  state: `CLAIM: measured in cents paid per dollar of payout -- no fair-value assumption needed -- Kalshi is cheaper than the best of 4 books for heavy favourites (-1.094pp, t = -4.70, cheaper in 92.3% of minute-sides) and more expensive for dogs (+1.063pp at p 0.25-0.40, t = +6.51; +1.387pp for heavy dogs, t = +2.58), crossing at about p = 0.57.
METHOD: 78,604 minute-sides across 31 regular-season games, bucketed by implied probability, with n and game count reported per bucket (5,074/7 games, 21,174/20, 26,257/11, 21,069/19, 5,030/6). Kalshi cost is half the real bid-ask plus the actual 0.07*p*(1-p) fee; book cost is the real posted price. t statistics are reported per bucket.
THE AUTHOR GIVES A STRUCTURAL MECHANISM RATHER THAN A FITTED ONE: a book's share of the overround is i*(1 - 1/S), mechanically proportional to the probability, while Kalshi's cost is a flat half-spread (about 0.63 cents at every price) plus a fee humped at the money and near zero at the extremes. Proportional versus flat-plus-hump must cross, and the predicted crossing point matches the measured one. Measured book overround runs 4.11% at heavy favourite down to 0.95% at heavy dog; Kalshi's runs 1.40 / 2.17 / 1.59%.
THE AUTHOR REJECTS A FAKE EDGE INSIDE THE SAME TEST: a maker version that rests a bid instead of lifting the ask prints +2.5% expected value in every bucket, and the author discards it on the grounds that an unfilled limit order is not a trade.
CONCLUSION DRAWN: still not an edge. Kalshi's best bucket is -1.88% expected value, worse than the -1.82% already available by shopping spreads. Only 31 games, and buckets rest on as few as 6 games. No placebo. No multiplicity correction across the five buckets.`,
  mine: { placebo: 0, price: 1, clustered: 1, baseline: 1, mult: 0, sound: 3 },
},
{
  id: 'T18', src: 'EDGE-TEST-REGISTRY Test 18', kind: 'market_test', recorded: 'accepted',
  title: 'Totals line shopping: best book -3.03%',
  state: `CLAIM: shopping the best totals price across books returns -3.03% per bet, a gain of +1.77 percentage points over the baseline, t = -7.46 against zero.
METHOD: 509,038 quote-sides across 1,936 games, real posted prices, same construction as the spreads version. The author frames it as the same shape as spreads and worse. Game count is large and t is computed. Whether the t is game-clustered is not stated in this entry. No placebo. No multiplicity correction.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 1, mult: 0, sound: 3 },
},
{
  id: 'T19', src: 'EDGE-TEST-REGISTRY Test 19', kind: 'market_test', recorded: 'accepted',
  title: 'Moneyline shopping including underdogs: best book -3.35%',
  state: `CLAIM: best-book moneyline expected value is -3.35% per bet, 95% confidence interval [-5.35, -1.31], with the probability that expected value exceeds zero at 0.001. Dispersion does scale with price -- the shopping gain is +4.69pp at implied probability under 20% versus +0.90pp above 80% -- and it still loses.
METHOD: 3,892 quote-sides across 1,946 games, real posted moneyline prices converted to expected value against realised outcomes. A confidence interval and a posterior probability are reported rather than a bare point estimate. No placebo. Clustering not stated. No multiplicity correction across the price buckets.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 1, mult: 0, sound: 3 },
},
{
  id: 'T20', src: 'EDGE-TEST-REGISTRY Test 20', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Closing-line efficiency probed 39 ways: zero survive Bonferroni',
  state: `CLAIM BEING KILLED: some identifiable bucket of games -- home dogs, big road favourites, divisional games, primetime, low totals, high totals, key numbers 3 and 7 -- beats the closing line.
KILL METHOD: 39 buckets enumerated and all 39 tested on 5,292 games. Bonferroni threshold set at alpha = 0.00128 requiring |t| >= 3.220; zero of 39 clear it. 7 buckets are nominally p < 0.05 against 2.0 expected under a pure null. Omnibus chi-squared tests are reported per market: spreads 21.18 (p = 0.012), totals p = 0.067, moneyline p = 0.174. The multiplicity correction is explicit and pre-stated, and the count of nominal hits is compared against its null expectation rather than being reported alone. Whether real posted prices were used is not stated. No placebo. Game clustering not stated (units are games, so each game contributes once).`,
  mine: { placebo: 0, price: 0, clustered: 1, baseline: 0, mult: 1, sound: 3 },
},
{
  id: 'T21', src: 'EDGE-TEST-REGISTRY Test 21', kind: 'market_test', recorded: 'inconclusive',
  title: 'In-game: Kalshi live price vs ESPN win probability',
  state: `CLAIM: betting the side ESPN's win-probability model favours, at Kalshi's ask, returns +1.02% on 560 bets across 14 games (50.2% hit rate, t = +0.04); at an edge of 5-10 percentage points +9.46% (t = +0.30) and at 10-20 points -9.90% (t = -0.23).
METHOD: scripts/model-lab/ingame_kalshi_vs_espn.py. Kalshi per-minute bid/ask aligned to ESPN per-play win probability through espn_plays.wallclock, which is a real UTC event timestamp; the author explicitly rejects espn_probabilities.last_modified because it is an edit time and would misalign everything. Bets cross the real bid-ask and pay the actual 0.07*p*(1-p) Kalshi fee.
VERDICT RECORDED: inconclusive and not powerable this season. 14 games with a standard error of 28.71, and only 16 games have been played in 2026, so that is the ceiling. Logged so it is re-run later rather than re-invented. No placebo. Clustering by game is implicit in the game count reported but not in the t. No multiplicity correction across the three edge cuts.`,
  mine: { placebo: 0, price: 1, clustered: 1, baseline: 0, mult: 0, sound: 2 },
},
// ---------------------------------------------------------------- test 22
{
  id: 'T22', src: 'EDGE-TEST-REGISTRY Test 22', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Public betting % and sharp money: zero of 22 thresholds clear',
  state: `CLAIM BEING KILLED: fading the public, or following the money (the gap between the share of BETS and the share of MONEY on a side), is profitable.
KILL METHOD: scripts/model-lab/public_money_splits.py on 2,112 completed games, 2018-2026, that carry both bet share and money share per side. 22 thresholds were enumerated and all 22 reported. The best cells: fade the public on spreads at public <= 40% gives 52.37% and +0.18% expected value (t = +0.05); follow the money on totals at a gap >= 20 percentage points gives 55.44% and +5.98% (t = +1.22). Zero of 22 clear the corrected bar of |t| >= 2.81; the largest observed is 1.77. Fading extreme public sentiment is actively bad: at <= 20% public the return is -21.50%.
THE BET-EVERYTHING BASELINE IS REPORTED AND IS THE PROOF THE PIPELINE IS RIGHT: betting every side of every game returns -4.27% on spreads and -4.38% on totals, precisely the vig. A first run returned +567% on that same baseline, which exposed a column-naming trap -- in the an_public_splits table, spread_home is the POINT SPREAD and spread_home_line is the PRICE, the opposite of what the names imply, so a spread of 1.0 read the intuitive way parses as American odds worth a 33-times payout. The baseline caught it immediately and is now permanently in the script.
No placebo shuffle. Game clustering not explicitly stated, though units are games.`,
  mine: { placebo: 0, price: 1, clustered: 1, baseline: 1, mult: 1, sound: 4 },
},
// ---------------------------------------------------------------- test 23 cluster
{
  id: 'T23A', src: 'EDGE-TEST-REGISTRY Test 23 (as published)', kind: 'market_test', recorded: 'killed',
  title: 'Steam moves at a lagging book: +3.67% EV, stable across six settings',
  state: `CLAIM AS PUBLISHED: when at least two of the four Covers books move the home spread the same way inside a time window by at least 0.5 points in aggregate, betting the side the market moved toward at a book that has not yet moved returns +3.67% expected value (t = +2.63) on 18,667 bets across 1,659 games, at a 54.31% win rate against a 52.38% break-even, with +0.73 points of closing-line value at t = +36.94.
METHOD AS PUBLISHED: scripts/model-lab/steam_moves.py. Six parameter settings were swept (minimum books 2 or 3, window 30, 60 or 120 minutes) and all six reported: win rates 53.46% to 54.32%, expected value +2.06% to +3.70%. The author argues the stability across all six settings shows it is not a threshold cherry-pick. A bet-everything baseline of -4.3% is cited as the reference.
PRICING: expected value is computed at a flat 100/110. The script selects the laggard book's home_price column into a variable and the variable is never used.
The author lists six reasons for suspicion before defending the result: it does not clear the Bonferroni bar (6 settings plus 22 prior tests gives alpha = 0.0018 needing |t| >= 3.12, best observed +2.63); the closing-line-value t of +36 is partly mechanical because the rule selects books offering a better number than the movers and the "close" is the median of each book's last line INCLUDING the laggard book being bet; a directional bug was already found here once (the first run bet the wrong side and returned closing-line value -0.93 at t = -24.86, and the mirror-image magnitude is what exposed it); seasons are unstable at 2022 -4.28% and 2026 -2.05% against 2023 +7.66%; corrupt 2019-2020 Covers data with 7.97 and 1.32 points of cross-book disagreement is not filtered; and a close cousin, the stale-book test, found a real large lag and returned only +0.71%.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 1, mult: 1, sound: 0 },
},
{
  id: 'T23B', src: 'EDGE-TEST-REGISTRY Test 23 (replication 1)', kind: 'market_test', recorded: 'killed',
  title: 'Steam replicated on the 11-book Odds API tape: +7.81%',
  state: `CLAIM: the steam result replicates on a different source with different books and different sampling. On the 11-book Odds API tape sampled on a regular 15-minute grid -- where "has this book moved" is OBSERVED rather than inferred from the absence of a change row -- the rule wins 58.90% with +1.06 points of closing-line value and +7.81% expected value (t = +0.93), against Covers' 54.19%, +0.93 points and +3.45%.
METHOD: scripts/model-lab/steam_moves_oddsapi.py, 15 games. The author states plainly that 15 games cannot confirm anything at t = +0.93, and claims only that it rules out "artifact of Covers' change-triggered sampling", which was the leading alternative explanation. Two join bugs were found and fixed on the way, both of which silently returned zero rows rather than wrong ones: nflverse writes the Rams as LA while the full-name map yields LAR, and oddsapi_snapshots.side is literally 'home'/'away' unlike nfl_line_snapshots where side holds the full team name.
Pricing inherits the parent script's flat 100/110. No placebo. No clustering correction. No multiplicity correction.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 1 },
},
{
  id: 'T23C', src: 'EDGE-TEST-REGISTRY Test 23 (replication 2)', kind: 'market_test', recorded: 'killed',
  title: 'Steam replicated on TOTALS: +5.04% to +5.57% at 3-of-4 books',
  state: `CLAIM: the same steam logic on the totals market with the same books returns +5.04%, +5.57% and +4.94% at minimum-books 3 for windows 30, 60 and 120, against +3.38%, +3.45% and +3.70% on spreads -- so requiring 3 of 4 books is positive in both markets at every window, with closing-line value +0.90 to +0.98. Requiring only 2 of 4 collapses to +0.59%, +0.30% and +0.01% on totals, which the author calls mechanically sensible because two of four books moving together happens by chance.
METHOD: a grading bug surfaced first and the author records it because it was caught the same way as the spread one. Totals initially returned closing-line value -0.98 at t = -40.53, a near-exact mirror of the spread's +0.93, which the author treats as a bug signature rather than a finding. The cause: a total is graded points > line for the over, so a LOWER line is better, whereas a spread is graded points + line > 0 where a HIGHER line is better, so closing-line value flips sign for the over side. After correcting it the author re-ran the spread control and confirmed it was unchanged at +0.93 and +3.45%.
Multiplicity is tracked explicitly: 22 prior hypotheses plus 12 steam settings gives 34 comparisons, Bonferroni alpha 0.0015 needing |t| >= 3.17, best observed +2.64 -- so the author records that it still does not clear, while noting the 12 settings are one hypothesis at different parameters rather than 12 independent ones.
Pricing remains the flat 100/110 inherited from the parent script. No placebo at this stage.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 1, mult: 1, sound: 1 },
},
{
  id: 'T23D', src: 'EDGE-TEST-REGISTRY Test 23 (kill 1: price)', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'KILL 1 -- the price was fetched and never used; at real prices +3.67% becomes +0.33%',
  state: `CLAIM BEING KILLED: steam moves at a lagging book return +3.67% expected value.
KILL METHOD: the script selects the laggard's home_price into a variable and then never uses it; expected value is hardcoded at 100/110. The premise of the entire test is that you bet at a book that has not repriced, and a stale book defends itself with JUICE rather than by moving the line -- so the hardcoded price is wrong in exactly the direction that flatters the result. The laggard's actual posted price averages -112.4 and 46.9% of laggard quotes are worse than -110, against only 11.8% better; mean decimal payout at the laggard is 0.8841 versus 0.9091 at -110, which is 2.5 points of expected value handed back before a single bet is graded. Re-grading at the price the script had already fetched, and additionally counting the 211 pushes that an "if v == 0: continue" line had silently dropped: minimum-books 2 window 30 goes from +2.06% (t +1.39) to -0.54% (t -0.38); window 60 from +2.96% (t +2.07) to +0.27% (t +0.19); window 120 from +3.67% (t +2.63) to +0.33% (t +0.25). A 2,000-replication bootstrap gives a 95% confidence interval of [-2.34%, +3.00%] with one-sided p = 0.403. Best of all six cells at real prices is t = +1.02.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 0, mult: 1, sound: 4 },
},
{
  id: 'T23E', src: 'EDGE-TEST-REGISTRY Test 23 (kill 2: placebo)', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'KILL 2 -- a direction placebo reproduces the result, and the CLV to three decimals',
  state: `CLAIM BEING KILLED: the direction the steam moved carries information about which side to bet.
KILL METHOD: 200 shuffles randomising the steam DIRECTION, holding the same games, the same times and the same selection rule. At minimum-books 2 window 120 the null returns +2.78% expected value (standard deviation 1.02) with closing-line value +0.752, against the real +3.21% and +0.75 -- the real result sits at the 65th percentile of its own null (z = +0.42). At minimum-books 3 window 60 the null returns +5.16% (sd 2.09) with closing-line value +0.966 against the real +4.20% and +0.94, so a RANDOM direction does better than the real signal (z = -0.46). The reported closing-line value is reproduced to three decimals: null +0.729 against real +0.730, z = +0.10.
THE KILL ALSO EXPLAINS THE MECHANISM RATHER THAN JUST FAILING TO REJECT: the author points out that the null itself implies naming a random direction yields +0.97 closing-line value and +5% expected value, which would be an arbitrage against simultaneously-available prices, and is only possible because the quotes are NOT simultaneous. The rule is therefore a cross-book-dispersion harvester, and dispersion in this tape is largely scrape staleness. A confirming check: priced at the movers' number instead of the laggard's, the same side and time bets win 51.06% and 51.41%, below break-even.
The author records a correction to a prior draft which had said "the closing-line value is real and correctly signed"; the placebo overrules it, and the author notes the script's own docstring already admitted "positive closing-line value by construction", so a t of +36.94 measures the selection rule, not an edge.`,
  mine: { placebo: 1, price: 1, clustered: 0, baseline: 1, mult: 0, sound: 4 },
},
{
  id: 'T23F', src: 'EDGE-TEST-REGISTRY Test 23 (kill 3: execution)', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'KILL 3 -- the laggard charges for the stale number, and the bets are not independent',
  state: `CLAIM BEING KILLED: the laggard's number is obtainable at a normal price, and the 18,667 bets are 18,667 opportunities.
KILL METHOD: the laggard's price is worse than the movers' price on the same side 71.1% of the time, median 5 cents worse, and the juice scales with the apparent free points -- mean price -102.3 at zero closing-line value rising to -119.6 at +6 points of closing-line value. The book charges precisely for the stale number. On bet multiplicity, the headline setting is not 3.5 bets per game but 11.25 (median 7, maximum 443 bets on a single game), and at minimum-books 3, 57.7% of games have every bet on the same side -- so those were never independent opportunities. Collapsing to one bet per game gives +0.34%. On executability, the median time to the laggard's next line change is 33 minutes at minimum-books 3 with 23% gone within five minutes, not the 675 minutes the companion stale-book test described, and the highest-closing-line-value bets are the fastest to vanish and return +0.00% and -0.59% at real prices.`,
  mine: { placebo: 0, price: 1, clustered: 1, baseline: 0, mult: 0, sound: 4 },
},
{
  id: 'T23G', src: 'EDGE-TEST-REGISTRY Test 23 (kill 4: data artifact + final stack)', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'KILL 4 -- stacked corrections with a game-clustered bootstrap end at -2.35%',
  state: `CLAIM BEING KILLED: steam is +3.67% expected value.
KILL METHOD: an independent data-artifact attack checked four things and the claim SURVIVED three of them -- corrupt-line filtering, the minute-resolution ordering concern, the outcome join and the sign convention were all clean. It then stacked corrections with a game-clustered bootstrap of 4,000 replications: as published, 18,667 bets across 1,659 games, +3.67%, 95% interval [+0.93, +6.37], probability EV <= 0 of 0.005; adding the laggard's actual price plus a 2021-onward restriction plus dispersion <= 3 points plus gap <= 1.5 points leaves 8,329 bets across 972 games at +1.41%, interval [-2.10, +4.90], probability EV <= 0 of 0.213; adding a 30-minute executability requirement leaves 5,926 bets across 943 games at +0.80%, interval [-3.14, +4.82].
A separate final stack, dropping 16 phantom season-mislabeled games and the corrupt 2019/2020 seasons and >1.5-point cross-book gaps and collapsing to one bet per game: as published +3.66% (t +2.62), at real prices +1.94% (t +1.41), after dropping phantom and corrupt seasons +0.88% (t +0.57) on 15,078 bets across 1,229 games, after dropping wide cross-book gaps +0.45% (t +0.28) on 12,914 bets across 1,218 games, and at one bet per game -2.35% (t -0.87) on 1,218 games.
THE KILL RECONCILES TWO PRIOR RESULTS RATHER THAN JUST NEGATING ONE: the fully corrected +0.80% matches the earlier stale-book test's +0.71%, closing an open contradiction between the two, and the roughly 3-point gap decomposes almost exactly into the price correction (-1.7 to -2.1 points) plus the bet-multiplicity correction (-1.6 points). A season check shows the effect leaned on the corrupt data: at real prices the two best seasons in the sample are 2019 (+4.37%) and 2020 (+5.39%), precisely the two with 7.97 and 1.32 points of cross-book disagreement, and restricted to 2021-onward the result is -1.59%.`,
  mine: { placebo: 0, price: 1, clustered: 1, baseline: 0, mult: 1, sound: 4 },
},
// ---------------------------------------------------------------- self-audit, 24, 25
{
  id: 'SA1', src: 'EDGE-TEST-REGISTRY self-audit', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Tests 5 and 6 measure LINE-ONLY CLV and overstate the realisable edge',
  state: `CLAIM BEING QUALIFIED: the +0.94pp (Test 5) and +0.29pp (Test 6) of closing-line value are realisable edges.
AUDIT METHOD: both grade_shadow_tape.py and beat_close_backtest.py derive closing-line value from the empirical margin or total distribution applied to the LINE, with no price term; beat_close_backtest.py does not read a price column at all. The auditor connects this to a separately established fact -- that a book which has not moved its line defends the number with juice, the laggard's price averaging -112.4 and worsening monotonically with the apparent free points from -102.3 at zero to -119.6 at +6 points -- and concludes that any line-only closing-line value overstates the realisable edge precisely where these signals fire, which is at books off consensus. The auditor also searched the night's other scripts for a second instance of the "fetch a price, never use it" bug and found none.
Direct check on Test 5: all 56 week-1 decisions matched to a Covers closing price gives mean price paid -104.8 against mean closing price -106.0, and paid-versus-no-vig-close of -2.62pp over 16 games at t = -8.57. The auditor explicitly declines to call this a refutation, noting the two quantities are not commensurable because the price paid carries vig while the closing probability has vig removed, so the -2.62pp is dominated by the roughly 2.4pp of half-vig paid rather than by the signal; and that shadow_decisions stores only our own side's price so a genuine two-way de-vig at bet time cannot be computed. Conclusion drawn: neither verdict changes, but the numbers must not be quoted as net of price.
No placebo. No multiplicity correction. Clustering by game is inherited from the tests being audited.`,
  mine: { placebo: 0, price: 1, clustered: 1, baseline: 0, mult: 0, sound: 4 },
},
{
  id: 'T24', src: 'EDGE-TEST-REGISTRY Test 24', kind: 'market_test', recorded: 'inconclusive',
  title: 'Kalshi favourite-longshot bias: textbook shape on 15 games',
  state: `CLAIM: Kalshi's no-vig mid prices show textbook favourite-longshot bias. Bucketed against realised outcomes: 0.10-0.20 priced 0.153 realised 0.133 (error -0.020, t -0.22); 0.20-0.30 priced 0.257 realised 0.200 (-0.057, t -0.53); 0.30-0.40 priced 0.358 realised 0.267 (-0.091, t -0.78); 0.40-0.50 priced 0.443 realised 0.357 (-0.086, t -0.65); 0.60-0.70 priced 0.643 realised 0.867 (+0.224, t +2.44); 0.70-0.80 priced 0.745 realised 0.867 (+0.121, t +1.32). Longshots win less often than their price implies, favourites more. This would be exploitable without forecasting anything, by selling longshots, and Kalshi's 0.07*p*(1-p) fee is near zero exactly at the extremes where the bias lives.
METHOD: scripts/model-lab/kalshi_calibration.py on 88,631 minute-quotes on KXNFLGAME markets that resolved to a completed 2026 game.
THE AUTHOR REFUSES THE SAMPLE: it rests on 15 games. Minutes inside a game are near-perfectly dependent -- a 30-3 blowout contributes hundreds of minutes all pointing the same way -- so the effective sample is the GAME count, not the 88,631 quotes, and every t clustered by game is below 1 except two. The 0.90-0.98 cell's t of +19.94 is called out as degenerate because all 14 games won so variance collapses. The plus-or-minus 65% buy/sell expected-value swings are a handful of games moving everything. Verdict: do not act on this; do re-run it once 2026 has 60 or more completed games with Kalshi coverage.
No placebo. No multiplicity correction across the buckets.`,
  mine: { placebo: 0, price: 1, clustered: 1, baseline: 0, mult: 0, sound: 3 },
},
{
  id: 'T25A', src: 'EDGE-TEST-REGISTRY Tests 25+', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'A registered family of 5,940 correlation tests: zero survivors',
  state: `CLAIM BEING KILLED: some lagged advanced team-week feature predicts cover, total, or model error.
KILL METHOD: scripts/model-lab/mass_test_harness.py enumerated the entire family MECHANICALLY IN ADVANCE so nothing could be dropped for being inconvenient -- 165 lagged features (advanced team-week differentials, offensive, defensive and matchup) times 4 targets (against-the-spread cover, total over, margin error, total error) times 9 splits, on 1,646 games 2016-2025, and every one of the 5,940 tests was recorded. 393 are nominally p < 0.05 against 297 expected under a pure null. The Bonferroni threshold of 8.42e-06 yields zero survivors; Benjamini-Hochberg at q = 0.10 also yields zero survivors. The strongest single result, matchup red-zone EPA against margin error in the favourite-by-more-than-7 split, is r = -0.196 at p = 7.0e-05, still 8 times short of the Bonferroni bar.
Features are lagged so nothing uses same-week information. No placebo shuffle is reported -- the family-wide null expectation of 297 nominal hits plays the role of one. No price term; this is a correlation family, not a betting backtest. Game clustering: units are games.`,
  mine: { placebo: 0, price: 0, clustered: 1, baseline: 1, mult: 1, sound: 4 },
},
{
  id: 'T25B', src: 'EDGE-TEST-REGISTRY Tests 25+', kind: 'market_test', recorded: 'accepted',
  title: 'Family-level sign test: recent-form features are systematically over-priced',
  state: `CLAIM: the individual tests are all null but the FAMILY carries a signal a sign test can see. On the 'all' split only, feature-to-target correlations are overwhelmingly negative: margin error 123 of 165 negative (74.5%, binomial p = 4.7e-10, mean r -0.0170); against-the-spread cover 113 of 165 (68.5%, p = 3.0e-06, mean r -0.0144); total over 69 of 165 (41.8%, p = 0.043); total error 91 of 165 (55.2%, p = 0.21). Interpretation: teams that look stronger on recent advanced metrics systematically underperform the closing spread -- the market prices recent form and overshoots slightly. Overwhelming on spreads, absent on totals.
METHOD: only the 'all' split is used, because the author establishes the nine splits are nine dependent views of the same games; the 84 features are argued to be substantially independent with a measured effective rank of 39.7 by entropy and 24.5 by participation ratio and a mean absolute inter-feature correlation of 0.104, which is what licenses the binomial test. A sign test is used precisely because it is more powerful than any single correlation.
The author also records a correction to a prior project belief: the earlier "effective rank about 2.5" figure applies to the ensemble's 35 forecast signals, which are collinear by construction, NOT to raw descriptive features, which measure about 40 independent directions out of 84 -- and says the two claims were being conflated.
No placebo. No price term. No out-of-sample split for the sign test itself.`,
  mine: { placebo: 0, price: 0, clustered: 1, baseline: 1, mult: 1, sound: 3 },
},
{
  id: 'T25C', src: 'EDGE-TEST-REGISTRY Tests 25+', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'KILL of the sign-test signal: magnitude, asymmetry, and a non-monotone ordering',
  state: `CLAIM BEING KILLED: the family-level negative sign on recent-form features is bettable.
KILL METHOD: three checks, run after the signal was established. (1) Magnitude: mean r = -0.017, so a one-standard-deviation feature move shifts cover probability by under 1 percentage point against the 2.38pp needed at -110. (2) Asymmetry: a walk-forward composite with signs and scaling fitted on prior seasons only, 1,150 games 2019-2025, gives top-quintile-to-HOME 54.78% but bottom-quintile-to-AWAY only 49.57%, and a real signal should work in both tails; the home base rate in this sample is 49.83% so the excess is +4.95pp at a standard error of 3.30pp, about 1.5 standard errors. (3) Monotonicity, which the author calls decisive: cover rate across composite quintiles runs 50.43 / 42.17 / 52.61 / 49.13 / 54.78 -- not monotone, with quintile 2 the worst bucket by eight points. If the composite ordered games by expected cover that is impossible, so the top-quintile spike is noise.
The composite is walk-forward fitted, so the quintile test is genuinely out of sample. No placebo shuffle. No price term. No multiplicity correction on the three checks (they are confirmatory rather than exploratory).`,
  mine: { placebo: 0, price: 0, clustered: 1, baseline: 1, mult: 0, sound: 4 },
},
// ---------------------------------------------------------------- session 2: polymarket
{
  id: 'PM1', src: 'Session 2026-09-17 A', kind: 'market_test', recorded: 'withdrawn',
  title: 'Polymarket monotonicity violations: 23.3% of adjacent pairs -- WITHDRAWN',
  state: `CLAIM AS FIRST MADE: Polymarket's NFL total-points option chain contradicts itself. P(over L) must fall as L rises, and a violation is a riskless box; 23.3% of adjacent strike pairs violate monotonicity, median 11 cents, maximum 43 cents.
WITHDRAWAL METHOD: a volume gate was applied and the finding vanished -- 0 of 29 adjacent pairs violate monotonicity once only markets with more than $5,000 of traded volume are considered. The cause is established directly: 85% of NFL total markets on Polymarket have traded EXACTLY ZERO DOLLARS, median volume $0, p90 $28, and the median game has no strike above $5,000. The "boxes" were resting market-maker quotes parked at 0.500 sitting beside real quotes. Gated on volume the chain is perfectly monotone. The author summarises the venue as roughly 169 liquid markets wrapped in about 5,000 untraded quotes that look like depth, and adds a standing project rule: check volume BEFORE coherence, because an untraded resting quote is not a price.
Script: scripts/model-lab/polymarket_ladder_coherence.py. No placebo (a coherence violation is arithmetic). The withdrawal rests on a liquidity filter that is independently verifiable from volume columns.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 0, mult: 0, sound: 4 },
},
{
  id: 'PM2', src: 'Session 2026-09-17 A', kind: 'market_test', recorded: 'withdrawn',
  title: 'Polymarket 1H+2H vs GAME additivity gap: -2.73 pts, t=-4.55 -- WITHDRAWN',
  state: `CLAIM AS FIRST MADE: expected first-half points plus expected second-half points should equal expected game points by linearity of expectation, requiring no independence assumption, and Polymarket's chain violates this by -2.73 points at t = -4.55.
WITHDRAWAL METHOD: the author records the additivity test as UNTESTABLE after the volume gate, because the quarter and half ladders are precisely the illiquid ones. The mechanism is given with a sign: untraded quotes drift toward 0.50, which drags the survival integral toward the ladder centre, so "the parts" were biased low by construction. The finding is withdrawn rather than re-measured -- after gating there is no sample left to measure on.
No placebo. The withdrawal is a liquidity argument plus a stated directional mechanism, not a re-measurement.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 0, mult: 0, sound: 3 },
},
// ---------------------------------------------------------------- session 2: structural hunts
{
  id: 'SB1', src: 'Session 2026-09-17 B', kind: 'market_test', recorded: 'blocked',
  title: 'Wong teasers BLOCKED on a price that was never recorded',
  state: `CLAIM: Wong teasers are +4.16% expected value at -110 (t = 1.82), with a measured break-even price of -120.2, 95% confidence interval [-132.6, -109.4].
BLOCKING METHOD: the entire claim hinges on obtainable teaser price, which the project holds no data for. As the closest available proxy the author computes Pinnacle's own implied price for the teased leg, which is 72.30%, against a 72.37% break-even -- so on the one real price anywhere in reach the strategy is a fraction of a percentage point underwater. Verdict recorded as blocked on a price never recorded, rather than dead.
A separate infrastructure defect is recorded alongside it: teaser_fair_value.py hardcoded a narrow Wong window and silently dropped -7 and +3, and +3 alone is 39% of historical Wong legs; it now uses the module's own CROSS_BOTH_LINES definition.
Break-even is reported with a confidence interval. No placebo. Clustering by game not stated (legs are not independent within a ticket). No multiplicity correction across this and the four earlier teaser cuts.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 0, mult: 0, sound: 3 },
},
{
  id: 'SB2', src: 'Session 2026-09-17 B', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Cross-book middles: +0.562% ROI at t=0.41, and the sample can never be big enough',
  state: `CLAIM BEING KILLED: cross-book middles are profitable.
KILL METHOD: +0.562% return on investment at t = 0.41 -- a failure to reject, not a demonstrated loss. The author adds a power calculation that makes the failure structural rather than incidental: detecting an effect of that size needs 9,820 bets and seven seasons supply only 2,883. A companion arithmetic check on true arbitrage finds 22 genuine locks in 2,224,042 candidate pairs, 0.00099%.
No placebo. Clustering not stated. No bet-everything baseline in this entry. The power calculation is the load-bearing part of the kill.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 0, mult: 0, sound: 3 },
},
{
  id: 'SB3', src: 'Session 2026-09-17 B', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Exchange vs book routing costs -1.362pp MORE than best-of-11 books',
  state: `CLAIM BEING KILLED: routing bets to a prediction-market exchange (Kalshi) is cheaper than the best sportsbook price.
KILL METHOD: routing to Kalshi costs -1.362 percentage points more than best-of-11 books, with a standard error of 0.161 -- so the kill is a measured, tightly-estimated loss rather than a null. Mechanism given at a specific price point: at p = 0.5, Kalshi takes 2.41 cents against the books' 2.08 cents. Fees kill 619 of 623 raw cross-venue locks. Real two-sided prices with the actual Kalshi fee schedule applied on both legs.
No placebo (this is a cost comparison, not a signal test). Clustering not stated. No multiplicity correction.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 1, mult: 0, sound: 4 },
},
{
  id: 'SB4', src: 'Session 2026-09-17 B', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Pinnacle alternate-total ladder is mispriced by 1.76pp/rung -- but the correction is smaller than the toll',
  state: `CLAIM BEING KILLED: Pinnacle's alternate TOTAL ladder is internally mispriced and can be traded against itself.
KILL METHOD: the mispricing is affirmed as genuine at 1.76 percentage points per rung, and then killed on cost: the ladder's overround is 4.34%, so you need 2.17 percentage points to break even and the correction is 1.76. The correction is smaller than the toll. A placebo was run and returns p = 0.114.
This is one of only two entries in the whole registry where a placebo is reported as part of the kill. Real posted ladder prices with the venue's own overround measured rather than assumed. Clustering not stated. No multiplicity correction across the six hunts in this session.`,
  mine: { placebo: 1, price: 1, clustered: 0, baseline: 1, mult: 0, sound: 4 },
},
{
  id: 'SB5', src: 'Session 2026-09-17 B', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Graveyard revival: +0.64%/bet at t=2.84, against a 5.66% cost to extract',
  state: `CLAIM: pooling every signal ever killed in this project and re-testing the pooled construct yields +0.64% per bet at t = 2.84 -- which the author calls the headline number of the whole project, real and statistically significant.
KILL METHOD: it is killed on cost, not on significance. Extracting the signal costs 5.66% per bet, so the edge is roughly 9 times too small to pay the toll. The author records the effect as real rather than spurious.
No placebo reported for the pooled construct. The pooled construct is assembled from hypotheses that were each already tested on this same data, so the t = 2.84 is a re-use of samples already searched and carries no multiplicity correction for the searching that produced its components. Clustering not stated. The cost figure (5.66%) is price-aware and is the load-bearing quantity.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 0, mult: 0, sound: 2 },
},
{
  id: 'SB6', src: 'Session 2026-09-17 B', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Promo/boost conversion: +18.4% was graded at a price the token can never reach',
  state: `CLAIM BEING KILLED: odds boosts and free-bet promotions convert at +18.4% expected value, and the longer the boosted price the better.
KILL METHOD: three refuters, all three landing on grading rather than on statistics. (1) A free bet is a credit in ONE book so its leg cannot be shopped and only the hedge can; the original hedging cost h = 3.05% was the both-sides-shopped overround, unobtainable by any free-bet ticket. Executable h is 4.11-5.33%, which moves optimal conversion c* = (1 - sqrt(h))^2 from 68.1% to 60.9%, and best-of-slate conversion from a claimed 65.2% to a measured 60.0% median. (2) Boosts are BOOK-LOCKED: the +18.4% was graded at a best-of-4-books price the token can never reach. Re-graded at the issuing book it is +12.7% with a standard error of 8.0, t = 1.59, which fails Bonferroni over its own 32-cell family. (3) The recommendation was inverted: realised book-locked conversion kappa = 1.33 gives favourite +4.8%, +100 to +200 +17.5%, +200 to +400 +12.7% -- boost expected value is NON-MONOTONE, peaking around +180 to +260, not on the longest price.
The author also corrects an asserted premise: a -110 to +100 boost on a true 50% event is exactly 0.00% expected value, not a large gain -- it refunds the vig, and a boost is only positive once the boosted price beats fair. And records that supply, not expected value, is the binding limit: n* = 347 tokens to be two standard deviations from zero, against a realistic supply of 60-100 a year, giving an 80-86% probability of profit that can never be statistically clean within a season.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 1, mult: 1, sound: 4 },
},
{
  id: 'SC1', src: 'Session 2026-09-17 C', kind: 'kill_of_a_market_test', recorded: 'inconclusive',
  title: 'Press conferences do not mark abnormal line movement (underpowered)',
  state: `CLAIM BEING TESTED: coach press conferences mark abnormal line movement, which would make classifying their text worth paying for.
METHOD, RUN BEFORE ANY TEXT CLASSIFICATION WAS PAID FOR: every timestamped presser is an event at time T, and each has a matched PLACEBO at the same game, the same weekday and the same hour, one week earlier. After-window absolute line movement is 1.438 points at pressers against 1.259 at placebos, a difference of +0.179 at t = +1.10, not significant. The before/after ratio is 1.13, which the author reads as symmetric with no event signature.
VERDICT: recorded explicitly as underpowered rather than as a kill. Only 482 of 10,670 presser rows carry a usable timestamp; at the same effect size the full corpus would reach t of about 4.9. A hard ceiling is documented: YouTube stops exposing exact timestamps past about six weeks (2026-09: 156 fixed, 0 failed; 2026-08: 326 fixed, 21 failed; 2026-07: 0 fixed, 59 failed), and unblocking it needs a YouTube Data API v3 key.
A matched placebo is the core of the design. No price term (the outcome is line movement in points, not a bet). Clustering by game not stated. No multiplicity correction.`,
  mine: { placebo: 1, price: 0, clustered: 0, baseline: 1, mult: 0, sound: 3 },
},
{
  id: 'SE1', src: 'Session 2026-09-17 E', kind: 'literature_or_design', recorded: 'accepted',
  title: 'Jev transaction labels verified by hand on two examples',
  state: `CLAIM: the Jev classifier's labels on ESPN roster transactions are correct in scale and gradient. Evidence given: "Placed G Landon Dickerson on IR" scores availability impact 0.41 and starter-involved 0.80; "Released WR from the practice squad" scores impact 1.13 and starter 0.18.
METHOD: hand inspection of two examples, chosen by the author. No agreement rate against structured data is computed, no sample is drawn at random, and no independent label source (roster status, snap counts, depth chart) is joined to check. A separate smoke test on one press-conference transcript is cited as discriminating correctly: qb_hedged 0.96, qb_plays 0.17, lt_plays 0.93.
No placebo. No price term. No clustering. No multiplicity correction. This is a two-example spot check presented as label verification.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 1 },
},
// ---------------------------------------------------------------- carried-forward priors
{
  id: 'P1', src: 'Prior results carried forward', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Weekly ridge stacker over ~35 signals: no edge',
  state: `CLAIM BEING KILLED: a weekly ridge-regression stacker over about 35 model signals beats the market.
KILL METHOD: recorded as "no edge" with two diagnostics: the signal matrix has an effective rank of about 2.5, and the ridge gives the market line itself 35-52% of the weight. No sample size, no date range, no test statistic, no confidence interval and no out-of-sample split are recorded in the registry entry. The measurement predates a database deletion and the entry states these results are "not being re-litigated".
No placebo. No price term recorded. No clustering recorded. No multiplicity correction recorded.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 1 },
},
{
  id: 'P2', src: 'Prior results carried forward', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Confidence tiers / conviction sizing: failed five ways',
  state: `CLAIM BEING KILLED: sizing bets by model confidence improves returns.
KILL METHOD: five independent failures are recorded. The correlation between edge size and correctness is r = -0.01. Component agreement sign-flipped. A meta-model trained to predict correctness scores AUC 0.489 on a held-out 2024 season, which is below chance. The held-out season makes the AUC number genuinely out of sample. No sample size is recorded for the r = -0.01 or for the agreement check, and no confidence intervals are given for any of the five.
No placebo. No price term. Clustering not recorded. No multiplicity correction across the five checks.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 1, mult: 0, sound: 3 },
},
{
  id: 'P3', src: 'Prior results carried forward', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Top-10% conviction tier at 60% was caused by 127 fake placeholder openers',
  state: `CLAIM BEING KILLED: the top-decile conviction tier wins 60% of its bets.
KILL METHOD: the 60% was traced to 127 fake Pinnacle placeholder openers in the data. Repairing them drops the tier to 52.9%, essentially break-even at -110. The repaired rule was then applied as a preset and lost in BOTH 2024 and 2025, which is an out-of-sample confirmation of the kill rather than a re-fit. The diagnosis names a specific data defect and a specific row count, so it is checkable.
No placebo. No price term recorded beyond the implicit -110 break-even. Clustering not recorded. No multiplicity correction.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 1, mult: 0, sound: 3 },
},
{
  id: 'P4', src: 'Prior results carried forward', kind: 'market_test', recorded: 'killed',
  title: 'Line shopping worth ~+4 points of EV per bet and gets to roughly break-even',
  state: `CLAIM AS RECORDED IN THE PRIOR AUDIT: line shopping is real and worth about +4 points of expected value per bet, which gets a bettor to roughly break-even, and models add at most 1 point on top (which went negative in 2025). This was the project's founding assumption and the only measured positive in the prior audit.
METHOD AS RECORDED: no sample size, no book count, no date range, no price source and no test statistic accompany the +4-point figure in the registry entry. It is carried forward as settled.
It was subsequently overturned within the same registry by a direct measurement (561,746 opportunities, 260 games, 11 books, real prices) which found the gain is +2.5 to +2.6 points, roughly 60% smaller, and that perfect shopping still returns -1.82% per bet rather than break-even -- so the "gets you to break-even, models supply the edge" premise is wrong at the first step. A second sample (2019-2025, 4 books) found best-book expected value negative in every season at -4.61%.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 0 },
},
{
  id: 'P5', src: 'Prior results carried forward', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Opener move direction is predictable but not profitable',
  state: `CLAIM: the direction the line moves from the opener is predictable, but the prediction does not survive costs.
METHOD AS RECORDED: one line in a carried-forward table. No sample size, no date range, no win rate, no expected value, no test statistic and no description of what "costs" were applied. The cost claim is the entire kill and it is unquantified in the entry.
No placebo. No stated price source. No clustering. No multiplicity correction.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 0 },
},
{
  id: 'P6', src: 'Prior results carried forward', kind: 'market_test', recorded: 'open',
  title: 'Kalshi leads books by 2-3 hours on 36 games -- preregistered test waits for 150',
  state: `CLAIM: Kalshi's price leads sportsbook lines by 2-3 hours, observed on 36 games.
METHOD: recorded as OPEN, with a preregistered test that will not be graded until 150 games are available. Declaring the sample size and the rule in advance and refusing to read the result at 36 games is a preregistration discipline. No effect size, no test statistic and no confidence interval are recorded for the 36-game observation. No placebo. No price term. Clustering by game is implicit in the game count.
NOTE: a later, fully-run test on 14 games and 227,810 minute-bars found NO lead at any lag, with only 306 nonzero Kalshi bars and 67 nonzero book bars in the whole sample -- which directly contradicts the 2-3 hour lead recorded here, and the registry does not reconcile the two.`,
  mine: { placebo: 0, price: 0, clustered: 1, baseline: 0, mult: 0, sound: 2 },
},
{
  id: 'P7', src: 'Prior results carried forward', kind: 'kill_of_a_market_test', recorded: 'killed',
  title: 'Props model week 1 2026: 1,149 bets, 50.0%, zero CLV -- and no longer reproducible',
  state: `CLAIM BEING KILLED: the player-props model has an edge.
KILL METHOD: 1,149 bets at a 50.0% hit rate with zero closing-line value and badly broken calibration -- the 70% confidence bucket hit 48% and the 99% bucket hit 63%. Calibration by bucket is a genuine diagnostic beyond the headline rate.
REPRODUCIBILITY DEFECT RECORDED BY THE AUTHOR: this result can no longer be reproduced. The deleted database held the model's side selection (model_probability) and the Underdog closing lines (closing_line), and both columns are empty in the surviving copy; 442 of the 443 surviving props carry BOTH the Over and the Under, so re-settling them returns about 50% mechanically regardless of skill. The conclusion stands as recorded but is no longer checkable against data.
No placebo. No clustering by game (props within a game are highly correlated). No multiplicity correction. One week of data.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 1 },
},
{
  id: 'FT1', src: 'Forward tape restarted 2026-09-17', kind: 'market_test', recorded: 'open',
  title: 'Week-2 shadow cohort: 38 decisions whose recorded opener equals the current line',
  state: `CLAIM: the shadow-decision writer is recording again -- 176 signals written and 38 decisions frozen for 2026 week 2 -- so the forward tape resumes.
CAVEAT RECORDED BY THE AUTHOR, EXPLICITLY AND IN ADVANCE OF GRADING: these 38 decisions are NOT comparable to week 1's 56. Their recorded opener_at is 2026-09-17T03:18:24, which is the first Pinnacle capture, not week 2's true opener which posted around 09-14. Every one has opener equal to line, so the signal reduces to "rating versus the current line", not "rating versus the opener" -- a legitimate test of a DIFFERENT strategy from the preregistered one, and the recorded "+0.58 closing-line value, 57.7%, n 570" basis does not apply to it. The author instructs that this cohort be graded separately. Week 1's decisions did not have this problem: opener_at and captured_at were 23 seconds apart.
The author also records that week 1 can never be settled by its own rule, because the settlement function grades against Pinnacle's last pre-kickoff line and Pinnacle's week-1 closes were never captured; the +0.94pp in Test 5 comes from an independent grader against nflverse closes, which is a substitute for the preregistered metric, not the metric itself.
Nothing graded yet. No placebo, price term, clustering or multiplicity correction applies yet.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 3 },
},
// ---------------------------------------------------------------- F-series
{
  id: 'F01a', src: 'F01-drive-sim-mechanics', kind: 'code_defect', recorded: 'accepted',
  title: 'Drive simulator hands turnover field position to the wrong team',
  state: `CLAIM: in server/services/nfl-drive-sim.js, a turnover returns endYard offense-relative at lines 345-346, and lines 536 and 825 then hand that SAME number to the new possessing team with no mirror. Field position 0-100 is one physical line, so a turnover at offense-yard 70 should give the new offense the spot 100-70 = 30 from their perspective; the simulator gives them 70, i.e. a spot 40 yards better than reality on every turnover, systematically biasing the simulator toward the outcome that generated the turnover.
METHOD: read-only code reading of the full 1,280-line file plus nfl-sim-policy.js and nfl-live.js, with exact line numbers cited. No execution, no database access, no simulation run to measure the size of the resulting bias in points or win probability. The claim is a code-logic argument, verifiable by reading the cited lines.
No placebo, no price, no clustering, no baseline control, no multiplicity correction -- none of which apply to a code-logic claim.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 3 },
},
{
  id: 'F01b', src: 'F01-drive-sim-mechanics', kind: 'code_defect', recorded: 'accepted',
  title: 'Half-scoped clock divided by a full-game denominator',
  state: `CLAIM: nfl-drive-sim.js sets HALF = 1800 and scopes secondsLeft to one half, but nfl-sim-policy.js at lines 214 and 415 computes urgency = clamp(1 - secondsLeft/3600, 0, 1), dividing a half-scoped clock by a full-game denominator. At the opening kickoff of a half (secondsLeft = 1800) urgency is already 0.5 instead of 0, so two-point, pass-rate and variance policies are primed for "already halfway through the game" from the opening whistle of every half.
METHOD: read-only code reading with exact constants and line numbers cited. The arithmetic is checkable from the quoted expression alone. No simulation was run to quantify how much the mis-scaled urgency moves simulated scores or win probabilities.
No placebo, price, clustering, baseline or multiplicity correction -- none apply to a code-logic claim.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 3 },
},
{
  id: 'F01c', src: 'F01-drive-sim-mechanics', kind: 'code_defect', recorded: 'accepted',
  title: 'Kneel and timeout accounting wrong three ways and compounding',
  state: `CLAIM: three compounding defects. kneelDecision uses kneelable = 40 + timeouts*40 where timeouts is the OPPONENT'S remaining timeouts, so more opponent timeouts raises the safe-to-kneel threshold -- backwards, since a timeout stops the clock and the relationship should be inverse. The kneel branch then returns seconds = secondsLeft, so one decision consumes the entire remaining half clock in one call rather than one roughly 40-second snap that a defence could stop. And timeouts are never spent: nfl-drive-sim.js:475 computes a timeout policy decision and discards the result, so nothing ever decrements them.
METHOD: read-only code reading with call sites and line numbers cited. No execution and no measurement of the downstream effect on simulated margins.
No placebo, price, clustering, baseline or multiplicity correction -- none apply.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 3 },
},
{
  id: 'F04a', src: 'F04-clv-unification', kind: 'code_defect', recorded: 'accepted',
  title: 'Four to five independent CLV implementations with genuinely different math',
  state: `CLAIM: the project computes closing-line value four or five different ways and they do not agree. nfl-clv.js grades in signed points with an explicit totals-side inversion and a fair probability via noVigProbability. nfl-execution-clv.js assumes lines are ALREADY expressed from the backed side's perspective and therefore does NOT apply the totals inversion -- a different sign convention for the same physical quantity. nfl-prop-clv.js is a fourth, props-specific implementation. forward-ledger.js and shadow-ledger.js each carry their own inline points-space-only computation. They differ on (a) which table the bet lives in, (b) whether closing-line value is priced in points or probability, and (c) sign convention. Only one of the five versions its own grading logic with a CLV_GRADING_VERSION string.
METHOD: read-only file reading with line numbers cited for each implementation, plus grep counts. Nothing was executed and no two implementations were run on the same bet to measure how far apart their answers actually come out.
No placebo, price, clustering, baseline or multiplicity correction -- none apply to a code-inventory claim. The claim's consequence, that published closing-line-value numbers in this project are not comparable across modules, is asserted rather than demonstrated numerically.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 3 },
},
{
  id: 'F06a', src: 'F06-trial-registry-multiplicity', kind: 'code_defect', recorded: 'accepted',
  title: 'The preregistration system exists, is well designed, and has zero callers',
  state: `CLAIM: server/services/audit-registry.js is a genuinely well-designed preregistration system -- preregister() locks a hypothesis, metric and threshold plus a code hash and a data signature before the number exists, runAudit() seals the result once and voids if code or data moved, and it computes a Sidak-style sequential multiple-comparisons correction alpha = 1-(1-0.05)^(1/(priorTests+1)) plus an always-valid mSPRT p-value. IT IS ORPHANED: grep -rn "preregister(|runAudit(" across server and scripts finds zero callers outside the file itself and its own test. The audit_registry table exists and nothing populates it for any model search the project has actually run -- including the headline "0 of 21 models beat 15,096 closing lines", the "9 signal families degraded under ablation" and the "24 candidates times 4 stats, zero survivors" findings, all of which were produced OUTSIDE any preregistration.
The doc further confirms by grep that no Holm-Bonferroni, deflated Sharpe ratio, or CSCV/probability-of-backtest-overfitting implementation exists anywhere in the codebase, and that a fourth trial-adjacent structure (nfl-experiments.js) locks discovery, validation and holdout seasons as chronologically disjoint but has no multiplicity correction of any kind.
METHOD: read-only reading plus named grep commands whose exact invocations and zero-hit results are quoted, so every claim is independently re-runnable. Nothing executed against data.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 1, sound: 4 },
},
{
  id: 'F06b', src: 'F06-trial-registry-multiplicity (recorded prior finding)', kind: 'market_test', recorded: 'killed',
  title: '0 of 21 models beat 15,096 closing lines',
  state: `CLAIM: zero of 21 candidate models beat the closing line across 15,096 graded lines.
METHOD AS RECORDED: the result is cited from docs/evidence/historical/path-to-profit-measurements.md and three service files. The F06 audit establishes that this search was run OUTSIDE the project's own preregistration system -- the audit_registry table has no row for it -- so no hypothesis, metric or threshold was locked before the numbers existed, and no code hash or data signature was sealed. No multiplicity correction is recorded for having tried 21 models. No placebo. Clustering by game is not stated for 15,096 lines drawn from far fewer games. The direction of the result (a null) makes searcher bias a smaller concern than it would be for a positive.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 2 },
},
{
  id: 'F06c', src: 'F06-trial-registry-multiplicity (recorded prior finding)', kind: 'market_test', recorded: 'killed',
  title: '9 signal families degraded under ablation; 24 candidates x 4 stats, zero survivors',
  state: `CLAIM: nine signal families degraded under ablation, and a 24-candidate by 4-statistic sweep produced zero survivors.
METHOD AS RECORDED: cited from a work log. Sample sizes, date ranges, out-of-sample splits, test statistics and thresholds are not recorded in the audit that cites them. The F06 audit establishes the search was not preregistered -- nothing was locked before the numbers existed -- and that the codebase contains no Holm-Bonferroni, deflated Sharpe or probability-of-backtest-overfitting implementation anywhere, so the 96-cell sweep has no recorded multiplicity correction available to it. No placebo, no price term, no clustering recorded.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 1 },
},
{
  id: 'F07a', src: 'F07-sequential-inference-fix', kind: 'code_defect', recorded: 'accepted',
  title: 'A fixed-sample p-value is persisted into a column named as if it were anytime-valid',
  state: `CLAIM: alwaysValidPValue() correctly returns two distinct, differently-named fields -- p_always_valid with anytime_valid true only when the caller supplies a sigma/tau from a holdout, in which case Ville's inequality genuinely holds, and p_fixed_sample_only with anytime_valid false when sigma is estimated from the very sequence under test. runAudit() then destroys the distinction one call site later: it coalesces p_always_valid ?? p_fixed_sample_only into a single variable and persists it into one always_valid_p REAL column, with no variance_source, no anytime_valid flag and no declared sigma/tau stored. grep -rln "always_valid_tau|always_valid_sigma" returns only the file itself, so NO production caller has ever declared sigma in advance -- meaning every real audit that runs through this path gets a fixed-sample-only p-value stored in a column named as if it carried the anytime-valid guarantee, and auditHistory() reprints it with no way to recover which guarantee it actually has.
METHOD: read-only code reading with the offending lines quoted verbatim, the schema line cited, and the grep invocation and its result quoted so the "zero callers declare sigma" claim is independently re-runnable. Nothing executed.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 1, sound: 4 },
},
{
  id: 'F16a', src: 'F16-dfp-devig-favorite-longshot', kind: 'market_test', recorded: 'accepted',
  title: 'The dog/over pick bias is a margin-blend shrinkage artifact, not a devig or FLB effect',
  state: `CLAIM: Gridiron picked dogs on 152 of 153 spread picks and overs on 48 of 48 total picks, with mean closing-line value -2.28 and 78% adverse moves. The finding is that this is a mechanical attenuation bug in the point-margin blend (shrinkage toward an anchor, beta about 0.632 < 1), NOT a devig artifact and not favourite-longshot bias.
METHOD: the call graph is traced end to end in the live repo, read-only. nfl-ensemble.js computes marketMargin from raw points with the 0.68 + 0.632*market shrinkage living entirely in point-margin space and no devig function called anywhere in the file (grepped). nfl-auto-picks.js:104-107 fixes the pick's SIDE from margins alone, and only on the NEXT line does any devig call execute, and then only to compute a confidence number for a side already chosen. nfl-clv.js likewise devigs only to score a bet already taken. So devig cannot be the mechanism that makes 152 of 153 picks dogs -- that ratio is set before any devig call runs, and this is provable from the code alone.
A SECOND, INDEPENDENT SIGN ARGUMENT: the project's existing Shin devig implementation is confirmed by its own test to push the FAVOURITE's fair probability UP relative to naive proportional splitting on a skewed line, so if devig mattered here it would argue for MORE favourites, which is the opposite sign from the observed bias.
A THIRD ARGUMENT FROM MARKET STRUCTURE: every dataset in the favourite-longshot literature documents the effect in WIDE-odds markets (horse racing, soccer match odds, tennis moneylines), whereas NFL spreads are a narrow-odds roughly-symmetric handicap market mostly between -105 and -130, structurally closest to Asian Handicap -- where the published realised-versus-predicted-loss gap that drives the bias does not appear.
No placebo, no clustering, no multiplicity correction. The 152/153 and 48/48 counts are reported without a sample period or a bet-everything baseline. The conclusion is a code-plus-theory argument, not a re-measurement: the beta = 0.632 shrinkage is not shown by simulation to reproduce a 152-of-153 dog rate.`,
  mine: { placebo: 0, price: 1, clustered: 0, baseline: 0, mult: 0, sound: 3 },
},
{
  id: 'F18a', src: 'F18-audit-architecture-consolidation', kind: 'code_defect', recorded: 'accepted',
  title: '~37 files independently reinvent "what code and data produced this number"',
  state: `CLAIM: there is not one audit engine to fix but roughly 37 things independently reinventing content-addressing. Four named schemes are read in full -- nfl-blind-audit.js (1,005 lines, its own inline freeze plus an INPUT_TABLES list and mutation-journal triggers), audit-registry.js (333 lines, a separate codeHash over every .js in the services dir plus a dataSignature over six tables), nfl-engine-registry.js (196 lines, a third scheme producing a distinct schema version), and modeling/contracts.js (a fourth, configurationHash over canonical key-sorted JSON) -- and grepping createHash('sha256'), codeHash and dataSignature across server/services hits 37 separate files, none of which agree with each other. The doc also records two already-observed false-void bugs caused by hashing too coarsely: one run voided by a docs paragraph edited during a two-minute week-open, another voided by a docs-only commit moving HEAD.
METHOD: read-only file search and grep with file names, line counts and hit counts quoted; the two false-void incidents are cited from the modules' own doc comments with run numbers and dates. Nothing executed. The "37 files" figure is a grep hit count for a pattern, not an audit of whether all 37 are genuinely duplicative.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 3 },
},
{
  id: 'F18b', src: 'F18-audit-architecture-consolidation', kind: 'code_defect', recorded: 'accepted',
  title: 'Two CLV modules use opposite sign conventions for the same physical quantity',
  state: `CLAIM: nfl-clv.js's gradeClosingLineValue applies an explicit totals-side inversion (for a totals market with the Under side, the sign flips) while nfl-execution-clv.js's spreadClvPoints assumes lines are already expressed from the backed side's perspective by the contract key and therefore does NOT apply that inversion. These are two different sign conventions for the same physical quantity, reading different closing-book defaults and different contract-key joins. A fifth CLV-adjacent number exists in nfl-audit-overview.js reusing nfl-replay.js's uncertainty math.
METHOD: read-only reading of both functions with the conditional expression quoted from one and the assumption quoted from the other's own comment. Nothing was executed; the two functions were not run on the same totals bet to demonstrate that they actually produce opposite-signed answers. Given that a sign-convention error of exactly this kind has twice produced mirror-image results elsewhere in this project (a shadow-tape grader that returned +18.5 points of closing-line value, and a totals steam grader that returned -0.98 against a spread's +0.93), the claim is highly consequential and is supported by reading rather than by a differential test.`,
  mine: { placebo: 0, price: 0, clustered: 0, baseline: 0, mult: 0, sound: 3 },
},
];
