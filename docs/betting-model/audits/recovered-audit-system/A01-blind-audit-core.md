# A01-blind-audit-core — Gridiron HQ blind-audit controller, registry, overview

Reader: A01-blind-audit-core. Date: 2026-09-11. Repo read-only; DB read via `node:sqlite` `readOnly:true` against `server/data.sqlite` (never the `.bak`). Every assigned file read in full (2,189 lines) plus the cutoff-bearing callees they invoke (`nfl-replay.js`, `nfl-ensemble.js`, `nfl-expert-council.js`, `nfl-expert-coordinator.js`, `nfl-postgame-truth.js`, `server/db/schema/nfl-a-to-m.js`, `server/routes/nfl-betting.js`) and plan sections 3, 4, 7, 9.

## 0. Headline

* There is **no 2026 forward run** in `nfl_blind_audit_runs`. All 24 runs (ids 9–32) are 2021–25 or 2022–25 historical replays, weeks 5–18. The "blind forward ledger" the protocol text promises (`nfl-blind-audit.js:995-997`) is not produced by this controller; the only 2026 artefacts this code touches are read-only look-back reads of `shadow_decisions` (61 `beat-the-close-v%` rows, all season 2026).
* The controller's chronology is sound where it matters: model fits, coordinator training and expert examples are cut at `(season<S) OR (season=S AND week<W)` and the run's own persisted examples are re-read by `audit_run_id`. I found **no path by which week N+1 outcomes reach week N's forecast inside these files**. The residual leakage risks live in the *content* of frozen tables (in-place mutated `nfl_injuries`/`nfl_depth`, season-level `nfl_pfr_adv`/`nfl_ngs`, `weekly_ensemble_fits` through 2025) — the freeze hashes them but cannot make them as-of. That is C04/C07/C11 territory and is flagged, not adjudicated, here.
* The overview (C09 fix) still has three counting defects: the spread-only bootstrap is fed lowercase results into a helper that matches `'Won'/'Lost'`, so `win_rate_95` is always `[0,0]` and the sample warning always fires; `spread_only.units`/bootstrap turn missing units into 0 despite the file's own rule; and "coverage complete" is computed from the observed min–max, not the run's declared schedule, so a run that died at week 12 reports `complete:true`.

## 1. `server/services/nfl-blind-audit.js` (1,005 lines)

### Purpose
Content-addressed, week-at-a-time chronological replay controller. Preregisters a spec (seasons, weeks, engine versions, policy, code hash, per-table data hashes, mutation-journal cursor), then opens one (season, week) at a time, sealing each week as a hash-chained immutable row.

### Flow
1. **Preregister** `preregisterBlindAudit()` (`:186-211`): requires clean tree unless `allowDirty` (`:188`); `normalizeSpec` clamps `startWeek` to ≥5 and `endWeek` to ≤18 (`:157-158`); inside `BEGIN IMMEDIATE` hashes 31 input tables (`inputDataState`, `:99-152`), records journal cursor `mutation_id` (`:196-197`), inserts `nfl_blind_audit_runs` status `registered`, `next_ordinal=0`.
2. **Open next week** `runNextBlindAuditWeek` → `openNextWeek` (`:829-921`):
   * status gate (`complete`/`failed`/`cancelled` refuse, `:845-847`), `assertFrozen` (`:219-236`), target = `spec.schedule[next_ordinal]` (`:851`).
   * Inside `withEphemeralEnsembleArtifacts` (`nfl-ensemble.js:951-962`, persistence disabled + caches invalidated on entry/exit): `weeklyExpertAudit(season, week, {auditRunId})`, `buildPostgameTruth` per game, `bettingWeekResult`, `playerWeekResult`, `weeklyInput`. Result keys: `cutoff` (label `${season}-W${week-1}`), `player`, `betting`, `expert_council`, `weekly_input`, `postgame_truth` (`:857-871`).
   * `lookback` chained from the previous sealed week's `result_json.lookback` (`:874-879`).
   * `resultHash = sha(JSON(result))`, `chainHash = sha(prior:ordinal:season:week:resultHash)` with `prior = last chain_hash ?? spec_hash` (`:884-888`).
   * `BEGIN IMMEDIATE` → **re-run `assertFrozen`** while holding the writer lock (`:895`) → insert `nfl_blind_audit_weeks` (PK `(run_id,ordinal)`, UNIQUE `(run_id,season,week)`) → `persistWeeklyExpertAudit(run_id, …)` (writes `nfl_weekly_expert_examples` tagged with `audit_run_id`) → `persistPostgameTruth` (writes `nfl_game_variance` and `nfl_postgame_truth_packets`) → `next_ordinal+1`, status `running`/`complete`, `final_json = aggregate(all weeks)` on completion → `nfl_blind_audit_week_performance` → `COMMIT` (`:891-918`).
   * Any throw: `ROLLBACK`, `runNextBlindAuditWeek` writes `nfl_blind_audit_retries` and rethrows (`:818-827`).
3. **Resume**: purely DB-driven. `next_ordinal` selects the target; the chain prior is read from the last sealed row; `mutationCursor` is a process-local `Map` (`:52`) so a fresh process falls back to the preregistration cursor (`:222-223`) and does a full 31-table rehash. Two concurrent openers are serialised by `BEGIN IMMEDIATE` and the `(run_id,ordinal)` PK — the loser rolls back and logs a retry. Status `failed`/`cancelled` cannot be resumed; there is no un-void path, so a data-hash mismatch is terminal for the run (runs 21–26, 28 died this way; see retries table).

### What is frozen per week
* **Code**: sha256 over content of every tracked+untracked file under `server`, `scripts`, `package.json`, `package-lock.json` (`:71-88`); commit id recorded but not hashed. `.gitignore` covers `server/data.sqlite*` and `*.pre-migration-*.bak` (verified with `git check-ignore`).
* **Data**: per-table sha256 of `SELECT <cols> FROM t <scope> ORDER BY rowid` (`:141-147`). Scopes: season tables `season<=maxSeason`; `news_items`/`nfl_news_signals`/`nfl_line_snapshots`/`nfl_quote_tape`/roster tables by timestamp `< maxSeason+1-03-01`; `players` → `id,name,position,gsis_id WHERE gsis_id IS NOT NULL`; `nfl_teams` → `id,abbr,name,conference,division`; `weekly_ensemble_fits` `through_season<=maxSeason`; **`nfl_ensemble_fit_artifacts` all rows**.
* **`weekly_input`** (`:420-449`): game × 12 specialists + coordinator + combined decision + production pick, with `completeness` (`:451-462`). This is a *record of what the council said before outcomes*, not a frozen input packet in the C11 sense — it is assembled from `expertCouncil` output, which is computed in the same call.
* **`lookback`** (`:520-643`): graded week + cumulative chain (specialists, coordinator weights, betting cumulative, beat-the-close, opener-rule replay). Reads **non-frozen** tables `shadow_decisions` (`:584-585`), `nfl_odds_archive`, `nfl_nfelo_games`, `nfl_external_ratings` (`:485-493`).

### `nfl_blind_input_mutations` (5,057,310 rows, 2026-09-02 → 2026-09-12)
Schema `(id AUTOINCREMENT, table_name, operation, changed_at)` (`nfl-a-to-m.js:157-162`); 93 `AFTER INSERT/UPDATE/DELETE` triggers = 31 tables × 3 (`nfl-a-to-m.js:640-667`; `players` triggers are column/`gsis_id`-gated). It records **that** a frozen table changed, never which row. Purpose: cheap fast-path — `assertFrozen` compares `MAX(id)` against the cursor and skips the full rehash when nothing moved (`:224-225`). Composition: 1.75M `nfl_line_snapshots` inserts and 1.59M `nfl_quote_tape` inserts (the live quote capture), then bulk in-place `update`s on `nfl_depth` (342k), `nfl_snaps` (253k), `game_lines` (209k), `nfl_news_signals` (178k), `players` (120k), `nfl_injuries` (79k). Consequence: while the live server runs the fast path never fires and every week-open does a full rehash — measured cheap (run 32: avg `freeze_check_ms` 1,296 vs `compute_ms` 150,738). The table is never pruned.

### Bets, units, "void"/"fault"
* `bettingWeekResult` (`:264-330`) runs `replaySeason(season,{startWeek:week,endWeek:week,markets:[m]})` **once per market** (spread/total/moneyline), so `maxPicksPerWeek=5` applies per market (documented `:246-262`). Policy `nfl-spread-historical-replay-v1` with `minExpectedReturn:null`, `authority:'diagnostic_only'`.
* Units come from `nfl-replay.js:77-81`: push 0, loss −1, win `price>0 ? price/100 : 100/|price|` at the stored historical price. `roi = units/bets` with pushes in the denominator (`:339`, `:397`).
* "Void" does not exist in the controller's vocabulary; results are only `Won|Lost|Push` (`nfl-replay.js:236,265,299`). `void` is recognised only by the overview (`nfl-audit-overview.js:120`).
* "Fault" = `fault_json`: top-10 player misses, top-10 betting misses, missing reporting cells, `classification: 'outcome-visible fault pass; no model mutation authorized'` (`:880-883`). Descriptive; nothing reads it back into the model (verified: `aggregate` reads `result.player.faults` for a count only, `:352`).
* `aggregate()` (`:351-509`) is the completion summary; `bettingSummary`/`runManifest` (`:511-608`) the manifest.

### Time semantics (verified in callees)
* Ensemble: `fitEnsemble({beforeSeason:season, beforeWeek:week})` (`nfl-ensemble.js:1238`), history filter `season<S OR (season=S AND week<W)` (`:1243`), calibration `train = season < min(evalFrom, beforeSeason)` (`:831-832`, `:1011`), team-week features `week < target` (`:261-262`).
* Council: `kickoffFor` = actual kickoff from `game_lines.gameday/gametime` (`nfl-expert-council.js:451-455`; DB has zero NULL gamedays 2021–26); news/roster/shopping bounded by `before: cutoff`; neural residual training rows `audit_run_id=? AND week<` (`:279-282`); coordinator fit `audit_run_id=? AND actual_residual IS NOT NULL AND week<` (`nfl-expert-coordinator.js:258-260`); forward predictions excluded when `auditRunId` set (`:261-265`); `target:'adjusted'` (reads unfrozen `nfl_game_variance`) is only used by `nfl-specialist-audit.js:110`, not the weekly path (`nfl-expert-council.js:595`).
* Replay market = `game_lines.spread` (close) and stored close prices — a **closing-line replay** by construction; the −2.28 CLV finding is not something this controller can see.

### Defects
| # | Sev | Where | Claim |
|---|---|---|---|
| B1 | P2 | `:485-493`, `:584-585` | Look-back reads four unfrozen tables (`nfl_odds_archive`, `nfl_nfelo_games`, `nfl_external_ratings`, `shadow_decisions`) and their values enter `result_json` → `result_hash` → `chain_hash`. Loading the Pinnacle archive between two runs makes `compareAuditRuns` report "a real forecast, selection-policy, or data change" for every week, while the freeze never noticed. |
| B2 | P2 | `:141-147` (no scope branch for `nfl_ensemble_fit_artifacts`) | `nfl_ensemble_fit_artifacts` is hashed `all_rows`, yet the audit neither reads nor writes it (`nfl-ensemble.js:993-995`, `:1206`). Any live fit persisted by the running server voids the run with no recovery (run 21 retry error names exactly this table). Same false-positive class that killed run 28 on `nfl_teams`. |
| B3 | P2 | `:857-871` vs plan §4.1 | `weekly_input` is a projection of the same in-memory council output, not a persisted exact input packet; nothing verifies the forecast consumed the frozen rows. Plan C11 states the packet requirement; this controller does not meet it and should not be cited as if it did. |
| B4 | P3 | `:453`, `nfl-expert-council.js:453` | Latent: when `gameday` is NULL the cutoff becomes the string `${season}-W${week}-pregame`, which compares lexicographically *after* every ISO timestamp of that year, admitting the whole season's news. Zero NULLs today; unguarded. |
| B5 | P3 | `:157-158` | Silent clamp of `startWeek` to ≥5 / `endWeek` ≤18: a caller asking for weeks 1–4 gets 5–18 with no error, and the overview then says weeks 1–4 are untested. |
| B6 | P3 | `:186`, `routes/nfl-betting.js:398` | `allowDirty` is accepted from the HTTP body; the "clean committed repository" rule is one JSON flag away for any local caller. |
| B7 | P3 | `:923-932`, `:847` | `failBlindAudit` is reachable only from `scripts/nfl-2022-2025-rebuild.mjs:239`; there is no `cancel` function although `cancelled` is a gated status (run 11 is `cancelled` by an unknown writer). Lifecycle states exist without a controlled writer. |
| B8 | P3 | `:481-484` | `aggregate().betting` omits pushes (run 32 final: 550 bets, 207 W, 339 L → 4 pushes invisible); `bettingSummary` in the manifest does include them — two summaries, two vocabularies. |
| B9 | P3 | `:52`, `:222-223` | Process-local `mutationCursor` means the journal fast-path is lost on every restart; harmless today because the live server defeats the fast path anyway (see journal composition). |

### Verdict
Chronologically honest replay controller with strong tamper-evidence (hash chain, in-lock recheck, per-run example isolation). It is a *historical diagnostic*, correctly self-labelled (`:996`). Its weaknesses are freeze *scope* (B1/B2: hashes what it doesn't read, doesn't hash what it does read) and the absence of any 2026 forward path.

## 2. `scripts/nfl-blind-audit.mjs` (33 lines)
CLI: `protocol | preregister | status <id> | next <id> | run <id> [max-weeks]`. `run` loops `runNextBlindAuditWeek` until `complete` (`:21-29`); it does not catch errors, so a freeze violation stops the loop with the retry already logged. `preregister` takes no args, so seasons/label are always the defaults (2021–25, 5–18). No defects beyond inheriting B5/B6. Note the `run` loop calls `blindAuditStatus` (full manifest incl. `sliceDiagnostic`) after every week — heavy but read-only.

## 3. `server/services/audit-registry.js` (333 lines)
Independent preregistration registry (`audit_registry` table): `preregister` locks name/hypothesis/metric/direction/threshold + `codeHash()` + `dataSignature()`; `runAudit` executes a producer once, voids on code change, seals with Šidák-corrected significance and the optional mSPRT gate.

Defects:
| # | Sev | Where | Claim |
|---|---|---|---|
| R1 | P3 | `:46-54` | `codeHash` covers only flat `server/services/*.js`; `server/modeling`, `server/db`, nested dirs and `scripts` are outside it — narrower than the blind-audit freeze and silently so. |
| R2 | P3 | `:62-71`, `:192`, `:237` | `dataSignature` is six row counts; in-place updates are invisible, and drift is merely flagged in `void_reason` while the result is sealed as valid. |
| R3 | P3 | `:197-198` vs `:282-286` | Corrected alpha at run time uses `COUNT(sealed)` at that moment, so the first audit run is judged at 0.05 and later ones tighter; `auditHistory` recomputes with the final n, so a stored `passed=1` can sit next to `survive_correction` excluding it. Order-dependent and inconsistent with the "COUNTED" claim (`:20-24`). |
| R4 | P3 | `:138-145`, `:230` | Status check and seal are not in one transaction; two concurrent `runAudit` calls on the same id can both pass the `preregistered` gate. |
| R5 | P3 | `:170-174` | `require_deterministic` invokes the producer twice with no isolation; a producer with side effects (persisting fits) changes the data it is being checked against. |

Verdict: coherent and honest about the C17 relabelling (`:213-219`); the counting/ordering semantics of the correction are weaker than the header prose.

## 4. `server/services/nfl-audit-overview.js` (272 lines)
`auditOverview(runId)` aggregates picks from `nfl_blind_audit_weeks.result_json.betting.picks` per market with explicit `pushes/voids/unknown_results/missing_units`, reconciles against `by_market` summaries, reports coverage as present/missing week sets, and a spread-only block with the weekly-cluster bootstrap. `compareAuditRuns` diffs `result_hash` per (season,week).

Defects:
| # | Sev | Where | Claim |
|---|---|---|---|
| O1 | P2 | `:116`, `:125`, `:221` → `nfl-replay.js:44,57-58` | Results are lower-cased (`'won'/'lost'/'push'`) then passed to `uncertainty()`, which filters `b.result === 'Won' || 'Lost'`. `settled` and `graded` are always empty: `win_rate_95` is `[0,0]`, `sample_warning` is always "Very small sample", regardless of the 153-bet sample. `roi_95` still works (uses `units`) which is why the run-27 test (`assert.ok(Array.isArray(roi_95))`) passes. |
| O2 | P2 | `:87-91`, `:159-170`, `:205` | Coverage completeness is derived from the observed min–max span; the run's own `spec_json.schedule` is loaded (`:36`) but unused. A run that failed mid-season (e.g. run 28, 22 of 70 weeks) reports every partial season `complete:true` and `coverage_complete:true`. C09 asked for "exact expected/present/valid week sets". |
| O3 | P3 | `:125-126`, `:196`, `:221` | `allBets` stores `units: pick.units ?? 0`; `spread_only.units`, `roi` and the bootstrap therefore treat missing units as zero, the exact substitution the file forbids at `:107-109`. `units_known` is stored and never read. |
| O4 | P3 | `:135` | `roi = units / bets` where `bets` counts picks with `missing_units`/`void`/unknown results but `units` excludes them; the counting test asserts `units === 0.909` for 3 bets but never checks the resulting `roi` 0.303. |
| O5 | P3 | `:238-272` | `compareAuditRuns` is a single full-payload hash diff; C09 asks for artefact / forecast / selection-price / cash-flow differences separately. Combined with B1, any unfrozen look-back input flips every week to "changed". |
| O6 | P3 | `:44-49`, `:71`, `:200` | `weeks_with_fault_log` counts truthy `fault_json`; the controller always writes it (`:900`), so the number equals `weeks_sealed` and carries no information. |

Verdict: the C09 core (pushes, corrupt weeks, zero-bet weeks, interior gaps, unknown/void states, reconciliation) is fixed and tested; the residuals above are exactly the shape C09 warns about — confident output with a silently wrong sub-block (O1) and a completeness flag that cannot see a truncated run (O2).

## 5. Tests
* `test/nfl-blind-audit-team-scope.test.js` (55): temp DB; proves `nfl_teams` coach columns are outside the hash and identity columns inside. Sound.
* `test/blind-audit-lookback.test.js` (102): temp DB; exercises `weeklyInput`, `reportingCompleteness`, `weekLookback` chaining, `dashboardWeekResult`. Sound; does not touch `beat_the_close`/opener replay branches (both swallow errors, `:586`, `:610`).
* `test/audit-overview-counting.test.js` (229): synthetic runs in a temp DB. Covers pushes, zero-bet weeks, interior gaps, corrupt JSON, missing units, void/unknown, reconciliation, metadata-only, case-normalisation, rounding tolerance. **Gaps**: never asserts `roi` with missing units (O4), never asserts `spread_only.uncertainty.win_rate_95` (O1), never tests a run truncated relative to its schedule (O2), never tests `spread_only.units` with null units (O3).
| # | Sev | Where | Claim |
|---|---|---|---|
| T1 | P2 | `test/nfl-audit-overview.test.js:12-13` | Imports `server/db/index.js` **without** `GRIDIRON_DB_PATH`, so it opens the developer's live `server/data.sqlite` as a WAL writer and runs the legacy migration at import (`server/db/index.js:163`) while the production server (PID 56651) is writing. It then hard-codes run 27/31 figures. This is the C06 defect verbatim ("tests import the application's default DB or expect saved audit runs"); the skips only hide it on a clean checkout. |
* `test/audit-registry-always-valid.test.js` (83): temp DB; wiring of both gates. Sound. Note the "noise" case passes only because `alwaysValidPValue` on a null sequence is > corrected alpha with seed 2 — a seed-specific fixture, acceptable but brittle.

## 6. Where week N+1 information could reach week N (answer)
Inside the assigned files: **nowhere I could demonstrate.** Every fit/training read is cut at `week < W` and scoped to the run. The credible routes are outside this controller and are only *frozen*, not *made chronological*, by it:
1. In-place mutated week-keyed tables (`nfl_injuries` 79k updates, `nfl_depth` 342k, `nfl_snaps` 253k, `player_week_usage` 122k in the journal) — a week-N row holds its *latest* value (possibly post-kickoff or post-season correction). C11's revision-history requirement is the fix; the freeze hash guarantees only that the value was the same at preregistration.
2. Season-level or through-season artefacts hashed as inputs: `weekly_ensemble_fits WHERE through_season<=2025` (`:139-140`) and `nfl_pfr_adv`/`nfl_ngs` (season tables). Whether the 2021 replay consumes a fit or aggregate that saw 2022–25 is C04/C07's question; readers of those tables (`weekly-weight-store.js`, `weekly-learning.js`, `nfl-engine-registry.js`) were not in my scope.
3. `nfl_team_week_features` rows for week k<N are filtered by week, but if a row's *content* was computed with later data (feature backfill), the filter is cosmetic (C07).
4. Latent B4 string-cutoff fallback.
5. Cross-run pooling: with `auditRunId` set the coordinator and neural residual read only this run's examples; the *forward* (non-audit) paths pool all runs' examples (`nfl-expert-coordinator.js:254-257`) — chronological but code-version-mixed. Not a blind-audit leak; a production-path caveat.

## 7. Point-in-time guarantees actually provided
* Week ordinal sealed once; `(run_id,ordinal)` PK + `UNIQUE(run_id,season,week)`; hash chain rooted at `spec_hash`.
* Code + 31-table data hash checked before compute and again inside the writer lock before sealing.
* Ensemble fit artefacts neither read nor written during compute.
* Coordinator/neural training limited to this run's own earlier sealed weeks.
* Retries logged; no silent overwrite; `failed`/`cancelled`/`complete` are terminal.
* Byte-identical reproduction demonstrated (runs 27, 31, 32 all 70 weeks; `nfl_weekly_expert_examples` 20,780 rows each).
