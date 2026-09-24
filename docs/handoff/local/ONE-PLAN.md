# THE ONE PLAN: Transfer Portal Title Run (league 4)
Assembled by the coordinator 2026-09-24 10:53 EDT (from `date`). Sources: the design panel (3 architects, 3 judges, synthesis, 3 critics, fix pass), the coordinator's own evaluation (coordinator-eval.md), the data inventory (314 live tables + satellites + chat corpus), the plan-item inventory (836 items over 16 documents), and the column-level variable sweep (section 4b). Names-free: league-mates are roster ids. Nothing here is committed to the public repo until Nick approves.

## 0. In one breath
The system is one loop: live data -> the player basis (ESPN's point as the weather, our rest-of-season number) -> what a player is worth to Nick (title odds on paired seeds, tiers as constraints, LOVE as a tag) -> what each league-mate thinks he is worth and whether he says yes (their price, needs, chat reads, P(yes) with its basis) -> ONE planner that searches thousands of paths under Nick's rules (never overpay, blue chips locked, gets are real players) -> three screens (flip radar, go-get-X, Title Plan) -> Nick taps "I sent it" -> the replies grade every guess on a Tuesday. Nothing unproven moves a served number. Builds run at night; every morning there is one PASS/FAIL line and a screenshot.

Why nothing clears today is arithmetic, not a bug: with Nico Collins and Chase Brown locked and a 0 overpay cap, Taylor and Bijan are unreachable by any package this week; Olave is a Balanced 2-for-1 (Bucky + Etienne or Bucky + Price) that ALREADY sits on the flip radar and misses the deck only because the planner looks at 3 targets; Jeanty and St. Brown are Fuck-it 3-for-1s. Night 1 makes the deck look at 8 targets, prints why each path died, and merges the four ready PRs.

## 0b. Coordinator's verdicts applied (from coordinator-eval.md)
- DATA: rich, two live breaks (the nflverse growth job dies at its 120 s budget every tick; the news extractor's key returns 401), unused gold (routes proxies, team tendencies, 10,670 labelled pressers, APM), people data wired for league 4 but not read by the target cards. Repairs are night 1 item 0.
- STRUCTURE: the design is right; the process was the problem (16 plan documents, 25 names for the same things, 65 built-but-unmerged PRs). This document is now the only plan; the dedup families are its glossary; merging comes before building.
- PLAN: keep the panel's order (real card first, basis + resolution, P(yes) one module, tiers + ladders, offer loop, breadth, then opportunity into the numbers). The 5-lens composite Nick chose is KILLED as a ranker by the bake-off (r53) and survives as thresholds + a display breakdown; the objective stays title odds.

## 0c. The weekly rhythm (defined once; every night hangs on it)
Tue night: grade last week (E1-E7, autopsy), refit what is due (K, availability rates, credibility), the R&D night. Wed night: merges + the week's build. Thu night: plan + offers drafted for the 7 AM ET send window. Fri/Sat nights: replies, counters, waivers. Sun morning: game-day checks 90 minutes before kickoff (inactives, late news, swap-before-1-pm). Mon night: autopsy inputs. Every morning 06:30 ET: MORNING.md (one PASS/FAIL line), two screenshots, the brief. Trade deadline Wed 12/02 17:00 UTC; last real send Mon 11/30.

---


Tonight (night 1, Thu 9/24, 9 PM ET): repair the five data holes, merge #308 + #336 + #291 + #375, build REACH-01 with `dropped_by_reason` as its FIRST output, run the producer once, write MORNING.md. Friday 06:30 ET you open one names-free file and one screenshot: either a real-player card that wins on value, or the exact count of paths dropped by each gate and the closest miss with its chain. Everything below serves that morning and the mornings after it.

Every fact is marked (measured: source) or (guess). Facts file = ONE-PLAN-FACTS.md in the coordinator scratchpad; it wins over any doc EXCEPT where the live DB contradicts it (two places, flagged below). League-mates are roster ids only.

Calendar correction (measured `cal 9 2026` and `schedule_games` season 2026): today 9/24 is a THURSDAY, not Wednesday. NFL week 3 has NOT been played: week-3 games run Thu 9/24 (tonight) to Mon 9/28 (`schedule_games` week 3 dates 2026-09-25..09-29 in UTC, 32 rows; `league_roster_snapshots` period 3 has 0 of 21 rows with actual_points; `leagues.payload currentMatchupPeriod` 3). Facts §3 "week 3 done" is wrong; DB wins. Consequences: usage tables at 2026 week 2 (`player_week_usage`, `nfl_ffopportunity_weekly` max week 2, measured) are CURRENT, not lagging, until the post-week-3 nflverse update on Tue 9/29; every "week N" in the night table is re-labelled; week 4 = 10/1-10/5, week 12 = 11/26-11/30 (UTC 12/1), week 13 starts Thu 12/3; the deadline 1796230800000 = Wed 12/02 17:00 UTC (measured `date -r`), so `_run.deadline_week` 12 stands.

---

## 1. The objective and the three screens

Objective (Nick, facts §1): beat the league-mates, not ESPN. Deliverable = the North Star's three screens (NORTH-STAR-PLAN.md rows 1-3, lines 6-8, all live in preview):

| screen | what it shows | what it reads |
|---|---|---|
| 1. Flip radar | each roster's price for a player vs its real title value to Nick; buy-from-A / sell-to-B gaps fair on both screens; "why now" | plans.json `flip_map` + `partners` |
| 2. Go-get-X planner | ranked paths (trade / claim / flip) to a real player, P(yes) per step with basis and `guess:true`, title-odds effect with SE, backup at every "no", message + walk-away + reply table, and when nothing clears: dropped-by-reason counts + the closest miss with its chain | plans.json `targets`, `next_move`, `alternatives`, `_run.dropped_by_reason`; his-screens.json |
| 3. Title Plan (War Room) | destination, title odds now vs planned, next move, itinerary, Safe / Balanced / Fuck-it, catch-up list, report card, number health; Coach reads the same fields and only writes words | plans.json `destination`, `itinerary`, `speed_curve`, `catch_up`, `risk_modes`, `brain_report`, `number_health` |

Two files, ONE producer: `scripts/campaign/produce-plans.mjs` writes plans.json and, in the same run, his-screens.json via `server/services/campaign/his-screen.js#writeHisScreens` (measured produce-plans.mjs:32 "ONE-PLANNER: this is the only planner and plans.json its only output"; :494-496 writeHisScreens). his-screens.json is `leagues: {}` today (measured) because no deck exists. Nothing in this plan adds a second producer of any served number.

What the ranker maximises: Nick's title odds change on paired seeds (`server/services/campaign/modes.js:89-110 scorePlan`; Safe = expected minus one SD, Balanced = expected, Fuck-it = `delta_final` if the whole plan lands AND `p_complete >= ALL_IN_MIN_COMPLETE` 0.03, `modes.js:25, :96-99`, hand-set). Evidence (measured r53-VALUE-BAKEOFF.md:14-23, held-out 2023/2024): title-odds lens 0.571 / 0.559 AUC at picking the side that gains; every lineup lens ties 0.57-0.58; the fitted composite does NOT beat the best lens (facts §6 KILL); market-value and blue-chip lenses anti-predict the playoffs (0.48). Caveat: right-signed, low-resolution (r53 title Brier 0.092 vs 0.094 base). Playoff odds is an allowed Safe-mode substitute.

Nick's rules are CONSTRAINTS on the search, never weights (facts §2):

| rule | how it is enforced today (measured) | what changes |
|---|---|---|
| Never overpay (FantasyCalc given <= received on every step, flip leg, walk-away) | `search.js:30 DEFAULT_MAX_OVERPAY = 0`; filter inside `stepsFrom` before scoring (`search.js:302-315`), merged #372 | stays. NOTE: cap 0 allows give == get; facts §2 says he wants trades he WINS. A `min_edge` threshold is added (default 0 = even allowed) and is decision 1 |
| Blue chips never offered (Nico Collins 160, Chase Brown 80) | `search.js:87` `tradable` excludes `adapter.untouchable` (from Nick's notes, #373) from gives AND targets; `search.js:298` flipMap adds each manager's nick block; served ids ['368','132','160','80','277'] (plans.json 14:23Z `_run.inputs.untouchable`). `modes.js:78-80` is a SECOND belt that reads `objective.untouchables` from objectives.json, which does not exist next to plans.json (measured `ls`), so it drops nothing today | stays (single-source in the adapter; measurable: every served give grep'd against `untouchable.ids` = 0 hits). A.J. Brown 277 stays in the set until night 5 prices him at a HEALTHY value (decision 3) |
| Gets are real players | not enforced (any get passes) | GETS-REAL (night 1): the final-leg GET must carry a PLAYER-SCORE label >= the floor ("Level below", 74+, default; decision 2). The floor applies to the GET only; "Level below" players on Nick's side are spendable currency (so Bucky Irving 74 can be paid; not circular) |
| Depth-for-depth only on the way to a blue chip | intermediate steps unconstrained (`search.js:353-362 chipLayer`) | stays; LADDER-01 (night 5) lets the chained finish spend the acquired piece with the mode's max give |
| LOVE on buy-lows (usage + draft capital + healthy role; luck weight 0) | not built | LOVE-RULE (night 5) served as a TAG only (BUY / PASS / AVOID + one luck sentence) through 12/02; never a search constraint (keeps the radar byte-diff check honest, section 5 night 8) |
| Sliders 40/30/10/10/10 | display breakdown | become THRESHOLDS: `min_edge`, min tier of the get, min his-screen fairness; playoff/lineup sliders collapse into the risk mode (`modes.js:30-34`). The composite never re-ranks (r53) |

Provenance rule (reworded so the ranker obeys it): every served NUMBER is PROVEN (held-out gate passed), BLEND (labelled; cannot move a served odds number) or GUESS (`guess:true`). Unproven pieces cannot move `title_delta`, `title_now` or `p_yes`'s value class. RANKS are a different thing: `pathExpectation` multiplies every delta by a guess-labelled p (`paths.js:57-75`, `modes.js:89-105`) and flipMap ranks by spread x p1 x p2 (`search.js:232-240`). So each served rank carries `rank_basis: "p_guess"` and the card shows "if he says yes: +X" beside the expected value, until E1 passes (night 13). Safe mode may rank on delta with a declared constant p per partner (labelled) as a fallback.

---

## 2. The one system (layers)

| layer | produces | producer (one) | gate / grader | status | feeds |
|---|---|---|---|---|---|
| L0 Live data | rosters, injuries, news, lines, chat labels, FantasyCalc `player_metrics fc_value` (195 rows, fetched 2026-09-24 08:57:05, measured) | `scripts/refresh-live-data.mjs --loop` 15 min; DATA-FC #336 adds the daily FantasyCalc job | FRESH-01 (night 1): one row per loop table with max(week) / max(fetched_at) in `number_health` (today `source_age` reads ok while a table can be stale for days: coordinator-eval.md:31). Repairs D1-D5 (coordinator-eval.md:10-14): `nfl_model_growth` dies at its 120 s worker budget every tick (12 straight) so week-3 usage will NOT land after Monday unless fixed; `nfl_news_signals` dead on HTTP 401 (42-43 straight; key in .env; only Nick can enter a credential); 6 chat messages unlabelled; ~8 GB duplicate DB copies; FantasyCalc credit link. META-01b: `scripts/rnd/espn-projection-poller.mjs` exists but no process runs it and `rnd/loop/data/espn-flip-timing/` is empty (measured `ls`, `pgrep` 0) | live, holes | L1, L4, L5, L6, L8 |
| L0b Betting-side assets reused (betting objectives: ignored) | reuse table below | the boundary "one door" `server/services/betting-fantasy-link.js` is a RULE (master plan:787), partly wired: it is imported by `server/routes/nfl-betting.js` and `server/services/campaign/his-screen.js` (measured grep), but the live game-lines path is `game_lines -> server/services/gamescript.js#gameScriptFor -> projections.js:33` directly (measured) | each reused item is gated by the fantasy number it feeds; the boundary becomes real when O1C-WIRE touches `projections.js` (night 11) | rule, partly wired | L1, L3, L5, L11 |
| L1 Player basis | `blend.week` = ESPN's point (META-01 ruling; #291 adds `server/services/blend-week.js#blendWeek`, measured `gh pr view 291 --json files`; absent on main); `ros_ppg` (`ros-projection.js`, served ROS; MAE 3.40/3.62/3.68 at wk 3/5/8 of 2024, facts §6); `p_play` role cells; volume x efficiency chain (`projections.js:103-108`, K.share 6 / K.team_volume 10 hand-picked, facts §4) | `ros-projection.js buildRosProjections`; `blend-week.js` after #291 | ROS 12-check gate; AI-01 #376 declined; `number_health projection_basis` BROKEN: rank agreement 0.78 over 143 rostered players, needs 0.9 (measured plans.json generated_at 2026-09-24T14:23:43Z) | live | L3, L4, L8 |
| L2 Opportunity radar | `adapter.opportunityOf(id)`: 4 validated cells (teammate_out RB; usage_rise WR/TE; star_return RB and WR/TE marginal) + watch flags (backup-QB downgrade NOT significant n=474) | PR #377 (MERGEABLE, flag `GRIDIRON_OPP_RADAR` off) (facts §9) | pre-registered; whole radar MAE 3.134 -> 3.108 [0.016, 0.038]; train/serve P(out) 0.506 vs 0.496 must be fixed before preview | draft_pr | L4 (LOVE role health), flip "why now", Coach |
| L3 One world (title odds) | `title_now`, `title_delta` + `se`, `playoff_delta`, `points_delta`, paired seeds | `season-sim.js tradeImpactWorld :945` at 1,200 runs; RB-TITLE planned (r50: SE 0.40x levels, 0.34x paired, no bias) | E3 passing (Brier gain 0.0018 [0.0012, 0.0024], measured brain_report 14:23Z); E3-live needs 40 team-seasons; RL-6-3 nulls | live | L8, L11, screens |
| L4 Tiers + LOVE | blue-chip score 0-100 + 7 labels (192 league-4 players; Nico 90, Chase 83, Bucky 74, A.J. 75; measured PR #375); LOVE tag | #375 PLAYER-SCORE (MERGEABLE; flag `GRIDIRON_PLAYER_SCORE`; with the flag on `adapter.untouchable` = notes UNION Nick's 80+ players, PR body; today notes already cover both 80+ players, so gives of 80+ = 0 with the flag on or off, measured PR body); `campaign/love.js` (night 5) | r51: KILL as validated cutoffs, draft+production cuts week-3 ROS MAE 9-13% -> LABELLED BLEND; it constrains the GET floor and untouchables, never a rank; LOVE graded by a luck-free r52 re-run (night 5) | draft_pr | L8 (constraint), screens |
| L5 Market price + his screen | `player.value` = fc_value (no-overpay currency); `screenFair` window -12..+18 on his side (`paths.js:16-27`, hand-set); his ESPN screen (his-screen.js + `HisScreen.tsx` already on main, measured; #304 extends them); fitted per-shape completion band (#363: 2-for-1 completes at r 1.118-1.699, held-out coverage 75.7%, PR body) | `league-adapter.mjs` (value), `campaign/his-screen.js`, `price-band.js` | #363 coverage 57.4% -> 81.4% uneven trades; RS-07 compares his_pct to ESPN's own view | live + draft_pr | L8, screens |
| L5b His PRICE (new row) | `clone.price` = fc_value x `counterparty-pricing.js playerValuation` multiplier (`league-adapter.mjs:334-338`); e.g. Olave at roster 7 priced 6,182.6 vs fc 5,796 (measured flip_map 14:23Z) | `counterparty-pricing.js` (13 factors carry `fitted: false`, measured grep) | label GUESS; multiplier shown separately from fc_value; grader = realised trade prices vs multiplier from `league_transactions_raw` (league 4 2026: 8 executed TRADE_ACCEPT, measured) | live, ungraded | flip radar, L8 |
| L6 People read | per roster: wants, shopping, untouchables with credibility n, needs, activity, send window, pulse (45 statements), credibility (140 rows); 13 counterpart models in `_run.inputs.counterpart` (measured 14:23Z); ESPN `tradeBlock` present in `leagues.payload` (measured) with no reader on main (inventory-plans C.7) | `people/counterpart.js`, `pulse.js`, `credibility.js`, `partners.js pResponds :61-72` (BASE / CHECKED_OUT caps "hand-set", measured) | PEOPLE-03: chat features weight 0 in P(accept) until E1; PULSE-02 #369 grades the labeller; partner order labelled "activity read (hand-set caps; E1 pending)", never PROVEN | live | L7, L8, Coach |
| L7 P(yes) + P(complete) | one p per step with band, basis, `guess:true`; P(complete) = p_yes x p_survives_review (league 4: 24 h revision window, veto votes required per `leagues.payload tradeSettings`; 2026: 7 TRADE_VETO, 10 TRADE_UPHOLD, 8 TRADE_ACCEPT executed, measured) | `trade-acceptance.js acceptanceBand :142` (centre 0.30 `:92`; every source `fitted:false`), wired at `league-adapter.mjs:290-298` with `edge: {passes: true}`; ALSO called from `trade-engine.js:2351` for Trade Lab / Coach / trade cards (measured) = two callers today; #319 PYES-BASELINE (CONFLICTING) serves the E1 baseline in the War Room path but leaves the second caller (PR body) | E1: "needs 171,590 more offers" at n=37 (`eval/e1.js:69-71, :98, :149-153` = pre-registered `minOffersToDecide()` floor); #319's own split: forward-only WORSE than the clone on league 4 (log loss 0.602 -> 0.666), leave-one-week-out better (PR body) -> night-13 test uses the forward-only split | live, guess | L8, L11 |
| L8 Search + planner | plans.json + his-screens.json: `next_move`, `alternatives`, `targets`, `flip_map`, `catch_up`, `speed_curve`, `itinerary`, `risk_modes`, `_run` | `produce-plans.mjs` -> `planner.js planLeague` -> `search.js searchTarget / flipMap` -> `modes.js rankPlans` -> `confirm.js` -> `plans-schema.js validatePlans` | real path gates: `modes.js:56-84 toleranceViolation` (max_assets, offers per manager-week, `max_give_per_step` 2/2/3, `max_downside_per_step` on the POINT estimate, core, untouchables), `modes.js:96-99` all_in `p_complete >= 0.03`, `confirm.js:39` fresh expected <= 0 -> failed; overpay filter `search.js:302-315`; `verify-warroom.sh` all PASS | live | screens |
| L9 Screens + Coach | War Room cards, REASON-01 panels, Coach text (never a number) | `client/src/components/warroom/*`, `messages.js`, `playbook.js`, `verify.js` | `shoot.mjs`; C8 needs 20 settled claims (n 0, measured) | live | Nick |
| L10 Offer loop (labels) | `trade_outcomes.sent_at`, settled status, `campaign_steps` | write path on main (`trade-outcomes.js:479-493`, `requests.js:163-172`); 94 rows, 0 `sent_at`, `campaign_steps` 0 rows (measured) = no taps yet | settle vs `league_transactions_raw` mapping ACCEPT -> UPHOLD / VETO before the E1 label; #335 STEP-LOG extends E5 | live | L7, L11 |
| L11 Graders + report card | brain_report E1-E7, E3-live, E4-live, E3-ESPN, C8; `number_health`; Balanced fallback | ALREADY on the tick: `refresh-live-data.mjs:32-34` step 6 spawns `scripts/eval/run-graders.mjs` (:377) which calls `runAll` + `writeReport` (run-graders.mjs:48-49) every 15 min; brain-rule: report > 48 h stale forces Balanced (`brain-rule.js:11`) | what is MISSING is source tables: `planner_move_outcomes` and `weekly_autopsy` not in sqlite_master (measured); E4-live "needs 4 more weeks (table not built)", E7 same, E6 "needs 20 more decisions" (measured brain_report 14:23Z) | live | Title Plan, Coach |
| L12 Jev / LLM | chat labels, REASON-01 words, Coach text; never a served number | classifier on the refresh loop; `claude.js` for panels | JEV-01b #289 (CONFLICTING) grades stored signals; r17: LLM persona AUC 0.47 vs activity 0.78 | live | L6, L9 |
| L13 Ops clock (new) | nights-only enforcement; MORNING.md + screenshot; usage gate | RULES.md v3.1 entry night 1: supersedes "NO STOPPING" (RULES.md:61) and "Two lanes, always busy" (:54); auto-intake `intake.pause` on at 06:00 ET, off at 21:00 ET; `~/claude-handoff/usage.sh` before every launch (RULES.md:41 "stop at 94% weekly"); `morning-check.sh` (exists, `~/gridiron-local/bin`) extended, never duplicated | CONVERGE GATE (RULES.md:70): (b) references #216 (CLOSED, measured) + #250 (CONFLICTING); (d) open PRs < 35 vs 114 open today (108 drafts, 47 CONFLICTING, 54 MERGEABLE, 13 UNKNOWN; measured `gh pr list` this pass). This plan SUPERSEDES the gate for its named units and sizes the sweep (nights 10-11) | planned | every night |

Betting-side assets reused for fantasy (facts §11; betting objectives: ignored):

| reused item | where | fantasy number it feeds | status |
|---|---|---|---|
| `game_lines` 15,096 rows 1999-2026, spread / total / implied / weather / rest (measured inventory-data.md:89) | `gamescript.js#gameScriptFor` | team pass/rush attempts -> `projections.js` team volume as a DISTRIBUTION, never the mean | live |
| `nfl_injuries` 28,675 rows 2021-2026 wk 3 (inventory-data.md:50) + injury dialect | `fit-availability.mjs` role rates | `p_play` role cells (L1), P(out) in the radar (L2) | live |
| Regularised APM `player_value_weekly` 436,238 rows (inventory-data.md:210) | `data/derived/player_value.sqlite` | candidate efficiency prior for ROS-USAGE | parked to night 11 |
| `conformal.js`, walk-forward harness, paired seeds, calibration grading | betting harness | #363 bands, r50-r53, E-graders | live |
| Market-anchored grading (CLV pattern) | betting grading | our number vs ESPN / FantasyCalc / FantasyPros-internal (META-01 anchor) | live |
| `nfl-props.js#projectWeek` per-stat distribution, `nfl_prop_clv` (table exists, measured) | betting engine | candidate honest weekly range (NSP row 14) via PROJ-03-c | parked past 12/02 |
| `nfl-team-tendencies.js` PROE / neutral pass rate, `margin-distribution.js` blowout probability | betting engine | the "plan" half of game script for team volume (O1C-WIRE input) | parked to night 11 |
| `jev_presser_signals`, `jev_transaction_signals` (not in data.sqlite's sqlite_master, measured; live in the chat/derived store per ENGINE-SPECS:378) | Jev scripts | typed role / availability inputs for L1/L2/LOVE | shadow only (O3-JEV park) |
| `nfl-drive-sim.js`, prediction-market game odds | betting engine | correlated game-path engine for PROJ-03 | parked |

---

## 3. The data flow

```
refresh-live-data.mjs --loop (ESPN rosters/tx/injuries/news, lines, nflverse usage [growth job repaired night 1], ffopportunity, FantasyCalc daily, chat labels, ESPN as-of poller [night 1])
  -> L1: ESPN point = blend.week (#291); ros-projection.js -> ros_ppg; role cells -> p_play; projections.js chain (game_lines via gamescript.js today; the betting-fantasy-link door becomes real with O1C-WIRE)
  -> L2 O1-RADAR adapter.opportunityOf: 4 validated cells may move ROS / LOVE / flip "why now"; watch flags display only
  -> L4 PLAYER-SCORE label (BLEND) = GET floor + untouchables (notes #373 + 80+ under the flag); LOVE tag = words only
  -> L3 season-sim tradeImpactWorld on the ros basis (BASIS-02) with RB-TITLE -> title_now, title_delta +/- se
  -> L5 fc_value (no-overpay currency) + screenFair + his ESPN screen + #363 band label; L5b his price = fc x multiplier (GUESS)
  -> L6 counterpart wants / shopping / tradeBlock / untouchables / needs / activity / pulse / credibility n
  -> L7 P(yes) one module (E1 baseline in the War Room path AND trade-engine.js:2351), guess:true until E1; P(complete) = p_yes x p_survives_review
  -> L8 produce-plans.mjs: REACH-01 target pool -> searchTarget (1-for-1, 2-for-1, 1-for-2, 3-for-1 direct, ladders) under {no-overpay + min_edge, protect, gets-real, fair, fatigue, deadline - 24 h}
       -> rankPlans by title odds per mode (rank_basis p_guess) -> confirm on fresh dice -> validatePlans -> plans.json + his-screens.json (+ dropped_by_reason)
  -> SCREENS: flip radar | go-get-X (deck + playbook + closest-miss chain) | Title Plan ; Coach reads the same fields
  -> Nick taps "I sent it" -> trade_outcomes.sent_at + campaign_steps -> ESPN ACCEPT -> 24 h review -> UPHOLD/VETO settles vs league_transactions_raw
  -> L11 on every tick (run-graders.mjs): E1/E2 (offers), E5 (steps), E7 (weekly_autopsy, #295), E4-live (planner_move_outcomes, night 7), radar ledger -> brain_report -> brain gate
  -> 06:30 ET: morning-check.sh line + MORNING.md + shoot.mjs screenshot (names-free)
```

---

## 4. Why nothing clears now, and the fix

Live state (measured plans.json generated_at 2026-09-24T14:23:43Z, league 4, me = roster 5; the 14:08Z file the earlier plan quoted no longer exists because the loop rewrites every 15 min, which is why CLEARS-BENCH on a REPRO-01 snapshot moves to night 1): `title_now` 0.005; `next_move` unknown: "None of the 53 paths searched clears the sliders and the fresh-dice check this week. Nothing clears without overpaying; the closest is Deebo Samuel Sr. + Trey McBride for Ashton Jeanty at +1% market value"; `alternatives` empty; all three risk modes "No plan fits this mode"; 5 targets all `p_reach` unknown (roster 10, 2, 10, 7, 1), each `his_side` "There is no read of ..." (5 occurrences); `stop_tradeoffs` unknown; `two_for_one` on under preview, screened 2-for-1 2,412 / 1-for-1 591 / 3-for-1 10, shortlisted 53, `_run.targets` 3, rows: target 134 best +0.000637 (via a 2-side path), target 15 none, target 210 +0.001774; `candidates_scored` 53, `rescores` 397, `runtime_ms` 97,918; 13 counterpart models; `number_health` BROKEN on `projection_basis` (0.78 over 143 rostered players) and `weekly_range` (75.6 vs 41.2, 34.3 pts apart, limit 10). The flip radar is NOT empty: `flip_map` has 10 rows, 6 realised with legs; row 1 = Chris Olave (290) bought from roster 7, sold to roster 1, spread 0.0483 title odds, SE 0.015, `clears_2se` true, prices 6,182.6 / 5,848.4 from `clone.price`, and the realised buy leg is a 2-for-1 give under the 0 cap (Bucky Irving 379 + Jadarian Price 367 = 5,366 fc, inside [0.88, 1.00] x 5,796). So an Olave-class 2-for-1 already exists on screen 1; the Go-get-X deck misses it because Olave is target #4 and `budget.targets` = 3.

What is NOT a cause: there is no "title delta must clear 2 SE" step gate (`clears` is a badge, `view.js:153-164`, and filters only flip-leg realisation, `search.js:192`; no gate in `planner.js` or `modes.js` reads it, measured grep). And there is no roster discrepancy: `league_roster_snapshots` period 3 has 21 rows but `SUM(on_roster)` = 18 (measured), the 3 extra rows are `on_roster = 0` (the two players roster 5 sent to roster 2 in the 9/23 executed trade, measured `league_transactions_raw` TRADE_ACCEPT EXECUTED processed 2026-09-23, plus one departed player); the producer's `_run.roster_key` for team 5 is exactly those 18. The table is a per-period ledger; the one roster producer is the trade-engine asset universe (`league-adapter.mjs:241`). ROSTER-ONE is dropped; a one-line number_health check "snapshot on_roster=1 set == producer roster" replaces it (night 1, FRESH-01).

Six real causes, in order of size:

1. REACH ARITHMETIC (measured fc_value 08:57Z). A step must read fair on his screen (`paths.js:16`: Nick's give in [0.88v, 1.18v] of his get) AND not overpay (give <= get): Nick's give lands in [0.88v, 1.00v]. With 160 and 80 locked and 277 held out (until decision 3), Nick's tradable currency: Bucky 3,583, Etienne 1,920, Kelce 1,910, Price 1,783, Deebo 743, Vele 637, the backup QB 637, J. Johnson 615, Stroud 366, Charbonnet 286, A. Williams 134, Raymond 19. Best 2-give 5,503 (Bucky + Etienne); best 3-give 7,413 (+ Kelce). Targets: Bijan 9,722 needs >= 8,555: unreachable; Taylor 9,018 needs >= 7,936: unreachable (even with A.J. Brown at 2,339: 7,842 < 7,936); St. Brown 8,819 needs >= 7,761: only Bucky + A.J. + Etienne 7,842 (3-for-1, Fuck-it only, and only if A.J. Brown is priced and released per decision 3); Jeanty 6,791 needs >= 5,976: Bucky + Etienne + Kelce 7,413 or Bucky + Etienne + Deebo 6,246 (3-for-1, Fuck-it only since Balanced `max_give_per_step` = 2, `modes.js:32`); Olave 5,796 needs >= 5,100: Bucky + Etienne 5,503 or Bucky + Price 5,366 (2-for-1, Balanced). The 1-for-2 shape (target + a filler from his roster for ONE of Nick's, `search.js:337-345`, fillers 4) exists but cannot reach any of the five: Nick's biggest single tradable piece is 3,583, so 1-for-2 reaches gets of at most 4,071 total. The closest miss is a CHAIN: McBride (id 7, fc 6,166) sits on roster 9, not roster 10; Bucky + Etienne 5,503 >= 0.88 x 6,166 = 5,426 reaches him (2-for-1, Balanced), then Deebo + McBride 6,909 for Jeanty 6,791 overpays by 1.7% -> rejected at cap 0 (`search.js:296 stepsFrom` reads the chained state's roster). The card will print that chain. The producer searched targets 134, 15, 210 (measured `two_for_one.rows`): two of three out of reach by arithmetic, and the in-cap paths carry +0.0006 and +0.0018 against flip-row SEs of ~0.015 (measured).
2. SEARCH SHAPE. `planner.js:105 budget.targets = 3` (a CLI / loop setting: `produce-plans.mjs:73 [--targets 3]`, launched from `refresh-live-data.mjs:244` with `GRIDIRON_WARROOM_LEAGUES` :249; RULES.md:72 unit-scoping means the caller ships with the change); shortlists [8, 12, 8] with the top 6 prefixes (`search.js:378-393`). The DIRECT finish already allows 3 gives (`search.js:282 maxGiveFinal = 3`; `:352 stepsFrom(new Map(), owner, target, maxGiveFinal)`; 10 3-for-1s screened this run); only the CHAINED finish is capped at 2 (`:369`) and `flipReach` packages only the top 2 (`:122-123`). Balanced drops 3-gives via `max_give_per_step` 2, but all_in allows 3 and STILL found no plan, so widening the finish leg is not what unlocks a Fuck-it 3-for-1 card; the reason those 10 died (tolerance / overpay / p_complete < 0.03 / confirm) is unknown until `dropped_by_reason` prints. That is REACH-01's first deliverable.
3. BASIS. The title sim prices players on last season's shape (`season-sim.js:341-345` comment; `asofScale :436`), the finder on this season's ros_ppg (number_health text). RL17-3 is ALREADY on under preview (`season-sim.js:363 rosBasisFlag`) and the check is still broken, so BASIS-02 edits the scale path, not a flag.
4. RESOLUTION. `title_now` 0.5% at 1,200 runs is ~6 title wins; per-step deltas of 0.5-2 pp sit inside noise, so `max_downside_per_step 0.01` (`modes.js:70-72`, point estimate) drops chip steps whose true value is 0, and `confirm.js:39` fails decks whose fresh expected <= 0. RB-TITLE (r50: paired SE 0.34x) shrinks exactly that noise.
5. P(YES) IS A GUESS and Fuck-it has a hard floor. Every step p is `acceptanceBand`'s midpoint with edge assumed passed (`league-adapter.mjs:290-298`), centre 0.30 (`trade-acceptance.js:92`); `pathExpectation` multiplies p across steps, so a 2-step ladder scores ~0.09 x its delta; in all_in a 3-step ladder has `p_complete` 0.027 < `ALL_IN_MIN_COMPLETE` 0.03 (`modes.js:25, :96-99`) and is ineligible regardless of value. LADDER-01 must design around this (label p per rung; Fuck-it ladders capped at 2 steps until E1 moves p).
6. TWO CALLERS OF P(YES). `league-adapter.mjs:290-298` (War Room) and `trade-engine.js:2351` (Trade Lab / Coach / trade cards) both call `acceptanceBand`; #319 replaces only the first (PR body). PYES-ONE (night 3) makes both read one module.

The fix, in the order it pays: (A) night 1 REACH-01: `dropped_by_reason` first (aggregate `planner.js:333 no_overpay.rejected`, `:337 dropped[].why`, confirm 'failed', all_in `p_complete` floor into `_run`; a 10-line aggregation of numbers the planner already returns), then the reach filter before the top-N slice (`fairBand(value).lo <= reach package` for the mode's max give), `--targets 8` in the loop launch, chained finish + `flipReach` package to `tol.max_give_per_step`, GETS-REAL floor, closest-miss chain printed. This puts the Olave-class card on the deck without touching any served number. (B) night 2 BASIS-02 + RB-TITLE. (C) night 3 P(yes) one module + his side + his screen + P(complete). (D) night 5 tiers, LOVE tag, ladders, A.J. Brown healthy value. (E) nights 4 and 7 the offer loop and source tables. (F) night 6 breadth. If after (A)-(B) zero paths clear, the card says so with the counts and the chain; that is a result about Nick's roster under his rules, and decision 1 is where the gap closes.

---

## 4b. Broken variables and the repair for each (column-level sweep, inventory-variables.md: 238 tables, 4,252 variables)

Calendar note first: the sweep assumed NFL week 3 was final (it read `leagues.current_week = 3`). Week 3 plays Thu 9/24 to Mon 9/28, so every "no week-3 rows" flag on a stats table is EXPECTED today. The real risk is that week 3 will not land on Tue 9/29 unless the growth job is repaired (D1). Verdict counts: OK 2,476; by-design 811; empty-table columns 731 (58 empty tables); EMPTY 68; MOSTLY-EMPTY 108; STALE 32; PLACEHOLDER 11; CONSTANT 8; BROKEN-KEY 3; DUP-KEY 3; MIXED-FORMAT 1. The ones that touch a served number:

| # | table.column | flag | what it feeds | repair (or parked reason) | when |
|---|---|---|---|---|---|
| 1 | league_draft_picks.player_id | BROKEN-KEY: it is the ESPN id (0/1,738 join players.id; 1,738/1,738 join players.espn_id; Nick's 17 picks 17/17 by espn_id) | draft capital -> tiers, LOVE, drafting-style archetypes (which currently join on players.id and see nothing) | join on players.espn_id in DRAFT-ID-MAP and in manager-archetypes draft metrics | night 5 (with DRAFT-ID-MAP) |
| 2 | nfl_snaps.player (name-keyed, 93% of 2026 skill rows) | BROKEN-KEY | volume, O-line continuity | carry gsis/pfr ids from nflverse snap_counts and join on gsis | night 11 (O1C-WIRE inputs) |
| 3 | nfl_pfr_adv.player_name (name-keyed, 91%) + 2026 week 2 partial (49 of ~740 rows) | BROKEN-KEY + STALE | efficiency prior | re-run the nfl_pfr_adv job for 2026 week 2 tonight; pfr -> gsis crosswalk with #2 | night 1 (re-run); night 11 (crosswalk) |
| 4 | player_week_usage / snaps / xFP / pbp features / charting / NGS / QBR (all end 2026 week 2) | expected today; STALE from Tue 9/29 if nfl_model_growth keeps dying at its 120 s budget (12 straight) | every projection, the radar, LOVE, tiers | D1: hand-run the nflverse growth jobs after Monday night; raise/skip the 120 s worker budget for this job; FRESH-01 row shows max(week) | night 1 (fix), night 6 (check max(week) = 3) |
| 5 | players.espn_id = 0 on 2,884 historical rows | PLACEHOLDER: any join on espn_id = 0 fans out 2,884 ways | the join key for everything | write NULL for unknown ESPN ids; add a guard in the loader | night 1 (10 min) |
| 6 | players.bye_week (8,640/8,640 NULL) | EMPTY | bye alignment for itinerary stops (block 4), lineup holes | populate from schedule_games (32 teams x 18 weeks present) | night 1 (10 min) |
| 7 | league_week_scores.points = 0 for weeks 3-14 (pre-created) | PLACEHOLDER: zeros read as real by the luck panel / posture calibration | luck lines, autopsy inputs | league_history job writes NULL for unplayed weeks; re-pull after each week's finals | night 1 |
| 8 | manager_signals.value = 0 where n = 0 (141 rows; tx_* metrics for 25-41 of 46 rosters) | PLACEHOLDER: counterparty pricing reads "never trades" from "no data" | P(yes), partner order, his side | write NULL when n = 0; readers treat NULL as unknown | night 3 (HIS-SIDE-WIRE) |
| 9 | people_credibility.status = 'unknown' for 86/140 (n_statements 0, weight NULL) | sentinel, by design | brief claims weighting | keep; verify the reader gives unknown zero weight (it does per PEOPLE-03); no repair | night 3 (check) |
| 10 | dynasty_value_history: one day (2026-09-24) | CONSTANT | flip radar "why now" trend (fc_trend30) | DATA-FC #336 appends daily; trend served only when >= 7 days exist (label until then) | night 1 (merge), night 8 (trend) |
| 11 | espn_player_market_weekly: one capture (week 2), week_actual never written | CONSTANT + EMPTY | crowd demand (IDEA-114), ESPN as-of grading (META-01b) | META-01b poller on the refresh loop from tonight; week_actual written by the Tuesday settle step | night 1 (poller), night 7 (settle) |
| 12 | nfl_injuries.modified_at NULL for all 2025-26 rows (upstream dropped it) | EMPTY | point-in-time replay of availability | stamp from the capture time in the loader (fetched_at) | night 4 |
| 13 | news_items Claude columns (ai_analysis, fantasy_impact, confidence, ...) 100% empty | EMPTY (dead design) | none: the typed extraction (nfl_news_signals) replaced them | leave; D2 (the 401 key) is the live repair | night 1 (D2, Nick) |
| 14 | trade_outcomes.sent_at / counter_json / price_band never written (94 rows) | EMPTY | E1/E2/E5 labels | written by the "I sent it" tap path (exists on main); copy-DB tap test proves it | night 4 |
| 15 | nfl_team_week_features drive_turnover_rate 60% zeros (all seasons); scrambles dead (6 non-zero rows ever) | PLACEHOLDER | game-script distribution (block 1) | fix the turnover counter before O1C-WIRE reads it; drop scrambles | night 11 |
| 16 | nflverse.sqlite mirror: 2026-09-17 snapshot (week 1 only); NGS tables 44% duplicated (2016-23 double load); depth_charts ends 2024; participation ends 2025 (404 upstream) | STALE + DUP-KEY | history studies only (the app tables pull nflverse directly and are ahead of it) | re-run nflverse_backfill.py for 2026 with INSERT OR REPLACE on the natural key, on a quiet night; participation parked (licence / 404) | night 4 or the Tuesday R&D night |
| 17 | chat messages.ts_utc mixed 'Z' suffix (15,763 without, 961 with) | MIXED-FORMAT | JEV signal timing, pulse as_of | normalise on write in the extractor; one-off backfill | night 1 (5 min) |
| 18 | nfl_feature_revisions.valid_from never set; only one feature tracked | EMPTY | feature-store replay (study) | parked with the feature store v2 (study code) | parked |
| 19 | 58 empty tables: off_* (12), draft capture (8), news events / source validation / beat-reporter (5), press_* (2), negotiation_threads/events, campaign_steps, rec_ledger, decision_basis, trade_outcomes_synthetic, nfl_officials, pick_values, participation, cfbd, tweet watch | EMPTY-TABLE | none today | campaign_steps + negotiation_* fill on use (night 4 tap test); nfl_officials loadable from the mirror (22,012 rows) on a quiet night; the rest parked (off-season, licence, no key, or replaced) | night 4 / parked |

Joins that are fine (measured): league_roster_snapshots, player_week_usage, dynasty_values, weekly_prediction_snapshots, player_season_stats, nfl_news_signals all 100% on players.id; gsis-keyed tables 98-100% for skill positions; people_pulse player ids are ESPN ids (100%); chat identities 9/10 for league 4 (the 10th is Nick); manager_signals roster ids 100%. Rostered-player coverage (170 skill players across the 5 leagues): FantasyCalc 167, usage week 2 149, xFP 148, depth 168, ESPN market 170.

---

## 4c. Trade memory (added 11:1x after Nick: "look at my previous trades, why would I get Olave back for more")

Measured from league_transactions_raw (league 4, 2026, executed):
- 9/17: Nick gave Jonathan Taylor (fc 9,018) + two bench WRs for A.J. Brown (2,339 today, hurt) + Ladd McConkey (2,600) + Zach Charbonnet (286) from roster 1.
- 9/17: Nick gave Josh Downs + Bhayshul Tuten (2,277) for Jadarian Price (1,783) from roster 10.
- 9/17: Nick gave Emeka Egbuka (2,373) + Quentin Johnston + Harold Fannin + Kyle Monangai for Bucky Irving (3,583) + Travis Kelce (1,910) + Deebo Samuel (743) from roster 10.
- 9/17: Nick gave Chris Olave (5,796) 1-for-1 for Chase Brown (5,705) from roster 7.
- 9/23: Nick gave De'Von Achane (5,446) + Ladd McConkey (2,600) for Nico Collins (4,670) + Travis Etienne (1,920) from roster 2.

What this says about the Olave card: the planner proposed buying Olave back from roster 7 for Bucky + Etienne (5,503) one week after Nick sold him 1-for-1 for Chase Brown. That is a reversal Nick would never make and roster 7 would never accept: he paid a 5,705 RB for Olave, so his ask is anchored at what he paid, not at the 6,182 the multiplier guesses; and he sold an RB away to get a WR, so two RBs is the wrong currency for him. The planner has no memory of Nick's own trades and no acquisition-cost anchor for the counterparty. Both are fixed on night 1:

- TRADE-MEMORY (night 1, inside REACH-01): (a) a player Nick gave away in the last 4 weeks is excluded from targets unless his market value fell 10%+ since (then the card says "buy-back: price fell from X to Y"); (b) every counterparty's price for a player he acquired this season has a FLOOR at what he paid (fc of what he gave), and his "currency" is read from what he gave up (roster 7 sold an RB for a WR: he wants WRs, not RBs); (c) the offer text never proposes a reversal of a trade either side made this season. Check: Olave-for-RBs no longer appears; `_run.dropped_by_reason.trade_memory` prints the count.
- HIS-SIDE-WIRE (night 3) reads the same ledger: "roster 7 bought Olave for Chase Brown on 9/17; he sells WRs only for value above 5,705" on the target card.
- The AI negotiator (section 11, night 3+) is given the full transaction ledger (this league's 182 trade rows + the 24,873-transaction corpus) so its reply prediction and pitch account for what each manager just did.


## 4d. v3: research-backed changes (25 web reports + our data; spot-checked below)

What changes, by night (additions to section 5; nothing already promised is removed):
- Night 1 (Thu 9/24): negotiator defaults: defensible anchor, two genuine packages, firm plain wording, one-line "why this helps you", expiry on every offer, auto-withdraw on material news, DM/interest before a formal proposal; DROP door-in-the-face and fake scarcity; replace the "Monday tilt window" with "cool-off, then a fair offer". Explicit "no trade" row in every mode.
- Night 2 (Fri 9/25): RB-TITLE (conditional Monte Carlo) as planned; ADD importance sampling for Nick-title paths (IS-TITLE) because 1,200 runs cannot resolve a 0.1-0.5% title chance; pre-rank shrinkage of gains (optimizer's curse) on top of fresh-dice confirm.
- Night 3 (Sat 9/26): P(yes) = pooled Bayesian activity prior per manager (not LLM personas); log rejected / countered / expired offers; risk rule per mode (Safe = worst case, Balanced = minimax regret, Fuck-it = expected title odds).
- Night 5 (Mon 9/28): LOVE = target SHARE (sticky, r 0.82 in our data) + actual AND expected points + draft capital + health; TD-over-expected as the sell-high label (79% of 10+ TD seasons regress in our data).
- Night 7 (Wed 9/30): bitemporal inputs (event_time + availability_time) on the tables that feed decisions; reconcile standings with ESPN's official record.
- Block 1 (weeks 4-5): shared game shocks in the copula (tail dependence); replacement priced locally (next flex / the specific free agent); three-way cycle search when bilateral swaps fail; bye-rescue for the week-11 six-team bye cluster.
- R&D nights: pre-registered replication of the "XGBoost beats ESPN by 5.4%" claim on frozen pre-kickoff projections; FantasyFootballBench-style LLM league as a stress test for the deck and negotiator only.
- Waivers: priority resets weekly (measured), so it is perishable: claim real upgrades before the reset; handcuffs only after a workload test.

## Spot-check: what the research says vs what our data and code say (2026-09-24, coordinator, measured)
| # | Research claim (source) | Our data / code | Verdict | Plan effect |
|---|---|---|---|---|
| 1 | 10+ TD seasons regress next year: 81%, -4.8 TD (R1, ESPN 2012-24) | nflverse 2016-2025: 137 of 174 dropped (79%), mean -4.4 | CONFIRMED | TD-over-expected = sell-high filter (label, value weight 0) |
| 2 | WR target share is sticky, ~0.70 y/y (V3) | player_week_usage 2021-25 WR/TE, >=8 games: r = 0.82 (n = 679); raw targets r = 0.50 | CONFIRMED (stronger on share than volume) | target SHARE is the LOVE usage input, not raw targets |
| 3 | Pricing trades as paired title-odds changes from full sims is best practice (V1/E1/E4) | season-sim tradeImpactWorld, paired keyedSeed | CONFIRMED (we do it) | keep |
| 4 | Gaussian copula has no tail dependence (E1) | correlation.js:20 "Gaussian copula" via Cholesky | CONFIRMED gap | add shared game shocks (block 1) |
| 5 | At ~0.1-0.5% title odds you need 100k+ runs or variance reduction (E4) | 1,200 runs per rescore (trade-verify.js:135), 2,000 default; Nick title 0.000-0.005 served | CONFIRMED gap (the biggest) | RB-TITLE night 2 + importance sampling IS-TITLE |
| 6 | Optimizer's curse: re-evaluate on fresh samples + shrink (E2) | confirm.js re-prices on fresh dice (shrink measured and shown); no shrinkage BEFORE ranking; no explicit do-nothing option in planner/modes (grep 0 hits) | PARTIAL | add pre-rank shrinkage + an explicit "no trade" row per mode |
| 7 | ESPN standard: 4 of 10 vetoes, 48 h review (R1/R11) | league 4 payload: vetoVotesRequired 5, revisionHours 24 | DIFFERENT (ours is stricter to veto, shorter window) | veto sim uses 5 / 24 h |
| 8 | ESPN default deadline Week 11 Wednesday (R1) | deadlineDate 1796230800000 = Wed 12/02 (week 13) | DIFFERENT | deadline mode keyed to 12/02 |
| 9 | Weekly reverse-standings waiver reset makes priority perishable (R10) | waiverOrderReset = 1 (weekly) | CONFIRMED | claim real upgrades before the reset; lever corrected |
| 10 | Week 11 is the 6-team bye cluster, week 12 none (R5) | schedule_games: week 11 = 6 byes, week 12 = 0 | CONFIRMED | bye-rescue lever targets week 11 |
| 11 | Nico Collins hamstring (missed wk 2); the Washington QB elbow 5-6 wks; A.J. Brown 4-6 wks (R5) | nfl_injuries: Nico wk2 Out, wk3 Wed DNP; the Washington QB wk3 DNP elbow; A.J. on IR | CONFIRMED | Nico at risk this week; QB2 sell and A.J. healthy value are weeks out |
| 12 | Position XGBoost beat ESPN by 5.4% MAE on 2025 (E3, one project) | our META-01: errors correlate 0.87-0.92 with ESPN; BLEND-01: ESPN 0.683 beat ours 0.636 | CONFLICT (their single retrospective vs our held-out tests) | pre-registered replication on frozen pre-kickoff ESPN; ESPN stays the served point |
| 13 | Previous actual PPG predicts next season better than previous expected points (26.8% vs 20.9%, V3) | AI-01 #376: opportunity-based ROS beat points-based only at week 3; served ROS best | CONSISTENT | LOVE uses actual AND expected; usage matters most early |
| 14 | No evidence who wins 2-for-1s on average; shallow leagues favour consolidation (V6) | #363: real 2-for-1s complete when the 2-player side gives 12-70% more | CONSISTENT (ours adds the acceptance premium) | decision 1: allow consolidation where the lineup math says so |
| 15 | Market prices lag breaking news; FantasyCalc ~3 h, KTC 10 min (V2/V8/R9) | dynasty_value_history: 1 day stored; FantasyCalc synced daily (#336 pending) | UNTESTABLE yet | store daily history (#336) before any lag claim |
| 16 | LLM personas are exploitable / do not predict acceptance (R3/E3) | r17: LLM persona AUC 0.47 vs activity 0.78 | CONFIRMED | activity baseline for P(yes); LLM for words only |
| 17 | Reply latency signals the answer (R3, eBay) | chat has timestamps (latency measurable); 0 settled offers with sent_at | UNTESTABLE yet | log sent_at; build latency model as offers accrue |
| 18 | Firm wording, two genuine packages, defensible anchors raise acceptance (R7/E5) | 0 graded offers of our own | UNTESTABLE locally (external evidence only) | negotiator defaults; graded by lever tags |


## 5. The nightly build plan (21:00-06:00 ET; every night: `usage.sh` gate, load < 12, `df` >= 12 GB, ONE local fit under `nice -n 10`, MORNING.md + `shoot.mjs` screenshot by 06:30 ET; cloud agents code; Sunday and Monday game nights light)

Hour budget per night (guess): 0-1 h repairs/merges, 1-4 h the one build, 4-5 h producer run + checks, 5-6 h morning artifact. Drop order: the night's build ships its FIRST deliverable by 03:00 or the rest slips to the next night; merges never slip a gate change.

| night | date | units | unlocks on screen | how we know |
|---|---|---|---|---|
| 1 | Thu 9/24 (TNF wk 3 tonight) | ITEM 0 REPAIRS (~1.5 h): D1 hand-run the nflverse growth jobs + raise/skip the 120 s worker budget for `nfl_model_growth` so week 3 lands Tuesday; D2 news key: Nick replaces the .env key (only he enters credentials), the loop picks it up; D3 relabel the 6 chat messages after D2; D4 list the ~8 GB duplicate DB copies to MORNING.md and delete only the dead worktree/R&D copies named there; D5 FantasyCalc credit link; FRESH-01 per-table freshness rows + "snapshot on_roster=1 == producer roster" in `number_health`; META-01b: the ESPN as-of poller on the refresh loop (10 min on game days). RULES.md v3.1: nights only; NO STOPPING and Two lanes superseded; intake clock. MERGES (~1.5 h): #308 PRODUCER-FAST, #336 DATA-FC, #291 BROKEN-G, #375 PLAYER-SCORE (only after the `no-fantasypros-per-player-data` suite passes and a grep of served fields finds 0 FantasyPros strings; flag preview). REPRO-REBASE (cloud): #366, merge if CI green; CLEARS-BENCH baseline recorded tonight on a `--db-snapshot` with tonight's code (or "no baseline" printed). REACH-01 (cloud, ~3 h guess) in this order: (1) `_run.dropped_by_reason`; (2) reach filter before the top-N slice; (3) `--targets 8` in `refresh-live-data.mjs:244` + `produce-plans.mjs:73`; (4) chained finish + flipReach to the mode's max give; (5) GETS-REAL floor; (6) closest-miss chain in the card. One `produce-plans --leagues 4` (97.9 s alone measured 14:23Z; 2,221 s under load). | Fri 06:30 ET MORNING.md + screenshot: a Go-get-X deck with >= 1 real-player card (Olave-class 2-for-1 in Balanced: give <= get, no untouchable, tier label on every player, message + walk-away + reply table) or the honest card: dropped-by-reason counts per mode + the McBride chain | plans.json league 4 `next_move.status ok` with every step `overpay_pct <= 0`, 0 gives in `untouchable.ids`, final get label >= floor; else `_run.dropped_by_reason` printed for balanced AND all_in; `_run.targets` 8; `verify-warroom.sh` PASS; 0 FantasyPros strings served; FRESH-01 rows present; poller file non-empty by Friday |
| 2 | Fri 9/25 | BASIS-02 (cloud + one local check): sim prices on ros_ppg (`season-sim.js:436 asofScale`, `:467 simPlayerMeans`); RL-6-3 nulls pass. RB-TITLE (cloud, `season-sim.js:251 playBracket`, flag `GRIDIRON_RB_TITLE`); the night's one local fit = r50 harness SE ratio. CLEARS-BENCH script (fixed seed + snapshot: candidates / dropped by reason / confirm survivors) run before and after every merge from now on. E1-BAR: `e1.js` headline "n=37 of <floor>" with the coin-flip flag; if the floor changes it is a NEW registration (date, reason) and the old bar's result is kept beside it. | title_now with ~2.5x tighter SE; fewer spurious `max_downside` drops and confirm failures; a report-card E1 bar with a date | `projection_basis` >= 0.9; median SE ratio <= 0.5 levels / <= 0.45 paired with bias under the r50 gate; CLEARS-BENCH survivors and dropped counts printed (comparable to night 1 only if the snapshot is the same); E1 result matches `n=\d+ of \d+` |
| 3 | Sat 9/26 | Rebase + merge #304 HIS-SCREEN (what it ADDS on top of main's his-screen.js / HisScreen.tsx: any offer as the partner sees it, routes/trades.js) and #319 PYES-BASELINE. PYES-ONE: `trade-engine.js:2351` reads the same p-yes module; `view.js` / `plans-schema.js` SOURCE_IDS label "activity baseline (E1 pending)"; card notes that ladder rungs differ by Nick's gain, not P(yes), until E1. #363 PRICE-BAND-02 merged as a LABEL: "real 2-for-1s complete at r >= 1.118"; a 2-for-1 at give/get 0.88-1.00 shows P(yes) "below the fitted band" beside the 0.30 midpoint. P-COMPLETE: p_yes x p_survives_review (guess from the league's 10 uphold / 7 veto record); `send_by` = deadline - 24 h - his send window. HIS-SIDE-WIRE: `targets[].his_side` from the 13 counterpart models + pulse + credibility n + needs + TM-10 `tradeBlock` reader (new, `leagues.payload`). REACH-ORDER: partners by activity read, labelled "hand-set caps; E1 pending", then gain. | every target says what roster N needs / shops / blocks with n; every step shows P(yes) with basis, the band label, fair-on-HIS-screen %, and P(complete) | `his_side.status ok` 5/5; served `p_yes` equals the E1 baseline row by row in BOTH callers (grep `acceptanceBand` callers = the one module); `his-screens.json` has a row per deck step; `send_by` < 2026-12-01T17:00Z on every step |
| 4 | Sun 9/27 (game day, light, no local fit) | Merge #335 STEP-LOG, #296 M7-TIMING, #295 AUTOPSY-01, #256 HEALTH-01d+e (chaos drills + daily Coach canary on the daemon morning hook), #365 newest-note-wins, #280 BROKEN-H (all MERGEABLE). Close #251 PROJ-04-a (its luck split is a reporting input under META-01f, ENGINE-SPECS.md:162); #295 is the one `weekly_autopsy` producer. Copy-DB tap test on a snapshot: "I sent it" -> `trade_outcomes.sent_at` 0 -> 1, `campaign_steps` 0 -> 1; settle path maps ACCEPT -> UPHOLD / VETO. | tapping "I sent it" is recorded and graded; chaos: producer failure keeps the previous plans.json (`produce-plans.mjs:284`), daemon down -> report card says stale | counts 0 -> 1 on the copy; a synced decline settles with `resolved_at`; a vetoed accept settles as not-landed; grep shows no code path sends to ESPN |
| 5 | Mon 9/28 (MNF; one local fit) | DRAFT-ID-MAP: join `league_draft_picks.player_id -> players.espn_id` (170/170; `team_id` IS the drafting roster id, 10 ids x 17 picks measured; `players.id` join = 0); draft capital = `overall_pick` per player, owner-independent; current owner from the producer roster. LOVE-RULE (`campaign/love.js`): TAG only: BUY / PASS / AVOID from ffopportunity expected points ("usage through week N"), draft capital, healthy role (role cells + radar flags); luck as one SENTENCE, weight 0. The fit: r52's harness WITHOUT the luck regressor (r52-DRAFT-VS-LUCK.md:25-26 includes LUCK in X); the tag carries that held-out hit rate or "ungraded". LADDER-01: chained finish may spend the acquired piece with the mode's max give; backup branch at each "no"; Fuck-it ladders capped at 2 steps while p is the 0.30 guess (floor 0.03). AJ-HEALTHY: 277 valued on the GIVE side at a declared healthy value (pre-injury fc_value, GUESS until decision 3) in `overpayPct` and reach; final get fc_value >= that value and label >= Blue chip; until coded 277 stays untouchable. | Blue chips board ("blend, not validated"); LOVE tag on every target / flip / deck card; ladder cards depth -> level-below -> blue chip with P(yes) per step and the backup | 170/170 joined; McLaurin BUY and London PASS reproduce from usage + draft + role; Rice carries the luck sentence and whatever tag the luck-free rule gives, printed with the CI; 0 final-leg gets below the floor; 0 steps give 277 below its healthy value |
| 6 | Tue 9/29 (week-3 usage lands; first morning-check with FRESH-01 max(week) = 3) | SEARCH-WIDE: node budget on the PRODUCER-FAST cache, depth 3, lateral depth-for-depth only when the path ends at the tier floor, claims as steps (free-agent ros_ppg beats the given piece); #258 CHESS-01a closed and folded in (ONE-PLANNER). Cost measured first: 397 rescores in 97.9 s cold (14:23Z) = ~250 ms each, so 2,000 fresh rescores ~8 min cold (guess); #308's 6.3 s warm is cache HITS on an unchanged world. MODES check: Safe / Balanced / Fuck-it differ on the same dice. | "paths searched" in the thousands; a deck of >= 3 alternatives or the cost card; risk modes that differ | `candidates_scored` >= 2,000 within the tick budget printed (target <= 10 min cold, guess); same-seed best not below night 5; `validatePlans` ok; `risk_modes[].first_step` differs |
| 7 | Wed 9/30 | SOURCE-TABLES (the graders already run every tick; only their inputs are missing): `planner_move_outcomes` producer (weekly row: served move, finder best, do-nothing, re-priced on paired seeds) as a loop step before step 6; `weekly_autopsy` first rows (week 3 back-filled by #295); Tuesday settle step for offers; WEEKLY-RANGE-ONE started: rebase BROKEN-D/E/F/Q (#283/#285/#292/#286), pick the season-sim lineup sampler as the one producer of the lineup-week range (guess; the other three read it). MORNING-CHECK: add the CLEARS-BENCH line + grader-row counts to `morning-check.sh` (one script); hang the summary on #256's daemon hook; quarantine `warroom-coach-brief.test.js` (load-flaky, facts §8) to its own line. | report card reads "E4-live needs 3 more weeks" instead of "table not built"; number health lists which sampler wins | rows in both tables by the first tick after 06:30 ET Wed; `brain_report.as_of` within 30 min of now; morning line PASS |
| 8 | Thu 10/1 (TNF wk 4) | Fix the train/serve P(out) mismatch (0.506 vs 0.496), then merge #377 O1-RADAR flag preview. RADAR-WIRE: flip rows "why now" = validated cell (n, CI) or `fc_trend30` (a new adapter field + schema entry: `player_metrics fc_trend30` is read by `routes/rankings.js`, `aggregates.js`, `players.js` but not by the campaign adapter, measured) or a 48 h news contradiction (only once D2 is fixed; else "news dead" printed) -> "check first". RADAR-GRADE ledger graded at +2 weeks. | flip rows say why now with n / CI or "watch"; LOVE tags react to role events | byte-diff of plans.json flag off vs on differs only in why-now / LOVE fields (LOVE is a tag, so this holds); ledger rows with `as_of` for every served flag |
| 9 | Fri 10/2 | Rebase + merge #288 CLONE v2 (flag off; logged `p_yes_challenger`; VETO-01 inside it stays `fitted:false`), #369 PULSE-02 (grading only), #248 JEV-01a (shadow stage), #249 COACH-01a; cap `counterparty-pricing.js:103 outscoring_usage` toward 0, label "tested: not supported (r52)". COACH-FIELDS: Coach tools read plans.json fields only with provenance labels; rebase #310 COACH-LINK; 20 scripted questions. | E1 shows baseline vs clone with n; Coach answers "how do I get X" with the path, P(yes) + basis, his side, what to say, cost, report-card status | E1 two rows n >= 37; plans.json byte-identical with the clone flag off; 20 answers with 0 uncited numbers |
| 10 | Sat 10/3 | BENCHMARKS.md rows with commands (SE ratio, CLEARS-BENCH survivors, candidates, number_health broken count, band coverage, LOVE hit rate, runtime); merge queue refuses regressions. NAMES-LEAK test: the 14:23Z file carries manager-name strings in `flip_map` (3) and `next_move` (3) text (measured; `targets` and `catch_up` 0 in that file; `view.js:150` template can print a team label): every text field + shoot.mjs of the targets panel; push-handoff denylist. OPEN-PR SWEEP part 1 (cloud, ~2 h per 40 PRs guess): every draft not in section 6 or 7 closes with one line "absorbed by X / parked: reason". | week-5 morning brief driven entirely by the loop | morning-check PASS 3 consecutive ticks; open PRs 114 -> <= 70; 0 name hits in plans.json text fields |
| 11 | Sun 10/4 - Sat 10/10 (NFL wk 4 ends Mon 10/5; wk 5 10/8-10/12; first full Tuesday grade Tue 10/6 06:30 ET) | O1C-WIRE: validated cells into `projections.js` share / team volume through `betting-fantasy-link.js` (the door becomes real), behind a flag; PRE: beats ESPN on the same player-weeks (needs the as-of poller rows from night 1) before the served weekly number moves, else ROS / LOVE / flip only. VOL-K: `promote-volume-shrinkage.mjs --dry-run`, 5 gates, one local run. ROS-USAGE: usage features INTO `ros-projection.js`, 12-check gate. Apply decision 1 if chosen. OPEN-PR SWEEP part 2 to < 35 (RULES.md:70 (d) reachable only after both parts). | "real value moved, his price has not" flip rows on validated events; ROS with usage where it passes | O1C gate table in the PR; ros gate 12/12; `blend.week` byte-identical (`blend-week.js`); BENCHMARKS hold; open PRs < 35 |
| 12 | Sun 10/11 - Sat 10/17 (wk 6) | E4-live first number from `planner_move_outcomes` (reported with n, never a gate before n allows); SEARCH-WIDE v2; rebase #290 UI-ENG-5 stepper; #293 PUSH-01 on; #284 SELF-01b (E6's producer: follow / ignore ledger from the skip log + taps) rebased; #257 / #259 EA-03/04 merged only where SOURCE-TABLES left a gap, else closed as absorbed. | chess stepper over the one planner's path; E4-live and E6 with numbers | E4-live n >= 2 weeks; E6 n > 0; grep `findTradeSequences` served callers = 0 |
| 13 | Sun 10/18 - Sat 10/24 (wk 7) | P(yes) decision point at ~50 settled 2026 offers: promote the clone ONLY if E1's anytime-valid CS > 0 vs the baseline on the FORWARD-ONLY (as-of) split; else the baseline stays. REP-01 #264 rebased as a capped factor, inert with reason when no offers logged. `rank_basis` label drops only if E1 passes. | P(yes) loses its guess label or the card says exactly why it keeps it | E1 row with CS bounds and split named; served `p_yes.source` names the winner |
| 14 | Sun 10/25 - Sat 11/7 (wk 8-9) | STOPS-01: bye / injury stops with the priced trade-off (`stop_tradeoffs` is served "unknown" today, measured; this is its producer); injury-return timing from the role cells into ROS per calendar week. LIVING-01b #261 stays shadow. Feature freeze 10/31: fixes and grading only after. | week-by-week path shows bye holes and the stop that fixes them with its cost | `stop_tradeoffs.status ok` for every stop; E5 mean realised gain with CI |
| 15 | Sun 11/8 - Sat 11/21 (wk 10-11) | TM-34 deadline mode: countdown to 2026-12-02 17:00 UTC; last REAL send = Mon 11/30 ~17:00 UTC (24 h review + ESPN processing + his send window); last-call offers per partner, hold list, who goes quiet (activity), weeks-left cost in the speed curve. Freeze planner code 11/25 except fixes. | "do this by when" list for the last 7 days | every served step carries `send_by` <= 2026-11-30T17:00Z; 0 steps after week 12 |
| 16 | Sun 11/22 - Wed 12/2 (wk 12) | Final offers from the deck; after the deadline the same planner serves claims + start/sit posture for weeks 15-17 (no new units); season ledger exported names-free. | Title Plan trajectory from week 3 to the deadline with every executed step's predicted vs realised gain | E5 table complete for every sent step; report card dated; overall status honest with n |

---

## 6. Merge-first list (MERGEABLE / CONFLICTING measured `gh pr list` 2026-09-24, this pass: 114 open, 108 drafts, 47 CONFLICTING, 54 MERGEABLE, 13 UNKNOWN)

1. #308 PRODUCER-FAST (MERGEABLE, night 1): fixture 85.6 s -> 18.3 s cold / 1.6 s warm, byte-identical plan; real league 148.9 s -> 34.8 s cold / 6.3 s warm (PR body).
2. #375 PLAYER-SCORE (MERGEABLE, night 1): the GET floor + blue-chip board; strip FantasyPros display first (guard #165); DRAFT-ID-MAP follows night 5.
3. #336 DATA-FC (MERGEABLE, night 1): the no-overpay currency refreshes daily.
4. #291 BROKEN-G (MERGEABLE, night 1): one `blend.week`; adds `server/services/blend-week.js#blendWeek` (measured files).
5. #366 REPRO-01 (CONFLICTING -> rebase night 1): 0-diff replay; CLEARS-BENCH needs it.
6. #304 HIS-SCREEN, #319 PYES-BASELINE (CONFLICTING -> night 3); #363 PRICE-BAND-02 (MERGEABLE, night 3, label only).
7. #335 STEP-LOG, #296 M7-TIMING, #295 AUTOPSY-01, #256 HEALTH-01d+e, #365, #280 (MERGEABLE, night 4); #293 PUSH-01, #246 E1-FIX, #247 OFFER-SNAPSHOT (CONFLICTING -> when a night has room).
8. #377 O1-RADAR (MERGEABLE, night 8, after the P(out) fix).
9. #288 CLONE v2 (CONFLICTING), #369 PULSE-02, #248 JEV-01a, #249 COACH-01a (MERGEABLE), #310 COACH-LINK (CONFLICTING) (night 9; shadow / grading only).
10. #283 / #285 / #292 / #286 BROKEN-D/E/F/Q (CONFLICTING; night 7 WEEKLY-RANGE-ONE), #290 UI-ENG-5, #284 SELF-01b, #264 REP-01 (CONFLICTING; block 2-3); #250 HEALTH-01b/c (CONFLICTING; rebase with WEEKLY-RANGE-ONE: "Coach never repeats a broken number"); #281 EA-06 drift + fallback (CONFLICTING; fold into #256's chaos line or close as absorbed).
11. #374 Marcel referee (report-only, any quiet night); #376 AI-01: close as declined, keep docs; #371 FEAS-140-ESPN (1-line conflict; info-only side card); #277 HYPO-01a, #268 TELLS-01b, #334 ACTIVITY-01 (MERGEABLE but shadow; park table).

---

## 7. Parked or killed, with why

| item | verdict | why |
|---|---|---|
| 5-lens composite as the served ranker | KILL as ranker; sliders survive as thresholds + display | r53: composite minus best lens +0.009 [-0.001, +0.018]; market / blue-chip lenses 0.48 on the playoffs |
| GATE-SWAP / "2-SE clears" step gate | KILL (nothing to swap) | no path gate reads `clears` (measured `modes.js:56-84`, `planner.js`) |
| "Turn 2-for-1 on", "RL17-3 default on", "widen the direct finish leg" as fixes | KILL (already on / already 3) | 14:23Z `two_for_one on true`; `rosBasisFlag` preview; `search.js:282 maxGiveFinal = 3` |
| ROSTER-ONE (21 vs 18 roster) | KILL (no discrepancy) | `SUM(on_roster)` = 18 = producer roster (measured); a FRESH-01 check line remains |
| TUESDAY-GRADE as a new grader job | KILL (second producer) | graders run every tick (`refresh-live-data.mjs:32-34, :377`); SOURCE-TABLES replaces it |
| COST-CARD | KILL (already served) | `view.js:253-260` prints the closest overpay; night 1 adds the chain |
| CHESS-01a #258 separate beam search | KILL as a second planner; folded into SEARCH-WIDE | ONE-PLANNER (`produce-plans.mjs:32`) |
| #251 PROJ-04-a second `weekly_autopsy` producer | CLOSE; #295 survives; luck split = reporting input | META-01f ruling (ENGINE-SPECS.md:162) |
| E4-REDO Sleeper replay | PARK; E4-live replaces it | "about 43,965 more league-seasons" (measured brain_report) |
| WIN-VALUE / AI-01 second "true value" | DECLINED (#376) | served ROS still best; usage goes INTO ros-projection (ROS-USAGE, night 11) |
| O2-ML seven forecasters | PARK to a shadow leaderboard | EWMA beat a 16-feature ridge (OPPORTUNITY-FINDINGS:172-180); seven fits for unproven lift |
| O3-JEV situation reader as a served input | PARK to shadow from block 2, only if O1C passes | r17 LLM persona AUC 0.47 vs activity 0.78 |
| META-01a lab, META-01c/d referee producer + reader stage | PARK (lab / shadow) | no numeric expert beats ESPN's point (ENGINE-SPECS.md:665); META-01b runs from night 1; META-01e = L1 ruling applied; META-01f = SOURCE-TABLES + the tick graders |
| `outscoring_usage` and any sell-on-luck rule | cap toward 0, label "tested: not supported (r52)" | r52 Deviation 1 |
| Pure "buy the earlier pick" rule | KILL | r52 Deviation 2 |
| Fitted tier cutoffs as validated | KILL; labels served as a provisional blend | r51 KILL by the strict rule |
| LOVE as a search constraint | PARK until its luck-free grade prints and a `dropped_by_reason: love_avoid` count exists | provenance rule; keeps the night-8 byte-diff check honest |
| COACH-ROLEPLAY #301 as a probability | PARK (text only, shadow) | r17 |
| M5 pitch bandit #263, TELLS-01b #268, MESO arms, NSP row 20 "price at his yes point" | PARK until >= 20 settled offers per arm (guess); E2 "needs 10 more offers" (measured) | 0 `sent_at` rows today |
| LIVING-01b #261 / ACTIVITY-01 #334 in the sim | shadow | E3-live needs 40 team-seasons |
| Consensus gate on 2024, PROJ-02 sharp chain, K/DST modelling | PARK | ESPN 2024 as-of rows absent; 2026 forward capture starts night 1; PROJ-02 superseded by O1C-WIRE |
| Routes / participation features | PARK | licence-gated, table empty (facts §8) |
| NSP row 14 honest weekly range (PROJ-03-b/c), NSP row 27 self-play, CE-09 tables, CE-03 spells, HYPO-01 #277, TM-16 / AI-06 twins, AI-09, TM-21, AI-04, Team Outlook #42, H1 league-history service, UI-ENG-1/2/3/4/6, TM-01 closer notes, COUNTERPART-02b, PROJ-00/01-c licence backfill | PARK past 12/02 | not on the path to the three screens this season; twins need labels we do not have (37 decisions); Team Outlook gate failed (coordinator-eval S4) |
| ROADMAP-TIERS | ABSORBED by LADDER-01 + LOVE-RULE + GETS-REAL | same behaviour, one planner |
| Phase 11 always-on loop location | RULE: the Mac runs the refresh loop and the app by day; no builds by day | Nick's nights-only rule |
| Any FantasyPros display or commit; any betting objective | KILL | ruling 9/23 + guard #165; facts §11 |

Every other item in the two inventories (inventory-plans.md: 836 items over 16 documents, 25 alias families, measured coordinator-eval.md:34) attaches to a layer row above, a night, or a line here; the sweep (nights 10-11) writes the one-line home for each open draft.

---

## 8. Jev / LLM spend

Measured: the chat classifier runs on every refresh tick with no cap (RULES.md:39: log spend, alert on runaways; 6 messages unlabelled on gateway errors); scripts price tokens at $0.042/M input with per-script caps $1-$8 (ENGINE-SPECS.md:377-379); the in-app ledger is `ai_usage` (table exists, measured), `MAX_DAILY_BUDGET_USD` 100; r50-r53 and AI-01 used no paid calls. Plan (every figure a guess with a cap): nights 1-10 add NO new Jev question types; classifier <= $1/day; REASON-01 panels for the top card + deck, league 4 only, $0.50-2/day; PULSE-02 held-out grading ~$3 once; JEV-01b grades STORED signals, $0; COACH-ROLEPLAY shadow under the Coach $1/day cap; O3-JEV shadow only from block 2 and only if O1C passes ($5 build / $2 day). Total through 12/02: guess <= $120, every call logged with cost, a runaway alert at 3x the prior day's median. None of it moves a served number. The dead news extractor (D2) is a separate key Nick must replace; it is not Jev.

---

## 9. Risks

- Reach under Nick's rules: with two blue chips locked and a 0 cap, the first cards are Olave-class 2-for-1 (Balanced) or Jeanty-class 3-for-1 (Fuck-it, if the dropped-by-reason counts show they die only on `max_give_per_step`); Taylor and Bijan are unreachable by any package this week (measured arithmetic). The card says so.
- The fitted 2-for-1 completion band (r 1.118-1.699, #363) contradicts the 0 cap: under the cap those packages rarely complete in real leagues. Decision 1 puts the number in front of Nick; until then the card labels them "below the band".
- P(yes) is a guess for weeks (n=37; forward-only split favours the clone, LOWO the baseline); ranks carry `rank_basis: p_guess`.
- Fuck-it's 0.03 completion floor makes 3-step ladders ineligible at p 0.30 per step.
- Review window: a "yes" is not a landed trade (7 vetoes of 25 executed decisions in 2026); P(complete) is a guess from that record.
- The title lens is weak on resolution; RB-TITLE fixes noise, not the model.
- BASIS-02 edits a served path in `season-sim.js`; RL-6-3 nulls must pass.
- Data: `nfl_model_growth` must be repaired tonight or week-3 usage never lands Tuesday (then every tier / LOVE / radar number reads week 2 into week 4); news is dead until Nick replaces the key; the ESPN as-of capture has zero rows so far.
- Mac: one local fit per night; producer 97.9 s alone, 2,221 s under load (measured).
- Conflicts: 47 CONFLICTING drafts; shared files (`season-sim.js`, `search.js`, `league-adapter.mjs`, `produce-plans.mjs`, `trade-engine.js`) serialised by night; a slipped rebase moves to the next night.
- Converge gate: this plan supersedes RULES.md:70 (b)(d) for its named units and sizes the sweep (114 -> < 35 by night 11); if Nick does not accept that, nights 1-9 build only REACH-01, BASIS-02, PYES-ONE, SOURCE-TABLES as "fix units".
- Public repo: manager-name strings in `flip_map` / `next_move` text (measured); nothing from plans.json is committed; NAMES-LEAK on night 10.
- No labels accrue unless Nick taps "I sent it" (0 of 94 rows); Coach nudges once per offer.
- Calendar: the earlier plan's weekday labels were one day off; this table uses `cal` dates.

---

## 10. Decisions for Nick (max 3)

1. The cap and the edge: today give == get is allowed (cap 0) and the only fitted evidence (#363, held-out) says real 2-for-1s complete when the two-player side gives 12-70% MORE. Pick one: (a) keep 0, even trades allowed; (b) require a win margin (e.g. give <= 0.97 x get, shown as `min_edge`); (c) allow a bounded premium on depth-only 2-for-1 packages (no blue chip in the give), e.g. up to +12%, shown on the card. Default in the plan: (a).
2. Currency and the floor: Bucky Irving (board 74, "Level below") is spendable (the only Balanced 2-for-1s that reach Olave are Bucky + Etienne 5,503 and Bucky + Price 5,366); and the "real player" floor for the final GET: "Level below" (74+, default) or "Blue chip" (83+)? The floor never applies to what Nick pays with.
3. A.J. Brown: confirm his HEALTHY value for the give side (the plan's default = his pre-injury fc_value, a guess until you set it), that he moves only for a get worth at least that AND labelled Blue chip or above, and that Nico Collins and Chase Brown stay untouchable in Fuck-it through 12/02.

Next action (under two minutes): reply with three answers (1: a / b / c; 2: Bucky yes-no + floor; 3: A.J. number + confirm). Night 1 starts at 9 PM tonight with the defaults either way.


## 10b. Nick's decisions (2026-09-24 afternoon)
1. Cap = (c): max_overpay 0 by default; up to +12% FantasyCalc on depth-only 2-for-1 consolidations (no blue chip in the give), served ONLY if Nick's weekly starting-lineup points AND title odds rise on paired dice (and survive fresh-dice confirm).
2. Floor for the final GET = Blue chip (83+). Olave is excluded outright (sold 9/17; TRADE-MEMORY + Nick: "I don't want Olave, I just sold him away").
3. A.J. Brown moves only if the return is a Blue chip who is a CONSISTENT weekly scorer now (high floor: low week-to-week variance, healthy, established role), not a boom/bust or future piece. Nico Collins and Chase Brown stay untouchable in every mode.

---

# Appendix A. Every prior plan item and where it lives in the ONE PLAN

836 rows from 16 plan documents (inventory-plans.md). Disposition rule: merged/done -> its layer; draft PR -> its merge night or the nights 10-11 sweep; planned -> its build night, else homed by family alias, else parked with a reason; killed/declined/superseded -> with the evidence. Names-free.
Counts: 268 LIVE in its layer; 197 HOMED (family); 87 KILLED / ABSORBED (evidence in status); 81 PARTIAL: merged parts live, rest on its night; 60 MERGE NIGHT (section 6); 46 BUILD NIGHT (section 5); 44 PARKED; 24 PARTIAL: merged parts live, rest parked; 14 compound row: see its sub-items; 9 NIGHT 1: 15-min status check; 6 betting: ignored

## C.1 docs/FANTASY-ENGINE-MASTER-PLAN.md, section 00 parts A-C (st

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| W0 | DONE-NO-PR (direct commits 09-17/18, e.g. 06f05ff, 947d66c) | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| WA | DONE-NO-PR partial: 12 of 17 agents done at the 9/18 pause; 2 defects left open (edge-test violation, offerFor | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WA:play-chance-live | DONE-NO-PR: rates written to the live DB 9/24 (scripts/fit-availability.mjs, 871 role rates); role-cell model  | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WA:manager-data-pipeline | DONE-NO-PR (shipped) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WA:llm-plumbing | DONE-NO-PR (shipped; #213 later raised max_tokens) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WA:infra-essentials | DONE-NO-PR; unfixed: no supervised restart of the refresh loop, no Data Health page (later BROKEN-01 #237, #86 | LIVE in its layer | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| WA:review-fixes-2 | DONE-NO-PR (0a657f6) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WA:trade-engine-correctness | DONE-NO-PR; unfixed offerFor/offerForMany weekly-only ceiling gate | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WA:valuation-map | DONE-NO-PR; unfixed edge-test violation (perceptionFactorFor) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WA:tactics-and-packages | DONE-NO-PR (ffe97c9, 9cee38a, f92bb5f); verify result never recorded | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WA:value-and-acceptance | DONE-NO-PR (built + independently verified 9/19) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WA:sendable-proposals | DONE-NO-PR; live-verified 9/23 (#213 MERGED gave Sonnet output room) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WA:integration + restart | DONE-NO-PR (run.sh restarts logged 9/23-24; rate write 9/24) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WA:E6.4 counter an offer | MERGED as COACH-NEGOTIATE #327 + HIS-SCREEN-FIX #344 (via #359) | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| WO+WB (workflow) | SUPERSEDED by ENGINE-SPECS / NORTH-STAR-PLAN / BUILD-PLAN (never launched; last state "Next") | KILLED / ABSORBED (evidence in status) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WO:H1 league-history service | PARTIAL: dataset DONE-NO-PR (sleeper_history.sqlite, ~500 leagues/season 2021-25, ES C7-C10); reader service P | HOMED (family) | corpus used by R&D + E1 baseline; reader service parked |
| WO:O1 opportunity (O1a scaffold) | DRAFT-PR #377 O1-RADAR (4 gated cells pass: teammate_out RB, usage_rise WR/TE, star_return marginal; L4 wk3 9  | MERGE NIGHT (section 6) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| WO:O1b event triggers (items 7-10) | DRAFT-PR #377 (18 event types measured incl. backup-QB downgrade, NOT significant n=474) | MERGE NIGHT (section 6) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| WO:O1c wiring (item 11 + window fix) | QUEUED O1C-WIRE (BQ:3; branches after #377 merges; writes share/team volume only, fits K.share/K.team_volume) | BUILD NIGHT (section 5) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| WO:O2 injury-return model | PARTIAL: AVAIL-HORIZON-3 #357 ratio-form return curve MERGED preview-only (via #364, override aaad76cc); #349/ | PARTIAL: merged parts live, rest on its night | L1 p_play role cells live (#357 preview); CE-03 spells parked; injury timing into ROS block 4 |
| WO:O3 season sim v2 | PARTIAL: B-01 #162 MERGED (current week + record); CE-05 #168 MERGED (rules/brackets); RL-6-3 #192 MERGED (pai | PARTIAL: merged parts live, rest on its night | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| WO:O4 Team Outlook | OPEN-PR #42 draft "the measurement, the rule, and the gate it failed" (gate failed); verdict not on main | MERGE NIGHT (section 6) | parked (#42 gate failed); destination card = title odds |
| WO:O5 trade value + horizon | PARTIAL: RL-16-1 #236 playoff weight 5.13 flagged (via #278); RL-9-3 #200 roster-spot lineup value MERGED; bac | HOMED (family) | live (RL-16-1 merged); further weighting killed (r6/IDEA-068) |
| WO:O6 one this-week basis + line lift test + coordinator refit | PARTIAL: BLEND-01 #164 OPEN-PR held (ESPN 0.683 beat ours 0.636; 4 holds -> 2); S-03 #166 OPEN-PR (drops the l | PARTIAL: merged parts live, rest on its night | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| WO:C0 API contracts w/ provenance class | PARTIAL: WARROOM-CONTRACT #238 MERGED (plans-schema); #91 (trade path says what measured it) and #85 (chance-t | HOMED (family) | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| WB:B1 weekly action plan | SUPERSEDED by the campaign producer next_move/deck (#233 via #299; FIX-03 #272) | KILLED / ABSORBED (evidence in status) | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| WB:B2 Coach (D5-D7) | PARTIAL: Coach assistant #90 MERGED 9/22; COACH-TOOLS #298, COACH-NAV #325, COACH-MSG #306 (via #340); COACH-N | PARTIAL: merged parts live, rest on its night | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| WB:B3 opponent read, scoped news, one current-week, FA injury status | PARTIAL: news attribution #205 MERGED; Sleeper flags cleared #204 MERGED + waiver skips hurt replacements #178 | PARTIAL: merged parts live, rest on its night | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| WB:B4 UI (home "/", Coach everywhere, Outlook deep dive, budget settings, decision-log vie | PARTIAL/SUPERSEDED: League Hub command center SK-01 #186 MERGED; War Room #231/#230 in Trade Brain; Coach dock | PARTIAL: merged parts live, rest on its night | #284 block 2 (E6 producer); SELF-01a night-1 status check |
| WB:B5 decision log + waiver-priority guidance | PARTIAL: GR-01 rec_ledger #174 MERGED; trade_outcomes ledger #94 MERGED; waiver priority + weekly reset shown  | HOMED (family) | L10 live; #335 night 4; #247 when a night has room |
| WB:B6 live negotiation profiles (15-min incremental, weekly rebuild, $0.50 budget) | PARTIAL/SUPERSEDED: profiles rebuilt once 9/23 (10 local agents, written to negotiation_profiles); ONE-READER  | HOMED (family) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| WB:game-day checks | PARTIAL: SS-01 #185 dead-starter guard MERGED; RL-10-1 #198 ESPN-zero inactive (default-off); RL-3-2 #184 live | PARTIAL: merged parts live, rest on its night | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| WC page audit | PARTIAL: UX audit agents 9/23 (UX-01/02); UX-08 #167, UX-08b #175, UX-08c #182, UX-10 #177, UX-11 #180 MERGED; | PARTIAL: merged parts live, rest on its night | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| WD refinements + weekly learning loop + K/DST + depth-3 + Coach historical check | PARTIAL/SUPERSEDED: weekly loop -> EA-02 daemon hooks (#242 via #278) + META-01f PLANNED; K/DST -> #62 (waiver | PARTIAL: merged parts live, rest on its night | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| WE final integration + morning report | SUPERSEDED by integration PRs #278 #299 #317 #340 #359 #364 + MORNING-BRIEF.md (private) + bin/morning-check.s | KILLED / ABSORBED (evidence in status) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WF Phase 11 | PARTIAL: see C.5 Phase 11 rows | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WO+WB Phase 3 (verifier per item, skills panel, verification-loop) | SUPERSEDED by RULES v3 (diff reviewer + CI gate) | KILLED / ABSORBED (evidence in status) | live (RL-16-1 merged); further weighting killed (r6/IDEA-068) |
| Section 2 final-product promises 1-6 | PARTIAL: 1 PARTIAL (ESPN beats ours; ranges uncalibrated); 2 MERGED (finder + ONE-PLANNER; P(accept) shown, un | PARTIAL: merged parts live, rest on its night | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |

## C.2 FANTASY-ENGINE-MASTER-PLAN.md, part D designs, part E eviden

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| D1 Team Outlook (verdict Fine/Watch/Act) | OPEN-PR #42 draft (gate failed); not on main | MERGE NIGHT (section 6) | parked (#42 gate failed); destination card = title odds |
| D2 Outlook statistical standard (3 stacked estimators, intervals, self-grading) | PLANNED; pieces: E3 grader #235 MERGED (Sleeper PASS), CALIB-TEMPER r42 KILLED, E3-ESPN #322 inconclusive/over | BUILD NIGHT (section 5) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| D3 league history dataset + one reader | PARTIAL: corpus DONE-NO-PR (sh_* tables; used by ~40 R&D rounds); reader service PLANNED; IDEA-005 settings re | HOMED (family) | corpus used by R&D + E1 baseline; reader service parked |
| D4 Trade Brain (valuation map, 9 tactics, edge test, P(accept) band, AI pass, acceptance) | DONE-NO-PR (WA) + #213 MERGED; live-verified 9/23; acceptance "top ideas change when sentiment zeroed" not ver | LIVE in its layer | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| D5 Coach + computed weekly action plan | SUPERSEDED: plan -> campaign producer; chat -> COACH-* units; COACH-ANSWERS #346 answers 12/12 starter questio | KILLED / ABSORBED (evidence in status) | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| D6 Coach objective-driven, relays the Outlook verdict, complete tool catalog, proactive on | PARTIAL: COACH-TOOLS #298 (plan/people/brain/health reads) via #340; verdict relay blocked on #42; catalog-com | PARTIAL: merged parts live, rest on its night | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| D7 Coach knowledge pack (negotiation, psychology, trade theory, real examples) | PARTIAL: docs/COACH-PLAYBOOK.md exists (27 tactics; RL-15-1 #210 correction MERGED); psychology/theory/example | PARTIAL: merged parts live, rest on its night | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| D8 dashboard home at "/" (6 sections) | SUPERSEDED: League Hub command center SK-01 #186 MERGED + War Room; "/" as dashboard not confirmed -> UNKNOWN  | KILLED / ABSORBED (evidence in status) | see status |
| D9 UI audit and cleanup | PARTIAL (see WC row) | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| D10 final integration + morning report | SUPERSEDED (integration PRs + MORNING-BRIEF.md + morning-check.sh) | KILLED / ABSORBED (evidence in status) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| D11 | UNKNOWN: no D11 exists in the document (A4 says "D1-D10"); listed so the id is not silently dropped | NIGHT 1: 15-min status check | parked (#42 gate failed); destination card = title odds |
| E1.opportunity model test | DRAFT-PR #377 O1-RADAR (3-4 cells pass; MAE 3.134 -> 3.108) | MERGE NIGHT (section 6) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| E1.trade value edge test (ROS delta predicts realized) | DECLINED: RL-8-2 #196 gate FAILS (51.5%), RL-8-2b #207 one 2025 look fails both arms; E4 #294 planner vs finde | KILLED / ABSORBED (evidence in status) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E1.season-sim calibration | PARTIAL: E3 PASS on Sleeper week-7 replay (#235); ESPN-history check over-confident (#322); TITLE-ZERO bug fou | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E1.win-now vs championship split (exchange rate) | MERGED RL-16-1 #236 (5.13, flagged, via #278); IDEA-068 standing-dependent R KILLED r50 | LIVE in its layer | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| E1.season-ending news flag backtest | PLANNED (no unit found) | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E1.P(accept) + valuation map re-test | PARTIAL: E1 grader MERGED (#235/#246/#324): served band has no ranking skill on L4 (AUC 0.56), anti-predictive | PARTIAL: merged parts live, rest on its night | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| E1.weekly action plan follow-the-plan arm | PARTIAL: E4 #294 (via #340) = planner vs finder not proven; E4-REDO QUEUED r54 | PARTIAL: merged parts live, rest on its night | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E2.1 chance to play live as one piece | DONE-NO-PR (role-cell model on main; rates written to live DB 9/24 2:25 AM) | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E2.2 injury-return model | PARTIAL (see O2) | HOMED (family) | L1 p_play role cells live (#357 preview); CE-03 spells parked; injury timing into ROS block 4 |
| E2.3 free-agent ESPN injury status | MERGED #204 (Sleeper flags) + #178 (skip hurt replacements) | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E2.4 one week definition + handover | PARTIAL: Phase 0.6 DONE-NO-PR (migration 056); BROKEN-D #283 DRAFT (0/5 disagree live today per FIXPR-283) | PARTIAL: merged parts live, rest on its night | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E2.5 store ESPN injuryStatus in roster snapshots | DONE-NO-PR (STRUCTURAL-RELOOK: "roster snapshots with player-level pregame ESPN status"); IDEA-011 history rec | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E2.6 silent failures in the live path | DONE-NO-PR + MERGED #115 #130 #131 #111 (bare-catch fixes); #103 bare-catch sweep OPEN-PR | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E2.7 served-vs-trained mismatches | PARTIAL: HX-01 #165 MERGED (label); S-03 #166 OPEN-PR; serve-log #243 MERGED (records what served); FC-SNAP #1 | PARTIAL: merged parts live, rest on its night | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| E2.8 injury-dialect look-ahead re-pick (<=2024) | PLANNED (no unit found; S-04 in WORK-QUEUE covers "re-pick k on <=2024") | HOMED (family) | L1 p_play role cells live (#357 preview); CE-03 spells parked; injury timing into ROS block 4 |
| E2.9 LLM budget settings control | PARTIAL: llm-budget.js caps exist; Settings UI not found; #25 per-league budget CLOSED-UNMERGED | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E2.10 outcome/luck weekly refresh | SUPERSEDED (EA-02 daemon hooks; luck_self_view retired #353 via #364) | KILLED / ABSORBED (evidence in status) | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| E2.add accuracy scoreboard | PARTIAL: C-01 #160 start/sit vs ESPN MERGED; serve-log #243; BENCHMARKS.md; bench points metric PLANNED | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E2.add decision + outcome log | MERGED: GR-01 rec_ledger #174, trade_outcomes #94, offer loop #239 | LIVE in its layer | L10 live; #335 night 4; #247 when a night has room |
| E2.add storage guardrails | DONE-NO-PR (safe-clean.sh; disk check #149 MERGED; gzip of backups) | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E3 provenance -> WA bucket | PARTIAL: chance-to-play DONE; offerFor read/horizon UNKNOWN; cache key UNKNOWN; refresh loop restarted many ti | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E3 provenance -> WO bucket | PARTIAL: playoff weight MERGED #236; line lift -> #164/#166 OPEN; coordinator label #165; replay value RL-8-2  | PARTIAL: merged parts live, rest on its night | L1 p_play role cells live (#357 preview); CE-03 spells parked; injury timing into ROS block 4 |
| E3 provenance -> WB bucket | PARTIAL: BROKEN-G #291 DRAFT; confidence curve S-08 PLANNED (R1 finding); BROKEN-D #283 DRAFT; posture one dec | PARTIAL: merged parts live, rest on its night | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| E3 provenance -> WC bucket | PARTIAL: fake SOS removed RL-8-3 #195 MERGED; horizons S-07 PLANNED (RL-9-3 #200 season_delta weeks-left MERGE | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E3 provenance -> WD bucket | PARTIAL: selfScout variance advice fixed RL-15-3 #209/#212 MERGED; positional need cap RL-19-1 #224 MERGED; lu | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E3 provenance -> Later (draft bench constants) | PLANNED (before 2027 draft) | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E4.Coach re-engineer floating assistant | MERGED #90 (Coach grounded assistant) + #223 prompt audit; /pitch retired (410) | LIVE in its layer | see status |
| E4.action plan new service in Decision Inbox | SUPERSEDED (campaign producer; /inbox retired with MLB removal #128/#159) | KILLED / ABSORBED (evidence in status) | see status |
| E4.Trade Brain extend findTrades + counterparty-pricing | PARTIAL: profiles read via ONE-READER #260 (via #340); RL-17-3 #241 centres odds; luck term retired; playoffOd | HOMED (family) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| E4.dashboard new "/" page | SUPERSEDED by #186 + War Room (see D8) | KILLED / ABSORBED (evidence in status) | see status |
| E4.opponent read new + lineup objective + current week | PARTIAL: People Board #352 (via #364); posture objective #169 MERGED; BROKEN-D #283 DRAFT | PARTIAL: merged parts live, rest on its night | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| E4.news extend /news/signals + tracker + lag-trader | PARTIAL: #205 attribution MERGED; extractor broken since 9/22 (401, needs Nick) -> BROKEN-NUMBERS P | HOMED (family) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| E4.waivers waiverBoard single source | PARTIAL: #191 id match, #178, #211, #62 MERGED; /brain/waivers retirement UNKNOWN; trending_players scheduled? | HOMED (family) | live (SS-01, waiver priority); Sunday game-day checks in the weekly rhythm; K/DST done enough |
| E4.orphans -> WC | PARTIAL: /pitch retired; MLB routes removed #128 #159; kill list D-14 PLANNED (WQ); wiring map lists 4 unroute | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| E4.known overlaps list | PARTIAL (rulings SR 1-5, 11-13 settled the people/planner/flip/fatigue/week overlaps; waiver and news overlaps | HOMED (family) | live (#275 one counter); REP-01 block 3 capped |
| E5.1 weekly ingestion live | DONE-NO-PR (cf3d446) | LIVE in its layer | L10 live; #335 night 4; #247 when a night has room |
| E5.2 bluff-detector roster check | DONE-NO-PR (dc48028) | LIVE in its layer | L10 live; #335 night 4; #247 when a night has room |
| E5.3 waiver +3.45pp caveat / re-test | PARTIAL: caveated; re-test -> waiver-crowd-baseline package (validator REJECT) and C-02 gate PLANNED; R&D r13  | HOMED (family) | L10 live; #335 night 4; #247 when a night has room |
| E5.4 counterparty receptiveness centred on 0.5 vs real 12% | MERGED: RL-13-3 shrunk accept score in CLONE-01a #229 DRAFT (0.913 -> 0.5); RL-13-2b scale fix #211? (RL-13-2  | LIVE in its layer | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| E5.5 negotiation profiles rebuilt on defective inputs | DONE-NO-PR (profiles rebuilt from all messages 9/23, written to negotiation_profiles; ONE-READER #260) | LIVE in its layer | L10 live; #335 night 4; #247 when a night has room |
| E5.6 coordinator served-vs-fit basis (deadline week 5) | PARTIAL: HX-01 #165 label MERGED; S-03 #166 OPEN-PR (coordinator refit/switch-off); META-01e "served point = E | PARTIAL: merged parts live, rest on its night | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| E5.7 players.sleeper_id crosswalk | DONE-NO-PR (moonshot crosswalk 8,803 ids; H-01 can grade season-sim on corpus leagues) | LIVE in its layer | L10 live; #335 night 4; #247 when a night has room |
| E6.1 NFL trade re-key from nfl_player_roster_events | DRAFT-PR #377 (O1-RADAR event type "trades") | MERGE NIGHT (section 6) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| E6.2 coordinator/HC change: recency-weight team-identity means | PLANNED; OC change event in O1-RADAR #377; play-caller history moonshot backfill RUN (coordinator-approved $0. | BUILD NIGHT (section 5) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| E6.3 waiver-race competition model + auto re-rank on lost claim | PARTIAL: R13 priority resets (RL-13-3 #211 MERGED); P(contested) prior IDEA-017/072/114 untested; auto re-rank | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E6.4 counter an incoming offer | MERGED (COACH-NEGOTIATE #327, HIS-SCREEN-FIX #344 via #359) | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| E6.5 weather -> late line move (low priority) | KILLED as projection signal (R7: weather dead even in wind); loaders exist (nfl-weather.js) | KILLED / ABSORBED (evidence in status) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E6.6 benched-for-performance trigger | DRAFT-PR #377 (benching / usage_rise event types) ; LS-01 #189 benched-with-intact-usage FAILED its test | MERGE NIGHT (section 6) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E6.7 Outlook verdict -> real parameter change | PLANNED (verdict not built; risk modes exist instead: SAFE/BALANCED/FUCK-IT change the objective) | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| E6.8 bluff pattern -> position-level price adjustment | PARTIAL: CRED-01 #321 per-manager credibility by statement type (via #340); bluff-detector kept; SHOP credibil | HOMED (family) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| F.Q1 targetSharePrior joint fit | PLANNED (K.share fit inside O1C-WIRE QUEUED) | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 QBR refit + starts shrink | PLANNED (A-19 in WQ, never run) | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 negative-binomial dispersion | PLANNED (PROJ-03-b spec) | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 ensemble form convex vs LAD | SUPERSEDED (META-01 probe: no combiner beats ESPN; served point = ESPN pending Nick) | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 P(play) 0.92 floor cliff + zero inflation + copula | PARTIAL: BROKEN-E #285 DRAFT (typed unknown, `?? 0.92` removed); copula retire PLANNED (PROJ-03-c) | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 trade objective constants (lambda 0.9, fairness cap, 0.2 joint, PLAYOFF_IMPORTANCE) | PARTIAL: PLAYOFF_IMPORTANCE 5.13 #236; NO-OVERPAY #372 replaces value-giveaway with a hard cap; TRADE-LENSES Q | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 week-postmortem grades as-of | DRAFT-PR #251 PROJ-04-a (as-of ledger) + AUTOPSY-01 #295 | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 weekly-learning retrain rule | DONE-NO-PR (WA infra) | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 posture bootstrap by player + spread rule | PLANNED (S-16) | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 roster-risk LAST_REGULAR_WEEK per league + playoff_sos rename | PARTIAL: CE-05 #168 league rules (playoff weeks per league) MERGED; rename UNKNOWN | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 volume-prediction grading (opportunity) | DRAFT-PR #377 (graded on targets/carries) | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 ROS beyond week 10 (before week 11) | PLANNED (S-15 in WQ; RL-1-2 consensus prior; IDEA-026 Marcel referee CONFIRMED -> #374 DRAFT report-only) | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 play-chance activation + fake floors | DONE-NO-PR | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q1 start/sit accuracy table replaced by relevant-pairs numbers | PARTIAL: R1 finding (tail rate read as gap rate) -> S-08 one curve PLANNED; C-01 #160 grades vs ESPN | PARKED | parked past 12/02 (model deferral, off-season) |
| F.Q2 multi-week horizon in trades/plan | PARTIAL: RL-9-3 #200 weeks-left season_delta MERGED; S-07 real horizons PLANNED | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| F.Q2 bye-week planning | PARTIAL: #179 bench bye starter MERGED; RL-5-2 bye discount in trade value PLANNED; ST-06 planner PLANNED | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| F.Q2 trade-deadline awareness | PLANNED (DEADLINE-01 inside RADAR-01-a; TM-34) | BUILD NIGHT (section 5) | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| F.Q2 confidence display only where it changes a decision | PARTIAL (typed-absence + Provenance chip in War Room; C-15 stat block PLANNED) | PARTIAL: merged parts live, rest parked | see status |
| F.Q2 stacking as a playoff tool | PLANNED (ST-02 matchup-aware lineup; IDEA-033 untested) | HOMED (family) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| F.Q3 depth-3 sequences + three-team routes | DRAFT-PR #258 CHESS-01a (depth 3); three-team B-16 PLANNED | PARKED | parked past 12/02 (draft tool) |
| F.Q3 explain from every evidence block | PARTIAL: REASON-01 #234 MERGED (6-part panel); strength tags PLANNED | PARKED | parked past 12/02 (draft tool) |
| F.Q3 P(accept) band -> fitted; counter-offer behaviour ~week 10 | PARTIAL: CLONE-01a/b #229/#288 DRAFT; counter evaluation COACH-NEGOTIATE #327 MERGED; E1 no skill yet | PARKED | parked past 12/02 (draft tool) |
| F.Q3 early-QB draft tool with VOR baseline | PLANNED (before 2027 draft; replay rerun caveat) | PARKED | parked past 12/02 (draft tool) |
| F.Q3 bench points per week (snapshot capture + metric) | PARTIAL: snapshots DONE-NO-PR (league_roster_snapshots); metric PLANNED (lineup efficiency in skill study meas | PARKED | parked past 12/02 (draft tool) |
| F.Q3 durability prior in weeklyAvailability | DONE-NO-PR (WA E1); later found to be the TITLE-ZERO cause (frozen gap) -> #357 preview | PARKED | parked past 12/02 (draft tool) |
| F.Q3 Phase 9 trade-engine backtest on captured proposals | DECLINED (RL-8-2/#207); E4 #294 not proven | PARKED | parked past 12/02 (draft tool) |
| F.Q4 td-features.js walk-forward test | PLANNED (td-features.js listed "dead" in inventory; RL-8-1 retired TD-luck weights) | HOMED (family) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| F.Q4 launcher spawn ENOENT (phone start) | DONE-NO-PR (WA infra) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| F.Q4 3 failing prop-CLV tests | IGNORED (betting; counted in the betting line) | betting: ignored | betting side, ignored |
| F.Q4 .env.bak cleanup | UNKNOWN (not logged) | NIGHT 1: 15-min status check | see status |
| F.Q5 Phase 11 accounts + hosting (Nick's call) | PARTIAL (see C.3 Phase 11) | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| F.Q6 posture SPREAD_SCALE + swap sigma share one variance model | PLANNED (S-16; LIVING-01c team-mean term #273 DRAFT) | HOMED (family) | shadow (#261/#273); twins parked past 12/02 |
| F.Q6 injury-dialect k look-ahead re-pick | PLANNED (S-04) | HOMED (family) | L1 p_play role cells live (#357 preview); CE-03 spells parked; injury timing into ROS block 4 |
| F.Q6 redistribution null re-test (weeks 2-4, fitted-K, P(out)) | DRAFT-PR #377 O1-RADAR (4th attempt) | MERGE NIGHT (section 6) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| F.Q6 td-features + man/zone as O1 discovery candidates | PLANNED (man/zone parked; participation data #218 MERGED covers 2021-25) | HOMED (family) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| F.Q6 injury-driven redistribution rule (waiver disclosure, significance gate) items 1-6 | DRAFT-PR #377 (gate-first; "Watch" events explanation-only per O1C-WIRE spec) | MERGE NIGHT (section 6) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| F.Q6 O1 items 7-10 (QB switch, O-line, NFL trade, usage drop) | DRAFT-PR #377 (18 event types measured) | MERGE NIGHT (section 6) | see status |
| F.Q6 O1 item 11 wiring + season-goals window fix | QUEUED O1C-WIRE; window fix (trade-engine window reads real verdict) PLANNED | BUILD NIGHT (section 5) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| F.Q6 UI teardown lost capabilities (decision inbox reader, DataHealth) + palette prune | PARTIAL: Number health #237 MERGED; data freshness #86 MERGED; palette prune UNKNOWN | HOMED (family) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| F.Q6 hype window shrink n/(n+k) | PARTIAL: S-19 one hype producer #187 + rename #194 MERGED; shrink rule UNKNOWN | PARTIAL: merged parts live, rest parked | see status |
| F.Q6 trade horizon default odds 0.5 + dynasty_values refresh | PARTIAL: FC-SNAP #170 MERGED (daily history); DATA-FC #336 OPEN (refresh loop job); RL-17-3 #241 real ROS rate | PARTIAL: merged parts live, rest on its night | L3 live; BASIS-02 + RB-TITLE night 2; CE-09 tables parked |
| F.Q6 season-ending news flag roster check | PLANNED | PARKED | parked until the news key works (D2) |
| F.Q6 chat pipeline per-question persistence + retry | PLANNED (classifier fixed 9/24 00:38Z; per-question persist not found) | HOMED (family) | L12 live; PULSE-02 night 9 |
| F.Q6 replay study rerun before 2027 draft | PLANNED | PARKED | parked to the 2027 off-season |
| F.Q6 week-2 snapshot "old engine" label | UNKNOWN | NIGHT 1: 15-min status check | see status |

## C.3 FANTASY-ENGINE-MASTER-PLAN.md section 4 (phases 0-11), Jev, 

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| Phase 0.1 refresh loop off the web server | DONE-NO-PR (refresh.sh; #95 live tier off thread MERGED) | LIVE in its layer | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| Phase 0.2 fix nfl_news_signals key | DONE 9/17 then BROKEN again since 9/22 (401 x29, needs Nick) | LIVE in its layer | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| Phase 0.3 Sleeper as second injury source | DONE-NO-PR + #204 MERGED (flags cleared) | LIVE in its layer | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| Phase 0.4 live_data_health table + badge | PARTIAL: #86 data freshness + banner MERGED; table name differs | HOMED (family) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| Phase 0.5 re-enable growth tier | PARTIAL (#17/#95 off-thread; SCHEDULER_DISABLED=1 still exported by run.sh) | HOMED (family) | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| Phase 0.6 week progression follows ESPN | DONE-NO-PR (migration 056) | LIVE in its layer | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| Phase 0.7 24/7 hosting | PARTIAL: Fly live site up 9/22 (OPS "live site ok"); #49 #52 MERGED; #9 CLOSED-UNMERGED; deploy button #127 ME | HOMED (family) | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| Phase 1a persist validated fit | DONE-NO-PR (06f05ff) | LIVE in its layer | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| Phase 1b opportunity redistribution | KILLED 3x (measured null) then 4th attempt DRAFT-PR #377 (teammate_out RB passes) | KILLED / ABSORBED (evidence in status) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| Phase 1c xFP + TD regression anchor | DECLINED AI-01 #181 + #376; TD-luck retired RL-8-1 #197 MERGED (priced by consensus) | KILLED / ABSORBED (evidence in status) | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| Phase 1d TPRR / route volume | SUPERSEDED -> PROJ-02-b -> O1C-WIRE QUEUED; data #218 MERGED | KILLED / ABSORBED (evidence in status) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| Phase 1e APM shrinkage target | PLANNED (player_value.sqlite exists; no unit) | HOMED (family) | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| Phase 1f per-stat ML head | RUNNING-STOPPED: demoted 0aa; O2-ML launched 9/24 09:40, stopped 09:47 before a fit | BUILD NIGHT (section 5) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| Phase 1f feature families (coach/QB/O-line/teammates/defense/NGS/context/novel/on-off/off- | PLANNED (O2-ML spec; packages OL-continuity/FTN drop rejected by validator; officials/weather ignored by rulin | BUILD NIGHT (section 5) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| Phase 1g sportsbook props anchor | IGNORED (props; betting line) | betting: ignored | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| Phase 2 consensus gate | DONE: BLEND-01 #164 (ESPN wins, 0.683 vs 0.636) OPEN-PR held; META-01 probe: no combiner beats ESPN; HX-01 #16 | LIVE in its layer | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| Phase 3 ROS value | PARTIAL: ROS to week 10 DONE; playoff x1.5 -> 5.13 #236; #200 weeks-left; Marcel referee #374 DRAFT; beyond we | PARTIAL: merged parts live, rest on its night | live (RL-16-1 merged); further weighting killed (r6/IDEA-068) |
| Phase 4a transaction history collector | DONE-NO-PR forward (league_transactions_raw 1,615 rows; collector on the loop); prior seasons mostly not recov | LIVE in its layer | L10 live; #335 night 4; #247 when a night has room |
| Phase 4e reaction timeline (chat x transactions x news) | PARTIAL: PEOPLE-LAB statement->action (M4), TZ-AUDIT, CRED-01 #321; event_timeline table PLANNED | HOMED (family) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| Phase 4b behavioural profile metrics (draft/waivers/lineups/trades/chat/outcomes/coach sig | PARTIAL: manager_signals + archetypes (WA), tells factory #226, LS-01 #189, WEAK-01/02; most named metrics not | HOMED (family) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| Phase 4b archetypes (11 scores) | PARTIAL: manager_archetypes built (WA); Jev persona KILLED r17 as predictor | HOMED (family) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| Phase 4b seasonal price trend | PLANNED | HOMED (family) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| Phase 4c chat dossier + Jev labels | DONE-NO-PR (jev_league_chat running; classifier fixed 9/24; profiles rebuilt 9/23) | LIVE in its layer | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| Phase 4d per-manager valuation their_value (AUC>=0.70) | PARTIAL: playerValuation exists (WA); CLONE-01a #229 / b2 #288 DRAFT; AUC gate NOT met (E1 0.56; band anti-pre | PARTIAL: merged parts live, rest on its night | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| Phase 5.1 P(accept) logistic | PARTIAL (acceptanceBand; CLONE-01a/b; no skill yet) | HOMED (family) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| Phase 5.2 objective P(accept)xgain - lambda | PARTIAL: NO-OVERPAY #372 MERGED; TRADE-LENSES/WIN-VALUE QUEUED | PARTIAL: merged parts live, rest on its night | killed as ranker (r53); thresholds + display; NO-OVERPAY live; WIN-VALUE declined |
| Phase 5.3 tradeImpact ~1 s | MERGED RL-19-2 #225 (89 ms) | LIVE in its layer | L3 live; BASIS-02 + RB-TITLE night 2; CE-09 tables parked |
| Phase 5.4 anchoring ladder | MERGED (opening ask / walk-away in COACH-MSG #306 + CARD-CLARITY #345) | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| Phase 5.5 negotiation sim over counters | PARTIAL: COUNTERPART-02 #302 DECLINED; COUNTERPART-02b QUEUED; COACH-ROLEPLAY #301 OPEN | PARTIAL: merged parts live, rest on its night | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| Phase 6 find-trades expansion (maxPerSide 3, depth 3, three-team, <30 s) | PARTIAL: ONE-PLANNER 2-for-1 (via #340); CHESS-01a #258 DRAFT; three-team PLANNED; IDEA-048 beam untested | PARTIAL: merged parts live, rest on its night | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| Phase 6 counterparty -> finder data contract (8 rows) | PARTIAL: chat lift removed by SR 2; untouchables pruned via nick block #313; profile via ONE-READER; timeline  | PARTIAL: merged parts live, rest on its night | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| Phase 6 AI synthesis of realistic proposals | MERGED (#213; live-verified); "sentiment zeroed" acceptance not run | LIVE in its layer | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| Phase 7 explain from everything | PARTIAL: REASON-01 #234 + REASON-02 #271 (claims graded) MERGED; strength tags PLANNED | PARTIAL: merged parts live, rest on its night | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| Phase 8 Coach POST /coach (message, anchor, send_at, dont_say, predicted response) | MERGED as COACH-MSG #306 / COACH-NEGOTIATE #327 / VOICE-01 #331; VOICE-02/03 DECLINED (#338) | LIVE in its layer | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| Phase 8b live chat monitor (20-30 s, push) | PARTIAL: 15-min chat ingest + PULSE-01 #316 (WANT_PLAYER replans) MERGED; PULSE-02 #369 OPEN; PUSH-01 #293 OPE | PARTIAL: merged parts live, rest on its night | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| Phase 9 trade-engine backtest | DECLINED/PARTIAL (RL-8-2, #207; E4 #294 not proven; E4-REDO QUEUED) | KILLED / ABSORBED (evidence in status) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| Phase 10 UI sweep of 12 tabs / 47 endpoints | PARTIAL (UX audits; #22 Trade Brain page CLOSED-UNMERGED; Trade Brain exists) | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| Phase 10 live-data badge | MERGED #86 | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| Phase 10 Find deals tree view | DRAFT-PR #290 UI-ENG-5 | MERGE NIGHT (section 6) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| Phase 10 Manager tab | PARTIAL: TM-03 #190 OPEN-PR; People Board #352 MERGED via #364 | PARTIAL: merged parts live, rest on its night | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| Phase 10 Mock-a-trade Coach panel | MERGED NEGOTIATE-UI-FIX #337 via #359 | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| Phase 10 Explain panel | MERGED REASON-01 #234 | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| Phase 10 projection card drivers | PLANNED (UI-ENG-1 range bar) | BUILD NIGHT (section 5) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| Phase 10 health page | PARTIAL: BENCHMARKS.md + Number health #237 | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| Phase 10 counter an offer | MERGED (#327 #344) | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| Phase 10 package builder | PARTIAL: ONE-PLANNER 2-for-1; ROADMAP-TIERS QUEUED | PARTIAL: merged parts live, rest on its night | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| Phase 10 playoff planner | KILLED (R6 schedule-swing oracle) except playoff weight #236 and R9 rest | KILLED / ABSORBED (evidence in status) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| Phase 10 deadline mode | PLANNED (DEADLINE-01 / TM-34) | BUILD NIGHT (section 5) | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| Phase 10 claim-and-flip | PARTIAL: flip radar merged; waiver-flip TM-25 PLANNED | HOMED (family) | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| Phase 10 who needs what | MERGED WEAK-01 #326 / WEAK-02 #360 | LIVE in its layer | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| Phase 10 sell-high timing | PARTIAL: S-19 hype producer #187 MERGED; sell-into-hype card PLANNED | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| Phase 11.1 Google OAuth invite-only | CLOSED-UNMERGED #14; docs/GOOGLE-SIGN-IN-SETUP.md (5 steps for the owner) exists; #51 admin on sign-in OPEN | KILLED / ABSORBED (evidence in status) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| Phase 11.2 per-user vs shared data | PARTIAL (#46 hosted multi-user OPEN-PR draft; league_memberships exists) | PARTIAL: merged parts live, rest on its night | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| Phase 11.3 chat-reading hidden per tenant | PLANNED | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| Phase 11.4 bring-your-own Claude key | PLANNED (app_settings key exists; per-user not) | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| Phase 11.5 other keys audit | DONE-NO-PR (answered in plan); #48 ESPN credential owner OPEN, #81 leak guards OPEN | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| Phase 11.6 Fly host + slimmed archive | PARTIAL: Fly live; slimmed line_history extract PLANNED | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| Phase 11.7 auto-deploy on push | PARTIAL: docs/runbooks/deploy-workflow.md (Deploy button, GitHub runner) + #127 MERGED; auto on push to main U | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| Phase 11.8 security checklist | PARTIAL (#81 OPEN, #48 OPEN; tells route league check SR 10) | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| Phase 11.9 per-tenant UI verification | PLANNED | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| Jev.1 league-chat labels | DONE-NO-PR (running; fixed 9/24 00:38Z) | LIVE in its layer | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| Jev.2 presser corpus fantasy questions | PLANNED (jev_presser_signals exists in line_history) | HOMED (family) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| Jev.3 typed news extraction fallback | PLANNED (extractor 401 since 9/22; fallback not built) | HOMED (family) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| Jev.4 Coach second opinion on wording | SUPERSEDED JEV-01a #248 DRAFT (pitch_framing question) | KILLED / ABSORBED (evidence in status) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| Jev.5 P(accept) second opinion | KILLED as a frozen persona (r17 AUC 0.47; JEV-CROSS r34 KILLED); live graded arm JEV-01a/b DRAFT | KILLED / ABSORBED (evidence in status) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| Timeline 16.5-25 days | SUPERSEDED (stale) | KILLED / ABSORBED (evidence in status) | see status |
| 0aa.1 availability dialect | DONE-NO-PR | LIVE in its layer | see status |
| 0aa.2 opportunity redistribution | KILLED (null) -> #377 4th attempt | KILLED / ABSORBED (evidence in status) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| 0aa.3 waivers/live players | DONE-NO-PR; +3.45pp caveated | LIVE in its layer | live (SS-01, waiver priority); Sunday game-day checks in the weekly rhythm; K/DST done enough |
| 0aa.4 xFP anchor + TD regression | DECLINED/KILLED (AI-01, RL-8-1) | KILLED / ABSORBED (evidence in status) | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| 0aa.5 lineup posture by stage | DONE-NO-PR (#169 objective fix MERGED) | LIVE in its layer | see status |
| 0aa.6 counterparty + Coach | SUPERSEDED (see B2/CLONE) | KILLED / ABSORBED (evidence in status) | see status |
| 0aa.7 ML head | RUNNING-STOPPED (O2-ML) | BUILD NIGHT (section 5) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| 0aa.8 UI teardown | DONE-NO-PR (60f5f5d; 8 tabs) | LIVE in its layer | see status |
| §10 backlog: three-team routes >10/week | PLANNED | HOMED (family) | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| §10 backlog: Reddit/Twitter sentiment | KILLED (TM-14 r5; Reddit API blocked) | KILLED / ABSORBED (evidence in status) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| §10 backlog: DK/FD prop scraper; Kalshi/Polymarket | IGNORED (betting line) | betting: ignored | betting side, ignored |
| §9 needs from Nick 1-11 | DONE-NO-PR: 1 pending again (401), 2-5 answered, 6 done, 7-10 answered, 11 deferred then Fly live | LIVE in its layer | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |

## C.4 NORTH-STAR-PLAN.md (rows 1-27, tonight's units, additions)

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| NSP-1 flip radar | MERGED: ACQ-FLIP proto #227 + campaign flip_map (#233) via #299; FLIP-LEGS #358 + FLIP-LEGS-2 #362 via #364 (6 | LIVE in its layer | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| NSP-2 go-get-X planner | MERGED: proto #227, ONE-PLANNER #311 via #340 (2-for-1 search), campaign producer; ACQ-01 #267 SUPERSEDED; pla | LIVE in its layer | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| NSP-3 Title Plan War Room | MERGED #231 #230 #328 #333 #370 + INT5/INT6 | LIVE in its layer | see status |
| NSP-4 beat my boys not ESPN | DONE-NO-PR (ruling + META-01 design; served-point flip needs Nick OK) | LIVE in its layer | see status |
| NSP-5 objective picker + suggest targets | MERGED (WR-3 #230 requests; producer suggestions section; CAMPAIGN-01a) | LIVE in its layer | L10 live; #335 night 4; #247 when a night has room |
| NSP-6 exact things to say / reply table | MERGED (COACH-MSG #306 via #340; MSG-WIRE-2 #361 via #364 10/10 playbooks; CARD-CLARITY #345; COACH-NEGOTIATE  | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| NSP-7 always running / replans every refresh + events | PARTIAL: refresh-tick replans (REFRESH-L4 #347, 130 s L4); PULSE-01 #316 WANT_PLAYER replans; PUSH-01 #293 OPE | PARTIAL: merged parts live, rest on its night | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| NSP-8 risk modes + sliders | MERGED (risk_modes; FIX-05 #274 gates mode via #317; mode.set smoke-tested) | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| NSP-9 140 projected pts objective + feasibility | PARTIAL: FEAS-140 #300 + FEAS-140-ESPN #320 via #340; FEAS-140-ESPN-WIRE #371 OPEN (planner does not pass ESPN | PARTIAL: merged parts live, rest on its night | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| NSP-10 itinerary + Coach middle man | MERGED (COACH-NAV #325 via #340; itinerary section; WR-COACH #230) | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| NSP-11 speed curve | MERGED (speed_curve; CATCHUP-LIVE #350 via #364 levers 0->2) | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| NSP-12 catch-up list | MERGED (catch_up; #350 rows 2->5) | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| NSP-13 report card E1-E7 | MERGED EVAL-01 #235; E3 PASS; E1 no skill; E2/E4-E7 "not enough data"/partial (STEP-LOG #335, SELF-01b #284, A | LIVE in its layer | #295 night 4 (one producer); #251 closed |
| NSP-14 GPS weather/Vegas + honest range | PARTIAL: game lines in sim; conformal range PLANNED (PROJ-03-c / META-01a) | PARTIAL: merged parts live, rest on its night | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| NSP-15 number health card + red dot | MERGED #237 + dot fix #333 | LIVE in its layer | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| NSP-16 UI overhaul one decision per screen | MERGED (WAR-ROOM-UI v2/v3 + #231 #333 #370; phone 375 audited) | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| NSP-17 confirm on fresh dice | PARTIAL: IDEA-002 KILLED as bias, kept as variance reduction; confirm section; RB-TITLE QUEUED | PARTIAL: merged parts live, rest on its night | L3 live; BASIS-02 + RB-TITLE night 2; CE-09 tables parked |
| NSP-18 wait-or-act flag | KILLED (IDEA-151 r24); kill switch shipped in FEAS-140 | KILLED / ABSORBED (evidence in status) | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| NSP-19 attention budget | MERGED (attention ranking in plans; top strip #328); IDEA-007 untested | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| NSP-20 price at his yes point | KILLED r23 (IDEA-150), IDEA-150b INCONCLUSIVE un-killed; PRICE-BAND-01 #303 calibrated band via #340; PRICE-BA | KILLED / ABSORBED (evidence in status) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| NSP-21 one-tap decline reason | MERGED (WR-3 #230 reply log + skip reason; deck.skip logged 08:30) | LIVE in its layer | L10 live; #335 night 4; #247 when a night has room |
| NSP-22 offer-fatigue cap | MERGED FIX-07 #275 sentThisWeek; REP-01 #264 OPEN; IDEA-010 INCONCLUSIVE | LIVE in its layer | live (#275 one counter); REP-01 block 3 capped |
| NSP-23 living league in the sim | DRAFT-PR: LIVING-01a #220 CLOSED -> BROKEN-H #280; LIVING-01b #261; LIVING-01c #273 (IDEA-046 CONFIRMED) | MERGE NIGHT (section 6) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| NSP-24 early warning before checkout | KILLED (IDEA-146 r24) | KILLED / ABSORBED (evidence in status) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| NSP-25 pitch testing bandit | DRAFT-PR #263 (M5 pitch bandit); needs offer log; IDEA-037 untested | MERGE NIGHT (section 6) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| NSP-26 clone of Nick | DRAFT-PR #284 SELF-01b; SELF-01a UNKNOWN (#245/#255 closed); endowment/post-loss KILLED | MERGE NIGHT (section 6) | #284 block 2 (E6 producer); SELF-01a night-1 status check |
| NSP-27 league self-play | PLANNED (IDEA-188 untested; TWIN-01 HELD) | HOMED (family) | shadow (#261/#273); twins parked past 12/02 |
| NSP-unit-1 EA-00 spine v2 | MERGED (#216 via #278) | LIVE in its layer | see status |
| NSP-unit-2 ACQ-FLIP-proto | MERGED #227 | LIVE in its layer | see status |
| NSP-unit-3 WR-1 | MERGED #231 | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| NSP-unit-4 CAMPAIGN producer | MERGED #233 via #299 + FIX-03 #272 | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| NSP-unit-5 WR-2 one-dashboard grid | MERGED #231 + WR-POLISH #333 (no page scroll at 1440x900 and 375x812) | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| NSP-unit-6 WR-3 buttons | MERGED #230 + #332 ('I sent it' works) | LIVE in its layer | L10 live; #335 night 4; #247 when a night has room |
| NSP-unit-7 WR-COACH | MERGED #230 + FIX-06 #282 via #317 | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| NSP-unit-8 BROKEN-01a+b | MERGED #237 | LIVE in its layer | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| NSP-unit-9 EVAL graders + brain card | MERGED #235 + FIX-05 #274 | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| NSP-unit-10 REASON-01 | MERGED #234 + FIX-08 #279 | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| NSP-Phase C morning brief | DONE-NO-PR (evidence/MORNING-BRIEF.md private; screenshots evidence/shots) | LIVE in its layer | see status |
| NSP swipe deck | MERGED WR-SWIPE #342 via #359 | LIVE in its layer | see status |
| NSP chat classifier fix (Jev key) | DONE-NO-PR (refresh.sh loads .env.local; pid 46996) | LIVE in its layer | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| NSP ruling league 4 only | DONE-NO-PR (REFRESH-L4 #347, WR-L4 #328, GRIDIRON_WARROOM_LEAGUES=4) | LIVE in its layer | see status |
| NSP after-tonight critical path (daemon -> clones validated -> Coach navigator -> health - | PARTIAL: daemon MERGED (not always-on replanning); clones NOT validated; navigator MERGED; health MERGED; live | PARTIAL: merged parts live, rest parked | see status |

## C.5 NORTH-STAR-RND.md (components C1-C8, round order)

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| C1 who says yes (P(accept)) | MEASURED: no ranking skill L4 (AUC 0.56); chat features hurt (PEOPLE-03 INCONCLUSIVE); IDEA-010 INCONCLUSIVE;  | compound row: see its sub-items | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| C2 clone price | MEASURED: C2-BASE 28.5% inside band -> PRICE-BAND-01 #303 (79% coverage) via #340, PRICE-BAND-02 #363 OPEN; ID | compound row: see its sub-items | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| C3 flip radar | MERGED FLIP-LEGS/#362 (6/6 realised on L4 fixture); R19 need->position confirmed (RL-19-1 #224) | LIVE in its layer | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| C4 go-get-X planner | IDEA-038 CONFIRMED -> ONE-PLANNER via #340; IDEA-150 KILLED / 150b INCONCLUSIVE; E4 not proven; E4-REDO QUEUED | compound row: see its sub-items | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| C5 title odds | PASS on Sleeper (slopes 0.97/0.94); IDEA-046 CONFIRMED -> LIVING-01c #273 DRAFT; IDEA-047 INCONCLUSIVE (placeb | compound row: see its sub-items | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| C6 timing | IDEA-151 KILLED; IDEA-146 KILLED; IDEA-110 KILLED; IDEA-051 deadline KILLED; M7-TIMING #296 OPEN; PEOPLE-MOOD  | compound row: see its sub-items | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| C7 playbook | PARTIAL: needs logged offers; IDEA-022 CONFIRMED (fragile) -> RL-27-1 PLANNED; IDEA-025 menu INCONCLUSIVE; IDE | PARTIAL: merged parts live, rest on its night | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| C8 reasoning | PARTIAL: REASON-02 #271 stores claims (via #359); needs live weeks | HOMED (family) | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| NSR round order r22-r25 | DONE-NO-PR (r22 C2, r23 C4, r24 C6, r25 C5 all ran; r26+ continued from the backlog) | LIVE in its layer | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| NSR coordinator verification rule | DONE-NO-PR (applied: r22 IDEA-087 re-verified; DRAFT-VS-LUCK recorded by hand) | LIVE in its layer | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |

## C.6 ENGINE-SPECS.md (every unit id)

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| PROJ-00 | MERGED #218 (ESPN 2025 local-only, L162) | LIVE in its layer | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| PROJ-01-a | MERGED #222 (2 proven spots; residual model fails) | LIVE in its layer | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| PROJ-01-a-2025 | DRAFT-PR #228 (qb_change confirmed; blowout_underdog_rb not) | HOMED (family) | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| PROJ-01-b | PLANNED (deps #164 open; amended by META-01c) | HOMED (family) | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| PROJ-01-c | PLANNED (licence ruling: internal only) | HOMED (family) | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| PROJ-02-a | MERGED #221 default-off (all 4 links lose); relaunch PROJ-02-A 9/24 RUNNING-STOPPED; SUPERSEDED by O1C-WIRE pe | LIVE in its layer | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| PROJ-02-b | SUPERSEDED by O1C-WIRE (QUEUED) | KILLED / ABSORBED (evidence in status) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| PROJ-03-a (+v2) | DECLINED #215 and #219 (independent Normal wins) | KILLED / ABSORBED (evidence in status) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| PROJ-03-b | PLANNED | BUILD NIGHT (section 5) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| PROJ-03-c | PLANNED (folded into EA-06; amended META-01c) | BUILD NIGHT (section 5) | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| PROJ-04-a | DRAFT-PR #251 (migration 092, card behind flag) + AUTOPSY-01 #295 OPEN | MERGE NIGHT (section 6) | #295 night 4 (one producer); #251 closed |
| PROJ-04-b | SUPERSEDED by META-01f | KILLED / ABSORBED (evidence in status) | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| BLEND-02 | SUPERSEDED by META-01 (probe) | KILLED / ABSORBED (evidence in status) | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| CE-01 / CE-02 | SUPERSEDED (absorbed into PROJ-03) | KILLED / ABSORBED (evidence in status) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| CE-03 | PLANNED (R9 confirmed spells; #202/#204 merged); return curve preview #357 | BUILD NIGHT (section 5) | L1 p_play role cells live (#357 preview); CE-03 spells parked; injury timing into ROS block 4 |
| CE-09-a | PLANNED; folded into EA-06; RL-19-2 #225 MERGED gives the speed | BUILD NIGHT (section 5) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| CE-09-b | PLANNED (EA-06: fields not tables) | BUILD NIGHT (section 5) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| CLONE-01a | DRAFT-PR #229 (PASS; FIX-229-1 live motive wired; PU positives DECLINED) | HOMED (family) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| CLONE-01b b1 (OFFER-01) | MERGED #239 via #278 | LIVE in its layer | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| CLONE-01b b2 (+VETO-01) | DRAFT-PR #288 (Arm 1 pass; Arm 2 n=37 not; default-off) | MERGE NIGHT (section 6) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| MOTIVE-01 | DRAFT-PR #229 (display-only; live hook wired by FIX-229-1) | HOMED (family) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| DEADLINE-01 | PLANNED (inside RADAR-01-a; no reader on main per C29) | HOMED (family) | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| RADAR-01-a | PLANNED (flip_map is the one flip producer per SR 5) | HOMED (family) | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| RADAR-01-b | PLANNED (#174 MERGED) | HOMED (family) | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| CHESS-01-a | DRAFT-PR #258 (conflict with main; fix after 10) | MERGE NIGHT (section 6) | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| CHESS-01-b | PLANNED (E4 #294 covers planner vs finder: not proven) | HOMED (family) | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| REP-01 | DRAFT-PR #264 (FIXPR2-264 done) | MERGE NIGHT (section 6) | live (#275 one counter); REP-01 block 3 capped |
| JEV-01a | DRAFT-PR #248 | MERGE NIGHT (section 6) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| JEV-01b | DRAFT-PR #289 (part 3 SUPERSEDED by META-01) | MERGE NIGHT (section 6) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| JEV-01c | PLANNED (amended EA-08) | HOMED (family) | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| ENGINE-00a | MERGED #216 via #278 (after EA-00) | LIVE in its layer | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |
| ENGINE-00b-a | SUPERSEDED by EA-02 (#242 via #278 MERGED) | KILLED / ABSORBED (evidence in status) | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| ENGINE-00b-b | SUPERSEDED by EA-05 (#281 DRAFT) + §6 promotion-by-PR | KILLED / ABSORBED (evidence in status) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| QUICKFIX-01 | MERGED #217 | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| HYPO-01a | DRAFT-PR #277 (flag off; FIXPR2-277 done) | MERGE NIGHT (section 6) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| HYPO-01b | PLANNED | PARKED | parked (R&D hygiene, not on the path) |
| TELLS-01a | MERGED #226 (arm A; arm B KILLED) | LIVE in its layer | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| TELLS-01b | DRAFT-PR #268 (FIXPR-268/2 done; security league check per SR 10 not confirmed) | MERGE NIGHT (section 6) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| COACH-01a | DRAFT-PR #249 (Step 0: bar not met; gate repeatability-only) | MERGE NIGHT (section 6) | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| COACH-01b | PLANNED (amended EA-10; COACH-TOOLS #298 covers plan/people reads) | HOMED (family) | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| UI-ENG-6 status strip | PLANNED (EA-03 #257 DRAFT) | BUILD NIGHT (section 5) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| UI-ENG-1 range bar | PLANNED | BUILD NIGHT (section 5) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| UI-ENG-2 autopsy card | PLANNED (#251 carries a My team card) | BUILD NIGHT (section 5) | #295 night 4 (one producer); #251 closed |
| UI-ENG-3 title-odds impact no click | PARTIAL (EA-07 #269 one world via #340; #192 one number) | HOMED (family) | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |
| UI-ENG-4 clone view | DRAFT-PR #270 (FIXPR-270 done) | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| UI-ENG-5 chess path | DRAFT-PR #290 | MERGE NIGHT (section 6) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| EA-00 spine v2 | MERGED (#216 via #278) | LIVE in its layer | see status |
| EA-01 LIVING-01a on spine v2 | BUILT-UNMERGED (#220 head 60f03eaf; #220 CLOSED superseded by BROKEN-H #280 DRAFT) | MERGE NIGHT (section 6) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| EA-02 engine daemon | MERGED (#242 via #278; lock race fixed; hub tick used 05:57) | LIVE in its layer | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| EA-03 snapshot + views + status + hook | DRAFT-PR #257 (needs retarget) | MERGE NIGHT (section 6) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| EA-04 outcomes as events + grader | DRAFT-PR #259 (PR titled "EA-05") | MERGE NIGHT (section 6) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| EA-05 monitor + fallback | DRAFT-PR #281 (PR titled "EA-06") | MERGE NIGHT (section 6) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| EA-06 one world | MERGED as #269 "EA-07 one world per NFL week" via #340 (title odds, trade cards, ceiling, posture) | LIVE in its layer | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| EA-07 wave-1 inputs then pages | PARTIAL (#269 covers the pages named; views my_team/start_sit/trade_lab/player/command_center UNKNOWN) | HOMED (family) | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |
| EA-08 Jev stage on snapshots | PLANNED (JEV-01a #248 pre-amendment) | BUILD NIGHT (section 5) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| EA-09 no-recompute ratchet | PARTIAL (ONE-READER ratchet + check:wiring in CI; allowlist doc UNKNOWN) | HOMED (family) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| EA-10 Coach reads state | PARTIAL (COACH-TOOLS #298; HEALTH-01c #250 OPEN) | PARTIAL: merged parts live, rest on its night | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| EA-11a search+rank | PARTIAL (ONE-PLANNER via #340 as the search; hub fields UNKNOWN) | PARTIAL: merged parts live, rest on its night | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| EA-11b lineup+waivers producers | PLANNED | HOMED (family) | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |
| EA-11c clone+market producers | PARTIAL (HUB-PUBLISH-PEOPLE #315 via #340 publishes people.profile/counterpart) | HOMED (family) | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |
| EA-11d league.analysis/proj.season | PLANNED | HOMED (family) | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |
| EA-12 wave-3 | PLANNED | HOMED (family) | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |
| SELF-01a follow ledger | UNKNOWN (#245 closed -> #255 closed "category A"; whether follow_ledger 082 is on main not confirmed; migratio | NIGHT 1: 15-min status check | #284 block 2 (E6 producer); SELF-01a night-1 status check |
| SELF-01b Nick clone + bias flags | DRAFT-PR #284 (FIXPR-284 done; clone waits #280) | MERGE NIGHT (section 6) | #284 block 2 (E6 producer); SELF-01a night-1 status check |
| LIVING-01a | BUILT-UNMERGED (see EA-01) | HOMED (family) | shadow (#261/#273); twins parked past 12/02 |
| LIVING-01b | DRAFT-PR #261 (rebuilt on main; PRE PASS team-level; FIX-3 blocked on #280/#229) | MERGE NIGHT (section 6) | shadow (#261/#273); twins parked past 12/02 |
| LIVING-01c (from PR) | DRAFT-PR #273 (fit null recorded, shift inert; R&D-confirmed IDEA-046) | HOMED (family) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| HEALTH-01a | MERGED (folded into EA-00 #216) | LIVE in its layer | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| HEALTH-01b+c | DRAFT-PR #250 (FIXER done) | MERGE NIGHT (section 6) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| HEALTH-01d+e | DRAFT-PR #256 (7 drills TODO pending #250) | MERGE NIGHT (section 6) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| BROKEN-01a+b | MERGED #237 via #299 (+#333 dot fix) | LIVE in its layer | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| BROKEN-01c | PLANNED (EA-05 #281 mentions HEALTH-01 rows) | BUILD NIGHT (section 5) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| META-01a | PLANNED (not launched) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| META-01b | PARTIAL: poller #199 MERGED; scheduled? not confirmed (output empty 9/23 23:44Z); grade script PLANNED | PARTIAL: merged parts live, rest parked | see status |
| META-01c | PLANNED | HOMED (family) | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| META-01d | PLANNED (needs key fix) | HOMED (family) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| META-01e | PARTIAL: holds 4->2 built on #164 (OPEN-PR); rate write DONE live 9/24; ESPN anchor needs Nick OK | PARTIAL: merged parts live, rest on its night | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| META-01f | PLANNED | HOMED (family) | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| ACQ-01 | SUPERSEDED (#267 closed -> ONE-PLANNER #311 via #340) | KILLED / ABSORBED (evidence in status) | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| FLIP-01 | SUPERSEDED (#265 closed -> campaign flip_map + #358/#362) | KILLED / ABSORBED (evidence in status) | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| CAMPAIGN-01a objective | MERGED (#230 + producer) | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| CAMPAIGN-01b path + playbook | MERGED (#233 + #306 + #361) | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| CAMPAIGN-01c always replanning | PARTIAL (refresh-tick; PULSE-01; PUSH-01 #293 OPEN; daemon subscription PLANNED) | PARTIAL: merged parts live, rest on its night | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| CAMPAIGN-01d risk modes | MERGED | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| CAMPAIGN-01e learn from every move | PARTIAL (offer loop #239; STEP-LOG #335 OPEN; E2 not enough data) | PARTIAL: merged parts live, rest on its night | L10 live; #335 night 4; #247 when a night has room |
| CAMPAIGN-01f Coach navigator | MERGED COACH-NAV #325 via #340 | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| CAMPAIGN-01g speed | MERGED CATCHUP-LIVE #350 via #364 | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| EVAL-01 E1 | MERGED grader; RESULT: no ranking skill (AUC 0.56 L4); E1-DATA #324 one producer (76 answered = 37 graded + 39 | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| EVAL-01 E2 | MERGED grader; not enough data | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| EVAL-01 E3 | MERGED; PASS Sleeper; ESPN inconclusive/over-confident #322 | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| EVAL-01 E4 | MERGED #294 via #340: +0.0011 [-0.0046,+0.0069] NOT proven; E4-REDO QUEUED r54 | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| EVAL-01 E5 | DRAFT-PR #335 STEP-LOG | MERGE NIGHT (section 6) | L10 live; #335 night 4; #247 when a night has room |
| EVAL-01 E6 | DRAFT-PR #284 (needs SELF-01a log) | MERGE NIGHT (section 6) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| EVAL-01 E7 | DRAFT-PR #295 / #251 | MERGE NIGHT (section 6) | #295 night 4 (one producer); #251 closed |
| EVAL-01 "Is the brain working?" card + Balanced fallback | MERGED (brain_check; FIX-05 #274 via #317) | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| REASON-01 | MERGED #234 + #279; grading REASON-02 #271 via #359 | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| ES loop-stage map extras: chaos drills, daily canary | DRAFT-PR #256 | MERGE NIGHT (section 6) | see status |
| ES fact 5b OFFER-01 wires trade_outcomes writers | MERGED #239 | LIVE in its layer | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| ES fact 5c trade deadline reader | PLANNED (DEADLINE-01) | HOMED (family) | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| ES "Loop 1/2/3 launch order" | SUPERSEDED (by the ARCHITECTURE UNITS order EA-00..EA-12 and then by the north-star/INT batches) | KILLED / ABSORBED (evidence in status) | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |

## C.7 TRADE-MACHINE-PLAN.md (v2 fixes, TM-09..15, playbook, RS, bu

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| TMP v2.1 their-eyes value = market price + ESPN screen; sentiment as tag | MERGED: TM-09 #183; FantasyCalc value base (AI-01 declined); chat lift removed (SR 2); HIS-SCREEN #344 | LIVE in its layer | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| TMP v2.2 backtest leakage + N1 cookie | DECLINED/PARTIAL: RL-8-2 #196 fails, #207 declined; N1 still owed (local collector reads cookies; live server  | KILLED / ABSORBED (evidence in status) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| TMP v2.3 decision tree replanned weekly | MERGED (campaign path + backup; replans per refresh) | LIVE in its layer | see status |
| TMP v2.4 analyst confidence + "how it looks if wrong" | PARTIAL (REASON-01 devil's advocate; REASON-02 grading) | PARTIAL: merged parts live, rest on its night | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| TMP v2.5 league rules A-01 (review window, veto, deadline, roster) | PARTIAL: CE-05 #168 MERGED; veto votes read (vetoVotesRequired); deadline reader PLANNED | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| TMP v2.6 Nick's biases priced at market | MERGED NO-OVERPAY #372 + protect-mine #373; endowment KILLED as a bias (econometrics lens) | LIVE in its layer | #284 block 2 (E6 producer); SELF-01a night-1 status check |
| TMP v2.7 evaluate a counter in one tap | MERGED #327 + #344 | LIVE in its layer | see status |
| TM-09 market prices | MERGED #183 (+ S-19 #187) | LIVE in its layer | see status |
| TM-10 ESPN trade-block flags | PLANNED (payload has tradeBlock; reader not found; #76 "The block a manager clicks" OPEN draft may relate, unv | BUILD NIGHT (section 5) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| TM-11 injury timelines | PARTIAL (scripts/fit-availability-return.mjs; #357 preview; moonshot web timelines NULL vs free prior) | HOMED (family) | L1 p_play role cells live (#357 preview); CE-03 spells parked; injury timing into ROS block 4 |
| TM-12 forward schedule strength | KILLED (R6 oracle kill); implied totals stay a sim input | KILLED / ABSORBED (evidence in status) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| TM-13 role/opportunity signals | DRAFT-PR #377 (O1-RADAR) + O2-ML stopped | MERGE NIGHT (section 6) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| TM-14 public hype | KILLED (r5 Wikipedia three-arm test) | KILLED / ABSORBED (evidence in status) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| TM-15 Nick's voice | MERGED VOICE-01 #331 via #359; VOICE-02/03 DECLINED (#338) | LIVE in its layer | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| Playbook: anchor + MESO | PARTIAL (opening/walk-away merged; MESO menu IDEA-025 INCONCLUSIVE, IDEA-054 untested) | HOMED (family) | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| Playbook: justify on his need | MERGED (COACH-MSG grounded) | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| Playbook: frame the loss | PLANNED (IDEA-071 untested) | HOMED (family) | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |
| Playbook: quantity illusion 2-for-1 | MERGED (ONE-PLANNER 2-for-1; IDEA-038) | LIVE in its layer | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| Playbook: social proof ESPN analyzer | PARTIAL (HIS-SCREEN fair badge #304 OPEN / #344 MERGED) | PARTIAL: merged parts live, rest on its night | see status |
| Playbook: timing (loss, bye, deadline, active hours) | PARTIAL: tilt weak (r11); deadline KILLED (IDEA-051); M7-TIMING #296 OPEN; active hours -> P(responds) | PARTIAL: merged parts live, rest on its night | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| Playbook: repeated game cap + fairness ledger | DRAFT-PR #264 REP-01 | MERGE NIGHT (section 6) | live (#275 one counter); REP-01 block 3 capped |
| Playbook: trade-then-claim | PLANNED (RS-03; IDEA-067 untested) | HOMED (family) | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| Playbook: endowment -> sell hype, buy with quantity | PARTIAL (S-19 hype producer; Buy Low label fix #209) | PARTIAL: merged parts live, rest parked | see status |
| RS-01 (=TM-06) | DECLINED (#196/#207) | KILLED / ABSORBED (evidence in status) | see status |
| RS-02 acceptance/timing | DONE-NO-PR (R&D: tilt weak r11; deadline KILLED r48; bye crunch not shown) | LIVE in its layer | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| RS-03 trade-then-claim | PLANNED | HOMED (family) | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| RS-04 hype decay | PARTIAL (TM-09: hype decays modestly c 0.252 vs placebo 0.154) | PARTIAL: merged parts live, rest parked | see status |
| RS-05 2-for-1 outcomes | DONE-NO-PR (R14 stud premium confirmed -> RL-9-3b; IDEA-045 KILLED) | LIVE in its layer | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| RS-06 injury-adjacent sells | PLANNED (R7 borrowed-role fill-in RL-7-1 held until PROJ-03-c) | BUILD NIGHT (section 5) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| Build order 1: dossiers + TM-09 + TM-11 + TM-12 | PARTIAL (dossiers local; TM-09 MERGED; TM-11 partial; TM-12 KILLED) | HOMED (family) | L1 p_play role cells live (#357 preview); CE-03 spells parked; injury timing into ROS block 4 |
| Build order 2: TR-01, TR-03, TM-06/RS-01 | PARTIAL (TR-01 DONE; TR-03 partial #166 OPEN; TM-06 DECLINED) | HOMED (family) | killed as ranker (r53); thresholds + display; NO-OVERPAY live; WIN-VALUE declined |
| Build order 3: TM-01..05 + counter evaluator | PARTIAL (see TMM rows) | PARTIAL: merged parts live, rest on its night | killed as ranker (r53); thresholds + display; NO-OVERPAY live; WIN-VALUE declined |
| Build order 4: TM-07 analyst + TM-08 research feed | PARTIAL (REASON-01 MERGED; TM-08 PLANNED) | PARKED | parked (paid research feed) |
| Weekly "trade machine contribution" line | PLANNED (STEP-LOG #335 OPEN is the closest) | BUILD NIGHT (section 5) | L10 live; #335 night 4; #247 when a night has room |
| Decisions owed: N1, analyst cap, N12, deploy word | PARTIAL: Anthropic cap approved 9/23 ($0.50/day); N1, N12, deploy word still owed | PARTIAL: merged parts live, rest parked | see status |
| TM-16 digital twin per manager | HELD TWIN-01; COUNTERPART-02 #302 DECLINED; COUNTERPART-02b QUEUED; COACH-ROLEPLAY #301 OPEN | BUILD NIGHT (section 5) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| TM-17 pain calendar + live offense | DEMOTED (r11 tilt weak); WEAK-01/02 attack surfaces MERGED as the partial | HOMED (family) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| TM-18 regression radar | KILLED (R8 priced by consensus; AI-08 cliff KILLED r6); role-shrinking labels #209 MERGED | KILLED / ABSORBED (evidence in status) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| TM-19 playoff-week specialist | KILLED r6 then PARTIAL: R9 final-week rest (RL-9-1 replicated, PLANNED) + playoff weight #236 MERGED | KILLED / ABSORBED (evidence in status) | live (RL-16-1 merged); further weighting killed (r6/IDEA-068) |
| TM-20 contender-aware trading | PARTIAL: RL-19-3 title-mutual #240 MERGED; CATCHUP sellers <5% (#350); IDEA-050 untested | HOMED (family) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| TM-21 experiment engine | PARTIAL (pitch arms in #239; bandit #263 DRAFT; needs offers) | PARTIAL: merged parts live, rest on its night | see status |
| TM-22 pre-mortem + receipts | PARTIAL (REASON-01 devil's advocate; rec_ledger +1/+2/+5 #174; STEP-LOG #335) | PARTIAL: merged parts live, rest on its night | L10 live; #335 night 4; #247 when a night has room |
| TM-23 arbitrage chains | MERGED (flip map + legs); 3-way cycles PLANNED | LIVE in its layer | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| TM-24 reputation radar | DRAFT-PR #264 + selfRead "how Nick looks" (existing) | MERGE NIGHT (section 6) | live (#275 one counter); REP-01 block 3 capped |
| TM-25 waiver-flip | PLANNED (IDEA-133 untested) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| TM-26 war room on Trades tab | MERGED (War Room in Trade Brain) | LIVE in its layer | see status |
| TM-27 / ST-01 availability oracle | PARTIAL (role-cell model; #357 preview; practice-pattern IDEA-078 untested) | HOMED (family) | L1 p_play role cells live (#357 preview); CE-03 spells parked; injury timing into ROS block 4 |
| TMP "will NOT do" list (auto-send, false claims, collusion, >1 follow-up, over-trading) | DONE-NO-PR (rules in COACH-ANCHOR guardrails; never sends) | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| ST-02 matchup-aware lineup (win this matchup) | PARTIAL (posture by stage DONE; #169; ceiling button uncalibrated R3; deprioritised in PLAN v9) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| ST-03 late-swap engine | PARTIAL (#171 kicked-off swaps; SS-01 #185; RL-10-1 #198 default-off; #184 OPEN) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| ST-04 bounded autopilot | PLANNED (needs N12) | KILLED / ABSORBED (evidence in status) | KILLED: Nick never auto-sends offers |
| ST-05 dead-money audit | PARTIAL (AUTOPSY-01 #295 OPEN; #189 lineup signals) | PARTIAL: merged parts live, rest on its night | #295 night 4 (one producer); #251 closed |
| ST-06 bye/schedule planner | PARTIAL (#179; RL-5-3 bye range; 3-week plan PLANNED) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| TM-28 their-screen simulator | MERGED HIS-SCREEN-FIX #344 via #359 (his-screens.json); RS-07 reverse-engineer verdict PLANNED | LIVE in its layer | see status |
| TM-29 matchup arbitrage | PLANNED (RS-08 untested) | PARKED | parked past 12/02 |
| TM-30 reaction lag per manager | PARTIAL (tells factory; IDEA-069 untested) | HOMED (family) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| TM-31 package optimizer | MERGED (ONE-PLANNER 2-for-1); MESO PLANNED | LIVE in its layer | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| TM-32 objection playbook | PARTIAL (COACH-NEGOTIATE replies; per-manager objections from chat not confirmed) | HOMED (family) | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| TM-33 portfolio view | PLANNED (IDEA-024 untested) | HOMED (family) | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| TM-34 deadline endgame | PLANNED (DEADLINE-01) | BUILD NIGHT (section 5) | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| Weekly rhythm (Tue/Wed-Thu/Thu 8:15/Sun windows) | PARTIAL (refresh loop; explicit windows not scheduled) | PARTIAL: merged parts live, rest parked | see status |
| TM-35 paper-value stuffers | PLANNED (IDEA-053 untested) | HOMED (family) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| TM-36 auction mode | PLANNED | PARKED | parked past 12/02 |
| TM-37 buy-back tracker | PLANNED (IDEA-080 untested) | HOMED (family) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| TM-38 handcuff market | PLANNED (IDEA-120 untested) | HOMED (family) | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |
| TM-39 scoring-rule mispricing scanner | PARTIAL (#163 scoring map, #201 overrides MERGED; scanner PLANNED) | PARTIAL: merged parts live, rest parked | see status |
| TM-40 chat listener | MERGED PULSE-01 #316 via #340 (+ PULSE-02 #369 OPEN) | LIVE in its layer | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| TM-41 loss-leader trades | PLANNED (IDEA-027 INCONCLUSIVE) | HOMED (family) | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| TM-42 replacement-level pricing | PARTIAL (RL-9-3 #200 roster-spot value MERGED) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| ST-07 recency-bias guard | PARTIAL (role labels #209; explicit guard PLANNED) | PARTIAL: merged parts live, rest parked | see status |
| ST-08 weather/venue | KILLED as a projection signal (R7); range effect PLANNED | KILLED / ABSORBED (evidence in status) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| ST-09 bench built for late swaps | PLANNED | PARKED | parked (start/sit extras do not repeat: skill study) |
| ST-10 live points-needed tracker | PLANNED (CE-08) | PARKED | parked past 12/02 |
| ST-11 weekly grade of three lineups | PARTIAL (C-01 #160 vs ESPN) | PARTIAL: merged parts live, rest parked | see status |
| CE-01 game-environment sampler | DECLINED (PROJ-03-a x2) | KILLED / ABSORBED (evidence in status) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| CE-02 shares-conditional sampler | PLANNED (PROJ-03-b) | BUILD NIGHT (section 5) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| CE-03 availability sampling | PLANNED (see ES) | BUILD NIGHT (section 5) | L1 p_play role cells live (#357 preview); CE-03 spells parked; injury timing into ROS block 4 |
| CE-04 opponent behaviour models | DRAFT-PR (LIVING-01a/b/c #280/#261/#273) | MERGE NIGHT (section 6) | shadow (#261/#273); twins parked past 12/02 |
| CE-05 league rules/brackets | MERGED #168 | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| CE-06 event bus + incremental re-sim | MERGED EA-02 #242 via #278 (dirty bits, snapshots) | LIVE in its layer | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| CE-07 planner MCTS | PARTIAL (ONE-PLANNER search; CHESS-01a #258 DRAFT) | PARTIAL: merged parts live, rest on its night | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| CE-08 live Sunday ticker | PLANNED | PARKED | parked past 12/02 |
| CE-09 title-odds currency + ladder | PARTIAL (#192 #225 #241 MERGED; ladder folded EA-06) | PARTIAL: merged parts live, rest on its night | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| CE-10 grading | PARTIAL (EVAL-01 #235; EA-04 #259 DRAFT) | PARTIAL: merged parts live, rest on its night | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| AI-01 true-value engine | DECLINED #181 (v1) and #376 (v3, OPEN docs PR) | KILLED / ABSORBED (evidence in status) | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| AI-02 usage forecaster | RUNNING-STOPPED (O2-ML; removed from the queue as "O2-ML is it") | BUILD NIGHT (section 5) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| AI-03 situation reader multi-model | RUNNING-STOPPED (O3-JEV; never reached a fit); META-01d PLANNED | BUILD NIGHT (section 5) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| AI-04 market-price model | QUEUED (BQ; TM-09 #183 gives the median price) | BUILD NIGHT (section 5) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| AI-05 acceptance PU model | DRAFT-PR #229 (PU positives arm DECLINED FIX-229-2) | HOMED (family) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| AI-06 manager twins | HELD (TWIN-01); persona KILLED r17 | BUILD NIGHT (section 5) | shadow (#261/#273); twins parked past 12/02 |
| AI-07 source inference | PLANNED | PARKED | parked past 12/02 |
| AI-08 regression classifier | KILLED (r6 cliff; r8 priced) | KILLED / ABSORBED (evidence in status) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| AI-09 value network | PLANNED (not tested) | BUILD NIGHT (section 5) | see status |
| AI-10 pitch/objection LLM in Nick's voice | MERGED (COACH-MSG + VOICE-01) | LIVE in its layer | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| AI-11 Nick preference model | PARTIAL (skip log; learning PLANNED) | HOMED (family) | #284 block 2 (E6 producer); SELF-01a night-1 status check |
| AI-12 model zoo leaderboard | PARTIAL (BENCHMARKS.md; brain_report) | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| NX-01 pre-projection window | PARTIAL (poller #199 MERGED; lag not graded; AI-16 PLANNED) | PARTIAL: merged parts live, rest parked | see status |
| NX-02 IR-slot arbitrage | PLANNED | PARKED | parked (IR-slot mechanic; note for A.J. Brown on IR) |
| NX-03 bench tells | KILLED-ish: LS-01 #189 MERGED with "FAILED its pre-registered test" label | KILLED / ABSORBED (evidence in status) | see status |
| NX-04 drop watch | PLANNED (R15 confirmed buildable, not built) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| NX-05 cross-league pricing | PLANNED (IDEA-014 linked managers KILLED) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| NX-06 chat hype leading indicator | INCONCLUSIVE (PEOPLE-ANCHOR/STREET) | KILLED / ABSORBED (evidence in status) | see status |
| NX-07 position runs | PLANNED | PARKED | parked past 12/02 |
| NX-08 FantasyCalc as his-screen source | MERGED (FC-SNAP #170; FC value base; NO-OVERPAY) | LIVE in its layer | killed as ranker (r53); thresholds + display; NO-OVERPAY live; WIN-VALUE declined |
| NX-09 tiebreak mode | PLANNED | PARKED | parked past 12/02 |
| NX-10 playoff-week rentals | KILLED r6; R9 rest revived (PLANNED) | KILLED / ABSORBED (evidence in status) | live (RL-16-1 merged); further weighting killed (r6/IDEA-068) |
| TR-05 quality checks (correction) | PARTIAL (lineup gain vs paper on cards via lenses PLANNED; IR discount small; RL-8-1) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |

## C.8 TRADE-INSANE-RND.md (layers, loop stages, kill tests, additi

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| ONE ENGINE stage OBSERVE (engine_events) | MERGED (#216) | LIVE in its layer | see status |
| ONE ENGINE stage UNDERSTAND (engine_state, one producer per field) | MERGED spine; producers PARTIAL (people/tells/hub publish) | LIVE in its layer | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |
| ONE ENGINE stage SIMULATE (one simulator) | PARTIAL (#269 one world; copula retire PLANNED) | PARTIAL: merged parts live, rest parked | see status |
| ONE ENGINE stage DECIDE (one search) | PARTIAL (ONE-PLANNER; chess DRAFT) | PARTIAL: merged parts live, rest on its night | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| ONE ENGINE stage ACT (Coach one voice) | MERGED (COACH-* units) | LIVE in its layer | see status |
| ONE ENGINE stage LEARN (one grader) | PARTIAL (EVAL #235; EA-04 #259 DRAFT; autopsy #251 DRAFT) | PARTIAL: merged parts live, rest on its night | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| ALWAYS LEARNING: engine daemon always-on | PARTIAL (EA-02 merged; run as `engine-daemon --once` by hand 05:57; always-on process not confirmed) | HOMED (family) | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| ALWAYS LEARNING: per-event Bayesian updates | DRAFT-PR #288 (clone b2) | MERGE NIGHT (section 6) | see status |
| ALWAYS LEARNING: nightly refits | PARTIAL (CRED-01 nightly via #340; tells refit hook PLANNED) | HOMED (family) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| ALWAYS LEARNING: weekly autopsy + reweighting | DRAFT-PR #251 / PLANNED (META-01f) | MERGE NIGHT (section 6) | L11 graders on the tick (live) + SOURCE-TABLES night 7 |
| ALWAYS LEARNING: versioning | MERGED (engine_producer_versions in EA-00) | LIVE in its layer | see status |
| ALWAYS LEARNING: drift/health monitors | DRAFT-PR #281 (EA-05) + BROKEN-01 #237 MERGED | MERGE NIGHT (section 6) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| AND REASONS: reason chains on every number | MERGED (reason_chain v2 in EA-00; REASON-01 panels) | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| AND REASONS: hypothesis loop | DRAFT-PR #277 (01a); 01b PLANNED | MERGE NIGHT (section 6) | see status |
| AND REASONS: decisions with the argument | MERGED (REASON-01) | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| AND REASONS: autopsy reasons | DRAFT-PR #251 | MERGE NIGHT (section 6) | see status |
| JEV ANCHORS: Jev at DECIDE, calibrated, graded | DRAFT-PR #248 / #289; r17/r34 Jev-as-predictor KILLED; no-cap ruling DONE | MERGE NIGHT (section 6) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| Build rule: every unit a stage of the loop | DONE-NO-PR (SWEEP rulings enforce one producer; FIELD-REGISTRY) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| ENGINE-00 spine | MERGED #216 | LIVE in its layer | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |
| Layer 1 clones | DRAFT-PR #229/#288 (b1 #239 MERGED); clone test: fails baseline -> default-off | MERGE NIGHT (section 6) | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| Layer 2 real value / projection stack | SUPERSEDED (BLEND-02 -> META-01; ESPN point) | KILLED / ABSORBED (evidence in status) | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| Layer 2 deep dive 1 Mistake Map | MERGED #222 (+#228 DRAFT) | LIVE in its layer | see status |
| Layer 2 deep dive 2 sharp chain | MERGED #221 default-off -> O1C-WIRE QUEUED | LIVE in its layer | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| Layer 2 deep dive 3 correlated sim + conformal | PLANNED (PROJ-03-b/c) | BUILD NIGHT (section 5) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| Layer 2 deep dive 4 source disagreement signal | PLANNED (META-01a lab) | PARKED | parked (no expert beats the ESPN point) |
| Layer 2 deep dive 5 speed (inactives, beat writers, weather, Sunday re-projection) | PARTIAL (#198 #204; poller #199; Sunday re-projection PLANNED) | HOMED (family) | live (SS-01, waiver priority); Sunday game-day checks in the weekly rhythm; K/DST done enough |
| Layer 2 deep dive 6 Monday Autopsy | DRAFT-PR #251 / #295 | MERGE NIGHT (section 6) | see status |
| Layer 2 deep dive 7 grade on decisions | MERGED C-01 #160 (start/sit vs ESPN) | LIVE in its layer | live (SS-01, waiver priority); Sunday game-day checks in the weekly rhythm; K/DST done enough |
| Historical training gaps (ESPN 2021/2025, weather) | DONE-NO-PR (ESPN 2021 archived; 2025 pulled local L162; pbp #218) | LIVE in its layer | see status |
| Layer 3 mispricing radar | MERGED (flip map) / RADAR-01 grading PLANNED | LIVE in its layer | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| Layer 4 title-odds chess | DRAFT-PR #258 | MERGE NIGHT (section 6) | see status |
| Layer 5 AI pitch (persona test) | KILLED persona (r17 AUC 0.47); pitch-only MERGED | KILLED / ABSORBED (evidence in status) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| Kill-or-confirm: clone test | RESULT: fails (C2-BASE 28.5%; r33 AUC 0.32) -> default-off | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| Kill-or-confirm: chess test | PLANNED (E4 partial) | KILLED / ABSORBED (evidence in status) | absorbed by E4-live (block 2) |
| Kill-or-confirm: radar test | PLANNED (RADAR-01-b) | HOMED (family) | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| OFFER-01 offer loop | MERGED #239 (+#332) | LIVE in its layer | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| DEADLINE-01 | PLANNED | HOMED (family) | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| MOTIVE-01 | DRAFT-PR #229 | HOMED (family) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| VETO-01 | DRAFT-PR #288 (fitted:false, n=1) | MERGE NIGHT (section 6) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| REP-01 | DRAFT-PR #264 | MERGE NIGHT (section 6) | live (#275 one counter); REP-01 block 3 capped |
| Corrections (37 decisions, veto unfit, no FC history, pbp gap, FP research-only) | DONE-NO-PR | LIVE in its layer | see status |
| FantasyPros ruling (internal only) | DONE-NO-PR (#165 guard; CT:28 for PLAYER-SCORE) | LIVE in its layer | #375 night 1; DRAFT-ID-MAP + LOVE-RULE + LADDER-01 night 5 |
| TELLS-01 tells factory | MERGED #226 / DRAFT #268 | LIVE in its layer | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| COACH-01 fix Coach (4 fixes) | DRAFT-PR #249 (fix 1); fixes 2-4 PLANNED (EA-10) | MERGE NIGHT (section 6) | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| LIVING-01 | DRAFT-PRs (#280 #261 #273) | MERGE NIGHT (section 6) | shadow (#261/#273); twins parked past 12/02 |
| SELF-01 | DRAFT-PR #284; 01a UNKNOWN | MERGE NIGHT (section 6) | #284 block 2 (E6 producer); SELF-01a night-1 status check |
| 4 lens explorers -> rnd/insane/*.md | DONE-NO-PR (SYNTHESIS.md 9/23) | LIVE in its layer | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |

## C.9 TRADE-MACHINE-MASTER.md (compiled 9/23 1:20 AM; v1 unit defi

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| TMM doc | SUPERSEDED by PLAN v10+ / ENGINE-SPECS / NORTH-STAR (engine first; then north star) | KILLED / ABSORBED (evidence in status) | see status |
| TM-01 finder ("fair on paper, wins for you") | SUPERSEDED (campaign producer + ONE-PLANNER; consensus gate RL-8-2 #196 FAILS) | KILLED / ABSORBED (evidence in status) | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| TM-02 why-it-ages-well tags | PARTIAL (#209 role labels, #194 rename MERGED; schedule tag KILLED r6; regression tag KILLED r8) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| TM-03 target board | OPEN-PR #190 (conflicts fixed 9/23; War Room targets section supersedes) | MERGE NIGHT (section 6) | see status |
| TM-04 pitch ladder + counter evaluator | MERGED (COACH-MSG/MSG-WIRE-2/COACH-NEGOTIATE) | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| TM-05 decision tree | MERGED (campaign path + backup; RoadmapTree UI = itinerary) | LIVE in its layer | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| TM-06 proof + ledger backtest | DECLINED (#196/#207) + ledger MERGED (#174/#94) | KILLED / ABSORBED (evidence in status) | see status |
| TM-07 analyst layer | MERGED as REASON-01 #234 | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| TM-08 research feed | PLANNED | PARKED | parked (paid research feed) |
| LS-01 lineup-signal tracker | MERGED #189 (label: failed its test) | LIVE in its layer | see status |
| DD-01 doomsday cards | PLANNED (not found in any PR) | PARKED | parked past 12/02 |
| GT-01 game-theory layer | PARTIAL (RL-19-3 title-mutual #240; rival-aware planner PLANNED; IDEA-050) | HOMED (family) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| LL-01 luck ledger | PLANNED (luck-panel.mjs exists; served ledger not found; luck term retired #353) | KILLED / ABSORBED (evidence in status) | absorbed by the LOVE luck sentence (weight 0, r8) |
| TMM UI: My team ladder/doomsday/luck/portfolio | PARTIAL (ladder folded into EA-06 PLANNED; #180 My team tab MERGED) | PARTIAL: merged parts live, rest on its night | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| TMM build order 1-6 | SUPERSEDED (PLAN v10 engine first; then north star) | KILLED / ABSORBED (evidence in status) | see status |
| TMM decisions owed (N1, Jev cap, N12, deploy word, autopilot scope) | PARTIAL (Jev no-cap ruling DONE; others owed) | HOMED (family) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |

## C.10 COORD-TASKS.md (tasks 1-30; task 24 is absent from the file)

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| CT-1 verify-warroom after every merge | DONE-NO-PR (runs 03:44, 05:10, 05:51, 07:40, 08:00, 08:39 all logged) | LIVE in its layer | see status |
| CT-2 browser audits at 1440x900 + 375x812 | DONE-NO-PR (03:43, 04:55, 05:12, 08:10, 08:15 shots) | LIVE in its layer | see status |
| CT-3 review each finished PR's diff for the 10 AM path | PARTIAL (04:09 review of #334/#335 logged; others not logged) | PARTIAL: merged parts live, rest on its night | see status |
| CT-4 after int4: intake, restart refresh L4, re-run plan, verify | DONE-NO-PR (after-int4 05:51) | LIVE in its layer | see status |
| CT-5 morning brief current | DONE-NO-PR (evidence/MORNING-BRIEF.md 09:32) | LIVE in its layer | see status |
| CT-6 cloud session checks | DONE-NO-PR (04:10) | LIVE in its layer | see status |
| CT-7 tighten tests where reviewers found gaps | PLANNED | BUILD NIGHT (section 5) | ops: night 10 benchmarks ratchet |
| CT-8 produce-plans of: r.of token | DONE (#345) | LIVE in its layer | see status |
| CT-9 int4 ETA watch + releases | DONE-NO-PR (#340 merged 05:29) | LIVE in its layer | see status |
| CT-10 brief location | DONE-NO-PR | LIVE in its layer | see status |
| CT-11 plan re-run with basis, 'I sent it' | DONE (05:51, basis 9/9) | LIVE in its layer | L10 live; #335 night 4; #247 when a night has room |
| CT-12 E2E B10b real test | DONE (#339) | LIVE in its layer | see status |
| CT-13 attention.js no-move wording | DONE (delegated to #345) | LIVE in its layer | see status |
| CT-14 auto-intake v4 holds | DONE-NO-PR (04:40) | LIVE in its layer | see status |
| CT-15 nick_voice_profile live build | DONE-NO-PR (after-int5 07:26) | LIVE in its layer | see status |
| CT-16 Coach dock shows the morning brief | DONE (COACH-BRIEF-UI #343 via #359) | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| CT-17 retarget stacked PRs | SUPERSEDED by INT5 | KILLED / ABSORBED (evidence in status) | see status |
| CT-18 10 AM-critical builds order | DONE (via INT5) | LIVE in its layer | see status |
| CT-19 zero luck_self_view | DONE (#353 via #364) | LIVE in its layer | see status |
| CT-20 INT5 | DONE (#359 MERGED) | LIVE in its layer | see status |
| CT-21 int4 follow-ups FIX-320-2 / FIX-294-2 / FIX-311-1 | PARTIAL: FEAS-140-ESPN-WIRE #371 OPEN; E4-REDO QUEUED; produce-plans --tick caller -> REFRESH-L4 done | PARTIAL: merged parts live, rest on its night | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| CT-22 INT6 | DONE (#364 MERGED) | LIVE in its layer | see status |
| CT-23 AVAIL-HORIZON fallback wording | DONE (#357 preview override + brief states the gap) | LIVE in its layer | L1 p_play role cells live (#357 preview); CE-03 spells parked; injury timing into ROS block 4 |
| CT-25 after INT6: resume intake order, #258 conflict fix | PARTIAL (intake paused again until 10 AM; #258 conflict fix PLANNED) | PARTIAL: merged parts live, rest on its night | see status |
| CT-26 flip-flag fallback | SUPERSEDED (moot: #362 made INT6) | KILLED / ABSORBED (evidence in status) | see status |
| CT-27 freeze until 10:00 | DONE-NO-PR | LIVE in its layer | see status |
| CT-28 PLAYER-SCORE must strip FantasyPros display | PLANNED (#375 ready but "FantasyPros display strip still required before merge") | BUILD NIGHT (section 5) | #375 night 1; DRAFT-ID-MAP + LOVE-RULE + LADDER-01 night 5 |
| CT-29 LOVE check: luck zero weight | DONE-NO-PR (spec updated; ROADMAP-TIERS QUEUED carries it) | LIVE in its layer | #375 night 1; DRAFT-ID-MAP + LOVE-RULE + LADDER-01 night 5 |
| CT-30 refresh master plan §00 B+F | PLANNED (doc-only; this inventory feeds it) | KILLED / ABSORBED (evidence in status) | absorbed: this ONE PLAN supersedes master plan section 00 B+F |

## C.11 SWEEP-RULINGS.md (rulings that killed or merged items; lanes

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| SR-1 ONE profile reader (#260); #253 closed; #254/#270 drop copies; nick-block folded | DONE (#260 via #340; FIXPR-270 done; FIX-260-CI folded nick-block) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| SR-2 ONE counterpart (#254 -> #313); no chat lift in P(yes) | DONE (#313 via #340; chat lift max dP 0.95 -> 0) | LIVE in its layer | see status |
| SR-3 ONE fallback rule (#250 state.js); #257/#281 call it | PARTIAL (FIXER #257 done; #250/#257/#281 all OPEN) | PARTIAL: merged parts live, rest on its night | see status |
| SR-4 ONE fatigue counter (#275); #264 reads it | DONE (#275 via #317; FIXER #264 done) | LIVE in its layer | live (#275 one counter); REP-01 block 3 capped |
| SR-5 ONE flip producer (campaign); #265 = runner + nick block | DONE (#265 CLOSED superseded; FLIP-LEGS carries the nick block) | LIVE in its layer | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| SR-6 close #220 #245 #253 as superseded | DONE | LIVE in its layer | see status |
| SR-7 migrations from MIGRATIONS.md only (093 #184, 094 #284 freed) | DONE (registry) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| SR-8 flags through preview-mode.js | DONE (FIXERs for #263 #264 #277 #285 #286 etc.) | LIVE in its layer | see status |
| SR-9 wiring-map surfaces fix (FIX-279-1) | DONE (#299 'process' surface kind) | LIVE in its layer | see status |
| SR-10 #268 tells route league check (security) | PARTIAL (FIXPR-268 done 10:41Z; assertLeagueMember not explicitly confirmed) | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| SR-11 ONE planner (#267 inside the producer) | DONE (#311 via #340) | LIVE in its layer | see status |
| SR-12 ONE "this week" (#291 blend.week); #166 folded | PARTIAL (#291 OPEN; FIX-166-3 PLANNED) | PARTIAL: merged parts live, rest on its night | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| SR-13 LIVING-01c ships; 01b guard | PARTIAL (FIXER #261 done; both OPEN) | PARTIAL: merged parts live, rest on its night | shadow (#261/#273); twins parked past 12/02 |
| SR-14 War Room UI order FIX-04 then FIX-06 | DONE (#317) | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| SR-15 migration numbers 092/095/096/091/097 | DONE | LIVE in its layer | see status |
| SR-16 #246 E1 needs-N formula + trade_outcomes source | PARTIAL (E1-DATA #324 via #340; #246 OPEN in gh, on main per OPS) | PARTIAL: merged parts live, rest on its night | L10 live; #335 night 4; #247 when a night has room |
| SR-17 nick flags owned by the reader; typed counterpart fields (#313) | DONE (#313 via #340) | LIVE in its layer | see status |
| SR-18 blend-week.js one producer; #164 becomes a layer | QUEUED (FIXPR-164b local queue) | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |

## C.12 Lane queues (build-queue.json, build-queue-held.json, workfl

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| O1C-WIRE | QUEUED (after #377 merges) | BUILD NIGHT (section 5) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| ROADMAP-TIERS | QUEUED (after PLAYER-SCORE #375 + NO-OVERPAY #372 MERGED) | BUILD NIGHT (section 5) | killed as ranker (r53); thresholds + display; NO-OVERPAY live; WIN-VALUE declined |
| TRADE-LENSES | QUEUED | HOMED (family) | killed as ranker (r53); thresholds + display; NO-OVERPAY live; WIN-VALUE declined |
| AI-04 | QUEUED | BUILD NIGHT (section 5) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WIN-VALUE | QUEUED (NO-OVERPAY merged -> unblocked) | BUILD NIGHT (section 5) | killed as ranker (r53); thresholds + display; NO-OVERPAY live; WIN-VALUE declined |
| COUNTERPART-02b | QUEUED (stopped 09:1x for disk/RAM) | HOMED (family) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| RB-TITLE | QUEUED (RUNNING-STOPPED 09:25; relaunch after 10 AM) | BUILD NIGHT (section 5) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| TWIN-01 | HELD (converge gate) | HOMED (family) | shadow (#261/#273); twins parked past 12/02 |
| E4-REDO | QUEUED (RUNNING-STOPPED 09:25 after 74 min of sims) | BUILD NIGHT (section 5) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| FIXPR-247 (FIX-247-2) | QUEUED (parked until 9/27) | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| FIXPR-164 (FIX-164-4) | QUEUED (parked) | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| FIXPR2-309/295/305/310/323/301/307/319 | QUEUED | HOMED (family) | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| FIXPR-164b | QUEUED | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| FIXPR-261 | QUEUED (FIXPR-261 already ran once 07:35; re-queued entry) | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| FIXPR2-308 | RUNNING-STOPPED (bench killed 09:25; FIX-308-3 partial) | HOMED (family) | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| FIXPR2-304 | RUNNING-STOPPED (killed at STOP ALL 09:47) | HOMED (family) | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| cloud-launched FIXB batches (276-274-282, 230-234-184, 243-264-290, 258-281-250, 257-259-2 | PARTIAL (FIXB-193-190-256 and FIXB-228 pushed; FIXB-262-289-248 and FIXB-245-166-207 silent at 30 min; FEAS-14 | PARTIAL: merged parts live, rest on its night | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| cloud-done list (32 PRs: COUNTERPART-01 FIX-00 FIX-10 FLIP-01 ACQ-01 TELLS-01b EA-07 UI-EN | DONE-NO-PR as a list; each PR's own status is in C.6/C.17 | LIVE in its layer | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| Units stopped at STOP ALL 09:47: O2-ML, O3-JEV, O1-RADAR (-> #377 ready), PLAYER-SCORE (-> | RUNNING-STOPPED (three produced ready PRs before the stop) | BUILD NIGHT (section 5) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |

## C.13 Other local handoff plan docs (BUILD-PLAN, COACH-ANCHOR, NEX

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| BUILD-PLAN v2 Stage 0 CONVERGE | DONE-NO-PR except "<35 open PRs" (replaced by "rebaser/fixer clearing" 02:01) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| BUILD-PLAN v2 Stage 1 TRUTH CHECK (SCALE-140, ESPN-history calibration, E1 beats activity, | PARTIAL: SCALE-140 fixed 78->124-128 via #314/#318 + availability fit; E3-ESPN over-confident; E1 not beating  | PARTIAL: merged parts live, rest on its night | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| BUILD-PLAN v2 Stage 2 TWIN-01 + WEAK-01 + self-play check | PARTIAL: WEAK-01 #326 / WEAK-02 #360 MERGED; TWIN-01 HELD; self-play check PLANNED | HOMED (family) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| BUILD-PLAN v2 Stage 3 VOICE-01 | MERGED #331 via #359 (VOICE-02/03 DECLINED) | LIVE in its layer | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| BUILD-PLAN v2 Stage 4 FUSION-01 / CLONE-NN / JEV-CROSS | KILLED CLONE-NN (r33), JEV-CROSS (r34); FUSION-01 INCONCLUSIVE (r33) | KILLED / ABSORBED (evidence in status) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| BUILD-PLAN v2 Stage 5 screens (War Room v3, Coach jobs 1-6, COACH-LINK), always-on, report | PARTIAL: War Room v3 MERGED; COACH-LINK #310 OPEN; PRODUCER-FAST #308 OPEN; PUSH #293 OPEN; STEP-LOG #335 OPEN | PARTIAL: merged parts live, rest on its night | L10 live; #335 night 4; #247 when a night has room |
| BUILD-PLAN Phase 0 units (merge batch 1/2, FIX-00..11) | DONE: batches #278 #299 #317; FIX-00 #260, FIX-02..08 via #317/#340, FIX-09 #266, FIX-10 #262, FIX-11 smoke 8/ | LIVE in its layer | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| BUILD-PLAN Phase 1 (FIX-03/04/05/06, WR-L4, FEAS-140, COACH-MSG) | MERGED (all via #317/#340/#328) | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| BUILD-PLAN Phase 2 people brain (PEOPLE-01, PEOPLE-02+SHOT-01, COUNTERPART-02, TELLS-01b,  | PARTIAL: PEOPLE-01 -> #260 MERGED; PULSE-01 #316, CRED-01 #321 MERGED via #340; COUNTERPART-02 DECLINED -> 02b | PARTIAL: merged parts live, rest on its night | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| BUILD-PLAN Phase 3 always-on (PRODUCER-FAST, STEP-LOG, PUSH-01, EA-06/07, CATCHUP-LIVE, NE | PARTIAL: CATCHUP-LIVE #350 + NEGOTIATE-UI-FIX #337 MERGED; PRODUCER-FAST #308, STEP-LOG #335, PUSH-01 #293 OPE | PARTIAL: merged parts live, rest on its night | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| BUILD-PLAN Phase 4 report card (E1..E7, M1-M10 stats) | PARTIAL (see EVAL rows; M-stats card PLANNED) | HOMED (family) | #295 night 4 (one producer); #251 closed |
| COACH-ANCHOR jobs 1-6 (navigator, negotiator, people reader, analyst, screen driver, memor | MERGED: 1 COACH-NAV #325; 2 COACH-NEGOTIATE #327 + COACH-MSG; 3 people_read via COACH-TOOLS #298 (roleplay #30 | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| COACH-ANCHOR tools (plan_read, people_read, pulse_read, brain_read, health_read, what_if,  | PARTIAL: plan/people/pulse/brain/health MERGED (#298 + FIX-298-PULSE); itinerary_edit #325; ui_action #230; lo | PARTIAL: merged parts live, rest on its night | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| COACH-ANCHOR build units COACH-TOOLS/NAV/NEGOTIATE/ROLEPLAY/BRIEF | MERGED except COACH-ROLEPLAY #301 OPEN, COACH-LINK #310 OPEN | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| NEXT-TASKS Waves A-F (9/24 12:40 AM plan) | PARTIAL: Waves A-C DONE by 08:00 (batches, L4-PLAN, FIX-11, brief); Wave D (people brain Thu) PARTIAL; Waves E | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| NIGHT-PLAN lanes + KEEPER SWAP | DONE-NO-PR lanes running; KEEPER-DURABLE lane-keeper-v2 built, NOT swapped in (deliberately before 10 AM) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| PEOPLE-01 one reader | MERGED (#260 via #340; #253 closed) | LIVE in its layer | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| PEOPLE-02 nightly profile refresh | UNKNOWN (BUILD-PLAN says "local PR pending review"; migration 085 reserved with SHOT-01; no PR in gh list) | NIGHT 1: 15-min status check | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| PEOPLE-03 R&D test of new fields | INCONCLUSIVE (leaning harmful) | KILLED / ABSORBED (evidence in status) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| CAMPAIGN-PEOPLE counterpart model at 10 steps | SUPERSEDED (#252 closed) by ONE-COUNTERPART #313 via #340 + COUNTERPART-02/02b | KILLED / ABSORBED (evidence in status) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| M1 targets (sellers-to-be) | PARTIAL (WEAK-02 #360 seller ranking; M1 frustrated/shop noise per PEOPLE-LAB) | HOMED (family) | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| M2 partner order | MERGED (P(responds) x edge; PARTNER-KERNEL #354; FIX-02 partner pool) | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| M3 price yes-point | PARTIAL (yes_point served via #313; PRICE-BAND; count-neutral belief INCONCLUSIVE) | HOMED (family) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| M4 package (what he wants) | MERGED as standing interest only (TZ-AUDIT: 17x was live-offer talk; no timing weight) | LIVE in its layer | see status |
| M5 message framing bandit | DRAFT-PR #263 | MERGE NIGHT (section 6) | see status |
| M6 reply tree | MERGED (reply mix prior via #313; COACH-NEGOTIATE) | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| M7 timing urgency windows | DRAFT-PR #296 M7-TIMING | MERGE NIGHT (section 6) | see status |
| M8 simulation (opponent model) | DECLINED #302 -> COUNTERPART-02b QUEUED | KILLED / ABSORBED (evidence in status) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| M9 replanning on profile change | MERGED PULSE-01 #316 (WANT_PLAYER only) | LIVE in its layer | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| M10 reasoning "his side of the table" | MERGED REASON-01 + REASON-02 (grading) | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| PEOPLE-LAB | DONE-NO-PR (rnd/meta/people-lab.md; M4 17x later corrected) | LIVE in its layer | see status |
| Nick's ground truth -> manager_notes + nick_override | DONE-NO-PR (8 rows 9/23; 3 untouchable notes 9/24 08:38; protect-mine #373 MERGED; NICK-SOURCES #365 OPEN) | LIVE in its layer | see status |
| PEOPLE-FLOW sources (iMessage ext, screenshots SHOT-01, ESPN transactions, notes) | PARTIAL: messages_ext DONE-NO-PR; screenshot_trades table DONE-NO-PR, SHOT-01 proposals UNKNOWN; OFFER-SNAPSHO | PARTIAL: merged parts live, rest on its night | L10 live; #335 night 4; #247 when a night has room |
| PEOPLE-FLOW credibility (CRED-01) | MERGED #321 via #340 (140 rows live) | LIVE in its layer | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| PEOPLE-FLOW decision table (12 rows) | PARTIAL (each row mapped in the M rows above; flip radar MERGED; catch-up MERGED) | HOMED (family) | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| PEOPLE-FLOW new ideas 1-7 (mood, influence, face, anchor, street, how Nick comes across, c | R&D run: PEOPLE-MOOD/INFLUENCE/ANCHOR/FACE INCONCLUSIVE; PEOPLE-STREET confirm ruled invalid; PEOPLE-REPLAY KI | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| CONNECTIONS units FUSION-01 / CLONE-NN / JEV-CROSS | INCONCLUSIVE / KILLED / KILLED | KILLED / ABSORBED (evidence in status) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| WAR-ROOM-UI WR-1 read path + decision card | MERGED #231 | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| WAR-ROOM-UI WR-2 map + phone + dark | MERGED #231 + #333 | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| WAR-ROOM-UI WR-3 controls | MERGED #230 + #332 | LIVE in its layer | L10 live; #335 night 4; #247 when a night has room |
| WAR-ROOM-UI §8 producer gaps ("not computed yet") | PARTIAL (feasibility still typed unknown in smoke; title_now 0.005 preview) | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| WAR-ROOM-UI v2 one dashboard + Coach UI action protocol + WR-COACH | MERGED (#230 #231 #333) | LIVE in its layer | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| WAR-ROOM-UI v2 swipe deck | MERGED #342 | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| WAR-ROOM-UI v3 one screen league 4 people-first (People Board, negotiation mode, his scree | MERGED (#352 #337 #344 via #359/#364; TEAM-NAMES #351/#356) | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| UI-REVAMP UX-01 audit + benchmark | DONE-NO-PR (ui/UX-01-audit.md) | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| UI-REVAMP UX-02 IA | DONE-NO-PR (ui/UX-02-ia.md) | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| UI-REVAMP UX-03 design system v2 (shared components) | PARTIAL: C-12 #73 MERGED; UX-09 merge PageState/DesignSystem PLANNED; UX-12 shared states PLANNED | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| UI-REVAMP UX-04 hi-fi designs per tab | PARTIAL (War Room mock html only) | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| UI-REVAMP UX-05 build per tab | PARTIAL (Trade Brain/War Room done; other tabs not revamped) | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| UI-REVAMP UX-06 platform (code splitting, PWA, push) | PLANNED | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| UI-REVAMP UX-07 polish loop | PARTIAL (WR-POLISH #333, UI-POLISH-2 #370) | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| UI-STANDARD 12 rules + surfaces | DONE-NO-PR as a standard (UI-RED acceptance used by WR units) | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| PLAN v10 pillars 1-5 (projection, championship, trade engine, diligence, grading) | SUPERSEDED by v11/v12 north star; pillar statuses in the ES rows | KILLED / ABSORBED (evidence in status) | see status |
| PLAN v10 "UI the engine needs" (range bar, autopsy card, title-odds impact, clone view, ch | PLANNED/DRAFT (UI-ENG-1..5 rows) | BUILD NIGHT (section 5) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| PLAN v9 pillars: diligence engine, trade machine re-centred, grading on Nick's record, sta | PARTIAL: diligence units MERGED (SK-01 #186, SS-01 #185, WV-01 #176, WV-02 #178, #171); wording rule DONE; oth | HOMED (family) | live (SS-01, waiver priority); Sunday game-day checks in the weekly rhythm; K/DST done enough |
| PLAN v9 adjustments after R&D r3-r17 (each a plan change) | DONE-NO-PR (each recorded; the resulting RL-* units are in C.14) | LIVE in its layer | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| PLAN-REORG Phase A-D NEED lists + build order by item | SUPERSEDED (PLAN v10 -> v12); item statuses under WORK-QUEUE §1 rows | KILLED / ABSORBED (evidence in status) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| PHASE-DELIVERABLES Phase 1 (CE-05, TR-01, TR-03, AI-01, TM-09, AI-04, TM-06, FC test, GR-0 | PARTIAL: CE-05 #168, TM-09 #183, GR-05 #154 (S-00), GR-01 #174 MERGED; TR-01 DONE; AI-01 DECLINED; TM-06/FC te | PARTIAL: merged parts live, rest on its night | killed as ranker (r53); thresholds + display; NO-OVERPAY live; WIN-VALUE declined |
| PHASE-DELIVERABLES Phase 2 (CE-01/02/03/09/06/10) | PARTIAL (see CE rows) | HOMED (family) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| PHASE-DELIVERABLES Phase 3/4 (dossiers, LS-01, TM-03, AI-05, TM-17/30, TM-02, TM-04, TM-01 | PARTIAL (see TM rows; GR-02 report card -> brain_report MERGED; GR-06 receipts -> offer loop #239 + rec_ledger | PARKED | parked past 12/02 |
| PHASE-DELIVERABLES Phase 4 start/sit (SS-01, WV-01/02/03, SK-01, ST-02/03) | PARTIAL: SS-01 #185, WV-01 #176, WV-02 #178, SK-01 #186 MERGED; WV-03 PLANNED (snap share in #178? UNKNOWN); S | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| PHASE-DELIVERABLES Phase 5 AI tier + Phase 6 insane | PARTIAL/PLANNED (see AI-/TM-16+ rows) | PARTIAL: merged parts live, rest on its night | shadow (#261/#273); twins parked past 12/02 |
| PHASE-DELIVERABLES R&D researchers R1-R6 | SUPERSEDED by rnd-loop-v3 over IDEAS.json (Nick 9/23 21:49Z ruling drops the external explorer) | KILLED / ABSORBED (evidence in status) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| EXECUTION-WIRING tables (market_price, role_shift, lineup_signal, sim_state, action_price, | PARTIAL: rec_ledger #174 MERGED; market price #183 (table name may differ); lineup_signal #189; offer_ledger f | PARTIAL: merged parts live, rest on its night | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| EXECUTION-WIRING routes to add (/model/scenarios, /grades/report-card, /trades/offers, /li | PARTIAL: report card -> /api/brain-report MERGED; offers -> /offers/sent #239; streams -> #176; scenarios, win | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| BROKEN-NUMBERS rows A-S | A (title tab vs finder) FIX #241 MERGED; B three title odds -> EA-07 #269 MERGED; C four ranges PLANNED (PROJ- | compound row: see its sub-items | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| FIELD-REGISTRY rows (people.profile #260, people.counterpart #313, tells #268, credibility | DONE-NO-PR as a registry; producer PR statuses as listed in C.6 | LIVE in its layer | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| BENCHMARKS rows (CRPS, energy score, coverage, price MAE, pair accuracy, who-trades AUC, w | PARTIAL: RATCHET-01 (rows -> CI job) PLANNED; two rows "to measure" | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| BLOCKER-LAB BL-01 growth budget | UNKNOWN (no PR titled BL-01) | NIGHT 1: 15-min status check | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| BL-02 fast fantasy feeds on the refresh loop | UNKNOWN (BL-02 named in WQ; not found in PR titles) | NIGHT 1: 15-min status check | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| BL-03 freshness rule "last completed week present" | UNKNOWN (#96/#104 OPEN drafts hold the contract) | NIGHT 1: 15-min status check | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| BL-05 settle played-no-stat as 0 | UNKNOWN | NIGHT 1: 15-min status check | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| BL-20 settle cancellations/counters/review | PARTIAL (CLONE-01b b1 #239 settles by espn_tx_id) | HOMED (family) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| BL-40 4th-down GOE display trait | PLANNED (validator: resubmit as display-trait package) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| BL-50 resolve availability claims vs snaps weekly | PLANNED | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| BL-51 permutation guard in the person grader | PARTIAL (COACH-01a #249 adds separate windows; permutation guard UNKNOWN) | PARTIAL: merged parts live, rest on its night | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| BLOCKER-LAB Nick-only decisions (D1 restart loop, N9 migrations, N6 chat run, N7 paid data | PARTIAL: D1 DONE (loop restarted many times); N9 DONE (migrations approved 9/23); N6 DONE (chat corpus run loc | HOMED (family) | parked (#42 gate failed); destination card = title odds |
| INTEGRATION-AUDIT-0923 20-step merge order + FIX-00..FIX-11 | DONE (batches #278 #299 #317 followed the order; FIX-00..11 landed or smoke-tested) | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| INTEGRATION-CHECKS 4 layers + open seams | DONE-NO-PR: contract #238, wiring CI, integration audit ran, live E2E #330; seams: EVAL input tables -> FIX-09 | LIVE in its layer | L8 live; #308 + #366 night 1; STOPS-01 block 4; NSP-20 parked until offers |
| CLOUD-QUEUE next items 1-13 | PARTIAL: 1 FIX units DONE; 2 EA-06 #281 OPEN; 3 EA-07 #269 MERGED (UI-ENG-1 PLANNED); 4 TELLS-01b #268 OPEN; 5 | PARTIAL: merged parts live, rest on its night | L8 flip_map live (screen 1); deadline -> night 3 send_by + night 15 deadline mode |
| CLOUD-PIPELINE / CLOUD-LEDGER / BUDGET-PLAN / SPEND-ESTIMATE / THROUGHPUT | DONE-NO-PR as process; cloud on the other account closed 9/24 ($210/$250) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| MIGRATIONS.md registry 071-102 | DONE-NO-PR (registry; FIX-255-1 duplicate test on main) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| TASKS.md (9/23 7:50 PM) running/next/blocked lists | SUPERSEDED by NORTH-STAR-PLAN + BUILD-PLAN + COORD-TASKS (last updated 9/23) | KILLED / ABSORBED (evidence in status) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| TASKS "Blocked / needs Nick": news extractor key; META-01 ESPN anchor OK + reader model; S | PLANNED (all four still open; Sleeper 2026 panel IDEA-040 blocked) | BUILD NIGHT (section 5) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| PLAN-BOARD snapshot (9/22 19:53Z): 32 items 16% merged; 96 queued units | SUPERSEDED (board artifact gone; unit statuses in C.14) | KILLED / ABSORBED (evidence in status) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| META-01-REFEREE-MEMO draft units | SUPERSEDED by META-01-DESIGN v2 -> ES META-01a-f | KILLED / ABSORBED (evidence in status) | see status |
| META-01-DESIGN v2 | PLANNED (units META-01a-f) | KILLED / ABSORBED (evidence in status) | absorbed by the META-01 rows (L1 ruling, night 1 poller, night 7 source tables) |
| ENGINE-ARCHITECTURE v2 (§11.2 #216 must-change 14 items; §11.5 #220 8 items; §10.2 disagre | DONE: §11.2 applied by EA-00 (#216 merged); §11.5 applied by EA-01 (#220 head, then superseded); A-H tracked i | LIVE in its layer | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| rules-archive (INTEGRATION-PROCEDURE, VERIFICATION-RULES, WORKFLOWS-PER-STAGE, merge-gate- | SUPERSEDED by RULES v3 | KILLED / ABSORBED (evidence in status) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| audits/ (C-01, CE-05, RL-6-3, RL-9-3, S-03/BLEND-01/HX-01, TM-09, WV-01 rulings) | DONE-NO-PR (C-01 #160, CE-05 #168, RL-6-3 #192, RL-9-3 #200, TM-09 #183 CLEARED and MERGED; WV-01 #176 HELD th | LIVE in its layer | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| ui/UX-01-audit.md, ui/UX-02-ia.md | DONE-NO-PR (feed UX-08..14 units) | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| merged-parts/ENGINE-SPECS-DAEMON/TELLS/UI | SUPERSEDED (merged into ENGINE-SPECS.md 9/23 21:08Z) | KILLED / ABSORBED (evidence in status) | see status |
| INTEGRATION-LOG.md (579 lines), INTEGRATION-SMOKE-FIX-11.md, DRILL-0924-0604.md, SHUTDOWN- | DONE-NO-PR (records; no open items beyond those already rowed) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |

## C.14 WORK-QUEUE.md (2026-09-22 single queue; 32 plan items + unit

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| WQ F1 wiring map stopped + panel lines | DONE-NO-PR | LIVE in its layer | see status |
| WQ F2 stall table (#95 heavy jobs off thread; #98 stall measure) | PARTIAL (#95 MERGED; #98 OPEN) | PARTIAL: merged parts live, rest parked | see status |
| WQ F3 freshness registry + banner (#86) | MERGED #86 | LIVE in its layer | see status |
| WQ F4 trade-acceptance outcome logging (#94) | MERGED #94 (F-05) | LIVE in its layer | see status |
| WQ F5 honest inventory contract (#99 #108 #137 #147) | MERGED | LIVE in its layer | see status |
| WQ F6 open-PR triage (#102) | MERGED (board doc); re-triaged 9/24 01:33 | LIVE in its layer | see status |
| WQ F7 deploy sequence prep (#127 deploy button) | MERGED #127 (prep); live deploy word still Nick's | LIVE in its layer | see status |
| WQ A1 league config auto-ingest | PARTIAL: A-03 #163 scoring map MERGED; A-06/A-07 CE-05 #168 MERGED; A-01 #93 OPEN; A-02/A-04 league-config-ver | PARTIAL: merged parts live, rest parked | see status |
| WQ A2 deep predictive feature set | PARTIAL: lift proofs declined (routes run, red zone) in #68 MERGED; A-09..A-21 mostly PLANNED; A-13 officials  | PARTIAL: merged parts live, rest on its night | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| WQ A3 beat-reporter source map | PARTIAL: handle list exists; A-22..A-26 PLANNED (no per-source n per EXPLORER-LOG); moonshot pregame availabil | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| WQ B4 waiver wire system | PARTIAL: #62 K/DEF MERGED, #178 WV-02, #191, #211, #176 WV-01 (default-on #208); B-04 K/DST -> kdst-market-pro | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| WQ B5 defensive adds + kicker denial | PARTIAL: WV-01 streaming board #176 MERGED; B-09 denial value PLANNED; kdst package ACCEPTED not built | HOMED (family) | live (SS-01, waiver priority); Sunday game-day checks in the weekly rhythm; K/DST done enough |
| WQ B6 trade acceptance probability | PARTIAL: B-10 "experimental n" labels MERGED (#41/#47 OPEN dated reads); B-11 per-manager fit -> CLONE-01a/b;  | HOMED (family) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| WQ B7 trade timing | PARTIAL: B-13 #57/#64/#60 OPEN (league-true week) -> BROKEN-D #283; B-14 deadline PLANNED; B-15 buy-low graded | PARTIAL: merged parts live, rest on its night | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| WQ B8 three-team trades | PLANNED (B-16) | HOMED (family) | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| WQ B9 playoff probability engine | PARTIAL: B-01 #162 MERGED; B-02 #40/#44/#58/#83 OPEN (actual bracket etc.; CE-05 #168 covers brackets); B-03 o | PARTIAL: merged parts live, rest parked | see status |
| WQ B10 weekly operating rhythm | PARTIAL: SK-01 #186 MERGED; B-17 ops calendar PLANNED; #84 fantasy ingests OPEN | PARTIAL: merged parts live, rest parked | see status |
| WQ B11 push / game-day mode | PARTIAL: SS-01 #185 MERGED (in-app); B-18 web push PLANNED; PUSH-01 #293 OPEN | PARTIAL: merged parts live, rest on its night | L11/L13 live (EA-02); PUSH-01 block 2; EA-11/12 parked |
| WQ C12 dumb-baseline gates | PARTIAL: C-01 #160 MERGED (start/sit vs ESPN); C-02 waiver gate PLANNED; C-03 trade gate -> RL-8-2 DECLINED; C | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| WQ C13 decision post-mortem loop | DRAFT-PR (#251/#295) ; C-04 as-of PLANNED | MERGE NIGHT (section 6) | see status |
| WQ C14 luck decomposition | PARTIAL (luck-panel.mjs; LL-01 PLANNED; luck pricing retired #353) | PARTIAL: merged parts live, rest parked | see status |
| WQ C15 causal news impact | PLANNED (C-06 diff-in-diff; extractor broken) | PARKED | parked (R&D; news dead until D2) |
| WQ C16 injury response latency | PLANNED (C-07) | PARKED | parked (R&D) |
| WQ C17 selection-bias fix for trade logging | PARTIAL: C-08 considered-not-proposed -> serve-log #243 + trade_outcomes; two-stage model PLANNED | HOMED (family) | L10 live; #335 night 4; #247 when a night has room |
| WQ C18 Goodhart guards | PARTIAL: S-00 #154 stats contract MERGED; C-09 ceiling target PLANNED; C-10 PLANNED; C-11 #138/#79 OPEN | PARTIAL: merged parts live, rest parked | see status |
| WQ C19 uncertainty UI | PARTIAL: C-12 #73 MERGED; C-13 #75 OPEN (glossary wrong, UX-14 #193 OPEN); C-14 ranges #88 OPEN -> PROJ-03-c;  | PARTIAL: merged parts live, rest on its night | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| WQ C20 the "why" engine | PARTIAL: C-17 Coach panel -> #90 MERGED; C-18 required why PLANNED; C-19 page-explain -> #223; C-20 #43/#80/#5 | PARTIAL: merged parts live, rest parked | see status |
| WQ D21 pipeline fragility | PARTIAL: many silent-failure fixes MERGED (#86 #87 #89 #91 #111-#131); D-01 #96/#104 OPEN; D-02 #126/#144/#101 | PARTIAL: merged parts live, rest parked | see status |
| WQ D22 one-league overfitting | PARTIAL: sleeper-hierarchical-manager-priors package ACCEPTED narrowed to adds (D-11 PLANNED); CLONE-01a shrin | HOMED (family) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| WQ D23 desktop + mobile | PARTIAL: UX-10 #177 MERGED; phone audits 9/24; PWA PLANNED (D-12) | HOMED (family) | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| WQ D24 competitive teardown | PLANNED (D-13) | PARKED | parked past 12/02 |
| WQ D25 kill list | PLANNED (D-14; MLB removal #128/#159 MERGED) | KILLED / ABSORBED (evidence in status) | absorbed: section 7 of the plan is the kill list |
| WQ F-01..F-16 (foundation close units) | MERGED: F-01 #128, F-03 #97, F-05 #94, F-08 #157, F-09 #116, F-10 #146, F-15 (snapshots closed); OPEN: F-02 #9 | LIVE in its layer | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| WQ A-01..A-26 (Phase A units) | MERGED: A-03 #163; OPEN: A-01 #93, A-08 #74; rest PLANNED (queued 9/22); A-13 IGNORED (officials, ruling) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WQ B-01..B-18 (Phase B units) | MERGED: B-01 #162; OPEN: B-02 (#40 #44 #58 #83), B-07 #67, B-12 (#41 #47), B-13 (#57 #64 #60); rest PLANNED or | LIVE in its layer | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| WQ C-01..C-20 (Phase C units) | MERGED: C-01 #160, C-12 #73; OPEN: C-11 (#138/#79), C-13 #75, C-14 #88, C-15 #76, C-16 #78, C-20 (#43 #80 #53) | LIVE in its layer | see status |
| WQ D-01..D-14 (Phase D units) | OPEN: D-01 (#96 #104), D-02 (#126 #144 #101), D-03 (#125 #134 #107), D-08 (#50 #66 #45 #15 #39); PLANNED: D-04 | compound row: see its sub-items | see status |
| WQ S-00..S-20 (structure fixes) | MERGED: S-00 #154, S-02 #155, S-18 #156, S-19 #187, S-19b #194, S-20 #206; OPEN: S-03 #166; S-01 -> BROKEN-D/G | LIVE in its layer | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| WQ DD/Sleeper-data units (H-01 hold branches, MS-03/04/05) | H-01 PLANNED (6 hold branches: Team Outlook #42 etc. still OPEN); MS-03 human trade value -> TM-09 #183 MERGED | compound row: see its sub-items | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| WQ INT-* integration follow-ups (INT-94-1, INT-116-1, INT-128-1 #153, INT-149-1, INT-150-1 | MERGED: INT-128-1 #153, INT-159-1 #172, INT-162-1 #202, INT-163-1 #201, INT-168-1 #188; rest PLANNED/UNKNOWN ( | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WQ BL-01/02/03/05/20/40/50/51 | see C.13 BLOCKER-LAB rows (mostly UNKNOWN/PLANNED) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| WQ SY-01..SY-07 synergy units | MERGED: SY-02 #161, SY-06 #159; SY-01 accept/decline rule -> E1-DATA #324 (via #340); SY-03 link app trade to  | LIVE in its layer | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| WQ §13 HX-01 historical head-to-head | MERGED #165 | LIVE in its layer | see status |
| WQ §14 HX-02 gap attribution, NEWS-01 news into the served number | PLANNED (HX-02 queued 9/22; NEWS-01 blocked by the extractor) | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| WQ §15 BLEND-01 blend tournament | OPEN-PR #164 (held; ESPN won) | MERGE NIGHT (section 6) | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| WQ §16 the stack with ranges (BLEND-02, C-14) | SUPERSEDED (META-01) / C-14 #88 OPEN | KILLED / ABSORBED (evidence in status) | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| WQ §17 trade analyzer track + ESPN stack (TR-01..TR-05) | TR-01 DONE; TR-02 -> TM-06 DECLINED; TR-03 partial (#166 OPEN); TR-04 -> B-03/#225; TR-05 redefined partial | HOMED (family) | killed as ranker (r53); thresholds + display; NO-OVERPAY live; WIN-VALUE declined |
| WQ §18 skill levers into product (SS-01, WV-01, WV-02, WV-03, SK-01) | MERGED SS-01 #185, WV-01 #176, WV-02 #178, SK-01 #186; WV-03 snap-share add list UNKNOWN (#178 "skip hurt repl | LIVE in its layer | live (SS-01, waiver priority); Sunday game-day checks in the weekly rhythm; K/DST done enough |
| WQ §19 Trade Machine TM-01..TM-08 | see C.9 | PARKED | parked (paid research feed) |
| WQ UI revamp findings UX-08..UX-14, XO-01 | MERGED: UX-08 #167, UX-08b #175, UX-08c #182, UX-10 #177, UX-11 #180; OPEN: UX-14 #193; PLANNED: UX-09, UX-12, | LIVE in its layer | L9 live; UI-ENG-5 block 2; UI-ENG-1/2/3/4/6 parked |
| WQ §20 AI-13..AI-16 (news embeddings, silicon crowd, mass-label history, ESPN-move predict | PLANNED (queued 9/23 07:45Z with $1 caps; AI-14 silicon crowd -> JEV-01/META-01 shadow; AI-16 -> NX-01 poller) | BUILD NIGHT (section 5) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| WQ RL-1-1..RL-19-3 (R&D loop units rounds 1-19) | MERGED: RL-3-1+RL-4-3 #170, RL-3-2 #184 OPEN-PR, RL-3-3 (built; PR status UNKNOWN), RL-3-4 #169, RL-4-2 #171,  | LIVE in its layer | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| WQ RL-20-1, RL-23-1, RL-25-3, RL-27-1, RL-37-2, RL-45-1, RL-46-1, RL-50-1 (rnd-loop-v3 bui | RL-20-1 -> SERVE-LOG #243 MERGED; RL-23-1 -> ONE-PLANNER 2-for-1 via #340; RL-25-3 -> LIVING-01c #273 DRAFT; R | compound row: see its sub-items | L8 planner live; REACH-01 night 1; SEARCH-WIDE night 6; CHESS-01a folded, CHESS-01b -> E4-live |
| WQ NICK-ONLY blockers (14 + 1) | PARTIAL: N1 cookie, N12 alerts, N7 paid data still owed; N9 migrations approved; N6 chat run done; NICK-2025 a | HOMED (family) | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| WQ §12 coordinator grants/rulings log | DONE-NO-PR (rulings recorded; later ones in OPS-LOG) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |

## C.15 Repo docs (~/Documents/GitHub/gridiron-hq/docs): plan-bearin

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| WHAT-WINS-STUDY §4 execution steps 1-7 | DONE-NO-PR steps 2-6 (TARGET-SPEC produced 9/17; gate 15/15); step 1 partial (history window short); step 7 do | LIVE in its layer | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| WHAT-WINS §3 reorder items 1-7 (gate change, availability first, live players, trades vs c | PARTIAL: 1 DONE (0aa); 2 DONE; 3 DONE (waivers); 4 SUPERSEDED (value edge not found; RL-8-2b); 5 DONE (#169);  | HOMED (family) | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| TARGET-SPEC §6 priority order 1-5 | DONE / KILLED->#377 / DONE / DONE / PARTIAL (clones unproven) | LIVE in its layer | see status |
| STRUCTURAL-RELOOK items 1-18 | 1 DONE (cf3d446); 2 DONE (dc48028); 3 DONE (profiles rebuilt); 4 -> RL-13-3 (#229 DRAFT); 5 caveated / re-test | compound row: see its sub-items | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| NUMBER-PROVENANCE (b) unfitted constants 1-21 | 1 sim calibration -> E3 (PASS Sleeper); 2 old play prior -> role model DONE; 3 0.25/0.75 blend PLANNED (S-07); | compound row: see its sub-items | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| NUMBER-PROVENANCE (c) routing inconsistencies 1-17 | 1 -> #162 #168 #241 MERGED (+BROKEN A/B); 2/3 coordinator/lift -> #165 label, #166 OPEN; 4 four bases -> BROKE | compound row: see its sub-items | L1 blend.week = ESPN point (#291 night 1); ESPN+correction candidates parked (no expert beats ESPN) |
| NUMBER-PROVENANCE (d) "three that would move the most" | DONE / PARTIAL (#162 #314 #318 #241; E3) / PARTIAL (#236 done; blend PLANNED) | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| EXISTING-SYSTEMS-INVENTORY §3 recommendations A-H | see E4 rows (all PARTIAL or SUPERSEDED) | HOMED (family) | live (SS-01, waiver priority); Sunday game-day checks in the weekly rhythm; K/DST done enough |
| EXISTING-SYSTEMS §1 duplicates/overlaps, §2 orphaned code | PARTIAL (rulings SR 1-13 resolved the people/planner/flip/week duplicates; orphans -> D-14 kill list PLANNED;  | PARTIAL: merged parts live, rest parked | see status |
| RELEASE-TRAIN-2026-09-19 §1 order (base stack 7,9,10,11,12; then 8,24,17,19,20,28,29,31,32 | SUPERSEDED: #7 MERGED; #9-#14 #16-#37 mostly CLOSED-UNMERGED (replaced by direct integration + later PRs); #15 | KILLED / ABSORBED (evidence in status) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| RELEASE-TRAIN §4 not ready (#34 wrong base) | CLOSED-UNMERGED #34 (availability term) -> reopened as #38 OPEN | KILLED / ABSORBED (evidence in status) | see status |
| RELEASE-TRAIN §5-§7 deploy plan (baseline reading, deploy, watch first boot, unset heavy f | PARTIAL: deploy happened (7.0b: machine would not stay up; brake on 13:43Z); DB write 1 (volume shrinkage prom | HOMED (family) | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| RUNBOOK-promote-volume-shrinkage | PLANNED (not executed; waits on Nick's word) | HOMED (family) | L1 live (ESPN point + ros_ppg); ROS-USAGE + VOL-K night 11; consensus gate parked (2024 as-of absent); PROJ-01-c internal referee only |
| CLOUD-MIGRATION checklist 1-5 | DONE-NO-PR for cloud sessions (used by the 9/19 cloud sessions and 9/23-24 cloud builds); scripts/check-enviro | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| GOOGLE-SIGN-IN-SETUP steps 1-5 | PLANNED (owner-only steps; #14 CLOSED-UNMERGED; #51 OPEN) | PARKED | parked: Phase 11 hosting/accounts, last |
| OPPORTUNITY-FINDINGS-2026-09-19 (no opportunity model; volume shrinkage defect; teammate a | DONE-NO-PR findings; volume-shrinkage promotion PLANNED (runbook); redistribution -> #377 | LIVE in its layer | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| coach-surface-integration: eight tabs registering with Coach (4 of 8 do not) | PARTIAL (Coach dock in War Room; per-tab registration UNKNOWN) | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| COACH-PLAYBOOK §1-8 (27 tactics; §7 new profile data; §8 measurement) | DONE-NO-PR as the pack; RL-15-1 #210 correction MERGED; §7 profile fields PARTIAL; §8 measurement -> E1/E2 | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| STATS-CONTRACT rules 1-11 + prereg template | DONE-NO-PR (S-00 #154; check-prereg-order.mjs #173 MERGED) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| RD-HANDOFF-CONTRACT intake gate | SUPERSEDED (rnd-loop-v3 recorder) | KILLED / ABSORBED (evidence in status) | see status |
| HISTORICAL-TESTS (betting-era test ledger) | IGNORED (betting line) except its fantasy rows (none) | betting: ignored | betting side, ignored |
| CLAUDE-NEXT-STEPS (NFL spreads plan, C01-C17) | IGNORED (betting line) | betting: ignored | betting side, ignored |
| scheduler-what-actually-fires (jobs that never ran on the ~177 s restart cycle) | PARTIAL (heavy tier off thread #95/#17; 34 of 62 jobs never ran on that build; local refresh loop runs the fan | PARTIAL: merged parts live, rest parked | see status |
| spec/projection-range serving contract §5 | PLANNED (C-14 #88 OPEN; PROJ-03-c) | BUILD NIGHT (section 5) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| design/design-system | MERGED #73 (C-12) | LIVE in its layer | see status |
| runbooks/deploy-654ff93, deploy-workflow | DONE-NO-PR (deployed 9/22 17:05Z; Deploy button #127) | LIVE in its layer | see status |
| wiring/FINDINGS-2026-09-19 (10 missing feeds, 3 staleness, orphans), MISSING-FEEDS (10 tab | PARTIAL: fit-availability tables written 9/24; league_transactions_raw written by collector; league_draft_pick | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| data/missing-data-register (routes run; current-season participation; pbp_participation ta | PARTIAL: pbp/participation 2021-25 loaded #218; current season (2026) participation PLANNED; routes run per pl | PARTIAL: merged parts live, rest parked | see status |
| inventory/INVENTORY.md counts (52 wired, 184 half_done, 3 silently_broken, 10 phantom tabl | DONE-NO-PR (generated 9/22; not regenerated since; dead list includes td-features.js, vegas-fantasy.js, espn-m | LIVE in its layer | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| reference/* (18 operating references: DRAFT_ADVICE_VERIFY_LOOP, DRAFT_CAPTURE(+EXTENSION), | DONE-NO-PR (built systems documented: draft advice/capture, offseason + preseason models, Trade Lab verify loo | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| board/pr-triage-2026-09-22 + pr-board-2026-09-22-0800Z | SUPERSEDED by evidence/pr-triage-0924.md and auto-intake | KILLED / ABSORBED (evidence in status) | see status |
| board/2026-week2 | IGNORED | betting: ignored | betting side, ignored |
| README.md (docs index) | DONE-NO-PR (link map) | LIVE in its layer | see status |
| WA-WORKFLOW-RECORD.md | DONE-NO-PR (record) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| docs/tdd/*.md (237) and docs/evidence/**/*.md (115) | DONE-NO-PR (records; each is evidence for a unit already rowed; the 2026-09-09..13 evidence tree is betting-er | LIVE in its layer | see status |

## C.16 R&D docs under ~/gridiron-local/rnd (moonshots, packages, sk

| id | status (inventory) | disposition | home in the ONE PLAN |
|---|---|---|---|
| MS human-trade-value-model (rank 1) | MERGED as TM-09 #183 (price model beats ESPN-rank baseline); round-2 anchor test run (recency NULL; season-to- | LIVE in its layer | see status |
| MS trees-before-transformers (rank 2) | PARTIAL: CLONE-NN r33 KILLED (trees tie); O2-ML (trees + GRU) RUNNING-STOPPED | PARTIAL: merged parts live, rest on its night | L2 radar #377 night 8; O1C-WIRE night 11; O2-ML parked shadow |
| MS calibrated-news-extraction (rank 3) | PLANNED (blocked: paid LLM; extractor 401); META-01d reader is the successor | HOMED (family) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| MS decision-focused-projections (rank 4) | PLANNED (MS-04 queued 9/22; C-01 gate MERGED is the benchmark) | HOMED (family) | corpus used by R&D + E1 baseline; reader service parked |
| MS crowd-attention-overreaction (rank 5) | INCONCLUSIVE/PLANNED (H5 pre-registered; MS-05 queued; TM-14 hype KILLED r5) | KILLED / ABSORBED (evidence in status) | corpus used by R&D + E1 baseline; reader service parked |
| MS llm-counterparty-personas (rank 6) | KILLED (r17 persona AUC 0.47; r34 JEV-CROSS) | KILLED / ABSORBED (evidence in status) | L12 live (classifier); JEV-01a/b shadow night 9; O3-JEV parked |
| MS player2vec-cold-start (rank 7) | PLANNED (cheap numpy test never run) | PARKED | parked (R&D) |
| MS league-digital-twin (rank 8) | HELD (TWIN-01) / LIVING-01 DRAFTs | HOMED (family) | shadow (#261/#273); twins parked past 12/02 |
| MS ai-data-coordinator-playcaller-history | DONE-NO-PR pilot backfill RUN 9/22 21:55Z ($0.80 cap); table nfl_team_staff consumer PLANNED | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| MS ai-data-injury-timelines | KILLED pilot (n=36 NULL vs free prior); free-prior version -> TM-11/CE-03 | KILLED / ABSORBED (evidence in status) | L1 p_play role cells live (#357 preview); CE-03 spells parked; injury timing into ROS block 4 |
| MS ai-data-pregame-availability-claims | PARTIAL (pilot n=40; RL-6-2 web-search arm frozen into the W3-W8 availability test; BL-50 PLANNED) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| MS ai-use-coach-eval-harness (C-17) | PARTIAL (HEALTH-01e daily canary #256 DRAFT: 12 golden questions) | PARTIAL: merged parts live, rest on its night | L0 FRESH-01 night 1; #256 night 4; BROKEN-D/E/F/Q night 7; EA-03/04 block 2 |
| MS ai-use-gameday-pivot-line | PLANNED (needs live Sunday feed; SS-01 in-app) | HOMED (family) | live (SS-01, waiver priority); Sunday game-day checks in the weekly rhythm; K/DST done enough |
| MS ai-use-grounded-why (C20/C-18) | PARTIAL (pilot 18 calls; verifier reused by REASON-01/COACH-MSG; per-recommendation why PLANNED) | PARTIAL: merged parts live, rest on its night | L9 Coach live (words only); COACH-FIELDS night 9; roleplay shadow |
| MS ai-use-negotiation-drafts | MERGED (COACH-MSG #306 + VOICE-01 #331) | LIVE in its layer | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| MS ai-use-postmortem-writer (C13/C-04) | DRAFT-PR (#251/#295 hold the numbers; writer PLANNED) | MERGE NIGHT (section 6) | see status |
| MS ai-use-pr-redteam | KILLED by pilot (replaced by wiring-map check + RULES v3 diff reviewer) | KILLED / ABSORBED (evidence in status) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| PKG redzone-inside10-already-computed | ACCEPTED by validator; build status UNKNOWN (RD-01 on the 9/22 board) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| PKG ftn-drop-contested-catch-player-join | REJECTED by validator | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| PKG fourth-down-coach-aggression-index | REJECTED (resubmit as display trait -> BL-40 PLANNED) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| PKG ol-continuity-fantasy-efficiency | REJECTED | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| PKG kdst-market-projection | ACCEPTED; build (B-04) UNKNOWN; SIM-KDST #314 scores K/DST in the sim (via #340) | HOMED (family) | L3 season-sim live; BASIS-02 + RB-TITLE night 2; PROJ-03-b/c + weekly range parked (WEEKLY-RANGE-ONE night 7) |
| PKG waiver-crowd-baseline | REJECTED | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| PKG weekly-combination-encompassing | REJECTED; S-02 #155 grade MERGED; META-01 probe supersedes | compound row: see its sub-items | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| PKG season-sim-persistent-level-calibration | ACCEPTED (4 corrections); LIVING-01c team-mean #273 DRAFT is the nearest; H-01 PLANNED | HOMED (family) | shadow (#261/#273); twins parked past 12/02 |
| PKG sleeper-hierarchical-manager-priors | ACCEPTED narrowed to adds; D-11 PLANNED; CLONE-01a shrinkage #229 | HOMED (family) | L5b his price (GUESS) + L7 P(yes) one module night 3; #363 label night 3; #288 shadow night 9; COUNTERPART-02b parked |
| SKILL study (PREREG, SKILL-REPORT, luck-vs-skill, startsit-draft, waivers, trades + skepti | DONE-NO-PR (verified 8 skeptic passes; drove PLAN v9) | LIVE in its layer | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| SKILL-REPORT §4 app recommendations 1-5 (move nudge + streaming board; dead-starter alerts | 1 MERGED (#186 #176 #208); 2 MERGED in-app (#185 #178; push PLANNED); 3 PLANNED (before 2027 draft); 4 PARTIAL | HOMED (family) | killed as ranker (r53); thresholds + display; NO-OVERPAY live; WIN-VALUE declined |
| waivers.md "Do this" 1-5 | 1 MERGED (no-move nudge #186); 2 MERGED (#176); 3 PARTIAL (#178 alert; 3-day timing not enforced); 4 DONE (pri | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| startsit-draft "Do this" 1-5 + app features 1-3 | 1 MERGED (#185); 2 PARTIAL (#198 default-off, #184 OPEN); 3-5 PLANNED (draft tools, before 2027) | HOMED (family) | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| trades.md corrected "how to own it" 1-5 | 1 PARTIAL (lineup gain lens QUEUED); 2 DONE (best-player flag removed, TMP:173); 3 PLANNED (pedigree shrink);  | HOMED (family) | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |
| insane/SYNTHESIS converged winners 1-3 + killed + leads | LIVING-01a/b/c DRAFTs; BC waiver policy PLANNED (LIVING-01b); SELF-01a UNKNOWN/01b DRAFT; killed items recorde | HOMED (family) | shadow (#261/#273); twins parked past 12/02 |
| insane/game-theory, physics, ml, econometrics lens files | DONE-NO-PR (explorations; results folded into the rows above) | LIVE in its layer | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| meta/acq-flip-proto | MERGED #227 | LIVE in its layer | see status |
| meta/people-lab (+prereg, code) | DONE-NO-PR (M4 17x corrected by TZ-AUDIT; CRED-01 parity 14/14) | LIVE in its layer | L6 people read live; HIS-SIDE-WIRE night 3; PULSE-02 night 9; TELLS-01b parked until offers |
| meta/probe (+prereg) META-01 historical probe | DONE-NO-PR (no combiner beats ESPN) | LIVE in its layer | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| eval/eval-hist, e1-league-offers, e1/e3 preregs | DONE-NO-PR (E3 PASS; E1 stand-in; E1-league: no ranking skill) | LIVE in its layer | L11 live; E1-BAR night 2; #319 night 3; E4-live block 2; E4-REDO parked |
| backlog/IDEAS.md + IDEAS.json (188 + 19 = 207 ids), DEAD-ENDS.md, STATUS.json, picked/ | see section D | compound row: see its sub-items | see status |
| prompt-audit/app-audit (#223) + orchestration-audit | MERGED #223; orchestration applied locally | LIVE in its layer | see status |
| EXPLORER-LOG, MOONSHOT-LOG, VALIDATOR-LOG (9/22) | DONE-NO-PR (records; verdicts used above) | LIVE in its layer | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| rnd/loop/LOOP-LOG.md (5,438 lines), HOLDOUT-LEDGER-PENDING.md (8 pending rows), prereg/ (8 | DONE-NO-PR (records); HOLDOUT-LEDGER-PENDING rows PLANNED to be copied into the repo ledger via a PR | LIVE in its layer | R&D at night only, gated by the north-star number it moves; confirmed ideas mapped in D.2; rest parked |
| rnd/data/kdst-baseline licence files | DONE-NO-PR (licence copies) | LIVE in its layer | see status |
| wf/cloud-builder-prompt.md; wt/*-body.md, *-comment.md (PR bodies for #247 #261 #264 #277) | DONE-NO-PR (prompt + PR-body records) | LIVE in its layer | L13 ops clock (nights only); merge train + PR sweep nights 10-11; Phase 11 hosting parked last |


---

# Appendix B. Every data source and where it lives in the ONE PLAN

From inventory-data.md (314 live tables, satellites, chat corpus, local files). Group -> home; notable tables called out; empties/orphans given a repair or a parked reason. Names-free.


## B1: B1. NFL stats and usage (the projection inputs)
Home: L1 player basis / L2 radar / L4 tiers (usage, snaps, xFP, depth, injuries, rookies, ADP-internal)

| table | rows | home / repair |
|---|---|---|
| player_week_usage | 42,624 | L1 player basis / L2 radar / L4 tiers |
| player_week_snaps | 40,890 | L1 player basis / L2 radar / L4 tiers |
| nfl_snaps | 129,555 | L1 player basis / L2 radar / L4 tiers |
| nfl_depth | 180,153 | L1 player basis / L2 radar / L4 tiers |
| nfl_injuries | 28,675 | L1 player basis / L2 radar / L4 tiers |
| nfl_ngs | 12,136 | L1 player basis / L2 radar / L4 tiers |
| nfl_pfr_adv | 25,846 | L1 player basis / L2 radar / L4 tiers |
| nfl_ffopportunity_weekly | 28,919 | L1 player basis / L2 radar / L4 tiers |
| nfl_player_week_features | 52,864 | L1 player basis / L2 radar / L4 tiers |
| nfl_team_week_features | 5,342 | USE: pace/PROE -> game-script distribution (U2, night 11) |
| nfl_play_charting | 190,389 | L1 player basis / L2 radar / L4 tiers |
| nfl_play_formations | 187,421 | L1 player basis / L2 radar / L4 tiers |
| nfl_play_participation_players | 0 | PARKED: licence-gated / 2026 file 404 |
| nfl_volume_indicators | 62,069 | USE: routes/TPRR proxy for the radar (U1); needs a writer (night 11 O1C-WIRE input) |
| nfl_player_feature_vectors | 2,880 | L1 player basis / L2 radar / L4 tiers |
| nfl_team_feature_vectors | 2,174 | L1 player basis / L2 radar / L4 tiers |
| nfl_feature_dictionary | 5,877 | L1 player basis / L2 radar / L4 tiers |
| nfl_feature_revisions | 918 | L1 player basis / L2 radar / L4 tiers |
| nfl_qbr_weekly | 604 | L1 player basis / L2 radar / L4 tiers |
| nfl_team_coaches | 904 | L1 player basis / L2 radar / L4 tiers |
| nflverse_player_positions | 25,066 | L1 player basis / L2 radar / L4 tiers |
| players | 8,640 | L1 player basis / L2 radar / L4 tiers |
| roster_players | 2,501 | L1 player basis / L2 radar / L4 tiers |
| nfl_roster_snapshots | 32,108 | L1 player basis / L2 radar / L4 tiers |
| nfl_player_roster_events | 56 | L1 player basis / L2 radar / L4 tiers |
| nfl_player_state_quarantine | 208 | L1 player basis / L2 radar / L4 tiers |
| player_team_changes | 29 | L1 player basis / L2 radar / L4 tiers |
| schedule_games | 544 | L1 player basis / L2 radar / L4 tiers |
| nfl_teams / nfl_stadiums / nfl_team_stadiums | 32 / 67 / 59 | L1 player basis / L2 radar / L4 tiers |
| player_season_stats | 1,371 | L1 player basis / L2 radar / L4 tiers |
| player_metrics | 2,318 | L1 player basis / L2 radar / L4 tiers |
| nfl_rookie_evidence | 4,259 | L1 player basis / L2 radar / L4 tiers |
| cfbd_player_season | 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| nfl_historical_adp | 2,914 | L1 player basis / L2 radar / L4 tiers |
| nfl_historical_adp_scrape / nfl_historical_ffc_adp | 0 / 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| off_* (12 tables: contracts, depth_chart, draft_picks, ngs_season, pfr | all 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| player_gamelog, player_accolades, trending_players, scout_reports, slo | 0 each | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| player_analysis / team_cap / nfl_top100 | 1 / 32 / 100 | L1 player basis / L2 radar / L4 tiers |

## B2: B2. Game context from the betting side (kept: fantasy-usable)
Home: L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin forecasts parked to O1C-WIRE night 11; prop/market tables parked

| table | rows | home / repair |
|---|---|---|
| game_lines | 15,096 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| gamescript_model | 2 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_game_weather | 235 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_game_weather_forecast_history | 3,465 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_odds_archive | 102,288 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_line_snapshots | 55,421 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_quote_tape / nfl_quote_batches | 44,455 / 38 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_prop_quote_snapshots | 2,539 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_prop_clv | 3,117 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_signal_snapshots | 1,652 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| espn_line_moves | 55 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| prediction_market_quotes / prediction_market_flow | 1,462 / 4,600 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| polymarket_markets / polymarket_quotes / polymarket_order_book_levels  | 12,517 / 133,079 / 9,814 / 142 / 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| nfl_external_ratings | 2,496 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_nfelo_games / nfl_nfelo_lines / nfl_nfelo_qb | 1,741 each | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_expert_forward_predictions / _settlements | 1,860 / 1,540 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_ensemble_fit_artifacts | 421 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_game_variance | 32 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_postgame_truth_packets | 49 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_pregame_snapshot_history | 416 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_team_cards | 64 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_verified_events | 12,298 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_availability_rates / nfl_availability_role_rates | 139 / 871 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_officials | 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| nfl_play_by_play | 160 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_scottfree_game_features, nfl_alt_spread_*, nfl_sgp_quotes, nfl_t60 | 0, 0/0, 0, 1, 148, 3,030, 71 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |
| nfl_online_neural_examples/_artifacts, nfl_risk_lab_predictions/_artif | 64/1, 256/4, 2, 2, 1, 15, 1, 2, 7, 7 | L0b betting-side assets reused: game_lines -> game script distribution; injuries/verified events/availability -> p_play; weather, ratings, margin fore |

## B3: B3. ESPN league data (the five leagues)
Home: L0 live data -> L8 planner (rosters, transactions, draft picks -> DRAFT-ID-MAP night 5), L10 offer loop (league_transactions_raw settles)

| table | rows | home / repair |
|---|---|---|
| leagues | 5 | L0 live data -> L8 planner |
| league_memberships | 5 | L0 live data -> L8 planner |
| league_member_identity | 46 | L0 live data -> L8 planner |
| league_roster_snapshots | 2,315 | L0 live data -> L8 planner |
| league_roster_history | 154 | L0 live data -> L8 planner |
| league_transactions_raw | 1,645 | L0 live data -> L8 planner |
| league_draft_picks | 1,738 | L0 live data -> L8 planner |
| league_season_teams | 108 | L0 live data -> L8 planner |
| league_week_scores | 1,652 | L0 live data -> L8 planner |
| league_waiver_runs | 19 | L0 live data -> L8 planner |
| espn_player_market | 1,000 | L0 live data -> L8 planner |
| espn_player_market_weekly | 1,042 | REPAIR: META-01b as-of poller night 1 (2024 absent -> forward capture) |
| drafts / draft_picks / draft_events / draft_team_ownership | 6 / 352 / 192 / 5 | L0 live data -> L8 planner |
| draft_queue, draft_advice, draft_grades, draft_team_grades, draft_capt | 0 each | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| espn_cache / espn_settings | 0 / 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| ranking_sets / ranking_entries | 1 / 106 | L0 live data -> L8 planner |
| app_settings | 6 | L0 live data -> L8 planner |

## B4: B4. Markets (player values)
Home: L5 market price (fc_value no-overpay currency, DATA-FC daily night 1); pick_values empty -> parked

| table | rows | home / repair |
|---|---|---|
| dynasty_values | 437 | L5 market price |
| dynasty_value_history | 394 | L5 market price |
| pick_values | 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| nfl_historical_adp | (B1) | L5 market price |

## B5: B5. News and signals
Home: L0 news -> L12 typed extraction (DEAD on 401: D2 repair night 1) -> L2 news-role events, Coach news check

| table | rows | home / repair |
|---|---|---|
| news_items | 1,619 | L0 news -> L12 typed extraction |
| nfl_news_signals | 415 | REPAIR D2 (401 key) night 1 -> L2/L12 |
| nfl_news_extraction_attempts | 60 | L0 news -> L12 typed extraction |
| nfl_news_events / nfl_news_event_extraction_cache / news_source_valida | 0 / 0 / 0 / 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| press_conferences / press_availability / yt_channels | 0 / 0 / 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| nfl_tweet_line_watch / twitterapi_io_usage | 0 / 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |

## B6: B6. People and chat-derived (app DB side)
Home: L6 people read (archetypes, signals, sentiment, pulse, credibility) -> L7 P(yes) once E1 passes

| table | rows | home / repair |
|---|---|---|
| manager_archetypes | 6,575 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| manager_archetype_jev | 1,395 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| manager_signals | 1,415 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| manager_player_view | 135 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| manager_profiles | 1 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| people_pulse / people_pulse_runs | 45 / 11 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| people_credibility | 140 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| negotiation_threads / negotiation_events | 0 / 0 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| trade_proposal_cache | 3 | L6 people read |
| coach_answers / coach_briefs | 3 / 1 | L6 people read |
| reasoning_claims | 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |

## B7: B7. Engine, serving and evaluation
Home: L11 graders + report card, L8 plans, L13 ops; engine spine tables live

| table | rows | home / repair |
|---|---|---|
| engine_events / engine_event_entities | 58,591 / 142,933 | L11 graders + report card, L8 plans, L13 ops; engine spine tables live |
| engine_state | 680 | L11 graders + report card, L8 plans, L13 ops; engine spine tables live |
| engine_snapshots / engine_runs / engine_cursors / engine_fields / engi | 8 / 66 / 12 / 7 / 6 / 0 / 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| served_numbers | 1,424 | L11 graders + report card, L8 plans, L13 ops; engine spine tables live |
| number_audit | 55 | L11 graders + report card, L8 plans, L13 ops; engine spine tables live |
| brain_report | 295 | L11 graders + report card, L8 plans, L13 ops; engine spine tables live |
| weekly_prediction_snapshots | 2,379 | L11 graders + report card, L8 plans, L13 ops; engine spine tables live |
| weekly_ensemble_fits | 2 | L11 graders + report card, L8 plans, L13 ops; engine spine tables live |
| fantasy_coordinator_fits / shrinkage_fits / shrinkage_k | 5 / 1 / 6 | L11 graders + report card, L8 plans, L13 ops; engine spine tables live |
| model_gate_audits | 1 | L11 graders + report card, L8 plans, L13 ops; engine spine tables live |
| trade_outcomes / trade_outcomes_synthetic | 94 / 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| decision_recommendations / decision_basis / rec_ledger / follow_ledger | 9 / 0 / 0 / 4 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| warroom_requests / warroom_action_log / warroom_layouts / campaign_ste | 1 / 4 / 0 / 0 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| model_* governance (17 tables) | model_registry 11, model_feature_contrac | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| sync_log / schema_migrations / db_health_checks / audit_log / audit_re | 90 / 84 / 1 / 27 / 0 / 4 / 131 / 47 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| users / user_identities / auth_sessions / auth_invites / auth_login_fl | 1 / 0 / 50 / 0 / 0 / 0 / 5 | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| sqlite_sequence | 58 | L11 graders + report card, L8 plans, L13 ops; engine spine tables live |

## C. Files outside the live DB

| source | rows | home / repair |
|---|---|---|

## C1. `~/Documents/GitHub/gridiron-hq/data` (gitignored satellites)

| source | rows | home / repair |
|---|---|---|
| data/line-history/nflverse.sqlite | 2.16 GB | see group home |
| data/derived/league_chat.sqlite | 66 MB | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| data/derived/sleeper_history.sqlite | 204 MB | see group home |
| data/derived/player_value.sqlite | 69 MB | USE: APM efficiency prior -> ROS-USAGE (U4, night 11) |
| data/derived/feature-store-study.sqlite | 1.8 GB | see group home |
| data/line-history/line_history.sqlite | 21 GB | USE: labelled pressers/transactions -> O3-JEV shadow (U3), zero spend |
| data/line-history/jev_live_plays.sqlite | 281 MB | see group home |
| data/line-history/jev_yt_triage.sqlite | 71 MB | see group home |
| data/live-tape/live_tape.sqlite + kalshi_moneyline_minutes.csv | 107 MB | see group home |
| data/grading_panel.sqlite | 9.6 MB | see group home |
| data/line-history/extract-2026-09-16.sqlite | 104 MB | see group home |
| data/nflverse.sqlite | 0 B | EMPTY: parked (no producer in-season) unless the variable sweep names a feed |
| server/data.sqlite (+11 .pre-migration-*.bak) | 866 MB | see group home |
| server/data/app.sqlite | small | see group home |

## C1a. People and messages we hold (chat corpus, table by table)

| source | rows | home / repair |
|---|---|---|
| messages | 16,724 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| messages_ext | 5,433 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| participants | 9 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| entity_map | 9 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| extract_runs | 661 | see group home |
| jev_chat_signals | 538,857 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| jev_chat_done | 16,335 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| manager_chat_profile | 10 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| manager_player_sentiment | 135 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| manager_notes | 23 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| negotiation_profiles | 10 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| negotiation_profiles_history | 10 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| nick_voice_profile | 15 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| screenshot_trades | 19 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| league_member_identity | 8 | see group home |
| manager_signals | 216 (8 rosters) | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| manager_player_view | — | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| manager_archetypes (rows by season) | 2023 299 · 2024 296 · 2025 377 · 2026 28 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| manager_archetype_jev | 45 members × 8 questions = 1,395 rows, e | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| people_pulse | — | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| people_credibility | — | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| manager_profiles | 1 row total | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| trade_outcomes | 94 rows, 2026 (proposals with model P(ac | see group home |
| negotiation_threads / negotiation_events | 0 / 0 | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |

## C2. `~/gridiron-local` (local only, never committed)

| source | rows | home / repair |
|---|---|---|
| data.sqlite | 978 MB | see group home |
| wt/O2-ML/.local-db/data.sqlite, wt/O3-JEV/.local-db/data.sqlite | 978 MB each | see group home |
| wt/*/server/data.sqlite (fixpr2-304, O1-RADAR, profiles-run) | 2 MB, 2 MB, 4 KB | see group home |
| rnd/loop/data/dp/fpecr_weekly_wp.parquet (1.1 MB), fpecr_redraft_rp.pa | 6 MB | see group home |
| rnd/loop/data/espn_proj_hist/ (18 files, 11 MB) | 11 MB | see group home |
| rnd/loop/data/terms/ | — | see group home |
| rnd/loop/data/r*/data.sqlite (6 × ≈930 MB), r*/sleeper.sqlite (2 × 204 | ≈6 GB | see group home |
| rnd/loop/data/*.csv | parquet` (r2 crowd-start agg, r5x buzz/w | see group home |
| rnd/skill/team_seasons.sqlite (116 MB: team_seasons 27,648, team_weeks | ≈190 MB | see group home |
| rnd/skill/trades/trades_ext.sqlite (sides_ext 15,004) | 5.6 MB | see group home |
| rnd/data/sleeper/drafts.sqlite (picks 429,693, drafts 2,554, leagues_d | 35 MB | see group home |
| rnd/data/pbp-redzone-4thdown/play_by_play_2025.csv (98 MB), ftn-charti | ≈115 MB | see group home |
| rnd/coach-01a/sleeper.sqlite | 204 MB | see group home |
| voice-01/chat-copy.sqlite, private/league_chat.bak-* (6) | ≈450 MB | L6 people read / L12 (screenshot_trades -> E1 ledger, night 4; profiles rebuilt 9/24) |
| warroom/plans.json | — | see group home |
