# GATE AUDIT: which promotion gates cannot pass before the 12/2 deadline, and a weekly graded gate for each

Written 2026-09-25 against `origin/main` at `decf7ebf`, the merge of #398 integration-7. That merge put #378 REACH-01, #379 TRADE-MEMORY, #381 GETS-FLOOR, #382 CAP-1C and #383 NO-TRADE-SHRINK on main. Docs only: nothing here changes code, a flag, or a served number. Each proposal below is a pre-registration draft. A unit adopts it in its own PR, and the registration counts from the date of that PR. Old bars are kept next to the new ones, never deleted (ONE-PLAN night 2, the E1-BAR rule).

League-mates appear only as roster ids.

## 1. The calendar every gate has to fit

| date (ET) | what happens |
|---|---|
| Tue 9/29 | first Tuesday grade: NFL week 3 is final |
| Tue 10/6, 10/13, 10/20, 10/27 | grades for weeks 4 to 7 |
| Sat 10/31 | feature freeze (ONE-PLAN night 14): after this only fixes and grading |
| Tue 11/3, 11/10, 11/17, 11/24 | grades for weeks 8 to 11 |
| Mon 11/30 ~17:00 UTC | last real send (24 h review plus ESPN processing) |
| Wed 12/2 17:00 UTC | trade deadline |

So a gate has **5 Tuesday grades before the freeze** and **9 before the last send**. A "2 consecutive passes" rule can promote a unit on 10/6 at the earliest and 11/24 at the latest.

The data we already hold for 2026, as stated in Nick's queue message and not re-measured in this PR: 5 leagues, 46 team-seasons, 1,666 moves, 286 trades. Two numbers were measured elsewhere and are cited: **37 decided offers** across 3 ESPN leagues, 21 of them in league 4 (E1-DATA, `server/services/eval/decided-offers.js` header, and PR #319); about **20 decided offers a week** league-wide (PR #263 body). Nick has sent **0 app offers** (`trade_outcomes.sent_at` is written 0 times out of 94 rows, ONE-PLAN 4b row 14).

## 2. Rules shared by every weekly gate below

1. **When.** The Tuesday grade runs on the NFL week that just finished. The graders already run on every refresh tick (`scripts/eval/run-graders.mjs`), so each weekly gate is a new row in `brain_report`, not a new job. That follows the ONE-PLAN section 7 ruling "TUESDAY-GRADE as a new grader job: KILL".
2. **As-of inputs only.** A prediction counts only if it was stored, or can be replayed, from inputs dated before the event it predicts. `e1-league.js` `scoreAsOf` is the pattern to copy.
3. **A named baseline.** Every gate compares against the thing the unit would replace: the activity-only rate, the trailing rate, raw FantasyCalc, doing nothing, or ESPN's projection.
4. **The bar.** A 90% bootstrap CI clustered by league-week, with a lower bound above 0 on the cumulative sample, on **2 consecutive Tuesdays**. When a CI's upper bound falls below 0, the unit is demoted on the spot (one failing Tuesday is enough). The looks are fixed in advance: Tuesdays only, at most 9. The two-in-a-row rule is what pays for the repeated looks. A row that sits at `not_enough_data` on 11/24 stays off.
5. **The anytime-valid rows keep their power to fail a unit.** E1's confidence sequence (`e1.js`) still demotes on its own terms. A weekly gate can **promote** a unit; it cannot overrule a failing row.
6. **Nick's hard rules stay outside every model.** They are: never give 160/80; 277 only for a consistent Blue chip; final gets 83+; no buy-backs; overpay 0 except +12% on depth-only 2-for-1s; a served move must beat doing nothing on the confirm dice. No gate here touches them, and none can turn one off.
7. **Promotion means the provenance label changes.** GUESS becomes BLEND, or BLEND becomes PROVEN (ONE-PLAN section 1). A unit that is still unproven may reorder a deck, but it may not move `title_delta`, `title_now` or the value class of `p_yes`.

## 3. Gates that cannot realistically pass before 12/2

Rows are ordered by how much served behaviour each one holds back.

### 3.1 E1 accept calibration: blocks CLONE v2 #288, PYES-ONE flag-on #384, PYES-BASELINE #319, TELLS card #268, the `rank_basis: p_guess` label, and ONE-PLAN night 13

- **Gate today.** `e1.js`: a 95% anytime-valid confidence sequence on the per-offer log-loss gain over activity-only must sit wholly above 0, plus a pooled slope of 0.8 to 1.2 (se <= 0.25). Probabilities are clipped to [0.02, 0.98], so each offer's gain lies in ±ln(49) ≈ ±3.9. `minOffersToDecide()` sizes the sample for the most one-sided evidence possible.
- **Why it cannot pass.** The CS is sized for that ±3.9 range, but the gains being measured are on the order of 0.01 to 0.05. #288's arm 2 is −0.0150 [−0.0488, +0.0151] at n = 37, and #268 is +0.0011 with a CS of [−1.08, +1.08]. The brain report printed "needs 171,590 more offers" at n = 37 (ONE-PLAN L7). At about 20 decided offers a week, we reach roughly 37 + 9 × 20 ≈ 220 by 11/24. Night 13's "~50 settled offers" arrives in count by early October, but the CS will not decide at 50.
- **Weekly gate proposed: E1-weekly.**
  - Evidence: every decided offer in all 5 leagues. That means every manager's offers, not only Nick's, taken from `decidedOffers()`, with the one producer unchanged.
  - Scoring: each offer is scored as of its proposal time by `scoreAsOf`. This is the forward-only split by construction, which answers #319's split question (LOWO no longer counts).
  - Metric: the mean per-offer log-loss gain of the challenger over activity-only, cumulative from week 4, with a 90% CI clustered by responder.
  - Pass: the lower bound is above 0 **and** the mean is at least `MIN_GAIN` (0.01) on 2 consecutive Tuesdays. The pooled slope is reported next to it, and a slope CI wholly outside 0.8 to 1.2 blocks the pass.
  - Arms graded side by side on the same offers: the activity baseline (#319/#384), clone v2 (#288), the receptiveness activity term (`GRIDIRON_RECEPTIVENESS_ACTIVITY`, which missed its 2024 bar at AUC 0.644 against 0.645), and TELLS prior_trades (#268).
  - If nothing passes, the baseline stays served, which is also today's safe default.
  - Power (a guess): at n ≈ 150 to 220 with a per-offer SD of about 0.3, the CI half-width is about 0.035 to 0.04. Only a gain of about 0.04 or more is likely to pass. The PR that adopts this has to state that honestly.

### 3.2 E2 price accuracy: blocks promotion of `counterparty-pricing.js` from GUESS (13 factors `fitted: false`) and L5b "his price"

- **Gate today.** `e2.js`: only the app's own offers that were **sent** and carry a `price_band` are graded, because another manager's offer has no predicted "yes" point.
- **Why it cannot pass.** It has 0 sent offers today, and it needs dozens priced exactly at the yes point. Nick is not going to send dozens of offers before 11/30.
- **Weekly gate proposed: E2-league (price from real trades).**
  - Evidence: every decided offer and every executed trade in the 5 leagues. That is the 286 trades plus the declines already in `decidedOffers()`.
  - Model: for each offer, "his screen" is computed as of the proposal, both ways: (a) raw FantasyCalc value given versus received; (b) FantasyCalc × the `playerValuation` multiplier (`league-adapter.mjs:334-338`).
  - Metric: the log-loss gain of accept ~ (b) over accept ~ (a), fit on offers before week w and graded on week w, cumulative. A 90% CI clustered by responder, with a lower bound above 0 on 2 consecutive Tuesdays.
  - Pass: the multiplier loses its GUESS label and becomes BLEND. Fail: `playerValuation` is capped toward 1, the same way `outscoring_usage` was capped (ONE-PLAN section 7).
  - What this does NOT test: the "at the yes point" calibration that E2 was built for. That part stays `not_enough_data` and is not a gate this season.

### 3.3 E3-live title-odds calibration: blocks LIVING-01b #261's old gate, ACTIVITY-01 #334 in the sim, and `title_now` as PROVEN

- **Gate today.** `e3.js`: `MIN_TEAM_SEASONS` 40 of **finished** team-seasons, read from the `title_odds_snapshots` view (migration 083). That view only admits a season once every team has a `final_rank` and a playoff week has been scored.
- **Why it cannot pass.** It is structurally 0 before 12/2. No 2026 season finishes before the NFL playoffs, and the view needs served snapshots, which past seasons do not have. Even after the season, 46 team-seasons is one draw per league for "who won the title".
- **Weekly gate: already drafted in the LIVING-01b thread** (coordinator comment on #261, 9/25). That draft has two parts: activity intensity against each team's trailing rate, and the sim with league-mates against a static sim on next-week lineup-points error, with 2 consecutive passes. This audit does not duplicate it. It only adds a third row that the title number itself needs:
- **E3-weekly (matchup calibration of the served sim).**
  - Before each week's first kickoff, snapshot the sim's head-to-head win probability for every matchup in the 5 leagues. That is about 23 matchups a week, so about 115 by the freeze and about 207 by 11/24. `served_numbers` with `trigger = 'weekly'` is already the store.
  - Metric: Brier score against two baselines, ESPN's projected-points favourite and a standings-only baseline, with a 90% CI clustered by league-week, plus the reliability slope.
  - Pass (2 consecutive): `title_now` moves from GUESS to BLEND. This does **not** make the title number PROVEN. Title calibration stays an end-of-season question, and the historical E3 row (906 league-seasons) stays its structural evidence.

### 3.4 E4-live planner vs baselines: blocks the shrinkage promotion in NO-TRADE-SHRINK #383 and REACH/SEARCH-WIDE ranking claims

- **Gate today.** `e4-planner.js` `live()` needs `LIVE_MIN_WEEKS` 4 rows in `planner_move_outcomes`, and that table is not built: #395 SOURCE-TABLES is off. The metric is realized **title** gain, planner minus the best baseline, with the lower bound of a league-clustered 95% CI above 0.
- **Why it cannot pass.** It covers one league (league 4, Nick's team only), so there is 1 row a week and at most about 7 by 11/24 even if #395 lands on night 7. Title gains per move are 0.0006 to 0.0018 (ONE-PLAN section 4), against SEs of about 0.015. A CI over 7 clusters cannot exclude 0.
- **Weekly gate proposed: E4-points.**
  - Rows: one per week for **Nick's team in each of the 5 leagues** (the producer already takes `GRIDIRON_WARROOM_LEAGUES`). That is 5 rows a week, so 25 by the freeze and 45 by 11/24.
  - Arms: the planner's served move (or its no-trade row), the finder's best, do nothing, and greedy.
  - Each arm is scored on **realized starting-lineup points over the next 2 weeks**, using the players' real points and the same lineup rule for every arm. That scoring is weekly observable, whereas the title result is not.
  - Pass: planner minus the best baseline, 90% CI clustered by league-week, lower bound above 0 on 2 consecutive Tuesdays. The shrinkage in #383 is promoted only on a pass.
  - The title-gain E4-live row stays as the season-end check.

### 3.5 E5 step value, live: no served unit waits on it today, but the ONE-PLAN week-16 "E5 table complete" line does

- **Gate today.** `e5.js` `MIN_N` 15 executed campaign steps that have a realized title gain.
- **Why it cannot pass.** `campaign_steps` has 0 rows, and Nick has made 5 trades all season (ONE-PLAN 4c). Fifteen executed steps before 12/2 is not realistic.
- **Weekly gate proposed: E5-league (trade valuation on every executed trade).**
  - Evidence: each executed 2026 trade in the 5 leagues, about 286 minus vetoes.
  - Model: price both sides as of the accept time with the served sim on paired seeds, as a predicted rest-of-season starting-lineup points change for each roster.
  - Outcome: the realized lineup-points change over the weeks since, pro-rated per week.
  - Metric: the realized-minus-predicted mean with a 90% CI clustered by trade containing 0, and a realized-on-predicted slope with a CI touching 1. Graded cumulatively each Tuesday.
  - This tests the one piece every step's "+X if he says yes" depends on, using trades we did not have to send.

### 3.6 E6 follow vs ignore: gates SELF-01b #284

- **Gate today.** `e6.js`: at least 20 near-tie decisions per arm across at least 8 distinct weeks. `follow_ledger` is empty.
- **Why it cannot pass.** It needs 40 near-tie decisions by Nick himself. No data we hold substitutes for Nick's own choices.
- **Proposal: no weekly gate. Park E6 and #284 as report-only through 12/2.** #284's own overpay flag also needs at least 8 comparable trades, and Nick has 5. Stating that plainly is better than inventing a proxy.

### 3.7 Units whose gates count Nick's own sent offers

| unit | gate today | why it cannot pass | proposal |
|---|---|---|---|
| REP-01 #264 (offer fatigue / reputation) | about 40 settled **app** offers, accept rate against prior lopsidedness | 0 sent | **REP-league weekly**: the same regression on every decided offer in the 5 leagues (proposer's prior lopsidedness from their own earlier 2026 offers), 90% CI clustered by proposer, 2 consecutive Tuesdays. Then it applies as a capped factor to Nick's offers |
| M5 pitch bandit #263 | at least 20 settled offers per arm (ONE-PLAN section 7, a guess) | 0 sent; ESPN offers carry no pitch text, so league data cannot stand in | **Park past 12/2.** NEGOTIATOR-DEFAULTS #386 stays on its external-evidence labels (ONE-PLAN spot-check row 18) |
| NEGOTIATOR-DEFAULTS #386 acceptance effect | "0 graded offers, so no lever is shown to raise acceptance" | same | no promotion gate needed: it moves no number. Its lever tags accrue into E1-weekly as an arm once Nick sends |
| JEV-01b #289 blend | forward 2026 holdout log loss, blend minus incumbent; needs #248 answers | no Jev answers yet, and chat exists for league 4 only (10 teams) | **JEV-weekly on activity, not acceptance**: does a chat signal predict "roster makes a move in the next 7 days" better than the trailing move rate (from the 1,666 moves)? That is 10 team-weeks a week, so about 50 by the freeze. Thin: likely `not_enough_data` by 11/24, so it stays shadow unless the effect is large |
| C8 reasoning claims (`reasoning/grade.js`) | Wilson 95% interval above one half at `MIN_N` 20 settled claims; runs under preview only | n = 0; it needs claim volume of about 3 or more a week from league 4's panels | **Keep the bar, widen the evidence**: settle claims made about all 5 leagues' rosters, not league 4 only. The bar may then be reachable in November. It moves no number, so this is low priority |

### 3.8 E3-ESPN (Nick's ESPN history, week-7 replay)

- **Gate today.** `e3-espn.js` `MIN_LEAGUE_SEASONS` 30, with seasons up to 2024.
- **Can it pass?** Only if league history exists. The LIVING-01b thread is checking whether ESPN history (past transactions and final standings) is available for the 5 leagues. With 5 leagues, 30 league-seasons needs 6 or more past seasons each. That is not something a weekly gate can supply.
- **Proposal.** Keep it as a one-time sanity row, not a promotion gate. If the history ingest lands, run it once and record the result.

### 3.9 Flags on main whose gate names no test ("default off until measured on 2026")

These are the quiet ones. Each flag's reason for being off is a sentence, not a number, so nothing can ever mark it passed. Each one below gets a row in one of the weekly gates above, so its "measured" has a date and a bar. Flag defaults and file:line were read from `origin/main`.

| flag (read at) | stated reason it is off | weekly gate it joins |
|---|---|---|
| `GRIDIRON_RL17_3_ENABLED` (`season-sim.js:364`) | "default off until measured on 2026 leagues" | E3-weekly: an arm with the flag on vs off on the same matchups; pass = Brier gain CI > 0, 2 consecutive |
| `GRIDIRON_ONE_WORLD` (`one-world.js:41-45`) | "default off until measured on the local leagues" | E3-weekly arm (same draws behind odds and cards, so the same matchup Brier applies) |
| `GRIDIRON_SIM_KDST` (`season-sim.js:504`), `GRIDIRON_SIM_ASOF_PROJ` (`:427-431`) | "default off until confirmed on 2026 weeks" | E3-weekly arms, plus next-week team-points MAE on/off (46 team-weeks a week) |
| `GRIDIRON_COUNTERPART` (`people/counterpart.js:75-77`; `P_ACCEPT_CHAT_WEIGHT = 0` at :66) | "no chat feature in P(accept) until E1 grades one positive" | E1-weekly arm (league 4 only, where the chat is) |
| `GRIDIRON_HIS_SCREEN` (`campaign/his-screen.js:49`) | "no graded check (E1/E2) has confirmed that view predicts his answer yet" | E2-league: the his-screen fair % as a predictor of accept vs decline |
| `counterparty-pricing.js` VALUATION_SOURCES (8 hand-set factors, `:93-128`) | "cannot be fitted until enough proposals have been decided" | E2-league (3.2) |
| `GRIDIRON_TRADE_MEMORY_FLOOR` (#379, on main via #398, shadow) | no promotion bar stated | E2-league arm: does "his floor is what he paid" predict accept vs decline better than the multiplier alone? |
| `GRIDIRON_PARTNER_KERNEL` (`people/partner-kernel.js:49-54`) | "fitted on Sleeper; on ESPN it is a descriptive forward check only" | **Partner-weekly**: does the kernel's partner order predict which pairs of rosters trade in the next 2 weeks (the 286 trades) better than activity alone? AUC gain, 90% CI clustered by league-week, 2 consecutive |
| `GRIDIRON_WEAKNESS` (`people/weakness.js:138-140`) | "seller ranking … is not validated on ESPN leagues" | Partner-weekly, second arm: does the seller rank predict who sells a starter in the next 2 weeks (from the 1,666 moves)? |
| `GRIDIRON_PRICE_BAND_V2` (`price-band.js:67`) | "graded on executed Sleeper trades only" | 2026 transfer coverage (section 5 row): reported, not promoted |
| `GRIDIRON_ESPN_ZERO_INACTIVE` (`espn-zero-inactive.js:53`) | already has a real bar: at least 80% of Q/none inactives flip by T-30 with 0 wrong flips on Nick's starters, over a W4-W5 Sunday test | none needed: it is weekly by nature and fits (section 4) |

Flags that are **not** model promotions (speed switches, UI surfaces, paid opt-ins, kill switches) need no weekly gate: `PRODUCER_FAST`, `FAST_RESCORE`, `TWO_FOR_ONE`, `FLIP_LEGS`, `NUMBER_HEALTH`, `BRAIN_REPORT`, `BLEND_WEEK`, `COACH_*`, `NEGOTIATE_UI`, `WARROOM_PEOPLE_ENABLED`, `HUB_PEOPLE`, `NICK_VOICE`, `REASONING_ENABLED` (C8), `POINTS_FEASIBILITY`, `TITLE_MUTUAL_ENABLED`, `OFFER_LOOP`. Each one needs a single local confirmation run, or Nick's go. `WAIT_OR_ACT` is already killed (r24).

Two wiring mismatches turned up. Neither is changed here:
- `GRIDIRON_TELLS_ENABLED` (`tells/refit.js:35`) and `GRIDIRON_ESPN_ZERO_INACTIVE` (`espn-zero-inactive.js:53`) read only their own flag.
- `preview-mode.js` and the TELLS-01a pre-registration say preview mode turns them on. It does not.

## 4. Gates that can pass before 12/2 without a new bar

These need a run, not more data. A cloud thread cannot measure them (no live DB), so each belongs under "Needs local measurement" in its own PR.

| unit | bar | what is missing |
|---|---|---|
| E7 luck vs decision (`e7.js`) | 4 finished weeks of `weekly_autopsy`, luck CI containing 0 | #395 merged and running; weeks 3 to 6 are final by 10/13 |
| SOURCE-TABLES #395 | live: 10 rows per finished week, capture under 2 min | one live run after merge |
| ACTIVITY-01 #334 / `ACTIVITY_MIN_WEEKS` 5 | 5 weeks of pickups | weeks 1 to 5 are final by 10/6; the ESPN transfer is graded in the LIVING-01b thread's weekly gate |
| RB-TITLE #385 | SE ratio <= 0.5 (levels) / <= 0.45 (paired), bias z < 3 | a league-4 shadow run (synthetic already met: 0.416 to 0.488 / 0.28 to 0.318) |
| O1-RADAR #377 | 4 cells met historically; train/serve P(out) 0.506 vs 0.496 | the P(out) fix, then RADAR-GRADE at +2 weeks (already weekly) |
| O1C-WIRE PRE (ONE-PLAN night 11) | beats ESPN on the same player-weeks | as-of poller rows from night 1; weekly by nature |
| LOVE-RULE #393 | league reproduction; hit rate from the luck-free r52 re-run | one local run plus one historical re-run |
| REACH-01 #378 (on main, `GRIDIRON_REACH` off), CAP-1C #382 (on main), DRAFT-ID-MAP #391, LADDER-01 #394, HIS-SIDE-WIRE #388, RISK-RULE #389, BITEMPORAL #399, GAME-SHOCKS #400 | fixture bars met; each needs one league-4 run (or a local `player_week_usage` run for #400) | local measurement |
| PLAYER-SCORE #375 (merged) | no bar; provisional 50/50 weights, served as a BLEND label | none; it is a label, not a promotion |

The hard rules that #398 put on main (GETS-FLOOR, the no-buy-back part of TRADE-MEMORY, the no-trade gate) are filters that are on by default, not models. They need no promotion gate, and this audit proposes none.

## 5. Gates that already missed, which a weekly gate should not rescue

A weekly gate is for a bar that cannot be *measured* in time, not for one that was measured and missed. These keep their result as it stands:

| unit | missed bar | recommendation |
|---|---|---|
| IS-TITLE #387 | M1 0.733 against <= 0.5; M4 0.861 against <= 0.6 | PARKED per Nick; no re-gate |
| PRICE-BAND-02 #363 | 1-for-1 coverage 73.6% against 80 ± 5 | stays a label. Optional transfer check: coverage on the 2026 executed trades in the 5 leagues, reported, not a promotion |
| PULSE-02 #369 | SHOP 0.603, REFUSAL 0.452, URGENCY unmeasurable, against F1 >= 0.7 | only WANT_PLAYER (0.730) may trigger a replan; the other types need more hand labels, not more weeks |
| LIVING-01b #261 rescore time | 558 ms off / 5,186 ms on against 150 ms | a performance fix, separate from the re-gate |
| integration-7 #398 RULE-FUZZ Safe bar | 142/300 against >= 150, as reported in the #398 body | #398 is merged; commit `0e4f1d11` changed Safe's no-trade gate after that measurement, so the bar needs a re-run, not a new gate |
| AVAIL-HORIZON (`GRIDIRON_AVAIL_HORIZON`, `availability-return.js:18-24, :78-97`) | 10.4% / 0.50% against a pre-registered 12-21% / 0.7-1.6% | served in preview anyway under "COORDINATOR OVERRIDE (INT6)". Flagged here because a missed bar is serving. Nick should decide whether the override stands; this PR changes nothing |
| Receptiveness activity term | 2024 held-out AUC 0.644 against 0.645 | do not re-litigate the historical miss; it is graded forward as an arm of E1-weekly (3.1) |

## 6. Not on main, so not audited here

LIVE-BLEND (branch `claude/cloud-live-blend`) earns its weights from "E1-graded settled offers". That source has the same problem as 3.1. When LIVE-BLEND lands, it should read E1-weekly's per-arm log-loss rows instead of waiting on the anytime-valid E1. That thread owns the decision.

## 7. What adopting this costs

- **One grader file per new row.** Each is a new check id in `eval/index.js` `GRADERS` and in `plans-schema.js` `BRAIN_CHECK_IDS`. No new job, no new producer.
- **Snapshots that do not exist yet.** E3-weekly needs pre-kickoff matchup win probabilities in `served_numbers`, and they need to start by week 4 (Thu 10/1) to reach 5 Tuesdays before the freeze. E4-points needs the producer run for all 5 leagues.
- **Everything else re-reads tables that already exist:** `decidedOffers()`, `league_transactions_raw`, `league_week_scores` and the roster snapshots.
- **Order, by what each unblocks:**
  1. E1-weekly: 5 PR units plus the `COUNTERPART` and receptiveness arms.
  2. E3-weekly: the title number plus 4 sim flags.
  3. E4-points: #383 and the ranking claims.
  4. E2-league: his price, `HIS_SCREEN` and the 8 valuation factors.
  5. Partner-weekly: `PARTNER_KERNEL` and `WEAKNESS`.
  6. E5-league.
  7. REP-league.
  8. JEV-weekly.
- **Timing.** Rows 1 to 3 have to be registered and snapshotting by Tue 10/6 to reach 2 consecutive passes before the 10/31 freeze. Anything registered later can still promote by 11/24, but only as a fix under the freeze rule.
