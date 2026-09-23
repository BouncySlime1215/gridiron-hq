# GR-01: the recommendation ledger (C13 grading, C17, C-08)

Unit GR-01, plan item 13 (decision post-mortem loop). Branch
`claude/local-gr-01-recommendation-ledger`, cut from origin/main `89f69b3b`.

## 1. Audit: what already exists for this surface (tree 89f69b3b)

Commands: `grep -rn 'trade_outcomes' server`, `grep -rln 'CREATE TABLE IF NOT EXISTS [a-z_]*\(decision\|recommend\|grade\|ledger\)' server`,
`grep -rn 'INSERT[A-Z ]* INTO player_week_usage' server`, and the reads below.

| Existing surface | Table / writer (file:line) | What it answers | Why it is not this unit |
|---|---|---|---|
| Decision Inbox | `decision_recommendations`, `server/migrations/020_decision_recommendations.js`; publisher in `server/routes/decision-inbox.js` | "what has the app told me, and did I act on it" (open / actioned / dismissed / expired) | lifecycle of a nudge; no prediction, no baseline, no horizon, no score. An upsert keyed on `dedup_key` overwrites the prediction in place, so it cannot be graded later. |
| Trade outcome ledger | `trade_outcomes`, `server/migrations/067_outcome_ledgers.js`; writers `recordProposedOutcome` / `recordConsideredOnly` / `recordProposalSlate` at `server/services/trade-outcomes.js:234`, `:262`, `:321`; only caller `server/routes/trades.js:783` (`/proposals`) | "when the model said 70% he would accept, did he" (acceptance calibration of the AI proposals slate) | measures ACCEPTANCE of the `/proposals` slate. It records no points outcome and no horizon, and it is never written by `/find`, `/offer`, `/offer-many`, `/lineup` or `/waivers`. |
| NFL decision tape | `nfl_decision_runs` / `nfl_decision_events`, `server/migrations/027_decision_tape.js` | betting-side policy decisions | betting scope; out of this unit. |
| Forward ledger | `forward_picks`, `server/services/forward-ledger.js` | betting picks before kickoff | betting scope. |

**Realised weekly points, the one producer.** Two candidates exist:

- `player_gamelog.fantasy_points` (writer `syncGameLogs`, `server/routes/edge.js:99`): fixed PPR, top-250
  players only, defaults to the prior season. On the local copy (not production) it holds **0 rows**:
  `sqlite3 .local-db/data.sqlite "select season,count(*) from player_gamelog group by season"` returns nothing,
  while the known-nonzero control on the same file,
  `select season,count(*),max(week) from player_week_usage group by season order by season desc limit 3`,
  returns `2026|1052|2`, `2025|8857|18`, `2024|8675|18`.
- `player_week_usage` (writer `server/services/nflverse.js:260`, job `nflverse_weekly_usage`), scored per
  league by `scoreLine(u, scoringFor(lg))` (`server/services/scoring.js:52`, `:82`). This is what
  `actuals(season, scoring)` in `server/services/backtest.js:26` already does.

The grader reuses `actuals()` from `backtest.js`; it does not write a third scorer.

**Extend or build: BUILD a new table, reuse every producer.** `trade_outcomes` is the closest neighbour, but
its unit of truth is an accept/decline event keyed on the `/proposals` slate, and its CHECKs require
`model_p_accept` on a proposed row, which `/find`, `/offer` and `/lineup` do not produce. Folding points
grading into it would either weaken its contract or leave lineup and waiver calls with nowhere to go. A
separate `rec_ledger` answers the other question the plan item asks (did the call gain points against the
call we would otherwise have made), and it names `trade_outcomes` as its sibling rather than duplicating it:
no acceptance probability is stored here.

## 2. Pre-registration

Not applicable. This unit ships plumbing (a ledger, its writers, a grader and a count reader). It produces no
model number and no ship/no-ship claim; the grader's scores are stored, not reported as evidence. The first
unit to read `score` as evidence (GR-02, the report card) owns its pre-registration. No look at the 2025
held-out season was taken (Holdout looks: none).
