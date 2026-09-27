# MODEL-POOL-V2: families, a sharp reason ledger, a real trust gate, decision-first Coach

Nick, 9/27: "expand the families way more; add categories only if genuinely unique; the reason ledger needs to be sharp; the trust gate needs a lot of work; there's a way better way to do the blended decision and the Coach trade pages."

## 1. Families (14). Each is unique in the signal it sees
1. **Market consensus:** ESPN, FantasyPros ECR and projections, Yahoo/Sleeper, the FFA aggregate, player props (receiving yards, rush yards, anytime TD), DFS salaries (DK/FD pricing as an implied projection), start% and roster% trends.
2. **Usage:** xFP, routes run, TPRR, target share, air-yards share, WOPR, snap %, RB route participation, red-zone and goal-line share, 2-minute and 3rd-down roles, first-read share (FTN), designed rushes (QB).
3. **Game environment:** game script (gamescript.js), pace, PROE, Vegas total and spread plus their movement, weather (wind, precipitation), dome, altitude, time zone and travel, short week.
4. **Events:** starter ruled out, teammate injury redistribution, depth-chart change, trade or signing, suspension, QB change, OL injuries, coordinator firing (the O1 radar, 18+ types).
5. **Information timing:** the practice-report sequence (DNP→LP→FP), beat-reporter language, the 90-minute inactives, late scratches, news velocity. A timing edge, not a projection edge.
6. **Player arcs:** rookie growth curves, 2nd-year leap, aging by position and workload, injury-return ramps (hamstring, high ankle, ACL), contract-year effect.
7. **Luck and regression:** the xFP gap, TD rate vs expected, YAC over expected, catch rate over expected, fumble luck, opponent-adjusted efficiency shrinkage.
8. **Matchups:** CB shadow and coverage (man/zone), OL vs DL win rates, defense vs position adjusted for opponent, slot vs outside, run-defense front, blitz rate vs QB.
9. **Scheme and coaching:** play-caller tendencies, personnel groupings (11/12/21), motion rate, RBBC patterns, red-zone play-calling, coach-change shocks.
10. **Team health and structure:** OL continuity, QB quality (starter vs backup multiplier), receiving-corps depth (who absorbs volume), defense injuries on the opponent.
11. **Statistical learners (method diversity):** XGBoost (Tweedie), Bayesian hierarchical, quantile GBM (tails), k-NN comps, ridge on lags, a state-space (Kalman) talent tracker.
12. **Schedule and league structure:** byes, playoff-week matchups, strength of remaining schedule, our league's scoring and 2-flex slots, the tiebreaker (points-for). Feeds decision value, not points.
13. **People and league market:** league-mates' behaviour (Jev, reply clock, trade history), their calculators (screen-gap), their needs and roster holes, who else chases a player. Feeds trade value and P(yes).
14. **Crowd sentiment:** ADP and trade-value trajectories, add/drop velocity, news-volume spikes. Signals over- and under-reaction to fade or follow.

## 2. Reason ledger: SHARP
- **Typed reasons.** A canonical taxonomy (e.g. `EVENT.starter_out.rb`, `USAGE.route_growth.wr`, `LUCK.td_over_expected`). Every expert disagreement must emit (reason_type, magnitude, context, lead_time).
- **A record per firing:** predicted direction and size, the consensus at the time, and the outcome, graded after the games.
- **Stats per reason × context:**
  - hit rate with a Wilson CI;
  - size calibration (predicted +6 → realised +4.1?), not only direction;
  - lead-time value (how early it fired vs consensus moving);
  - decay (does it still work this season?).
- **Guards:**
  - min n before it counts;
  - hierarchical pooling across sibling reasons, so rare reasons borrow strength;
  - false-discovery control across hundreds of reasons;
  - a season-level hold-out;
  - "reason already priced in?": does the consensus already move on it? If so, the edge is 0.
- **Output:** "Reason X, context Y: right 71% (CI 64-77), sizes calibrated at 0.8×, 2 days earlier than consensus, n=240, stable across 3 seasons."

## 3. Trust gate: the real version
- **Conditional reliability:** a Bayesian hierarchical model of each expert's error by context (position × situation). Posterior weights, never zero.
- **Correlation-aware weighting:** penalise redundant experts using the error covariance (like portfolio weights for forecasts). 10 clones of one idea get 1 vote.
- **Reason override:** when a high-credibility reason fires, that expert's weight is raised for THAT player-week by the ledger's calibrated effect.
- **Online adaptation:** Hedge-style updates with changepoint detection (a scheme change resets trust faster).
- **Calibrated output:** conformal intervals, so the blend's ranges are honest (80% of outcomes fall in the 80% band).
- **Baseline to beat:** equal weights and ESPN. Promotion only through a pre-registered walk-forward test.

## 4. Blended decision: the better way (decision-first, not blend-first)
- Don't collapse everything to one number and then decide. Keep the whole mixture: each expert or scenario is a possible world.
- For each candidate decision (lineup, trade, chain), simulate the season under the mixture and score it by playoff odds.
- Report ROBUSTNESS alongside EV:
  - in how many expert worlds it wins;
  - the worst-case regret;
  - the break-evens ("wrong only if both the routes model and ESPN are right about X").
- Prefer decisions that win across most worlds unless a high-credibility reason says otherwise.

## 5. Coach trade page: a DEBATE plus a live what-if
- **Verdict line,** then the SCENARIO MAP: the top experts FOR and AGAINST, each with its reason and ledger record.
- **Belief sliders:** Nick can say "I think Amon-Ra regresses to 22", and the page re-simulates live. Comparative statics made interactive.
- **Flip triggers:** "this flips if Puka is out 2+ weeks, or Lars's P(yes) < 12%". The page watches those triggers and re-alerts when news hits.
- **Chain plus lineup by slot, before and after,** with the hole highlighted, the rules checklist and the counter ladder.
- **Everything is computed by producers.** The model narrates and never invents numbers.

## Build order
1. Wire the existing experts + equal-weight baseline + typed reason emission.
2. Reason ledger with grading and stats.
3. Trust gate: hierarchical plus correlation-aware.
4. Decision-first mixture simulation.
5. Coach debate page with belief sliders and flip triggers.
6. Add families 5, 8, 9, 10, 13 and 14, one per unit, each through the ablation gate.
