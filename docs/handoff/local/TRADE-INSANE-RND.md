# R&D sole focus: make the Trade Analyzer insane (Nick, 2026-09-23 2:25 PM ET)
Every R&D round, both lanes, works ONLY on this until Nick says otherwise. Each find must move one of the 5 layers below, with a kill-or-confirm test.

## The technique: "Manager Clones + Title-Odds Chess"
In plain English: we build a clone of every manager in your leagues, meaning a model of how THAT person prices players and decides on offers. Then we play the rest of the season against the clones thousands of times, and pick the move sequence that raises your title odds most while each clone thinks it's winning.

### Layer 1: Clones (their price)
- Learn each manager's personal price for every player from what they actually DO: who they add, drop, start, bench, offer, accept and decline.
- Data on hand (local copy, counts measured 2026-09-23):
  - ESPN league_transactions_raw for Nick's leagues: TRADE_PROPOSAL 93 canceled + 75 pending, TRADE_DECLINE 58, TRADE_ACCEPT 26. These are **real labelled yes/no decisions**.
  - Sleeper sh_transactions: 7,952 completed trades, 352,916 free-agent adds, 198,324 completed and 156,211 failed waiver claims. This is the **population prior** for how people value players.
  - Lineup decisions: who each manager starts vs benches each week.
- Method:
  - Population model of "what makes people say yes": ESPN rank, recent points, name value, position need, number of players, loss streak, bye crunch.
  - Shrink each manager toward the population using their own history (empirical Bayes, the same idea as RL-13-3).
  - Extend counterparty-pricing.js (the one producer for counterparty price and receptiveness). Never build a second producer.
- Output: for any manager and any offer, P(accept) and "their price" for every player.

### Layer 2: Real value (title odds)
- **Projection stack (BLEND-02) feeds the sims.** Don't pick one source; learn how to JOIN them. Sources: ESPN weekly, our model, a tree model, Vegas team totals and spreads (game script), FantasyPros consensus (local only), news turned into structured facts by Jev (who's out, role changes).
- Weights are learned by position and situation, walk-forward, and output a calibrated range (an 80% range that hits about 80%).
- BLEND-01 found ESPN alone beat ESPN+ours with one fixed weight, so the test is whether a situation-aware stack beats ESPN. R&D should find the situations where ESPN is wrong (news lag, game script, usage trend) and the features that detect them.
- Math does the joining. AI supplies the facts it reads and gets graded like any other source.
- Title odds from the season simulator (CE-01/02/03/09): multi-week injury spells, final-week rest, game lines, playoff bracket.


### Layer 2 deep dive: the projection engine (Nick: "that's what I care about"), v2 after Nick's review
1. **ESPN Mistake Map (residual engine).**
   - A boosted model over hundreds of situation features predicts the *distribution* of ESPN's error (direction, size, confidence), not just its mean.
   - **Blind-spot library:** each named situation is tested alone with its historical ESPN error and 95% CI. Situations include backup after an injury, rookie weeks 1-4, return from IR, new play-caller, QB change, wind 15+ mph, blowout script, and a team total moved 2.5+ points since ESPN posted. A spot switches on only if pre-registered AND the same sign holds in every season.
   - **Line drift since ESPN posted** (Tuesday post to kickoff) is information ESPN never had: use it.
   - **Second anchor:** where ESPN and FantasyPros consensus disagree, learn who was right in that situation.
2. **Sharp chain.** Every link is measured and graded separately against actuals.
   - Team plays = f(spread, total, pace). Pass rate = neutral pass rate adjusted by the expected script (win probability from the spread).
   - Targets = team pass attempts x target share, where target share comes from route participation x targets per route run (nflverse participation plus FTN charting). Carries = team rushes x carry share.
   - TDs come from red-zone share x the team's implied TDs (from the total).
   - Efficiency uses Bayesian shrinkage by sample size.
   - **Shares must sum to 100% per team.** This kills the classic error of projecting more targets than the team will throw.
   - Each league's own scoring settings apply last.
3. **Correlated game simulator, with guaranteed-honest ranges.**
   - Each simulation draws one game script (score path) consistent with Vegas. All players in that game share it, so correlations emerge on their own (QB-WR together, RB fading when trailing, garbage time).
   - Volume and shares get uncertainty (Dirichlet), efficiency draws, fat-tailed TDs (negative binomial), and in-game injury risk.
   - **Conformal calibration** then adjusts the ranges so an 80% range covers 80% on history, per position and week band, and is re-checked every week.
4. Source disagreement is a signal (as before).
5. Speed: inactives, beat writers via Jev, weather, Sunday-morning re-projection (as before).
6. **Monday Autopsy.**
   - For every player it splits the miss into links: game script (Vegas off), team volume, share, efficiency, TD luck, in-game exit, and news we had vs missed. The plain-English line reads like: "Missed X by 11: 6 from targets (share jumped when Y left), 5 TD luck."
   - It separates decision quality from outcome luck, so luck never retrains the model.
   - Season rollups show which link is failing most and which source was right.
   - The weights update each week with forgetting (online Bayesian), and new blind spots go straight to the R&D queue.
7. Grade on decisions: start/sit win rate vs "start ESPN's higher number", range log score and coverage.

**Historical training (measured on the local copy, 2026-09-23):**
- nflverse play-by-play, participation, FTN charting, depth charts and player stats. player_week_usage covers 2021-2026 (42,624 rows); nfl_snaps 2021-2026 (129,555 rows).
- nfl_injuries 2021-2026 (28,438). game_lines 1999-2026 (15,096).
- ESPN weekly projections archived for 2022-2024 (the BLEND-01 backtest used them). FantasyPros consensus 2022-2024 via the Wayback crawl (HX-01).
- **Gaps:** ESPN history for 2021 and 2025, and weather before 2025. R&D should backfill them, licence check first.
- **Walk-forward:** fit 2021-22 -> test 2023 -> refit -> test 2024 -> 2025 (holdout already used: ledger every look) -> forward 2026 weeks as they're played.

### Layer 3: Mispricing radar
- For every manager and player: their price minus real value. Scan daily.
- Alert when news moves real value before the clone's price moves (the ESPN lag, fill-ins, rest weeks).

### Layer 4: Title-Odds Chess (game theory)
- Search move sequences, not single trades: trade, then claim, then flip.
- The clones respond: they claim free agents, counter, or reject. Use Monte Carlo tree search, where the score is your title odds after the clones' likely replies.
- Pick paths where every counterparty's clone sees a gain (so they say yes) but your real gain is bigger.

### Layer 5: AI pitch and persona test
- An LLM writes the pitch framed on the other manager's needs.
- R&D question: does an LLM persona built from a manager's history predict their decisions better than the statistical clone? Test it; don't assume it.

## Kill-or-confirm tests (pre-register before any number)
- **Clone test:** predicting held-out real decisions must beat the "fair by FantasyCalc value" baseline. Decisions are ESPN accept/decline and which waiver player they claim. Metrics: log loss and AUC, grouped by manager, with 2026 weeks forward. If it doesn't beat the baseline, Layer 1 ships default-off.
- **Chess test:** in replayed past seasons (Sleeper 2021-24, as-of only), paths chosen by the search must beat single best-value trades on title odds gained.
- **Radar test:** flagged mispricings must resolve our way more often than chance, forward-graded in the rec ledger.
- The 2025 holdout is mostly used up. Record every look in HOLDOUT-LEDGER.md.

## Rules unchanged
- One producer per number; additive migrations only.
- No league or manager names in the repo; Sleeper as aggregates only.
- Jev at most $0.25 per round, balance checked first; nothing else paid.
- Say "guess" plainly when it is one.

## Added 2026-09-23 2:45 PM ET (Nick approved): the offer loop and 4 more trade opportunities
### OFFER-01: the offer loop (part of CLONE-01; the biggest gap)
Only about 26 accepts and 58 declines exist in all five leagues' history, too few to learn each person. So every offer Nick sends becomes data and an experiment:
1. One-tap "I sent this" on any suggested deal. ESPN's proposal, decline and accept sync (league_transactions_raw) auto-matches the reply.
2. Each reply updates that manager's clone right away (Bayesian update).
3. Test the pitch: vary one factor at a time (screen-fairness level, 2-for-1 vs 1-for-1, which need is led with), logged per offer.
4. After a no: the decline bounds their price, so suggest the follow-up they're likely to take.
5. Grade it: did accepted trades raise Nick's title odds? This is the Trade Machine's real scorecard (rec ledger).
- The app never sends offers itself (sending on Nick's behalf needs his word each time); it only logs and suggests.
### Other opportunities (fold into the named layers)
- **DEADLINE-01 (Radar/Chess):** read each league's trade deadline from ESPN settings. The learning and trading window is short: rank moves by weeks left, and warn before the deadline.
- **MOTIVE-01 (Clones):** a buyer/seller state per manager from their own title odds, injuries, bye crunch and losing streak. Out-of-contention and desperate teams price differently; target them at the right moment.
- **VETO-01 (Clones):** league approval risk. The data has TRADE_VETO 7 and TRADE_UPHOLD 11; model P(veto) per league for lopsided-looking deals and fold it into P(accept).
- **REP-01 (Coach):** a reputation budget. Repeated lopsided offers lower future acceptance (how Nick comes across), so the engine spends "lopsidedness" where it pays most.
