# S-03: apply S-02 to the served weekly construction

Unit S-03 (WORK-QUEUE §5, plan item A2 / Structure). Applies S-02's grade
(`docs/evidence/2026-09-22/weekly-construction-grade.md`, PR #155, not merged when this started:
**this branch is stacked on S-02's branch at `c9d1acd8`**). Pre-registration of the one new number
this unit runs: `docs/evidence/2026-09-22/weekly-construction-walk-forward-preregistration.md`,
committed before any number.

## 1. Audit: extend or build (written before the first test, tree `8321b7c3`)

"This week's points" for one player has 7+ producers (STRUCTURE-MAP D1). The ones this unit's
files feed, and every existing piece it could reuse:

| Existing | file:line on `8321b7c3` | What it does today | Decision |
|---|---|---|---|
| Coordinator read | fantasy-coordinator.js:378-382 `activeFantasyCoordinatorFit` | serves the **latest** `fantasy_coordinator_fits` row (writer `saveFantasyCoordinatorFit`, fantasy-coordinator.js:369, called by the daily heavy job scheduler.js:1434), gated by nothing. On the local copy the 5 rows (ids 1, 2, 5, 6, 7) all say `through_season` 2025 and 23,334 rows, yet their intercepts are −0.574, −0.423, +0.578, +0.578, −0.555 (command in section 5): the engine changed between refits, and whichever ran last is served | **extend**: serve only a promoted row |
| Promotion pattern | weekly-weight-store.js:34 (`promoted=1`), :174 `promoteWeeklyFitChecked` | the ensemble's own promoted-fit column and checked promotion | **reuse the shape** (a `promoted` column plus a checked promote function), not the code: the ensemble gate grades a candidate against a champion on MAE, which is not this fit's evidence |
| Coordinator base, trade page | trade-engine.js:353-355 | `coordinateFantasy(fit, experts, weeklyPpg)`: a structural-residual fit added to the **ensemble** (arm B) | **replace** with one construction function |
| Coordinator base, player wrapper | fantasy-coordinator.js:565-571 `weeklyProjectionFor` | the same arm B, written a second time | **replace** with the same function (one producer, not two) |
| Fit target | fantasy-coordinator.js:324 (target), :355 (`safeguards.target`) | every fit records "structural-projection residual" | **reuse**: the served base follows the fit's recorded target, so B cannot be built |
| Betting-line lift | waiver-brain.js:162-185 `vegasLift`; callers lineup-brain.js:357, trade-engine.js:2651, waiver-brain.js:202 | full multiplier on Start/Sit, the League Hub card and the waiver horizon | **one switch inside `vegasLift`**; callers untouched. The multiplier's code moves unchanged into `gameScriptLift` so studies can still grade it |
| PR #57 (draft, 5f9c3y) fix 2 | trade-engine.js `coordinatorBase` on its branch | moves the base to structural at the trade-engine call site only | **superseded at the producer**: the base is decided in fantasy-coordinator.js for both call sites. Reported to that thread, not edited |
| Fit watchers | decay-watch.js:63; routes/model.js:550 | read the latest row as "the approved fit" | decay-watch reads the served fit through the one reader (same unit, else it would watch an unserved candidate); routes/model.js is the Wiring map thread's file: reported |
| S-02 study library | scripts/weekly-construction-grade-lib.mjs | the seven arms from the served functions; the ship rule; the guards | **reuse** for the walk-forward grade (new runner, no copy of any arm) |
| Surface label | trade-engine.js:482-494 `out.context` → `model_context` (routes/trades.js:871, trade-engine.js:1818, :2220, :2462); Start/Sit's "Betting market" line (lineup-brain.js:607 → Lineup.tsx:345-347) | no label says what the week number is built from; the Start/Sit card says the market moved the number | **extend** `out.context` and each asset with the construction; the lift's own reading, which Start/Sit already renders, says the lift is off. Per-player chips are S-14 (after S-03) |

Not built here, by design: a second "this week" function (S-01 unifies the pages after this unit);
anything in `ceiling-lineup.js`, `news-fantasy-impact.js`, `season-sim.js` (S-06, S-05); the
combination package the R&D validator rejected (VALIDATOR-LOG round 3 §7).
