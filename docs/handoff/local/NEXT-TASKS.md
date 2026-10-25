# NEXT TASKS: what runs now, what runs when that ends, and what runs after that (league 4)
Nick 9/24 ~12:40 AM: "organize the plan of your next tasks: what you do when the current ones end, then when the new ones end". Each wave starts automatically as the previous wave's slots free up (lane-keeper, WORKFLOW KEEPER, REVIEW-ON-FINISH sweep). Every finished PR is reviewed within about 20 min of its last commit, and its fixes are queued as a FIXPR unit.

## WAVE A: running now (12:40 AM to about 2 AM)
- Build workflows (Mac): COUNTERPART-02, EVAL-E4, COACH-MSG. Done: COACH-TOOLS #298 (12/12 grounded). Blocked: FEAS-140 #300 (wiring -> FEAS-140-WIRE).
- Cloud (main account, up to 8): COACH-ROLEPLAY, COACH-BRIEF, PRODUCER-FAST, PEOPLE-BOARD, NEGOTIATE-UI, HIS-SCREEN, PRICE-BAND-01, M7-TIMING, BANDIT-01.
- Merge train: #242 lock-race fix -> #278 (batch 1) green -> merge.
- Rebaser: FIX-02/05/06/07/08 onto FIX-03 (#272).
- Local (2): WR-FREEZE (the War Room page freezes the server), SCALE-140 (sim 73 vs ESPN 140).
- R&D: paused while the Mac load is over 14.

## WAVE B: as Wave A slots free up (about 1:30 to 3:30 AM)
1. Cloud: FIXPR units in priority order (69 PRs swept; 31 cloud, 38 local): #242, #268 (security), #254 (one counterpart, no chat lift), #260 (one reader + nick overrides survive a rebuild), #276, #272, #287, #274, #275, #279, #282, #266, #265, #233... then COACH-LINK, FEAS-140-WIRE.
2. Build workflows: WR-L4, COACH-NAV, COACH-NEGOTIATE (+ whatever the keeper adds from BUILD-PLAN).
3. Merge train batch 2: 246 237 227 233 231 230 234 + 228 229 247 + the green FIX PRs, in audit order.
4. Local: PULSE-01, CRED-01, ACTIVITY-01, STEP-LOG, CATCHUP-LIVE, local FIXPR units (they need the DB/chat), then L4-PLAN and FIX-11 once #233/#231/#230 merge.

## WAVE C: morning (about 3:30 to 6 AM)
1. After batch 2: auto-intake fast-forwards the local app; L4-PLAN writes the real league-4 plan; FIX-11 runs the integration smoke.
2. 5:37 AM: MORNING DELIVERABLE (the coordinator itself): War Room click-through on league 4 + screenshots + MORNING-BRIEF.md sent to Nick.
3. Batch 3 merges: FIX-03..10 + COACH-TOOLS + the Wave B builds that the sweep passed.
4. R&D resumes when the load is under 14: round 31 (mood, influence, anchor), round 32 (face, street, replay).

## WAVE D: Thursday 9/24 (people brain, Phase 2)
One reader + one counterpart merged. COUNTERPART-02 in the planner. CRED-01 nightly. PULSE-01 live replans. PEOPLE-BOARD + HIS-SCREEN + NEGOTIATE-UI on the War Room. COACH-ROLEPLAY + COACH-NEGOTIATE on Coach. The PRICE-BAND-01 calibrated band. M7 timing.

## WAVE E: Friday-Saturday 9/25-26 (always-on)
PRODUCER-FAST (under 60 s) -> replan on every refresh and event; PUSH-01 alerts; STEP-LOG live grading; EA-06/07 monitors + one world; CATCHUP-LIVE; COACH-BRIEF daily.

## WAVE F: Sunday-Monday 9/27-28 (report card)
E1-E7 + the M1-M10 module stats on the "Is the brain working?" card; BANDIT live once offers log; counterfactual replay; final sweep; handoff doc; stop Mon 9/28 9 PM ET.

## Standing loops (all waves)
REVIEW-ON-FINISH sweep (:07/:27/:47) · WORKFLOW KEEPER (every 10 min) · lane-keeper (5 min) · auto-intake (10 min) · HOURLY handoff push (:17) · Monitor on EVENTS.log · rulings in SWEEP-RULINGS.md · migrations in MIGRATIONS.md · the Mac load cap (builds under 18, R&D under 14, 1 producer at a time).
