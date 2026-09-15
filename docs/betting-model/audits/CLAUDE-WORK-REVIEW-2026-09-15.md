# Claude’s latest Gridiron work: review and remaining work

Reviewed September 15, 2026. Repository: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`. Committed comparison: `21789a9..81a5ed6` (35 changed tracked files), plus the uncommitted drafts present during this review. This is a focused review of betting, training, historical evidence, and integration—not a fresh line-by-line audit of the entire application.

## Verdict in plain English

Claude did useful work. It repaired several real defects, expanded the football training dataset, ran actual ridge and LightGBM experiments, and correctly reported that the market beat those models. Keep that work.

However, “all gates are correct, no code problems” is too broad. I reproduced historical-news leakage, a frozen-packet reproducibility failure, and two problems in the unfinished drafts. The system is still between a research lab and a reproducible betting model. It is not yet the weekly trained, frozen-input, end-to-end system in our master plan.

The next step is targeted engineering and honest measurement. A larger literature sweep or an immediate jump to deep learning is not the priority.

## Findings requiring fixes

### R1 — P1: the new news cutoff comparison admits later information on the same day

**Committed code:** [nfl-news-signal.js:259](../../../server/services/nfl-news-signal.js), with the same pattern in the team queries. The table’s [created_at default](../../../server/db/schema/nfl-n-to-z.js) uses SQLite `datetime('now')`.

The new query compares `created_at <= cutoff` as text. Stored extraction timestamps use `2026-09-10 20:00:00`; callers supply ISO timestamps such as `2026-09-10T12:00:00.000Z`. A space sorts before `T`, so the evening extraction is incorrectly admitted at noon.

**Reproduced:** the actual `playerNewsSignal` function returned the claim extracted at 20:00 for a 12:00 cutoff. This is not just a hypothetical format: all **642** signal rows in the read-only database snapshot used the space-separated format. This does not establish that 642 decisions were affected; it establishes that the production data uses the vulnerable representation.

**Fix:** compare normalized instants, either through a consistently enforced timestamp representation or a validated numeric/SQL date conversion. Invalid timestamps must be rejected. Apply the fix to every related cutoff reader, not just the player query.

**Required proof:** real SQLite-default formatting, equivalent timezone offsets, before/equal/after boundaries, malformed values, and both player/team readers. The existing tests seed ISO strings and therefore miss this case.

### R2 — P1: revised injury news overwrites history while keeping its original extraction clock

**Committed code:** [structured signal upsert](../../../server/services/nfl-news-signal.js), [news item revision handling](../../../server/news/store.js). The LLM extraction upsert also updates an existing signal’s content without versioning its original creation timestamp.

Claude correctly advanced an article’s `ingested_at` when its content changes. But `syncStructuredNewsSignals` then overwrites the corresponding signal’s status/evidence while preserving its original `created_at`. Historical readers query that signal directly. An updated article can therefore smuggle a later claim into an earlier cutoff despite the article-level repair.

**Reproduced through the real ingestion/extraction functions:**

1. September 9: a player is questionable, and that claim is extracted.
2. Query the September 10 noon snapshot: **questionable**.
3. September 11: the same article is revised to say the player is out; run extraction again.
4. Query the identical September 10 snapshot: now **out**.

Separately, overwriting the article also destroys the older text needed for a faithful historical replay. Merely bumping the signal’s timestamp would prevent this specific leak but make the earlier claim disappear. That is a partial containment, not complete historical support.

**Fix:** immutable article revisions and immutable extracted claims, linked by article-version/content hash. Preserve publication, receipt, extraction, and revision clocks separately. Select the version actually available at the cutoff. Use historical player/team identity. Keep reconstructed historical evidence distinct from evidence actually captured prospectively.

**Required proof:** adding a later revision leaves an earlier snapshot identical; the later snapshot changes; duplicate ingestion is idempotent; corrections and retractions are represented; stale claims do not survive a changed article silently. This is a prerequisite for the weekly news/injury backfill in our plan.

### R3 — P1: the new frozen-decision retry still recomputes from mutable inputs

**Committed code:** [t60-runner.js:327](../../../server/betting/nfl/strategy/t60-runner.js). The called function explicitly documents its remaining live inputs in [nfl-auto-picks.js:270](../../../server/services/nfl-auto-picks.js).

Recovering a failed decision-tape link is necessary. But the retry calls `autoPickDecisionBoardForPacket` again, and that function only freezes part of the input. Game context, team features, total-market data, and model/calibration state can still come from changing tables or artifacts. The retry has a minimum waiting period but no maximum age, and records `dataIdentityStatus: 'frozen_packet'`.

**Reproduced:** with one unchanged packet, changing the live total and clearing disposable fixture caches changed the returned `predictive_distribution` and `model_trace`. The stored spread quote remained frozen. This proves the complete forecast is not a pure function of the retained packet. The probe does not claim that this mutation changed a placed bet or the selected spread side.

**Fix:** persist the computed forecast/decision and complete input/artifact identity before linking. Recovery should link the already computed result. Recomputing is valid only when every consumed input and model version can be restored. Until then, label a late recomputation explicitly and exclude it from claims of a prospectively available forecast.

**Required proof:** freeze → simulated link failure → mutate live features, game context, prices, calibrators, and model artifacts → restart → recover the identical original result, or explicitly refuse prospective recovery. The existing retry tests prove recovery succeeds, not that every recovered input remains unchanged.

**Current database limitation:** 13 of 15 observations remain `frozen`; those 13 lack retained `packet_json`. Claude correctly identified them as unrecoverable through honest packet replay. Do not rebuild them from today’s tables and count them as successful historical captures.

### R4 — P2: draft model artifact identities do not identify the training data’s contents

**Uncommitted draft:** [model_artifact.py:126](../../../research/betting/nfl/model_artifact.py), [save collision handling](../../../research/betting/nfl/model_artifact.py).

The artifact ID hashes row identifiers, a fixed dataset-version label, settings, and selected code. It does not hash the actual training features/labels/source revisions. The default code hash also omits `dataset.py`, which helps determine eligible data and feature inputs.

**Reproduced:** fitting with fixed hyperparameters on the same row IDs but changed outcome values produced a different fitted model with the same artifact identity. Saving the second fit raised `FileExistsError`. This is an ordinary data-revision case, not the cryptographic collision or corruption described by the error.

**Fix before landing:** hash a canonical training-data snapshot, target definition, source/feature revisions, relevant dependency code, and fitting configuration. Include the snapshot identity in the artifact identity. Preserve old versions. Repeating identical inputs must reuse the same artifact; genuinely revised inputs must produce a distinct one.

**Required proof:** independently mutate an eligible feature, label, and source revision without changing row IDs; each must change identity. Altering excluded future rows must not. Test the same behavior after restarting the process.

### R5 — P2: draft adapters validate probabilities and then round them into invalid probabilities

**Uncommitted draft:** [spread-family-adapters.js:156](../../../server/betting/nfl/forecast/spread-family-adapters.js).

The adapter validates the triple, then rounds each number to three decimals while returning `available: true`.

**Reproduced:** valid win/push/loss probabilities `0.4834 / 0.0334 / 0.4832` at handicap −3 become `0.483 / 0.033 / 0.483`, summing to **0.999**. The project’s own shared validator rejects the returned object.

**Fix:** preserve computational precision through the model contract; round only when displaying numbers. Validate the actual returned contract, including handicap precision. Do not fix this by broadly loosening probability checks.

**Required proof:** integer-handicap triples with nonzero push probability survive adapter → shared validator → economics unchanged.

## Conclusions Claude needs to narrow

### A gate rejecting everything is not sufficient evidence that its design is right

Claude’s gate investigation usefully checked several real rejection reasons. Do not remove safeguards merely to manufacture picks. But the claim that this resolves all gate concerns is unjustified.

For example, [staking.js:330](../../../server/services/staking.js) rejects an 80% margin prediction interval wider than 24 points. Claude reports ordinary observed widths around 32–34. That establishes why the rule rejects forecasts. It does not establish that 24 is an empirically justified eligibility threshold, or that such a narrow outcome interval is necessary for a calibrated betting edge. Outcome variability and uncertainty about estimated betting value are different quantities.

Audit each gate’s **purpose, inputs, information regime, empirical justification, and attainable passing example**. Keep the stake restriction while evaluating alternatives in research. Require a synthetic valid candidate to travel all the way through the relevant boundaries; separately prove bad candidates are rejected for the intended reason. Do not represent this review as an exhaustive re-audit of all five gates.

### The new “independent simulation” draft is still anchored to the ensemble

[spread-family-adapters.js:289](../../../server/betting/nfl/forecast/spread-family-adapters.js) labels a family “Independent game simulation,” then supplies ensemble `targetMargin` and `targetTotal` to the simulator. Its detailed metadata does disclose reconciliation, which is good, but it is not an independent source of mean predictions.

Keep an explicitly ensemble-conditioned simulator if useful. If testing an independent simulation family, expose its unreconciled forecast and measure its incremental value on matched games. Otherwise the proposed next experiment risks repackaging an existing prediction as fresh evidence.

### The baseline results are useful, but not the completed evaluation system

The stored Stage 3 report contains **7,276 dataset games**, **6,499 scored games**, and **24 annual outer folds**. Average absolute margin error in points, lower being better:

| Forecast | Error |
|---|---:|
| Zero-information baseline | 11.309 |
| Market | **10.249** |
| Ridge | 10.675 |
| LightGBM | 10.738 |

The report correctly calls this research, identifies previously inspected history as development data, and makes no profit claim. Its limited 14-feature comparison is a legitimate baseline. It does not establish that richer point-in-time player/injury inputs cannot help, or that a different family is automatically the best next investment.

The new annual-fold study is not the planned weekly-refit evaluation. Its writer saves aggregate/fold metrics but does not persist its available per-game predictions, a content-addressed input snapshot, or exact-price betting outcomes. The market comparison uses the stored historical spread; it is not a verified historical T-60 executable quote comparison. Preserve these distinctions.

The separate direct-cover lab still uses limited 2022+ price-qualified history. Its reported negative results and underpowered folds are useful warnings, not proof of no possible edge. Related experiments on overlapping games are not independent confirmations in the statistical sense.

## What to retain

- Stricter packet validation and finite-number handling; coherent same-book, same-handicap quote pairing.
- Repairs to cutoff plumbing, QBR handling, missing specialist values, and the unsupported “robust” error-analysis flag.
- The shared football dataset that retains older football games without requiring archived betting prices.
- Explicit negative model results and separation of research authority from production eligibility.
- The artifact and adapter work as unfinished foundations, after the draft defects above are fixed.

These are meaningful improvements. “There is no ML” is no longer a useful blanket description: actual ML training exists. The important unresolved question is which trained forecast reaches the live betting decision, with what frozen inputs and proven incremental value.

## Remaining work, in execution order

1. **Repair historical correctness:** R1–R3 first. Finish immutable news/feature/model identities rather than adding more timestamp filters around mutable rows. Preserve old unrecoverable observations as failures.
2. **Finish and review the drafts:** artifact identity, adapter precision, and the team-card injury-cutoff change. The latter’s focused tests pass, but that alone does not establish historical player/team identity across roster changes. These files were still uncommitted when reviewed.
3. **Create the common frozen forecast boundary:** one exact feature vector, artifact ID, training cutoff, quote identity, and probability/distribution output consumed by both replay and live inference. Cutoff metadata alone is not a historical computation.
4. **Run the specified weekly training/replay:** separate football-history eligibility from odds eligibility, fit every learned transform using earlier available evidence, and preserve every scheduled game’s prediction or explicit failure/abstention. Include model, market, coverage, and regime identities.
5. **Persist all-game evaluation and error analysis:** paired prediction/calibration metrics, proper push handling, exact executable prices when available, uncertainty, dropped-row reasons, and preregistered model trials. Use measured errors and source coverage to decide which new data/family is worth testing.
6. **Build the bounded historical news/injury pilot:** start with the planned 2024 weeks 1–4 engineering sample. Reconstruct dated official reports and article versions, historical rosters, availability changes, and explicit missingness. Do not let an LLM invent missing quotes, original receipt times, or injury timelines. Evaluate extraction quality before allowing learned numerical influence.
7. **Revisit gates as part of integration:** map the exact forecast identity and information regime to its calibration and promotion evidence. Test reachability without changing production stake authority. Investigate the width rule empirically.
8. **Only then add targeted model complexity:** lineup/replacement features, an actually distinct simulator, or another measured weakness from the research plan. Register the experiment before seeing its result, use earlier-only tuning, account for repeated trials, and confirm any promising result on genuinely new games. No method makes overfitting impossible.

## Verification and limits

- **102 existing focused JavaScript tests passed**, covering packets, T-60 capture/retry, packet-sourced boards, news cutoffs, and the two JavaScript drafts.
- **54 Python tests passed** under `research/betting/nfl`, including dataset, Stage 3, and artifact tests.
- An additional copied packet-board fixture passed its four existing tests and a fifth review probe confirming the mutable-input problem.
- Isolated review probes reproduced both news issues, probability rounding, and artifact identity collision. Their assertions intentionally confirm the defects; passing them does not mean those defects are fixed.
- Application modules used in probes ran against disposable migrated databases with the project’s external-fetch test guard. The real application database was inspected only through a read-only SQLite snapshot. No production code, live records, or stake settings were changed.
- This review did not rerun Claude’s entire claimed 2,000+ test suite or the full historical training experiments. The numerical comparison above is from its saved report; the targeted tests and defect probes were run independently here.
- Fresh database observations: 32 team-feature rows for 2026, 20 feature revisions, 146 decision events, and 15 T-60 observations (2 decided, 13 frozen without retained packets). Counts are not evidence of complete coverage or profitable bets. Some older documentation’s zero/current-row counts are now stale.

Evidence and logs: [review evidence](claude-review-evidence/evidence.json), [JavaScript tests](claude-review-evidence/node-tests.log), [Python tests](claude-review-evidence/python-tests.log), [news/probability probes](claude-review-evidence/probes.log), [frozen-board probe](claude-review-evidence/frozen-board-probe.log), [artifact probe](claude-review-evidence/artifact-probe.log).
