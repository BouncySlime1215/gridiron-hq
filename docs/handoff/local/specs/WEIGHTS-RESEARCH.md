# WEIGHTS-RESEARCH: how to weigh trade factors when the weights keep moving

Nick asked for this on 9/26:
- "each consideration holds weight of some sort; the weights will be different every time; how do we narrow choices with always moving pieces";
- "luck is a big one";
- "look into how to value players today vs value over time, past and future";
- "use simulations of random events, models, AI, ML to help weigh each one".

This is a RESEARCH job first: parallel web research plus a Fable design. Build nothing until the findings and a pre-registered plan exist. Relates to TRADE-EVAL-V2.md (the 15 factors) and to COACH-CHAIN (the expectimax lookahead).

## Questions to answer, each with sources and a recommendation

1. **Weights that change with the situation.** Do we need weights at all, or does the season simulation integrate the factors natively? The approach so far says every factor changes the simulated lineups, win probabilities and playoff odds, so the "weight" is emergent and situation-specific. Compare with:
   - contextual and learned weights (gradient-boosted value models, Bayesian hierarchical models);
   - the multi-criteria decision literature (MCDA, AHP);
   - how sharp DFS and season-long tools do it (for example the public writing of FantasyCalc, Establish The Run and 4for4).
2. **Luck.** How to separate luck from skill in the record and in player results:
   - Pythagorean expectation and all-play records for fantasy;
   - regression to the mean on TD rate and YPC;
   - schedule luck;
   - how many simulated seasons are needed.
   Should luck enter as (a) a variance term in the sim (already partly there), (b) a regression prior on unsustainable stats (the BUY-LOW and SELL-HIGH logic), or (c) both?
3. **Value now vs value over time.** The ROS points value, the market value (FantasyCalc, a dynasty-flavoured market), the trade-deadline and playoff-week value, and the past-performance signal against the forward projection.
   - How should the three combine for a redraft league with a deadline in week 12?
   - Find the literature on "time value" of fantasy assets, the decay of early-season signal, and when past production stops predicting.
4. **Narrowing choices when everything moves.** Search methods for sequential trade decisions under uncertainty:
   - expectimax and MCTS (what COACH-CHAIN does);
   - robust optimisation, where a move is good across many scenarios;
   - regret minimisation;
   - "value of information", i.e. when waiting a week beats acting.
   Recommend a pruning strategy that stays fast on an 8-core Mac.
5. **ML and AI roles, honestly.** Where ML adds signal given our data sizes:
   - 42 answered offers today;
   - about 31k player-weeks of history;
   - BUY-LOW, which passed held-out testing;
   - E-XGB, which lost to ESPN.
   Where Claude or Jev add judgement (people, context, news), and where they must not set numbers.

## Deliverable
`docs/handoff/local/specs/WEIGHTS-DESIGN.md`:
- findings with citations;
- a recommended architecture, which is probably "sim-native factors + learned priors + robust lookahead";
- a luck model;
- the value-over-time formula;
- a pre-registered validation plan (backtest on SEASON-REPLAY, calibration, a bar to pass);
- 3-5 build units.

## Budget and privacy
Run 5-6 parallel web-research agents, one per question, plus one Fable synthesis. Keep league-mate names out of anything committed.

## Addendum (Nick 9/27): comparative statics everywhere, plus missing ideas
**Comparative statics (a MUST, across the whole model).** Every recommendation ships with its sensitivity:
- how the decision and Δ playoff odds change as each key input moves;
- the BREAK-EVEN points, e.g. "worth it if Amon-Ra ≥ 24 ppg", "flips if P(yes) < 12%", "flips if Nico misses 3+ weeks";
- a tornado chart of the top 5 drivers.
Use paired-seed re-sims per input shift. Surface it in Coach and the trade story page. If a recommendation flips on a plausible input, say so.

**Other gaps to research and design:**
1. Luck regression: shrink hot and cold starts (TD rate, YPC, target share) toward priors before valuing a player.
2. Value of information and timing: an optimal-stopping rule for "act now vs wait". The lookahead's wait branch should be explicit and costed in lost games.
3. Game theory / the league as a market: who else chases the same player; what league-mates' likely trades do to our odds; bidding competition.
4. Correlation: QB-WR stacks and same-game exposure raise variance, which helps an underdog. Correlated injuries and byes.
5. Playoff-week matchups and bye clusters, weighted into player value.
6. Market timing: value trajectories (buy low before news, sell high after spikes), from the value-over-time research.
7. Portfolio view: diversification across NFL teams and byes; downside protection.
8. Negotiation: anchoring, multi-offer packages, counter ladders, and screen-gap offers (how their calculators see it).
9. Tiebreakers: points-for affects seeding. Value points, not only wins.
10. Calibration loop: log every prediction (P(yes), Δ odds, weekly win prob) and grade it weekly, so the model learns where it's overconfident.

## Addendum 2 (Nick 9/27): "our model is a dud; we need to beat FantasyPros and ESPN; what's a model worth if it regurgitates"
EDGE-PLAN. Research it and pre-register it; no claims without held-out proof.
1. **Projection stack.** Ensemble ESPN + FantasyPros (internal only, never displayed) + E-XGB + usage features, weighted per position by rolling accuracy (stacking or Bayesian model averaging). Pre-register: beat ESPN AND FantasyPros on MAE over held-out weeks with a paired CI. The E-XGB shadow alone lost to ESPN, but ensembles usually beat any single source. Report the PROJ-DUEL scoreboard weekly.
2. **Structural edges ESPN and FantasyPros can't have:**
   - (a) our league's scoring, schedule and playoff format;
   - (b) league-mates' behaviour (Jev, reply clock, screen-gap vs their calculators);
   - (c) speed on news and usage inflections (the O1 radar);
   - (d) decision quality (the chain lookahead, comparative statics, the cost of waiting).
3. **Proven signal first:** BUY-LOW (+1.98 pts/game held out) goes into player value, not only as a tie-breaker. Look for more "usage up, points down" style signals with pre-registered tests.
4. **Honesty rule:** public-data projection edges are usually near zero (see the 9/17 betting work). Aim the model at league-specific decisions, where the edge is real, and show the scoreboard, never marketing.

## Addendum 3: lessons from 2 sources Nick sent (9/27)
**1. Fox, Stanford CS229 2016, "Beating Daily Fantasy Football".** Per-position linear regressions on the last game plus 3- and 5-game averages of yards, TDs and attempts.
- Test error: about 6.5 pts (WR/TE), 7.3 (RB) and 6.2 (QB), which is baseline-level.
- A big early bug was bye weeks counted as 0-point games. Our E-XGB has the same flaw (it projects bye and out players).
- The DFS "+10.5%" was ONE weekend, so it isn't evidence.
- Lessons: plain lagged stats about match the baseline; data hygiene (byes, injuries) matters as much as the model; never trust n=1.

**2. Fantasy Outliers 2017, "We beat ESPN" (the MathBox model).** About 7,000 features: Armchair Analysis history plus scraped coaching and contract data. Separate models per position and scoring format, cross-validation weighted to recent seasons.
- The key design: predict OPPORTUNITIES x POINTS-PER-OPPORTUNITY, not raw points.
- They evaluated by converting both projections into beta-distribution WIN PROBABILITIES, not raw MAE.
- Claimed result: beat ESPN at QB in weeks 6-16 of 2017, competitive elsewhere, best on LOW-BUZZ players.
- Their conclusion: "ML + human expertise beats either alone"; use the model as a DIRECTIONAL signal vs ESPN.

**What this means for us (feeds EDGE-PLAN):**
- **(a) Decompose projections** into an opportunity model (snaps, targets, carries, red-zone) times an efficiency model. That's also the player-level "why" Nick wants.
- **(b) Don't replace ESPN.** Use our model as a directional delta on low-buzz players, where ESPN's hand-tuning is thinnest. Grade the delta's hit rate.
- **(c) Evaluate on decisions:** win probability, start/sit and trade outcomes, not MAE alone.
- **(d) In-season edge shows up from about week 6.** Our Oct 13-15 refit timing matches.
- **(e) Fix bye/out handling first,** as data hygiene.
- **(f) Richer context features:** coaching changes, contract years, team pace.
- **(g) Never claim an edge from one week.**

## Addendum 4 (Nick 9/27): DEEP RESEARCH, "how do we beat ESPN AND FantasyPros by a CLEAR margin"
Run this first in the new account: 6 parallel web-research agents, then a Fable synthesis. Test these hypotheses with the literature and our data. The margin is likely NOT on overall MAE; it's on subsets and decisions.
1. **News timing.** Friday practice reports, Sunday 90-minute inactives and late scratches. Consensus projections update slowly; an instant re-project of affected players (backups, target redistribution) is a large edge on a small set of players.
2. **Live Vegas.** Team totals and spreads as they move through the week, feeding the top-down volume model.
3. **Routes-based opportunity.** Routes run, targets per route run and air-yard share from FTN charting (in our DB) are more predictive than raw targets.
4. **Distributions, not points.** Boom/bust probabilities and per-matchup win probability. Decisions scored by win-prob gain.
5. **Contextual ensemble weights.** Per position, per situation (injury, role change, low-buzz), learned from rolling accuracy. FFA-weighted beating single sources is the baseline to exceed.
6. **The subset metric.** Measure the edge where the consensus is thin (low-buzz players, role changes, injury replacements). A "clear margin" there is realistic even if overall MAE is a near-tie.
7. **Decision backtest.** Start/sit and waiver picks made with our model vs picks made with ESPN or FantasyPros alone, graded on realised points over past seasons (SEASON-REPLAY).
Deliverable: a ranked list of edges, each with expected size, evidence, the data we have and a build cost, plus a pre-registered bar per edge.

## Addendum 5 (9/27): open-source models reviewed, and the better edges they point to
**Repos and papers:**
- ffverse/ffopportunity: xgboost expected points on nflverse play-by-play. We already ingest it as nfl_ffopportunity_weekly.
- ffverse/ffsimulator.
- mattgilgo/fantasy_football (benchmarked vs experts).
- clemens06 (walk-forward, per-season baselines, an ensemble of linear + xgb).
- jfontanet5 (a Tweedie objective for zero-inflated points).
- mazinsafer (leakage-safe walk-forward).
- the `fantasyfootball` PyPI package: 18% better than naive, but industry is 4% better than it. Honest: DIY models usually trail industry on overall error.
- OpenFPL (arXiv 2508.09992): position-specific ensembles MATCH a commercial service overall and BEAT it on HIGH-RETURN players.

**Better edges to add to EDGE-PLAN:**
- **(8) Tail accuracy.** Model boom probability (P ≥ 20/25 pts). OpenFPL's clear win was on high-return players, and underdogs (like Nick at 0-3) win on tails.
- **(9) xFP luck regression.** Actual minus expected fantasy points (ffopportunity) regresses hard. Buy negative-luck players and sell positive-luck ones; this is BUY-LOW/SELL-HIGH made quantitative.
- **(10) Tweedie / zero-inflated loss** plus availability, so injuries, byes and blowouts are modelled natively.
- **(11) Walk-forward weekly retrain** (the A_weekly arm), with leakage-safe features.
- **(12) Market-value vs projection gaps.** Where FantasyCalc and FantasyPros trade value lag our xFP-based forward value, that's the trade edge; it pairs with SCREEN-GAP.

## Addendum 6 (9/27): "one giant ML pool", done right (STACK unit)
- Build a stacked ensemble, not "add every repo".
- Base learners chosen for DIVERSITY:
  - ESPN;
  - FantasyPros (internal only);
  - xFP (ffopportunity);
  - a usage/routes model (FTN TPRR, route growth);
  - a Vegas top-down volume model;
  - our E-XGB (Tweedie);
  - a luck-regression prior.
- Meta-learner: a regularised linear or quantile blender with per-position, per-context weights, trained walk-forward on past weeks only.
- Outputs: the mean plus quantiles (p10/p50/p90 and boom probability).
- Pre-registered bar: beat ESPN and FantasyPros on held-out-week MAE AND on tail and boom calibration, with a paired CI. Otherwise it stays shadow.
- Only add a new base model if it lowers stack error on held-out weeks (ablation). Check the license before copying any repo code; prefer re-implementing ideas.
- Watch out for: models trained on the same nflverse data make correlated errors (little gain); the blender overfits with about 3 seasons of weekly data; leakage from post-game stats; 8 GB Mac compute.

## Addendum 7 (9/27): 20 more candidate base learners for the STACK
Each must pass the ablation (it lowers held-out stack error) to stay.
8. CB matchup model: WR vs shadow corner, coverage type (man/zone rates from FTN charting).
9. O-line vs D-line model: run-block and pass-block win rates vs the defensive front, into RB YPC and QB time.
10. Game-script simulator: play-by-play Monte Carlo from the spread and total, giving pass/run volume per script (trailing = pass).
11. Weather model: wind, precipitation and temperature on pass efficiency and kicking.
12. Coaching/play-caller tendency model: PROE (pass rate over expected), tempo, red-zone play-calling by coordinator, with coach-change shocks.
13. Red-zone and goal-line share model: inside-10 and inside-5 carries and targets into TD probability.
14. Air-yards / aDOT model: WOPR, deep-target share into boom probability.
15. Snap-share trajectory model: changepoint detection on snap%, routes% and RB route participation.
16. Injury-return model: first games back from specific injury types (hamstring, high-ankle) predict reduced snaps.
17. Teammate-injury redistribution model: vacated targets and carries, and who absorbs them (O1 radar events, quantified).
18. Rookie development curve: week-by-week usage growth for rookies and 2nd-years vs historical comps.
19. Age/aging-curve prior: position-specific decline by age and workload.
20. Similarity/comps (k-NN) model: find the closest historical player-seasons, then use their next-week distribution.
21. QB-quality-to-receiver model: the pass-catcher's value conditional on the starting QB (backup QB downgrade).
22. Pace model: seconds per play and no-huddle rates into total plays.
23. Defense-vs-position adjusted for opponent strength (not raw points allowed).
24. Market-movement model: prop lines (receiving yards, anytime TD) as a sharp external signal where liquid.
25. News/sentiment NLP model: beat-reporter language ("expanded role", "limited") into a usage prior (Claude-extracted, numbers from producers).
26. Bayesian hierarchical player model: partial pooling of efficiency toward position/team priors, giving shrinkage with honest uncertainty.
27. Quantile gradient-boosting model: direct p10/p50/p90 and boom prediction (tail specialist).
Data we have: nflverse PBP/usage, FTN charting (routes, coverage), ffopportunity, odds/lines, injuries, depth charts, news. Missing: weather (needs ingestion), O-line win rates (limited public), props (thin liquidity per 9/17 findings).
