# ENGINE-SPECS: build-ready specs for the trade engine core (2026-09-23)

Design: TRADE-INSANE-RND.md ("Manager Clones + Title-Odds Chess"). Cites are file:line on **origin/main `19a4eea1`** (C1) unless a PR is named. Every number has a command id (Cn, listed at the bottom). "guess" marks a guess. All DB numbers come from the local copy, not production.

Facts that change the plan (read these first):
1. **RL-6-3 has landed** (#192, `0558bbcc`). tradeImpact already keys draws by player identity and publishes a paired SE (season-sim.js:477-574). So CE-09's "paired seeds" part is done. What CE-09 still needs is the ladder, the persistence and the SE at 10k runs (C15).
2. **P(accept) already has one producer**: `acceptanceBand` (trade-acceptance.js:142). "Their price" has one producer: `playerValuation`/`readDeal` (counterparty-pricing.js:543/:885). CLONE-01 extends both of these. It adds no third module.
3. **ESPN labelled trade decisions are anecdote-sized.** Counting only the decider's side of a linked proposal (the SY-01 rule), there are 37 decisions (7 accepts, 30 declines) in 3 leagues. 17 of the 37 are Nick's own, which leaves **20 leaguemate decisions** (C3). The design doc's 58/26 counts include proposer-side duplicate rows (C4). The clone test cannot be powered on ESPN. Its primary arm has to be the Sleeper waiver-choice data (21,484 manager-seasons, C9).
4. **No as-of FantasyCalc history exists locally.** `dynasty_values` holds only the latest value per player, 425 rows (C6), and FC history starts only when #170 (migration 073) merges. The clone test's "fair by FantasyCalc" baseline therefore works only for decisions after the snapshots begin. For history it needs a stated proxy (see CLONE-01).
5. **Migration numbers are already contested in open PRs.** 071 appears twice (#174 `071_rec_ledger`, #184 `071_live_inactive_claims`), 072 appears twice (#164 and #166 both carry `072_fantasy_coordinator_fit_promotion`, which is the same S-03 file), and 073 is in #170 (C17). New migrations here start at **074**.
6. **Open PRs touch engine files** (C17). season-sim.js: #202. contingency.js: #204. counterparty-pricing.js: #203. trade-engine.js: #164 #166 #170 #174 #202 #204 #205 #209 #212. routes/trades.js: #170 #174 #190. Each spec lists the PRs it must wait for.

---

## BLEND-02: ESPN-based stack with Vegas, calibrated weekly range (critical)

| ID | plan item | goal | files (file:line on origin/main) | acceptance | deps |
|---|---|---|---|---|---|
| BLEND-02-a | Layer 2 projection stack; WORK-QUEUE BLEND-02 (redefined, :663) scoped per RL-7-2 (:793) to Vegas only | Add one layer on top of ESPN's weekly number: Vegas implied team total + spread as of lock, as a learned multiplier by position. It ships only if it beats ESPN alone. The layer lives in weekly-blend.js as one more candidate, so there is still one producer for "this week's points" | `server/services/weekly-blend.js` (new in #164; the switch is `SERVED_BLEND.on = TOURNAMENT_DECISION.on && SERVING_HOLDS.length === 0`); call site trade-engine.js:388 (`currentWeekPpg`), which #164 moves to one producer line (~:413 on #164); gamescript.js:389 `gameScriptFor` / :416 `linesFor` (read only, the one lines producer); waiver-brain.js:163 `vegasLift` (retired onto ESPN's number, then deleted or made a thin reader); lineup-brain.js:358 and trade-engine.js:2942 (vegasLift callers); `scripts/weekly-blend-tournament-lib.mjs` (#164) gains a `vegas` candidate | **PRE first** (commit the prereg before any number): walk-forward 2023-24, graded the way BLEND-01 graded (pair accuracy on start/sit pairs plus points per decision). Baseline: ESPN alone, 0.683 pair accuracy 2023-24 (BLEND-01 result, quoted from WORK-QUEUE.md §17, not re-measured here). The layer ships ON only if it beats ESPN beyond the prereg MDE on 2023-24 AND holds in direction on 2026 W1-3 (a forward look, logged in HOLDOUT-LEDGER.md). 2025 is not opened: no local 2025 ESPN archive exists (C14). **RED:** (1) with `vegas` off, current_week_ppg is byte-identical to the #164 head for all 6 leagues (reuse #164's `round2/dump.mjs`); (2) a fixture where a team's implied total rises 3 points moves that team's WR's served number in the fitted direction, and an off-team control does not move; (3) `git grep -n vegasLift server` shows only the weekly-blend reader | #166 then #164 merged (#164 is stacked on the S-03 head that #166 carries) |
| BLEND-02-b | same; C-14 folded in | Serve a calibrated 80% range per player-week around the served point. Replace the uncalibrated `weekDist.p10/p90` at the one range site with split-conformal quantiles (Mondrian bins: position x week band) built with conformal.js | trade-engine.js:435 (`weekDist`), :481-484 (floor/ceiling/avg/boom/bust, the one served weekly range site); projections.js:1007 `weeklyDistribution` (stays as the shape source); conformal.js `buildConformal` (a reused utility, not a producer); weekly-blend.js (emits `range`) | **PRE:** calibration set 2022-23, grade 2024, forward 2026 W1-3. Measure the incumbent first: coverage of today's p10-p90 band, which the prereg records as the baseline (not measured here). Ship rule: the 80% range covers 78-82%... more exactly **77-83% (±3) in every position x week-band cell with n>=200**, and pinball loss at q=0.1/0.5/0.9 beats the incumbent band. **RED:** a fixture with known residuals yields the conformal quantile at rank ceil((n+1)·0.8); a bye returns 0/0 (today's branch at :477) | BLEND-02-a; #88 (open, owns `projection-range.js`) closed or rebased onto this, which is a coordinator call so there are never two range producers |

Notes:
- **Canonical producer:** weekly-blend.js, the one producer for current_week_ppg once #164 lands. The range stays at trade-engine.js:481-482. No new module.
- **Consumers:** every reader of `current_week_ppg`. Start/Sit via lineup-brain.js `startSitWeekPoints`; the waiver board via `GET /:leagueId/waivers` (routes/trades.js:679) and waiver-wire.js; the League Hub card; TradeCard; the trade horizon `adj_ppg` (#164 body). floor/ceiling go to Start/Sit and TradeCard.
- **Data:**
  - ESPN archive 2021-2024 + 2026 at `~/gridiron-local/rnd/loop/data/espn_proj_hist/`, local only, no 2025 file (C14).
  - game_lines 2022/23/24 = 568/570/570 team-game rows, all scored (C11).
  - 2026 lines exist for weeks 1-18: 544 rows, from ESPN for weeks 2-18 (C11).
  - Outcomes: the same assembler BLEND-01 used (`scripts/weekly-construction-walk-forward-lib.mjs`, #164).
- **Migration:** none. Fitted weights are committed constants in weekly-blend.js, following the `TOURNAMENT_DECISION` pattern.
- **Settings:** risk normal, **critical:true** (it is on the fixed critical list). Opus builder, Fable auditor.
- **Size:** -a about 1 day (guess), -b about 1 day (guess).
- **Parallel:** disjoint from CE-01, CE-03 and CLONE-01. It overlaps CHESS-01 and RL-7-1 on trade-engine.js. RL-7-1 edits :390-403, the lines next to :388, so **do not run RL-7-1 concurrently**.

---

## CE-01: game sampler (team points from lines)

| ID | plan item | goal | files | acceptance | deps |
|---|---|---|---|---|---|
| CE-01 | Layer 2 title odds; PHASE-DELIVERABLES CE-01 | A seeded team-points sampler per (team, season, week, key). The mean comes from the implied total, the spread sets the joint margin, and the residual sd is fitted by spread bucket. Future 2026 weeks use ESPN look-ahead lines where they exist and a power-rating fallback (TM-12) where they don't | `server/services/gamescript.js` (extend, the one lines producer: `fitGameScript` :331, `gameScriptFor` :389, `linesFor` :416), add `sampleGamePoints(team, season, week, keyedSeed)`; stats-util.js `keyedSeed` (read only); `test/game-sampler.test.js` (new); `scripts/ce01-calibration.mjs` (new). The plan's new `services/sim/game-sampler.js` is dropped: gamescript.js already owns game-level expectations, so a new file would be a second producer | **PRE:** fit sd on 2022-23, grade 2024 walk-forward. 2025 is used only if HOLDOUT-LEDGER allows it, and the look is logged. Metrics by spread bucket (\|spread\| <3, 3-7, >7): 80% team-points interval coverage within 77-83%, PIT uniformity (KS p>0.05), and CRPS vs the baseline "Normal(implied, one pooled sd)". Ships if coverage holds in all buckets AND CRPS is no worse than the baseline. **RED:** same key gives the same draw; the mean over 20k draws equals the implied total ±0.1; a fixture with a 10-point spread has favourite win share within 0.02 of its fitted value | none |

Notes:
- **Canonical producer:** gamescript.js.
- **Consumers:** none until CE-02, the player sampler that conditions shares on team points. That is a wiring-gate exception: ask the coordinator for a grant, or ship CE-01 inside CE-02's PR. The calibration script is the only reader until then.
- **Data:** game_lines 2022-2025 nflverse, 2,278 scored team-game rows (568+570+570+570, C11). 2026: 64 scored rows, and ESPN look-ahead lines for weeks 2-18 (C11). Whether week 12+ look-ahead lines are real markets or placeholders is a **guess**; the builder must check `open_spread`/`book_count` before trusting them.
- **Migration:** none (fitted sd as committed constants).
- **Settings:** risk low, critical:false (nothing is served until CE-02, and CE-02 is on the critical list). Opus builder.
- **Size:** about half a day (guess).
- **Parallel:** fully disjoint from every other unit here. It can start now.

---

## CE-03: availability sampling as multi-week spells (folds RL-9-2)

| ID | plan item | goal | files | acceptance | deps |
|---|---|---|---|---|---|
| CE-03 | Layer 2 title odds; CE-03 + RL-9-2 (WORK-QUEUE :817) | Replace the sim's per-week independent chance-to-play (baked into each pool as zeros by `sampleWeeks`) with a per-run availability path. Week 1 starts from today's report (weeklyAvailability). Later weeks follow a fitted semi-Markov chain by position (P(out next week \| out k weeks), P(injured \| healthy)), keyed `keyedSeed(world,'avail',p.id)` so trade pairs stay paired. Pools are drawn conditional on playing (activeProbability=1) and multiplied by the path | contingency.js:73 `availability`, :933 `weeklyAvailability`, plus new export `availabilityTransitions()` next to `fitRoleRates` :436; season-sim.js:342 (`activeChance`), :356-358 (pool draw passes `activeProbability`), :377-378 (copula keys), :399-406 (run loop, which applies the path); projections.js:981 `sampleWeeks` (read only, called with 1); `test/ce03-availability-spells.test.js` (new) | **PRE**, taken from RL-9-2: 2023-24 decision weeks 4-14, healthy-starter universe. Predicted P(miss both of the next 2 games) and P(miss all 3), with a player-clustered bootstrap 90% CI, must contain the observed rates at every position. Baseline today: iid 0.22%/0.01% vs observed 4.01%/2.75% (quoted from WORK-QUEUE.md:817, R&D r9, not re-measured here). Do not grade on 2025. Forward confirmation on 2026 W4-12 after W15. **RED:** (1) the stationary per-week availability equals today's `durability_prior` ±0.005, so means are unchanged; (2) P(out wk t+1 \| out wk t) > P(out wk t+1) in the sim; (3) the RL-6-3 null tests still pass: a roster reorder changes nothing, and a free agent added leaves uninvolved teams unchanged to 1e-9 (test/rl-6-3-trade-impact-paired.test.js) | #202 (season-sim.js) and #204 (contingency.js) merged; RL-9-1 (rest discount, same function) runs **after** this unit, not alongside it |

Notes:
- **Canonical producers:** contingency.js for availability, season-sim.js for title odds. No rest-model or new module.
- **Consumers:**
  - `GET /:leagueId/simulate` (routes/model.js:450), `POST /:leagueId/trade-impact` (model.js:465) and TradeCard.tsx:186.
  - `GET /:leagueId/title-trades` (routes/trades.js:659) via title-odds-trades.js:68, shown in TradeLab.tsx:264.
  - The sense-check at routes/trades.js:1195.
  - `myPlayoffOdds` (trade-engine.js:1632).
- **Data:**
  - player_week_usage 2021-2025 = 7,659/7,945/8,436/8,675/8,857 rows (C13).
  - nfl_injuries 2021-2025 = 5,348/5,449/5,451/5,952/5,783 (C12).
  - nfl_availability_rates has 139 rows (C18b).
  - The transition fit is computed and cached like `availability()`, so no table is needed.
- **Migration:** none.
- **Settings:** risk normal, **critical:true**. It moves served title odds. It is not on the 07:50Z fixed list, so log the reason when you add it there.
- **Size:** about 1 day (guess). The trade-engine.js `playerRiskProfile` :1071 / `packageRisk` :1120 half of RL-9-2 is **left out** to keep trade-engine.js free. Queue it as CE-03-follow.
- **Parallel:** it shares season-sim.js with CE-09, so run the two sequentially. Disjoint from BLEND-02, CE-01 and CLONE-01.

---

## CE-09: one currency: the title-odds ladder (critical)

| ID | plan item | goal | files | acceptance | deps |
|---|---|---|---|---|---|
| CE-09-a | Layer 2/4; CE-09 | Generalise `tradeImpact` into `actionImpact(lg, {myTeamId, actions})`, where an action is a roster delta (trade, claim, drop, lineup pin), with tradeImpact kept as a thin wrapper. Add `oddsLadder(lg, myTeamId)`, which returns do nothing / best claim / best trade / best trade + claim. Every rung is simulated on the same paired seed and carries its paired SE | season-sim.js:477 `TRADE_DELTA_NOISE_SE`, :483 `pairedSe`, :498 `tradeImpactSeed`, :508 `TRADE_IMPACT_RUNS`, :519-574 `tradeImpact`; best claim is read from waiver-wire.js:144 `waiverBoard`; best trade is read from trade-engine.js:1765 `findTrades` (read only); routes/model.js:465 (new sibling `GET /:leagueId/odds-ladder`); `test/ce09-odds-ladder.test.js` (new) | **Contract RED:** (1) `git grep` finds exactly one title-odds delta producer (`actionImpact`), and title-odds-trades.js:68, routes/trades.js:1195 and model.js:471 all route through it; (2) "do nothing" gives a delta of exactly 0 for every team; (3) a trade given through the ladder equals `tradeImpact` for the same deal and seed to 1e-12; (4) rungs are monotone by construction only when the search chose them, so the test pins "best trade + claim >= best trade − 2·SE". **SE bar:** median published paired SE is 1.03pp at 800 runs (C15). By 1/sqrt(n) that gives about 0.29pp at 10k runs (arithmetic, not measured). Acceptance: measured median SE <= 0.35pp at 10k on the 23-deal W3 shortlist from RL-6-3, **and** wall time per ladder is recorded. Runtime at 10k is unknown, because 10k is 8.3x the current 1,200 runs (C16). Whether it fits a request is a **guess**; if not, the ladder runs as a job (CE-09-b) | CE-03 merged (same file) |
| CE-09-b | CE-09 tables + OddsLadder | Persist ladder results so pages read and never re-simulate on request: `sim_state` (league, fetched_at, seed, runs, fit stamps) and `action_price` (league, team, action_json, delta, se, rung). A job runs after each league sync. Add a shared `OddsLadder` component on My team, TradeCard and WaiverWire | `server/migrations/074_sim_state_action_price.js` (new, additive); `server/jobs/` (new odds-ladder job, registered in the scheduler); client: new `client/src/components/OddsLadder.tsx`, `client/src/pages/MyTeam.tsx`, `client/src/components/TradeCard.tsx:179-190,367-369`, `client/src/components/lineup/WaiverWire.tsx` | **RED:** (1) the job writes one sim_state row per league sync and N action_price rows; (2) the route serves the stored row (no sim call, asserted with a mock); (3) a stale fetched_at is served with its age label; (4) the wiring gate shows 0 unwired tables; (5) each UI card has at most three lines, and a delta inside 2 SE renders grey (it reuses TradeLab.tsx:289's `clears_noise` rule) | CE-09-a; #174 (rec_ledger 071) merged first, so the migration numbers settle |

Notes:
- **Canonical producer:** season-sim.js tradeImpact → actionImpact. title-odds-trades.js and trade-verify.js stay consumers.
- **Consumers:** TradeLab Title impact (TradeLab.tsx:264-314), TradeCard (TradeCard.tsx:186, :367), the sense-check (routes/trades.js:1195), and the new My team / WaiverWire cards.
- **Data:** live league state only.
- **Migration:** 074 (CE-09-b).
- **Settings:** -a is risk normal, **critical:true** (CE-09 is on the fixed list). -b is risk normal, critical:true for the server/migration part; the UI part goes to a Sonnet lean builder.
- **Size:** each part about 1 day (guess).
- **Parallel:** -a follows CE-03 on season-sim.js. -b touches client files and routes/model.js, disjoint from CLONE and BLEND.

---

## CLONE-01: manager clones (their price + P(accept))

| ID | plan item | goal | files | acceptance | deps |
|---|---|---|---|---|---|
| CLONE-01-a | Layer 1 population model; folds RL-13-3 (:859) | (1) The RL-13-3 fix: shrink each manager's accept rate toward the pooled rate (empirical Bayes), then rescale to the 0.5-is-middle scale. (2) Fit a population "what makes people say yes / what they claim" model offline on Sleeper: a conditional-logit waiver choice (claimed player vs that week's unrostered pool rebuilt from `sh_team_weeks.players_json`) and completed trades as positive-unlabelled data. Features: ESPN rank / season-to-date points proxy, recent points, position need, roster count, loss streak, bye crunch. Output: committed coefficients | counterparty-pricing.js:317-327 (the accept-rate blend, where `shrunkAcceptScore` goes); `scripts/rnd/fit-clone-population.py` (new, local, aggregates only); `docs/evidence/<date>/clone-01-preregistration.md` (new); `test/counterparty-pricing.test.js` | **RED (RL-13-3):** a manager at the pool rate (0.355) with n=15 scores ~0.5, not today's 0.913 (numbers quoted from WORK-QUEUE.md:859, not re-measured). **PRE (population):** fit Sleeper 2021-23, grade 2024, grouped by manager. Metric: waiver-choice log loss and top-1 accuracy vs the baseline "pick the highest as-of value available". No as-of FantasyCalc history exists locally (C6), so the baseline is season-to-date points per game; this deviation from the design doc's FC baseline is stated in the prereg. Ships its coefficients only if log loss beats the baseline with a manager-clustered 90% CI clear of 0 | #203 merged (it edits counterparty-pricing.js:364-371); SY-01 answer-matching rule used for all ESPN counts |
| CLONE-01-b | Layer 1 per-manager clones; feeds AI-05 / TM-01 their-eyes | Per-manager shrinkage of the population coefficients using that manager's own history (empirical Bayes, k fitted on Sleeper). It feeds two existing producers: `playerValuation` (:543) gets a "clone price" factor within the existing `PLAYER_VALUATION_CAP` (:107), and `acceptanceBand` (trade-acceptance.js:142) gets its **centre** from the clone's P(accept). Both keep their caps, their inert-reason contract and `fitted:true` labels. Default-off until the clone test passes | counterparty-pricing.js:68 `VALUATION_SOURCES` (new source `clone`), :543 `playerValuation`, :885 `readDeal`; trade-acceptance.js:65 `ACCEPTANCE_SOURCES`, :142 `acceptanceBand`; `server/migrations/075_manager_clone_fits.js` (new, additive: league_id, roster_id, coef_json, n, k, fit_stamp); `scripts/build-manager-clones.mjs` (new, runs after league sync) | **PRE clone test** (design doc): held-out real decisions vs the "fair by value" baseline, with log loss and AUC grouped by manager. Arm 1 (primary, powered): Sleeper 2024 waiver choices from managers with >=10 prior claims. Arm 2 (ESPN, anecdote-sized): 2026 forward decisions, reported with n and CI, and never a ship gate alone. The ESPN linked decider-side set is 37 (7 accept / 30 decline), 20 of them leaguemates (C3). Only 24 of the 37 fall after 2026-09-03, the first FC timestamp (C5). **Ship rule:** Arm 1 CI clear of baseline AND Arm 2 not worse in direction; otherwise Layer 1 ships default-off (design doc). **RED:** a `zero:['clone']` ablation reproduces today's `acceptanceBand` byte-for-byte; a manager with n=0 equals the population model exactly; the clone factor never exceeds the cap | CLONE-01-a; #170 merged if Arm 2 wants FC as-of values |

Notes:
- **Canonical producers:** counterparty-pricing.js for their price and receptiveness, trade-acceptance.js `acceptanceBand` for P(accept). No new "clone" service: fitting is scripts plus one fits table.
- **Consumers:**
  - trade-engine.js:1922 (`managerFactor`), :1951 (`perceptionFactorFor` :1677), :2238 (`d.acceptance`).
  - `GET /:leagueId/find` (routes/trades.js:732, TradeLab.tsx:427), `/evaluate` (:857), `/offer`/`/offer-many` (:829/:840), `/brain/managers` (:232, TradeBrain.tsx:49), `/market/:playerId` (:1026, valuationMap).
- **Data:**
  - ESPN raw TRADE_* rows (C4): PROPOSAL 93 canceled + 75 pending, DECLINE 58, ACCEPT 29 (17 blank status, 9 executed, 2 pending, 1 canceled), UPHOLD 11, VETO 7.
  - Usable linked decider-side decisions: 37 (C3). Canceled proposals are **not** declines: withdrawn and expired look the same.
  - ESPN 2026 waivers: 55 executed (21 teams); free-agent adds: 89 (25 teams) (C18).
  - Sleeper: 7,952 completed trades, 3 failed; 352,916 FA adds; 198,324 completed + 156,211 failed waivers (C7). About 470-490 leagues per season, 2021-2025 (C8). Sleeper has **no declined trades**, so trades are positives only (PU).
  - Per-manager waiver claims: 21,484 manager-league-seasons, mean 9.2, max 74 (C9).
  - As-of rosters: sh_team_weeks has 385,022 rows with players_json (C10).
  - Mapping Sleeper player ids to our ids is required for any feature beyond Sleeper's own points. Its effort is a **guess**; check the existing rnd/skill mapping first.
- **Migration:** 075 (CLONE-01-b).
- **Settings:** -a is risk normal, critical:false (offline fit plus the RL-13-3 display-scale fix). -b is risk normal, **critical:true** (AI-05 acceptance is on the fixed list).
- **Size:** about 1 day each (guess).
- **Parallel:** counterparty-pricing.js and trade-acceptance.js are touched by no other unit here. Disjoint from BLEND, CE-01, CE-03 and CE-09.

---

## RADAR-01: mispricing radar

| ID | plan item | goal | files | acceptance | deps |
|---|---|---|---|---|---|
| RADAR-01-a | Layer 3 | For every (manager, player): gap = clone price (counterparty-pricing `playerValuation`) minus real value (the trade-engine asset value the finder uses). Extend `newsOpportunities` (the one "news moved value, the league hasn't" producer) so it ranks by the gap and flags "real value moved, clone price hasn't" | `server/services/news-lag-trader.js:113` `newsOpportunities` (extend; it already imports `assetUniverse`); counterparty-pricing.js:950 `valuationMap` (read only; this unit gives it its first app caller, as the comment at :940 asks); routes/trades.js:626 `/news-edge` (response shape grows); `test/radar-gap.test.js` (new) | **RED:** a fixture where news drops a starter to Out raises the handcuff's real value while the clone price stays still, so the handcuff ranks first with gap > 0; a manager with no clone fit returns `gap:null` with a reason, never 0; the gap equals value − price exactly, from the two producers (contract test: no local re-pricing) | CLONE-01-b |
| RADAR-01-b | Layer 3 forward grading | A daily job scans all leagues, writes each flag to rec_ledger (GR-01, #174) as a graded recommendation, and grades it at +1/+2/+5 weeks: did the gap close our way? | `server/jobs/` (new radar-scan job); rec-ledger helper from #174 (`server/services/rec-ledger.js`); client TradeLab.tsx:181 (news-edge panel shows the gap) | **PRE radar test** (design doc): flagged mispricings resolve our way more often than chance, forward-graded. Metric: share of flags where the gap closes toward real value by +2 weeks, with a league-clustered 90% CI vs 50%, and the MDE stated at the prereg's expected n. Forward-only, so no historical backfill counts. **RED:** the job writes one rec_ledger row per flag; the grader closes the row at +2w | RADAR-01-a; #174 merged |

Notes:
- **Canonical producer:** news-lag-trader.js for opportunities. The gap itself is a derived read of two producers and is computed nowhere else.
- **Consumers:** `GET /:leagueId/news-edge` (routes/trades.js:626) → TradeLab.tsx:181; rec_ledger grader.
- **Data:** live; clone fits (075); rec_ledger (071 in #174).
- **Migration:** none if #174 lands. If #174 does not land, stop; do not add a second ledger.
- **Settings:** -a is risk normal, critical:false (the served number stays default-off until the radar test). -b is risk low, critical:false; it becomes critical when it is switched ON.
- **Size:** about half a day each (guess).
- **Parallel:** it touches routes/trades.js. That conflicts with #170/#174/#190 until they merge, and with CHESS-01 (:816), so don't run it alongside CHESS-01.

---

## CHESS-01: title-odds chess (sequence search against clones)

| ID | plan item | goal | files | acceptance | deps |
|---|---|---|---|---|---|
| CHESS-01-a | Layer 4; TM-05 / GT-01 / CE-07 | Extend `findTradeSequences` (today 2-step greedy) into a budgeted Monte Carlo tree search over (trade → claim → flip) up to 3 steps. The score at each leaf is `actionImpact` (CE-09-a), and paired SE decides ties. A step is expanded only if the counterparty clone's P(accept) (CLONE-01-b `acceptanceBand` centre) passes a threshold. Clone replies: counter or reject from acceptanceBand; free-agent claims by rivals from the population waiver model | trade-engine.js:2288 `findTradeSequences` (extend in place), :1765 `findTrades` (read only); routes/trades.js:816 `/find/sequences`; client TradeLab.tsx:611 (RoadmapTree is a later UI unit); `test/chess-sequences.test.js` (new) | **RED:** a 3-step fixture league where the path's title odds rise at every step and each counterparty's clone sees a gain beats the best single trade by more than 2 paired SE (TM-05 fixture); the search is deterministic under one seed; the budget cap is respected (node count asserted) | CE-09-a, CLONE-01-b, BLEND-02-a merged (trade-engine.js) |
| CHESS-01-b | Chess kill-or-confirm | Offline replay harness for the chess test on Sleeper 2021-24, as-of only: rebuild each league-week from sh_team_weeks, run search vs single best-value trade, and score both by title odds gained, simulated on the same seeds | `scripts/rnd/chess-replay.mjs` (new), `docs/evidence/<date>/chess-01-preregistration.md` (new); no served code | **PRE:** paths beat single best-value trades on title odds gained, with a league-clustered 90% CI clear of 0. The sample is a stratified draw of league-weeks with the count fixed in the prereg. Sleeper stays aggregate-only. If it fails, CHESS-01-a stays default-off | CHESS-01-a; Sleeper id mapping (see CLONE-01) |

Notes:
- **Canonical producer:** trade-engine.js `findTradeSequences`. The title-odds score stays in season-sim.js.
- **Consumers:** `GET /:leagueId/find/sequences` (routes/trades.js:816) → TradeLab.tsx:611.
- **Data:** live; for -b, sh_team_weeks 385,022 rows and sh_team_seasons 27,586 rows (C10).
- **Migration:** none.
- **Settings:** -a is risk normal, **critical:true** (served trade and title numbers). -b is risk low, critical:false (a study).
- **Size:** -a about 1 day (guess). -b is more than 1 day because of the Sleeper projection mapping (**guess**); split it again into -b1 (mapping + harness) and -b2 (run + grade) if the mapping is not ready.
- **Parallel:** it touches trade-engine.js and routes/trades.js, so it runs last.

---

## Launch order for 3 loops

The rule: one editor per file at a time. Wait for the named open PRs before starting.

| Loop | Sequence | Why this order |
|---|---|---|
| **Loop 1: sim lane** (season-sim.js, contingency.js) | CE-03 → CE-09-a → CE-09-b → CHESS-01-a → CHESS-01-b | CE-03 and CE-09-a share season-sim.js, so they run back to back. CE-03 waits for #202 and #204. CHESS-01-a needs CE-09-a, CLONE-01-b and BLEND-02-a, and by this slot all three are done |
| **Loop 2: projection lane** (gamescript.js, weekly-blend.js, trade-engine.js :380-495) | CE-01 (start now) → BLEND-02-a → BLEND-02-b | CE-01 is disjoint and has no deps, so it fills the time while #166 → #164 merge. BLEND-02 then owns trade-engine.js's assetUniverse region. Hold RL-7-1 until BLEND-02-b lands |
| **Loop 3: manager lane** (counterparty-pricing.js, trade-acceptance.js, news-lag-trader.js) | CLONE-01-a → CLONE-01-b → RADAR-01-a → RADAR-01-b | CLONE-01-a waits for #203. CLONE-01-b's migration 075 comes after CE-09-b's 074; if 075 is ready first, swap the numbers when the PR is written. RADAR-01-b waits for #174 |

Cross-loop conflicts to watch:
- trade-engine.js: BLEND-02 (loop 2) edits :380-495, and CHESS-01-a (loop 1) edits :2288. They are sequenced because CHESS-01-a starts only after BLEND-02-a has merged.
- routes/trades.js: RADAR-01-a (:626) and CHESS-01-a (:816). Don't run them at the same time.
- Migrations: 074 (CE-09-b) and 075 (CLONE-01-b). Re-check the highest number on main at PR time.

---

## Commands (every number above)

- C1 `git fetch origin; git log -1 --format='%h %cd %s' origin/main` → `19a4eea1`, 2026-09-23 14:21 -0400.
- C2 `git show origin/main:<file> | wc -l` → season-sim 574, contingency 1156, counterparty-pricing 1331, trade-engine 3270, projections 1076, title-odds-trades 178, correlation 243, news-lag-trader 248.
- C3 `sqlite3 -readonly ~/gridiron-local/data.sqlite` with the query: TRADE_ACCEPT/DECLINE rows joined to a TRADE_PROPOSAL (same league, `tx_id=related_tx_id`, items non-empty), `decider team_id != proposer`, DISTINCT (type, league, key, decider). Result: ACCEPT 7 (4 deciders, 2 leagues, 3 by Nick), DECLINE 30 (11 deciders, 3 leagues, 14 by Nick). Nick = `leagues.my_team_id`.
- C4 `SELECT type,status,count(*) FROM league_transactions_raw WHERE type LIKE 'TRADE%' GROUP BY 1,2` → ACCEPT 17 blank / 1 CANCELED / 9 EXECUTED / 2 PENDING; DECLINE 58; PROPOSAL 93 CANCELED / 75 PENDING; UPHOLD 11; VETO 7. All 2026, in 5 leagues.
- C5 C3's set split at `proposed_at >= '2026-09-03'`: ACCEPT 5/2, DECLINE 19/11 → 24 after, 13 before.
- C6 `SELECT format_key,count(*),min(fetched_at),max(fetched_at) FROM dynasty_values GROUP BY 1` → 213 + 212 rows, 2026-09-03 → 2026-09-19 (latest-only, no history).
- C7 `sqlite3 -readonly data/derived/sleeper_history.sqlite "SELECT type,status,count(*) FROM sh_transactions GROUP BY 1,2"` → trade complete 7,952 / failed 3; free_agent 352,916; waiver complete 198,324 / failed 156,211; commissioner 3,303.
- C8 same DB, joined to sh_leagues by season → leagues 469/483/489/490/470 for 2021-2025.
- C9 `SELECT count(*),avg(c),max(c) FROM (SELECT count(*) c FROM sh_transactions t, json_each(t.roster_ids_json) r WHERE t.type='waiver' AND t.status='complete' GROUP BY t.league_id, r.value)` → 21,484 / 9.2 / 74.
- C10 `SELECT count(*) FROM sh_team_weeks` → 385,022 (it has players_json); sh_team_seasons → 27,586.
- C11 `SELECT season,count(*),sum(team_score IS NOT NULL) FROM game_lines GROUP BY 1` → 2022 568, 2023 570, 2024 570, 2025 570 (all scored, source nflverse); 2026 544 rows, 64 scored; the by-week query shows week 1 nflverse and weeks 2-18 espn.
- C12 `SELECT season,count(*) FROM nfl_injuries GROUP BY 1` → 5,348 / 5,449 / 5,451 / 5,952 / 5,783 / 455 (2021-2026).
- C13 `SELECT season,count(*) FROM player_week_usage GROUP BY 1` → 7,659 / 7,945 / 8,436 / 8,675 / 8,857 / 1,052.
- C14 `ls ~/gridiron-local/rnd/loop/data/espn_proj_hist/` → leaguedefaults3 files for 2021, 2022, 2023, 2024 and 2026 (plus K/DST for 2021-24); no 2025. The path is `DEFAULT_ARCHIVE` in #164's `weekly-construction-walk-forward.mjs`.
- C15 `git show origin/main:docs/tdd/2026-09-23-trade-impact-paired-seeds.tdd.md | sed -n 140,160p` → median published paired SE 1.03pp at 800 runs, fixed seed sd 0.81pp, n=23. Also 1.03·sqrt(800/10000) = 0.29 (arithmetic).
- C16 `git grep -n "export const SENSE_CHECK_SIM_RUNS" origin/main` → trade-verify.js:135 = 1200.
- C17 `for n in <open PRs>; gh pr view $n --json files` filtered to engine paths → as listed in fact 6; `gh pr view 164/203 --json body,files`.
- C18 `SELECT type,status,count(*),count(DISTINCT league_id||'-'||team_id) FROM league_transactions_raw WHERE type NOT LIKE 'TRADE%' GROUP BY 1,2` → WAIVER EXECUTED 55 (21), FREEAGENT EXECUTED 89 (25).
- C18b `SELECT count(*) FROM nfl_availability_rates` → 139.
