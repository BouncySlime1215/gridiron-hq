# BLEND-01: one producer for the served weekly number, blended with ESPN's by a pre-registered tournament

Unit BLEND-01 (WORK-QUEUE §15; plan item C12 / Structure). Branch
`claude/local-blend-01-weekly-blend-tournament` from `origin/main` `a3e2bf35`. Pre-registration:
`docs/evidence/2026-09-22/weekly-blend-tournament-preregistration.md`, committed before any number.
All data runs are on a **local copy, not production** (`.local-db/data.sqlite`, a `.backup` of
`~/gridiron-local/data.sqlite` taken 2026-09-22 19:57 ET).

## 1. Audit: extend or build (written before the first test, tree `a3e2bf35`)

**Verdict: build a new served module and a study; extend the producer at one call site.**
Nothing on main blends ESPN's weekly projection into any weekly number. Command:
`git grep -c -i -E "projected_points|league_roster_snapshots" -- <file>` returns 0 for
`weekly-ensemble.js`, `weekly-backtest.js`, `fantasy-coordinator.js` and `trade-engine.js`, and 1
for `lineup-brain.js`, where the hit (`:686`) is a lineup-total output field, not a read.
Known-nonzero control: 8 in `scripts/collect-roster-snapshots.mjs`.

| Existing | file:line on `a3e2bf35` | What it does today | Decision |
|---|---|---|---|
| The producer | `server/services/trade-engine.js:384` `currentWeekPpg` → `current_week_ppg` (`:474`) | this week's number: base x `thisGame.mult` x `active_probability`, 0 on a bye | **extend at this one line**. Every weekly page reads it (next row) |
| Its readers (STRUCTURE-MAP D1 a-d) | `lineup-brain.js:356` `startSitWeekPoints`; `trade-engine.js:2675` `lineupDiffWeekPoints`; `waiver-wire.js:127` `weekPpg`; `lineup-posture.js:68` `weekPpg`; `TradeCard.tsx:79` | Start/Sit, the League Hub card, the waiver board, the matchup card and the trade pill all read `current_week_ppg` | **no edit**: blending where the number is made reaches all five |
| S-03 (local branch, not merged) | `trade-engine.js:352-367` on its branch; `fantasy-coordinator.js:710` `servedWeekConstruction` | serves only a promoted coordinator fit on its own base; switches the betting-line lift off; promoting fit 7 in both windows | **stack on it, never edit its lines**. The study rebuilds its base from merged functions and checks parity once merged |
| ESPN's weekly projection | `league_roster_snapshots.projected_points`, writer `scripts/collect-roster-snapshots.mjs:109` `writePeriod` (value built `:92`) | every rostered player, per league and period; `live` rows updated each refresh tick, `final` rows from the boxscore; only reader today is `bluff-detector.js:111` (names only) | **reuse as the blend's ESPN input; no migration** |
| ESPN id → our player | `players.espn_id`, written by `server/services/espn-draft.js:135` `resolveEspnPlayers` (`:167` update, `:172` insert); the collector maps the same way (`collect-roster-snapshots.mjs:52` `playerIndex`) | the app's one ESPN id mapping | **reuse**: the reader keys on `players.espn_id` |
| Combination maths | `server/services/forecast-combination.js:159` `constrainedLeastSquares`; `:577` `shrunk_to_equal` (Stock-Watson) | betting-only today (plus `opportunity-model.js`, which imports `solveLinear` only) | **reuse** `constrainedLeastSquares` for fitted weights and the Stock-Watson shrinkage form, with T counted as weekly slates (`:27-32`) |
| Grading pieces (S-02, #155) | `scripts/weekly-construction-grade-lib.mjs:99` `eligibleRows`, `:276` `assertKControl`, `:286` `assertFitCutoff`, `:123` `mde80`, `:196` `decisionWinRate` | the decision-row population, the replay guards, MDE | **reuse**. S-02 clusters its CIs by week x position; the unit asks for player-clustered intervals, so the pair bootstrap is new |
| Pair accuracy | `scripts/promote-early-week-weights.mjs:153` `startSitPairAccuracy` | house start/sit pair metric | **reuse** as the parity check on the runner's own pair enumeration |
| Served snapshot | `weekly_prediction_snapshots`, writer `server/services/weekly-learning.js:49` `captureWeeklyPredictions` (insert `:63`) | 2026 W2 only: the ensemble on frozen-2023 weights, 18:56Z Thursday | **forward sensitivity** (what was served then) |
| ESPN Thursday capture | `espn_player_market_weekly` (no writer in the repo) | one W2 capture, 22:08Z Thursday | **forward sensitivity only** |
| ESPN archive | R&D loop `~/gridiron-local/rnd/loop/data/espn_proj_hist/` (`r2-external-espn-weekly-projection-history.md`) | ESPN's weekly projection for 2021-2024 and 2026, the same number the app stores | **history input, local only, never committed** |
| HX-01 (local branch, not merged) | `scripts/historical-consensus-lib.mjs` on its branch | our served number replayed 2022-2024 against FantasyPros | **not imported** (not merged). Same replay shape rebuilt here; follow-up: swap in its served-row library once merged |
| C-01 (local branch, not merged) | `server/services/gates/start-sit-gate.js` on its branch | the start/sit gate, with ESPN as arm B on W2 | **not imported**. Its "one value per player-week, conflicting leagues dropped" rule is reused |
| RL-1-1 (queued) | migration 071 `espn_proj` column | same-cutoff ESPN capture for free agents | **not built** (no migration in this unit) |

**Other producers of "this week's points" this unit does not change** (STRUCTURE-MAP D1):
- (e) the raw `ppg`/`proj` fields;
- (f) `ceiling-lineup.js`;
- (g) `news-fantasy-impact.js`;
- (h) `season-sim.js`;
- (i) `fantasy-coordinator.js` `weeklyProjectionFor` (never rendered).

Named, not edited. The follow-ups are S-01, S-05 and S-06. The floor, ceiling and mean
(`weekDist`, `WEEK_MARGINAL`) stay on our distribution; that is a named follow-up in §7.
