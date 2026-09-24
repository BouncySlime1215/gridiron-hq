# BROKEN NUMBERS inventory (live; Nick 9/23 ~7:15 PM ET: "keep an inventory for the broken numbers")
In the app: BROKEN-01 (ENGINE-SPECS) builds a "Number health" card in Settings + a red dot when a number breaks; this file is the list until then.
Every number the app shows that is wrong, disagrees with another page, or is built on a known-bad input. One row each. Updated by the coordinator's hourly tick and whenever a unit lands. Status: OPEN / FIX BUILDING (PR) / FIXED (merged + checked live).
Source for rows A-H: ENGINE-ARCHITECTURE.md §10.2 (cites on origin/main 29ac6bcf).

| id | where you see it | what's wrong | cause | fix | status |
|---|---|---|---|---|---|
| A | Title tab vs trade finder | disagree on who helps your title odds (rank correlation 0.796) | sim uses LAST SEASON's projections (season-sim.js:304, :548); finder uses rest-of-season (trade-engine.js:333) | EA-07 one world reads proj.ros (folds RL-17-3) | FIX BUILDING (RL-17-3 cloud); in-app detection #237 |
| B | My team twin vs Title tab vs TradeCard button | three different title odds for the same team | three caches with three keys + a fresh random world per call (routes/model.js:120, title-odds-trades.js:47, season-sim.js:338) | EA-07 one title.odds per snapshot, one world per week | OPEN |
| C | trade card, sim, ceiling lineup, lineup posture | four different weekly ranges for one player-week | four separate samplers (trade-engine.js:447, season-sim.js:363, ceiling-lineup.js:109/:215, lineup-posture.js:153) | EA-07 range.week from the one world | OPEN |
| D | several pages | three different "current week"s | trade-engine.js:180 vs league-week.js:12 vs season-sim.js:190 | nfl.week + league.week fields (EA spine) | OPEN |
| E | trade values, sim | chance-to-play differs by caller; unknown injuries default to 92% | different args + `?? 0.92` at trade-engine.js:387, :3198, season-sim.js:359 | avail.p_play with typed "unknown", no default | OPEN |
| F | finder vs League Hub vs Trade Brain | three different player values, unlabeled | FantasyCalc value, preseason VOR (routes/edge.js:50), clone price | three named fields; pages label which | OPEN |
| G | Start/Sit, lineup, trade card | three different "this week" numbers | current_week_ppg (:507), week_points x full Vegas lift (lineup-brain.js:357-365), adj_ppg 0.25/0.75 (:432) | blend.week = the one number (then META-01 Referee) | OPEN |
| H | Trade Brain under preview | two "checked out" signals at once | activity.manager (#220) beside checkedOutFactor (counterparty-pricing.js:374/:548) | activity.manager replaces it (EA-01 + ratchet) | OPEN |
| I | trade prices | "his need pays N" premium up to 8%; data says <=2.8% | positional_need cap 0.08 unfitted (counterparty-pricing.js:84-86) | RL-19-1 (#224) behind flag, on in preview | FIX BUILDING (#224 CI failing, needs a fix); follow-up: served label still says 0.08 under the flag |
| J | trade finder | hides deals that raise BOTH teams' title odds | points gate drops them (trade-engine.js:1885) | RL-19-3 -> CHESS-01-a | OPEN |
| K | Coach | max 1,500 output tokens on a thinking model: long answers can cut off | same failure as #213 | #223 (8,000) | MERGED 9/23 (#223), in local app a6a77824; live check pending |
| L | page explainer | points at a deleted glossary file | stale reference | #223 | MERGED 9/23 (#223); live check pending |
| M | Trade Brain proposals (league 4) | a failed answer stays cached 6 h after a fix | failed-slate key ignores the model config (trade-proposals.js:69) | FIX-HOLD-01 | OPEN |
| N | waiver card | next waiver run time wrong in 9/9 checked cases (7-8 h late) | guessed "11 AM ET" (waiver-wire.js:415-439) | RL-16-2 (needs real run times) | OPEN |
| O | trade cards (playoff weight) | playoff importance hand-set at 4; measured ~5.2 for contenders | constant at trade-horizon.js:36 | RL-16-1 interim, then CE-09 | OPEN |

| P | News page, injury reads, anything using extracted news | the news extractor has failed every run since 9/22 6:26 PM ET (29 in a row): Claude key rejected (401 invalid x-api-key) | extractor's process has a bad/blanked Anthropic key (found by META-01 review 9/23) | needs Nick: approve Anthropic use for the news extractor + restart with the real key | OPEN (needs Nick) |
| Q | news timing | 1,014 of 1,582 news items have no ingested_at; 412 ingested >3 days after publish; 159 edited after ingest | collector timestamps | EA spine events (as_of + ingested_at); fix collector stamps | OPEN |
| R | War Room feasibility / weekly outlook, title odds, trade values (all sim-based points) | sim weekly lineup points ~45% low: league 4 sim 70-87/team (Nick 72.7) vs ESPN projected 128-155 and actual 128-133 league mean | (1) healthy players get career durability as weekly play chance on the 'pooled' path (median 0.71; contingency.js weeklyAvailability, season-sim.js:359) ~-27%; (2) K and D/ST not scored (season-sim.js:36 SCORED, trade-engine.js:632 lineupSlots) ~-14 pts; (3) last-season projections ~-7% (row A) | points feasibility on ESPN projected 10-slot lineup totals now (evidence/scale-140.md); then fit nfl_availability_role_rates, score K/DST, proj.ros (EA-07) | OPEN (SCALE-140, 9/24) |

## Rules
- A row closes only when the fix is merged AND checked on the live local app (RULES §5).
- New broken numbers found by any unit, review or R&D round get a row here the same day.
- Until EA-07/EA-08 land, the app has no automatic health labels; these rows are the known-bad list.
| R | title odds, trade values, 140 card, every sim number | the sim's weekly points about 45% low (league mean 78 vs actual ~130) and NON-uniform: healthy players docked to their career durability rate (0.56-0.85) | nfl_availability_role_rates empty (the scheduler that runs fit-availability is off locally) + K/D-ST not scored + last-season projections | 9/24 2:25 AM: fit-availability run on the live DB (backup kept): 871 role rows; sim league mean 78.5 -> 97.7 (DB copy, 300 runs). Still open: SIM-KDST (about +14), proj.ros (row A), FEAS-140-ESPN | PARTLY FIXED |
