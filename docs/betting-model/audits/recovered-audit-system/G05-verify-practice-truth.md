# G05 adversarial verification (lens = practice-truth)

Gap: "Historical audit grades a forecast that is not served (raw vs market_residual blend)."
Question: is the SHOULD-BE ("replay and board call one function with an explicit, recorded blendMode
carried in spec_json and spec_hash; runs 27/32 relabelled 'raw-blend closing-line development record'")
a genuine backtest/ledger principle, or opinion dressed as a standard? Can it apply at 272 games/season?

Verdict: NOT refuted. The should-be is (a) the repository's own already-adopted, already-tested standard,
applied to the forecast graph in three places but not in the replay/blind-audit lineage, and (b) the
generic train/serve-parity + declared-identity principle of any backtest ledger. It is a recording and
identity requirement that consumes no additional data, so NFL sample size cannot bear on it.

Repo read-only; DB via node:sqlite readOnly:true (scratchpad g05-db.cjs, g05-db2.cjs, g05-db3.cjs).
All four assigned files read in full: nfl-auto-picks.js 285, nfl-replay.js 1102, nfl-ensemble.js 1423,
nfl-blind-audit.js 1005. No web lookups; external references below are cited from memory, not fetched.

## 1. CURRENT state — every claim re-verified

| Claim | Evidence |
|---|---|
| Replay never sets blendMode | nfl-replay.js:187 `modelOptions = {}` default; :225 `ensembleLine(season, g.week, g.home, g.away, { includeEvidence: false, ...modelOptions })` |
| Ensemble default is raw | nfl-ensemble.js:1221 `weighting = 'exponential', families = null, blendMode = 'raw', includeEvidence = true,`; :1299 `const margin = blendMode === 'market_residual' ? residualMargin : rawMargin;` |
| Board forces market_residual | nfl-auto-picks.js:83 `modelOptions = { blendMode: 'market_residual', ...modelOptions };`; :18 `COORDINATED_DECISION_VERSION = 'coordinated-market-residual-v2-graph-bound'`; :177 `base_blend: e.blend_mode` |
| Blind audit inherits raw | nfl-blind-audit.js:284 `replaySeason(season, { startWeek: week, endWeek: week, markets: [market] })` — no modelOptions; :307 the explanation call likewise `ensembleLine(season, week, b.home, b.away, { includeEvidence: false })` |
| Blend mode not in spec_json / spec_hash | nfl-blind-audit.js:171-196 `normalizeSpec` fields: protocol, classification, seasons, weeks, schedule, domains, player_engine, …, `betting_policy: NFL_HISTORICAL_REPLAY_POLICY` (:183), expert_council, postgame_truth, rules. :211 `specHash = sha(JSON.stringify(spec))`. No blend/model-options field. |
| DB confirms for runs 27/31/32 | nfl_blind_audit_runs spec_json: `contains 'blend'? false, 'modelOptions'? false, 'market_residual'? false` for all three. Each run's first week result_json `betting.metrics.config.modelOptions = {}` and the whole week result contains neither `blend_mode` nor `blendMode`. |
| Mismatch was live when the runs froze, not only now | Runs froze at commits b4616b46 (run 27, 2026-09-08), 969d501e (run 31, 2026-09-09), f92719ee (run 32, 2026-09-10). `git show` at each: nfl-auto-picks.js already has `blendMode: 'market_residual'` (lines 81/82/83), nfl-replay.js calls ensembleLine without blendMode (174/182/224), nfl-ensemble.js default `blendMode = 'raw'` (1048/1048/1133). Production has forced market_residual since 8582fd1 (2026-08-31 "Coordinate NFL residual decision engine"). |
| No test asserts the replay's blend mode | Tests touching replaySeason / blind audit: blind-audit-lookback, empty-state, model-integrity, nfl-blind-audit-team-scope, nfl-cover-identity, nfl-family-contribution, nfl-moneyline-domain, nfl-replay-error-analysis. Only nfl-cover-identity.test.js asserts a blendMode on replay calls (:74) — and that is for the cover-calibration builder, which forces it explicitly (nfl-cover-calibration.js:276). model-integrity.test.js's four "blend" hits (:846, :853, :888, :945) are about challenger/convex/durability blends, not blendMode. |

## 2. Stronger than stated: the served graph has NO historical bet record at all

market_residual only departs from the market when at least one component passes the residual gate:
- nfl-ensemble.js:1187-1189 `m.residual_gate_passed = … && m.residual_diagnostic_passed; m.residual_weight = m.residual_gate_passed ? … : 0;`
- :1291-1295 `residualModels = perModel.filter(… m.residual_weight > 0 …)`; `residualMargin = marketMargin != null && residualWeight > 0 ? … : marketMargin;`
- :1319 `spread_edge: … r2(margin - marketMargin)`; nfl-replay.js:234 `edge = e.projected_margin - marketMargin`; nfl-policy.js:21 `minEdge: 3`, :201 `edge_points < policy.minEdge → 'edge_below_threshold'`.

DB scan of ALL 847 rows of nfl_ensemble_fit_artifacts (versions v7, v8, v9, v10; cutoffs 2016|10 … 2026|2 and 'live'): `withAnyResidualGatePass = 0`. Not one component has ever passed the gate under any fit version at any cutoff.

Therefore a market_residual replay of 2021-2025 would yield projected_margin == market margin on every game, edge 0, and zero spread bets. The −7.7% (run 27) and −7.1% (run 32) records are entirely records of the raw blend; the served forecast's honest historical record is "all abstain". The two are not "slightly different forecasts", they are different objects: one has 153 bets, the other has 0. That is exactly why the label must say which graph was graded.

Note the production board itself confirms this is the served behaviour: nfl-auto-picks.js:141-143 filters `weightedModels` by `residual_weight > 0` when `blend_mode === 'market_residual'`; with none passing, `activeModels` is empty and `margin_models_active: 0` is what is written to feature_snapshot.

## 3. Is the SHOULD-BE a genuine principle? (practice-truth)

### 3a. It is the repository's own standard, already adopted and tested — applied everywhere except here

1. Forecast identity includes blend_mode by design. nfl-forecast-identity.js:41 `const blendMode = modelOptions.blendMode ?? 'market_residual';` :50 `blend_mode: blendMode, weighting,` inside the descriptor whose sha256 is the identity (:58). The header (:3-4): "This binds algorithm/configuration and information regime."
2. A calibrator fitted on one blend mode is refused for another. test/nfl-cover-identity.test.js:57-70 "forecast identities … distinguish every implemented forecast choice" — `live({ modelOptions: { blendMode: 'raw' } }).id !== base.id` (:62-67); :68 `coverCalibrationVersion({...descriptor blend_mode:'raw'})` throws; :97-100 "legacy passed-gate fits do not authorize an unidentified or changed forecast".
3. The cover-calibration builder does precisely what the should-be asks of the replay: nfl-cover-calibration.js:276 `modelOptions = { blendMode: 'market_residual', ...modelOptions };` :280 `spreadForecastIdentity({ modelOptions, informationRegime: 'historical_weekly_closing' })`; :285 passes `modelOptions` into `replaySeason`; :323 stamps `forecast_identity` into the persisted metrics; test :73-74 asserts every replay call carried `blendMode === 'market_residual'`. So "one function (replaySeason) with an explicit, recorded blendMode" is already the house pattern one file away.
4. The policy layer already applies the same rule to its own divergence. nfl-policy.js:1-6 "One frozen decision policy for NFL live picks and historical replay … production and replay must select the same markets, threshold, disagreement guard, ranking, and weekly capacity." :84-86 "Historical diagnostics grade the selector that existed before the current calibration gate. Name that contract explicitly so an audit manifest never claims to test today's production policy while executing this older rule." The divergence in policy is DECLARED (id `nfl-spread-historical-replay-v1`, version 1.0.0, `authority: 'diagnostic_only'`) and lands in spec_json (blind-audit.js:183). The divergence in forecast graph is UNDECLARED. The should-be asks for the forecast graph to be treated the way the repo already treats policy.
5. The experiments module records blendMode in the frozen spec. nfl-experiments.js:38 `const blendMode = raw.modelOptions?.blendMode ?? 'raw';` :51 returns `modelOptions: { weighting, families, blendMode }` — the locked experiment config carries it explicitly, defaults included.
6. The plan (docs/CLAUDE-NEXT-STEPS.md) states it as a requirement, not a preference:
   - :326 (C16 fix) "Save graph/cutoff/universe/calibration identities."
   - :324 "The report's default graph is raw historical/closing replay, not the intended T−60 residual graph."
   - :412 "Do not average predicted margins and then silently reuse a calibrator fitted for a different final graph."
   - :584 "Label historical reconstruction and real prospective observation separately."
   - :46 "A corrected accounting report must retain the original and clearly explain its correction."
   - :654 assigns nfl-replay.js the deliverable "graph identity".
   - docs/evidence/2026-09-09/AUDIT-EVIDENCE.md:257-261 (M06 "Calibrate the forecast path that is actually served"): "Build one pure prediction API for live/replay with explicit cutoff, model artifact, features, market quote and event rules. Calibration artifacts name/hash that exact probability-producing pipeline."
   - docs/evidence/2026-09-10/IMPLEMENTATION-SUMMARY.md:28-30 already concedes in prose: "the blind audit replays with `blendMode: 'raw'` (its long-standing default, per finding M06 — it does not exercise the `market_residual` blend's residual-skill gate at all)". The disclosure exists in a document; it does not exist in the run's spec, hash, label or result rows, which is what the should-be fixes.

### 3b. It is also the generic, widely-held principle (cited from memory, not fetched)

- Train/serve parity: Google "Rules of Machine Learning" (developers.google.com/machine-learning/guides/rules-of-ml) Rule #29 (log the features used at serving and train on those), Rule #32 (re-use code between training and serving pipelines), Rule #37 (measure training/serving skew). Sculley et al., "Hidden Technical Debt in Machine Learning Systems", NIPS 2015 (training/serving skew; configuration debt — configuration must be versioned and reviewed). A backtest of a graph that is not served is the textbook instance of skew.
- Backtest = the deployed decision function, declared in advance: López de Prado, Advances in Financial Machine Learning (2018), ch. 11 "The Dangers of Backtesting"; Bailey, Borwein, López de Prado, Zhu, "Pseudo-Mathematics and Financial Charlatanism" (Notices of the AMS, 2014). A backtest is a statement about one exact strategy; unrecorded configuration makes the number unattributable.
- Preregistration: the preregistered spec must name the model/estimator being tested (Nosek et al., "The preregistration revolution", PNAS 2018). This repo's blind audit calls itself preregistered (nfl-blind-audit.js:8 "refuses to open week N+1 if any of them change after preregistration") and hashes code+data+policy — but not the forecast graph the code will select, because it is chosen by an implicit default.
- Append-only identity / labelled ledgers: the plan's own C01 (:166-172) "hash canonical immutable content including the complete forecast/dependency identity".

None of these is an opinion of the A05 auditor; the repo cites or implements each of them somewhere.

### 3c. Attempted refutations, and why they fail

- "raw IS the historical policy, deliberately." No: nfl-policy.js:87-99 NFL_HISTORICAL_REPLAY_POLICY has no blend field; the historical-policy comment at nfl-replay.js:209-211 is about the calibration gate, not the forecast graph. And production had already switched to market_residual (8582fd1, 2026-08-31) eight days before run 27 froze; raw was never "the served graph at the time" for these runs. (The only served-raw rows in nfl_auto_picks are the three 2026-W1 picks selected 2026-08-05T00:40Z, which predate abecd7b, the commit that introduced blend modes.)
- "The default is documented, so it is declared." A default in a function signature (nfl-ensemble.js:1221) is not a declaration in the run record. The spec hash is `sha(JSON.stringify(spec))` (blind-audit.js:211) over a spec with no blend field; a future change of the default to market_residual would leave spec_hash and betting_policy identical while changing every number — precisely the failure the repo's own C15 comment forbids for policy (nfl-policy.js:11-17 "two materially different economics ran under one version").
- "The runs are already labelled development data." Partly: classification `historical_algorithmically_blind_replay` (:176), rule :193, naming :999, plan §1.2 "Negative historical development record". None says which forecast graph; and section 2 shows the graph is the whole story (153 bets vs 0). Adding "raw-blend" is a truthful, zero-cost correction the plan's :46 rule requires.
- "One function is impossible because the board also does neural substitution and the calibration gate." The should-be asks for one forecast function with an explicit blend mode; policy layers may legitimately differ and are already declared. M06 asks for exactly this ("one pure prediction API for live/replay"). nfl-cover-calibration.js:276-285 proves it is a one-line change on the replay side.

### 3d. Sample size (272 games/season, ~153 bets in the record)

Irrelevant to this gap, for three reasons:
1. The should-be adds a recorded field and a label; it consumes no observations.
2. At n≈153 the run's own bootstrap interval is [−23.2%, +7.4%] ROI (IMPLEMENTATION-SUMMARY.md:39-41), far wider than any blend-mode effect — so the mismatch cannot be detected statistically and must be declared structurally. Small n makes explicit identity more necessary, not less.
3. The served graph would place 0 bets on the same 2021-2025 slate (section 2). No sample size makes a 153-bet record and a 0-bet record comparable.

## 4. Verdict

refuted = false. The should-be is the repo's own forecast-identity / declared-divergence standard
(nfl-forecast-identity.js:41-50; nfl-policy.js:84-86; nfl-cover-calibration.js:276-285 with its test :73-74;
plan :326, :412, :584; M06), and the generic train/serve-parity and preregistration principle. Runs 27/31/32
carry no blend identity in spec_json/spec_hash (DB), were frozen while production already served
market_residual (git), and grade a raw graph whose served counterpart would have placed zero bets
(847/847 fit artifacts: residual gate never passes).

Suggested precision to the gap wording (not a refutation): the relabel should say the served graph has
no historical bet record ("raw-blend closing-line development record; the served market_residual graph
abstains on every 2021-2025 game because no component has ever passed the residual gate"), because
"a different forecast" understates it.
