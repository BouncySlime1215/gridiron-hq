# FIELD REGISTRY: one producer per number (like MIGRATIONS.md). The sweep checks every PR against it; a second producer is a defect.
| field / output | the ONE producer (file) | PR | consumers |
|---|---|---|---|
| people.profile (typed, nick block) | server/services/people/profile-reader.js | #260 (ONE-READER) | counterpart, campaign partners, Coach people_read, UI-ENG-4, bandit, chat-labels |
| people.counterpart (P(responds), P(yes), reply mix, yes-point) | server/services/people/counterpart.js | #254 (ONE-COUNTERPART) | planner opponent model (COUNTERPART-02), Coach roleplay/negotiate, People board |
| people.credibility | server/services/people/credibility.js | CRED-01 | counterpart (targets only), Coach |
| people.pulse (labelled statements) | server/services/people/pulse.js | PULSE-01 | replan trigger, ticker, Coach pulse_read |
| plans.json (destination, next_move, alternatives, flip_map, targets, itinerary, catch_up, speed, feasibility) | scripts/campaign/produce-plans.mjs + campaign/* | #233 + #272 (ONE-PLANNER) | War Room view, Coach plan_read, PUSH-01, STEP-LOG |
| title.odds / range.week (one world per week) | EA-07 world | #269 | planner, trade engine, Title tab, lineup |
| nfl.week / league.week | week.js | #283 BROKEN-D | all pages, daemon |
| blend.week ("this week" points) | #291 BROKEN-G | #291 | Start/Sit, lineup, trade card |
| avail.p_play | #285 BROKEN-E | #285 | trade values, sim |
| activity.manager | LIVING-01c #273 (+ ACTIVITY-01 intensity) | #273 | counterpart P(responds), sim |
| brain_report (E1-E7) | server/services/eval | #235 + #246 + FIX-09 | FIX-05 gate, War Room card, Coach brain_read |
| number audit | #237 BROKEN-01 | #237 | health card, Coach health_read |
| served numbers log | #243 SERVE-LOG | #243 | E-graders, Coach recall |
| fatigue (offers sent this week) | FIX-07 sentThisWeek | #275 | planner, REP-01 |
| last-good fallback | engine spine state.js | #250 | all views |
