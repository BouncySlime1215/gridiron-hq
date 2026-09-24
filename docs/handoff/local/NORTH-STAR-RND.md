# NORTH STAR R&D (Nick 9/23 ~9:35 PM: "R&D should just be running off this plan, the new north star: picking areas, defining the stats, and making it better")
R&D no longer takes the top of the generic 188-idea list. Each round picks ONE north-star component, states its stat (the number that says how good that piece is), measures today's value, then tests the 1-3 ideas most likely to move that stat. Winners become build units for that component. The 188-idea list is the idea pool; this file is the order.

| # | Component (north star piece) | The stat that defines "better" | Today's value | Ideas to test (pool ids) |
|---|---|---|---|---|
| C1 | Who says yes (P(accept)) | log loss + calibration slope on who-trades-with-whom (Sleeper 2023-24 held out) now; on logged offers once n>=50 (E1) | E1 on 82 real league offers (L4: 40 offers, 13 yes = 32.5%): served band level OK in L4 but NO ranking skill (AUC 0.56 L4); overconfident elsewhere (says 31%, 18% said yes); clones can't separate L4 managers yet; chat features did not help (+0.068 worse L4, CI spans 0). Stand-in: slopes 0.93/0.90; r22: fatigue INCONCLUSIVE (77 ESPN decisions, control failed), home-team KILLED ; PEOPLE-LAB (verified): 'asks for player X' -> acquires X in 7d at 17x (CI 9.7-25.5, n=53, mostly 1 manager); frustration/shop/untouchable talk = noise | ~~IDEA-010~~ ~~IDEA-087~~, chat-derived labels (manager_chat_profile) as clone features, IDEA-084 activity point process |
| C2 | Clone price (what he'd pay) | on real Sleeper trades: did the trade clear inside the clone's predicted accept band (price accuracy); 2026: accept rate at the predicted "yes" point (E2) | not measured yet (measure first); r22: primetime premium KILLED (they pay LESS) | ~~IDEA-110~~, RL-17-4 lineup conviction, recency after one big game |
| C3 | Flip radar | realized flips per league that leave Nick past 2 SE better off, screen-fair both legs | 0-2 per league (ACQ-FLIP proto) | better clone prices (C2), 2-for-1 legs, need -> position targeting (r19) |
| C4 | "Go get X" planner | best plan expected title-odds gain vs the finder's best single offer, same world | 3.1-4.8 vs -0.1-2.5 pts (5/5 leagues, proto) | IDEA-038 2-for-1 search, waiver claims inside paths, chained steps, IDEA-150 price at his yes point |
| C5 | Title odds (the scoreboard) | E3 calibration on the Sleeper replay (Brier vs standings-only, slope) | pass: slopes 0.97/0.94 | LIVING-01b league-mates act in the sim, IDEA-046 checkout in the sim, IDEA-047 bigger replay harness |
| C6 | Timing | title-odds value of acting now vs waiting / selling after spikes | not measured | IDEA-151 wait-or-act, IDEA-110 sell after primetime, IDEA-146 early checkout warning |
| C7 | Playbook (what to say, counters) | predicted counter vs actual; accept rate by framing | needs logged offers | IDEA-037 pitch bandit, IDEA-135 offers that teach us his price, IDEA-006 decline reasons |
| C8 | Reasoning (REASON-01) | share of reasoning claims that come true ("he'll counter with X", "check first") | needs live weeks | graded once panels ship |

## How a round runs (rnd-loop-v3 with explicit ids)
1. Pick the component with the biggest (gap to target) x (leverage on Nick's title odds) that has testable ideas today (data present).
2. If its stat has no measured value yet, the FIRST tester measures the baseline (that is a result).
3. Test up to 3 ideas for that component; checker re-derives; winners -> build units tagged with the component id.
4. Update the "Today's value" column. Rotate so no component starves.

## Order for the next rounds
- r22: C2 (measure clone price accuracy on Sleeper trades) + IDEA-110 primetime premium.
- r23: C1: IDEA-010 offer fatigue + IDEA-087 home-team bias + chat labels as features.
- r24: C4: IDEA-038 2-for-1 search + IDEA-150 price at his yes point.
- r25: C6: IDEA-151 wait-or-act + IDEA-146 early checkout.
- then back to the weakest stat.

## After r22
r23: C4 planner (IDEA-038 2-for-1 search, IDEA-150 price at his yes point) on league 4. C1 waits for the E1 league-offer study (running) to set the baseline; then chat-profile features as the next C1 test.

## Coordinator verification of every R&D result (Nick 9/23 ~9:50 PM: "this R&D is super important, check it when it comes back")
Before a round's result is recorded, acted on or told to Nick, the coordinator personally: (1) reads the package's pre-registration and confirms its sha256 predates the result; (2) re-runs the headline command (or the checker's) on a fresh DB copy and matches the number; (3) checks as-of timing and that 2025 was not opened; (4) checks the verdict follows the pre-registered rule (no rule bending either way); (5) writes 'verified by coordinator' + any discrepancy into LOOP-LOG before building on it.
