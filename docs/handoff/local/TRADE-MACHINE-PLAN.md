# Trade Machine plan v2 (2026-09-23 02:40Z; Nick: "spend what's left making this plan better")
Objective (one KPI): Nick's title odds per league (season-sim, current week + real record), moved by trades. Second: rest-of-season starting-lineup points gained minus given. Everything else is a means.

## What v1 (§19 TM-01..08) got wrong or left thin, and the fix
1. "Their-eyes value shifted by sentiment" (TM-01) is thin: 132 sentiment rows, no calibration. FIX: their-eyes value = a MARKET price built from the 14,882 real Sleeper trade sides (what managers actually pay, per player per week, revealed preference; free and allowed) + ESPN's public numbers they see (ROS rank/projection, %rostered, %started and their weekly change = hype) + that manager's own revealed habits from his transactions. Chat sentiment becomes a tag with n ("praised him 3x"), not a multiplier.
2. Backtest leakage (TM-06): the "fair on paper" side must use only what was known on the trade date (ESPN projections as of that week, rosters of BOTH teams that week from team_weeks). Only accepted trades are observed; declined offers are invisible, so acceptance cannot be fit there. Nick's own 20 proposals in league 4 (declined/countered/ignored) are the only acceptance data and stay unreadable until N1 (ESPN cookie on the live collector). N1 is the #1 blocker for the machine learning anything about acceptance.
3. Roadmap as a fixed path (TM-05) ignores that each step may be refused. FIX: a decision tree with acceptance odds per branch and expected title odds per branch, re-planned weekly.
4. Analyst confidence (TM-07): structured output, every number cited, influence capped, forward-only grading, and a "how this looks if it goes wrong" line on every pitch (reputation is a repeated game: the same manager has to say yes again in November).
5. Missing rules: the league's trade review window, veto rule, deadline, roster size and flex rules (A-01 league config) decide what "fair-looking" must mean (veto-proof = paper value within the review norm) and when 2-for-1s hurt (roster spots).
6. Nick's own biases: endowment (overvaluing his own players) and recency. FIX: the machine prices Nick's players at MARKET and flags when Nick is the one overpaying (selfScout exists).
7. Counters: v1 only sends offers. FIX: "evaluate this counter" in one tap (paper + real + what to reply), because most deals close on the counter.

## New data to pull in (licence-first; free unless noted)
- TM-09 Market prices from real trades: per player per week, the median package value paid across Sleeper trades (revealed price), with a hype index = price minus our real value. Sell where hype > 0, buy where < 0. Allowed by Nick (aggregates only).
- TM-10 ESPN league signals via the league API: each team's trade block ("on the block" / "untouchable" flags per player), transaction counter, %rostered/%started deltas, injury status. The block flags are the counterparty telling us what he wants to move. Needs the cookie (N1) for private leagues.
- TM-11 Injury timelines: from nflverse injuries 2009+, the distribution of games missed by injury type and position, re-injury rates, and post-return production dip. Gives "two weeks later" numbers for injured and injury-adjacent players (teammate returning = targets vanish).
- TM-12 Forward schedule strength: power ratings from closing lines -> implied team totals for every future week incl. 15-17; bye map; a "next 3 weeks vs rest" swing per player. Uses the nflverse line history we hold.
- TM-13 Role and opportunity: snap share, routes, target and air-yard share, red-zone share, xFP (ffopportunity, licence fixed in F-08), OL continuity (rnd/data/ol-continuity-snaps), FTN charting (rnd/data/ftn-charting; licence to confirm), OC/QB changes from the news feed.
- TM-14 Public hype (terms first): FantasyPros/ECR rank moves, Reddit and X mention volume, Google Trends. Only if terms allow; otherwise the ESPN %started delta is the hype proxy.
- TM-15 Nick's voice: his own messages in the corpus (length, tone, emoji, how he opens deals) so drafts read like him.

## Negotiation playbook (each item = a feature + a test)
- Anchor: open above the target, concede in shrinking steps; MESO: send 2-3 equivalent offers at once so his choice reveals what he values and he feels he chose. Test: acceptance and reply rate by offer style once N1 gives outcomes.
- Justify: every offer carries a true "because" tied to HIS stated need (he said he needs an RB: cite it; his RB2 slot scores 6.1). Commitment/consistency.
- Frame the loss of not trading ("your flex has averaged 5.8 the last 3 weeks"), never the gain we take.
- Quantity illusion: 2-for-1 where Nick gets the best player; show him the roster spot he frees as a plus for him; plan the throw-in he will ask for in advance (Nick's droppable bench).
- Social proof: prefer deals ESPN's own analyzer calls even or his win; say so only when true.
- Timing: after a loss (tilt) and before his bye crunch; before the deadline; in his active hours (night_share, reply latency). Test on Sleeper: acceptance rate vs the partner's prior-week result and bye load (RS-02).
- Repeated game: cap "wins" per partner per season; never take the same guy's best player twice; keep a fairness ledger per partner so November deals still happen.
- Trade-then-claim: a 2-for-1 forces him to drop someone; if Nick holds waiver priority, target the drop. Test on Sleeper: are post-trade drops picked up by the partner within 48 h and how good are they (RS-03).
- Endowment: he overvalues his own players, so buying costs more than selling earns. Prefer SELLING hype (TM-09) and buying with quantity; expect to pay a premium when buying a stud and price it in.

## Research units (pre-registered, aggregates only)
- RS-01 (=TM-06): does the paper-fair/real-edge signal predict who gained at +2/+5 weeks? vs ESPN-value baseline.
- RS-02: acceptance/timing: do trades close more often after the partner lost, in bye weeks, near the deadline? (Sleeper transactions have timestamps and matchups.)
- RS-03: trade-then-claim frequency and value.
- RS-04: hype decay: does a player's revealed market price (TM-09) above his real value fall over the next 2-4 weeks? (This is the "why did I do that" mechanism, measured.)
- RS-05: 2-for-1 outcomes: does the side receiving the best player gain more, by league size and roster rules?
- RS-06: injury-adjacent sells: production of WR2/RB2 when the WR1/RB1 returns; timing of the return vs the trade.

## Build order (after the midnight resume; each unit: RED test, skeptics, auditor where it prices)
1. Dossiers (local) + TM-09 market prices + TM-11 injury timelines + TM-12 schedule swing (data first; all local, no product risk).
2. TR-01 chance-to-play fix, TR-03 value inputs, TM-06/RS-01 backtest (the proof).
3. TM-01 finder + TM-02 tags + counter evaluator; TM-03 target board; TM-04 pitch ladder in Nick's voice; TM-05 decision tree.
4. TM-07 analyst + TM-08 research feed (after Nick's spend cap).
Weekly: title-odds trajectory per league and a "trade machine contribution" line (points from acquired minus given), so we know if it works.

## Decisions owed by Nick: N1 (ESPN cookie on the live collector: unlocks acceptance learning and trade-block flags), analyst spend cap (TM-07/08), phone alerts (N12), deploy word.

## Research notes (02:50Z, web + local checks)
- MESO (multiple equivalent simultaneous offers) is backed by six experiments: offers are accepted more often, recipients are more satisfied, the offerer anchors harder (recipients adjust less from a MESO), joint outcomes rise, and the offerer earns a cooperative reputation. Sources: Leonardelli, Gu, McRuer, Medvec & Galinsky 2019, OBHDP (https://www.sciencedirect.com/science/article/pii/S074959781630557X); Medvec & Galinsky, "Negotiating for more: the MESO" (https://pubmed.ncbi.nlm.nih.gov/24042029/); AOM 2012 (https://journals.aom.org/doi/10.5465/AMBPP.2012.14827abstract). Product rule: TM-04 sends 2-3 equivalent offers by default, each with a true "because"; the counterpart's pick is logged as a preference read (feeds the dossier).
- ESPN trade-block flags (TM-10): the mTeam view exists but the block fields are undocumented (https://github.com/cwendt94/espn-api, https://gist.github.com/nntrn/ee26cb2a0716de0947a0a4e9a157bc1c, https://thomaswildetech.com/blog/category/espn-fantasy-football-api/). Local check on the 5 stored league payloads: payloads=5, containing "tradeBlock"=5, "onTheBlock"/"untouchable"=1. CONFIRMED: all 5 stored payloads carry "tradeBlock", and one league already has players flagged on the block / untouchable. TM-10 reads it from the stored payload today (the fetch that stores it needs the cookie, so keeping it fresh on the live server is N1).
- Endowment effect and the repeated game are why the machine prefers SELLING hype over buying studs, and why it keeps a per-partner fairness ledger.

# v3, the insane tier (Nick 2026-09-23 12:20 AM ET: "MAKE IT MORE INSANE"). Built after the core (TM-01..15); each has its own how-we-know test.
- TM-16 Digital twin per manager: an AI agent per league-mate built from his 16,626-message corpus, transactions and dossier. Every offer is negotiated 20 times in simulation before it goes out; the machine sends the offer and pitch that wins most often in simulation. Test: the twin must predict the real replies to Nick's 20 league-4 proposals and to every future offer (hit rate with CI) before its advice moves anything.
- TM-17 Pain calendar + live offense: per manager per week: byes, injuries, tough schedule, playoff-odds collapse, tilt. When news hits (his starter goes down), an offer filling his new hole from Nick's surplus is drafted within minutes at a premium (news-lag-trader wired to the beat-reporter feed). Test: acceptance and price of offers sent inside a pain window vs outside (RS-02).
- TM-18 Regression radar, the "why did I do that" list: every week the 10 players most likely to fall (hype above real value, TD luck, a teammate returning, a schedule cliff) and the 10 most likely to rise, each with a probability from history (RS-04). Sell and buy before it happens.
- TM-19 Playoff-week specialist: values weighted for weeks 15-17 (implied totals then, from TM-12) while everyone else prices this week. Test on history: rosters built by playoff-schedule value vs generic value, points scored in weeks 15-17.
- TM-20 Contender-aware trading: simulate the whole league; prefer partners outside Nick's playoff path; never strengthen the rival blocking his seed; buy from collapsing teams at seller prices. Test: title-odds delta including the partner's change, not just Nick's.
- TM-21 Experiment engine: 5 leagues, about 45 counterparts, every offer a trial: 2-3 equivalent offers vs one; loss frame vs gain frame; post-loss timing vs neutral; 2-for-1 vs 1-for-1. Bayesian updating of acceptance per style; by mid-season we know what works on these humans. Needs N1 to see replies.
- TM-22 Pre-mortem + receipts: before sending, the analyst writes "it is three weeks later and this trade was a disaster: why?" and the offer is adjusted or dropped; two and five weeks after, the receipt (both sides' real lineup points vs expected) is filed and shown.
- TM-23 Arbitrage chains: buy from A what B overvalues, flip to B; three-way cycles found from per-manager price maps (B8 later). Test: chain value realized vs planned.
- TM-24 Reputation radar: chat signals about Nick (resentment, "fleeced", veto talk), a goodwill ledger per partner, a cool-down rule, and a post-trade goodwill line. Test: reply rate and acceptance of the second deal with the same partner.
- TM-25 Waiver-flip: claim the week's hyped one-week jumpers and flip them to point-chasers before the fade (the study: one-week jumps fade). Test: flip value vs holding.
- TM-26 War room on the Trades tab (nav stays 8): targets, offers out, counters in, pain calendar, regression radar, receipts; one-tap "evaluate this counter".
- TM-27 Availability oracle: practice-report patterns (DNP/LP by day) plus injury history give P(plays) per starter and P(returns) per injured player; feeds the dead-starter guard and trade timing. The study says availability is the biggest lever. Test: Brier score vs designation-only.
Insane ideas we will NOT do (and why): auto-sending offers without Nick's tap (one-way door, reputation); anything false in a pitch (caught in a group chat, kills the repeated game); collusion or side deals (the study checked for collusion signatures; stay inside league norms); more than one follow-up per partner per week; over-trading (from 5+ trades a season the per-trade gain drops to +0.9).

# v4: trades + start/sit only (Nick 2026-09-23 12:35 AM ET: "just trade rn and start sit, make it insane"). Planning only; nothing launched.
## Start/sit, the insane tier (the study: the edge is availability and late information, not clever picks)
- ST-01 Availability oracle (=TM-27): P(plays) per starter from practice reports by day (DNP/LP/FP patterns per injury type and per team's habit with "questionable"), injury history, rest and travel; P(returns) per injured player; P(leaves early). Test: Brier vs designation-only on 2022-2025; ships when it wins.
- ST-02 Matchup-aware lineup: optimize the chance of WINNING THIS MATCHUP, not expected points. Underdog: take the ceiling lineup (stack QB with his WR, correlated upside); favorite: take the floor. Uses the ranges (BLEND-02), the opponent's lineup (visible on ESPN) and live score. Test on history: simulated head-to-head weeks, P(win)-optimal vs max-expected lineups, with CI.
- ST-03 Late-swap engine: sequence by kickoff window; keep flex on late-game players when uncertain (option value); after the early games, re-choose floor vs ceiling from the live margin and the opponent's remaining players; 90-minute inactives check per window (39.6% of inactive regular starters were still started league-wide). Test: points and win-rate gain of the late-swap rule on 2022-2025 vs a Sunday-morning lock.
- ST-04 Bounded autopilot (needs N12): if a starter is ruled Out or inactive and the best healthy replacement is clear, the swap is applied automatically 30 minutes before kickoff and Nick gets the receipt. Everything else stays one-tap. Test: zero dead starters across all 5 leagues, every week.
- ST-05 Dead-money audit, weekly: points left on the bench split into dead starters, late news missed, and wrong calls among healthy players (Nick weeks 1-2: efficiency 0.850 vs 0.851 for others; zero blunders). Shows where the loss really is, per league.
- ST-06 Bye and schedule planner: 3-week-ahead lineup plan per league (byes, stashes, streams), feeding "pre-bye sell" and "post-bye buy" into the trade finder.
## Trades, more insane
- TM-28 Their-screen simulator: reproduce what the ESPN app shows the other manager for a proposed deal (its projections and verdict), so "looks fair on their screen" is computed, not guessed. RS-07: reverse-engineer it from real proposals (Nick sends one, we compare the app's verdict to ours).
- TM-29 Matchup arbitrage, weekly: most managers price THIS week (matchup, recency). Buy players with a bad matchup now and a great rest-of-season (playoff-weighted); sell players with a great matchup now and a bad road ahead. RS-08 on the 14,882 trades: is this week's implied total priced into what people pay?
- TM-30 Reaction-lag per manager: median time from injury news to that manager's first move (drop, claim, offer), from news and transaction timestamps; the offense window is his lag minus ours.
- TM-31 Package optimizer: for a target, 2-3 equivalent packages from Nick's roster (equal for Nick, different for him), built around his bye holes and weakest slot, including the throw-in he will ask for. Every package passes the veto line and the reputation ledger.
- TM-32 Objection playbook per manager: his top objections from chat history ("not giving up X", "you're fleecing me", "let me think") with prepared true replies; the pitch ladder uses them.
- TM-33 Portfolio view of Nick's roster: bye stacking, same-team concentration, playoff-week exposure, injury correlation; insurance trades that cut risk at equal value.
- TM-34 Deadline endgame: a countdown plan for the last 10 days before the trade deadline (A-01 gives the date): who still needs what, last-call offers, and the hold list.
## The weekly rhythm (what the command center runs)
Tue: receipts from last week; waivers and streams; offers out (2-3 per target, MESO). Wed-Thu: practice reports -> availability alerts; counters evaluated in one tap. Thu 8:15 PM: lock window 1 (dead-starter guard). Sun 11:30 AM: inactives -> swaps; 1:00, 4:05/4:25, 8:20 windows; Mon 8:15. Every window: floor vs ceiling from the live margin.
## Not doing: auto-sending trade offers; any false claim; more than one follow-up per partner per week; clever start/sit "optimizers" among healthy players (+0.68/week, does not repeat).

# v5 addendum (Nick 12:40 AM ET: "what else is there"). Planning only.
## Trades
- TM-35 Paper-value stuffers: a catalog of assets ESPN's screen prices but his lineup can't use: a QB2 in a 1-QB league, kickers and defenses (replacement off the wire is nearly as good), deep-bench receivers with projections but no slot on HIS roster, handcuffs with no role. Adding them makes the deal read "fair" on his screen at near-zero real cost. The study's 80% paper-vs-lineup disagreement is exactly this.
- TM-36 Auction mode: when two managers want the same player of Nick's, run a real auction: equivalent asks to both, best real value wins, both told the truth ("another offer is in").
- TM-37 Buy-back tracker: sell at the peak, buy back after the bye or the bad game; the round trip is tracked and priced.
- TM-38 Handcuff market: buy your own RB1's handcuff cheaply (insurance), sell his RB1's handcuff to him at a premium (he values his own insurance; endowment).
- TM-39 Scoring-rule mispricing scanner (biggest untested edge): each league's real scoring (A-01: bonuses, PPR level, TE premium, return yards) vs ESPN's default rank that managers price from. Players whose value under THIS league's rules differs most from their default rank are the buy and sell lists, per league. Computable today from the 5 stored scoring payloads; test: value gap vs what people paid.
- TM-40 Chat listener: live intent detection on the group chat ("anyone have a RB?", complaints about a player, "I'm done with X") -> an alert with a drafted reply within minutes.
- TM-41 Loss-leader trades: a small deal that genuinely helps him early buys the big one later (reciprocity); the ledger tracks it and RS tests whether the second deal closes more often.
- TM-42 Replacement-level pricing per league: a player's real value = his points minus the best free agent at his position on THAT league's wire. Sell the position the wire is rich in, buy the one it is empty in.
## Start/sit
- ST-07 Recency-bias guard for Nick: flags benching a stable-usage player after one bad game, and starting a one-week jumper (the study: jumps fade); shows usage next to last week's points.
- ST-08 Weather and venue: wind over 15 mph, rain, dome, altitude, as-of Sunday morning, moving the ranges (passing, kicking).
- ST-09 Bench built for late swaps: keep at least one flex-able late-window player so ST-03 always has an option.
- ST-10 Live points-needed tracker: on gameday, what the remaining unlocked players need, and the floor/ceiling call per window.
- ST-11 Weekly grade of three lineups: ours, ESPN's, and what Nick actually started, scored by matchup win probability, not just points (extends the C-01 gate).

# v6: THE CHAMPIONSHIP ENGINE (Nick 12:50 AM ET: "thousands of sims till championship, always moving with every action, ML/AI"). This is the spine; the trade machine, start/sit and waivers all read from it. Planning only.
## What it is
One simulator of the rest of every season (all 5 leagues) that re-runs itself on every event and prices every possible action, trade, claim or lineup, in one currency: Nick's title odds. Embryo exists: season-sim.js:173 simulateSeason and :361 tradeImpact (paired seeds, CIs); B-01/B-03/B9 in the queue. The engine is its upgrade.
## The sampler (one sim = one full season to the trophy)
1. Game environment first: for every NFL game, sample the score from the spread and total (line history for the fit; future weeks from power ratings, TM-12), weather where known. Team points drive everything below, so teammates move together.
2. Player outcomes conditional on team points: usage shares (snap, route, target, red-zone; TM-13) turn team points into each player's points with a calibrated range (BLEND-02); the QB-WR stack and the RB-vs-passing trade-off fall out of the shares, not a hand-set correlation.
3. Availability: each starter plays or not from the availability oracle (ST-01); injuries strike with the historical rate by position and age, last a sampled number of weeks (TM-11), and dent production on return.
4. Opponent managers behave like themselves: lineup efficiency and dead-starter rate per manager (their 2026 lineup snapshots, the Sleeper population as the prior), waiver adds per week, trade frequency; active managers get stronger late, checked-out ones decay. Nick's policy is the engine's own best lineup.
5. League rules exactly: scoring (A-01), roster slots, byes, playoff format, seeding, tiebreakers, the bracket (weeks 15-17), median games if any.
6. Output per sim: every team's wins, points, seed, bracket result. 10,000 sims per evaluation; paired seeds (common random numbers) so the difference between two actions is measured on the same simulated seasons and the noise cancels (standard error on a title-odds delta about 0.3 points at 10k).
## Always moving (event-driven)
Events: injury or practice-report news, any transaction in any league (ESPN sync), a line move, a waiver run, a trade offer received, a game result, and on Sundays every scoring update. Each event updates the state, re-runs the affected sims (state hash cache; only leagues touched), re-ranks offers and lineups, and raises an alert when title odds move more than a threshold or a new top-3 offer appears. Sunday: a live title-odds ticker per league (matchup win probability from the live score plus remaining players, chained into season odds).
## The planner (the ML that finds the deals)
Monte Carlo tree search over Nick's actions with the simulator as the world: actions are offers (with acceptance odds from the acceptance model and the twins), waiver claims (with win odds by priority or FAAB), lineup choices and holds. Value = title odds at the leaves. Rollouts reuse the sampler. The output is the decision tree (TM-05): the best next action, its fallback, and the odds along every branch. Runs nightly in full and incrementally after events; heavy runs on this Mac or a worker, not the small Fly box.
## AI in the loop, capped
The analyst (TM-07) may shift a player's range (role change, coaching change, a returning teammate) by a bounded amount with a citation; the twins (TM-16) supply acceptance odds; both are graded weekly and lose their cap if they miss.
## One currency everywhere (B-03 done right)
Every card in the app shows "title odds X% -> Y%" with a counterfactual ladder: do nothing / best claim / best trade / best trade + lineup. Waivers and start/sit price in the same units, so the roadmap "0-2 to the trophy" is one list sorted by odds gained per unit of risk and effort.
## Units
- CE-01 Game-environment sampler (scores from lines; future weeks from power ratings). Test: simulated team-point distributions match 2022-2025 actuals (coverage, calibration by spread bucket).
- CE-02 Shares-conditional player sampler with ranges. Test: player-week coverage (80% range covers ~80%) and same-team correlation matches history.
- CE-03 Availability and injury sampling (ST-01, TM-11). Test: simulated games-missed distribution vs 2022-2025.
- CE-04 Opponent-manager behavior models (per manager with population priors). Test: simulated opponent lineup efficiency and adds per week match their own 2026 record.
- CE-05 League rules, brackets, tiebreakers from A-01 for all 5 leagues. Test: replaying 2025 standings reproduces the real seeds.
- CE-06 Event bus + incremental re-sim + state cache. Test: an injury event re-prices the affected league in under a minute.
- CE-07 Planner (MCTS over offers, claims, lineups; decision tree out). Test: on 2025 replays, the planner's recommended path beats "do nothing" and "greedy points" in realized title odds.
- CE-08 Live Sunday ticker (matchup win probability -> season odds). Test: calibration of live win probability vs outcomes across 2026 weeks.
- CE-09 Title-odds currency + counterfactual ladder on every surface (B-03). Test: contract test, one producer.
- CE-10 Grading: weekly Brier and calibration of matchup win probability, playoff odds and title odds vs ESPN's projected winner as the baseline; the engine earns its place by beating it.
Order: CE-05, CE-01, CE-02, CE-03 (data and sampler), then CE-09, CE-06, CE-04, CE-07, CE-08, CE-10. The trade finder (TM-01) and the target board sit on top from CE-09 on.

# v7: the AI / neural / LLM layer of the trade plan, on top of the opportunity model (Nick 12:58 AM ET). Planning only.
## What we already hold (measured, origin/main + local copy)
- Opportunity model: server/services/opportunity-model.js (fitOpportunityModel, predictOpportunity: ridge on usage features; fitVacatedCorrection/applyVacatedCorrection), ffopportunity.js (nfl_ffopportunity_weekly, 28,919 rows 2021-2026), opportunity-redistribution.js (vacated-volume redistribution; measured 9.5-12.6% WORSE for the weekly projection, so it stays off there; for trades it is re-tested on a different target, see AI-02).
- Training corpus: player_week_usage 42,624 player-weeks 2021-2026; snaps 128k; depth charts 180k; injuries 28k; game lines 15k; 14,882 real trade sides; 16,626 chat messages with 535,887 AI-read signals.
- Lesson from A2: usage features did not lift the WEEKLY projection beyond ESPN. The AI layer's targets are different: opportunity 2-5 weeks ahead, what humans pay, who accepts, and who plays. Every model below is graded against a dumb baseline and against ESPN where ESPN has a number, on 2025 held out and 2026 forward.
## Models (AI-01..AI-12)
- AI-01 True-value engine: rest-of-season value from OPPORTUNITY (usage -> expected points) with luck split out (actual minus expected: TD luck, YAC luck). Sells luck, buys opportunity. Test: opportunity-based ROS vs points-based ROS at predicting the next 5 weeks, 2021-2025.
- AI-02 Usage forecaster, 1-5 weeks ahead: gradient-boosted trees AND a sequence network (GRU/transformer over weekly usage vectors: snap, route, target, air-yard, red-zone and carry shares, depth-chart slot, teammates' availability, pace, spread), whichever wins on held-out. Includes the vacated-volume signal as a feature, re-tested on THIS target. Test: MAE vs last-3 average and vs ESPN's implied usage; MDE stated.
- AI-03 Situation reader (Jev, multi-model): Claude, GPT and Gemini each read the same news (beat reporters, injury reports, coach quotes, depth-chart changes) and output structured role shifts ("WR2 -> WR1 while X is out: +3.5 targets/game, 80%"); the vote is calibrated and feeds AI-02 as features. Graded weekly: did the share move as read? Cost: about $0.01 per item on Jev.
- AI-04 Market-price model (trees): what a player fetches in a real trade this week, from 14,882 sides (ESPN rank, recent points, expected points, age and pedigree, position, week, team). Hype = market price minus AI-01 value. Test: held-out price MAE; hype decay (RS-04).
- AI-05 Acceptance model with only accepted trades (positive-unlabeled learning): a market model of which packages clear (his-screen fairness, lineup fit for him, position need, bye relief, star power, player count, timing, his recent results); P(accept) from the density ratio; recalibrated on Nick's own proposals after N1. Test: reliability curve vs the fair-tier default.
- AI-06 Manager twins (Jev LLM + retrieval): for each manager, embeddings over his 16k-message history retrieve how he reacted to similar offers and situations; the twin negotiates in simulation (TM-16). Test: predicts his real replies (hit rate with CI) before it steers anything.
- AI-07 Source inference: which projections each manager prices from (ESPN app, Yahoo, consensus), inferred from his own lineup decisions matched against each source's projections. Test: classification accuracy on managers with known sources (ask a few). His-screen model uses the inferred source.
- AI-08 Regression classifier: P(a player's market price falls 20%+ within 2-4 weeks) from hype, luck, returning teammates, schedule cliff. The "why did I do that" list. Test: precision/recall on 2021-2025.
- AI-09 Value network for the planner (AlphaZero-lite): a network trained on the simulator's own rollouts to map a league state to title odds within 1 point, so tree search (CE-07) runs 100x deeper. One-day kill-or-confirm before anything else is built on it.
- AI-10 Pitch and objection LLM in Nick's voice (Jev), every number cited through the Coach verifier; objections per manager from his history. Test: a blind read can't tell drafts from Nick's messages; ungrounded digits refused.
- AI-11 Nick's preference model: thumbs up/down on every idea trains what he likes (risk, style, partners); the ranker learns it. Test: top-3 hit rate rises over the season.
- AI-12 Model zoo leaderboard: every model above on one page with its baseline, its held-out score, its forward score and its cap; nothing moves a number until it leads its baseline; weekly Jev spend shown.
## Jev budget and rules: balance checked first; per-run caps; nothing paid without Nick's word beyond the agreed weekly cap; licence-first for any source the reader consumes; no manager names leave the local DBs.
## Order: AI-01, AI-04, AI-02 (data-only wins first), then AI-05, AI-08, AI-03, AI-06, AI-07, AI-10, AI-11, AI-09, AI-12 alongside.
