# Linear import — Gridiron NFL betting model (2026-09-15)

**How to import.** Create the Epic first. Then create the six Milestone issues (M0–M5) as sub-issues of that Epic, or as milestones on a Linear Project named for the Epic. Then create WP01–WP20 as issues, each linked to its parent Milestone (and to the Epic). Copy **Dependencies** into Linear’s blocked-by / blocking relations (or a `Dependencies` custom field) and copy the **Labels** line into labels/custom fields (`milestone`, `type`, `research_rules`, `code_findings`, plus **Status** when given). Paste one delimited block per Linear issue; do not merge blocks. Sequencing authority remains `docs/betting-model/plans/LATEST-PLAN.md` (M0→M5 / WP01–WP20). Immediate front from the master plan: (1) WP15 frozen packet, (2) WP08 news versioning, (3) WP14 prediction/error ledger, (4) one CLV module (FIX#28) and closed-form ridge team strength (FIX#14), (5) WP12–WP13 walk-forward + conformal probability, (6) unity (family adapters → gated comparison → coordinator + `tree_lab`→Node).

Sources: `docs/betting-model/plans/WORK-PACKAGE-INDEX.json`, `docs/betting-model/plans/agent-prompts/WP01.md`–`WP20.md`, `docs/betting-model/plans/LATEST-PLAN.md`, `docs/evidence/2026-09-15/BETTING-MODEL-MASTER-PLAN.md`. Type tags **unity / ML / data-leakage / governance** follow the companion `[U]/[M]/[D]/[G]` mapping used with that master plan (first tag is the Linear `type` when a WP is dual-tagged). Status uses the master-plan legend ✅ done · ◐ partial · ⛔ open.

---

<!-- ===== LINEAR ISSUE START: Epic ===== -->

## Epic

**Title:** Gridiron NFL betting model - unified trustworthy pipeline

**Description:**
The systems already exist (ensembles, labs, gates, execution, news, packets) but they lack **unity** and **ML in the served path**: families are disconnected, trained Stage 3 ridge/LightGBM/`tree_lab` is not served, and production spread output is market identity (edge 0). The goal is a **correct, leak-free, unified, reproducible pipeline** plus a **trustworthy forward test** of whether orthogonal information (availability/news) or execution (CLV/line-shopping, timing) yields an edge — the only places an edge is plausible. Profit is **not** an engineering completion checkbox; it is separate **forward evidence**. Honest base case: **no robust spread edge**; expected outcome is trustworthy and probably **edgeless**. Unifying systems and turning on ML will not by itself create profit.

**Link:** `docs/evidence/2026-09-15/BETTING-MODEL-MASTER-PLAN.md`

**Children:** M0, M1, M2, M3, M4, M5 (WP01–WP20)

<!-- ===== LINEAR ISSUE END: Epic ===== -->

---

<!-- ===== LINEAR ISSUE START: M0 ===== -->

## Milestone M0

**Title:** M0 - Trustworthy status

**Required result:** One reconciled defect/implementation ledger and frozen baseline.

**Child WPs:** WP01, WP02

**Dependencies:** None (starts the implementation).

**Master-plan status:** partial (◐ mostly done). WP01 ledger/baseline freeze exists; WP02 repairs for C01–C04, C06, C09, orthogonal-NaN, QBR are done. Remaining: publish the money-vs-measurement gate table; open “justify gate thresholds.”

**Labels:** `milestone: M0`; `type: governance`

<!-- ===== LINEAR ISSUE END: M0 ===== -->

---

<!-- ===== LINEAR ISSUE START: M1 ===== -->

## Milestone M1

**Title:** M1 - Replayable examples

**Required result:** A historical week can be rebuilt with source lineage and honest cutoffs.

**Child WPs:** WP03, WP04, WP05, WP06, WP07

**Dependencies:** M0. M1–M3 must be able to proceed with explicit missing-news features.

**Master-plan status:** partial (◐ foundation). C06 clocks and C03/C04 book policy are largely in; C08 coverage, C12 totals contract, and chronology-safe shared features remain.

**Labels:** `milestone: M1`; `type: data-leakage`

<!-- ===== LINEAR ISSUE END: M1 ===== -->

---

<!-- ===== LINEAR ISSUE START: M2 ===== -->

## Milestone M2

**Title:** M2 - First learned comparison

**Required result:** Baseline plus one restrained tree family, chronological predictions and error report.

**Child WPs:** WP11, WP12, WP13, WP14

**Dependencies:** M1, WP11–WP14. This is the “ML becomes real” milestone (reproducible loop, not a positive result). Stage 3 already shows market MAE beating ridge/LightGBM.

**Master-plan status:** open (⛔).

**Labels:** `milestone: M2`; `type: ML`

<!-- ===== LINEAR ISSUE END: M2 ===== -->

---

<!-- ===== LINEAR ISSUE START: M3 ===== -->

## Milestone M3

**Title:** M3 - Complete shadow path

**Required result:** Frozen input → actual trained artifact → decision trace → later settlement.

**Child WPs:** WP15, WP16, WP17

**Dependencies:** M2, WP15–WP17. This milestone is **unity**: one frozen packet through trained artifact, versioned policy, independent settlement/CLV.

**Master-plan status:** open (⛔). WP15 full frozen packet is the highest-value integration item (closes D3/R3).

**Labels:** `milestone: M3`; `type: unity`

<!-- ===== LINEAR ISSUE END: M3 ===== -->

---

<!-- ===== LINEAR ISSUE START: M4 ===== -->

## Milestone M4

**Title:** M4 - News earns or fails its place

**Required result:** Structured availability and text contributions measured separately.

**Child WPs:** WP08, WP09, WP10

**Dependencies:** WP08–WP10, M2. Parallel after M1 contracts; must not block the football baseline. News ingestion/extraction can progress independently after source contracts are settled.

**Master-plan status:** open (⛔).

**Labels:** `milestone: M4`; `type: data-leakage`

<!-- ===== LINEAR ISSUE END: M4 ===== -->

---

<!-- ===== LINEAR ISSUE START: M5 ===== -->

## Milestone M5

**Title:** M5 - Maintainable weekly operation

**Required result:** Repeatable updates, restart recovery, versioned evaluation and prioritized improvements.

**Child WPs:** WP18, WP19, WP20

**Dependencies:** M3–M4, WP18–WP20. Forward 2026 CLV accrues here toward promotion gates.

**Master-plan status:** open (⛔).

**Labels:** `milestone: M5`; `type: governance`

<!-- ===== LINEAR ISSUE END: M5 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP01 ===== -->

## WP01

**Title:** WP01 - Reconcile implementation and preserve baseline

**Description:**
Reconcile the current checkout, dirty-file ownership, deployed version and prior evidence. Classify earlier findings using actual source/tests rather than comments. Create the single work ledger and preserve the incumbent configuration, predictions and metric definitions. Do not overwrite a current plan or rerun paid/live jobs just to inventory them. Deliver a current status ledger; a frozen baseline manifest or an explicit explanation of missing reconstruction evidence; a dependency/ownership map identifying the next unfinished package.

**Dependencies:** None; starts the implementation.

**Acceptance criteria:**
- Recompute one available baseline example from its saved inputs.
- Distinguish historical inspection counts from refreshed observations.
- A written claim that a bug is fixed is not verification.

**Labels:** `milestone: M0`; `type: governance`; `research_rules: R01, R09, R25`; `code_findings: C01–C12`

**Status:** done (✅ Stage-1 freeze exists; master plan records this as completing the reconciliation).

<!-- ===== LINEAR ISSUE END: WP01 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP02 ===== -->

## WP02

**Title:** WP02 - Repair defects and gate responsibilities

**Description:**
Reproduce relevant numerical/data/gate defects on isolated fixtures before fixing them. Check specialist dimensions, QBR season identity and the current DSR promotion integration. Resolve validator behavior C01/C02 with the contract owner. Separate invalid data/output from insufficient betting evidence so valid shadow predictions remain measurable. Do not repair a statistical assumption merely by lowering its threshold. Deliver a defect-by-defect before/after report and targeted regression tests; one gate responsibility table with caller, condition, effect and recorded reason.

**Dependencies:** WP01

**Acceptance criteria:**
- Exercise tall and small design matrices, corrupt or duplicate season rows, malformed packet fields and a valid forecast withheld only from staking.
- Reference-check statistical calculations before using them for promotion.

**Labels:** `milestone: M0`; `type: governance`; `also: unity`; `research_rules: R04, R11, R27, R28`; `code_findings: C01, C02`

**Status:** partial (✅ C01–C04, C06, C09, orthogonal-NaN, QBR; remaining: publish the money-vs-measurement gate table; open “justify gate thresholds”).

<!-- ===== LINEAR ISSUE END: WP02 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP03 ===== -->

## WP03

**Title:** WP03 - Historical identities and exact clocks

**Description:**
Define canonical game/player/provider mappings and timestamp precision. Replace the fixed historical -04:00 assumption for cutoff construction with reliable UTC or named-timezone conversion. Resolve player identity from historical roster intervals and retain ambiguous cases. Preserve schedule revisions and distinguish date-only records from precise kickoff instants. Deliver an identity/time dictionary; mapping and exclusion manifest; fixtures for a trade, alias, ambiguous name, neutral venue, reschedule, bye, postseason and winter/summer offset.

**Dependencies:** WP01 and ownership agreement for dataset/packet contracts

**Acceptance criteria:**
- Check one winter and one summer kickoff independently.
- A date-only game must not silently qualify as an exact T−60 packet.
- Later roster changes must not rewrite a frozen historical mapping.

**Labels:** `milestone: M1`; `type: data-leakage`; `research_rules: R01, R02, R03`; `code_findings: C06, C08`

**Status:** partial (C06✅, C08⛔).

<!-- ===== LINEAR ISSUE END: WP03 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP04 ===== -->

## WP04

**Title:** WP04 - Immutable records and validated contracts

**Description:**
Implement the source/event/feature/artifact/decision contracts. Reuse existing stores and append-only conventions. Validate semantic types, market discriminants, timestamp order, finite numbers and missingness before hashing. Define compatible schema evolution and retain exact values rather than counts. Separate the general forecast schema from the older T−60 source-summary packet with an explicit adapter. Deliver a versioned schema/adapter and migration where needed; real example records; lineage links; old/new compatibility behavior and invalid-record reasons.

**Dependencies:** WP02, WP03

**Acceptance criteria:**
- C01 malformed cases must fail or follow a documented legitimate missing-value path.
- C02 nonfinite values cannot collapse into null unnoticed.
- Replaying frozen evidence after source mutations is invariant.
- Test a populated database copy as well as clean setup.

**Labels:** `milestone: M1`; `type: data-leakage`; `also: governance`; `research_rules: R01, R02, R13, R15, R16`; `code_findings: C01, C02, C12`

**Status:** partial (C01/C02✅, C12⛔).

<!-- ===== LINEAR ISSUE END: WP04 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP05 ===== -->

## WP05

**Title:** WP05 - Coverage and source admission

**Description:**
Extend the current source/freshness reports into source-specific admission rules and coverage by game, era, team and horizon. Distinguish discovered, resolved, verified, timely, snapshotted and consumed records. Record every join denominator and exclusion reason. Consult nflverse release schedules and pin source versions; a present-day file is not proof of past availability. Deliver a coverage matrix, source admission contracts and before/after-join game counts with sampled source records. Mark unverifiable timing and missing data explicitly.

**Dependencies:** WP03, WP04

**Acceptance criteria:**
- Removing one optional source does not delete valid football examples.
- A source with many unrelated/unverified rows cannot pass game-specific readiness.
- Every excluded example has a reproducible reason.

**Labels:** `milestone: M1`; `type: data-leakage`; `research_rules: R01, R03, R07, R08, R25`; `code_findings: C08`

**Status:** open (C08⛔).

<!-- ===== LINEAR ISSUE END: WP05 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP06 ===== -->

## WP06

**Title:** WP06 - Shared football features and strength priors

**Description:**
Extend the common builder already being edited; do not fork its chronology. Define the small first feature set, units, missingness and prior-observation ages. Use broad price-independent football history, earlier opponent/QB information and learned shrinkage where justified. Keep labels and unqualified market fields outside the allowlisted model matrix. Preserve old extractor results as explicit comparisons when semantics change. Deliver a feature dictionary, shared extract, consumer-parity report, source lineage and era coverage. Each learned feature names its own training cutoff. Master-plan FIX#14 (closed-form ridge paired-comparison team strength) and FIX#25 (`wind_epa_delta` into `weather_total`) sit here.

**Dependencies:** WP03, WP04, WP05

**Acceptance criteria:**
- Future scores, revised EPA or target-game players cannot change an earlier vector.
- Home/away signs, away-team rest, Week 1 fallback and optional PBP are covered.
- Calibrate priors within earlier folds, not globally.

**Labels:** `milestone: M1`; `type: ML`; `also: data-leakage`; `research_rules: R04, R05, R07, R24`; `code_findings: C06 and earlier dataset chronology findings`

**Status:** partial (◐; `build_football_dataset` exists).

<!-- ===== LINEAR ISSUE END: WP06 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP07 ===== -->

## WP07

**Title:** WP07 - Exact-horizon quote and betting datasets

**Description:**
Add exact T−60 examples separately from opening-line experiments. Resolve C03/C04 with a declared eligible-book policy, per-side identities/clocks and correct opposing-contract pairing. Missing closing prices must not discard valid outcome examples. Preserve spread and total label definitions, provenance mode and actual odds. Do not infer a fill from an archived offer. Deliver a betting dataset manifest and quote-selection trace showing retained, missing, stale, mismatched and fallback cases; labels are separate from feature columns.

**Dependencies:** WP03, WP04, WP05; coordinate shared dataset ownership with WP06

**Acceptance criteria:**
- Test a moved handicap, asynchronous opposite-side update, missing preferred-book home side, alternate period and unavailable close.
- Two individual offers at different lines must not be de-vigged as the same contract.

**Labels:** `milestone: M1`; `type: data-leakage`; `research_rules: R02, R08, R16, R26`; `code_findings: C03, C04, C06, C12`

**Status:** partial (C03/C04✅ policy; C06/C12 remain in scope).

<!-- ===== LINEAR ISSUE END: WP07 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP08 ===== -->

## WP08

**Title:** WP08 - Historical news source pilot

**Description:**
Run the specified 2024 Weeks 1–4 engineering pilot only after defining source/version contracts. Use existing stored material, structured reports and official dated archives before expensive transcription. Add content-addressed source versions before updating the current news view. Preserve raw supported content and timing precision. Build an independently reviewed extraction sample and measure coverage/cost before extending seasons. Deliver source manifests, retrieval/resume log, source-version examples, a reviewed passage set and measured usable coverage/cost. No performance claim from this pilot.

**Dependencies:** WP03, WP04, WP05; document schema owner assigned

**Acceptance criteria:**
- A changed Friday body cannot inherit Wednesday ingestion as its own receipt.
- Repeating the same fetch does not duplicate versions.
- Missing archives are explicit and do not block the football baseline.

**Labels:** `milestone: M4`; `type: data-leakage`; `research_rules: R01, R02, R03, R22, R25`; `code_findings: C07`

**Status:** open (⛔). Immediate front item 2 (news signal versioning / R1–R2).

<!-- ===== LINEAR ISSUE END: WP08 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP09 ===== -->

## WP09

**Title:** WP09 - Typed events and historical injury timelines

**Description:**
Extend supported-span extraction, historical roster resolution, source-version references and separate receipt/extraction clocks. Build the shared as-of state reducer. Retain practice trajectories, contradictions, superseding events and unresolved persistent statuses. Unknown teams and unverified claims remain preserved but are not admitted as usable game features. Keep structured parsing separate from LLM interpretation. Deliver player/game timelines at T−72h, T−24h and T−60; event schema/examples; extraction quality by claim type; coverage and unresolved-state reports.

**Dependencies:** WP03, WP04 and initial WP08 material

**Acceptance criteria:**
- Test negation, ambiguous pronouns, multi-player stories, an inactive reversal, traded players, byes and long-term IR.
- Later events cannot alter an earlier snapshot; repeated syndicated text is not independent evidence.

**Labels:** `milestone: M4`; `type: data-leakage`; `research_rules: R01, R03, R20, R22, R23`; `code_findings: C07, C08`

**Status:** open (⛔).

<!-- ===== LINEAR ISSUE END: WP09 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP10 ===== -->

## WP10

**Title:** WP10 - Availability and replacement learning

**Description:**
Define active-status and conditional-usage targets, including healthy non-use and in-game exits. Implement a small regularized availability baseline and earlier-estimated replacement features. Use historical rosters, structured reports and lagged usage. Treat LLM extraction confidence as separate from playing probability. Add text only as a separately registered experiment after structured availability works. Deliver a target dictionary, player model artifacts and chronological OOF outputs, calibration/usage reports and compact game-level availability features.

**Dependencies:** WP06, WP09 and WP11 protocol; may proceed after baseline launch

**Acceptance criteria:**
- Audit upstream train row IDs for every output used by the game learner.
- Actual target-game snaps/starters cannot enter features.
- Compare structured and text additions on identical games with and without contemporaneous market information.

**Labels:** `milestone: M4`; `type: ML`; `research_rules: R04, R05, R20, R23, R24`; `code_findings: Earlier news/availability integration findings`

**Status:** open (⛔).

<!-- ===== LINEAR ISSUE END: WP10 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP11 ===== -->

## WP11

**Title:** WP11 - Registered experiments and bounded model selection

**Description:**
Define a machine-readable experiment specification covering data/source mode, target/horizon, folds, candidates, seeds, metrics, calibration, policy and review schedule. Reuse the existing trial registry; inspect whether generic model-registry APIs actually apply to NFL before integrating. Freeze a small ridge/LightGBM configuration family and record all attempted settings, failures and later changes. Snapshot installed dependency versions. Deliver experiment specification, trial records, candidate budget, runtime/dependency manifest and artifact-naming rules. No hidden best-seed or best-era selection.

**Dependencies:** WP01, WP04, WP05; before comparative model fitting

**Acceptance criteria:**
- Changing data, schema, source mode or feature family produces a distinguishable experiment identity.
- Failed fits and unsuccessful variants remain discoverable.
- A registration after scoring is labeled retrospective.

**Labels:** `milestone: M2`; `type: governance`; `research_rules: R06, R09, R10, R11, R25`; `code_findings: Statistical promotion integration requires current reconciliation`

**Status:** open (⛔ M2). Master plan does not mark WP11 done; Stage 3 ran as a precursor, not a closed registered-spec package.

<!-- ===== LINEAR ISSUE END: WP11 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP12 ===== -->

## WP12

**Title:** WP12 - Weekly nested training and OOF lineage

**Description:**
Implement weekly refits matching the master schedule while preserving old seasonal comparisons. Every preprocessing step, upstream learner, early-stopping choice, combiner and calibrator must use earlier data. Keep entire games and related snapshots together. Produce chronological OOF features for downstream fitting, and save train/test row IDs. Do not replace old holdout predictions with fitted values after final refitting. Deliver a runnable weekly experiment entry point, immutable split manifests, all-candidate predictions, selected artifacts and a complete upstream lineage example. Master-plan FIX: replace `0.68+0.632·market` shrinkage with DM-gated, equal-weight/inverse-MSE-benchmarked regularized combination on OOF preds, with PCA/correlation reduction first.

**Dependencies:** WP06, WP07, WP11; availability optional until WP10 ready

**Acceptance criteria:**
- A held-out outcome mutation does not change its model or feature inputs.
- Same-game leakage through player/book/horizon rows is refused.
- Newly available current-season labels can enter the next scheduled fit under the declared policy.

**Labels:** `milestone: M2`; `type: ML`; `research_rules: R04, R05, R07, R08, R09`; `code_findings: C11 reuse requires actual refit verification`

**Status:** open (⛔). Immediate front item 5 (with WP13).

<!-- ===== LINEAR ISSUE END: WP12 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP13 ===== -->

## WP13

**Title:** WP13 - Probability, calibration and pushes

**Description:**
Bind probabilities/calibration to model identity and exact market/horizon. Specify spread versus total schemas explicitly. Convert conditional non-push probabilities to unconditional win/push/loss probabilities using earlier-estimated push mass. Keep conformal intervals distinct from betting probabilities. Reuse existing corrected math and independent references; do not port a second implementation without parity evidence. Deliver a market-discriminated probability contract, earlier calibration manifest, proper-score and coverage reports, key-margin/push fixtures and explicit unsupported cases.

**Dependencies:** WP04, WP07, WP11, WP12

**Acceptance criteria:**
- Probabilities are finite, sum to one and yield correct price-based EV.
- Changing the line requires rescoring that contract.
- C01 malformed market combinations fail; valid totals require their own complete path, not a renamed spread.

**Labels:** `milestone: M2`; `type: ML`; `research_rules: R13, R14, R15, R16, R17`; `code_findings: C01, C02, C12`

**Status:** open (⛔). Immediate front item 5 (with WP12).

<!-- ===== LINEAR ISSUE END: WP13 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP14 ===== -->

## WP14

**Title:** WP14 - Measurement and actionable error analysis

**Description:**
Reuse existing diagnostics and paired-score contracts, but connect actual all-game outputs, abstentions and frozen context from the new learner. Fix not-estimable-as-robust in C09. Separate loss, probability and return comparisons; evaluate base-test/dependence assumptions before applying multiplicity. Preserve full precision for decisions and round only displays. Measure full-pipeline refitted ablations, not just disabled outputs. Deliver a reproducible error report and ranked hypothesis backlog; row-level inputs; matched baselines; sample/coverage and uncertainty; explicit inconclusive states. Master plan: save every game’s prediction + abstention + frozen context.

**Dependencies:** WP11, WP12, WP13; reuse historical reports as references only

**Acceptance criteria:**
- A one-season slice cannot pass a multi-season check.
- No-bet games are retained for forecast evaluation.
- A family with no numerical consumer is labeled disconnected.
- Hypotheses discovered in the report require later confirmation.

**Labels:** `milestone: M2`; `type: ML`; `also: governance`; `research_rules: R08, R09, R11, R24, R28`; `code_findings: C09, C10, C11`

**Status:** open (⛔; C09✅ in prior ledger, C10/C11⛔). Immediate front item 3.

<!-- ===== LINEAR ISSUE END: WP14 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP15 ===== -->

## WP15

**Title:** WP15 - Trained-artifact serving and frozen recovery

**Description:**
Connect the actual fitted pipeline to the app through a narrow scoring interface. Freeze all consumed features, quotes, transforms and model identities; no mutable-table rereads in the learned path. Implement recovery of frozen observations using their stored evidence and idempotent tape linkage. Preserve actual late completion times and classify replay versus on-time decisions correctly. Deliver one complete spread-game demonstration and then a slate; artifact/snapshot/decision linkage; numerical parity; explicit fallback and recovery traces. Extend to totals only with WP13 contracts ready. Closes D3/R3; includes `tree_lab` joblib → Node bridge so Family D (direct-cover) stops being a stub.

**Dependencies:** WP04, WP07, WP12, WP13

**Acceptance criteria:**
- A restart or source mutation cannot change frozen outputs.
- Invalid artifacts fail explicitly.
- A tape write/link interruption neither duplicates the decision nor strands it forever.
- The same quote is not falsely assigned another side’s timestamp.

**Labels:** `milestone: M3`; `type: unity`; `research_rules: R01, R02, R15, R16, R27`; `code_findings: C01–C05, C12`

**Status:** open (⛔). Immediate front item 1 (highest-value integration).

<!-- ===== LINEAR ISSUE END: WP15 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP16 ===== -->

## WP16

**Title:** WP16 - Betting policy and related exposure

**Description:**
Make one versioned authority/execution policy consume saved valid probabilities and actual offered odds. Keep shadow prediction available while qualifications are unresolved. Trace every gate result and reason. Preserve related-position accounting across books/markets. Review any AI allocation separately against a deterministic baseline. Do not increase live stakes as a side effect of integration. Deliver a policy contract, deterministic EV/action fixtures and examples of valid forecasts that abstain for distinct reasons; exposure and duplicate-opportunity behavior. Kelly sizing stays gated off.

**Dependencies:** WP02, WP07, WP13, WP15

**Acceptance criteria:**
- Push EV, invalid price, stale quote, duplicate same-side opportunity, opposite positions at different lines and no-edge cases behave explicitly.
- An LLM explanation cannot silently change numerical authority.

**Labels:** `milestone: M3`; `type: governance`; `research_rules: R16, R19, R23, R27`; `code_findings: C03 and market-specific policy integration`

**Status:** open (⛔ M3; master plan does not mark WP16 complete).

<!-- ===== LINEAR ISSUE END: WP16 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP17 ===== -->

## WP17

**Title:** WP17 - Independent settlement and CLV grading

**Description:**
Grade the exact recorded contract and price with versioned settlement rules. Keep actual confirmed fills, user-reported acceptance and paper opportunities distinct. Append corrections without rewriting original predictions. Define the close benchmark and report missing closes separately. Handle spreads and totals through their declared contracts, not shared ambiguous field names. Deliver independent settlement fixture calculations, a reconciled row-to-summary ledger, closing-reference specification and cancellation/push/correction examples. Master-plan ADD#28: delete the four CLV calculators → one `computeClv()` + one `clv_grades` table (highest-leverage audit item). R26: CLV and ROI on the same bets are dependent, not two proofs.

**Dependencies:** WP07, WP13, WP15, WP16

**Acceptance criteria:**
- Win/loss/push/void and positive/negative American odds reconcile to risked stake and profit.
- Missing close does not erase a settled outcome.
- CLV at different lines is not mislabeled same-contract price improvement.

**Labels:** `milestone: M3`; `type: unity`; `also: governance`; `research_rules: R16, R19, R26, R27`; `code_findings: C12`

**Status:** open (⛔ M3). Immediate front item 4 includes FIX#28 (one CLV module).

<!-- ===== LINEAR ISSUE END: WP17 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP18 ===== -->

## WP18

**Title:** WP18 - Reliable jobs, migrations and resource limits

**Description:**
Implement observable job states, bounded retries, resume cursors and atomic artifact publication. Separate source arrival from scheduled fitting. Recover frozen decisions without new inputs and retain the previous eligible model if a fit fails. Exercise migration behavior on populated copies and append-only guards. Track accepted-document costs, time, memory and failure concentration from actual runs. Deliver a lifecycle/retry specification, restart evidence, populated/clean migration results, resource report and a recovery/rollback runbook.

**Dependencies:** WP04, WP08–WP09 as available, WP15, WP16, WP17

**Acceptance criteria:**
- Interrupt fetch, extraction, artifact publish and tape linking.
- Resume without duplicate writes or repeat billing for cached unchanged work.
- Missing a cutoff remains visible; no job backdates receipt or completion.

**Labels:** `milestone: M5`; `type: unity`; `research_rules: R01, R02, R25`; `code_findings: C05, C07`

**Status:** open (⛔ M5).

<!-- ===== LINEAR ISSUE END: WP18 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP19 ===== -->

## WP19

**Title:** WP19 - Challenge the complete system independently

**Description:**
Review the complete implemented path against the master threat cases and all C findings. Write tests that cross module boundaries, not mirrors of implementation formulas. Use independent arithmetic/temporal expectations, known-leak positive controls and repeated appropriate no-signal controls. Inspect import-time effects before testing, keep databases disposable and prevent provider calls. Report failures to their owning packages rather than rewriting unrelated production code. Deliver a reproducible adversarial verification report, coverage of each failure class, actual commands and clear unresolved findings. Preserve raw negative outcomes.

**Dependencies:** M3 complete path; can review individual packages earlier

**Acceptance criteria:**
- Exercise future mutation, source revisions, historical identities, duplicate stories, player/book split leakage, moved contracts, malformed packets, restarts and metric reconciliation.
- Passing 14 existing packet tests is insufficient if the seven known malformed cases still pass validation.

**Labels:** `milestone: M5`; `type: governance`; `research_rules: R01–R28`; `code_findings: C01–C12`

**Status:** open (⛔).

<!-- ===== LINEAR ISSUE END: WP19 ===== -->

---

<!-- ===== LINEAR ISSUE START: WP20 ===== -->

## WP20

**Title:** WP20 - Prospective ledger and evidence-driven expansion

**Description:**
Freeze the adaptive fitting recipe, prospective observation horizon and review schedule. Preserve every eligible prediction and abstention, including version changes and missed observations. Use the error report to propose the smallest fix for a measured weakness. Require later confirmation for discovered hypotheses and retain rejected/inconclusive additions. Distinguish engineering completion from predictive value and betting qualification. Deliver a prospective protocol, versioned evidence ledger, ranked improvement backlog and one example accept/reject/inconclusive decision with its evidence requirements. This is where forward 2026 CLV accrues toward the promotion gates.

**Dependencies:** WP14, WP15, WP16, WP17, WP18, WP19; protocol must be frozen before using future results

**Acceptance criteria:**
- Changing a feature/search/policy starts a new evidence segment.
- A failed or uncomputable robustness check never becomes a pass.
- Advanced methods need a specific error, suitable data and a simpler baseline before implementation.

**Labels:** `milestone: M5`; `type: governance`; `research_rules: R09, R10, R12, R24, R27, R28`; `code_findings: C09–C12`

**Status:** open (⛔).

<!-- ===== LINEAR ISSUE END: WP20 ===== -->
