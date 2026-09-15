# G06 — NFL expert council, specialists, research and learning lab

Reader: G06-nfl-council-research. Date: 2026-09-11 (NFL Week 1 weekend; SF@LAR and NE@SEA already final).
Repo: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard (read-only). 24 files, 7,224 lines, every line read
(`wc -l` totals matched per file; big files read in `sed -n` chunks with contiguous ranges).

DB facts below came from `node:sqlite { readOnly: true }` one-liners against `server/data.sqlite`; no .bak file was opened,
no process was touched, no paid API was called.

## 0. Headline answers to the focus questions

**The council is 19 roles, not 16.** `NFL_EXPERTS` (nfl-expert-council.js:31-51) has 12 original roles + 5 matchup
candidates (`trench_continuity`, `tendency_matchup`, `situational_efficiency`, `pressure_matchup`, `qb_state`) + 2 external
line roles (`nfelo_line`, `teamrankings_line`). A `coordinator` row and a `combined_decision` row are appended on each
forward capture (council.js:651-682), so a fully captured game writes 21 rows per horizon.

**The coordinator zeroes every role — confirmed from the live DB.** The most recent `coordinator` row
(2026 W1, LAR, horizon T-15m, captured 2026-09-11T00:25:44Z) has `training_games: 1039, training_weeks: 70,
active_weight_l1: 0`, and all 19 contributions carry `shrink: 0` (`"shrunk to zero: no walk-forward gain"` for 16 roles,
`"fewer than 60 settled forecasts"` for `live_updater`, `price_shopper`, `player_opportunity`). The forecast that survives is
`fit.coefficients[0] + 0 + missingOffset` (coordinator.js:412) — i.e. intercept plus the learned coefficient on *which
roles were missing*. That is why every 2026 W1 `combined_decision` is exactly `-0.075` or `+0.047`: the only thing that
differs game to game is the missingness pattern (news_reaction / nfelo / teamrankings present or absent).

**Nothing in this group is on the money/decision path.** `grep` of nfl-auto-picks.js, nfl-policy.js, forward-ledger.js,
shadow-ledger.js and nfl-ensemble.js for `expertCouncilGame|coordinator|combined_decision|council` returns nothing.
The council's only readers are `nfl-unified-engine.js:82` (attaches `expert_council` as a *head* in the unified
projection payload), `page-explain-tools.js:100` (explanation tool), `nfl-diagnostic.js`, `nfl-profitability.js`
(status), the blind audit (`nfl-blind-audit.js:855,898`), and the scheduler/evidence-daemon capture jobs. It is
100% shadow. The forward trace even reads the *production* selection from `nfl_pick_decisions` (council.js:667-669)
and stamps `stake_units: 0` (council.js:671).

**Two latent live-path hooks exist, both currently inert:**
1. `nfl-online-neural.js` → `onlineNeuralPrediction().production_eligible` is consumed by `nfl-auto-picks.js:104-108`,
   which *replaces the ensemble's projected margin with the neural head's* when that self-computed gate is true. Today
   there are 0 artifacts under the active epoch (epoch 3, created 2026-09-09 after Nick's reset), 128 captured / 14 settled /
   0 trained examples, so the head is the cold-start network whose output layer is all zeros (`w2: Array(HIDDEN).fill(0)`,
   online-neural.js:59) and `production_eligible` is false. See D4.
2. `nfl-model-growth.js` (scheduler job) refits the production ensemble (`fitEnsemble`, growth.js:224) after each
   finalized week and records `nfl_ensemble_fit_artifacts`, which the live ensemble reads. That is the one genuine
   live-path write in this group, and it is intended.

**Claude (paid) is called by exactly one file in this group:** `nfl-ai-replay.js` (`callClaude`, ai-replay.js:342),
model `claude-haiku-4-5-20251001`, only via `POST` → `startAiBlindReplay` (route nfl-betting.js:756), hard-capped at
$1 per run (ai-replay.js:377) and forked to a detached worker. `ai_usage` shows feature `nfl_blind_replay_gate`: 203
calls, 635k in / 36.5k out tokens (≈ $0.82 total), last 2026-08-24; the `nfl_ai_replay_runs` table is currently empty.
None of the council, coordinator, specialist, team-card, neural, risk-lab, growth, watch or research files import
`claude.js`. `nfl-unified-engine.js` imports `ask` from `gridiron-model.js`, which is the capability-authority registry
(gridiron-model.js:483), not an API call.

**Historical evidence, latest audit run (#32, 1,039 games, 70 weeks, 2021-2025):** directional rates per role are
0.477-0.526 (`qb_state` 0.526 is the max; `coordinator` 0.496). No role clears 52.38%. This matches the settled memory
note (no spread edge vs the close) and the specialist audit's own finding text (specialist-audit.js:98).

## 1. Per-file sections

### server/services/nfl-expert-council.js (867 lines) — active, shadow
**Purpose.** Builds every role's market-residual opinion per game (`gameExperts`, 457-582), runs the historical weekly
audit (`weeklyExpertAudit`, 584-628), freezes forward rows before kickoff (`captureForwardExpertWeek`, 631-697),
settles them (`settleForwardExpertPredictions`, 700-719), persists audit rows (`persistWeeklyExpertAudit`, 721-756),
and serves status/game views (`expertCouncilStatus` 766-838, `expertCouncilGame` 840-864).

**What each role computes (gameExperts):**
| role | source | notes |
|---|---|---|
| rulebook | median residual of `elo, melo, point_diff, pythagorean, recent_form, rest_travel` ensemble members (467-469, 501) | |
| player_builder | `matchupTeamCards` roster score → `1.5 + Δroster*0.32 - market` plus `gamePlayerAvailability.shadow_margin_adjustment` + `gameInjuryCarryover` (490-500, 503-511) | reads frozen team card (see D3) |
| game_replay | `simulateMatchup` 160 trials, seeded by council version (479-483, 512-524) | scored on margin/total MAE + 80% interval |
| similar_games | kNN k=35 on GBM design vectors, EB-shrunk `effN/(effN+30)` (92-121) | |
| boosted_tree | 48 depth-2 trees fit on all prior rows in `dataset()` (77-90) | cached per season|week |
| deep_residual | `auditedNeuralFor` retrains a fresh 35→10→1 net from stored `deep_residual` audit rows each call (273-306) | see D7 |
| specialist_team | `orthogonalSpecialistPrediction` else legacy family-median council (543-549) | see D1 |
| line_movement | ridge slope of residual on open→decision move, prior games only (206-232) | |
| news_reaction | `teamNewsSignals` burden edge ×0.75, else verified event archive ×0.5 (234-271) | |
| live_updater | possession ledger Brier reconstruction, never a forecast (314-327) | observed 0/125 forward |
| price_shopper | best/worst book line per side from `nfl_line_snapshots` before cutoff (329-370) | execution only |
| player_opportunity | `buildPlayerWeekEngine` volume expectations, settled by player MAE (372-446) | forecasts 0 by design |
| 5 matchup + 2 external | `matchupOpinion` (563-567) | trench_continuity observed 0/125 forward, see D10 |

**Data read.** game_lines, nfl_weekly_expert_examples, nfl_live_possession_* , nfl_line_snapshots, nfl_teams, news_items,
nfl_player_week_features, nfl_pick_decisions, nfl_expert_forward_predictions/settlements, plus everything the imported
services read. **Data written.** nfl_expert_forward_predictions (INSERT OR IGNORE), nfl_expert_forward_settlements,
nfl_weekly_expert_examples; and *indirectly* nfl_team_cards via `matchupTeamCards` → `freezeTeamCard` (490 → team-card.js:213).

**Wiring.** Imported by nfl-betting.js:84 (status + manual capture), scheduler.js:699 (`refreshNflDecisionLedger`, horizon
`scheduled`), evidence-daemon.js:19,133 (one capture per T-window: open/T-24h/T-6h/T-60m/T-15m/close), nfl-model-growth.js:32
(settle + `weekly_growth` capture), nfl-blind-audit.js:25, nfl-unified-engine.js:18, page-explain-tools.js:14,
nfl-diagnostic.js:14, nfl-slice-diagnostic.js:16, nfl-expert-coordinator.js:10, nfl-specialist-audit.js:18; 6 tests.
DB: 2026 W1 has 7 horizons captured (scheduled/open/T-24h/T-6h/T-60m/close/T-15m; 2,289 rows), 2026 W2 `open` captured
2026-09-09. Settlement joined the two final games (LAR ×7 horizons, SEA ×4).

**Defects.**
- D2 (P2) 174/186: `combinedDecisionTrace` reports `state: 'candidate_forecast_only'` and a
  `projected_home_margin = market + forecast_residual` whenever `coordinator.ready`, even when `active_weight_l1 === 0`
  and the residual is pure missingness offset (coordinator.js:412). Every 2026 W1 combined decision is ±0.05 for this
  reason. Fix: when `active_weight_l1 === 0` (or all `shrink === 0`) emit `state: 'all_roles_zeroed'`, null the
  projected margin, and keep the missingness offset as a diagnostic field only.
- D1 (P2) 543-544: `forecast: Number.isFinite(orthogonal.forecast_residual) ? orthogonal.forecast_residual : council.forecast`
  — a hard `0` from the broken orthogonal engine (see nfl-orthogonal-specialists.js) is `isFinite`, so it *masks* the
  legacy family fallback (`legacy_family_fallback.forecast` was -0.446 on the latest LAR row) and is persisted as a forecast.
  DB: all 125 `specialist_team` forward rows have `forecast_residual = 0`; `reportingState` calls it `forecasting`;
  `directional_correct` is null on every settled row because `|0| > 1e-9` fails. Fix: treat `orthogonal.specialists.every(s => !s.active)`
  as "abstain" and fall through to the legacy council, or mark `observed:false` with a reason.
- D6 (P3) 72-74: `datasetCache` is module-global and never invalidated (`buildGbmDataset({throughSeason: 2026})`). In the
  long-lived server (PID 56651) the boosted-tree and analog experts train on the dataset as of the first call this
  process made, so mid-season captures silently omit newly finalized 2026 games from their training pool even though the
  `before(season, week)` filter would allow them. `captureForwardExpertWeek` builds a *second* dataset (633) but only
  uses it for `meta`/`X` of the target (647); the models still fit on the stale cache. Fix: invalidate on growth-cycle
  completion (there is already `clearNflEngineRegistryCache` etc. in growth.js:214-223) or key the cache by a data fingerprint.
- D7 (P3) 273-306: `auditedNeuralFor` re-trains the full chronological replay (up to 70 weekly `trainBatch` calls of 20
  epochs over 512 examples) **per game per capture** with no cache — 16 games × 7 horizons a week. It also reads only
  `nfl_weekly_expert_examples` (278), never the settled forward rows, so the `deep_residual` council expert is frozen at
  the last historical audit (payload shows `examples: 1039, weeks: 70` = 2025 W18) and will not learn from 2026.
  The coordinator *does* merge forward rows (coordinator.js:261), so the two disagree on what "earlier settled weeks" means.
- D8 (P3) 644-646: comment says "Twelve experts plus the coordinator"; the registry has 19 and outputs include
  `combined_decision`, so the skip threshold is `NFL_EXPERTS.length + 1 = 20` rows: a warm-up capture that wrote 20 rows
  (19 experts + combined_decision, coordinator not ready) is treated as complete and will never gain the coordinator row
  for that horizon. Correct in effect but the comment is wrong and the arithmetic is fragile; make the check `>= NFL_EXPERTS.length + 2`
  only when the coordinator is ready, or compare against the set of expected ids.

**Verdict.** Structurally sound shadow ledger; append-only contracts are respected. Two P2 reporting defects make the
"combined decision" and the `specialist_team` column look like forecasts when they are not.

### server/services/nfl-expert-coordinator.js (448 lines) — active, shadow
**Purpose.** v4 robust coordinator: per-role walk-forward shrinkage (Stage A, `shrinkageScales` 98-132: `k = cov/(var+4)`
clipped 0..1, zeroed unless t>2 and split-half cross gain > 0), single-linkage families at r ≥ 0.6 (Stage B, 135-153),
week-balanced Huber(10) ridge(36) on family columns + missingness flags (`fitRows` 171-228), coefficient caps ±0.35 and
L1 ≤ 0.8, regime sub-fits (`fitExpertCoordinator` 255-303), exact Shapley trace (`familyShapley` 339-361).

**Data read.** nfl_weekly_expert_examples, nfl_expert_forward_predictions ⨝ settlements (261-265), game_lines (223-229),
nfl_game_variance for `target:'adjusted'` (274). **Writes.** none.

**Wiring.** Imported only by nfl-expert-council.js:19 and nfl-specialist-audit.js:19; 3 tests. Output is persisted by the
council; nothing stakes on it (445: "not stake permission").

**Defects.**
- D9 (P3) 233-237: `regimeLabels` reads `[...game.experts.values()]`, but `pivotRows` (75-86) keeps *every* expert_id
  in the row set including `coordinator` and `combined_decision` (both are persisted as expert rows by council.js:731-751
  and 676-682). So `disagreement` includes the previous coordinator's own forecast and `coverage = forecasts.length / IDS.length`
  can exceed 1. Regime labels `disagreement:high|normal` and `coverage:sparse|broad` are therefore mis-assigned on
  games that already have a coordinator row. Fix: filter `IDS` in `pivotRows` or in `regimeLabels`.
- Observation (not a defect): with every `k = 0` (129), `designV4` pushes `0` for every family column (168) and the
  only non-constant regressors are the 19 missingness flags. The fit is then "which roles abstained predicts the residual"
  — with 1,039 games and ridge 36 that is noise, and it is what the 2026 W1 combined decisions are made of.

**Verdict.** Mathematically careful, honest about zeroing; the persisted-row leakage into regime labels is a small bug.

### server/services/nfl-specialists.js (619 lines) — experimental research harness
**Purpose.** Standalone "specialists argue, meta-model decides" architecture: 15 families of team-week differentials
(`FAMILIES` 43-55 + context/ATS/movement/news), ridge specialists (λ=250) → gated meta ridge (λ=500) with 6 context
interaction gates (368-375), walk-forward `evaluate` (401-499) and `permutationTest` (510-558). Its own verdict strings
(551-556) already say the architecture's answer is "no".

**Data read.** nfl_team_week_features, game_lines, nfl_teams, nfl_line_snapshots, news_items. **Writes.** none.

**Wiring.** Route `nfl-betting.js:1394` (`research` topic `specialists` → `evaluate({})`), `nfl-rookies.js:38` imports only
`ridgeFit`; 1 test. Not part of the council.

**Defects.** none load-bearing. Note `movementVector` (260-279) and `newsVector` (281-291) are gated by `COVERAGE_FLOOR`
(89) as the docstring promises. `buildDataset` default `maxSeason = 2025` (161) means the route result never includes 2026.

**Verdict.** Dead-weight candidate: the only live consumer is `ridgeFit`. Move `ridgeFit` to a shared util (there are
already four hand-rolled Gaussian solvers in this group: council uses none, coordinator.js:53-70, matchup-specialists.js:168-181,
orthogonal-specialists.js:45-60, passing-specialists.js:18-34, neural-replay.js:67-82) and archive the rest.

### server/services/nfl-matchup-specialists.js (248 lines) — active, shadow
**Purpose.** Five matchup roles + two external-line roles as small ridge fits (λ=25, cap ±4) of the residual on
differentials from `nfl_team_week_features` (`teamProfile` 71-86, prior-week only, prior-season blend), snaps
(`continuityProfile` 106-121), QBR (`qb_state` 149-153), nfelo/TeamRankings vs the close (137-148).

**Data read.** nfl_team_week_features, nfl_snaps, game_lines (closing spread), nfelo/external ratings services.
**Writes.** none. Caches: `_featureRows`, `_snapRows`, `_fits` module-level (57, 88, 199), cleared only by `clearMatchupCache`
(68) which has **no callers** (the `clearMatchupCache` referenced by routes is `matchups.js`'s).

**Wiring.** council.js:9, line-move-study.js:27 (MATCHUP_ROLES only — external roles correctly excluded, 243-248); 1 test.

**Defects.**
- D10 (P3) 106-110: `continuityProfile` looks back only within `season` (`${season}|${w}|${team}`), so `trench_continuity`
  abstains for every game in weeks 1-2 of a season; DB: observed 0/125 on 2026 forward rows. The other roles blend the
  prior season (74-77). Either blend prior-season snaps or document that the role is a Week-3+ role.
- (P3) 68: `clearMatchupCache` never called → after the growth cycle ingests a new week, the live server keeps serving
  `_featureRows` from first load, so matchup roles compute "prior weeks" from a stale feature table until restart. Same
  class as D6.

**Verdict.** Fine as a candidate generator; stale-cache hygiene.

### server/services/nfl-orthogonal-specialists.js (258 lines) — active, shadow, **numerically broken**
**Purpose.** Six families fit sequentially on the residual left by earlier families (`fitArtifact` 161-202) with a
train/tune/report chronological split (147-159); influence per family from tune-block MSE gain (180-185); persisted to
`nfl_orthogonal_specialist_artifacts`; `orthogonalSpecialistPrediction` (232-250) sums `raw × influence`.

**Data read.** nfl_team_cards (frozen v2), game_lines. **Writes.** nfl_orthogonal_specialist_artifacts (205-211).

**Wiring.** council.js:26, model-growth.js:39 (`persist:true` each finalized week), scripts/nfl-2022-2025-rebuild.mjs:17,
schema registry; 1 test.

**Defects.**
- D1 (P2) — the persisted artifact (`through 2025 W18`, created 2026-09-01T19:07:45Z) has **every beta non-finite in all
  six families** (`roster` 7/7, `efficiency` 11/11, `pace_script` 10/10, `availability` 6/6, `environment` 7/7,
  `market_shape` 6/6 — NaN/Infinity serialised as `null`), `final_validation_mse: null`, `roster.influence: null`,
  every other `influence: 0`. Mechanism: `fitRidge` (62-86) has no finiteness guard; `solve` (45-60) substitutes a
  `1e-10` divisor for a singular pivot (51) instead of failing, which blows the IRLS weights up; once `roster` produces a
  NaN `influence`, `trainRemaining = value - trainRaw[i] * influence` (186-188) poisons the target for every later family,
  whose `baselineMse` then becomes NaN so `gainFraction` is forced to `0` (183) and `influence` to `0`. `r4` (36) turns NaN
  into `null` at 189-193 and 199-200, so the artifact looks like "no family earned influence" rather than "the fit failed".
  Live effect: `forecast_residual` (246) is exactly `0` for every 2026 game (`null` betas coerce to `0` in `predictFamily`
  after the JSON round trip), and the council persists that 0 as a forecast (council.js:544, D1 above). Fix: assert
  `beta.every(Number.isFinite)` after each `fitRidge` and return `{error}` from `fitArtifact`; make `solve` return `null`
  on a singular pivot like the matchup-specialists solver does (matchup-specialists.js:173).
- (P3) 115-116: `market_margin` differential is `-h.spread - (-a.spread) = -2×home spread` because both cards store the spread
  from their own side; harmless under standardisation but the field name is misleading.

**Verdict.** Broken and silently reporting zero. This is the `specialist_team` role's real source.

### server/services/nfl-passing-specialists.js (251 lines) — experimental research
**Purpose.** 20 pre-declared QB passing-yards component challengers (5 families × 4 λ) with discovery 2022→2023 and
validation ≤2023→2024-25, paired cluster bootstrap and Holm (`passingSpecialistAudit` 198-251). `production_authority: 0` (224).

**Data read.** `propReplayRows` (heavy, cached), nfl_team_week_features, nfl_player_week_features, game_lines. **Writes.** none
(module cache only).

**Wiring.** nfl-betting.js:70,308 (`GET` passing audit), scripts/audit-passing-specialists.mjs:1. No test.

**Defects.** none found. Cutoff: `averageForm/averagePlayer` use `row.week < week` (77, 87); `playerHistory` is appended
after feature construction (132-134) and `propReplayRows` iterates seasons and weeks in sorted order (nfl-props.js:79-93),
so the `qb_participation` family is leak-free. Props are Nick's real skill, so this is the one research file in the group
worth keeping warm.

**Verdict.** Acceptable, experimental.

### server/services/nfl-specialist-audit.js (115 lines) — active diagnostic
**Purpose.** Scale / conviction / duplication audit of the latest historical run (`specialistAudit` 33-115), plus the
coordinator's would-be shrinkage on that run (103-110).

**Data read.** nfl_weekly_expert_examples. **Writes.** none. **Wiring.** nfl-betting.js:62,204.

**Defects.**
- D11 (P3) 109-110: `fitExpertCoordinator(9999, 1, { auditRunId })` fits on *all* rows of the run (in-sample) and is
  presented as "what the v4 coordinator would do"; label it in-sample in the payload (`rule` at 114 does not say so).
- (P3) 98: the fifth finding is a hard-coded sentence ("No role clears 52.4% ...") emitted regardless of the computed
  rates; if a role ever does clear, the text will contradict the numbers next to it.

**Verdict.** Useful, honest, small hygiene.

### server/services/nfl-context-heads.js (209 lines) — experimental research
**Purpose.** ~200-candidate grid of multiplicative prop adjustments (opponent DvP × weight × shrink, home/away, rest,
weather) over the structural player-week projection; discovery-only (2023 dev, 2024 discovery), redundancy prune, sign-flip
p, Holm; 2025 sealed (163-167, 205).

**Data read.** playerWeeks, gameContext, player-week engine, PROP_METRIC_CONFIG. **Writes.** none.
**Wiring.** nfl-betting.js:1399 only (`research` topic `context-heads`). No test.

**Defects.** none. `cutoffDvp` (46-83) is prior-seasons-only as documented.

**Verdict.** Experimental; fine to keep behind the research route. Relevant to fantasy (props) more than betting.

### server/services/nfl-reasoning.js (255 lines) — active, presentation only
**Purpose.** Human-readable "why the model likes it" (`explainPick` 161-218) from a curated explainer list (38-60),
league-normed z gaps (`factorAnalysis` 83-111), line movement as public-money proxy (`publicSignal` 123-152),
`explainBoard` (240-255).

**Data read.** teamFeatureVector, teamWeeks, game_lines, teamNewsSignals. **Writes.** none.
**Wiring.** nfl-betting.js:24 (routes 424, 459, 480, 544), pick-reasoning.js:40,128.

**Defects.**
- D21 (P3) 165-167: `teamNewsSignals(pickTeam)` / `(oppTeam)` are called with no `before` cutoff, so when `explainBoard`
  is applied to a historical or already-kicked-off row the "news context" can include post-kickoff items. Presentation
  only; pass `before` = kickoff.
- (P3) 178: headline text calls it a "-point disagreement" for a *probability* difference ×100 — cosmetic.

**Verdict.** Acceptable.

### server/services/nfl-team-card.js (253 lines) — active, shadow input
**Purpose.** Immutable per-team-week evidence card (`buildTeamCard` 149-181: schedule, market, roster strength, weekly
feature vector, tendencies, injuries ≤ cutoff, verified news/events, roster events, coach, officials), content-hashed and
frozen once (`freezeTeamCard` 183-202), read by `getFrozenTeamCard`/`matchupTeamCards`, backfilled by `backfillTeamCards`.

**Data read.** game_lines, nfl_team_week_features, nfl_injuries, nfl_player_roster_events, nfl_team_coaches, nfl_officials,
nfl_team_cards + roster-strength/news/event/feature-store services. **Writes.** nfl_team_cards.

**Wiring.** council.js:25 (on-demand freeze), orthogonal-specialists.js:11, nfl-live-ledger.js:5, model-growth.js:37
(`backfillTeamCards` for next week), nfl-betting.js:82 (coverage), scripts/nfl-2022-2025-rebuild.mjs:15, schema registry.
DB: v1 2,156 cards, v2 2,142 cards; 2026 W1 (32) frozen 2026-09-02T05:50Z, W2 (32) frozen 2026-09-09T03:48Z.

**Defects.**
- D3 (P2) 153 + 213 + council.js:490: `matchupTeamCards` freezes a card the first time *anyone* asks for it. The first
  asker for 2026 W1 was the scheduler's `refreshNflDecisionLedger` council capture at 2026-09-02T05:50:35Z (11 days before
  kickoff), and for W2 the evidence-daemon `open` capture on 09-09. The card's `cutoff` is the *kickoff* (153), and the
  `contracts` block claims `news_at_or_before_cutoff: true` (176), but its content is whatever the warehouse held at build
  time. Verified: every 2026 W1 card has `injuries.players.length = 0` while `nfl_injuries` now holds 167 W1 rows (ARI 7,
  ATL 10, CHI 6, ...). Consequences: (a) `player_builder` (roster from the card) and `orthogonal` families
  (`injury_burden`, `news_*`, `roster_status_changes`) run at T-15m on an 11-day-old snapshot while `availability` is
  live; (b) the growth cycle's intended weekly `backfillTeamCards(season, nextWeek)` (growth.js:243) will hit
  `team card conflict` (192) for all 32 teams every week from now on because the hash differs, and nothing handles that
  error (grep: no other reference to the string). Fix options: freeze cards *only* from the growth cycle / a T-6h window
  and have the council read-only fall back (`getFrozenTeamCard` → `teamRosterStrength`) when none exists; or key the
  frozen identity by horizon so pre-kickoff refreshes get a new row instead of a conflict.
- (P3) 76: `modified_at IS NULL OR modified_at<=?` — `nfl_injuries.modified_at` is NULL for all 167 2026 W1 rows
  (`MAX(modified_at)` = null), so the cutoff filter is a no-op for this season's data.

**Verdict.** Good idea, wrong freezing trigger.

### server/services/nfl-family-contribution.js (444 lines) — experimental research
**Purpose.** Section-8.6 paired leave-one-family-out ablation on a common universe: margin MAE, proper cover/push scores
(`spreadProperScores` 183-213), ROI, paired weekly-cluster bootstrap of deltas (`pairedDelta` 253-299),
`decideFamily` keep/simplify/test-connection (405-444).

**Data read.** `replaySeason` per family per season (319 — refits the ensemble each time), ensemble feature contracts.
**Writes.** none. **Wiring.** nfl-betting.js:1407,1414 (`family-consumers`, `family-contribution` research topics); 2 tests.

**Defects.**
- D19 (P3) 4-27 vs nfl-research.js:119-147: this module was written to *replace* `runNflFeatureAblations` (its docstring
  says the ROI-only comparison "quietly invalidates" itself), yet both remain wired (`POST` ablations at nfl-market.js:210
  still writes `nfl_feature_ablation_audits` and `nflOperations` still surfaces `latest_ablation`). Merge: have
  `runNflFeatureAblations` call `familyContributionReport` or retire the route.

**Verdict.** Statistically the best-argued file in the group; duplicate of an older harness.

### server/services/nfl-engine-registry.js (196 lines) — active, live metadata
**Purpose.** Content-addressed engine version (`computedVersion` 101-111) from the active artifacts + warehouse cutoff;
learning epochs (`activeLearningEpoch`, `startLearningEpoch` 115-151); seal artifact (`recordNflEngineArtifact` 161-172);
status (174-194).

**Data read/written.** nfl_learning_epochs (INSERT on import, 25-31; INSERT/UPDATE in `startLearningEpoch`),
nfl_engine_artifacts (INSERT OR IGNORE), reads nfl_ensemble_fit_artifacts, weekly_ensemble_fits, nfl_online_neural_artifacts,
nfl_signal_reliability_artifacts, nfl_risk_lab_artifacts, audit_registry via `modelMap`.

**Wiring.** 14 server importers (props, player-value, player-week-engine, weekly-learning, ensemble, profitability,
unified-engine, online-neural, risk-lab, growth, backfill, weekly-weight-store, nfl-betting route) + 3 tests. `nflEngineVersionFor`
stamps live prop/fantasy predictions. DB: `nfl_engine_artifacts` is empty (never sealed under any epoch), epochs: #2 archived,
#3 active (Nick's 2026-09-08 reset).

**Defects.**
- D15 (P3) 25-31: import-time DB write (creates an active epoch if none). Side effects on import make the module
  order-sensitive and force every test that touches a downstream module to mock it (`mock.module` in two tests). Move into
  `activeLearningEpoch()` lazily.
- (P3) 153-158: every `nflEngineVersionFor` call does a `row()` lookup then falls to `computedVersion` (10 s cache) — with
  an empty artifacts table the fallback is always taken; harmless but the "sealed" path has never been exercised in prod.

**Verdict.** Acceptable.

### server/services/nfl-engine-backfill.js (195 lines) — active tool, historical only
**Purpose.** Resumable 2022-2025 chronological replay: optional ingest (45-56), `fitEnsemble` per week, `ensembleLine`
market-residual projections into `nfl_historical_engine_replay` (156-166), checkpoints, bias slices (66-89), challenger
signal backfill (92-130), status (189-195).

**Writes.** nfl_engine_backfill_runs, nfl_engine_backfill_checkpoints, nfl_historical_engine_replay (INSERT OR IGNORE),
nfl_historical_signal_replay (INSERT OR REPLACE), nfl_engine_artifacts via registry.

**Wiring.** nfl-betting.js:74-75 (routes 245-259); 1 test.

**Defects.** (P3) 109: `INSERT OR REPLACE` with a fresh `generated_at` on every run means the "historical shadow signal"
rows are not immutable, unlike every other ledger in the group. Minor.

**Verdict.** Acceptable.

### server/services/nfl-unified-engine.js (96 lines) — active, read path
**Purpose.** One projection payload: ensemble (market-residual) → `simulateMatchup` (neutral-site aware, 45-52) →
news, injury carryover, council game view, capability authority (61-62, 84-91).

**Wiring.** nfl-betting.js:73,1139. No test.

**Defects.** D25 (P3) 65: calls `nflEngineStatus(...)` (which recomputes all components and reads the latest artifact)
just to get `learning_epoch`; `activeLearningEpoch()` is the cheap call. Otherwise fine; `authority.staking` (91) states
the correct rule.

**Verdict.** Acceptable.

### server/services/nfl-model-growth.js (308 lines) — active, scheduler, **live path (weekly refit)**
**Purpose.** Publication-driven weekly cycle: settle all shadow ledgers (168-174), ingest when a week finalizes (186-202),
postgame truth + signal reliability, `fitEnsemble` for next week (224), team-code reconciliation, freeze weekly state,
team cards, sim calibration, orthogonal specialists, feature coverage (241-246), train neural + risk lab, player weights,
council capture (`weekly_growth`), seal engine artifact (277-281). `nflModelGrowthStatus` (118-147) read-only.

**Writes.** nfl_model_growth_runs and everything the called services write. **Wiring.** scheduler.js:668, nfl-betting.js:63,231,
nfl-profitability.js:10, schema registry; 2 tests. DB: runs #40-42 today, all `waiting` (finalized_week 0 — correct: W1 not
fully final).

**Defects.**
- D3 (see team-card): 243 will fail for every team once a council capture has already frozen the week's cards; the
  failures land in `detail.team_cards.failures` and nobody reads them.
- (P3) 64-67 is right (a week is finalized only when every game is final) — worth saying because the TNF/SEA results
  today would otherwise have tripped a fake Week-1 retrain.

**Verdict.** Good; this is the one file here that genuinely changes production weights, and it does so with the right gates.

### server/services/nfl-model-watch.js (147 lines) — active, scheduler, report-only
**Purpose.** Daily drift pass: baseline gates, probability skill, calibration parity, optional head discovery, prop edge
evidence; writes `nfl_model_watch_runs`; `production_eligible: false` by construction (121).
**Wiring.** scheduler.js:655 (`includeHeadSearch:false`), schema registry. `modelWatchHistory/Status` have no callers
outside the file. DB: 7 runs, last 2026-09-11T04:16Z.
**Defects.** (P3) 80: alert text hard-codes "was 0.9734" as the reference coverage. Otherwise clean.
**Verdict.** Good.

### server/services/nfl-online-neural.js (367 lines) — active, shadow, latent live hook
**Purpose.** 35→10→1 tanh residual head with bounded output (±7), full-batch Huber SGD (`trainBatch` 77-110), feature
vector from the frozen ensemble packet + verified news (`spreadFeatureVector` 118-158), per-horizon immutable captures
(195-224), settlement (226-244), prequential training with 512-example replay (295-336), `performanceMetrics` gate (265-291).
**Writes.** nfl_online_neural_examples, nfl_online_neural_artifacts.
**Wiring.** council.js:15, neural-replay.js:12, auto-picks.js:14 (**consumer of `production_eligible`**), evidence-daemon.js:17,
growth.js:27, coordination-audit, profitability, nfl-betting.js:65; 3 tests. DB (epoch 3): 128 captured, 14 settled,
0 trained, 0 artifacts → cold network, `residual = 0`.

**Defects.**
- D4 (P2, latent) 185-186 vs nfl-auto-picks.js:104-108: `production_eligible` is a self-computed gate (≥128 examples,
  ≥8 weeks, weekly-clustered CI90 lower bound > 0) and the payload labels it `eligible_for_production_review`; but the
  auto-picks board treats `production_eligible === true` as *promotion* and swaps `projectedMargin` to the neural head's
  number with no human step. That contradicts growth.js:144 ("never auto-promote") and engine-registry.js:191. With the
  epoch-3 reset it cannot fire before ~Week 9, but it will fire on its own. Fix: consume only `includeChallengers` in
  auto-picks, or gate on an explicit governance flag (`model-governance.js` registry state), not on the head's own metric.
- (P3) 166-172: `activeNetwork` silently cold-starts when the latest artifact's schema/input size mismatches; status
  (349) would still show `active_version` of that artifact. Emit a `schema_mismatch` flag.

**Verdict.** Careful prequential design; one policy wire is pointed the wrong way.

### server/services/nfl-neural-replay.js (207 lines) — **dead**
**Purpose.** Historical prequential replay of the neural head with a ridge-logit cover calibrator and a 3-pick weekly
policy (`runHistoricalNeuralReplay` 101-193), save/load (195-207).
**Wiring.** `latestHistoricalNeuralReplay` ← nfl-diagnostic.js:13 only; `runHistoricalNeuralReplay` / `saveHistoricalNeuralReplay`
have **zero callers** in server/, scripts/, client/ (only test/model-integrity.test.js imports the calibrator helpers).
DB: `nfl_neural_replay_audits` has 0 rows → the diagnostic reader always returns null.
**Defects.** none functional; it is unreachable.
**Verdict.** Archive (keep `fitNeuralDecisionCalibrator`/`calibratedNeuralProbability` only if the test is worth keeping).

### server/services/nfl-ai-replay.js (414 lines) — active tool, **paid**, manual only
**Purpose.** Outcome-blind Claude Haiku risk gate over historical replay candidates: packet builder (`packetFor` 110-178),
tool-use review with strict normalisation (`normalizeReview` 221-236), $1 budget cap (377), detached worker (395-401),
stake-normalised report (`reportRun` 245-278), strictly-prior learning memory (`agentLearningMemory` 77-107).
**Writes.** nfl_ai_replay_runs, nfl_ai_replay_reviews, nfl_ai_replay_candidate_cache, ai_usage (via claude.js).
**Wiring.** nfl-betting.js:45 (routes 756-770), server/scripts/run-nfl-ai-replay.js:2; 1 test. DB: runs table empty;
ai_usage shows 203 historical gate calls (≈$0.82), last 2026-08-24.
**Defects.**
- D12 (P3) 197-208: the regex fallback parses v1 keys (`"risk": "low|medium|high"`, `"adjustment": -0.15|-0.05|0`) that
  the v4 `REVIEW_TOOL` schema (37-55) never emits; dead branch. The final conservative fallback (211-213) is the one that
  actually runs.
- (P3) 24: `INPUT_TOKENS = 3500` reservation vs observed ≈3,128 input tokens/call (634,965/203) — fine, conservative.
**Verdict.** Acceptable; cost-bounded; `admissibility: research_only` (177) is correct.

### server/services/nfl-research.js (199 lines) — active
**Purpose.** Nested market-residual audit (`nflResidualAudit` 55-99), ROI-only family ablations (119-147), promotion-gate
dashboard `nflOperations` (155-199) with 8 gates.
**Writes.** nfl_residual_audits, nfl_feature_ablation_audits, gate audits/registry via model-governance when `persist`.
**Wiring.** nfl-market.js:10 (routes 73, 200, 204, 210), schema registry.
**Defects.**
- D14 (P3) 158: `latestCoverCalibration(2027)` — magic `beforeSeason`; today it means "any", but it will silently exclude
  a 2027-trained calibration. Pass nothing (default 9999) or the current season + 1.
- D19 (P3) 119-147: superseded by nfl-family-contribution.js (see above); the docstring at 15-28 already fixed the
  hard-coded family list that nfl-experiments.js still has.
**Verdict.** Acceptable.

### server/services/nfl-research-lab.js (280 lines) — active, read-only workspace
**Purpose.** Assembles the research workspace page from on-disk lab reports (market-lab, tree-lab, book-lag-lab,
expert-selector-lab, news-event-impact), blind-audit runs, and the master plan (`researchMasterPlan` 278-280 reads
docs/CLAUDE-NEXT-STEPS.md — the single active plan).
**Wiring.** nfl-market.js:33 (routes 43, 46); 1 test.
**Defects.** D13 (P3) 3: `fileURLToPath` imported, unused (the comment at 9-15 explains why it was removed from use).
**Verdict.** Good; Package F's negative result (79) is exactly the "expert selector did not beat the market" finding.

### server/services/nfl-risk-lab.js (494 lines) — active, shadow
**Purpose.** Four restricted challengers on the same frozen vectors as the neural head: 5-member deep ensemble (24→12),
diagonal Bayesian online regressor, contextual MoE over family residuals, multitask spread+total encoder; capture from
`nfl_online_neural_examples` (324-352), settle per row (354-378), prequential train with 256 replay (429-471),
`review_eligible` metric (425) with `direct_betting_authority: false` (426).
**Writes.** nfl_risk_lab_predictions, nfl_risk_lab_artifacts. **Wiring.** growth.js:28, evidence-daemon.js:18,
coordination-audit, profitability, nfl-betting.js:67; 2 tests. DB (epoch 3): 160/160/160/128 captured, 18/18/18/14
settled, 0 trained.
**Defects.** none load-bearing. (P3) 294: `trainMoe` uses `example.target` unguarded; a `null` `target_residual` (possible
only if `market_margin` was non-finite at capture, which `captureOnlineNeuralWeek` prevents) would become `0` via coercion
rather than being skipped. No consumer auto-promotes on `review_eligible`.
**Verdict.** Acceptable; pure shadow.

### server/services/nfl-experiments.js (176 lines) — experimental, route-wired, unused
**Purpose.** Locked discovery/validation/holdout experiments over `trainingIteration` configs; holdout opens once.
**Writes.** nfl_model_experiments. **Wiring.** nfl-betting.js:42 (routes 1051-1055); 1 test. DB: 0 experiments ever created.
**Defects.**
- D5 (P2) 21 + 40-41: `FAMILIES = new Set(['Rating systems','Efficiency','Context','Market'])` omits `'Roster availability'`,
  and `normalizeConfig` *filters* any requested family list through this set. Because `families` is a whitelist inside
  `ensembleLine`, every candidate that names families would silently drop roster availability — exactly the defect
  nfl-research.js:19-28 documents and fixed there by deriving the list from `ensembleFeatureContracts()`. Any experiment
  result produced here would be mislabeled. Derive `FAMILIES` the same way.
- (P3) 76: `execFileSync('git', ['rev-parse','HEAD'])` with `cwd: process.cwd()` — the server's cwd is not guaranteed to
  be the repo; use `PROJECT_ROOT` like nfl-research-lab.js does.
**Verdict.** Experimental; fix D5 or archive.

### server/services/claude.js (178 lines) — active, paid gateway
**Purpose.** API key/workspace storage (app_settings + `.env` write, 15-72), single `callClaude` entry (99-142) with
usage recording (74-79), Haiku-only pricing (10-13), `parseJson`, `usageSummary` (154-178), `GROUNDING_SYSTEM` (86-90).
**Wiring.** 12 routes + 5 services import it; in this group only nfl-ai-replay.js calls it.
**Defects.**
- (P3) 32-42, 44-50: the API key is persisted in plaintext in both `app_settings` and `.env` (mode 0600). Standard for a
  local single-user app but worth noting; the `new RegExp(`^${name}=.*$`, 'm')` strips only the first match.
- (P3) 172, 176: `today` and `by_feature` costs use `PRICING.default` regardless of model; identical to Haiku today, but
  will misprice the moment a second model appears in `PRICING`.
**Verdict.** Acceptable. Total recorded AI spend across all features is modest; `team-analysis` (424 calls, 1.14M in tokens)
is the largest consumer and is outside this group.

## 2. Data flows (this group)

1. **Forward council capture:** scheduler `refreshNflDecisionLedger` (horizon `scheduled`) and evidence-daemon T-windows
   → `captureForwardExpertWeek` → `gameExperts` (reads ensemble packet, GBM dataset cache, team cards [freezes if missing],
   orthogonal artifact, matchup fits, news, line snapshots, player-week engine) → `coordinateExperts(fitExpertCoordinator)`
   → 21 rows/game/horizon into `nfl_expert_forward_predictions` (+ production selection copied from `nfl_pick_decisions`).
2. **Settlement:** growth cycle → `settleForwardExpertPredictions` → `nfl_expert_forward_settlements`; coordinator
   training merges settled forward rows with historical audit rows next fit.
3. **Historical audit:** blind audit → `weeklyExpertAudit(auditRunId)` → `persistWeeklyExpertAudit` → `nfl_weekly_expert_examples`
   (100,483 rows, runs ≤ #32) → `specialistAudit`, `fitExpertCoordinator`, `auditedNeuralFor`.
4. **Neural/risk lab:** evidence-daemon `captureOnlineNeuralWeek` → `nfl_online_neural_examples` → `captureRiskLabWeek`
   (same vectors) → growth cycle settle + train → artifacts (none yet under epoch 3) → `onlineNeuralPrediction` (auto-picks,
   gated) / `nflEngineComponents` (version hash).
5. **Weekly growth:** scheduler → `runNflModelGrowthCycle` → ingest → `fitEnsemble` (LIVE weights) → freeze state/cards/
   orthogonal fit → council `weekly_growth` capture → `recordNflEngineArtifact`.
6. **Read-only views:** `unifiedGameProjection` (ensemble + sim + council game), `expertCouncilStatus`, `specialistAudit`,
   `researchLabStatus` (disk JSON), `nflOperations` (gates), research topics route (specialists, context-heads, family-*).
7. **Paid:** `startAiBlindReplay` → worker → `callClaude` (Haiku, $1 cap) → `nfl_ai_replay_reviews`.

## 3. Dead / duplicate / archive list

| path | disposition | reason |
|---|---|---|
| nfl-neural-replay.js | archive | `runHistoricalNeuralReplay`/`saveHistoricalNeuralReplay` have no callers; audits table empty; only reader returns null |
| nfl-specialists.js | move + archive | only `ridgeFit` is consumed (nfl-rookies.js); the harness's own verdict is "no signal"; move `ridgeFit` to a shared linear-algebra util (six hand-rolled solvers in this group) |
| nfl-experiments.js | keep (fix D5) or archive | route-wired but 0 experiments ever created; stale family whitelist |
| nfl-research.js `runNflFeatureAblations` | merge into nfl-family-contribution.js | superseded ROI-only ablation, still wired at nfl-market.js:210 |
| nfl-context-heads.js | keep (experimental) | discovery-only; relevant to props/fantasy |
| nfl-passing-specialists.js | keep (experimental) | props are the real skill; leak-free |
| nfl-ai-replay.js:197-208 | delete branch | v1 regex fallback unreachable under v4 tool schema |
| nfl-matchup-specialists.js `clearMatchupCache` | keep, wire it | exported but never called; needed after weekly ingest |

## 4. Open questions for Nick / the orchestrator

1. Was the 2025-W18 orthogonal artifact with all-NaN betas present before the 2026-09-08 epoch reset, i.e. has
   `specialist_team` been a hard zero for the whole 2026 forward ledger? (DB says yes for every 2026 row; the artifact
   was created 2026-09-01.)
2. Should the council stop freezing team cards on demand (D3) before Week 2's T-24h capture on 2026-09-16, so the growth
   cycle's `backfillTeamCards` can own the freeze after Week 1 ingests? This is the one change in this group with a
   near-term date.
3. Is the auto-picks neural promotion hook (D4) intended? If not, it should be cut before the epoch-3 head accumulates
   128 examples (~Week 9).
4. Given "fantasy first", the only files here that serve fantasy are the props-adjacent research (passing specialists,
   context heads) and the player-week engine calls inside `player_opportunity`; everything else is betting shadow.
