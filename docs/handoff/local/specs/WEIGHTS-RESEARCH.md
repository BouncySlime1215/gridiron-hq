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
