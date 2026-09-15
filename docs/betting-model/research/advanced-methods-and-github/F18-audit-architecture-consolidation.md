# F18 — Audit/CLV Architecture Consolidation

Researcher: F18-audit-architecture-consolidation (bucket: fix)
Repo scanned read-only: /Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard

## 1. What's actually in the repo (grepped, not assumed)

Duplicate audit/registry/CLV surfaces found by file search:

- `server/services/nfl-blind-audit.js` (1005 lines) — its own content-addressed
  freeze: `codeHash()`-style logic inline, `INPUT_TABLES` list, mutation-journal
  triggers, `sha()` helper.
- `server/services/audit-registry.js` (333 lines) — a SEPARATE codeHash()
  (hashes every .js file in the services dir) + dataSignature() (row counts
  across 6 tables) + preregister()/alwaysValidPValue-based significance.
- `server/services/nfl-engine-registry.js` (196 lines) — a THIRD independent
  content-addressing scheme: `digest = value => sha256(JSON.stringify(value))`,
  producing a "GRIDIRON_ENGINE_SCHEMA" version distinct from the other two.
- `server/modeling/contracts.js` — a FOURTH: `configurationHash()` over
  `stableJson()` (canonical key-sorted JSON), used only by
  `server/modeling/registry.js` (the ML-head training experiment registry) and
  the fantasy walk-forward pipeline (`PIPELINE_VERSION =
  'gridiron-fantasy-walk-forward@1.0.0'`).
- Grepping `createHash('sha256')` / `codeHash` / `dataSignature` across
  `server/services/*.js` hits **37 separate files** independently rolling their
  own content-addressing (nfl-bitemporal.js, nfl-contract-key.js,
  nfl-evidence-dataset.js, nfl-decision-tape.js, nfl-experiments.js,
  nfl-feature-coverage.js, nfl-forecast-identity.js, nfl-live-ledger.js,
  nfl-model-growth.js, nfl-online-neural.js, nfl-orthogonal-specialists.js,
  nfl-postgame-truth.js, nfl-prop-*.js, nfl-quote-tape.js, nfl-replay.js,
  nfl-risk-lab.js, nfl-signal-reliability.js, nfl-team-card.js,
  nfl-teaser-execution.js, nfl-unified-engine.js, nfl-weekly-feature-store.js,
  role-scenario-lab.js, weekly-learning.js, model-governance.js, and more).
  This is the mechanism behind tonight's "5-7 duplicate audit engines" finding:
  there isn't one thing to fix, there's ~37 things independently reinventing
  "what code+data produced this number," none of which agree with each other.

CLV specifically — 4 modules confirmed with genuinely different math (the
FOUND note says 5 across 4 tables; the file search turned up these 4 plus
`nfl-audit-overview.js` reusing `nfl-replay.js`'s uncertainty math for a
spread-scoped CLV-adjacent number, which is the likely 5th):
- `nfl-clv.js` — `gradeClosingLineValue()`: signed points with an explicit
  totals-side inversion (`b.market === 'totals' && b.side === 'Under' ? ...`),
  fair-probability via `noVigProbability`, writes to `nfl_bet_log`.
- `nfl-execution-clv.js` — `spreadClvPoints()`: assumes lines are **already**
  expressed from the backed side's perspective ("Both lines are already
  expressed from the backed side's perspective by the contract key") so it
  does NOT do the totals-side inversion nfl-clv.js does — a different sign
  convention for the same physical quantity, reading `DEFAULT_CLOSING_BOOKS`
  and its own contract-key join.
- `nfl-execution-clv-downsize.js` — a third layer: `evaluateClvWindow()` /
  `weekClusteredMeanCi()` (Student-t CI over week-clustered CLV observations)
  feeding a staking-multiplier ladder (`CLV_DOWNSIZE_POLICY`) — consumes CLV as
  an *input* rather than computing it, but from yet another aggregation path.
- `nfl-prop-clv.js` (735 lines) — implied-probability-based `clv` (`close.
  implied_probability` vs `quote.implied_probability`, expressed ×100 as a
  percentage, not points), its own devig, its own settlement/finalization.

No shared function anywhere computes "CLV" once. Four different tables
(`nfl_bet_log`, the execution-clv contract-key join, whatever
`nfl-execution-clv-downsize.js` reads as `history`, and the prop-quote tables)
each store their own CLV number, in different units (points vs probability
vs percentage), with different sign handling.

## 2. The genuinely important discovery: a real registry already exists, unused by the audit layer

`server/modeling/registry.js` + `server/modeling/sqlite-store.js` +
`server/migrations/005_model_registry_integrity.js` is a **working, tested**
model registry with almost exactly the shape the topic asks for:

- `model_dataset_versions` (content_hash, cutoff_at) and
  `model_feature_versions` (contract_json, content_hash, name+version unique)
  — i.e. versioned dataset/feature identities.
- `model_experiments` keyed by `configurationHash({spec, dataset_version_id,
  feature_version_id})` (`server/modeling/contracts.js`) — so identical config
  against a new dataset gets a new id instead of colliding.
- `model_backtests` with `protocol CHECK IN ('walk_forward','sealed_holdout')`.
- `model_metrics` with `split CHECK IN ('discovery','validation','holdout',
  'forward')`.
- `ModelRegistry.promote()` / `.rollback()` enforcing `REQUIRED_GATES =
  ['schema','leakage','data_quality','baseline_improvement','tests']` via
  `assertPromotable()`, gated by `model:train`/`model:promote` permissions,
  with `atomicPromote()` recording `model_promotion_history`.
- Real usage: `nfl-experiments.js`, `mlb-experiments.js`, `nfl-evidence.js`,
  `server/routes/model.js`, `client/src/features/model-lab/
  ModelRegistryPanel.tsx`, and it is covered by
  `test/model-registry-persistence.test.js` (auth, gates, promotion, rollback
  all exercised end-to-end through real HTTP routes against a temp sqlite db).

**This registry is never imported by `nfl-blind-audit.js`, `audit-registry.js`,
or any of the 4 CLV modules.** Those surfaces don't have a `promote()`, don't
write to `model_dataset_versions`/`model_feature_versions`, and each freezes
its own idea of "the data as it stands" independently. The consolidation
problem tonight's audit found is not "we need to invent feature-store/registry
architecture" — Gridiron already built one correctly, once, for ML-head
training, and then let the audit/backtest/CLV surface grow its own competing,
worse copy instead of using it. That reframes most of the "fix" work as
wiring, not invention, which is why the fix candidates below are cheap.

Separately, `server/modeling/contracts.js` already has a real point-in-time
leakage guard, `assertTimestampedObservation()` — checks `available_at <=
as_of` for both the observation and every feature, throws `future-data
leakage: ...` — but it is scoped to `PIPELINE_VERSION =
'gridiron-fantasy-walk-forward@1.0.0'` only. Nothing calls it from the NFL
betting side (`nfl-team-strength.js`, `nfl_team_week_features`,
`nfl_play_by_play`) that `nfl-blind-audit.js` freezes and replays every week.

## 3. Primary sources (read in full where marked)

1. **Sculley, D. et al., "Hidden Technical Debt in Machine Learning Systems,"
   NeurIPS 2015.**
   https://proceedings.neurips.cc/paper_files/paper/2015/file/86df7dcfd896fcaf2674f757a2463eba-Paper.pdf
   read_in_full: true (fetched and read the body via WebFetch + saved PDF).
   Key result: names "pipeline jungles" (ad hoc scrape/join/sample chains that
   accumulate as new signals get bolted on) and "glue code" (can be 95%+ of a
   mature ML codebase) as concrete, named technical-debt categories, plus
   "undeclared consumers" (silent downstream dependents that break when a
   pipeline changes) and "configuration debt" (untracked hyperparameters/flags
   proliferating without governance). The paper's own prescription is blunt
   and directly on-topic: pipeline jungles "can only be avoided by thinking
   holistically about data collection and feature extraction," and sometimes
   the fix is to scrap the jungle and redesign from scratch rather than patch
   it incrementally — exactly the choice this audit is facing with 37
   independent content-addressing implementations. No quantitative benchmark
   (this is a position/taxonomy paper drawing on Google's internal systems,
   not an experiment) — cited as the naming/diagnosis source, not a numeric
   result.

2. **Breck, E., Cai, S., Nielsen, E., Salib, M., Sculley, D., "The ML Test
   Score: A Rubric for ML Production Readiness and Technical Debt Reduction,"
   IEEE Big Data 2017.**
   https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf
   read_in_full: true (fetched full 8-page PDF, read all sections directly,
   including all 4 test tables and the scoring table).
   Sample/result: interviewed maintainers of 36 real production ML systems at
   Google. Result actually measured: "none of these tests was implemented by
   more than 80% of teams" surveyed, and "most tests had a nonzero score for
   at least half of the teams" — i.e., even at a company with a strong testing
   culture, most ML-specific production tests are partially or fully skipped.
   The rubric itself: 28 tests across 4 categories (7 Data tests — e.g. "Data
   1: feature expectations are captured in a schema," "Data 7: all input
   feature code is tested"; 7 Model tests — e.g. "Model 1: every model spec
   is code-reviewed and checked in," "Model 5: a simpler model is not better"
   [mandatory baseline comparison]; 7 Infra tests — "Infra 1: training is
   reproducible," "Infra 6: models are canaried before serving," "Infra 7:
   models can be quickly and safely rolled back"; 7 Monitoring tests —
   "Monitor 3: training and serving compute the same values" [training/serving
   skew], "Monitor 7: prediction quality has not regressed"). Score = 0.5pt
   per test run manually + documented, 1pt if automated and repeated;
   **final score = MINIMUM across the 4 category sums** (deliberately, so no
   single strong category masks a weak one). Score bands (Table V): 0 =
   "more of a research project than a productionized system" up to >5 =
   "exceptional." Limitation the paper itself states: all 28 tests are
   equally weighted regardless of a team's actual risk profile, and the score
   "reduces the extent to which an individual's efforts are reflected" since
   it takes a minimum across categories.

3. **Chen, A. et al. (Databricks), "Developments in MLflow: A System to
   Accelerate the Machine Learning Lifecycle," DEEM '20 (SIGMOD workshop),
   2020.**
   https://people.eecs.berkeley.edu/~matei/papers/2020/deem_mlflow.pdf
   read_in_full: true (fetched full 4-page PDF, read every page).
   Key result: describes the MLflow Model Registry, introduced specifically
   because organizations using MLflow Tracking at scale independently reported
   the same downstream pain — no single hub to catalogue which model version
   is authoritative, versus experiment-tracking sprawl. The Registry adds
   exactly 4 stages (Development → Staging → Production → Archived), a
   `transition_model_version_stage()` API with request/approve semantics
   between data-scientist and deployment-engineer roles, and per-user/per-role
   access restriction on who can transition a stage — i.e. promotion is a
   governed state machine, not a file overwrite. Paper reports (self-reported
   adoption claim, not an experiment) "users are managing millions of models"
   through the Registry across "energy, biotechnology, and online retail"
   sectors. Directly comparable to Gridiron's own `ModelRegistry.promote()` /
   `REQUIRED_GATES` — Gridiron's design (schema/leakage/data_quality/
   baseline_improvement/tests gates + role permission check) is structurally
   the same idea MLflow formalized, already correctly built once in this repo,
   just not applied past the ML-head training surface.

4. **Uber Engineering, "Meet Michelangelo: Uber's Machine Learning
   Platform," 2017 (primary source for the "feature store" architecture
   pattern; foundational, widely cited industry source rather than a
   peer-reviewed paper).**
   https://www.uber.com/blog/michelangelo-machine-learning-platform/
   read_in_full: true (fetched and read via WebFetch).
   Concrete numbers: ~10,000 features in a shared catalog at the time of
   writing, computed once and reused across "dozens" of independent modeling
   teams; **stated problem it solved**: teams were independently rebuilding
   identical features before the feature store existed — the same "duplicate
   work" failure mode as Gridiron's 37 independent identity/hashing
   implementations, just one layer up (features instead of audit-run
   identity). Mechanism: a single DSL applies "the same expressions... at
   training time and at prediction time," and batch features are computed
   once from HDFS into Cassandra so "the same data and batch pipeline is used
   for both training and serving" — this is the direct analogue of Gridiron's
   own (currently narrow) `assertTimestampedObservation()` point-in-time
   check, generalized into an actual queryable, versioned, shared feature
   layer rather than a leakage assertion called from one pipeline.

## 4. Do-not-do

- Do not build a fifth "unified CLV module" that leaves the 4 existing ones in
  place "for compatibility" — that produces a 6th disagreeing implementation
  and a false sense of progress. Delete call sites into the old modules as
  part of the same change, not after.
- Do not invent a brand-new registry/feature-store framework from scratch —
  `server/modeling/registry.js` + `sqlite-store.js` + migration 005 already
  pass a real persistence/auth/promotion test suite. Extending that schema is
  strictly cheaper and lower-risk than a parallel new one, and building a
  second registry is literally the disease this research is diagnosing.
- Do not let "consolidation" become a rewrite of `nfl-blind-audit.js`'s
  leakage-freeze logic (INPUT_TABLES, mutation-journal triggers) — that part
  is doing real, working, load-bearing work (the codeHash + input-mutation
  freeze that makes weeks non-reopenable). Consolidate the *identity/versioning
  primitive* it uses, not the audit's actual freeze semantics.
- Do not adopt an external feature-store product (Feast/Tecton) wholesale for
  a single-operator SQLite project — the pattern (point-in-time joins,
  one shared definition per feature) is the transferable part; the
  infrastructure (a separate online/offline store, Spark/Cassandra) is not
  worth the operational cost here.
- Do not apply the ML Test Score's 28-point rubric as a literal gate that
  blocks shipping — the paper's own finding is that even Google teams sit well
  below full marks; use it as a tracked number to watch trend on, not a
  merge-blocking threshold.
- Do not give the new canary/shadow-serve requirement (candidate below) to
  every promotion uniformly — Nick's fantasy-over-betting priority means the
  shadow window should be shortest for fantasy-relevant heads and can be
  longer for betting-adjacent ones, where a slow promotion is a feature, not
  friction.
