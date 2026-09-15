# A05 — Replay / backtest engines (Gridiron HQ betting audit system)

Reader: A05-replay-engines. Date: 2026-09-11. Repo read-only; DB read via node:sqlite readOnly.
Assigned files read in full (every line): 6,098 lines across 21 files. Context also read: docs/CLAUDE-NEXT-STEPS.md §0,§1,§2,§3,§4,§7,§9; nfl-ensemble.js 940-1000, 1155-1195, 1220-1300, 1400-1425; nfl-blind-audit.js 240-320.

## 0. Headline answers

**How many engines, and which is THE audit.** There is ONE historical spread-replay engine — `replaySeason()` in `server/services/nfl-replay.js` — and roughly eight wrappers around it: the sealed blind audit (`nfl-blind-audit.js:284`, runs 27/31/32 that §1.2 of the plan cites), `trainingIteration` / `saveTrainingAudit`, `candidateInputComparison`, `nfl-experiments.js`, `nfl-research.js` (ROI-only family ablation), `nfl-family-contribution.js` (three-answer family ablation), `nfl-ai-replay.js` (candidate cache), plus `nfl-candidate-analysis.js` / `nfl-abstention-audit.js` (not assigned). Independent of that engine there are five separate spread research replays (`nfl-neural-replay.js`, `weekly-walkforward.js`, `scripts/audit-football-first.mjs`, `line-move-study.js`, `beat-the-close.js`), one totals script, one props replay, two fantasy backtests, and one execution-delay replay. The plan treats the sealed blind audit (runs 27 and 32, whose spread record §1.2 and C09 cite: 153 bets −7.7% / 156 bets −7.1%) as THE historical audit, and explicitly demotes it to "development data" (§9.2); the forward T−60 prospective ledger is the audit going forward (§7, §9). None of the assigned engines is the T−60 path; none consumes the frozen packet.

**Refit inside the loop vs single fit.** `replaySeason` is walk-forward at the ensemble level: `ensembleLine(season, week, …)` calls `fitEnsemble({ beforeSeason: season, beforeWeek: week })` (nfl-ensemble.js:1238), cached per cutoff in `nfl_ensemble_fit_artifacts` (847 rows in the live DB). `weekly-walkforward.js` refits ridge every week. `nfl-neural-replay.js` is prequential (one network, updated after each week; calibrator refit weekly). `line-move-study.js` runs both a week-by-week walk-forward and a single 2022–23 → 2024–25 holdout. `audit-football-first.mjs` is per-season fits on prior seasons. `nfl-props-replay.js` has no fit at all (fixed formula). `backtest.js`/`weekly-backtest.js` are fantasy and depend on globally fitted constants.

**Opener vs close disclosed?** `nfl-replay.js` grades and settles at the close and now carries two clearly labeled opener diagnostics (same-side regrade vs side-reselected counterfactual), neither executable — correctly disclosed. `line-move-study.js`/`beat-the-close.js` are opener-based by design with CLV against Pinnacle's close, T1/T2 labeled as upper bounds. `weekly-walkforward.js`, `audit-football-first.mjs`, `audit-trend-totals.mjs` grade against the close and say so in their headers. `nfl-neural-replay.js` grades against the close silently (no opener field, no disclosure string). `nfl-ai-replay.js` packets present the closing spread as `current_spread` and disclose "quote timestamp not preserved".

**Biggest finding.** The historical audit graph is not the served graph. `replaySeason` calls `ensembleLine` with `{ includeEvidence:false, ...modelOptions }` and never sets `blendMode`, so every replay (including the blind audit's `replaySeason(season, {startWeek, endWeek, markets})` at nfl-blind-audit.js:284) uses `blendMode='raw'` (nfl-ensemble.js:1221 default), whereas the production board forces `blendMode:'market_residual'` (nfl-auto-picks.js:83, nfl-cover-calibration.js:276). Runs 27/32 therefore score a different forecast than the one that would be served. C16 states this for the family report only; it applies to the entire historical audit lineage.

**Family ablation (C16).** `featureContracts()` now propagates `challenger_only` and `base_margin_weight` (nfl-ensemble.js:1415-1424; test pins 9 challengers). Conditional and three-state Brier are corrected (`spreadProperScores`, tests pin 0.25 / 0.3025 / 0.515). Still open, as the plan's own status row admits: `ablation_kind: 'refit_leave_one_family_out'` is false — `families` only filters `MODELS` in `ensembleLine` and is NOT passed to `fitEnsemble` (nfl-ensemble.js:1238 vs 1257); weights are the full-fit weights renormalized (`blend` divides by `wsum` of the surviving models). `nfl-research.js:139-142` makes the stronger, explicitly false claim "Each configuration REFITS the ensemble". Cost is still `model_count / 31` (family-contribution.js:375), not measured runtime. No graph/cutoff/fit/calibration identity is saved on the report.

---

## 1. server/services/nfl-replay.js (1,102 lines)

**Purpose.** Historical season replay + segment error analysis + candidate-finding rule hashing + training-audit persistence + candidate-input comparison.

**Flow.**
1. `replaySeason(season, {minEdge, maxDisagreement, markets, maxPicksPerWeek, startWeek, endWeek, modelOptions, label})` (L177-364): one `SELECT … FROM game_lines gl LEFT JOIN game_lines away …` (L187-200) for completed home rows with `spread IS NOT NULL`; per game `ensembleLine(season, g.week, g.home, g.away, { includeEvidence:false, ...modelOptions })` (L225); builds spread/total/moneyline candidates per week; `commitWeek()` runs `applyNflPolicy(weekly, policy)` with `NFL_HISTORICAL_REPLAY_POLICY` (L212-216) and settles selected bets with `unitsFor(won, pushed, american_price)` at the stored closing price (L80-84).
2. Opener diagnostics per bet (L93-172) and summaries (L365-410).
3. `saveReplay` → `nfl_replay_runs` / `nfl_replay_bets` (L416-435). Live DB: 0 rows in `nfl_replay_runs` — this persistence path is unused; the blind audit stores its own rows.
4. `segmentsFor` / `analyzeErrors` (L448-720): Holm across all segments, effect gate via `uncertainty`, overlap, leave-one-season-out.
5. `validateAdjustment` / `proposeAdjustment` (L728-850), `segmentRuleHash` + `candidateFindingsCodeHash` via `codeIdentity` (L960-975; C08 fix).
6. `trainingIteration` (L856-902) → `saveTrainingAudit` → `nfl_policy_audits` (1 row in live DB, 2026-08-24). `candidateInputComparison` → `nfl_candidate_input_audits` (5 rows, last 2026-08-31).

**Tables.** Reads `game_lines`, `nfl_policy_audits`, `nfl_candidate_input_audits`; writes `nfl_replay_runs`, `nfl_replay_bets`, `nfl_policy_audits`, `nfl_candidate_input_audits`. Indirectly (via ensembleLine) reads/writes `nfl_ensemble_fit_artifacts`.

**Time semantics.** Walk-forward at the ensemble-fit level (cutoff = `beforeSeason/beforeWeek`), but the price is the closing price (`gl.spread`, `gl.spread_odds`) and `quote_at = gl.fetched_at` (L246) — the row fetch time, not a quote time. The historical policy is applied, not today's (L212-216). Segments use a conservative week-first-kickoff cutoff for news/injury (L607-616).

**Defects.**
- P1 — Replay graph ≠ served graph. L225 `ensembleLine(season, g.week, g.home, g.away, { includeEvidence: false, ...modelOptions })` never sets `blendMode`; nfl-ensemble.js:1221 defaults `blendMode = 'raw'`; production uses `market_residual` (nfl-auto-picks.js:83 `modelOptions = { blendMode: 'market_residual', ...modelOptions }`). The blind audit's `replaySeason(season, { startWeek: week, endWeek: week, markets: [market] })` (nfl-blind-audit.js:284) inherits this. Runs 27/32 are audits of the raw blend.
- P2 — `uncertainty(bets)` (L43-72) builds weekly clusters only from bets: `for (const b of bets) { const key = \`${b.season}-${b.week}\` …}`. Zero-bet weeks are absent from the bootstrap; §9.2 requires "complete zero-bet weeks retained" and C09 asks for "complete declared weekly clusters including zero-bet weeks". The same function is reused by `nfl-neural-replay.js:97` and by the segment effect gate (L668).
- P3 — `candidateInputComparison` L1047 `const earlierSeasons = [2021].filter(season => !seasons.includes(season));` — hard-coded to 2021; the "full window" join is only ever 2021, so `full_window_context` silently equals the slice for any call that includes 2021 (the default). Cosmetic but misleadingly named.
- P3 — `quote_at: g.fetched_at` (L250, L278, L315) labels a table-fetch timestamp as a quote time; downstream AI packets already say "timestamp not preserved", but the field name invites misuse.
- P3 — `import { fitEnsemble, … }` (L27) unused; `execFileSync`, `readFileSync`, `resolve` (L23-25) unused after the C08 rewrite. Dead imports.

**Verdict.** Sound walk-forward mechanics with honest opener disclosure and a fixed historical policy; the single serious problem is that it audits `raw`, not the served `market_residual` blend, and nothing in the file or its callers says so.

## 2. server/services/nfl-execution-replay.js (429 lines)

**Purpose.** Pure delayed-execution replay of a frozen quote timeline (5s/30s/2m/10m ladder), plus timeline builders from the immutable quote tape and from frozen dataset rows.

**Flow.** `replayDelayedExecution` (L156-303): decision sample = last quote ≤ `decisionAt`; staleness gate at decision (L189-202); execution sample at `decisionAt + delay`; ordered gates: post-kickoff (L216-223) → pending/observedThrough (L225-230) → ambiguous → removed → suspended → stale → fill/repriced/capped; `availability_basis` reported separately (L290-293). `timelineFromQuoteTape` (L349-387) groups `nfl_quote_tape` rows by batch, emits `removed` only when a sibling side/line proves the book answered (L375), `ambiguous` on conflicting duplicates (L378). `replayFromFrozenDataset` (L421-429) discloses `market_status_source`.

**Tables.** Reads `nfl_quote_tape` JOIN `nfl_quote_batches`. Writes nothing. Called live by `nfl-execution-pipeline.js:217`.

**Time semantics.** Two clocks: `snapshot` (provider `snapshot_at`) or `received` = max(created_at, requested_at, snapshot_at) (L364-365). Batch time = max over the batch (L368). Staleness default 1,800s derived from capture cadence (L91-99).

**Defects.**
- P3 — `timelineFromQuoteTape` L355 `julianday(q.commence_time)=julianday(?)` still identifies the event by `provider_event_id` + optional commence time; period filter is optional (`if (period)`), so a caller that omits `period` can mix first-half and full-game rows into one contract timeline — the C11/C13 class of defect, guarded only by caller discipline. Pipeline call site not in scope.
- P3 — `replayFromFrozenDataset` (L421-428) drops `observedThrough`/`kickoffAt` — a frozen replay cannot express the E7 `pending`/`post_kickoff_unknown` states; the ladder path does.

**Verdict.** The cleanest file in the set: pure, deterministic, well-tested (test/nfl-execution-replay.test.js, 26 tests incl. determinism and time-shift invariance). It is a modeled-delay diagnostic, correctly labeled; not an audit of P&L.

## 3. server/services/nfl-props-replay.js (275 lines)

**Purpose.** Prop "replay" against a synthetic line (EWMA of the player's own prior games, half-pointed) at −115.

**Flow.** `buildPropDataset` (L55-81) from `nfl_player_week_features`, prior = same-season earlier weeks only; `replayProps` (L140-222): anchor = `weightedMean(priorStats,3)` → `toHalfPoint`; projection = volume × shrunk efficiency (L109-131); bet if |edge| ≥ 8% of line; grade at fixed −115; permutation null (L240-275).

**Tables.** Reads `nfl_player_week_features`. Writes nothing. Route: nfl-betting.js:1391 `replayPropsBySeason`.

**Time semantics.** Strictly prior weeks within season. No fit. No real quote — disclosed in `note` (L220).

**Defects.**
- P3 — `toHalfPoint` (L44) `Math.round(v*2)/2 + (Number.isInteger(…) ? 0.5 : 0)` always pushes integer results UP by 0.5, biasing the synthetic line high (favoring Unders on integers). Cosmetic given the whole line is synthetic.
- P3 — Not a market replay at all; "walk-forward" (L134) means only "prior weeks". Must never appear alongside spread ROI figures.

**Verdict.** Honest necessary-not-sufficient diagnostic; irrelevant to the spread audit.

## 4. server/services/nfl-ai-replay.js (414 lines)

**Purpose.** Paid Claude Haiku risk gate over `replaySeason` candidates, budget-capped, outcome-blind per review, with strictly-prior-week learning memory.

**Flow.** `cachedCandidates(season)` (L281-289) → `replaySeason(season)` (default policy, raw blend) cached in `nfl_ai_replay_candidate_cache` keyed (season, `CACHE_VERSION`); `execute` (L291-352) builds `packetFor(bet)` (L114-198) from `teamFeatureVector` (prior weeks), `game_lines` (open & close, weather, rest), `nfl_injuries` by season/week; calls Claude in batches of 3; writes review + outcome + units to `nfl_ai_replay_reviews`; `agentLearningMemory` (L74-105) aggregates only rows with `season<? OR (season=? AND week<?)`. Worker forked detached (L363-372).

**Tables.** Reads `nfl_ai_replay_runs/reviews/candidate_cache`, `game_lines`, `nfl_injuries`; writes all three ai tables. Live DB: 0 runs, empty cache.

**Time semantics.** Candidates = closing-line selections; packet shows `current_spread: game.spread` (the close) and `open_spread`; injuries have no publication timestamp; all disclosed as `research_only` (L196-197, L342).

**Defects.**
- P2 — Cache key ignores code/data/policy identity: L278 `WHERE season=? AND cache_version=?`. A replay-code or policy change after a cache fill is served stale forever unless `CACHE_VERSION` is bumped by hand — the C08 fail-open pattern. (Currently empty, so latent.)
- P3 — `INPUT_TOKENS = 3500` reservation (L24) is asserted, not measured against packet size; `perReviewCost` gates the number of reviews so an under-estimate silently truncates the slate (`bets = candidates.slice(0, maxReviews)`, L305) — the first N candidates by season order, i.e. 2021 first, not a random or stratified sample.
- P3 — Learning memory `press_eligible` (L100-101) grants a 2-unit "press" from ≥40 prior conviction reviews inside the same paid run; that is in-run adaptation whose evidence is the run itself.

**Verdict.** Correctly labeled research-only and outcome-blind at the packet level; no promotion authority. Paid; not run in the live DB.

## 5. server/services/nfl-neural-replay.js (207 lines)

**Purpose.** Prequential audit of the online spread-residual network with a weekly ridge-logit cover calibrator.

**Flow.** `runHistoricalNeuralReplay` (L101-193): games 2018–2025 from `game_lines` with `a.home=0` join; per week: `ensembleLine(..., {includeChallengers:true})` → `spreadFeatureVector(line, {before: kickoff})` → `predictNetwork`; calibrator `fitNeuralDecisionCalibrator(calibrationMemory)` (needs ≥200) once per week (L138); selection when `probability_edge ≥ 0.02`, top 3/week (L157-160); after the week: push to `replayMemory`/`calibrationMemory`, `trainBatch(network, replayMemory.slice(-512))` (L173). Saves to `nfl_neural_replay_audits` (0 rows live).

**Tables.** Reads `game_lines`; writes `nfl_neural_replay_audits`.

**Time semantics.** Genuinely prequential; `evidence_class` string says so (L185). Selection/settlement at the closing spread and closing odds only; no opener field.

**Defects.**
- P3 — No opener disclosure at all (contrast nfl-replay.js). `home_spread` is the close (L104).
- P3 — `noVig` (L26-29) is proportional devig, while nfl-replay.js uses Shin (`shinNoVig`); the two engines' "market probability" differ by method.
- P3 — Reuses `uncertainty()` from nfl-replay.js (L13, L97) and so inherits the zero-bet-week omission.
- P3 — Training cutoff: `spreadFeatureVector(line, { before: cutoff })` uses each game's own kickoff, but the network is updated only after the whole week (L165-173) — conservative, fine; however `ensembleLine` with `includeChallengers:true` inside a research replay means the neural head is fed the all-inputs graph, not the champion graph — another unlabeled graph difference.

**Verdict.** Methodologically the most honest of the independent replays (true prequential), but it is an "opened research candidate" (L7-8), never run/persisted, and grades only at the close without saying so.

## 6. server/services/backtest.js (250 lines)

**Purpose.** Fantasy projection grading (MAE/RMSE/Spearman/CRPS/PIT) and weekly start/sit decision backtest. Not betting.

**Flow.** `actuals(season)` from `player_week_usage` (L26-41); `gradePoint`, `crps`, `gradeDistribution`, `baselines` (last season points / ESPN projection), `compare`, `weeklyDecisionBacktest` (L208-250) which uses a single season-long `ppg` ranking every week (no weekly refit; L220 `ranked = [...pool].sort((a,b)=>b.ppg-a.ppg)` inside the week loop but `pool` is fixed).

**Tables.** Reads `player_week_usage`, `player_season_stats`. Writes nothing.

**Defects.**
- P3 — `weeklyDecisionBacktest` labels itself "pregame ranking versus realized weekly outcomes" but the ranking is a season-level projection applied identically to all weeks — not the weekly decision the product makes; weekly-backtest.js exists precisely because of this (its header L3-22 says so).

**Verdict.** Fantasy-only; irrelevant to betting audit; keep out of betting reports.

## 7. server/services/weekly-backtest.js (223 lines)

**Purpose.** Week-by-week fantasy replay: at week W, `buildProjections({through: season, throughWeek: week-1, …})` (L109-111), graded on week W; candidate player heads scored alongside.

**Tables.** Reads via `actuals` (`player_week_usage`) and `buildProjections`. Writes nothing. Used by nfl-blind-audit.js:252 for the fantasy half of the blind audit.

**Time semantics.** Data cutoff is week-1; but `kOverride`, `recency`, `roleRecency`, `WEEKLY_ENSEMBLE_WEIGHTS` are constants fitted by `scripts/fit-*.mjs` over the same seasons — hyperparameters are not walk-forward.

**Defects.**
- P3 — Hyperparameter leakage by construction (L90-91, L135): `WEEKLY_ENSEMBLE_WEIGHTS` and shrinkage constants are global fits; the header claims "exactly the shape Stage 6.3 requires" (L20-22) for data, which is true, but not for tuned constants. Fantasy-only impact.

**Verdict.** Adequate for fantasy; not part of the betting audit.

## 8. server/services/weekly-walkforward.js (247 lines)

**Purpose.** Weekly refit of the football-first ridge residual model; predicts week W from all completed games through W−1 (2016 onward); learning-curve test.

**Flow.** One `game_lines` query (L111-115); per (season, week≥5): train = all rows before, `ridgeFit` λ=5 (L66-92), predict, bet if |lean| ≥ 1.0, grade cover vs close excluding pushes (L152-155); `summarise` (L182-247) with median split learning curve.

**Tables.** Reads `game_lines`; features via `footballFeatures` (module cache L51). Writes nothing. Route nfl-betting.js:1821 serves a cached report when `minLean === 1.0`.

**Time semantics.** True weekly walk-forward on the data; depends on `footballFeatures` being cutoff-safe (football-first.js:42-44 claims "strictly before the target, except the injury report"). Closing spread, no price (`BREAK_EVEN = 0.5238` assumed, L42).

**Defects.**
- P3 — No price: settles at an assumed −110 (L42, L187); stored `spread_odds` is ignored. Break-even z-tests are therefore approximate.
- P3 — `_features` module cache (L51) is never invalidated on data change (only `clearWalkForwardCache()`); a long-lived server serves week-W features computed before a late stat correction.
- P3 — Learning-curve split by `training_games` median (L195-198) confounds "more data" with "later season/later years"; the reading strings (L229-240) over-interpret a two-bucket z.

**Verdict.** Honest research walk-forward against the close; not an audit; no opener.

## 9. server/services/line-move-study.js (447 lines)

**Purpose.** Beat-the-close Phase 1: predict open→close move from features stamped at T0 (Pinnacle opener), S (third soft opener), T1 (Wed 16:00Z), T2 (Fri 16:00Z); CLV gate ≥ +0.3 pts with week-clustered bootstrap on holdout 2024–25.

**Flow.** `buildLineMoveDataset` (L117-256): `nfl_odds_archive` Pinnacle open/close + soft books; drops counted; ratings line from `fitModel()` or `fitRatings({selectionThrough})` (L132); matchup roles, QBR, weather, forecast history, nfelo, TeamRankings, event archive deltas; `lineMoveStudy` (L344-447): per market × decision time, `walkForward` (weekly refit, L318-329) and `holdout` (single fit <2024, L331-334); per-feature Holm; gate.

**Tables.** Reads `nfl_odds_archive`, `game_lines`; via helpers: ratings, matchup, `nfl_qbr`, weather, forecast history, nfelo, external ratings, event archive. Writes nothing (called by nfl-research/experiments? — route grep shows only beat-the-close consumes its results conceptually).

**Time semantics.** Explicit and mostly correct; T1/T2 CLV labeled "upper bound: no line stored" (L72-73). BUT:

**Defects / leakage.**
- P2 — T2 weather is the ACTUAL kickoff-hour weather: L197 `const wx = gameWeather(g.season, g.week, g.home); … features.T2.wind_kmh = wx?.wind_kmh ?? 0;` with the comment "the actual hour stands in for a Friday forecast". That is post-close information labeled as T2. The honest lead-2 forecast feature exists beside it (L202-205) and beat-the-close.js's `wind_total` rule basis (L52-53) already admits the actual-wind number (+0.47) fell to +0.28 on the knowable forecast — below the gate. The study report still carries the leaked feature.
- P2 — `team_move_tendency` (L174) and the `tendency` map (L134-141) are built from the full archive (all seasons including holdout) keyed by `season-1`; fine for chronology, but `fitModel()` default (L132) selects ratings hyperparameters with `selectionCap = lastSeason - 1` (nfl-market.js:130) i.e. on seasons through 2024 — inside the 2024–25 holdout — unless the caller passes `selectionThrough`. The `ratings_line` string discloses the selection window (L254) but the default study run is contaminated for the 2024 holdout year.
- P2 — nfelo `nfelo_pre_line` (L218) and TeamRankings (L219-220) are third-party model outputs; nfelo's published historical lines are a backfill of a model whose parameters were tuned on the full history. The code treats them as T0-knowable. This is exactly the plan's §8 caveat (line 559: "Exact historical availability and incremental value" unverified) and is the basis of the only "+CLV" signal (`nfelo_pre_vs_open`, +0.68). Its historical availability is unproven.
- P3 — `holdout` per-feature loop (L367-378) refits the T2 logistic on the training block and then constructs per-feature single-coefficient strategies with a made-up `p_home = 0.5 ± |coef·z|/4` (L372); Brier on those is meaningless; Holm across ~40 features with the same 570 games is fine for direction but the gate also lets `passed_features` through on `mean_clv ≥ 0.3` — features are correlated (ratings vs nfelo vs teamrankings all "vs open").
- P3 — Study `units` block (L426-435) grades at fixed 0.909/−1 ignoring archive prices; labeled descriptive.

**Verdict.** The most carefully time-stamped historical study in the set, and the origin of the only positive evidence (opener CLV). Two labeled leaks (actual weather at T2; ratings hyperparameter selection inside the holdout by default) and one unverifiable external (nfelo backfill) sit under the passed signals.

## 10. server/services/beat-the-close.js (449 lines)

**Purpose.** Phase 2 live shadow: snapshot signals per capture, freeze one zero-stake decision per game/market/signal when a centered signal clears its rule, settle by CLV vs Pinnacle's last pre-kickoff line; weekly read with two-week retirement.

**Flow.** `openerFor` (L64-76: archive open, else first live Pinnacle capture — disclosed via `source`); `pinnacleLineAt` (L79-89, `captured_at<=before`); `bestReachable` (L97-112) freshness-filtered; `signalsFor` (L124-160); `slateSignals` centers across ≥4 games (L163-180); `snapshotSignals` → `nfl_signal_snapshots` (34,359 rows live, 2026-09-02 → 2026-09-12); `decideBeatTheClose` (L200-262) → `shadow_decisions` (live: 61 frozen across 5 signals, 6 settled); `settleBeatTheClose` (L266-292); `weeklyRead` (L364-433) → `nfl_rule_state` (empty live); `runBeatTheClose` on scheduler.js:381-387.

**Tables.** Reads `nfl_teams`, `nfl_odds_archive`, `nfl_line_snapshots`, `game_lines`, `nfl_signal_snapshots`, `shadow_decisions`, `nfl_rule_state`; writes `nfl_signal_snapshots`, `shadow_decisions`, `nfl_rule_state`.

**Time semantics.** Prospective; `now` injectable; kickoff via `gameCutoff`. Settlement excludes post-kickoff prints (test L77-78). Retirement guard against double-reads (L397-410).

**Defects.**
- P2 — Two rules are live that the study did NOT pass: `ratings_vs_open_total` "candidate, not a passed signal" (L44) and `wind_total` "under the +0.3 gate. Candidate" (L52-53). §9.1/§9.2 require every attempted rule to be counted in the research register; these are frozen as if qualified and appear in `by_signal` alongside passed ones. `RULES` bases are prose, not a versioned register.
- P2 — Opener for live games falls back to the FIRST live Pinnacle capture (L79-82) which, for a slate captured from 2026-09-02 on a game whose true opener posted in May (test fixture `2026-05-15`), can be days after the true opener; `ratings_vs_open` then measures against a mid-week number while its `basis` cites Phase 1 opener CLV. Disclosed only as `opener_source` inside `detail_json`.
- P3 — `weeklyRead` bootstrap uses one shared `rand` (L394) across signals in a fixed order, so a signal's interval depends on how many signals precede it in `RULES` order — deterministic but order-coupled; reordering `RULES` changes intervals.
- P3 — `beatTheCloseStatus` `readable: b.clv.length >= 30` and the Phase-3 gate string "≥ 200 settled" (L354) are two different thresholds in one payload.
- P3 — `decideBeatTheClose` freezes at `bestReachable` (soft-book best line) but settles CLV against Pinnacle (L275-277); the study's S-basis CLV was against the soft opener. Mixed reference; not versioned.

**Verdict.** The only forward, zero-stake, timestamped experiment in the set; correctly stake-0 and retirement-gated. Live evidence is tiny (6 settled). Two unpassed rules are running as if passed, and the live "opener" is not the study's opener.

## 11. server/services/nfl-family-contribution.js (444 lines)

**Purpose.** C16 family report: full ensemble vs leave-one-family-out, scored on the common candidate universe for margin MAE, conditional/three-state cover Brier, and units/ROI, with paired weekly bootstrap.

**Flow.** `familyContributionReport` (L300-397): configs `all` + `without:<family>`; each → `replaySeason(season, { markets, modelOptions: { weighting:'exponential', families } })` (L319); universe = intersection of decision keys (L316-317); `scoreOver` (L91-170); `pairedDelta` (L235-278); `decideFamily` (L393-444).

**Tables.** None directly (replaySeason reads game_lines; fit artifacts). Route nfl-betting.js:1417. Live DB has no family-contribution table; the report is not persisted here.

**Time semantics.** Inherits replaySeason (walk-forward fit per cutoff, raw blend, closing price).

**Defects.**
- P2 — `ablation_kind: 'refit_leave_one_family_out'` (L390) is false. `ensembleLine` passes `families` only to the `MODELS.filter` at nfl-ensemble.js:1257 and calls `fitEnsemble({ beforeSeason: season, beforeWeek: week, weighting, includeChallengers })` at :1238 with no `families`; `blend()` renormalizes the full-fit weights over the survivors. This is frozen-fit removal sensitivity, exactly what C16 says must be distinguished; the plan's status row concedes it is "not yet distinguished".
- P2 — Graph mismatch: default `blendMode` is `raw` (see §1), while the served graph is `market_residual`; C16 names this ("default graph is raw historical/closing replay, not the intended T−60 residual graph"); unchanged.
- P2 — `cost.share_of_ensemble = model_count / ensembleFeatureContracts().length` (L375): family count presented as cost; C16: "Measure runtime cost, do not infer it from model count."
- P3 — No identities saved: no fit artifact key, code hash, calibration id, cutoff manifest, or universe hash on the returned object (C16 "Save graph/cutoff/universe/calibration identities").
- P3 — `familyConsumers` `numerical_consumer` is derived from registry flags, not from the actual `margin_weight`/`residual_weight` at any cutoff; a production-flagged family with weight 0 everywhere still reads `production_ensemble`. `base_margin_weight` is now available from `featureContracts` but unused here.
- P3 — Duplicate engine: `nfl-research.js:120-146` runs the same family ablation ROI-only via `trainingIteration`, writes `nfl_feature_ablation_audits`, and asserts "Each configuration REFITS the ensemble … true leave-one-family-out ablation" (L139-142) — a stronger false claim than this file's.

**Verdict.** Scoring corrected and pinned by tests; the ablation label, cost proxy, and graph remain as C16 left them. Two ablation engines coexist with contradictory honesty.

## 12. server/services/nfl-feature-coverage.js (87 lines)

**Purpose.** Inventory of variable families and counts; freezes a per-(season, week) snapshot into `nfl_feature_coverage_snapshots` (append-only triggers per migration).

**Defects.**
- P3 — `nflFeatureCoverage()` is a global, now-time inventory (`generated_at`, all seasons; L19-23 `GROUP BY t.season` with no cutoff), yet `freezeFeatureCoverageSnapshot(season, week)` labels it as the variables "that can exist at each weekly cutoff" (L1). The snapshot is "what the tables held when frozen", not "what was available at that week".

**Verdict.** Not a replay; harmless inventory with a mislabeled as-of claim.

## 13. scripts/audit-football-first.mjs (163 lines)

**Purpose.** Preregistered audit via `audit-registry`: football-first lean (fitted on seasons strictly before N) vs closing spread, 2021–25, MIN_LEAN 1.0, break-even 0.5238.

**Flow.** `preregister` (L58-71) then `runAudit` (L75-136) over `game_lines` week≥5; `footballFirstLean(season, week, home, away, {target:'margin'})`; pushes skipped; one-sided z.

**Time semantics.** Per-season fit (`fitResidualModel(beforeSeason)` per football-first.js:253-259, five prior seasons), closing line, disclosed "second look" at a prior 2024–25 test (L47-52).

**Defects.**
- P3 — Each invocation files a NEW preregistration row (L58); re-running the script for any reason multiplies registry entries (by design, but there is no idempotency guard or dry-run flag).
- P3 — No price: assumed −110 (L41); same as weekly-walkforward.

**Verdict.** Correctly preregistered and counted; a single-fit-per-season research audit against the close.

## 14. scripts/audit-trend-totals.mjs (205 lines)

**Purpose.** Preregistered audit: pace/efficiency trends (through week−1, lookback 3) vs closing total; recorded result 194 bets, 43.81%, z −2.39 (header L43-46).

**Time semantics.** Cutoff-safe via `teamTrends(…, {throughWeek})`; pushes skipped; closing total.

**Defects.**
- P3 — Same re-run/preregistration multiplication as §13. Header candidly warns against the "bet the opposite" temptation (L58-63).

**Verdict.** Sealed negative result; nothing to fix beyond idempotency.

## 15. Tests (7 files, 1,156 lines)

- `test/nfl-execution-replay.test.js` (318): 26 tests; covers every outcome, determinism, time-shift invariance, tape removal vs silence, E7 states. Strong.
- `test/nfl-replay-error-analysis.test.js` (186): sign fix, Holm on 2,200 noise bets, effect gate, overlap, leave-one-season-out, overlap refusal. Fixture-only; does not exercise `replaySeason`.
- `test/nfl-replay-opener-disclosure.test.js` (92): pure-function tests of the two opener diagnostics; asserts notes never say "Same picks". Does not test that `replaySeason` wires both onto bets (it does at L247-248, L275-276) — untested integration.
- `test/line-move-study.test.js` (105): synthetic archive with one planted S-time signal; asserts T0 noise, S signal, Holm suppresses noise, `includeModels:false` — so none of the leak-prone model features (§9 P2s) are under test.
- `test/beat-the-close.test.js` (102): opener from archive, best reachable, stale-price exclusion, settlement CLV arithmetic with a hand-inserted decision. Does not test `decideBeatTheClose` freezing (ratings model absent), centering, or `weeklyRead` retirement.
- `test/nfl-family-contribution.test.js` (237): catalog-derived families, consumer classification, scoreOver (push exclusion 0.843/0.81, reconciliation, market MAE, universe), paired bootstrap, decideFamily asymmetry. Fixture-only; the report path (`familyContributionReport`) and the refit claim are untested.
- `test/family-contribution-scoring.test.js` (116): 9 challengers / 31 components / 17 Efficiency; conditional 0.25, legacy 0.3025, three-state 0.515 and 1.215; null handling. Pins C16's scoring fix.

No test anywhere asserts which `blendMode` the historical replay uses, or that `families` reaches `fitEnsemble`.

## 16. Duplication map

| Question | Engines answering it |
|---|---|
| Historical spread ROI 2021–25 | `replaySeason` via: blind audit (THE audit, runs 27/32), `trainingIteration`, `candidateInputComparison`, `nfl-experiments`, `nfl-research` ablation, `nfl-family-contribution`, `nfl-ai-replay` candidates |
| Family contribution | `nfl-family-contribution.js` (3 answers, paired) AND `nfl-research.js:120-146` (ROI-only, false refit claim) |
| Football-first vs close | `weekly-walkforward.js` (weekly refit) AND `scripts/audit-football-first.mjs` (per-season fit) |
| Opener-move prediction / CLV | `line-move-study.js` (historical) → `beat-the-close.js` (live shadow) — intended pair, not duplicate |
| Neural residual | `nfl-neural-replay.js` (own loop) — plus council `deep_residual` (out of scope) |
| Weekly cluster bootstrap | `nfl-replay.uncertainty` (zero-bet weeks omitted), `line-move-study.clvSummary`, `beat-the-close.weeklyRead`, `nfl-family-contribution.pairedDelta` — four implementations, three RNGs |

## 17. Point-in-time guarantees (what actually holds)

- Ensemble fit cutoff `beforeSeason/beforeWeek` per game week (nfl-ensemble.js:1238); fit artifacts keyed by cutoff + data fingerprint.
- Historical replay applies the historical policy (`NFL_HISTORICAL_REPLAY_POLICY`), not today's gate.
- Opener is nulled inside the ensemble context for completed games (nfl-ensemble.js:1247 `CASE WHEN team_score IS NULL THEN open_spread END`).
- Neural replay: weekly prequential update after all of the week's forecasts.
- Line-move study: every feature stamped T0/S/T1/T2, T1/T2 CLV labeled upper bound; walk-forward and holdout both reported.
- Beat-the-close: `captured_at<=kickoff` close; post-kickoff prints excluded (tested).
- Execution replay: `observedThrough`, `kickoffAt`, staleness, and availability_basis — never asserts an unobserved fill.
- Not guaranteed: replay graph = served graph; family ablation = refit; T2 weather knowable; ratings hyperparameters outside holdout; nfelo lines historically available; zero-bet weeks in the bootstrap.
