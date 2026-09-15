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

Start with the current package, the relevant code/tests, and one or two indexed reports. Use the [research index](START-HERE-research-and-audits.md) to find the broader corpus and the [complete inventory](recovered-evidence/INDEX.md) for supporting documents. The recovered research is substantial, but this plan does not claim every page has been independently reread or every recommendation validated.

The September 14 verification reviews are particularly useful:

- [Point-in-time architecture corrections](recovered-evidence/sept14/wf_65f8c9e5-bf5/verify-point-in-time-ml-architecture.json): mutable tables, training/serving skew and why a single event timestamp is inadequate.
- [Walk-forward corrections](recovered-evidence/sept14/wf_65f8c9e5-bf5/verify-walk-forward-validation.json): do not misquote sufficient conditions for cross-validation as universal prohibitions; deployment realism and non-stationarity justify our chronology. Synthetic finance comparisons do not establish the best NFL protocol.
- [Calibration/authority corrections](recovered-evidence/sept14/wf_65f8c9e5-bf5/verify-bet-authority-calibration.json): do not import unstable ROI claims, assume a prior automatically eliminates no-edge bets, or equate calibration with safe Kelly sizing.
- [JS/Python corrections](recovered-evidence/sept14/wf_65f8c9e5-bf5/verify-js-vs-python-implementation.json): claims that no alternative bindings exist, that ONNX must use float32, or that a toy tree is a production learner were overstated. Our Python-first choice is based on existing infrastructure and parity, not those claims.
- [QB/availability corrections](recovered-evidence/sept14/wf_65f8c9e5-bf5/verify-qb-injury-availability-value.json): benchmark formulas, data cutoffs and repository terms must be checked before reuse.

Some old reports prescribe native JS, prohibit new Python dependencies, require a particular old significance gate, or say “read-only tonight.” Those are dated implementation/session choices. They do not override the current user-authorized scope, Python-first architecture or the need to repair a defective gate. Keep the underlying lesson—chronology, explicit authority and verification—without reinstating obsolete mechanics.

In particular: Holm does not require independent base p-values, but it does require valid base tests. Do not repeat the old grouping of Holm with independence-dependent corrections. Likewise, a weighted conformal or block method is not automatically guaranteed under arbitrary NFL drift; state its actual assumptions and measured behavior.

### Research-backed mistakes to avoid

The references below point to recovered reports and, where available, verification corrections. They explain the design constraints. Any numerical guarantee must be checked against its primary source and the implemented assumptions before being advertised.

| ID | Do not do this | Required alternative and verification | Research reading |
|---|---|---|---|
| R01 | Join old games to today's final feature values and call the result historical | Retain publication, receipt, extraction and revision clocks; mutate future rows to test invariance | [F05 point-in-time](recovered-evidence/research2/F05-bitemporal-pit.md) and architecture verification |
| R02 | Invent first receipt from provider publication or request start | Preserve actual response receipt; label reconstructions and timing uncertainty | F05; current quote/event contracts |
| R03 | Recreate Wednesday injury status from a final Friday report | Preserve exact source versions; unknown earlier versions stay unknown | F05; QB/availability verification |
| R04 | Fit preprocessing, team ratings, availability or calibration on the whole dataset before splitting | Fit the entire dependency chain inside earlier folds, retaining row-level lineage | Walk-forward and architecture verification |
| R05 | Stack in-sample predictions from component models | Use earlier out-of-fold component predictions and regularized combination | [F02 forecast combination](recovered-evidence/research2/F02-forecast-combination.md) |
| R06 | Add many correlated experts because more models sound stronger | Compare a small candidate family; measure collinearity and incremental value; fit any reduction only on training data | F02 |
| R07 | Treat a 1999–2025 dataset as 25 years of equally informative modern football | Report era/feature coverage and time-weighted sample size; test recency choices inside the training protocol | [F08 dynamic ratings](recovered-evidence/research2/F08-bayesian-state-space-ratings.md), [F15 shrinkage](recovered-evidence/research2/F15-team-strength-shrinkage.md) |
| R08 | Turn millions of plays or repeated book quotes into millions of independent betting outcomes | Group by game/week and preserve the relevant dependence in uncertainty estimates | Walk-forward verification; F06 |
| R09 | Choose a favorable metric, subgroup, seed, horizon or start year after seeing results without counting the search | Preregister the comparison; retain all attempts and changes | [F06 multiplicity](recovered-evidence/research2/F06-trial-registry-multiplicity.md), [GF10 registry](recovered-evidence/research2/GF10-trial-registry-preregistration-code.md) |
| R10 | Use PBO/DSR as an objective to optimize or claim they restore a used holdout | Treat them as assumption-dependent diagnostics; confirm redesigned models on later uninspected data | F06; walk-forward verification |
| R11 | Discount model trials using incomparable ROI/MAE/Brier sequences without justification | Use aligned loss panels and a declared comparison family; validate dependence treatment | F06; statistical audit issue in this plan |
| R12 | Repeatedly check ordinary significance and stop when it looks good | Use prespecified review times or independently verified sequential methods with their assumptions satisfied | [F07 sequential inference](recovered-evidence/research2/F07-sequential-inference-fix.md) |
| R13 | Assume a wide predictive interval means the expected edge is too uncertain, or vice versa | Distinguish outcome variability, model uncertainty and calibration uncertainty in the contract | F11; calibration/authority verification |
| R14 | Treat conformal coverage as proof of accuracy, cover probability or profit | Measure interval coverage/width separately from proper probability scores and executable returns | [F11 conformal](recovered-evidence/research2/F11-conformal-calibration.md), [GF08 code](recovered-evidence/research2/GF08-conformal-prediction-code.md) |
| R15 | Reuse one residual distribution/calibrator across different model identities and price horizons | Bind calibration to the actual prediction and contract; use earlier calibration data | F11; calibration/authority verification |
| R16 | Price an integer spread from a non-push binary probability without push mass | Return unconditional win/push/loss probabilities and use exact-price EV | [F17 NFL margins](recovered-evidence/research2/F17-margin-distribution-lit.md); probability contracts |
| R17 | Copy a soccer goal model or fixed historical NFL standard deviation as the full score model | Validate NFL score support, key margins, tails and era behavior; compare simpler distributions | F17; [F01 simulator mechanics](recovered-evidence/research2/F01-drive-sim-mechanics.md) |
| R18 | Calibrate around broken simulator mechanics and declare the physics fixed | First validate possessions, field direction, clocks, turnovers and period/OT behavior | F01, F17 |
| R19 | Treat related bet legs/positions as independent | Model or conservatively constrain dependence; fit copulas only after useful calibrated marginals exist | [F10 copulas](recovered-evidence/research2/F10-copula-correlation.md), [GF06 dependence code](recovered-evidence/research2/GF06-copula-dependence-code.md) |
| R20 | Convert a coach quote into an arbitrary injury probability or point adjustment | Extract supported facts; learn availability and impact from earlier labeled examples | [N13 injury interactions](recovered-evidence/research2/N13-injury-network-propagation.md); QB/availability verification |
| R21 | Call market movement after a story its causal effect | Separate prediction from causal identification; handle overlapping events, price history, receipt delays and controls | [F13 news impact](recovered-evidence/research2/F13-causal-news-impact.md) |
| R22 | Feed a modern LLM a historical game and accept its remembered outcome as blind prediction | Use span-supported extraction and prospective validation; maintain reconstruction labels | Architecture/calibration reviews; current AI audit |
| R23 | Treat publication, extraction, truth, activity probability and win probability as one confidence number | Keep each quantity separately named and measured | F05, N13, F13 |
| R24 | Transfer rankings, thresholds or claimed profits from baseball, NBA or finance directly to NFL | Use them as hypotheses/reference math; test on appropriate NFL information and outcomes | F15; walk-forward and calibration verification |
| R25 | Assume a known advanced method or GitHub repository is correct, licensed for reuse, or production ready | Read relevant code/terms, pin a version, use independent fixtures and an actual full-pipeline comparison | [GF09 nflverse](recovered-evidence/research2/GF09-nflverse-ecosystem-code.md), GitHub catalog and verification reviews |
| R26 | Present better CLV and better returns from the same bets as two independent proofs | Report both, recognize dependence, use exact contracts and a stated close benchmark | F13; calibration/authority verification |
| R27 | Increase stakes or remove safeguards because the model now produces non-market numbers | Require valid outputs, matching calibration, explicit evidence and separately authorized betting policy | Calibration/authority verification |
| R28 | Call an uncomputable robustness test a pass | Return not-estimable/inconclusive with the missing sample requirement | F06/F07; new error-analysis finding below |

### Additional gaps found in the current source

This was a targeted review, not a new claim of complete line-by-line coverage. Findings refer to `21789a9` plus the reported working changes. Recheck before implementation. “Reproduced” below means isolated synthetic behavior, not demonstrated financial loss. The [probe results](PLAN-CODE-CHECKS.json) preserve the output.

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
