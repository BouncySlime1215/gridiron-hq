# BUDGET PLAN (Nick 2026-09-23 ~4:40 AM ET: working 24/7; plan the 5-hour and the weekly caps; second Max account unlocks today Wed 9/23 3:00 PM ET)
Accounts: A = this desktop account (weekly: Nick says 57% left as of 4:40 AM ET; weekly reset time not yet recorded: read it from Settings > Usage and write it here). B = Nick's second Max account, usable from Wed 9/23 3:00 PM ET, via PASTE-TO-RESUME.md in a fresh session.
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
