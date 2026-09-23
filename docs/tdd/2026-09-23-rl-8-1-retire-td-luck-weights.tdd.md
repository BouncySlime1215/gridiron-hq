# RL-8-1: retire the in-season td_luck weights (consensus prices them)

Unit: RL-8-1 (WORK-QUEUE section 9, round 8; plan items TM-02 / TR-05 / AI-08 / S-19).
Base tree: origin/main `3ac59fea`. Branch: `claude/local-rl-8-1-retire-td-luck-weights`.
Source finding: R&D r8 external package `rnd/loop/r8-external-regression-tag-priced.md` (local, not in the repo).

## 1. Audit: what exists (extend or build)

Commands run on `3ac59fea`:

- `grep -rnI -i -E 'td_luck|tdLuck|td_regression|tdRegression|fpoe|td-regression' server client/src test`
- `grep -rnI "player-case\|regressionCandidates\|touchdownRates" server client/src scripts`
- `git grep -n "regressionForLeague" -- server client test`

Producers of the "touchdown luck" concept on origin/main:

| where | what | reaches |
|---|---|---|
| `server/services/td-regression.js` `regressionCandidates` | fitted expected-TD board (hot = `negative_regression`, cold = `positive_regression`) | only the two consumers below |
| `server/services/player-case.js:214-233` | `td_luck` factor, weight `min(1.2, abs(ppg_swing)/2)`; a single factor at 1.2 alone clears the ±0.8 verdict line (`player-case.js:246-249`) | `lineup-brain.js:565` `safeCase` -> `lineupCall` `football` -> Start/Sit page (`client/src/pages/Lineup.tsx:338`, `net_lean` colour and verdict line) |
| `server/services/lineup-brain.js:533-545` | `evidence` map of hot/cold text -> `caution` / `upside` fields on every Start/Sit call | `client/src/pages/Lineup.tsx:358-374` ("Running hot" / "Due to score" lines) |
| `server/services/gridiron-model.js:150-160` | registry entry `fantasy.td_regression`, `baseAuthority: 'advisory'` (may inform and rank) | `modelMap()` / `ask()` |
| `server/services/preseason-model.js:478,533,556` | `td_luck_pg_1`, last season's points over expected per game, a fitted and tested PRESEASON feature | preseason model; KEPT by this unit |
| `server/services/td-regression.js:344` `regressionForLeague` | league join | no caller (definition only) |

No trade value reads it: the r8 package greps `trade-engine.js ros-projection.js trade-horizon.js news-lag-trader.js routes/trades.js title-odds-trades.js opportunity-model.js` for `regression|td_luck|tdLuck|fpoe|over.expected` and gets 0 hits; this unit did not re-run that grep beyond the whole-tree grep above, whose only in-season consumers are player-case.js and lineup-brain.js.

Decision: **extend (subtract), not build.** Nothing new is produced. The in-season weight and flag are deleted from the two consumers, the registry entry is demoted from `advisory` to `research` (may inform, may not rank or decide) with the r8 reason as its refusal, and the td-regression.js header claim ("the most reliable inefficiency", "the profitable half") is rewritten. The preseason feature is untouched and pinned by a test.

Why (r8, graded 2021-24, 2025 not opened, 2026 not graded): after consensus ROS ECR, one PPR point per game of FPOE is worth about 0 ROS points per game (it is worth -0.20 to -0.33 without ECR, the known-nonzero control); pair-accuracy gain over ECR is +0.0000 to -0.0003; humans in 1,363 real Sleeper 1-for-1 trades price about 73% of it (b_fpoe -0.059 [-0.154, +0.041] vs placebo -0.220). R2 internal separately found the next-week Start/Sit value nil and the name join broken. Those numbers are the r8 package's, produced by the scripts it names; this unit did not re-run them.

Not statistical: this unit adds no model number and runs no grade, so no pre-registration and no holdout look (nothing is appended to `docs/evidence/HOLDOUT-LEDGER.md`).
