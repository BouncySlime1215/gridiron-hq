# BUDGET PLAN (Nick 2026-09-23 ~1:40 AM ET: working 24/7; plan the 5-hour and the weekly caps; second Max account unlocks today Wed 9/23 3:00 PM ET)
Accounts: A = this desktop account (weekly: Nick says 57% left as of 1:40 AM ET (the meter reads 55% used = 45% left; Nick said 57% left; use the meter); weekly resets Mon 9/28 8:59 PM ET (get_usage)). B = Nick's second Max account, usable from Wed 9/23 3:00 PM ET, via PASTE-TO-RESUME.md in a fresh session.
## 5-hour window rule (checked every other 20-min check with bin/burn.py)
- Projected minutes to 95% > minutes left in the window: full speed (≤5 workflows, ≤6 agents).
- Projection hits 95% with more than 60 min left in the window: THROTTLE-1 (≤3 workflows; no new Fable; R&D paused).
- Projection hits 95% with more than 120 min left: THROTTLE-2 (≤2 workflows; only finishing work; no new launches).
- At 95%: stop all workflows (resume state saved), wait for the reset.
## Weekly rule (account A: 57% left)
- Daily target on A: spend at most ~19% of weekly per day for the next 3 days (57% / 3), keeping ~5% reserve for Nick's own chat.
- If weekly used > day's target: THROTTLE-1 for the rest of the day.
- At 90% weekly on A: stop launching on A, finish in-flight, write PASTE-TO-RESUME.md fresh, and tell Nick "paste it into account B".
## Account B (from 3 PM ET today)
- B takes the heavy build phases (engine, Trade Machine batches); A keeps the coordinator light when both are live, or A pauses and B runs everything if A is near its weekly cap.
- Two accounts never run workflows against the same unit at once: the WORK-QUEUE "owner" column (A or B) is set at launch.

## Two accounts, same plan (Nick 2026-09-23 2:10 AM ET: "the other Max plan will be the same as this")
- Account B has the same limits as A: its own 5-hour windows and its own weekly cap, full (100%) from Wed 9/23 3:00 PM ET.
- Combined weekly capacity this week: A's remaining (meter: 57% used at 2:05 AM ET, so ~43% left) + B's 100% = ~143% of one account.
- Only one account can run this session's workflows. Moving to B needs Nick to paste PASTE-TO-RESUME.md into a session on B, so A must last until Nick is awake to do it.
- Pace on A until the switch: spend ≤ ~30% more of A's weekly (stop at 87%), keeping ~13% for Nick's own chat and the handoff itself. At the current ~30%/5-hour-window burn, that is roughly 1 to 1.5 more full windows, then THROTTLE-2 (finishing work only) until Nick pastes into B.
- After the switch: B runs everything (same caps and rules; 5-hour stop at 95%, weekly stop at 90% then hand back to A after A's weekly reset). Record each account's weekly reset time here once known (Settings > Usage).
- Every other 20-min check reports the weekly pace against this plan and the projected hour A reaches 87%.

## 2:20 AM ET update from SPEND-ESTIMATE.md: sustained pace target ~0.8% weekly per hour (tonight ran ~4.8%/h). THROTTLE-1 now (<=3 workflows). Board keeper stopped; the 20-min status cron updates the board. Critical path ~93% of one account-week fits this week across A+B; the full plan needs 2-3 more weeks.

## 5:50 AM ET: TRUE READING (get_usage; the app's sampled meter had been stale for ~2.7 h)
- Account A: 5-hour 15% (resets 9:59 AM ET); weekly 69% (resets Mon 9/28 8:59 PM ET); Fable weekly 17%.
- Weekly burn since 2:05 AM: 57% -> 69% in ~3.75 h = ~3.2%/h. A's usable remainder to the 87% stop = 18% -> ~5.5 h at this pace (~11:30 AM ET), before account B unlocks at 3 PM.
- Plan: keep 3 build loops + R&D, but lean (no extra auditor agents except for critical/served numbers; R&D explorers stay high effort but one find each). If A reaches 87% before Nick pastes into B, only finishing work runs until the paste.
- Status cron now reads get_usage directly (the meter watcher script keeps logging but is advisory only).
