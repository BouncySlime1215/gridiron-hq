from pathlib import Path
import json
repo=Path('/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard')
out=Path('outputs'); folder=out/'agent-prompts';folder.mkdir(exist_ok=True)
# Existing file paths are checked below. Proposed files are explicit design suggestions.
data=[
('WP01','Reconcile implementation and preserve baseline',
 ['docs/CLAUDE-NEXT-STEPS.md','docs/reference/model-governance-manual.md'],[],[],
 'Reconcile the current checkout, dirty-file ownership, deployed version and prior evidence. Classify earlier findings using actual source/tests rather than comments. Create the single work ledger and preserve the incumbent configuration, predictions and metric definitions. Do not overwrite a current plan or rerun paid/live jobs just to inventory them.',
 'A current status ledger; a frozen baseline manifest or an explicit explanation of missing reconstruction evidence; a dependency/ownership map identifying the next unfinished package.',
 'Recompute one available baseline example from its saved inputs. Distinguish historical inspection counts from refreshed observations. A written claim that a bug is fixed is not verification.', 'R01,R09,R25', 'C01–C12', 'None; starts the implementation'),
('WP02','Repair defects and gate responsibilities',
 ['server/services/nfl-orthogonal-specialists.js','server/services/nfl-qbr.js','server/services/trial-statistics.js','scripts/run-purged-evaluation.mjs','server/services/model-governance.js','server/betting/nfl/contracts/forecast-packet.js'],
 ['test/nfl-qbr.test.js','test/trial-statistics.test.js','test/forecast-packet-contract.test.js'],['test/nfl-specialist-weight-shape.test.js'],
 'Reproduce relevant numerical/data/gate defects on isolated fixtures before fixing them. Check specialist dimensions, QBR season identity and the current DSR promotion integration. Resolve validator behavior C01/C02 with the contract owner. Separate invalid data/output from insufficient betting evidence so valid shadow predictions remain measurable. Do not repair a statistical assumption merely by lowering its threshold.',
 'A defect-by-defect before/after report and targeted regression tests; one gate responsibility table with caller, condition, effect and recorded reason.',
 'Exercise tall and small design matrices, corrupt or duplicate season rows, malformed packet fields and a valid forecast withheld only from staking. Reference-check statistical calculations before using them for promotion.', 'R04,R11,R27,R28','C01,C02','WP01'),
('WP03','Historical identities and exact clocks',
 ['server/services/team-codes.js','server/services/nfl-contract-key.js','server/services/nfl-t60-packet.js','research/betting/nfl/dataset.py'],
 ['test/team-codes.test.js','test/nfl-t60-packet.test.js','research/betting/nfl/test_dataset.py'],['test/nfl-historical-clock-identity.test.js'],
 'Define canonical game/player/provider mappings and timestamp precision. Replace the fixed historical -04:00 assumption for cutoff construction with reliable UTC or named-timezone conversion. Resolve player identity from historical roster intervals and retain ambiguous cases. Preserve schedule revisions and distinguish date-only records from precise kickoff instants.',
 'An identity/time dictionary; mapping and exclusion manifest; fixtures for a trade, alias, ambiguous name, neutral venue, reschedule, bye, postseason and winter/summer offset.',
 'Check one winter and one summer kickoff independently. A date-only game must not silently qualify as an exact T−60 packet. Later roster changes must not rewrite a frozen historical mapping.', 'R01,R02,R03','C06,C08','WP01 and ownership agreement for dataset/packet contracts'),
('WP04','Immutable records and validated contracts',
 ['server/betting/nfl/contracts/forecast-packet.js','server/services/nfl-bitemporal.js','server/services/nfl-decision-tape.js','server/db/migrate.js'],
 ['test/forecast-packet-contract.test.js','test/nfl-injuries-bitemporal.test.js','test/migration-027-populated-upgrade.test.js'],['A new migration allocated after inspecting the current migration sequence; never rewrite an applied migration'],
 'Implement the source/event/feature/artifact/decision contracts from WP04. Reuse existing stores and append-only conventions. Validate semantic types, market discriminants, timestamp order, finite numbers and missingness before hashing. Define compatible schema evolution and retain exact values rather than counts. Separate the general forecast schema from the older T−60 source-summary packet with an explicit adapter.',
 'A versioned schema/adapter and migration where needed; real example records; lineage links; old/new compatibility behavior and invalid-record reasons.',
 'C01 malformed cases must fail or follow a documented legitimate missing-value path. C02 nonfinite values cannot collapse into null unnoticed. Replaying frozen evidence after source mutations is invariant. Test a populated database copy as well as clean setup.', 'R01,R02,R13,R15,R16','C01,C02,C12','WP02–WP03'),
('WP05','Coverage and source admission',
 ['server/services/nfl-feature-coverage.js','server/services/nfl-evidence-dataset.js','research/betting/nfl/dataset.py'],
 ['test/evidence-dataset.test.js','research/betting/nfl/test_dataset.py'],['A source-admission manifest in the existing evidence/artifact layout'],
 'Extend the current source/freshness reports into source-specific admission rules and coverage by game, era, team and horizon. Distinguish discovered, resolved, verified, timely, snapshotted and consumed records. Record every join denominator and exclusion reason. Consult nflverse release schedules and pin source versions; a present-day file is not proof of past availability.',
 'A coverage matrix, source admission contracts and before/after-join game counts with sampled source records. Mark unverifiable timing and missing data explicitly.',
 'Removing one optional source does not delete valid football examples. A source with many unrelated/unverified rows cannot pass game-specific readiness. Every excluded example has a reproducible reason.', 'R01,R03,R07,R08,R25','C08','WP03–WP04'),
('WP06','Shared football features and strength priors',
 ['research/betting/nfl/dataset.py','research/market_lab.py','research/tree_lab.py','server/services/nfl-features.js','server/services/nfl-team-strength.js','server/services/nfl-preseason-blend.js'],
 ['research/betting/nfl/test_dataset.py','research/test_market_lab.py','research/test_tree_lab.py','test/nfl-team-strength.test.js','test/preseason-blend-cutoff.test.js'],[],
 'Extend the common builder already being edited; do not fork its chronology. Define the small first feature set, units, missingness and prior-observation ages. Use broad price-independent football history, earlier opponent/QB information and learned shrinkage where justified. Keep labels and unqualified market fields outside the allowlisted model matrix. Preserve old extractor results as explicit comparisons when semantics change.',
 'A feature dictionary, shared extract, consumer-parity report, source lineage and era coverage. Each learned feature names its own training cutoff.',
 'Future scores, revised EPA or target-game players cannot change an earlier vector. Home/away signs, away-team rest, Week 1 fallback and optional PBP are covered. Calibrate priors within earlier folds, not globally.', 'R04,R05,R07,R24','C06 and earlier dataset chronology findings','WP03–WP05'),
('WP07','Exact-horizon quote and betting datasets',
 ['research/betting/nfl/dataset.py','server/services/nfl-quote-tape.js','server/services/nfl-contract-key.js','server/services/nfl-evidence-dataset.js','server/services/nfl-t60-packet.js'],
 ['research/betting/nfl/test_dataset.py','test/evidence-dataset.test.js','test/nfl-t60-packet.test.js'],['A T−60 extraction entry point under research/betting/nfl, sharing the current dataset module'],
 'Add exact T−60 examples separately from opening-line experiments. Resolve C03/C04 with a declared eligible-book policy, per-side identities/clocks and correct opposing-contract pairing. Missing closing prices must not discard valid outcome examples. Preserve spread and total label definitions, provenance mode and actual odds. Do not infer a fill from an archived offer.',
 'A betting dataset manifest and quote-selection trace showing retained, missing, stale, mismatched and fallback cases; labels are separate from feature columns.',
 'Test a moved handicap, asynchronous opposite-side update, missing preferred-book home side, alternate period and unavailable close. Two individual offers at different lines must not be de-vigged as the same contract.', 'R02,R08,R16,R26','C03,C04,C06,C12','WP03–WP05; coordinate shared dataset ownership with WP06'),
('WP08','Historical news source pilot',
 ['server/news/ingest.js','server/news/store.js','server/news/normalize.js','server/services/press-conference.js'],
 ['test/news-ingest.test.js'],['A bounded archive backfill runner with absolute date/team/source filters and resume state'],
 'Run the specified 2024 Weeks 1–4 engineering pilot only after defining source/version contracts. Use existing stored material, structured reports and official dated archives before expensive transcription. Add content-addressed source versions before updating the current news view. Preserve raw supported content and timing precision. Build an independently reviewed extraction sample and measure coverage/cost before extending seasons.',
 'Source manifests, retrieval/resume log, source-version examples, a reviewed passage set and measured usable coverage/cost. No performance claim from this pilot.',
 'A changed Friday body cannot inherit Wednesday ingestion as its own receipt. Repeating the same fetch does not duplicate versions. Missing archives are explicit and do not block the football baseline.', 'R01,R02,R03,R22,R25','C07','WP03–WP05; document schema owner assigned'),
('WP09','Typed events and historical injury timelines',
 ['server/services/nfl-news-events.js','server/services/nfl-news-signal.js','server/services/nfl-advanced.js','server/services/nfl-bitemporal.js','server/services/nfl-t60-packet.js'],
 ['test/nfl-news-events.test.js','test/nfl-injuries-bitemporal.test.js'],['An absolute-date-range event extraction/replay interface using existing stores'],
 'Extend supported-span extraction, historical roster resolution, source-version references and separate receipt/extraction clocks. Build the shared as-of state reducer. Retain practice trajectories, contradictions, superseding events and unresolved persistent statuses. Unknown teams and unverified claims remain preserved but are not admitted as usable game features. Keep structured parsing separate from LLM interpretation.',
 'Player/game timelines at T−72h, T−24h and T−60; event schema/examples; extraction quality by claim type; coverage and unresolved-state reports.',
 'Test negation, ambiguous pronouns, multi-player stories, an inactive reversal, traded players, byes and long-term IR. Later events cannot alter an earlier snapshot; repeated syndicated text is not independent evidence.', 'R01,R03,R20,R22,R23','C07,C08','WP03–WP04 and initial WP08 material'),
('WP10','Availability and replacement learning',
 ['server/services/nfl-availability.js','server/services/player-availability.js','research/betting/nfl/dataset.py'],
 ['test/player-availability.test.js'],['research/betting/nfl/availability.py','research/betting/nfl/test_availability.py'],
 'Define active-status and conditional-usage targets, including healthy non-use and in-game exits. Implement a small regularized availability baseline and earlier-estimated replacement features. Use historical rosters, structured reports and lagged usage. Treat LLM extraction confidence as separate from playing probability. Add text only as a separately registered experiment after structured availability works.',
 'Target dictionary, player model artifacts and chronological OOF outputs, calibration/usage reports and compact game-level availability features.',
 'Audit upstream train row IDs for every output used by the game learner. Actual target-game snaps/starters cannot enter features. Compare structured and text additions on identical games with and without contemporaneous market information.', 'R04,R05,R20,R23,R24','Earlier news/availability integration findings','WP06, WP09 and WP11 protocol; may proceed after baseline launch'),
('WP11','Registered experiments and bounded model selection',
 ['server/services/research-trials.js','server/modeling/registry.js','research/requirements.txt','research/tree_lab.py','research/market_lab.py'],
 ['test/research-trials.test.js','test/model-registry-persistence.test.js'],['A versioned NFL experiment specification under research/betting/nfl'],
 'Define a machine-readable experiment specification covering data/source mode, target/horizon, folds, candidates, seeds, metrics, calibration, policy and review schedule. Reuse the existing trial registry; inspect whether generic model-registry APIs actually apply to NFL before integrating. Freeze a small ridge/LightGBM configuration family and record all attempted settings, failures and later changes. Snapshot installed dependency versions.',
 'Experiment specification, trial records, candidate budget, runtime/dependency manifest and artifact-naming rules. No hidden best-seed or best-era selection.',
 'Changing data, schema, source mode or feature family produces a distinguishable experiment identity. Failed fits and unsuccessful variants remain discoverable. A registration after scoring is labeled retrospective.', 'R06,R09,R10,R11,R25','Statistical promotion integration requires current reconciliation','WP01, WP04–WP05; before comparative model fitting'),
('WP12','Weekly nested training and OOF lineage',
 ['research/betting/nfl/dataset.py','research/tree_lab.py','research/market_lab.py','server/services/purged-walk-forward.js','server/services/forecast-combination.js'],
 ['research/betting/nfl/test_dataset.py','research/test_tree_lab.py','test/purged-walk-forward.test.js','test/forecast-combination.test.js'],['research/betting/nfl/walk_forward.py','research/betting/nfl/test_walk_forward.py'],
 'Implement weekly refits matching the master schedule while preserving old seasonal comparisons. Every preprocessing step, upstream learner, early-stopping choice, combiner and calibrator must use earlier data. Keep entire games and related snapshots together. Produce chronological OOF features for downstream fitting, and save train/test row IDs. Do not replace old holdout predictions with fitted values after final refitting.',
 'Runnable weekly experiment entry point, immutable split manifests, all-candidate predictions, selected artifacts and a complete upstream lineage example.',
 'A held-out outcome mutation does not change its model or feature inputs. Same-game leakage through player/book/horizon rows is refused. Newly available current-season labels can enter the next scheduled fit under the declared policy.', 'R04,R05,R07,R08,R09','C11 reuse requires actual refit verification','WP06–WP07, WP11; availability optional until WP10 ready'),
('WP13','Probability, calibration and pushes',
 ['server/betting/nfl/contracts/spread-probabilities.js','server/betting/nfl/contracts/forecast-packet.js','server/services/nfl-cover-calibration.js','server/services/nfl-total-calibration.js','server/services/conformal.js'],
 ['test/spread-probabilities.test.js','test/nfl-total-calibration.test.js','test/forecast-packet-contract.test.js','test/conformal-finite-sample.test.js'],['A Python probability/calibration module with parity fixtures for the declared serving contract'],
 'Bind probabilities/calibration to model identity and exact market/horizon. Specify spread versus total schemas explicitly. Convert conditional non-push probabilities to unconditional win/push/loss probabilities using earlier-estimated push mass. Keep conformal intervals distinct from betting probabilities. Reuse existing corrected math and independent references; do not port a second implementation without parity evidence.',
 'Market-discriminated probability contract, earlier calibration manifest, proper-score and coverage reports, key-margin/push fixtures and explicit unsupported cases.',
 'Probabilities are finite, sum to one and yield correct price-based EV. Changing the line requires rescoring that contract. C01 malformed market combinations fail; valid totals require their own complete path, not a renamed spread.', 'R13,R14,R15,R16,R17','C01,C02,C12','WP04, WP07, WP11–WP12'),
('WP14','Measurement and actionable error analysis',
 ['server/services/nfl-replay.js','server/services/nfl-slice-diagnostic.js','server/services/nfl-family-contribution.js','server/services/stats-util.js'],
 ['test/nfl-replay-error-analysis.test.js','test/nfl-family-contribution.test.js','test/family-contribution-scoring.test.js'],['A report adapter for the new Python row-level prediction ledger'],
 'Reuse existing diagnostics and paired-score contracts, but connect actual all-game outputs, abstentions and frozen context from the new learner. Fix not-estimable-as-robust in C09. Separate loss, probability and return comparisons; evaluate base-test/dependence assumptions before applying multiplicity. Preserve full precision for decisions and round only displays. Measure full-pipeline refitted ablations, not just disabled outputs.',
 'A reproducible error report and ranked hypothesis backlog; row-level inputs; matched baselines; sample/coverage and uncertainty; explicit inconclusive states.',
 'A one-season slice cannot pass a multi-season check. No-bet games are retained for forecast evaluation. A family with no numerical consumer is labeled disconnected. Hypotheses discovered in the report require later confirmation.', 'R08,R09,R11,R24,R28','C09,C10,C11','WP11–WP13; reuse historical reports as references only'),
('WP15','Trained-artifact serving and frozen recovery',
 ['server/services/nfl-auto-picks.js','server/services/nfl-t60-packet.js','server/betting/nfl/contracts/forecast-packet.js','server/betting/nfl/strategy/t60-runner.js','server/services/nfl-decision-tape.js'],
 ['test/t60-runner.test.js','test/forecast-packet-contract.test.js','test/nfl-decision-identity-pipeline.test.js'],['A narrow versioned Python artifact-scoring adapter with integration tests'],
 'Connect the actual fitted pipeline to the app through a narrow scoring interface. Freeze all consumed features, quotes, transforms and model identities; no mutable-table rereads in the learned path. Implement recovery of frozen observations using their stored evidence and idempotent tape linkage. Preserve actual late completion times and classify replay versus on-time decisions correctly.',
 'One complete spread-game demonstration and then a slate; artifact/snapshot/decision linkage; numerical parity; explicit fallback and recovery traces. Extend to totals only with WP13 contracts ready.',
 'A restart or source mutation cannot change frozen outputs. Invalid artifacts fail explicitly. A tape write/link interruption neither duplicates the decision nor strands it forever. The same quote is not falsely assigned another side’s timestamp.', 'R01,R02,R15,R16,R27','C01–C05,C12','WP04, WP07, WP12–WP13'),
('WP16','Betting policy and related exposure',
 ['server/services/nfl-execution-edge.js','server/services/nfl-execution-exposure.js','server/services/nfl-execution-staking-policy.js','server/services/model-governance.js','server/services/nfl-auto-picks.js'],
 ['test/nfl-execution-edge.test.js','test/nfl-execution-exposure.test.js','test/nfl-execution-decision.test.js'],[],
 'Make one versioned authority/execution policy consume saved valid probabilities and actual offered odds. Keep shadow prediction available while qualifications are unresolved. Trace every gate result and reason. Preserve related-position accounting across books/markets. Review any AI allocation separately against a deterministic baseline. Do not increase live stakes as a side effect of integration.',
 'Policy contract, deterministic EV/action fixtures and examples of valid forecasts that abstain for distinct reasons; exposure and duplicate-opportunity behavior.',
 'Push EV, invalid price, stale quote, duplicate same-side opportunity, opposite positions at different lines and no-edge cases behave explicitly. An LLM explanation cannot silently change numerical authority.', 'R16,R19,R23,R27','C03 and market-specific policy integration','WP02, WP07, WP13, WP15'),
('WP17','Independent settlement and CLV grading',
 ['server/services/nfl-execution-lifecycle.js','server/services/nfl-execution-clv.js','server/services/nfl-execution.js','server/services/nfl-decision-tape.js'],
 ['test/nfl-execution-lifecycle.test.js','test/nfl-execution-clv.test.js','test/nfl-execution-clv-abstained.test.js'],[],
 'Grade the exact recorded contract and price with versioned settlement rules. Keep actual confirmed fills, user-reported acceptance and paper opportunities distinct. Append corrections without rewriting original predictions. Define the close benchmark and report missing closes separately. Handle spreads and totals through their declared contracts, not shared ambiguous field names.',
 'Independent settlement fixture calculations, a reconciled row-to-summary ledger, closing-reference specification and cancellation/push/correction examples.',
 'Win/loss/push/void and positive/negative American odds reconcile to risked stake and profit. Missing close does not erase a settled outcome. CLV at different lines is not mislabeled same-contract price improvement.', 'R16,R19,R26,R27','C12','WP07, WP13, WP15–WP16'),
('WP18','Reliable jobs, migrations and resource limits',
 ['server/betting/nfl/strategy/t60-runner.js','server/db/migrate.js','server/services/nfl-news-events.js','server/news/store.js','server/platform/paths.js'],
 ['test/t60-runner.test.js','test/nfl-prospective-collection.test.js','test/migration-027-populated-upgrade.test.js','test/news-ingest.test.js'],['Targeted job-recovery, artifact-publication and populated-schema tests'],
 'Implement observable job states, bounded retries, resume cursors and atomic artifact publication. Separate source arrival from scheduled fitting. Recover frozen decisions without new inputs and retain the previous eligible model if a fit fails. Exercise migration behavior on populated copies and append-only guards. Track accepted-document costs, time, memory and failure concentration from actual runs.',
 'Lifecycle/retry specification, restart evidence, populated/clean migration results, resource report and a recovery/rollback runbook.',
 'Interrupt fetch, extraction, artifact publish and tape linking. Resume without duplicate writes or repeat billing for cached unchanged work. Missing a cutoff remains visible; no job backdates receipt or completion.', 'R01,R02,R25','C05,C07','WP04, WP08–WP09 as available, WP15–WP17'),
('WP19','Challenge the complete system independently',
 ['test/offline-guard.mjs','test/forecast-packet-contract.test.js','test/nfl-replay-error-analysis.test.js','test/nfl-family-contribution.test.js'],[],['An integrated frozen-prediction/chronology challenge suite and self-contained synthetic fixtures'],
 'Review the complete implemented path against the master threat cases and all C findings. Write tests that cross module boundaries, not mirrors of implementation formulas. Use independent arithmetic/temporal expectations, known-leak positive controls and repeated appropriate no-signal controls. Inspect import-time effects before testing, keep databases disposable and prevent provider calls. Report failures to their owning packages rather than rewriting unrelated production code.',
 'A reproducible adversarial verification report, coverage of each failure class, actual commands and clear unresolved findings. Preserve raw negative outcomes.',
 'Exercise future mutation, source revisions, historical identities, duplicate stories, player/book split leakage, moved contracts, malformed packets, restarts and metric reconciliation. Passing 14 existing packet tests is insufficient if the seven known malformed cases still pass validation.', 'R01–R28','C01–C12','M3 complete path; can review individual packages earlier'),
('WP20','Prospective ledger and evidence-driven expansion',
 ['server/services/research-trials.js','server/services/model-governance.js','server/services/nfl-replay.js','docs/CLAUDE-NEXT-STEPS.md'],
 ['test/research-trials.test.js','test/nfl-replay-error-analysis.test.js'],['A versioned prospective protocol and hypothesis-backlog artifact in the existing evidence layout'],
 'Freeze the adaptive fitting recipe, prospective observation horizon and review schedule. Preserve every eligible prediction and abstention, including version changes and missed observations. Use the error report to propose the smallest fix for a measured weakness. Require later confirmation for discovered hypotheses and retain rejected/inconclusive additions. Distinguish engineering completion from predictive value and betting qualification.',
 'Prospective protocol, versioned evidence ledger, ranked improvement backlog and one example accept/reject/inconclusive decision with its evidence requirements.',
 'Changing a feature/search/policy starts a new evidence segment. A failed or uncomputable robustness check never becomes a pass. Advanced methods need a specific error, suitable data and a simpler baseline before implementation.', 'R09,R10,R12,R24,R27,R28','C09–C12','WP14–WP19; protocol must be frozen before using future results')
]
common='''Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.\n'''
index=[]; parts=['## Package prompts and exact edit map\n\nUse the shared operating manual with each prompt. Existing paths below were checked during planning, but must be rechecked against the active checkout. Paths are relative to the repository root declared in each prompt. Proposed modules are suggestions, not claims that files or commands already exist. The lead owns shared contracts/migrations and must resolve overlapping edit ownership before assigning concurrent work.\n']
for ident,title,files,tests,proposed,task,returns,checks,rules,findings,deps in data:
 for p in files+tests:assert (repo/p).is_file(),(ident,p)
 body=f'''### {ident} prompt — {title}

{common}
**Dependencies:** {deps}.

**Existing code/docs to inspect and edit within scope:** {', '.join('`'+p+'`' for p in files)}.

**Existing verification to extend:** {', '.join('`'+p+'`' for p in tests) if tests else 'Choose focused tests after inspecting the active callers; do not claim a nonexistent test command was run.'}

**Proposed additions, only if the existing code cannot own the contract cleanly:** {'; '.join(proposed) if proposed else 'Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.'}

**Task:** {task}

**Required return:** {returns}

**Acceptance/counterexamples:** {checks}

**Research guardrails:** {rules}. **Code findings:** {findings}.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.
'''
 parts.append(body)
 standalone=f'# {ident} — {title}\n\nRead [the master plan](../GRIDIRON-MASTER-PLAN.md) and [agent manual](../AGENT-PLAYBOOK.md) before execution.\n\n'+body.split('\n',1)[1]
 (folder/f'{ident}.md').write_text(standalone)
 index.append({'id':ident,'title':title,'dependencies':deps,'existing_files':files,'existing_tests':tests,'proposed_additions':proposed,'research_rules':rules,'code_findings':findings,'prompt':f'agent-prompts/{ident}.md'})
Path('work/all-package-prompts.md').write_text('\n'.join(parts))
(out/'WORK-PACKAGE-INDEX.json').write_text(json.dumps(index,indent=2)+'\n')
print({'prompts_written':len(index),'existing_paths_verified':sum(len(t[2])+len(t[3]) for t in data)})
