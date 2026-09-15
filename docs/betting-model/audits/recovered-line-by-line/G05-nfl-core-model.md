# G05-nfl-core-model — NFL spread/total forecast pipeline, line-by-line audit

Date: 2026-09-11. Reader: G05. Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only).
Files assigned: 26. Files found: 25 (`server/services/nfl-weekly-state.js` does not exist; `test/nfl-weekly-state.test.js` imports `nfl-weekly-feature-store.js`, which is what the name refers to). Every line of every existing file was read: 8,766 lines.

Severity key: P1 wrong money/decision/data-integrity/leakage/security; P2 wrong number or misleading output; P3 hygiene.

---

## 0. Pipeline end to end (the focus questions)

### 0.1 inputs -> features -> components -> blend -> output

1. **Raw ingest**
   - `nfl-pbp.js:syncPbpSeason` streams nflverse play_by_play_{season}.csv.gz and writes one JSON blob per team-week (`nfl_team_week_features`) and per player-week (`nfl_player_week_features`) (`nfl-pbp.js:530-655`).
   - `nfl-advanced.js` pulls NGS, PFR, snap counts, depth charts, injuries into `nfl_ngs/nfl_pfr_adv/nfl_snaps/nfl_depth/nfl_injuries`.
   - `gamescript.js` (not mine) writes `game_lines` — for nflverse seasons `spread` is the closing line; for the live 2026 season `spread` is the last ESPN poll before final (`gamescript.js:120-152`, confirmed by grep). `open_spread/open_total` are populated by `nfl-opening-lines.js` / `odds-archive.js`.
   - `nfelo.js`, `nfl-external-ratings.js`, `nfl-qbr.js`, `nfl-weather*.js`, `nfl-officials.js`, `nfl-coaches.js`, `nfl-formations.js` load side tables that are **not** ensemble inputs (they feed line-move-study, matchup specialists, team cards).

2. **Features for the ensemble** — `nfl-ensemble.js:featureAggregates(season, week)` (`:262-303`) takes `teamWeeks()` rows where `season === target ? week < target : season === target-1`, recency-weighted `0.5 ** (age/12)`. Cutoff-safe by construction.

3. **Components** — `MODELS` array (`nfl-ensemble.js:317-612`): 31 registered, 9 `challengerOnly`. Families: Roster availability (2), Rating systems (6), Efficiency (17), Context (4), Market (2). Every `predict(ctx)` returns `{margin,total}` from home perspective.

4. **Calibration** — `calibrate(all, restMap, evalFrom)` (`:831-895`) fits OLS `b0 + b1*raw` per feature-differential model on `train = season < evalFrom` (2022 live, or `min(evalFrom, beforeSeason)` for replays).

5. **Weights** — `fitEnsemble` (`:997-1214`) walks weeks chronologically, grades each component's margin RMSE on `eligible` (2018+ up to cutoff) and derives `margin_weight = exp(-0.7*RMSE)/Σ` (`:1169,:1174`). A separate residual gate (`:1185-1189`) grants `residual_weight` only when `residual_n>=250 && gain>=0.03 && t<=-1.645`, fit/score split on a complete-week boundary (`completeWeekSplit`, `:731-744`).

6. **Blend** — `ensembleLine` (`:1220-1340`). `blendMode:'raw'` = weighted mean of all non-challenger margins; `blendMode:'market_residual'` = `marketMargin + Σ residual_weight*slope*(model-market)/Σw`, falling back to exactly the market when no component passes the gate (`:1290-1296`). Production consumers (`nfl-auto-picks.js:83`, `nfl-unified-engine.js:39`) use `market_residual`.

7. **Output** — `projected_spread = -margin`, `spread_edge`, `distribution` from `predictiveDistribution` (`:201-259`, `production_eligible:false` at `:250`), `confidence` string, `models[]` with weights.

### 0.2 Where market data enters

- `games()` (`:53-64`) reads `spread AS home_spread, total` from `game_lines` for **completed** games only and hard-codes `NULL AS open_spread, NULL AS open_total` (`:60`). So every fit, every RMSE and every residual coefficient is measured against the **closing** line (nflverse `spread_line` for 2015-2025).
- `market_anchor` (`:597-605`) predicts `-openSpread ?? -spread`; in the fit loop openSpread is always null, so it *is* the close. Its RMSE is therefore the lowest of any component, and `exp(-0.7*RMSE)` makes it (with `market_regression`, `:606-612`, `reg = marketRegression(hist)` `:678-687`) dominate the raw blend. Memory's "model ≈ 0.68 + 0.632·market" is not a hard-coded constant anywhere — it is the empirically measured consequence of this weighting. Confirmed: **the raw blend is a shrinkage of the close, and the market_residual blend is the close unless a component clears the gate.**
- `market_regression` regresses actual margin on `-spread` over `hist` only (strictly earlier games) — no lookahead in the coefficient itself.
- Live path difference: `ensembleLine` reads `CASE WHEN team_score IS NULL THEN open_spread END AS open_spread` (`:1247`), so for an **unplayed** game `market_anchor` switches to the opener while its weight was learned against the close. See D-01.

### 0.3 Lookahead audit — does any feature for week N read week ≥ N?

| Path | Verdict | Evidence |
|---|---|---|
| `featureAggregates` | safe | `:269` `t.week < week` / prior season |
| `scheduleFaced` | safe (C04 fixed) | `:713-716` same window as featureAggregates |
| `teamAggregates/massey/colley/melo/dynamicStrength` | safe | all built from `hist = season<S or week<W` (`:1053`, `:1243`) |
| `marketRegression(hist)` | safe | `:797` uses hist only |
| `availabilityDeficit(g.season, g.week)` | not in scope (nfl-availability.js) | called at `:797` |
| `rosterStrengthWeek` | **current-season overlay leaks** | see D-04 |
| **`calibrate` slopes reused for 2018-2021 weight grading** | **in-sample** | see D-02 |
| `nfl-features.js:gameContext` | target-week `temp/wind/roof/spread` from `game_lines` — pregame-legal quotes, but for historical games `temp/wind` are observed-not-forecast | P3 note |
| `nfl-features.js:adjustedFeatures.sos_remaining` | `week>=?` = schedule only, legal | `:441-443` |
| `nfl-gbm.js:priorMean` | safe | `:173-181` `x.week < week`, prior season fallback |
| `nfl-gbm.js` weather fallback to `nfl_game_weather` | archive = observed post-hoc for historical, forecast row for live; not a result leak | `:190-201` |
| `nfl-weekly-feature-store.js` | safe | every query `season<? OR (season=? AND week<?)` |
| `nfl-spread-context.js` | safe | every query `week < ?` |
| `nfl-qbr.js:teamQbrProfile` | safe | `:55` |
| `nfl-opponent.js:opponentEfficiency` | safe | prior seasons only `:56-59` |
| `nfl-scheme.js:schemeChange` | **full-season read** | `:57` reads all weeks of `season`; see D-03 |
| `nfl-preseason-blend.js` | safe | `:277-283` `week<?`, calibration `asOfSeason` guard `:262-266` |

### 0.4 Bayesian prior weighting (Codex M01) — verified at the line

`nfl-preseason-blend.js:321`:
```
const weightOnPrior = perGameVariance / (perGameVariance + gamesPlayed * priorVariance);
```
This is the correct normal-normal posterior weight on the prior mean, `σ²/(σ²+n·τ²)`. Posterior variance at `:323` `1/(1/τ² + n/σ²)` is also correct. The monotonicity is right: more games or a less trustworthy prior lowers the weight; noisier single games raise it. **M01 fix confirmed.** Note the module is imported only by tests (see §orphans) so the fix has no production consumer.

---

## 1. Per-file sections

### server/services/nfl-ensemble.js — 1423 lines, ACTIVE (core)
**Purpose.** 31 component models, walk-forward calibration and weighting, blend, predictive distribution.
**Key functions.** `games`, `massey`, `colley`, `solve`, `teamAggregates`, `dynamicStrength`, `predictiveDistribution`, `featureAggregates`, `MODELS`, `diffModel`, `meloRatings`, `marketRegression`, `scheduleFaced`, `completeWeekSplit`, `sharedContext`, `buildContext`, `calibrate`, `rawDifferentials`, `fitEnsemble`, `ensembleLine`, `ensembleWeek`, `challengerSignalWeek`, `modelCatalog`, `featureContracts`.
**Reads.** `game_lines`, `nfl_team_week_features` (via nfl-pbp), `nfl_ensemble_fit_artifacts`; injury/roster via nfl-availability, nfl-roster-strength, nfl-player-value.
**Writes.** `nfl_ensemble_fit_artifacts` (`:1207-1212`), `DELETE` in `clearEnsembleCache` (`:942`).
**Imported by.** nfl-betting route, nfl-unified-engine, nfl-auto-picks, nfl-expert-council, nfl-replay, nfl-research, nfl-blind-audit, nfl-engine-backfill, decision-basis, nfl-family-contribution, nfl-model-growth, nfl-online-neural, nfl-neural-replay, 7 tests.

**Defects.**

- **D-01 (P2) Live `market_anchor` uses the opener but is weighted as the close.** `nfl-ensemble.js:60` `NULL AS open_spread, NULL AS open_total` in `games()` means every historical grading of `market_anchor` is against the close; `:1247` `CASE WHEN team_score IS NULL THEN open_spread END AS open_spread` swaps in the opener only for live games; `:601` `margin: c.openSpread != null ? -c.openSpread : c.spread != null ? -c.spread : null`. The component's live number is a different quantity than the one its `margin_weight` and `residual_slope` were fit on. Given memory's finding that the opener path has no CLV for this model, this silently injects the opener into the raw blend for live weeks. Fix: either grade with `open_spread` too (COALESCE in `games()`) or drop the opener branch and let `market_anchor` be the current quote in both paths. Also the note at `:600` ("the number the books opened") is false in every fit.

- **D-02 (P2) Calibration slopes are in-sample for the 2018-2021 portion of weight fitting.** `:832` `const train = all.filter(g => g.season < evalFrom)` (2022 live) fits `cal` on 2015-2021; `:1026` `eligible = all.filter(g => g.season >= WEIGHT_FIT_FROM(2018) && ...)`; `:1059` `const base = { ...buildContext(slate[0], hist, restMap), cal }` applies those slopes when grading 2018-2021 games whose actual margins were in the fit. `margin_rmse` for the 15 calibrated components is therefore optimistic on ~half the weight-fit window relative to `market_anchor`, which needs no calibration. Docstring at `:827-829` ("no game used to fit a slope is ever also used to grade it") is false for the weight fit. Magnitude is small (2-parameter OLS on >1000 rows) but it is the exact class of leak C07 was meant to close ("one feature calibration fitted through a later cutoff is reused inside earlier historical forecasts" — plan `docs/CLAUDE-NEXT-STEPS.md:232`), and the status register marks C07 `tested`. Fix: `WEIGHT_FIT_FROM = evalFrom`, or refit `cal` per week on `hist`.

- **D-06 (P3) `dynamicStrength` tracks `error2` that nothing reads.** `:168,:179,:193-194` maintain `error2`; no consumer (`dynamic_state` predict at `:386-393` ignores it). Dead state.

- **D-07 (P3) `hfa` derivation is written confusingly.** `:790` `hfa: 2 * (avg(hist.map(x => (x.home_score - x.away_score) / 2)) ?? 1.1)` is just the mean home margin over all of hist (2015 onward), not a season-decayed HFA; the `2*(…/2)` is a no-op. HFA has drifted ~2.5 -> ~1.5 since 2015, so a flat 11-season mean overstates 2026 HFA in every Rating/Efficiency/Context component. Cheap improvement: recency weight.

- **D-08 (P3) `teamWeeks()` full-table parse per call.** `featureAggregates` (`:269`) calls `teamWeeks()` with no filter; `nfl-pbp.js:657-665` `SELECT * ... JSON.parse` every row (5,000+ blobs) each time the cache misses. Same in `nfl-features.js:463` and `nfl-pregame.js:30`.

**Non-defects worth recording.** `completeWeekSplit` (`:731-744`) is correct. `scheduleFaced` window matches `featureAggregates` (`:713-716`). `predictiveDistribution` derives cover and win probabilities from one margin sample so they cannot disagree (`:220-228`). `withEphemeralEnsembleArtifacts` correctly disables persistence and clears caches on both sides (`:952-963`). The fingerprint (`:965-973`) includes feature bytes so a re-sync invalidates the artifact.

**Verdict.** Structurally sound walk-forward with two remaining chronology defects (D-01, D-02) that the plan's C07 language already asks for.

### server/services/nfl-features.js — 514 lines, ACTIVE
**Purpose.** Variable catalog (`catalog`, `countVariables`), betting-trend features, game context, rolling form, opponent-adjusted EPA, `teamFeatureVector`, `playerFeatureVector`.
**Reads.** `game_lines`, `nfl_team_week_features`, `nfl_player_week_features`, `players/roster_players/nfl_teams`.
**Imported by.** nfl-betting route, betting-hub route, page-explain-tools, nfl-reasoning, nfl-ai-replay, nfl-context-heads.
**Defects.**
- **D-09 (P3) N+1 query in `gameContext`.** `:353-357` runs one `SELECT roof,temp,wind FROM game_lines` per prior week inside `hist.map`. Up to 17 queries per team per call; `teamFeatureVector` calls it for every team.
- **D-10 (P3) `playerFeatureVector` hard-codes `|| 2026`** at `:506` as the NFL_SEASON fallback (same pattern `nfl-team-tendencies.js:24`); will silently be wrong in 2027.
- **Note (P3).** `gameContext` `:359-375` returns the target game's `temp/wind` from `game_lines`; for historical games those are observed conditions, so any replay that consumes `is_windy/is_cold` sees post-kickoff weather. Not a result leak; label it.
**Verdict.** Cutoff rules hold (`week < week` everywhere, `sos_remaining` schedule-only at `:441`). Acceptable.

### server/services/nfl-team-strength.js — 480 lines, ORPHANED (test-only)
**Purpose.** Team aggregates of offseason engines as a GBM challenger feature block + walk-forward harness + gate recording.
**Imported by.** `test/nfl-team-strength.test.js` only. Imports nfl-gbm, offseason-model, preseason-model, backtest-significance, team-codes, model-governance.
**Notes.** Deliberately unwired ("contract starts blocked"). `leaguePrior` returns 0 for empty columns (`:203`), which differences to 0 — documented. `qbProjectedPpg(season-1)` for prior QB is cutoff-safe. No defects beyond being a research harness with no route. Disposition: keep (documented negative result), but it is dead weight in `server/services`.

### server/services/nfl-gbm.js — 321 lines, ACTIVE
**Purpose.** Hand-rolled GBM on the market residual; `buildGbmDataset`, `fitGbm`, `predictGbm`, `gbmWalkForward`.
**Imported by.** nfl-betting route, offseason-model, nfl-expert-council, nfl-team-strength, boom-bust, 2 tests.
**Defects.**
- **D-11 (P3) `includeUnsettled` rows push `y = null`** (`:221`) and `fitGbm` does `y.map((v,i) => v - preds[i])` (`:99`) — NaN residuals if a caller ever trains on them. `gbmWalkForward` never sets the flag, but the seam is unguarded.
- **Note.** The 7 situational columns include `spread` and `total` (`:207`) — the close for historical rows, the live line for 2026 rows. Documented at `:205-206`.
**Verdict.** Good; the residual target is the right choice and the walk-forward is clean.

### server/services/nfl-preseason-blend.js — 410 lines, ORPHANED (test-only)
**Purpose.** Normal-normal blend of prior-season margin with in-season margin; `calibratePreseasonBlend`, `blendedTeamRating`, `teamChurnMultiplier`, `preseasonBlendGbmFeature(s)`.
**Imported by.** `test/preseason-blend-cutoff.test.js`, `test/nfl-preseason-blend.test.js` only.
**Verified.** M01 formula correct at `:321` (see §0.4). C10 fallback is prespecified (`:170-176`) and later `asOfSeason` throws (`:262-266`).
**Defects.**
- **D-12 (P3) Module-level DB query at import.** `:135` `const CALIBRATED = calibratePreseasonBlend();` runs two `game_lines` scans whenever the module loads (tests today; any future importer pays it at boot). Move behind a lazy getter.
- **D-13 (P3) `teamChurnMultiplier` reads `player_team_changes.detected_at`** (`:222-225`) — detection time, not effective time, so a batch import would collapse an offseason's churn into one day and could fall under the `counts.length < 8` guard (`:226`). Only matters once roster tracking has history.
**Verdict.** Correct math, honest negative walk-forward result recorded at `:380-410`, no production consumer.

### server/services/nfl-opponent.js — 154 lines, ACTIVE (route only)
**Purpose.** Defense-vs-position efficiency multiplier (prior seasons) + standalone validation.
**Imported by.** nfl-betting route.
**Defects.**
- **D-14 (P3) `fitThrough` parameter is dead.** `:100` accepts `fitThrough = 2024`, `:150` echoes it, but every multiplier is built with `opponentEfficiencyMult(metricKey, testSeason, ...)` (`:137`) i.e. `throughSeason = testSeason`. The reported `fit_through` is not what was used (they coincide only because `testSeason-1 === fitThrough` by default).
**Verdict.** Acceptable; research-only.

### server/services/nfl-roster-strength.js — 424 lines, ACTIVE (challenger component + team card)
**Purpose.** Depth-chart-ranked roster strength per team-week; `teamRosterStrength`, `rosterStrengthWeek`, PFF import/sync.
**Reads.** `nfl_depth`, `nfl_snaps`, `nfl_player_week_features`, `nfl_external_player_grades`, `nfl_rookie_evidence`, `player_accolades`, `nfl_player_roster_events`, `player_team_changes`, `players/nfl_teams`.
**Writes.** `nfl_external_player_grades` (`:398-405`).
**Imported by.** nfl-ensemble (`roster_strength`, challengerOnly), nfl-betting route, nfl-team-card, nfl-expert-council, schema manifests, 4 tests.
**Defects.**
- **D-04 (P2) Current-season depth is overlaid with the live roster regardless of the requested week.** `:97` `if (season === currentSeason) {` replaces every position group with `players` joined to `nfl_teams` (`:98-111`, `captured: 'current_local_roster_snapshot'`), and `:118` lets that snapshot win deduplication. `rookieProfiles` does the same at `:172`. Any 2026 replay/backfill of an earlier week (e.g. Week 1 re-run after Week 4 trades or injuries) sees today's roster, contradicting `cutoff_policy` at `:373`. The component is `challengerOnly` so it has zero production weight today, but `challengerSignalWeek` and `includeChallengers` audits for 2026 weeks are contaminated. Fix: only apply the overlay when `week >= currentWeek`, or stamp the snapshot with `fetched_at` and filter by `gameCutoff`.
- **D-05 (P3) `scheme_change` reported in `preseason_context` reads the full current season** (`:363` -> `nfl-scheme.js:57`). Reporting-only (not in `roster_score`), but a Week 3 card shows a "changed" flag derived from Weeks 1-18.
- **Note.** `reliability` at `:305` parses as `(external || sample>=8) ? 'higher' : ...` — matches intent.
**Verdict.** Acceptable for the historical path; the current-season overlay is the one real chronology hole.

### server/services/nfl-external-ratings.js — 277 lines, ACTIVE
**Purpose.** ESPN FPI + TeamRankings snapshots into `nfl_external_ratings`; `externalRatingsFeatures`.
**Imported by.** nfl-market route, scheduler, beat-the-close, line-move-study, nfl-matchup-specialists, schema manifests, 1 test.
**Notes.** FPI has no history so only current-week rows are honest (`:105-118`); TeamRankings uses `?date=` Wednesday snapshots and refuses when the page echoes a different date (`:200-203`). `wednesdayOf` (`:164-169`) correct. No defects. Not a model input.

### server/services/nfelo.js — 312 lines, ACTIVE
**Purpose.** greerreNFL CSVs -> `nfl_nfelo_qb/games/lines`, `nfl_stadiums`; `nfeloFeatures`.
**Imported by.** nfl-market route, scheduler, beat-the-close, line-move-study, nfl-matchup-specialists, schema manifests, 1 test.
**Notes.** `parseGameId` canonicalises OAK/LA (`:86-90`). `nfeloFeatures` (`:262-290`) flips sign when the QB row is stored away-first — correct. `home_line_close` from nfelo_games is a **closing** number; anything that consumes it as a pregame feature for a completed game is reading the close — the readers are outside my scope (line-move-study). No defects.

### server/services/nfl-weekly-feature-store.js — 403 lines, ACTIVE
**Purpose.** Frozen high-dimensional team/player vectors (13 transforms per metric) in `nfl_team_feature_vectors`/`nfl_player_feature_vectors` + `nfl_feature_dictionary`.
**Imported by.** nfl-betting route, nfl-team-card, nfl-model-growth, nfl-feature-coverage, rebuild script, schema manifests, `test/nfl-weekly-state.test.js`.
**Notes.** Every history query is `season>=TRUSTED_HISTORY_START AND (season<? OR (season=? AND week<?))` — cutoff-safe. `ewma` walks oldest->newest correctly (`:69-74`); `slope` receives chronological order (`:96`). `evidence_hash` covers cutoff+history (`:167`).
**Defects.**
- **D-15 (P3) `freeze*` early-return omits `missing`.** `:196` and `:288` return `{existing:true, ...existing, vector}` without parsing `missing_json`, whereas `getFrozen*` (`:206,:298`) do. Callers that read `.missing` off a fresh freeze get `undefined`.
**Verdict.** Good.

### server/services/nfl-pbp.js — 683 lines, ACTIVE (data substrate)
**Purpose.** Streaming nflverse PBP ingest -> team-week and player-week feature blobs; `teamWeeks`, `playerWeeks`, `pbpCoverage`.
**Writes.** `nfl_team_week_features`, `nfl_player_week_features`.
**Imported by.** 20+ services (ensemble, features, opponent, props, roster-strength, reasoning, model-growth, etc.).
**Defects.**
- **D-16 (P2) Team pass "attempts" include sacks.** `:274` `side.att++` runs for every `play_type === 'pass'` play, and nflverse files sacks as `pass`. The player path handles it (`:346-349` `if sack p.sacks++ else p.att++`) but the team path does not. Consequences: `off/def_completion_pct` (`:443`), `explosive_pass_rate` (`:438`), `int_rate` (`:453`), `adot` (`:445`), `deep_attempt_rate` (`:447`) are all divided by attempts+sacks, so they are biased low by the sack rate (~6-8%), and unevenly across teams (a team sacked 50 times vs 20 times gets a different denominator). `off_explosive_pass_rate` feeds the challenger `explosive_pass` component in the ensemble (`nfl-ensemble.js:427-430`) and the catalog describes it as "share of attempts" (`nfl-features.js:35`). Fix: `if (num(rec,'sack') !== 1) side.att++`.
- **D-17 (P3) Penalty double-count.** `:301` `if (num(rec,'penalty') === 1) side.penalties++` inside the `for (const side of [o, d])` loop credits both offense and defense with every penalty on a scrimmage play; `off_penalty_count` and `def_penalty_count` are identical per team-week (plus no-play penalties only on offense, `:224-226`).
**Verdict.** Solid ingest; D-16 is a real metric-definition bug that propagates into the catalog and one challenger.

### server/services/nfl-espn-pbp.js — 638 lines, ACTIVE (live)
**Purpose.** ESPN summary plays -> `nfl_play_by_play`; live state; simulator validation (`playDistributionAudit`, `liveModelValidation`, `liveRemainderValidation`); `backfillSeasons`; `formationReport`.
**Imported by.** nfl-betting route, scheduler, schema manifests.
**Defects.**
- **D-18 (P3) Unused `ece`.** `:557` computes `ece` then `:558` computes `weightedEce`, and only the latter is used. Dead variable.
- **D-19 (P3) Preseason guard only in `pollLiveGames`.** `:238-243` refuses `season.type !== 2`, but `ingestCompleted` (`:265-281`) has no such guard, so an August call to `/pbp/ingest` re-creates the exact "332 preseason plays stored as Week 4" problem the guard fixed.
**Verdict.** Acceptable; validation logic (Brier vs base-rate baseline, calibration buckets) is correct.

### server/services/nfl-advanced.js — 476 lines, ACTIVE
**Purpose.** NGS/PFR/snaps/depth/injuries sync; `rolesFor`, `roleTimeline`, `reconcileHistoricalTeamCodes`.
**Imported by.** 12 services/routes + rebuild script + tests.
**Notes.** Depth-chart `captured` for pre-2025 archives is midnight on gameday (`:273-283`); `weekFromDate` maps 2025+ snapshots to the next unkicked week (`:290-303`). `ON CONFLICT ... WHERE excluded.captured >= nfl_depth.captured` keeps the latest snapshot. `reconcileHistoricalTeamCodes` uses `UPDATE OR IGNORE` (`:398`) so a UNIQUE collision (e.g. an OAK and an LV row for the same week) is silently skipped rather than reported. P3 note only. No defects.

### server/services/nfl-qbr.js — 101 lines, ACTIVE
**Purpose.** ESPN weekly QBR -> `nfl_qbr_weekly`; `teamQbrProfile`, `qbrTrailingForPlayer`.
**Imported by.** scheduler, line-move-study, nfl-matchup-specialists, projections, analyze script, schema manifests, 1 test.
**Notes.** `:55` cutoff `(season=? AND week<?) OR season=season-1` — correct. `qbrTrailingForPlayer` `week<=throughWeek` is inclusive by design (matches projections.js). No defects.

### server/services/nfl-weather.js — 137 lines, ACTIVE
**Purpose.** Open-Meteo archive/forecast -> `nfl_game_weather`.
**Imported by.** scheduler, beat-the-close, line-move-study, nfl-weather-history, schema manifests, 2 tests.
**Notes.** Archive rows only block re-fetch (`:57-58`); forecast rows are overwritten hourly and replaced by archive after kickoff. `STADIUMS` marks LAC/LAR/ARI/… indoor (`:15-27`). Hard-coded coordinates for "current venues" will silently be wrong for any relocation. No defects.

### server/services/nfl-weather-history.js — 133 lines, ACTIVE
**Purpose.** Previous-runs API forecast leads (0/1/2/3/5 days) -> `nfl_game_weather_forecast_history`.
**Imported by.** nfl-market route, scheduler, line-move-study, schema manifests, 1 test.
**Notes.** `outdoorGames` is duplicated from nfl-weather.js (`:29-35`, acknowledged). No defects.

### server/services/nfl-officials.js — 213 lines, ACTIVE
**Purpose.** nflverse officials -> `nfl_officials`; `refereeTotals` with Šidák-corrected z threshold.
**Imported by.** nfl-betting route, schema manifests, 1 test.
**Notes.** Join is exact on home/away (`:119-127`). `inverseNormal` is Acklam's approximation, adequate. `splitCsv` (`:30-39`) does not handle escaped quotes but the officials file has none. No defects.

### server/services/nfl-coaches.js — 121 lines, ACTIVE
**Purpose.** nfldata games.csv -> `nfl_team_coaches` (primary HC per team-season); `coachChanges`.
**Imported by.** boom-bust, football-context, nfl-roster-strength, nfl-betting route, model route, scheduler, schema manifests.
**Notes.** Team codes are stored raw from nfldata (`:71-77`, no `canonicalTeamCode`), so `LA` (Rams 2016-2019 in nfldata) vs `LAR` could split; `coachChanges` compares by team key so a code change between seasons reads as "no prior coach" (`:106`) rather than a false change. P3 note.

### server/services/nfl-formations.js — 224 lines, ACTIVE
**Purpose.** pbp_participation + ftn_charting -> `nfl_play_formations`, `nfl_play_charting`; distributions.
**Imported by.** nfl-betting route, nfl-model-growth, rebuild script, schema manifests.
**Notes.** `ON CONFLICT DO NOTHING` (`:71,:110`) means a corrected upstream file never overwrites. `possession_team` stored raw (`:83`), reconciled later by `nfl-advanced.js:reconcileHistoricalTeamCodes`. No defects.

### server/services/nfl-scheme.js — 254 lines, ACTIVE (route + roster card)
**Purpose.** Scheme identity from team-week features; `schemeChange`, `schemeArchetypes`, `measureSchemeChangeEffect`, `validateSchemeAdjustment`.
**Imported by.** nfl-betting route, nfl-roster-strength.
**Defects.**
- **D-03 (P2) `validateSchemeAdjustment` grades on a flag computed from the test season's own full-season features.** `:223` `const changes = allSchemeChanges(testSeason);` -> `schemeChange(team, testSeason)` -> `seasonProfiles(testSeason)` -> `:57` `SELECT team, features FROM nfl_team_week_features WHERE season = ?` (all 18 weeks). The `changed` flag that decides whether `factor` is applied (`:240`) is therefore derived from the same games whose usage is being predicted. The note at `:251-252` ("the adjustment never sees the games it is graded on") is false: the factor does not, the gate does. The same full-season read makes `schemeChange` unusable as an in-season feature (only `schemeArchetypes(season-1)` is honestly cutoff-safe, as `:133-140` says). Fix: build the test-season profile from `week < throughWeek` or from a declared preseason window.
**Verdict.** Research-only; the validation claim is unsafe as written.

### server/services/nfl-team-tendencies.js — 181 lines, ACTIVE (teams route)
**Purpose.** Percentile tendencies vs league for the X's & O's page.
**Imported by.** routes/teams.js.
**Notes.** Full-season read is appropriate for a descriptive page; labels prior-season fallback (`:105-110`). `|| 2026` at `:24` (see D-10). No defects.

### server/services/nfl-spread-context.js — 365 lines, ACTIVE
**Purpose.** ATS profile, efficiency-record gap, game context, `spreadContext`, `fantasyContext`.
**Imported by.** nfl-betting route, lineup-brain, football-first, pick-reasoning.
**Notes.** Every history query is `week < ?` (`:63,:130,:189`). `gameContext` returns shape-stable nulls (`:214-220`). `fantasyContext` returns flags not multipliers (`:361-363`) — correct given game-script already prices the line. No defects.

### server/services/nfl-pregame.js — 90 lines, ACTIVE
**Purpose.** Forward-shadow pregame snapshots -> `nfl_pregame_snapshot_history`.
**Imported by.** nfl-betting route, nfl-auto-picks, scheduler, nfl-research, nfl-player-value, evidence-daemon, schema manifests, 1 test.
**Notes.** Reads live `roster_players` (`:16-18`) — correct for a *forward* snapshot; filters rows fetched after capture. `teamWeeks()` full parse at `:30` (D-08). `production_eligible: false` (`:60`). No defects.

### server/services/nflverse.js — 332 lines, ACTIVE
**Purpose.** players.csv crosswalk (`syncCrosswalk`), `stats_player_week` usage, snap counts, `parseCsv`.
**Imported by.** 15+ services, routes, scripts, tests.
**Notes.** gsis uniqueness enforced (`:186-188`). `syncSnapCounts` name+position match (`:278-281`) is the documented fallback. No defects.

### server/services/team-codes.js — 100 lines, ACTIVE
**Purpose.** Canonical team-code map and name resolver.
**Imported by.** 25+ files.
**Notes.** `_resolver` cache never invalidates on `nfl_teams` change except via `clearTeamResolverCache`. Containment fallback (`:82-83`) could match "Giants" in "New York Giants" only — unique, fine. No defects.

### server/services/nfl-weekly-state.js — MISSING
Does not exist. `test/nfl-weekly-state.test.js:11` imports `nfl-weekly-feature-store.js` plus `nfl-quote-tape.js`, `nfl-sim-learn.js`, `nfl-orthogonal-specialists.js`. The assigned name is stale; treat `nfl-weekly-feature-store.js` as the file meant.

---

## 2. Wiring summary

- `nfl-pbp.js` -> `nfl_team_week_features` -> `nfl-ensemble.js:featureAggregates` (via `teamWeeks`) and `nfl-features.js`, `nfl-gbm.js`, `nfl-weekly-feature-store.js`, `nfl-scheme.js`, `nfl-team-tendencies.js`, `nfl-spread-context.js`.
- `game_lines` (gamescript.js, out of scope) -> `nfl-ensemble.js:games()` (completed, close) and `ensembleLine` (live row, open+current).
- `nfl-roster-strength.js` -> `nfl-ensemble.js:sharedContext.roster` (challengerOnly component) and `nfl-team-card.js`.
- `nfl-ensemble.js:ensembleLine/ensembleWeek` -> `nfl-auto-picks.js` (market_residual), `nfl-unified-engine.js` (market_residual), council, replay, blind audit, online-neural, backfill, betting route.
- `nfl-gbm.js` <- `nfl-team-strength.js` (test-only) and `nfl-preseason-blend.js` (test-only) via `extraFeatures` injection.
- `nfelo.js`, `nfl-external-ratings.js`, `nfl-qbr.js`, `nfl-weather*.js`, `nfl-officials.js`, `nfl-coaches.js`, `nfl-formations.js` -> side tables consumed by line-move-study, beat-the-close, matchup specialists, team cards, routes. None reach the ensemble blend.

## 3. Dead / duplicate / orphaned

| Path | Disposition | Reason |
|---|---|---|
| server/services/nfl-team-strength.js | keep (archive candidate) | Test-only import; documented blocked contract and negative gate result. Move to research/ or docs evidence if `server/services` is meant to be production-only. |
| server/services/nfl-preseason-blend.js | keep (archive candidate) | Test-only import; documented negative walk-forward; M01/C10 fixes verified but unconsumed. |
| server/services/nfl-weekly-state.js | n/a | Does not exist; stale name in the task list. |
| nfl-weather-history.js `outdoorGames` | merge | Duplicate of nfl-weather.js `:29-34`; export one. |
| nfl-espn-pbp.js `:557` `ece` | delete | Unused variable. |
| nfl-ensemble.js `dynamicStrength.error2` | delete | Unused state. |

## 4. Open questions

1. Is `game_lines.spread` for 2026 rows the close or the last poll? `gamescript.js:141-152` freezes `closing_spread` separately; `nfl-ensemble.js` reads `spread`, so once 2026 games settle the ensemble's "close" for those rows is ESPN's last pre-final quote, not `closing_spread`. Cross-reader on gamescript should confirm which column the ensemble ought to use.
2. Does `availabilityDeficit` (nfl-availability.js) obey `week < week`? Out of my file set but it is a live production component with real weight.
3. The status register marks C07 `tested` on the residual split alone; D-02 (calibration in-sample for 2018-2021 weight fit) is the "upstream leakage" C07's text explicitly names. Should the register row be reopened or a new correction filed?
4. `nfl-scheme.js:schemeChange` is surfaced on the roster card for the live season — is anyone reading `preseason_context.scheme_change` for a decision?
