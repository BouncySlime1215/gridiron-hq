# CLOUD QUEUE (the hourly tick launches the next items with bin/cloud-run.sh when fewer than ~8 cloud builds are in flight; Nick: "do this on your own, lock in")
Launched: batch 1 (#230-#246), batch 2 (PEOPLE-01, CAMPAIGN-PEOPLE, EA-04, HEALTH-01b+c, HEALTH-01d+e, COACH-01a), batch 3 (JEV-01a, PROJ-04-a, EA-05, LIVING-01b, CHESS-01a, M5 bandit, REP-01).
Next (in order; each builds on the named PR branch when stacked):
1. Fix units from INTEGRATION-AUDIT-0923.md (as soon as it lands) — highest priority.
2. EA-06 monitor + drift fallback (on EA-05).
3. EA-07 one world per week (folds RL-17-3 #241, RL-19-2) + UI-ENG-1 range bar after it.
4. TELLS-01b tells card + clone features (after PEOPLE-01 merges; counterparty-pricing).
5. CLONE-01b b2 clones + veto (after #239).
6. JEV-01b grader + calibration + blend (after JEV-01a).
7. HYPO-01a surprise detector -> Jev hypotheses (after JEV-01a).
8. ACQ-01 on the engine (planner as a producer, after EA-04/05).
9. FLIP-01 radar as a nightly producer + news triggers (after EA-04).
10. SELF-01b clone of Nick (after #245 + profiles).
11. UI-ENG-4 clone view per league-4 manager (profile + P(accept) + reasons) in the War Room.
12. UI-ENG-5 chess path steps in the War Room (after CHESS-01a).
13. R&D winners from NORTH-STAR-RND.md as they confirm.
