> Start with [LATEST-PLAN.md](LATEST-PLAN.md). Its September 15 update controls sequencing; dated findings below require reconciliation with current code.

# Gridiron implementation agent playbook

Use the [master plan](archive/MASTER-PLAN-2026-09-14.md) for scope and specifications, and the [package index](WORK-PACKAGE-INDEX.json) for dependencies and file ownership.

## Agent operating manual, research guardrails and code-review additions

This is the execution contract for agents implementing the work packages. Use it with the package specification and prompt below. It is not evidence that implementation has occurred. Agent prompts are prepared for the user to assign; this planning task has not launched implementation agents or changed the application.

### Context every agent must receive

- The objective is an NFL betting pipeline that learns from legitimate information, produces reproducible forecasts and measures incremental value against the market. Fantasy product work is outside scope; shared-module changes require checking affected callers.
- Real ML already exists. Do not start from “there is no ML,” rebuild every expert, or infer model quality from a working UI. The unresolved issue is trustworthy data, numerical correctness, training/serving integration and honest measurement.
- Use the active checkout, inspect its dirty changes, and reconcile prior work. The latest source inspection here was HEAD `21789a9` with dataset/lab/governance edits in progress. Earlier database counts belong to their recorded inspection; they are not automatically current.
- Reuse the installed `research/.venv` and the existing data, temporal, probability, decision and execution contracts. Do not choose a new database/framework simply because a research report mentions one.
- Work from immutable extracts or disposable database copies for experiments. Importing database-owning app modules can initialize state; inspect the import chain and use explicit test databases. Preserve append-only evidence and original failed runs.
- Read only the relevant research bundle plus its verification notes at first. Read a primary paper's relevant assumptions before implementing its mathematics. A report's recommended code change is an engineering suggestion, not a theorem.
- Separate development results, reconstructed historical evidence, actual prospective capture and confirmed execution. A manually recorded acceptance is not an independently confirmed sportsbook fill; the current execution lifecycle explicitly distinguishes that.
- A valid model may legitimately predict little beyond the market. Do not force nonzero model influence, relax an invalid-input check or select a convenient subset to make the result look successful.
- Keep learning and valid shadow scoring available when betting evidence is insufficient. Source integrity, forecast validity, evidence qualification and exposure checks have distinct purposes.
- Every new comparison belongs in the trial registry, including abandoned settings and post-hoc slices. “The test season is later” does not make repeatedly inspected history untouched.
- Output numbers only when computed. Use null plus a reason for unknowns, not invented probabilities, reconstructed timestamps presented as observations, or estimated test results.

### Reading priority and how to handle contradictory research

Start with the current package, the relevant code/tests, and one or two indexed reports. Use the [research index](../archive/recovery-indexes/START-HERE-research-and-audits.md) to find the broader corpus and the [complete inventory](../archive/recovery-indexes/INDEX.md) for supporting documents. The recovered research is substantial, but this plan does not claim every page has been independently reread or every recommendation validated.

The September 14 verification reviews are particularly useful:

- [Point-in-time architecture corrections](../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-point-in-time-ml-architecture.json): mutable tables, training/serving skew and why a single event timestamp is inadequate.
- [Walk-forward corrections](../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-walk-forward-validation.json): do not misquote sufficient conditions for cross-validation as universal prohibitions; deployment realism and non-stationarity justify our chronology. Synthetic finance comparisons do not establish the best NFL protocol.
- [Calibration/authority corrections](../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-bet-authority-calibration.json): do not import unstable ROI claims, assume a prior automatically eliminates no-edge bets, or equate calibration with safe Kelly sizing.
- [JS/Python corrections](../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-js-vs-python-implementation.json): claims that no alternative bindings exist, that ONNX must use float32, or that a toy tree is a production learner were overstated. Our Python-first choice is based on existing infrastructure and parity, not those claims.
- [QB/availability corrections](../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-qb-injury-availability-value.json): benchmark formulas, data cutoffs and repository terms must be checked before reuse.

Some old reports prescribe native JS, prohibit new Python dependencies, require a particular old significance gate, or say “read-only tonight.” Those are dated implementation/session choices. They do not override the current user-authorized scope, Python-first architecture or the need to repair a defective gate. Keep the underlying lesson—chronology, explicit authority and verification—without reinstating obsolete mechanics.

In particular: Holm does not require independent base p-values, but it does require valid base tests. Do not repeat the old grouping of Holm with independence-dependent corrections. Likewise, a weighted conformal or block method is not automatically guaranteed under arbitrary NFL drift; state its actual assumptions and measured behavior.

### Research-backed mistakes to avoid

The references below point to recovered reports and, where available, verification corrections. They explain the design constraints. Any numerical guarantee must be checked against its primary source and the implemented assumptions before being advertised.

| ID | Do not do this | Required alternative and verification | Research reading |
|---|---|---|---|
| R01 | Join old games to today's final feature values and call the result historical | Retain publication, receipt, extraction and revision clocks; mutate future rows to test invariance | [F05 point-in-time](../research/advanced-methods-and-github/F05-bitemporal-pit.md) and architecture verification |
| R02 | Invent first receipt from provider publication or request start | Preserve actual response receipt; label reconstructions and timing uncertainty | F05; current quote/event contracts |
| R03 | Recreate Wednesday injury status from a final Friday report | Preserve exact source versions; unknown earlier versions stay unknown | F05; QB/availability verification |
| R04 | Fit preprocessing, team ratings, availability or calibration on the whole dataset before splitting | Fit the entire dependency chain inside earlier folds, retaining row-level lineage | Walk-forward and architecture verification |
| R05 | Stack in-sample predictions from component models | Use earlier out-of-fold component predictions and regularized combination | [F02 forecast combination](../research/advanced-methods-and-github/F02-forecast-combination.md) |
| R06 | Add many correlated experts because more models sound stronger | Compare a small candidate family; measure collinearity and incremental value; fit any reduction only on training data | F02 |
| R07 | Treat a 1999–2025 dataset as 25 years of equally informative modern football | Report era/feature coverage and time-weighted sample size; test recency choices inside the training protocol | [F08 dynamic ratings](../research/advanced-methods-and-github/F08-bayesian-state-space-ratings.md), [F15 shrinkage](../research/advanced-methods-and-github/F15-team-strength-shrinkage.md) |
| R08 | Turn millions of plays or repeated book quotes into millions of independent betting outcomes | Group by game/week and preserve the relevant dependence in uncertainty estimates | Walk-forward verification; F06 |
| R09 | Choose a favorable metric, subgroup, seed, horizon or start year after seeing results without counting the search | Preregister the comparison; retain all attempts and changes | [F06 multiplicity](../research/advanced-methods-and-github/F06-trial-registry-multiplicity.md), [GF10 registry](../research/advanced-methods-and-github/GF10-trial-registry-preregistration-code.md) |
| R10 | Use PBO/DSR as an objective to optimize or claim they restore a used holdout | Treat them as assumption-dependent diagnostics; confirm redesigned models on later uninspected data | F06; walk-forward verification |
| R11 | Discount model trials using incomparable ROI/MAE/Brier sequences without justification | Use aligned loss panels and a declared comparison family; validate dependence treatment | F06; statistical audit issue in this plan |
| R12 | Repeatedly check ordinary significance and stop when it looks good | Use prespecified review times or independently verified sequential methods with their assumptions satisfied | [F07 sequential inference](../research/advanced-methods-and-github/F07-sequential-inference-fix.md) |
| R13 | Assume a wide predictive interval means the expected edge is too uncertain, or vice versa | Distinguish outcome variability, model uncertainty and calibration uncertainty in the contract | F11; calibration/authority verification |
| R14 | Treat conformal coverage as proof of accuracy, cover probability or profit | Measure interval coverage/width separately from proper probability scores and executable returns | [F11 conformal](../research/advanced-methods-and-github/F11-conformal-calibration.md), [GF08 code](../research/advanced-methods-and-github/GF08-conformal-prediction-code.md) |
| R15 | Reuse one residual distribution/calibrator across different model identities and price horizons | Bind calibration to the actual prediction and contract; use earlier calibration data | F11; calibration/authority verification |
| R16 | Price an integer spread from a non-push binary probability without push mass | Return unconditional win/push/loss probabilities and use exact-price EV | [F17 NFL margins](../research/advanced-methods-and-github/F17-margin-distribution-lit.md); probability contracts |
| R17 | Copy a soccer goal model or fixed historical NFL standard deviation as the full score model | Validate NFL score support, key margins, tails and era behavior; compare simpler distributions | F17; [F01 simulator mechanics](../research/advanced-methods-and-github/F01-drive-sim-mechanics.md) |
| R18 | Calibrate around broken simulator mechanics and declare the physics fixed | First validate possessions, field direction, clocks, turnovers and period/OT behavior | F01, F17 |
| R19 | Treat related bet legs/positions as independent | Model or conservatively constrain dependence; fit copulas only after useful calibrated marginals exist | [F10 copulas](../research/advanced-methods-and-github/F10-copula-correlation.md), [GF06 dependence code](../research/advanced-methods-and-github/GF06-copula-dependence-code.md) |
| R20 | Convert a coach quote into an arbitrary injury probability or point adjustment | Extract supported facts; learn availability and impact from earlier labeled examples | [N13 injury interactions](../research/advanced-methods-and-github/N13-injury-network-propagation.md); QB/availability verification |
| R21 | Call market movement after a story its causal effect | Separate prediction from causal identification; handle overlapping events, price history, receipt delays and controls | [F13 news impact](../research/advanced-methods-and-github/F13-causal-news-impact.md) |
| R22 | Feed a modern LLM a historical game and accept its remembered outcome as blind prediction | Use span-supported extraction and prospective validation; maintain reconstruction labels | Architecture/calibration reviews; current AI audit |
| R23 | Treat publication, extraction, truth, activity probability and win probability as one confidence number | Keep each quantity separately named and measured | F05, N13, F13 |
| R24 | Transfer rankings, thresholds or claimed profits from baseball, NBA or finance directly to NFL | Use them as hypotheses/reference math; test on appropriate NFL information and outcomes | F15; walk-forward and calibration verification |
| R25 | Assume a known advanced method or GitHub repository is correct, licensed for reuse, or production ready | Read relevant code/terms, pin a version, use independent fixtures and an actual full-pipeline comparison | [GF09 nflverse](../research/advanced-methods-and-github/GF09-nflverse-ecosystem-code.md), GitHub catalog and verification reviews |
| R26 | Present better CLV and better returns from the same bets as two independent proofs | Report both, recognize dependence, use exact contracts and a stated close benchmark | F13; calibration/authority verification |
| R27 | Increase stakes or remove safeguards because the model now produces non-market numbers | Require valid outputs, matching calibration, explicit evidence and separately authorized betting policy | Calibration/authority verification |
| R28 | Call an uncomputable robustness test a pass | Return not-estimable/inconclusive with the missing sample requirement | F06/F07; new error-analysis finding below |

### Additional gaps found in the current source

This was a targeted review, not a new claim of complete line-by-line coverage. Findings refer to `21789a9` plus the reported working changes. Recheck before implementation. “Reproduced” below means isolated synthetic behavior, not demonstrated financial loss. The [probe results](../audits/plan-code-checks/PLAN-CODE-CHECKS.json) preserve the output.

| ID / priority | Evidence | Required work and completion check |
|---|---|---|
| C01 / P1 | `server/betting/nfl/contracts/forecast-packet.js:89–163`: isolated probes accepted an invalid receipt timestamp, null/empty feature values, a nonfinite feature, odds of zero, `market='totals'` with spread-style fields, and a cutoff after kickoff | WP02/WP04/WP13: validate field types, enum combinations, timestamp ordering, finite values, allowed missingness and schema compatibility. Each reproduced malformed case needs a regression test. |
| C02 / P1 | Same module, `packetHash` at line 193: `[NaN]` and `[null]` yielded identical hashes through JSON serialization; nonfinite features also passed validation | Validate before hashing/sealing or make nonfinite values unrepresentable. Preserve legitimate explicit null/missing values. Test semantic distinctions rather than replacing every null with zero. |
| C03 / P1 | `nfl-t60-packet.js::resolvePacketMarketQuote` independently chooses latest home/away rows. An isolated fixture returned home −3 and away +2.5 as one available result without mismatch disclosure; downstream `quoteFor` uses the home timestamp for either side | WP07/WP15: preserve per-side identity/time and exact contracts. Two different lines can be individual offers, but cannot be treated as opposing prices for one de-vigged contract. Add asynchronous-update and moved-line fixtures. |
| C04 / P2 | The same resolver chooses a preferred book before checking it has a home quote. A fixture with only an away quote there and a complete second book returned unavailable | Select among eligible complete candidates under a declared policy or state why a single-sided quote is used. Test fallback without fabricating a missing price. |
| C05 / P1 | `t60-runner.js:141–235`: selection reads only `state='scheduled'`; a board/tape failure leaves the row `frozen`. The inspected `runT60Pass` has no separate frozen-packet retry phase | WP15/WP18: recover from frozen evidence without refetching its inputs. Distinguish an on-time result from a late reconstruction; record actual completion/action times. Retry idempotently if a tape write succeeded before linking the observation failed. No claim is made here about the cause of each historical stranded row. |
| C06 / P1 for historical cutoff use | `nfl-t60-packet.js:674` constructs all historical kickoffs with fixed `-04:00`; its comment acknowledges the standard-time error | WP03/WP07: use a canonical UTC kickoff or an explicit America/New_York conversion with date/DST tests. Existing coarse diagnostic output is not a safe T−60 training builder. |
| C07 / P1 | `server/news/store.js:33–47` updates headline/body/publication metadata on a duplicate row while retaining its original `ingested_at` | WP08/WP09: preserve immutable document versions before updating the current view. Today's revised body plus an old ingestion clock is not proof that body was known earlier. Test a Friday edit of a Wednesday article. |
| C08 / P2, coverage-contract risk | `nfl-t60-packet.js` injury/news queries admit unresolved teams; the news coverage query also lacks a verification-state filter. These paths primarily report counts, not frozen claim values | WP03/WP09/WP15: separate discovered, identity-resolved, verified, timely and actually consumed counts. Do not count unknown-team/unverified evidence as usable game features. Preserve raw records for later resolution. |
| C09 / P2 | `nfl-replay.js:648` already implements error slicing, Holm adjustment and effect checks. At line 721, fewer than three seasons returns `robust: true` with a caveat | WP14/WP20: reuse useful code, replace not-estimable-as-pass with an explicit state, retain full-precision test values for decisions and review base-test assumptions. Passing a later heuristic does not establish valid inference. |
| C10 / design gap | `nfl-slice-diagnostic.js` analyzes historical expert rows, derives probabilities from a normal-CDF approximation and joins current `game_lines`; `nfl-replay.js::analyzeErrors` takes bets | WP14: adapt reporting to saved all-game candidate probabilities, abstentions and frozen context. Existing diagnostics are useful foundations but not the complete new model error ledger. |
| C11 / design gap | `nfl-family-contribution.js` already has matched-game comparisons and paired weekly bootstrap; it is oriented to the current ensemble and spread path | WP12/WP14: reuse metric contracts, but verify full refits and upstream lineage for the new Python candidate; separately wire totals. Do not label a family with no numerical consumer a scientific zero-effect result. |
| C12 / design gap | The declared forecast contract and current packet-board path are spread oriented; totals appear in research but are not automatically supported by this contract | WP13/WP15–WP17: version market-discriminated spread/total schemas, scoring and settlement. Complete one spread slice first, then a full total slice; do not pass totals through by renaming one field. |

**Verification performed:** the existing pure forecast-packet test file passed all 14 tests. The additional isolated probes still accepted the seven malformed cases above. This is concrete evidence that passing the existing suite does not cover these cases. No application modules owning a database were imported for the probes, and no application source, live database or bet settings were changed. The quote selector was evaluated in an isolated JavaScript context with synthetic values.

### What a good deliverable looks like

Every package returns one concise human report plus structured artifacts. Its evidence must let the next agent reproduce the result without relying on the previous agent's explanation.

| Deliverable | Required content | Unacceptable substitute |
|---|---|---|
| Status/change report | Actual source identity, package ID, existing work reconciled, changed files, completed state, remaining dependency | “Implemented everything” without evidence |
| Source/coverage manifest | Source versions, timing/provenance, unique games, exclusions by reason, fetch/extraction cost where applicable | Total row count or “data cleaned” |
| Example lineage | One game and each upstream source/feature/artifact reference, including clocks and missingness | Only a hash, aggregate counts or a screenshot |
| Training/selection record | All candidates/settings, exact splits, fitting row IDs, seeds, upstream OOF artifacts and failures | Only the winner's score |
| Prediction ledger | All eligible games, actual saved outputs/probabilities, quoted contract, artifact/policy identity, abstentions | Selected winning bets or regenerated predictions |
| Evaluation | Paired baseline comparison, metric definition, sample/coverage, uncertainty, search exposure and verdict | ROI alone, unsupported significance or “beats Vegas” |
| Verification | Actual command, runtime, exit status, test counts, representative failures addressed | A test plan described as tests run |
| Handoff | Artifacts, accepted contracts, next dependency, remaining uncertainty and rollback/recovery behavior | A long narrative with no executable next step |

An example **synthetic verification result**, not a real model result: a Wednesday DNP report, Friday questionable update and pregame inactive notice produce different eligible feature snapshots. Adding the later inactive notice leaves Wednesday's saved feature hash and prediction unchanged. Running a revised article through the source store creates a new version instead of making Friday text appear received Wednesday. Running the same completed extraction again emits no duplicate events.

An example **synthetic pricing check**: `P(win)=0.53`, `P(push)=0.02`, `P(loss)=0.45`, odds `−110` gives expected profit per unit risked of `0.53×(100/110)−0.45 ≈ 0.03182`. Probabilities sum to one; a push returns stake. This is an arithmetic fixture, not an estimated edge or permission to bet.

An example **acceptable performance verdict**: “Candidate comparison completed, coverage and parity verified. Its improvement interval includes zero, so predictive benefit is inconclusive. Shadow scoring is connected; betting qualification is unchanged.” A negative or inconclusive finding can complete the engineering task successfully.

For artifact paths use a package/run directory under the repository's existing evidence layout, with manifest, commands, test results, coverage, predictions and comparison as applicable. Store large source/data/model artifacts in the established data/artifact location with a manifest reference; do not commit the live database or raw secrets. Generated filenames and CLI names proposed in this plan must be labeled proposed until implemented and exercised.

### Coordination and file ownership

One lead owns shared contracts, schema/migrations, the master ledger and cross-package integration. A package agent owns its assigned source/test changes and returns a patch or commit plus evidence. A reviewer checks the result against an independent expected behavior, not just the implementation's own outputs.

Do not concurrently edit `dataset.py`, forecast-packet contracts, the migration list or shared governance files without explicit ownership. Agents discovering a cross-package issue should report its reproduction and dependency to the owner. Do not reset another worker's changes. A large number of research or implementation agents is not a quality metric.

The critical handoff chain is: stable identities/clocks → feature/schema contract → weekly training/probability outputs → frozen serving/settlement → evaluation. News retrieval can progress once the document/timing contract exists; richer text features must not block the basic model. Review one complete spread path before copying the design to totals.

### Review prompt to use after each package

> Review this package against its assigned WP specification, R guardrails and relevant C findings. Inspect the actual diff, tests and saved artifacts. Independently recompute at least one numerical or temporal result where applicable. Check that the output corresponds to the same data, model, horizon and code used by the consumer. Search for a counterexample the new tests do not cover. Classify findings by consequence and separate confirmed reproductions from hypotheses. Do not declare a whole system qualified from helper tests, require unrelated scope, or silently fix the author's code while reviewing. Return accept, changes required, or inconclusive; name the exact evidence and remaining integration dependency.

### Lead-agent kickoff prompt

> Implement the Gridiron betting rebuild from GRIDIRON-MASTER-PLAN.md. First reconcile the active checkout, existing implementation and dirty changes. Use the agent operating manual and WP01–WP20; begin with the first unfinished dependency, not another broad research sweep. Resolve the new C01–C12 findings in their owning packages. Assign bounded package prompts only when delegation is authorized and file ownership is clear. Require the specified evidence from each package, review it, and integrate one complete frozen spread prediction through settlement before broadening to totals or advanced models. Preserve existing research and failed experiments. Keep model learning, data integrity and betting authority distinct. Continue useful work when a source gap blocks another package; record unknowns honestly. Return the updated ledger, actual artifacts/tests, measured results and limitations. A working pipeline with no demonstrated edge is an acceptable outcome; do not manufacture a positive verdict.

## Package prompts and exact edit map

Use the shared operating manual with each prompt. Existing paths below were checked during planning, but must be rechecked against the active checkout. Paths are relative to the repository root declared in each prompt. Proposed modules are suggestions, not claims that files or commands already exist. The lead owns shared contracts/migrations and must resolve overlapping edit ownership before assigning concurrent work.

### WP01 prompt — Reconcile implementation and preserve baseline

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** None; starts the implementation.

**Existing code/docs to inspect and edit within scope:** `docs/CLAUDE-NEXT-STEPS.md`, `docs/reference/model-governance-manual.md`.

**Existing verification to extend:** Choose focused tests after inspecting the active callers; do not claim a nonexistent test command was run.

**Proposed additions, only if the existing code cannot own the contract cleanly:** Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.

**Task:** Reconcile the current checkout, dirty-file ownership, deployed version and prior evidence. Classify earlier findings using actual source/tests rather than comments. Create the single work ledger and preserve the incumbent configuration, predictions and metric definitions. Do not overwrite a current plan or rerun paid/live jobs just to inventory them.

**Required return:** A current status ledger; a frozen baseline manifest or an explicit explanation of missing reconstruction evidence; a dependency/ownership map identifying the next unfinished package.

**Acceptance/counterexamples:** Recompute one available baseline example from its saved inputs. Distinguish historical inspection counts from refreshed observations. A written claim that a bug is fixed is not verification.

**Research guardrails:** R01,R09,R25. **Code findings:** C01–C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP02 prompt — Repair defects and gate responsibilities

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP01.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-orthogonal-specialists.js`, `server/services/nfl-qbr.js`, `server/services/trial-statistics.js`, `scripts/run-purged-evaluation.mjs`, `server/services/model-governance.js`, `server/betting/nfl/contracts/forecast-packet.js`.

**Existing verification to extend:** `test/nfl-qbr.test.js`, `test/trial-statistics.test.js`, `test/forecast-packet-contract.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** test/nfl-specialist-weight-shape.test.js

**Task:** Reproduce relevant numerical/data/gate defects on isolated fixtures before fixing them. Check specialist dimensions, QBR season identity and the current DSR promotion integration. Resolve validator behavior C01/C02 with the contract owner. Separate invalid data/output from insufficient betting evidence so valid shadow predictions remain measurable. Do not repair a statistical assumption merely by lowering its threshold.

**Required return:** A defect-by-defect before/after report and targeted regression tests; one gate responsibility table with caller, condition, effect and recorded reason.

**Acceptance/counterexamples:** Exercise tall and small design matrices, corrupt or duplicate season rows, malformed packet fields and a valid forecast withheld only from staking. Reference-check statistical calculations before using them for promotion.

**Research guardrails:** R04,R11,R27,R28. **Code findings:** C01,C02.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP03 prompt — Historical identities and exact clocks

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP01 and ownership agreement for dataset/packet contracts.

**Existing code/docs to inspect and edit within scope:** `server/services/team-codes.js`, `server/services/nfl-contract-key.js`, `server/services/nfl-t60-packet.js`, `research/betting/nfl/dataset.py`.

**Existing verification to extend:** `test/team-codes.test.js`, `test/nfl-t60-packet.test.js`, `research/betting/nfl/test_dataset.py`

**Proposed additions, only if the existing code cannot own the contract cleanly:** test/nfl-historical-clock-identity.test.js

**Task:** Define canonical game/player/provider mappings and timestamp precision. Replace the fixed historical -04:00 assumption for cutoff construction with reliable UTC or named-timezone conversion. Resolve player identity from historical roster intervals and retain ambiguous cases. Preserve schedule revisions and distinguish date-only records from precise kickoff instants.

**Required return:** An identity/time dictionary; mapping and exclusion manifest; fixtures for a trade, alias, ambiguous name, neutral venue, reschedule, bye, postseason and winter/summer offset.

**Acceptance/counterexamples:** Check one winter and one summer kickoff independently. A date-only game must not silently qualify as an exact T−60 packet. Later roster changes must not rewrite a frozen historical mapping.

**Research guardrails:** R01,R02,R03. **Code findings:** C06,C08.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP04 prompt — Immutable records and validated contracts

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP02–WP03.

**Existing code/docs to inspect and edit within scope:** `server/betting/nfl/contracts/forecast-packet.js`, `server/services/nfl-bitemporal.js`, `server/services/nfl-decision-tape.js`, `server/db/migrate.js`.

**Existing verification to extend:** `test/forecast-packet-contract.test.js`, `test/nfl-injuries-bitemporal.test.js`, `test/migration-027-populated-upgrade.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A new migration allocated after inspecting the current migration sequence; never rewrite an applied migration

**Task:** Implement the source/event/feature/artifact/decision contracts from WP04. Reuse existing stores and append-only conventions. Validate semantic types, market discriminants, timestamp order, finite numbers and missingness before hashing. Define compatible schema evolution and retain exact values rather than counts. Separate the general forecast schema from the older T−60 source-summary packet with an explicit adapter.

**Required return:** A versioned schema/adapter and migration where needed; real example records; lineage links; old/new compatibility behavior and invalid-record reasons.

**Acceptance/counterexamples:** C01 malformed cases must fail or follow a documented legitimate missing-value path. C02 nonfinite values cannot collapse into null unnoticed. Replaying frozen evidence after source mutations is invariant. Test a populated database copy as well as clean setup.

**Research guardrails:** R01,R02,R13,R15,R16. **Code findings:** C01,C02,C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP05 prompt — Coverage and source admission

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP04.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-feature-coverage.js`, `server/services/nfl-evidence-dataset.js`, `research/betting/nfl/dataset.py`.

**Existing verification to extend:** `test/evidence-dataset.test.js`, `research/betting/nfl/test_dataset.py`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A source-admission manifest in the existing evidence/artifact layout

**Task:** Extend the current source/freshness reports into source-specific admission rules and coverage by game, era, team and horizon. Distinguish discovered, resolved, verified, timely, snapshotted and consumed records. Record every join denominator and exclusion reason. Consult nflverse release schedules and pin source versions; a present-day file is not proof of past availability.

**Required return:** A coverage matrix, source admission contracts and before/after-join game counts with sampled source records. Mark unverifiable timing and missing data explicitly.

**Acceptance/counterexamples:** Removing one optional source does not delete valid football examples. A source with many unrelated/unverified rows cannot pass game-specific readiness. Every excluded example has a reproducible reason.

**Research guardrails:** R01,R03,R07,R08,R25. **Code findings:** C08.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP06 prompt — Shared football features and strength priors

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP05.

**Existing code/docs to inspect and edit within scope:** `research/betting/nfl/dataset.py`, `research/market_lab.py`, `research/tree_lab.py`, `server/services/nfl-features.js`, `server/services/nfl-team-strength.js`, `server/services/nfl-preseason-blend.js`.

**Existing verification to extend:** `research/betting/nfl/test_dataset.py`, `research/test_market_lab.py`, `research/test_tree_lab.py`, `test/nfl-team-strength.test.js`, `test/preseason-blend-cutoff.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.

**Task:** Extend the common builder already being edited; do not fork its chronology. Define the small first feature set, units, missingness and prior-observation ages. Use broad price-independent football history, earlier opponent/QB information and learned shrinkage where justified. Keep labels and unqualified market fields outside the allowlisted model matrix. Preserve old extractor results as explicit comparisons when semantics change.

**Required return:** A feature dictionary, shared extract, consumer-parity report, source lineage and era coverage. Each learned feature names its own training cutoff.

**Acceptance/counterexamples:** Future scores, revised EPA or target-game players cannot change an earlier vector. Home/away signs, away-team rest, Week 1 fallback and optional PBP are covered. Calibrate priors within earlier folds, not globally.

**Research guardrails:** R04,R05,R07,R24. **Code findings:** C06 and earlier dataset chronology findings.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP07 prompt — Exact-horizon quote and betting datasets

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP05; coordinate shared dataset ownership with WP06.

**Existing code/docs to inspect and edit within scope:** `research/betting/nfl/dataset.py`, `server/services/nfl-quote-tape.js`, `server/services/nfl-contract-key.js`, `server/services/nfl-evidence-dataset.js`, `server/services/nfl-t60-packet.js`.

**Existing verification to extend:** `research/betting/nfl/test_dataset.py`, `test/evidence-dataset.test.js`, `test/nfl-t60-packet.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A T−60 extraction entry point under research/betting/nfl, sharing the current dataset module

**Task:** Add exact T−60 examples separately from opening-line experiments. Resolve C03/C04 with a declared eligible-book policy, per-side identities/clocks and correct opposing-contract pairing. Missing closing prices must not discard valid outcome examples. Preserve spread and total label definitions, provenance mode and actual odds. Do not infer a fill from an archived offer.

**Required return:** A betting dataset manifest and quote-selection trace showing retained, missing, stale, mismatched and fallback cases; labels are separate from feature columns.

**Acceptance/counterexamples:** Test a moved handicap, asynchronous opposite-side update, missing preferred-book home side, alternate period and unavailable close. Two individual offers at different lines must not be de-vigged as the same contract.

**Research guardrails:** R02,R08,R16,R26. **Code findings:** C03,C04,C06,C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP08 prompt — Historical news source pilot

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP05; document schema owner assigned.

**Existing code/docs to inspect and edit within scope:** `server/news/ingest.js`, `server/news/store.js`, `server/news/normalize.js`, `server/services/press-conference.js`.

**Existing verification to extend:** `test/news-ingest.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A bounded archive backfill runner with absolute date/team/source filters and resume state

**Task:** Run the specified 2024 Weeks 1–4 engineering pilot only after defining source/version contracts. Use existing stored material, structured reports and official dated archives before expensive transcription. Add content-addressed source versions before updating the current news view. Preserve raw supported content and timing precision. Build an independently reviewed extraction sample and measure coverage/cost before extending seasons.

**Required return:** Source manifests, retrieval/resume log, source-version examples, a reviewed passage set and measured usable coverage/cost. No performance claim from this pilot.

**Acceptance/counterexamples:** A changed Friday body cannot inherit Wednesday ingestion as its own receipt. Repeating the same fetch does not duplicate versions. Missing archives are explicit and do not block the football baseline.

**Research guardrails:** R01,R02,R03,R22,R25. **Code findings:** C07.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP09 prompt — Typed events and historical injury timelines

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP04 and initial WP08 material.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-news-events.js`, `server/services/nfl-news-signal.js`, `server/services/nfl-advanced.js`, `server/services/nfl-bitemporal.js`, `server/services/nfl-t60-packet.js`.

**Existing verification to extend:** `test/nfl-news-events.test.js`, `test/nfl-injuries-bitemporal.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** An absolute-date-range event extraction/replay interface using existing stores

**Task:** Extend supported-span extraction, historical roster resolution, source-version references and separate receipt/extraction clocks. Build the shared as-of state reducer. Retain practice trajectories, contradictions, superseding events and unresolved persistent statuses. Unknown teams and unverified claims remain preserved but are not admitted as usable game features. Keep structured parsing separate from LLM interpretation.

**Required return:** Player/game timelines at T−72h, T−24h and T−60; event schema/examples; extraction quality by claim type; coverage and unresolved-state reports.

**Acceptance/counterexamples:** Test negation, ambiguous pronouns, multi-player stories, an inactive reversal, traded players, byes and long-term IR. Later events cannot alter an earlier snapshot; repeated syndicated text is not independent evidence.

**Research guardrails:** R01,R03,R20,R22,R23. **Code findings:** C07,C08.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP10 prompt — Availability and replacement learning

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP06, WP09 and WP11 protocol; may proceed after baseline launch.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-availability.js`, `server/services/player-availability.js`, `research/betting/nfl/dataset.py`.

**Existing verification to extend:** `test/player-availability.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** research/betting/nfl/availability.py; research/betting/nfl/test_availability.py

**Task:** Define active-status and conditional-usage targets, including healthy non-use and in-game exits. Implement a small regularized availability baseline and earlier-estimated replacement features. Use historical rosters, structured reports and lagged usage. Treat LLM extraction confidence as separate from playing probability. Add text only as a separately registered experiment after structured availability works.

**Required return:** Target dictionary, player model artifacts and chronological OOF outputs, calibration/usage reports and compact game-level availability features.

**Acceptance/counterexamples:** Audit upstream train row IDs for every output used by the game learner. Actual target-game snaps/starters cannot enter features. Compare structured and text additions on identical games with and without contemporaneous market information.

**Research guardrails:** R04,R05,R20,R23,R24. **Code findings:** Earlier news/availability integration findings.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP11 prompt — Registered experiments and bounded model selection

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP01, WP04–WP05; before comparative model fitting.

**Existing code/docs to inspect and edit within scope:** `server/services/research-trials.js`, `server/modeling/registry.js`, `research/requirements.txt`, `research/tree_lab.py`, `research/market_lab.py`.

**Existing verification to extend:** `test/research-trials.test.js`, `test/model-registry-persistence.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A versioned NFL experiment specification under research/betting/nfl

**Task:** Define a machine-readable experiment specification covering data/source mode, target/horizon, folds, candidates, seeds, metrics, calibration, policy and review schedule. Reuse the existing trial registry; inspect whether generic model-registry APIs actually apply to NFL before integrating. Freeze a small ridge/LightGBM configuration family and record all attempted settings, failures and later changes. Snapshot installed dependency versions.

**Required return:** Experiment specification, trial records, candidate budget, runtime/dependency manifest and artifact-naming rules. No hidden best-seed or best-era selection.

**Acceptance/counterexamples:** Changing data, schema, source mode or feature family produces a distinguishable experiment identity. Failed fits and unsuccessful variants remain discoverable. A registration after scoring is labeled retrospective.

**Research guardrails:** R06,R09,R10,R11,R25. **Code findings:** Statistical promotion integration requires current reconciliation.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP12 prompt — Weekly nested training and OOF lineage

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP06–WP07, WP11; availability optional until WP10 ready.

**Existing code/docs to inspect and edit within scope:** `research/betting/nfl/dataset.py`, `research/tree_lab.py`, `research/market_lab.py`, `server/services/purged-walk-forward.js`, `server/services/forecast-combination.js`.

**Existing verification to extend:** `research/betting/nfl/test_dataset.py`, `research/test_tree_lab.py`, `test/purged-walk-forward.test.js`, `test/forecast-combination.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** research/betting/nfl/walk_forward.py; research/betting/nfl/test_walk_forward.py

**Task:** Implement weekly refits matching the master schedule while preserving old seasonal comparisons. Every preprocessing step, upstream learner, early-stopping choice, combiner and calibrator must use earlier data. Keep entire games and related snapshots together. Produce chronological OOF features for downstream fitting, and save train/test row IDs. Do not replace old holdout predictions with fitted values after final refitting.

**Required return:** Runnable weekly experiment entry point, immutable split manifests, all-candidate predictions, selected artifacts and a complete upstream lineage example.

**Acceptance/counterexamples:** A held-out outcome mutation does not change its model or feature inputs. Same-game leakage through player/book/horizon rows is refused. Newly available current-season labels can enter the next scheduled fit under the declared policy.

**Research guardrails:** R04,R05,R07,R08,R09. **Code findings:** C11 reuse requires actual refit verification.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP13 prompt — Probability, calibration and pushes

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP04, WP07, WP11–WP12.

**Existing code/docs to inspect and edit within scope:** `server/betting/nfl/contracts/spread-probabilities.js`, `server/betting/nfl/contracts/forecast-packet.js`, `server/services/nfl-cover-calibration.js`, `server/services/nfl-total-calibration.js`, `server/services/conformal.js`.

**Existing verification to extend:** `test/spread-probabilities.test.js`, `test/nfl-total-calibration.test.js`, `test/forecast-packet-contract.test.js`, `test/conformal-finite-sample.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A Python probability/calibration module with parity fixtures for the declared serving contract

**Task:** Bind probabilities/calibration to model identity and exact market/horizon. Specify spread versus total schemas explicitly. Convert conditional non-push probabilities to unconditional win/push/loss probabilities using earlier-estimated push mass. Keep conformal intervals distinct from betting probabilities. Reuse existing corrected math and independent references; do not port a second implementation without parity evidence.

**Required return:** Market-discriminated probability contract, earlier calibration manifest, proper-score and coverage reports, key-margin/push fixtures and explicit unsupported cases.

**Acceptance/counterexamples:** Probabilities are finite, sum to one and yield correct price-based EV. Changing the line requires rescoring that contract. C01 malformed market combinations fail; valid totals require their own complete path, not a renamed spread.

**Research guardrails:** R13,R14,R15,R16,R17. **Code findings:** C01,C02,C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP14 prompt — Measurement and actionable error analysis

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP11–WP13; reuse historical reports as references only.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-replay.js`, `server/services/nfl-slice-diagnostic.js`, `server/services/nfl-family-contribution.js`, `server/services/stats-util.js`.

**Existing verification to extend:** `test/nfl-replay-error-analysis.test.js`, `test/nfl-family-contribution.test.js`, `test/family-contribution-scoring.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A report adapter for the new Python row-level prediction ledger

**Task:** Reuse existing diagnostics and paired-score contracts, but connect actual all-game outputs, abstentions and frozen context from the new learner. Fix not-estimable-as-robust in C09. Separate loss, probability and return comparisons; evaluate base-test/dependence assumptions before applying multiplicity. Preserve full precision for decisions and round only displays. Measure full-pipeline refitted ablations, not just disabled outputs.

**Required return:** A reproducible error report and ranked hypothesis backlog; row-level inputs; matched baselines; sample/coverage and uncertainty; explicit inconclusive states.

**Acceptance/counterexamples:** A one-season slice cannot pass a multi-season check. No-bet games are retained for forecast evaluation. A family with no numerical consumer is labeled disconnected. Hypotheses discovered in the report require later confirmation.

**Research guardrails:** R08,R09,R11,R24,R28. **Code findings:** C09,C10,C11.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP15 prompt — Trained-artifact serving and frozen recovery

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP04, WP07, WP12–WP13.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-auto-picks.js`, `server/services/nfl-t60-packet.js`, `server/betting/nfl/contracts/forecast-packet.js`, `server/betting/nfl/strategy/t60-runner.js`, `server/services/nfl-decision-tape.js`.

**Existing verification to extend:** `test/t60-runner.test.js`, `test/forecast-packet-contract.test.js`, `test/nfl-decision-identity-pipeline.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A narrow versioned Python artifact-scoring adapter with integration tests

**Task:** Connect the actual fitted pipeline to the app through a narrow scoring interface. Freeze all consumed features, quotes, transforms and model identities; no mutable-table rereads in the learned path. Implement recovery of frozen observations using their stored evidence and idempotent tape linkage. Preserve actual late completion times and classify replay versus on-time decisions correctly.

**Required return:** One complete spread-game demonstration and then a slate; artifact/snapshot/decision linkage; numerical parity; explicit fallback and recovery traces. Extend to totals only with WP13 contracts ready.

**Acceptance/counterexamples:** A restart or source mutation cannot change frozen outputs. Invalid artifacts fail explicitly. A tape write/link interruption neither duplicates the decision nor strands it forever. The same quote is not falsely assigned another side’s timestamp.

**Research guardrails:** R01,R02,R15,R16,R27. **Code findings:** C01–C05,C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP16 prompt — Betting policy and related exposure

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP02, WP07, WP13, WP15.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-execution-edge.js`, `server/services/nfl-execution-exposure.js`, `server/services/nfl-execution-staking-policy.js`, `server/services/model-governance.js`, `server/services/nfl-auto-picks.js`.

**Existing verification to extend:** `test/nfl-execution-edge.test.js`, `test/nfl-execution-exposure.test.js`, `test/nfl-execution-decision.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.

**Task:** Make one versioned authority/execution policy consume saved valid probabilities and actual offered odds. Keep shadow prediction available while qualifications are unresolved. Trace every gate result and reason. Preserve related-position accounting across books/markets. Review any AI allocation separately against a deterministic baseline. Do not increase live stakes as a side effect of integration.

**Required return:** Policy contract, deterministic EV/action fixtures and examples of valid forecasts that abstain for distinct reasons; exposure and duplicate-opportunity behavior.

**Acceptance/counterexamples:** Push EV, invalid price, stale quote, duplicate same-side opportunity, opposite positions at different lines and no-edge cases behave explicitly. An LLM explanation cannot silently change numerical authority.

**Research guardrails:** R16,R19,R23,R27. **Code findings:** C03 and market-specific policy integration.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP17 prompt — Independent settlement and CLV grading

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP07, WP13, WP15–WP16.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-execution-lifecycle.js`, `server/services/nfl-execution-clv.js`, `server/services/nfl-execution.js`, `server/services/nfl-decision-tape.js`.

**Existing verification to extend:** `test/nfl-execution-lifecycle.test.js`, `test/nfl-execution-clv.test.js`, `test/nfl-execution-clv-abstained.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.

**Task:** Grade the exact recorded contract and price with versioned settlement rules. Keep actual confirmed fills, user-reported acceptance and paper opportunities distinct. Append corrections without rewriting original predictions. Define the close benchmark and report missing closes separately. Handle spreads and totals through their declared contracts, not shared ambiguous field names.

**Required return:** Independent settlement fixture calculations, a reconciled row-to-summary ledger, closing-reference specification and cancellation/push/correction examples.

**Acceptance/counterexamples:** Win/loss/push/void and positive/negative American odds reconcile to risked stake and profit. Missing close does not erase a settled outcome. CLV at different lines is not mislabeled same-contract price improvement.

**Research guardrails:** R16,R19,R26,R27. **Code findings:** C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP18 prompt — Reliable jobs, migrations and resource limits

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP04, WP08–WP09 as available, WP15–WP17.

**Existing code/docs to inspect and edit within scope:** `server/betting/nfl/strategy/t60-runner.js`, `server/db/migrate.js`, `server/services/nfl-news-events.js`, `server/news/store.js`, `server/platform/paths.js`.

**Existing verification to extend:** `test/t60-runner.test.js`, `test/nfl-prospective-collection.test.js`, `test/migration-027-populated-upgrade.test.js`, `test/news-ingest.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** Targeted job-recovery, artifact-publication and populated-schema tests

**Task:** Implement observable job states, bounded retries, resume cursors and atomic artifact publication. Separate source arrival from scheduled fitting. Recover frozen decisions without new inputs and retain the previous eligible model if a fit fails. Exercise migration behavior on populated copies and append-only guards. Track accepted-document costs, time, memory and failure concentration from actual runs.

**Required return:** Lifecycle/retry specification, restart evidence, populated/clean migration results, resource report and a recovery/rollback runbook.

**Acceptance/counterexamples:** Interrupt fetch, extraction, artifact publish and tape linking. Resume without duplicate writes or repeat billing for cached unchanged work. Missing a cutoff remains visible; no job backdates receipt or completion.

**Research guardrails:** R01,R02,R25. **Code findings:** C05,C07.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP19 prompt — Challenge the complete system independently

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** M3 complete path; can review individual packages earlier.

**Existing code/docs to inspect and edit within scope:** `test/offline-guard.mjs`, `test/forecast-packet-contract.test.js`, `test/nfl-replay-error-analysis.test.js`, `test/nfl-family-contribution.test.js`.

**Existing verification to extend:** Choose focused tests after inspecting the active callers; do not claim a nonexistent test command was run.

**Proposed additions, only if the existing code cannot own the contract cleanly:** An integrated frozen-prediction/chronology challenge suite and self-contained synthetic fixtures

**Task:** Review the complete implemented path against the master threat cases and all C findings. Write tests that cross module boundaries, not mirrors of implementation formulas. Use independent arithmetic/temporal expectations, known-leak positive controls and repeated appropriate no-signal controls. Inspect import-time effects before testing, keep databases disposable and prevent provider calls. Report failures to their owning packages rather than rewriting unrelated production code.

**Required return:** A reproducible adversarial verification report, coverage of each failure class, actual commands and clear unresolved findings. Preserve raw negative outcomes.

**Acceptance/counterexamples:** Exercise future mutation, source revisions, historical identities, duplicate stories, player/book split leakage, moved contracts, malformed packets, restarts and metric reconciliation. Passing 14 existing packet tests is insufficient if the seven known malformed cases still pass validation.

**Research guardrails:** R01–R28. **Code findings:** C01–C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP20 prompt — Prospective ledger and evidence-driven expansion

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP14–WP19; protocol must be frozen before using future results.

**Existing code/docs to inspect and edit within scope:** `server/services/research-trials.js`, `server/services/model-governance.js`, `server/services/nfl-replay.js`, `docs/CLAUDE-NEXT-STEPS.md`.

**Existing verification to extend:** `test/research-trials.test.js`, `test/nfl-replay-error-analysis.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A versioned prospective protocol and hypothesis-backlog artifact in the existing evidence layout

**Task:** Freeze the adaptive fitting recipe, prospective observation horizon and review schedule. Preserve every eligible prediction and abstention, including version changes and missed observations. Use the error report to propose the smallest fix for a measured weakness. Require later confirmation for discovered hypotheses and retain rejected/inconclusive additions. Distinguish engineering completion from predictive value and betting qualification.

**Required return:** Prospective protocol, versioned evidence ledger, ranked improvement backlog and one example accept/reject/inconclusive decision with its evidence requirements.

**Acceptance/counterexamples:** Changing a feature/search/policy starts a new evidence segment. A failed or uncomputable robustness check never becomes a pass. Advanced methods need a specific error, suitable data and a simpler baseline before implementation.

**Research guardrails:** R09,R10,R12,R24,R27,R28. **Code findings:** C09–C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.
