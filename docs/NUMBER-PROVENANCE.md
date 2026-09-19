# Number provenance and routing audit — 2026-09-18

Read-only audit of every future-facing number Nick sees: where it is computed, every constant on its path classified FV (fitted + validated on a held-out season) / F (fitted, not validated) / B (borrowed) / H (hand-set) / D (definitional), and every place the same number is computed differently. Rule it serves: section 00 part A2 (rule 3) of FANTASY-ENGINE-MASTER-PLAN.md. Every item below is mapped to a step in section 00 part E3.

I've finished the audit. The short answer is that most of what you see for the future isn't fully historical yet. Only a couple of numbers are fitted and checked on past seasons end to end. Several validated models sit behind hand-set wrappers, and the title odds run on a different set of projections from every other page.

**Commits audited:** I started at `72382a6` and HEAD moved to `644351c` while I worked. Only `server/services/weekly-learning.js` changed on a number path: `cf6ae18` puts the in-season ensemble retrain on the refresh loop. Paths below are under `R = /Users/nick_matta/Documents/GitHub/gridiron-hq`.

**What is actually running:**
- The live server (PID 49559) started at 06:08, before the chance-to-play fix (`f60c0d2`, 06:37 onward).
- The production database has no `nfl_availability_role_rates` table.
- So every chance-to-play number you see comes from the old path. By the play-chance-live TDD report, healthy starters average about 0.75 against a real play rate of about 0.95.

---

## (a) Registry, grouped by the number you see

Classes: **FV** = fitted and checked on a held-out season · **F** = fitted, not validated · **B** = borrowed · **H** = hand-set · **D** = definitional.

### The shared base (feeds every weekly number)

| Constant | file:line | Value | Class | Evidence |
|---|---|---|---|---|
| Volume shrinkage (target share, carry share, QB attempts, team pass and rush volume) | `shrinkage_k` fit #1, applied at R/server/services/shrinkage-fit.js:515 | 0.17 / 0.075 (RB), 0.09 (others) / 0.26 / 1.28 / 1.78 | FV | `scripts/promote-volume-shrinkage.mjs`, commit `7b4f2d6`. Walk-forward 2023–25, MAE 4.749 → 4.363. **Weekly engine only.** |
| Old hand-picked volume values | R/server/services/projections.js:95-96 | share 6, team volume 10 | H, and measured as far too strong | Still used by season sim, ceiling lineup, draft, and the ROS structural prior (shrinkage-fit.js:515-521) |
| Efficiency shrinkage | projections.js:97-99 | yards 34, catch rate 26, TD rate 70 | H (tested only as part of the whole head) | The fitted version made 2025 worse |
| Interception rate shrinkage | :124 | 1600 | F | Swept on 2022–25; no held-out season |
| Target-share prior; carry prior | :547, :551 | 0.06; 0.25 (RB) / 0.02 | H | Measured bias in low-evidence players (WD) |
| Availability prior and k; QB share prior and k | :644-645, :668-669 | 0.66 / 0.8; 0.45 / 0.5 | H (picked partly on 2025) | Own comment says it's in-sample |
| Dispersion fallbacks and caps | :596-599 | 1.6, 12, clamp 1.2–30 | H | — |
| QBR nudge | :272 | k 0.073, centre 53.26 | F, can't be reproduced | The 2021–24 QBR data is gone |
| Season decay | :162 | 0.35 | FV | Fit on 2023–24, checked once on 2025 |
| Weekly role recency | weekly-ensemble.js:55 | decay 0.05, half-life 5 | FV | `scripts/fit-role-recency.mjs` |
| Ensemble weights, weeks 5–18 (fit-1) | `weekly_ensemble_fits` id 1 | [.20, .40, .15, .05, .20] | FV | Fit 2023 → pick architecture 2024 → test 2025: MAE 4.334 vs 4.425. Re-fit on the new head was flat, so fit-1 stayed. |
| Early weeks 2–4 (fit-2) | id 2 | structural head only | FV | 2025: 4.71 → 4.32 |
| Fantasy coordinator | `fantasy_coordinator_fits` id 6; hyperparameters at fantasy-coordinator.js:106-116 | intercept 0.578; shift weight 0.35 (hit its cap), k 0.538; game-script k 0.054 (gain 0.002) | F: validated once against the structural head, never against the live ensemble | Fitted 09-17 19:00, before the new volume shrinkage went live (23:07). Refit daily with no gate (scheduler.js:947). |
| Weekly spread (per-position sigma, downside multiplier) | projections.js:863-866 | 0.30/0.30/0.20/0.25, 1.6 | FV | `scripts/fit-weekly-coverage.mjs`; 2025 coverage 0.782 (just inside the band) |
| Chance to play, **live path** | contingency.js:75-80, 518, 590, 745 | fitted report-status rates; durability prior (shrink 1.2, 0.82 penalty, fallbacks 0.92 / 0.75); capped at the prior | Fitted rates FV; the prior and the cap are H | Measured calibration error on starters 0.226 |
| Chance to play, HEAD role model | contingency.js:545 | k = 5 role cells | FV but **not deployed** | play-chance-live TDD: log loss 0.551 → 0.396 |
| Betting-line lift | waiver-brain.js:116-146; gamescript.js:331, 401 | OLS on spread and total (r² 0.026 / 0.044); clamp 0.75–1.3; RB 0.65 run / 0.35 pass | Coefficients F; RB split H | **Never validated as a fantasy-points multiplier.** The coordinator gave the same signal about zero weight. |
| Matchup / DvP / home field | matchups.js:25, 370 | switched off, multiplier 1 | FV (tested and failed, so off) | — |
| Volume redistribution when a teammate sits | player-week-engine.js:262 | off | FV (measured, didn't help) | — |

### The numbers, one by one

| Number | Where shown | Computed by | Extra constants on its path |
|---|---|---|---|
| This week's points per player and lineup total | Lineup.tsx, the League Hub card, the matchup card | `lineupCall` → `startSitWeekPoints` (lineup-brain.js:273) = `current_week_ppg` (trade-engine.js:274) × betting-line lift | Base above, plus the missing-data fallback of 0.92 (trade-engine.js:261, H) |
| Coin flip / lean / clear | Lineup.tsx slots | lineup-brain.js:487-490 | 1.5 and 4.0 points (:327-328), **H**, and labelled in the code as not fitted. The response still says `confidence_basis: 'calibrated_on_week_points'` (:554). |
| Warnings and "X% likely to play" | Lineup.tsx | lineup-brain.js:535 | Warning cut at 0.75, H |
| Floor / ceiling lineups (p10 / p90) | the objective toggle on Lineup.tsx | `playerWeekDistribution` (player-week-engine.js:775) | Weekly spread FV; old chance to play |
| Win probability, stance, variance swaps | MatchupPosture.tsx | `lineupPosture` (lineup-posture.js:206) | Spread scale 1.63 (:136): FV, **but a re-fit under the new chance to play gives 1.45**, outside the pre-set tolerance. Position spreads 0.40/0.57/0.63/0.67 (:89): H (a fitted version didn't beat them). Stay-silent edge of 23 points (:81): derived from a hand-set 0.3-point win-chance rule. Swap floor 0.15 points (:296): H. |
| Swap odds, "right about X%", urgency | MyTeam LineupDiffCard | `lineupDiff` (trade-engine.js:2108) | Sigma 14.5 (:2020): FV (fit 2023–24, checked on 2025), but the fit script is only in the scratchpad (record in week2-numbers TDD). Urgency cuts 0.60 / 0.75 (:2022): H. Swap against an empty slot uses 0.92 (:2184): H. |
| Waiver upgrade, cut, held-back list, stashes | WaiverWire.tsx and the teaser | `waiverBoard` (waiver-wire.js:145) | Minimum gain 0.05 (:67), tie 0.005, stash threshold 0.5 (:288), minimum projection 4 (trades.js:435), "likely to play" at 0.5 (:299): all **H**. The +3.45-point historical replay tested a different, simpler drop rule, not the live cut rule. |
| Rest-of-season points per game | pill tooltips, waivers, trades | `buildRosProjections` (ros-projection.js:364) | Weight on structural 0.5, evidence k 4, market prior (:69): **FV** (2024 and 2025, weeks 1–10 only). No availability term. |
| Trade lineup gain, "over the season", verdict, letter grade, fairness | TradeCard.tsx | `evaluate` (trade-engine.js:957) | Blended value = 0.25 × this week + 0.75 × rest of season (:300): **H**. "Over the season" = weekly gain × 17 (:1007): wrong horizon. Verdict cuts 2.5 / 0.8 (:941): H. Letter grade (TradeCard.tsx:53): H. Fairness cuts 4% / 12% (:1144): H. "Both improve" 0.15, "fair enough" −1.25 / −8% (:1048, :1057): H. |
| Trade ranking (decides which deal is shown per partner, and the order) | TradeLab Find Deals | `findTrades` score (trade-engine.js:1417) | Value giveaway cost 0.9 (:82): H. Fairness curve and 0.60 cap (:1358): H. 0.2 × joint gain: H. Perception ±10% (:1375): H. "Hard" manager 0.55 (:1339): H. Search filters: skew −0.16 / 0.30, gain ≥ 0.4, value −12% / +18%, throw-in 0.05 (:1306-1329): H. Playoff-week importance 4 (trade-horizon.js:35): **B** (ETR's 4:1 finals-to-advance rate, used out of context). Playoff odds default 0.5 (:81): H, and nothing ever passes real odds. |
| How the other manager reads a deal (no odds are shown) | ranking only | counterparty-pricing.js:49, 120 | Perception cap 0.15, receptiveness 0.7–1.3, chat-volume divisor 300, 0.65 / 0.35 blend, accept-rate weight after 15 decisions, your priors −0.10 / −0.05 / +0.08 (:27-87): H. Sentiment cap 0.12 at 5 mentions (manager-signals.js:123-127): H. Your per-manager priors (:313-323): H. Talk-vs-model gap 3.0, praise 2.3, sour 1.75, price moves 5–10% (talk-vs-model.js:38-41, 133-139): H. Bluff detector: base bluff rate 0.35 (weight 4), 10-day window, respect / probe cuts 0.7 / 0.45 (bluff-detector.js:35-38, 191): H. **There is no acceptance probability anywhere in live code.** The master plan's "P(accept) band" doesn't exist yet. |
| Trade floor / ceiling change | TradeCard | `lineupSpread` (trade-engine.js:688) | Normal approximation: checked against a brute-force simulation, not against real seasons. Correlations (`correlation_estimates`, 20 rows): **F**, pooled over all seasons. Default correlations 0.05 / 0.02 and the QB–receiver scaling (target share / 0.19, clamped 0.3–2.2) (correlation.js:125, 158): H. |
| Title odds, playoff odds, expected wins, trade title impact, Title-odds tab, sense-check | MyTeam, TradeCard, TradeLab | `simulateSeason` / `tradeImpact` (season-sim.js:173, 361) | **No historical calibration at all.** 1,500 / 1,200 / 800 runs, 600-draw pools, default 6 playoff teams and 14-week season (:39, 77, 198): H/D. The sense-check's "material" title change of 0.01 (trade-verify.js:114): H; its noise level of 0.0155 was measured. |
| Ceiling-lineup hit chance and percentiles | MyTeam, Ceiling tab | ceiling-lineup.js:144 | Structural head with the old hand-picked shrinkage; **chance to play fixed at 1** (:80-81); the target defaults to your own p90 (:182): H. |
| Weekly range, position strength, league rank, fix list, "Optimal lineup" | TeamScout, MyTeam Roster tab, PostDraftPlan | `selfScout` (trade-engine.js:1796) | Strength / weakness at 1.12 / 0.88 (:1841), injury drop-off > 4, bye cluster ≥ 3, "contender" means rank ≤ 3 (:1850-1896): all H. |
| Needs, surplus, and "their window" labels | TradeCard; also used to red-flag trades | `analyzeLeague` (tradelab.js:103) | 0.80 / 1.15 (:18), flex split 0.4 / 0.5 / 0.1 (:20), strong / weak 1.05 / 0.95, ages 25.5 / 27.5 (:180-184): H. Uses **ESPN's preseason projection** for value (edge.js:31-48): **B**. |
| Target-a-player "Projected X pts · Y/wk", SOS, offer ladders | TradeLab | `playerOutlook`, `offerFor` | Total = weekly number × (18 − week) (trade-engine.js:330): H horizon. Offer range 0.70–1.65 of the target's price, "can cover him" under 1.0, overpay line at 1.35× (:1572, 1615, 1670): H. SOS always shows 1. |
| News "Projected outcome", usage, % impact | News.tsx (labelled SHADOW) | `newsFantasyTracker` (news-fantasy-impact.js:70) | Uses the chance-it's-true and role change that the Haiku model pulled out of the story, times its own confidence; clamp 0.1–1.75 (:88-92). LLM-generated, not fitted. |
| Opportunities (targets, carries, attempts) | News.tsx | structural head `params` | F. The volume shrinkage was validated on points, never on opportunity itself (the plan's WO step). |
| Buy/Sell verdict; scout report | PlayerCard | players.js:120, 160; edge.js:293 | ±5% 30-day market-value rule: H. The prompts hand Claude a schedule-strength rank (players.js:137, 182) and a fantasy-playoff SOS (edge.js:304-321), and **neither signal is validated**. |
| "The football" verdict | Lineup.tsx | player-case.js:236-253 | Hand-set factor weights, lean cut ±0.8. **Includes the defence-vs-position factor (:102-124) that matchups.js retired.** |
| Draft pages (not audited in depth; draft is done) | DraftRoom, LiveDraft | draft-assist, draft-survival, draft-lookahead | Market curve FV. Model nudge 0.2: fitted, never significant. "Gone by" curve fitted on two 2026 drafts, checked leave-one-draft-out. Spread calibration 1.30: measured. Bench targets and demand, bench discount 0.25, fallback band: H. |

---

## (b) Unfitted constants, ranked by how much they can change what you see

1. **Season-sim inputs and horizon** (it isn't a constant, but it has the most weight). No calibration test exists. **Test:** calibrate week-w playoff and title odds against real finishes (your 12 league-seasons plus the replay leagues), after fixing the items in (c)-1.
2. **The old chance-to-play prior** (shrink 1.2, 0.82 penalty, cap at the prior, 0.92 / 0.75 fallbacks). It cuts every weekly number about 20–25%. **Fix:** deploy the validated role model and track calibration each week.
3. **The 0.25 / 0.75 blend of this week and rest of season.** It drives every trade gain, verdict, grade and selfScout rank. **Test:** replay at week w of 2021–25 and pick the weight that best predicts the realized rest-of-season lineup change (sign and rank).
4. **Playoff-week importance 4 (borrowed) and the default playoff odds of 0.5.** **Test:** measure in the replay how much each extra point moves title odds, by week and team strength (already planned for WO), and pass real playoff odds.
5. **The trade objective:** value giveaway 0.9, fairness curve and 0.60 cap, 0.2 × joint gain, the search filters. **Test:** replay trades for realized value, fit acceptance on decided proposals (about 30), and publish a sensitivity table until then.
6. **Betting-line lift at full strength.** **Test:** weekly walk-forward on 2023–25, with and without the lift, graded on MAE and start/sit pair accuracy. The coordinator result already suggests the answer is no.
7. **Start/Sit's 1.5 / 4.0 cuts.** **Fix:** replace with the already-validated curve Φ(gap / σ), re-fit on the week-points basis.
8. **Swap sigma 14.5 and the 0.60 / 0.75 urgency cuts.** **Test:** re-fit on the live basis (with chance to play and the lift, including weeks 2–4), and commit the fit script.
9. **Spread scale 1.63 is stale** (1.45 under the new chance to play). **Fix:** re-run `scripts/fit-posture-calibration.mjs` under its own gate.
10. **Waiver rule** (0.05, 0.5, 4, the cut rule). **Test:** put the live rule through the 2021–25 within-league replay alongside the old one.
11. **Counterparty caps and priors, talk-vs-model, bluff detector.** **Test:** logistic fit on decided proposals, leaving one manager out; check declarations against later transactions.
12. **Needs / surplus / window cut-offs and selfScout thresholds.** **Test:** does the red-flag filter predict declined proposals? Replace "contender" with calibrated odds.
13. **Efficiency shrinkage, target-share and carry priors, availability 0.66 / 0.8.** **Fix:** joint walk-forward fit that leaves 2024–25 untouched (WD).
14. **Correlations and the QB–receiver scaling.** **Test:** coverage of real lineup totals on 2025.
15. **Coordinator:** refit on the current head and gate it against the live ensemble, not the structural head.
16. **QBR k.** Re-sync 2021–24 and re-run.
17. **Label thresholds** (verdict, grade, fairness, tags) and **wrong horizons** (× 17, × (18 − week)). The horizons need no fit, just remaining-weeks definitions.
18. **Football-case weights and the DvP factor:** remove it, since it already failed its test.
19. **News LLM multipliers:** grade them on the settled signals the tracker already records.
20. **Player verdict and the scout prompts:** drop the SOS numbers; grade Buy/Sell against the next 30 days.
21. **Draft bench constants.** Low priority now the drafts are done.

---

## (c) Routing inconsistencies

1. **Title and playoff odds live in a different projection world.**
   - Projections are built through 2025 only, with no 2026 games and the old hand-picked shrinkage (season-sim.js:180, :380).
   - Any 2026 rookie with no earlier history (Jadarian Price, Jeremiyah Love and others) has no projection and is **never started** (:217).
   - Nothing passes a start week, so it defaults to 1: week 1 is simulated again and the real standings are ignored (model.js:528, :545; MyTeam.tsx:62; TradeCard.tsx:178; title-odds-trades.js:66; trades.js:818).
   - Playoffs are fixed at weeks 15–17 (season-sim.js:195), while the trade horizon uses each league's real calendar (trade-horizon.js:54-70). Leagues 1 and 3 differ.
   - So the Title-odds tab's "points and title disagree, ignore the points ranking" note (title-odds-trades.js:94-128) is partly comparing two different projection sets.
2. **The coordinator is applied on the wrong base.** It was fit on actual − structural (fantasy-coordinator.js:324), but live code adds it to the ensemble number (trade-engine.js:269; fantasy-coordinator.js:571). This is latent in weeks 2–4, where the ensemble equals the structural head. From week 5, live = ensemble + 0.147 × shift − 0.20, which was never validated.
3. **Game script is counted twice.** It's inside the coordinator (fantasy-coordinator.js:407-418), then the lift multiplies on top (lineup-brain.js:273-281; trade-engine.js:1974-1979).
4. **"This week's lineup" is computed on four different bases:**
   - Start/Sit, the League Hub card and the matchup card use the lifted week number.
   - The waiver board uses the unlifted `current_week_ppg` (waiver-wire.js:90, 96, 172), so the teaser on Lineup.tsx sits on a different basis from the total above it.
   - The MyTeam Roster tab ("what the engine would start this week") and PostDraftPlan use the 0.25 / 0.75 blend (trade-engine.js:1804; trades.js:118).
   - The Ceiling tab uses the structural head with chance to play = 1 (ceiling-lineup.js:62, 80).
5. **Confidence wording disagrees across pages.** Start/Sit calls a 4-point gap "clear" (lineup-brain.js:327-328, 487). The League Hub card calls the same gap "medium, right ~61%" (trade-engine.js:2020-2023).
6. **Current week has three definitions.** `tradeWeekContext` (trade-engine.js:116), `leagueCurrentWeek` (league-week.js:12; used at trades.js:381) and `currentNflWeek` (weekly-learning.js:367). All three say week 2 today, but they can diverge.
7. **Needs / surplus has three live versions:**
   - ESPN-projection value at 0.80 / 1.15 (tradelab.js:18), which feeds the trade red flags (trade-engine.js:1068);
   - FantasyCalc value at 0.80 / 1.15 (leagues.js:247), on the Leagues tab;
   - the blended number at 0.88 / 1.12 (trade-engine.js:1841; TeamScout.tsx:92).

   All three can appear inside League Hub.
8. **The floor/ceiling "posture" is decided in four places:** your Start/Sit choice (lineup-brain.js:585), the matchup card's stance (lineup-posture.js:253), selfScout's rank rule (trade-engine.js:1896), and the ceiling lineup's target (ceiling-lineup.js:182).
9. **Real playoff odds never reach trades** (trade-horizon.js:81; trade-engine.js:1207; trades.js:537), even though the same page family computes them.
10. **Chance to play is inconsistent across consumers:**
    - Live runs the old code and tables (see the top of this report).
    - The season sim prices future weeks on the durability prior (season-sim.js:212).
    - The ceiling lineup ignores chance to play.
    - Rest of season and the trade playoff leg carry no availability (trade-engine.js:279-292), so IR players keep full value.
11. **Fits on stale or different bases.** The spread scale was fit before the lift and before the new chance to play (lineup-posture.js:221-223). The swap sigma was fit on the unadjusted ensemble for weeks 5–17.
12. **Wrong horizons are shown and sent to Claude.** "Over the season" = × 17 (trade-engine.js:1007; TradeCard.tsx:108). The Target-a-player total = × (18 − week) (trade-engine.js:330; TradeLab.tsx:870). Both go into the sense-check prompt (trades.js:720, :741).
13. **`offerFor` / `offerForMany`** skip the counterparty read and the horizon weighting that `findTrades` uses (trade-engine.js:1551-1788).
14. **The `findTrades` cache ignores chat and counterparty inputs** (trade-engine.js:1213-1220). The fix already exists as `counterpartyDataKey` (counterparty-pricing.js:207), but nothing calls it. `negotiationProfilesFor` also has no caller.
15. **Retired schedule and DvP signals still surface:** as a Start/Sit reason (player-case.js:102), as SOS on the Target panel (TradeLab.tsx:874), and in the LLM prompts (players.js:137, 182; edge.js:304-321).
16. **Two doors into the same weights.** The ensemble table can now be written by the in-season auto-promotion (weekly-learning.js:220-323, on the loop since `cf6ae18`) as well as the promote scripts. The coordinator refits daily with no gate. A second win-now/playoff split (waiver-brain.js:59) lives in orphaned code.
17. **The News page projection** uses the engine number without the coordinator or the lift (news-fantasy-impact.js:86-97), so its "baseline" differs from Start/Sit for the same player and week.

---

## (d) Verdict

Of about 24 families of future numbers you can see:

| Status | Count | Share |
|---|---|---|
| Fully historical and on one route | 2 | ~8% |
| Validated core with hand-set, stale or mis-routed wrappers | 9 | ~38% |
| Not historical at all | 13 | ~54% |

- **Fully historical:** rest-of-season points per game (weeks 1–10), and the weekly ensemble number shown as "/wk" on the Target panel.
- **Partly historical:** this week's points, the floor/ceiling lineups, chance to play, matchup win probability, swap odds, waiver stashes, trade floor/ceiling changes, opportunities, and the draft market curve.
- **Not historical:** trade ranking and acceptance, trade verdicts, grades and fairness, title and playoff odds and every title-odds trade number, the ceiling lineup, selfScout, needs and windows, News projections, Buy/Sell, and the football case.

These three would move the most:
1. Deploy the validated chance-to-play model together with its restart.
2. Rebuild the season sim on the live projections and real standings, then calibrate it against past seasons.
3. Replace the 0.25 / 0.75 blend and the playoff-week importance with the replay measurement.
