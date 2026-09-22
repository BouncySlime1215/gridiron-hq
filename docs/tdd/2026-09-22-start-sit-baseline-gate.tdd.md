# The standing start/sit gate: our projection vs "start the higher average"

Unit C-01 (plan item C12). Branch `claude/local-c-01-startsit-baseline-gate` off
`origin/main d6d7bd5a`. Pre-registration: `docs/evidence/2026-09-22/start-sit-baseline-gate-prereg.md`,
committed at `a2ea8714` before any number was run.

## 1. Audit: what already exists, and extend-or-build

Written before the first test. Every line is on `d6d7bd5a`.

| piece | what it is | decision |
|---|---|---|
| `server/services/weekly-backtest.js:88` `replaySeasonWeekly` | the walk-forward replay; `_decision_rows` (`:163-170`) is the decision population already: players active in W−1, graded with 0 when they do not play | **reuse, unedited.** The gate calls it with configuration B and an as-of champion head |
| `server/services/backtest-significance.js:57` `pairedBootstrapDiff` | paired bootstrap with one cluster key per unit | **reuse, unedited,** for the week-clustered CI. It cannot express the player-clustered CI: a start/sit pair has **two** players, and a unit gets one key. The gate adds a two-factor (pigeonhole) resampler for that one shape |
| `server/services/lineup-posture.js:292`, `:405` | the two places the app *tells* the user "start the highest projection" (no opponent; a neutral matchup) | **not edited.** They state the rule as advice; nothing measured whether it beats a model-free version. That is what this gate measures |
| `server/services/lineup-brain.js:268` `DECISION_CURVE` | a static tail-rate curve measured on a research-baseline projection (startable MAE 6.085), 2018-2025, not production's projection | **not edited; disagreement named.** The gate reports each rule's pair accuracy on the same ≥ 8.0 startable universe, but on production's replay predictor and on 2024-2026. The two numbers describe different projections, so they will not match. C-10 (`lineup-brain.js:268` → tracked rate) is the named follow-up that should read this gate's rows |
| `scripts/promote-early-week-weights.mjs:153` `startSitPairAccuracy` | the one existing pair-accuracy producer (script, report-only): same week and position, every model ≥ a threshold, ties 0.5 | **one definition, two call sites.** The gate's pair accuracy is pinned equal to it on a shared fixture by a test, so the two cannot drift apart |
| `server/services/gate-verdicts.js` | pre-registered ship rules as pure functions | **pattern followed** (the verdict is a pure, tested function), file not edited (another thread's) |
| `scripts/fit-weekly-coverage.mjs:72-75` `production()` | configuration B as a helper: `kOverride: undefined`, `roleRecency: WEEKLY_ROLE_RECENCY`, ensemble head | **same shape,** except the head is the **as-of** champion (`activeWeeklyWeightSet({season, week})`), not a pinned fit: the gate grades what production would have served that week |
| `server/services/model-governance.js:154` `recordGateAudit` → `model_gate_audits` | immutable, hash-deduplicated gate-result store, verdict computed from `gates[].passed` | **reuse as the store, no migration.** Rows carry `sport = 'FANTASY'`, so the betting readers (`nfl-research.js:269` `gateAudits('NFL')`, `nfl-evidence.js:109` count of `sport='NFL'`, `routes/nfl-market.js:217` promote with `'NFL'`) never see them |
| `server/services/scheduler.js` `JOBS` | no gate job exists | **build:** `start_sit_gate`, growth tier, `offThread: true`, weekly cadence. B-17 (ops calendar, not built) will map it to a day |
| `client/src/pages/Lineup.tsx` | no gate panel | **build:** one panel on the existing page; nav stays 8 tabs |

Grep for other producers of the same concept (start/sit decision rate, pair
accuracy, "highest projection") on `d6d7bd5a`:
`git grep -n -i "decision win rate\|highest projection\|pair accuracy\|startSitPair" -- server client/src scripts`
returns only `lineup-posture.js:292,405`, `weekly-ensemble.js:40` (a quoted
0.605 → 0.626 from the early-week gate), `td-features.js:36` (a comment) and
`scripts/promote-early-week-weights.mjs:59,149,153,341`. Control for the grep:
the same command finds `startSitPairAccuracy`, a producer known to exist.

**Decision: extend.** Reuse the replay, the week-clustered bootstrap and the
governance store. Build only the pieces nothing does: the pair builder, the
two-factor resampler, the verdict, the job, the route and the panel.
