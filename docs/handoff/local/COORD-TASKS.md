# COORD-TASKS: the coordinator's own hands-on list (always non-empty; the 5-min COORDINATOR TICK pulls from the top)
Add tasks the moment you discover them; strike them with the result + time from `date`.
1. Run ~/gridiron-local/bin/verify-warroom.sh after every merge to main that touches the War Room/campaign; file any FAIL as a task.
2. Browser-audit localhost:5177 War Room + Coach at 1440x900 and 375x812 after each UI merge (WR-L4 #328, WR-E2E #330, #332, WR-POLISH, NUMBER-DOT, UI-BATCH): file new defects into build units or fix small ones yourself.
3. Review each finished PR's diff yourself for the 10 AM path (#328, #330, #332, int4, WR-POLISH, NUMBER-DOT, VOICE-02, REFRESH-L4, REPRO-01): look for the freeze pattern (heavy work on the request thread), second producers, names, invented numbers.
4. After int4 merges: remove #327 from auto-intake.seen and put it in merge-order; restart refresh with GRIDIRON_WARROOM_LEAGUES=4 once REFRESH-L4 merges; re-run the league-4 plan; re-run verify-warroom (the untouchables must PASS).
5. Keep the morning brief draft current in MORNING-BRIEF.md as results land (don't leave it all for 9:37).
6. Check cloud sessions' pushes (FIXB batches) and the budget; relaunch stalled ones only within budget.
7. Tighten tests where reviewers found gaps (e.g. the #325 served-preview pricing 1/10; the #326 retro 0/8 label).
