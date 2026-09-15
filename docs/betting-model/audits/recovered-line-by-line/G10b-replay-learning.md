# Adversarial verification — reader G10b-replay-learning (10 claims)

Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only; server/data.sqlite opened only via `node:sqlite` `{readOnly:true}`)
Date of review: 2026-09-12. Method: for each claim, read the cited file (>=80 lines around the cited line), traced every callee/caller named as "evidence", and where the claim cited live DB state, re-ran the same read-only query myself.

---

## #78 — weekly-learning.js:69 `if (!engine?.heads) continue;` — Week 1 forward capture permanently null

**Files read:** server/services/weekly-learning.js (full file, 220/220 lines). server/services/player-week-engine.js lines 100-199 (buildPlayerWeekEngine, priorScores). server/services/weekly-ensemble.js (full file, 41/41 lines — `weeklyEnsembleContext`).

Traced the exact mechanism:
- `priorScores(season, week, scoring)` (player-week-engine.js:123-132) queries `player_week_usage WHERE season=? AND week<?` — **same-season only**, no lookback into the prior season.
- For `week=1`, `week<1` matches nothing, so `priorWeeks` is `[]` for every player, every season, forever.
- `weeklyEnsembleContext({priorWeeks:[], ...})` (weekly-ensemble.js:28-29) is `if (!priorWeeks?.length) return null;` — so `context` is `null` for literally every player at week 1.
- `buildPlayerWeekEngine` (player-week-engine.js:159-170) sets `heads: context` = `null`, mode `'structural_only_no_current_season_history'`.
- Back in `captureWeeklyPredictions` (weekly-learning.js:67-76), `if (!engine?.heads) continue;` skips every player, so `captured` stays 0 for week 1 in every season — this is a structural, permanent property of the code, not a transient data gap.

Live DB (read-only, confirmed myself):
```
weekly_prediction_snapshots GROUP BY season -> []   (table is completely empty, all seasons)
weekly_ensemble_fits count -> 0
sync_log job=nfl_weekly_learning:
  last_status: "ok"
  last_detail: {"current":{"season":2026,"week":1},
    "capture":{"captured":0,"blocked":true,"reason":"the weekly slate has started; a whole-week pregame snapshot cannot be reconstructed"},
    "settlement":{"pending":0,"settled":0},"training":{"trained":false,...}}
  runs: 35
```
This matches the claim's cited counts closely (runs=34 claimed vs 35 observed a few minutes later — consistent with the job firing again between when the claim was written and when I checked).

**One correction to the claim's mechanism, not its substance:** the *current* live run is blocked by the earlier `schedule.some(game=>game.team_score!=null) || firstKickoff<=now` guard at weekly-learning.js:53-56 (kickoff has already passed for week 1 games), not by the `!engine?.heads` line directly — so right now the per-player loop with the heads-skip is never even reached. But this doesn't save the claim: (a) `captureWeeklyPredictions`'s bottom-of-function return path (line 79-80) has no `blocked` flag and no top-level `skipped` flag either way, so `runWeeklyLearningCycle()`'s result object never carries a scheduler-visible `skipped:true`, and scheduler.js's `record(name, detail?.skipped===true?'skipped':'ok', detail)` will mark this job `'ok'` in **both** the schedule-started-block case and the heads-skip case — confirmed live (`last_status:"ok"` despite `capture.captured:0`). (b) Even before kickoff, the heads-skip bug independently guarantees `captured:0` for week 1 — it's not merely redundant with the kickoff guard, it's an orthogonal, permanent defect that will recur unconditionally every season at week 1, including weeks that get re-attempted before kickoff in future years.
- Once week 1's first kickoff passes (as it already has for 2026), the block at line 53-56 is permanent and irreversible for the rest of the season, so "2026 Week 1 is now permanently blocked" for pregame snapshot capture is literally true.

**Verdict: CONFIRMED, not refuted.** Severity P1 is justified: it silently defeats the only mechanism that produces forward evidence for the fantasy projection engine (Nick's stated top priority is fantasy over betting), the scheduler status makes it invisible ("ok" every time), and — independent of any one season's kickoff timing — the underlying `!engine?.heads` gate makes Week 1 forward capture structurally impossible every year unless the code changes to look at the tail of the previous season.

---

## #79 — scheduler.js:678 (`refreshNflDecisionLedger`) / nfl-auto-picks.js `persistPickDecisions` — "frozen forward decision ledger" upsert

**Files read:** server/services/scheduler.js lines 640-740, 855-1010. server/services/nfl-auto-picks.js (full file, 285/285 lines). server/services/nfl-decision-tape.js lines 1-90 (module header + status doc). server/services/nfl-profitability.js lines 180-215. server/services/nfl-evidence.js lines 87-130 (`validationFirewall`). server/services/nfl-ensemble.js lines 1352-1356 (`ensembleWeek`).

The technical claim is true as stated: `persistPickDecisions` (nfl-auto-picks.js:205-222) does `ON CONFLICT(season,week,policy_id,matchup,market,selection) DO UPDATE SET line=excluded.line, american_price=..., quote_at=..., edge=..., eligible=..., recorded_at=excluded.recorded_at`, and `ensembleWeek` (nfl-ensemble.js:1352-1356) returns every game of the week with no filter on kickoff or `team_score`, so a re-run does re-decide already-played games and does overwrite the previously-recorded `quote_at`/line/price. Live DB confirms this pattern generically (week 1 2026: 16 rows, `MIN(recorded_at)=MAX(recorded_at)` after every pass; `sync_log.nfl_decision_ledger.runs=68` at review time).

**But the codebase already documents this exact fact and has already superseded this table as the evidence path — this is what refutes the claim's framing and impact.** `nfl-decision-tape.js`'s own header (lines 3-56) says, verbatim:

> "`persistPickDecisions` (nfl-auto-picks.js) writes a MUTABLE latest view: it UPSERTs over (season, week, policy_id, matchup, market, selection) ... so re-running the board after a line moved overwrites what the model actually decided before it moved. ... This module is the evidence layer those two facts require: every candidate is recorded, eligible or not, ... and the rows are append-only at the schema level (migrations 027 and 031) rather than by convention. ... `nfl_pick_decisions` is deliberately still written by its existing caller. It remains a convenient latest-view projection for the UI; it is simply no longer the evidence anything is evaluated from."

So: (1) this was already found and fixed by a Codex correction dated 2026-09-10 (two days before this review); (2) the actual append-only "frozen forward decision ledger" is `nfl-decision-tape.js`'s `recordDecisionRun`, called from `nfl-execution-pipeline.js:128`, which is reached via `nfl-prospective-collection.js` (the same family of module driving the live T-60 capture process this session was told not to disturb) — not via `scheduler.js`'s `refreshNflDecisionLedger`. (3) The actual numeric gate Nick would read — `validationFirewall().forward` in `nfl-evidence.js:100-124`, consumed by `nfl-profitability.js` for the profitability-page "forward" completion/target numbers — reads from `shadow_decisions`, **not** `nfl_pick_decisions`:
```js
const forward = tableExists('shadow_decisions') ? rows(`SELECT COUNT(DISTINCT ... ) decisions, ... FROM shadow_decisions WHERE sport='NFL' ...`)[0] : {decisions:0, settled:0};
```
`nfl-profitability.js:205` does list `nfl_pick_decisions` inside a decorative label string (`blind_audit: 'preregistered 2026 forward ledger (nfl_pick_decisions + shadow_decisions)'`), but that string is not the computation — the computation is `shadow_decisions`-only, which this overwrite does not touch.

`scheduler.js:684-693`'s own comment calls the automation "the forward decision ledger for the CURRENT week," but reading it carefully, the things it says are "frozen" are the *pregame snapshots* (`capturePregameSnapshots`) and the *expert council* (`captureForwardExpertWeek`, which is independently documented as append-only — "Predictions are append-only and settlement cannot overwrite their evidence, timestamp or number," confirmed live in this session's own sync_log detail: `"rule":"Predictions are append-only..."`), not `nfl_pick_decisions` itself.

**Verdict: REFUTED at the severity claimed.** The technical fact (last-write-wins UPSERT, no kickoff filter) is real, but it does not change any number Nick reads, does not corrupt the actual evidence trail used for CLV/promotion decisions (that is `shadow_decisions` + the append-only decision-tape, both unaffected), and is explicitly known and intentionally accepted by the same codebase two days before this review, with a comment saying so in so many words. Corrected severity: **P3** — a stale/misleading comment plus a UI-cache table churning, not a data-integrity or backtest-leakage defect.

---

## #80 — scheduler.js:958 / nfl-offseason-cycle.js — sync_log row shared between scheduler wrapper and job's own cadence check

**Files read:** server/services/scheduler.js lines 55-95, 855-870, 930-990. server/services/nfl-offseason-cycle.js (full file, 169/169 lines).

Confirmed exact mechanism:
- `OFFSEASON_DEPTH_INJURY_SOURCE = 'nfl_offseason_depth_injury'` (nfl-offseason-cycle.js:38) is the **same string** as the `JOBS` key registered in scheduler.js:861 (`nfl_offseason_depth_injury: { run: refreshNflOffseasonDepthInjury, maxAgeMinutes: 6*60, tier:'growth', ...}`) — both read/write the identical `sync_log` row.
- `record()` (scheduler.js:78-84) unconditionally does `last_run_at=nowIso()` on **every** call, whether the job actually did work or returned `{skipped:true}` (scheduler.js:980: `record(name, detail?.skipped===true?'skipped':'ok', detail)` — `last_run_at` is set regardless of the status string).
- `refreshNflOffseasonDepthAndInjuries()` (nfl-offseason-cycle.js:94-109) computes `hoursSince = (Date.now() - last.last_run_at)/36e5` from that **same row**, and skips if `hoursSince < dueInHours` (24-720h depending on calendar, nfl-offseason-cycle.js:70-85).
- Net effect: every time the scheduler's outer `runIfStale` calls this job (whether the job does real work or self-skips), the outer wrapper's `record()` call resets `last_run_at` to "now" regardless. So the *next* time the inner function checks `hoursSince`, it measures time since the last **scheduler tick**, not time since the last **actual sync**. Since the job's own `maxAgeMinutes` is 6 hours (360 min) — far less than any `dueInHours` value (min 24h) — `hoursSince` will essentially always read ~6h or less, which is always `< dueInHours`, so it self-perpetuates into permanent skip once it starts skipping.

Live DB (confirmed myself):
```
sync_log job=nfl_offseason_depth_injury:
  last_status: "skipped"
  last_detail: {"skipped":true,"reason":"not due yet under the variable offseason cadence","hours_since_last":6,"due_every_hours":720}
  runs: 12
```
`hours_since_last:6` lines up exactly with the outer job's `maxAgeMinutes:6*60` — direct confirmation that the "hours since last" the inner function is measuring is the outer scheduler's own poll cadence, not a real last-sync timestamp. `due_every_hours:720` matches the `isRegularSeason` branch of `offseasonRefreshIntervalHours` (nfl-offseason-cycle.js:80,82) for the current date (2026-09-12 falls in the Sep-Dec/Jan "regular season" branch under this function's calendar rule, despite still being week 1).

Confirmed the module's stated purpose (nfl-offseason-cycle.js:1-29 header) is specifically to close a "confirmed real ~6-month blackout" in depth/injury ingestion when `nfl-model-growth.js`'s per-finalized-week cycle goes quiet (Feb-Aug). `nfl-model-growth.js:195-196` does independently call `syncDepthCharts`/`syncInjuries` per finalized week — so this specific bug's *current* in-season impact is muted (a "backstop," per nfl-offseason-cycle.js:82's own comment), but the offseason months (when `dueInHours` is 24h-336h and the per-week growth cycle is entirely dormant) get the identical treatment: `last_run_at` will always look "recently touched" by scheduler ticks, so the backstop this module exists to provide never fires. That reopens exactly the blackout the module was written to close.

**Verdict: CONFIRMED, not refuted.** Real, verified against live data (exact number match on `hours_since_last` vs `maxAgeMinutes`), permanent unless fixed, and directly undoes the stated purpose of this module during the offseason months. P2 is a reasonable rating (not P1 only because in-season impact is currently backstopped by nfl-model-growth.js).

---

## #81 — scheduler.js:947 (`DEFAULT_JOB_TIMEOUT_MS`) / report-cache.js — timeout rejects but cannot cancel

**Files read:** server/services/scheduler.js lines 930-996 (`runIfStale`). server/services/report-cache.js (full file, 150/150 lines).

`Promise.race([job.run(), timeoutPromise])` (scheduler.js:966-978) only stops *waiting* on `job.run()`; it never calls anything that cancels the underlying work. `refreshStaleReports` (report-cache.js:129-137) `await`s each `refreshReport()` **sequentially** in a `for` loop, and each `refreshReport` spawns a `Worker` (report-worker.js) that keeps running to completion and eventually calls `finish()`, which writes `duration_ms`/`error:null` into `nfl_cached_reports` — regardless of whether the outer scheduler tier gave up waiting 120s in.

Live DB, confirmed myself:
```
nfl_cached_reports (report, duration_ms, error):
  nfl_diagnostic          1512292  null
  football_first_fit       276283  null
  walk_forward            2037774  null
  abstention_audit        4325014  null
  confidence_calibration  5010448  null
  line_move_study         1694982  null

sync_log job=nfl_reports:
  last_status: "error"
  last_detail: "job 'nfl_reports' exceeded its 120s budget and was abandoned so the rest of the tier could run"
  runs: 103
```
Exact match to the claim's cited range (276283..5010448ms, error null on every report) — `nfl_reports` has no `timeoutMs` override in `JOBS` (scheduler.js:865), so it uses `DEFAULT_JOB_TIMEOUT_MS=120000`, and every single report (60s-83min real work) blows straight through that, every single one of the 103 recorded runs, while every underlying report computation is completing successfully. This directly matches "health views show a working pipeline as failing."

The secondary claim ("abandoned async jobs ... can overlap their own next run") is structurally true (nothing prevents it) but not currently demonstrated in the data — the longest observed report (`confidence_calibration`, ~83.5 min) still finishes well inside this job's `maxAgeMinutes:3*60` (3h) recheck window, and `report-cache.js`'s own `inflight` map (line 96-98) would dedupe a same-report re-entry if the tier did fire again mid-flight. This part is a real latent risk, not an observed incident.

**Verdict: CONFIRMED, not refuted.** The core claim (misleading 'error' status on a healthy, if slow, pipeline) is fully verified against live data with an exact numeric match. P2 is appropriate — it's a monitoring/health-page correctness bug, not a money or evidence-integrity bug (no report's stored payload is wrong).

---

## #82 — model-intelligence.js:100 (`deterministic_outer_folds` red-team check)

**Files read:** server/services/model-intelligence.js (full file, 140/140 lines). server/services/nfl-market.js lines 378-427 (`nestedEvaluationRows` + its memo cache).

Confirmed: `redTeam()` (model-intelligence.js:95-108) does `const a = nestedEvaluationRows(), b = nestedEvaluationRows();` and `nestedEvaluationRows` (nfl-market.js:378-379) does `if (_nestedCache.has(seasonsBack)) return _nestedCache.get(seasonsBack);` with the same default `seasonsBack=4` on both calls — so the second call returns the *literal same object reference* the first call just cached. `JSON.stringify(a)===JSON.stringify(b)` is therefore guaranteed true regardless of anything about the underlying computation's actual determinism; it is testing reference identity of a cache, not reproducibility of a computation. Confirmed `nestedEvaluationRows` (nfl-market.js:378-427) is currently a pure function of `historicalGames()` with a fixed hyperparameter grid search and no randomness — so there's no live incident this masks today — but the check is genuinely tautological and would silently pass even if a future change (e.g. an accidental `Math.random()`, unstable float summation order, non-deterministic DB read order) broke determinism.

`nflIntelligence()` (model-intelligence.js:124-131) — which embeds this `red_team` block — is exposed via `server/routes/nfl-market.js:77` (`res.json(nflIntelligence())`) and via `nfl-research.js:190-197`'s persisted audit, so the `checks`/`passed`/`total` counts are a number Nick can actually see on a research page (e.g., "5/5 red-team checks passed").

**Verdict: CONFIRMED, not refuted.** It's a real, demonstrable tautology in a gate the code's own policy string says "blocks experiments and forces a human investigation." P2 is fair — no live nondeterminism exists today for it to be failing to catch, so this is a latent validation-integrity gap rather than an active one.

---

## #83 — weekly-learning.js:179 (`retrainWeeklyWeights` promotion) — repeated-look inflation

**Files read:** server/services/weekly-learning.js (full file, above). server/services/weekly-weight-store.js (full file, 37/37 lines). server/services/player-week-engine.js lines 134-170. server/services/backtest-significance.js lines 180-215.

Confirmed the mechanics: `retrainWeeklyWeights` (weekly-learning.js:151-194) computes a fresh `data_hash` from every settled snapshot row (:156-157); since a newly-settled week always changes the row set, the hash changes every week, so the "already evaluated" dedupe (:158-159) never blocks a new week's look — each settled week is a fresh statistical test against the (~20%) validation tail, immediately acted on with no correction for having repeated the test. `saveWeeklyFit` with `promoted:true` (:185-193) is picked up by `activeWeeklyWeightSet` (weekly-weight-store.js:8-18, `WHERE promoted=1 ... ORDER BY through_season DESC, through_week DESC ... LIMIT 1`), which `buildPlayerWeekEngine` (player-week-engine.js:138) reads on every single call — i.e., a single lucky week's promotion changes every player's projection going forward, with no human step in between.

`backtest-significance.js:186-214` is a real, directly-on-point citation: it documents a **Codex correction (C17, dated 2026-09-10)** for the exact same statistical failure mode ("A plug-in variance estimate from the same evaluated sequence is insufficient... checking it repeatedly and stopping when it looks good inflates the false-positive rate") — applied to the *betting* significance testing, but never applied to this *fantasy* ensemble-promotion gate. That the codebase demonstrably understands and has fixed this exact class of bug elsewhere strengthens rather than undermines the claim.

Currently dormant: `weekly_ensemble_fits` has 0 rows live (per #78's evidence), so no promotion has ever actually fired — this is a real, verified design defect but not yet a manifested incident.

**Verdict: CONFIRMED, not refuted.** P2 is reasonable given it hasn't fired yet (gated behind `minSettled=250`, and the settlement pipeline is itself broken per #78, delaying when this can even trigger) — but the mechanism is real and, when it does trigger, directly changes fantasy projections with no correction and no human gate.

---

## #84 — model-governance.js:170 (`updateRegistry`) — ungated state=production bypass

**Files read:** server/services/model-governance.js (full file, 213/213 lines). server/services/nfl-pick-watch.js lines 1-70. server/services/nfl-research.js, mlb-research.js callers (grepped, confirmed both pass `role:'challenger'`).

Confirmed: `updateRegistry({sport,market,role,modelVersion,state,reason,metrics})` (model-governance.js:170-178) validates only `role` (`must be champion or challenger`) — there is no check on `state` at all, so any caller can set `state:'production'` directly, bypassing `promoteEligibleAudit` (:181-197), which is the only path that checks `audit.verdict==='promotion_eligible'`, checks every gate passed, and writes a `model_registry_history` row. `nfl-pick-watch.js:53-55` (`marketGateOpen`) is confirmed to gate the "actionable / real recommendation" vs "no proven CLV, not a recommendation to bet money" language directly off `reg?.state==='production'` for `role:'champion'` — this is the real stake-authority gate the claim describes. Both current callers (`nfl-research.js:190`, `mlb-research.js:59`) only ever write `role:'challenger'` rows, confirmed by grep, so this bypass is unused today, and `model_registry_history` has 0 rows live (self-consistent with no promotion ever having happened through either path).

**Verdict: CONFIRMED, not refuted.** A real, verified structural gap in the governance module — no live exploit path today (no route calls `updateRegistry` with attacker-controlled `state`), matching the claim's own "unused today" framing. P2 is appropriate.

---

## #85 — scheduler.js:958 — strict `skipped===true` misses string-valued skip signals

**Files read:** server/services/scheduler.js lines 130-150, 790-810, 930-996 (all read above/together).

Confirmed both cited call sites return **string** values for `skipped`, not boolean `true`:
- `refreshPlayerRosters` (scheduler.js:137): `if (liveDraftActive()) return { skipped: 'live draft in progress — see liveDraftActive()' };`
- T-60 runner path (scheduler.js:800): `if (!Number.isFinite(season) || !Number.isFinite(week)) { return { skipped: 'no current NFL week resolved' }; }`

`record(name, detail?.skipped===true ? 'skipped' : 'ok', detail)` (scheduler.js:980) uses **strict** equality against the boolean `true`; a truthy string fails that check and falls to `'ok'`. This is a genuine, reproducible logic bug: the very comment directly above this line (scheduler.js:976-979 — "A job that chose not to do its work ... is not healthy; recording it as 'ok' told every freshness view that a capture happened when nothing did") states the author's own intent, which this line only partially implements. Live sync_log for `nfl_t60_runner` and `player_rosters` both currently show `last_status:"ok"` with details that *did* do real work this particular time (so I could not catch the exact string-skip case live, since neither condition — live draft active, or unresolved week — is true right now), but the code path is unambiguous and directly reachable (any live-draft window, or any week the schedule can't resolve).

This is directly relevant to the environment's own stated priorities: `nfl_t60_runner` is the exact live, must-not-disturb process capturing Week 1 T-60 packets right now, and `player_rosters` during a live draft is exactly the workflow Nick's "Draft-night setup" memory describes caring about.

**Verdict: CONFIRMED, not refuted.** Directly verified against source; the failure mode is real and matches the developer's own stated intent for this exact line. P2 is reasonable.

---

## #86 — nfl-props-replay.js:44 (`toHalfPoint`) — asymmetric rounding bias

**Files read:** server/services/nfl-props-replay.js lines 1-60 (module header + function).

Directly executed the cited function:
```
toHalfPoint(50.0) = 50.5   toHalfPoint(49.0) = 49.5   toHalfPoint(49.9) = 50.5
toHalfPoint(49.5) = 49.5   toHalfPoint(49.7) = 49.5   toHalfPoint(10.0) = 10.5
```
Confirmed: `Math.round(v*2)/2` only ever gets a `+0.5` correction (line 44), never a `-0.5` — so whenever the naive half-point rounding lands on a whole number, the result is always nudged **up**, never down. For continuous inputs this produces a systematic positive bias (order of magnitude the claimed ~+0.25 average is a reasonable estimate, since roughly half of real-valued inputs will hit the "round to integer" branch). This is a real, mechanically demonstrated asymmetry, not present in the surrounding comment's stated intent ("Books hang half points to avoid pushes" — true, but that half-point *placement itself is unbiased with correctly symmetric rounding*, and this implementation is not symmetric).

One overstatement in the claim's own evidence: "Pushes at :183 therefore never occur" is true, but it would be true under *symmetric* half-point rounding too (any half-point line vs. an integer actual stat can never tie) — so the "no pushes" fact is a consequence of using half-points at all, not specifically of the upward-bias bug. This doesn't undermine the core defect, just one supporting detail.

Confirmed via the file header (lines 9-23) that this proxy line is explicitly used to judge "whether the model has business being bet into a real market" — i.e., it does feed a number (per-side win rate / ROI in the props replay) that the codebase treats as a real go/no-go signal.

**Verdict: CONFIRMED, not refuted** (with the minor "pushes" nuance noted above). P2 is appropriate — it's a backtest-methodology bias affecting a real evaluation number, not a live-money bug (no real prop lines are currently bet against this proxy).

---

## #87 — week-postmortem.js:109 — postmortem attribution uses preseason, not in-season, projections

**Files read:** server/services/week-postmortem.js lines 80-140. server/services/projections.js lines 360-380 (`buildProjections` signature/defaults). server/services/player-week-engine.js lines 134-146 (`buildPlayerWeekEngine`'s own call to `buildProjections`).

Confirmed: week-postmortem.js:109 calls `buildProjections({ through: season - 1, scoring: PPR })` — no `throughWeek` at all, so it defaults to `null` (projections.js:366), meaning the projection basis is **frozen at the end of last season** with zero current-season data. Meanwhile the actual weekly advice the user saw came from `buildPlayerWeekEngine` (player-week-engine.js:143-146), whose structural call is `buildProjections({ through: season, throughWeek: week - 1, scoring, kOverride, roleRecency: WEEKLY_ROLE_RECENCY })` — i.e., through the *current* season up to the week before, capturing exactly the in-season role changes (injuries, depth-chart shifts, breakout usage) week-postmortem.js's calculation ignores. For any player whose role changed materially since last season (a rookie who took over a starting job, a free-agent signee, a mid-season breakout), the "projected" distribution used to label a week "unlucky" vs. "bad decision" (:125-126, percentile calc) is simply the wrong baseline — not what the engine that actually gave the advice believed.

Secondary point in the claim ("bestLineup at :102 also uses current asset values, not week-of values") is consistent with the same file's fallback path (`usedEngineLineup` branch, :102) calling `bestLineup(me.players, slots)` on the live/current roster rather than a week-of-week1 snapshot — a related but separate instance of the same "wrong point in time" pattern, not independently deep-dived here beyond confirming the call site exists.

**Verdict: CONFIRMED, not refuted.** This is the core analytical premise of a fantasy decision-review page (attributing bad weeks to luck vs. bad process) and it's demonstrably computed off the wrong distribution for exactly the players where it matters most (role changers). P2 is a fair rating for an analysis/labeling bug on a page Nick reads, not a P1 since no money or live pick is at stake.

---

# Summary table

| key | reader severity | verdict | corrected severity |
|---|---|---|---|
| #78 | P1 | CONFIRMED | P1 |
| #79 | P1 | **REFUTED** (superseded by nfl-decision-tape.js + shadow_decisions; codebase already documents nfl_pick_decisions as a non-evidentiary UI cache) | P3 |
| #80 | P2 | CONFIRMED | P2 |
| #81 | P2 | CONFIRMED | P2 |
| #82 | P2 | CONFIRMED | P2 |
| #83 | P2 | CONFIRMED | P2 |
| #84 | P2 | CONFIRMED | P2 |
| #85 | P2 | CONFIRMED | P2 |
| #86 | P2 | CONFIRMED | P2 |
| #87 | P2 | CONFIRMED | P2 |

Only #79 is refuted at the claimed severity; everything else in this reader's set survives adversarial review, several with exact numeric matches against the live database confirming the claimed evidence.
