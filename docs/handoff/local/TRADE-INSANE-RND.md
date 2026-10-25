# NORTH STAR (Nick 9/23 ~8:15 PM): beat the league-mates, not ESPN. FLIP radar + "go get player X" planner + Title Plan, driven by clones + proven psychology, on the one simulator. Spec: ENGINE-SPECS.md ACQ-01 + FLIP-01 + PLAN v11.

# ONE ENGINE (Nick, 3:45 PM ET 9/23: "they should be one integrated system, not separate"). Read this first; it overrides any layer-by-layer framing below.
Everything below is **one system with one loop**, not modules: projections, sims, tells, clones, radar, chess, Coach, offer loop and autopsy.

**OBSERVE -> UNDERSTAND -> SIMULATE -> DECIDE -> ACT -> LEARN -> (back to OBSERVE)**
1. **OBSERVE: one event log.** Every ESPN transaction, lineup set, offer/decline/accept, news item, Vegas move, injury, chat message and Sleeper history row goes into one append-only, timestamped `engine_events` stream (as-of safe by construction).
2. **UNDERSTAND: one world state, per week, as of any moment.**
   - Players: the projection engine (Mistake Map + chain) gives each player's distribution.
   - Managers: the Tells Factory tells + clone (engagement, their price per player, P(accept), buyer/seller state, veto risk, reputation).
   - Teams and leagues: rosters, rules, deadline, standings.
   - One store (`engine_state`), one producer per field. Every page and Coach read it; nothing recomputes.
3. **SIMULATE: one simulator.** The correlated game simulator gives player ranges, start/sit, then season sim gives title odds for every team. The same draws are used everywhere.
4. **DECIDE: one search.** Chess searches trade -> claim -> flip paths against the clones' replies, scored on title odds. Start/sit and waivers are the same search with smaller moves. The radar is the search's "where to look first" list.
5. **ACT: one voice.** Coach presents every decision (trade, pitch, start/sit, claim) with its evidence: tells with n, title-odds change, "why ESPN is off". The AI writes the words; the engine makes the calls.
6. **LEARN: one grader.** The offer loop and the Monday Autopsy grade every call against what happened, split decision vs luck, update projections, tells and clones, and log new blind spots to R&D.


## ALWAYS LEARNING (Nick, 3:50 PM ET 9/23: "one system that is always learning from all the pieces that come in, manager moves, texts etc. The engine is never done, it just learns always")
The loop never stops. There is no "trained model" that ships and freezes.
- **Engine daemon (part of ENGINE-00):** a separate always-on process, like refresh.sh and never inside the web server (the in-process scheduler stalled the server on 9/22).
  - Every 5-15 min it pulls new events: ESPN transactions, lineups, offers, news, lines, injuries, and new text messages through the chat ingest that feeds manager_chat_profile.
  - It appends them to engine_events and triggers the learners.
- **Three learning speeds:**
  1. **Per event, seconds:** Bayesian updates. A decline moves that manager's price and P(accept); a waiver move updates engagement; a text updates tone and latency tells; news updates the player's distribution.
  2. **Nightly:** refit the tells screen, the clone population model, the Mistake Map residuals and the conformal calibration on everything to date (walk-forward safe).
  3. **Weekly (Monday):** Autopsy plus reweighting of every source, and new blind spots and dead tells go to R&D.
- **Every update is versioned:** engine_state rows carry producer version and as_of, so any number can be traced to the data that made it and rolled back.
- **Drift and health monitors:** if a learner's live accuracy drops below its baseline (e.g. "start ESPN's higher number"), it falls back automatically and the status line says so. It never silently degrades.
- **Guardrails stay:** as-of safety (a learner never sees the future), one writer per field, forward grading decides ON/OFF, and no league or manager names committed. Texts stay local; only counts and rates leave the chat store.


## AND REASONS (Nick, 3:52 PM ET 9/23)
The engine doesn't just update numbers; it reasons about WHY and tests its own reasons.
- **Every number carries its reason chain:** which events and tells moved it, by how much (feature attribution on the model, e.g. "P(accept) fell 0.18: declined your 2-for-1 Tuesday (-0.11), his RB2 returned from injury so need dropped (-0.07)"). Stored with the state row, shown by Coach.
- **Hypothesis loop:** when something surprises the engine (a decline it predicted as a yes, a projection miss, a sudden waiver spree), an AI reasoner reads the evidence and writes candidate explanations ("he's tanking", "he values youth", "bye-week crunch"). Each becomes a testable tell or feature; the engine tests it on history and live data and keeps only what grades out. The AI proposes and the data decides (r17: the LLM alone doesn't predict).
- **Decisions come with the argument:** chess paths show the reasoning: what the clone believes, why it should say yes, what could go wrong, and what would change the call.
- **Autopsy reasons too:** each miss gets a causal breakdown (game script, volume, share, efficiency, luck, news missed) plus the fix the engine is making.


## JEV ANCHORS THE LOOP (Nick, 4:10 PM ET 9/23; supersedes the earlier Jev section)
"idc about JEV limits. I want JEV to anchor the models and AI simulations. It's the best ML thing out there into probabilities and actions."
**AI -> Jev -> LLM -> action -> result -> learn -> AI -> Jev ...**
- **Jev is the anchor of the engine loop.** At every DECIDE step, the engine hands Jev the world state: player distributions from the simulator, the tells card and clone, the chess candidates, news and the reason chains. Jev's models (several, cross-checked) return **probabilities and a recommended action** with the argument: which trade, which pitch, start/sit, which claim.
- **Action -> result -> learn:** every Jev probability and action is logged, then graded on what actually happened (accepted? points? title odds?). Calibration maps (per question type) and per-model weights update continuously, so Jev learns which of its models and prompts are right in which situations and gets sharper every week.
- **The stats and sim stack stays underneath as Jev's inputs and as the referee.** Jev reads the simulator's distributions; its final probability is blended with the stats model by learned weights, and the blend is what the pages show. Honest note: r17 found one frozen LLM persona lost to a waiver-move count at predicting people. This design differs (fed the full engine state, several models, calibrated on outcomes), but results decide the weight. If Jev wins, it carries the most weight; wherever it loses, the engine leans on the model that's right, and the status line says which.
- **No fixed spend cap** (Nick). Check the balance, log the cost per call, show daily Jev spend in the status, and alert only on runaway loops.
- **Question types Jev owns from day one:** P(plays Sunday), role/usage change from news, P(accept) for each offer, best pitch framing, start/sit tiebreaks, and the reasoning pass that flags contradictions in the sims.

**Build rule:** every unit (PROJ-*, CE-*, TELLS-*, CLONE-*, RADAR-*, CHESS-*, COACH-*, OFFER-*) is a STAGE of this loop. It reads from `engine_events` / `engine_state` and writes only its own fields. A unit that creates its own side store, or a second number for something the state already has, is blocking (structure lens). The first engine unit defines the two contracts (ENGINE-00, below); every later unit extends them.

**ENGINE-00 (first, before PROJ-01): the spine.**
- `engine_events` (additive migration): event type, as-of timestamp, league, team, player, payload.
- `engine_state`: an entity x field x as_of x producer table, or typed tables with one writer each.
- A reader API `/api/engine/state` for pages and Coach.
- Adapters that backfill the existing streams (league_transactions_raw, lineups, news, lines, injuries, Coach chat variables) into events.
- It builds no model, only the spine every stage plugs into.
- Tests: each field has exactly one writer (grep plus runtime assert), and as-of reads never see future events.

---

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

### Layer 5: AI pitch (persona test ANSWERED r17: the LLM persona loses to a waiver-move count, AUC 0.47 vs 0.78. The LLM writes pitches only)
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
- Jev: no fixed cap (Nick 9/23 4:10 PM); check the balance, log cost per call, alert on runaways. Nothing else paid.
- Say "guess" plainly when it is one.

## Added 2026-09-23 2:45 PM ET (Nick approved): the offer loop and 4 more trade opportunities
### OFFER-01: the offer loop (part of CLONE-01; the biggest gap)
ESPN holds only 37 real trade decisions once duplicates are removed (7 accepts, 30 declines; 20 of them by leaguemates), and just 1 trade drew real veto votes. That is anecdote-sized, so the clone test leans on Sleeper waiver claims (21,484 manager-seasons), and every offer Nick sends becomes data: So every offer Nick sends becomes data and an experiment:
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


## Corrections from ENGINE-SPECS.md (2026-09-23)
- The earlier 58/26 decision counts double-counted proposer-side rows. The true count is 37.
- VETO-01 can't be fitted per league (1 trade with real veto votes); use a population prior only.
- No past FantasyCalc values are stored. The clone baseline is season-to-date PPG until the snapshots accumulate, and the pre-registration must say so.
- The real data gaps are play-by-play and per-player route participation. ESPN 2021 is already archived, and weather before 2025 is partly there.
- FantasyPros referee (PROJ-01-c) is research-only until Nick rules on the licence.

- RULING 2026-09-23 ~3 PM ET (Nick): "we shouldnt just use that we should put better numbers out there". FantasyPros consensus may be used as an INTERNAL input and referee (PROJ-01-c, BLEND-02) from the local DB only. It is NEVER displayed or committed (the #165 repo guard stays). Every page shows OUR engine numbers. The goal is to beat consensus, not echo it.

## TELLS-01: the Tells Factory, and fixing Coach (Nick, 3:30 PM ET 9/23: "all these small things that we notice - THOUSANDS OF THINGS - that then help make predictions and reads on people. fix coach")
**R&D priority for rounds 18-20: make this runnable.**
### What it is
Thousands of small behavioral "tells" per manager, generated automatically from every event stream, then screened hard so only real ones survive. The survivors feed the clones (predictions) and Coach (plain-English reads).
- **Streams:** ESPN transactions (add/drop/waiver/trade timing, day of week, hour, reaction delay after injury news), lineup sets (when, how late, benching patterns, position hoarding, bye handling), roster construction (bench stashing, handcuffs, K/DEF streaming), trade behavior (who they target, offer size, counter style, 2-for-1 appetite, decline speed), results (after losses/wins, streaks, standings pressure), Coach chat variables (the 40 people variables: reply latency, night share, tone, and so on), and Sleeper population streams for the same features (about 22k team-seasons).
- **Generator:** crossed templates (event x window x conditioning, e.g. "median hours from injury news to add, when their starter is hurt, last 4 weeks"), giving thousands of candidates.
- **Screen, pre-registered, with no cherry-picking:**
  1. Repeatable: early vs late split, skill > 0 (coach/people/grading.js already does this; extend it to every tell).
  2. Predictive: lift on a held-out outcome in the Sleeper population (proposes a trade, accepts, drops a player, overpays, claims a player), walk-forward by season.
  3. False-discovery control across thousands of tests (Benjamini-Hochberg q ≤ 0.10); a tell must survive in every season it can be tested.
  - Survivors become features with shrinkage (population prior, per-manager empirical Bayes). Non-survivors are logged as dead so nobody re-tests them.
- **Output per manager:** a "tells card": the top tells with sample size, direction and what each predicts. Feeds CLONE-01 (P(accept), engagement, price) and RADAR-01 (a desperation or checked-out alert).
### Fix Coach (COACH-01)
- Today Coach's 40 people variables ship `priceable:false` and are graded only for repeatability, with no outcome labels.
- Fix:
  1. Grade them as tells in the factory (repeatability AND outcome lift, against ESPN decisions, activity and Sleeper outcomes). Flip the survivors on.
  2. Coach answers "how do I approach X?" from the tells card: the top 5 tells, each with n, plus the clone's P(accept) and the best-framed pitch, with no generic advice.
  3. Every Coach read cites its tells and sample sizes. Anything unproven says "unproven" instead of a neutral.
  4. The AI writes the words only (r17: an LLM persona does not predict people).
### Honesty
With only 37 real ESPN decisions, per-manager tells are trained on the Sleeper population and only tuned per person. More offers sent (OFFER-01) makes each person's read sharper. Thousands of tests without FDR control would produce thousands of fake tells, so the screen is the product.

## LIVING LEAGUE + NICK CLONE (Nick, 5:15 PM ET 9/23: picked #3 and #4; "explore INSANE ideas: physics, ML, game theory, econ, econometrics")
- **LIVING-01 (SIMULATE):** league-mates act inside the season sim through their clones (claims, trades, lineup errors, checking out), so title odds and chess play against a moving league, including their best responses to Nick's move.
- **SELF-01 (UNDERSTAND + LEARN):** a clone of Nick from his own moves (what he overpays for, panic drops, biases), causal grading of follow-vs-ignore on the engine's advice, and bias flags shown before he acts. His own graded record outranks population priors.
- 4 lens explorers (game theory/econ, physics/complex systems, ML, econometrics/behavioural) write ~/gridiron-local/rnd/insane/*.md with kill tests; survivors become LIVING-01/SELF-01 spec rows.
