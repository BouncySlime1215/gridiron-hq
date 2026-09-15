# Gridiron HQ: what ML and AI actually do

September 14, 2026. Companion to the betting continuation plan. Source: repository `43af933`, direct read-only database checks, and recovered research/verifications. No paid AI calls or training jobs were triggered.

## Verdict

**“There is no ML” is false. “The betting model is not benefiting from a coherent, trained ML pipeline” is supported by the evidence.**

The system has genuine statistical learning, trained tree experiments, hand-written neural networks, Claude calls, simulations, and a large authority framework. These serve different purposes and are not one trained model. The main recorded betting path still returns the market forecast. Successful execution of code and passing unit tests do not establish that the complete system learns, uses its latest inputs, or beats a betting baseline.

The architecture needs consolidation around a shared data → learning → prediction → price → recorded outcome path. This is more than adjusting a few thresholds, but it does not require discarding all the useful work.

## Usage map

| Component | Is it ML/AI? | Does it drive the main betting forecast? | What to do |
|---|---|---|---|
| `nfl-ensemble.js` | Statistical learning: fitted component scales and blend weights, with many hand-built formulas | Yes, but the production residual mode zeroes all model contributions in every stored fit checked | Reuse honest football inputs; replace the component significance filter with regularized learning/combination |
| Python `tree_lab`, `market_lab` | Genuine ML: LightGBM, XGBoost, CatBoost, ridge and other estimators | No deployed Python artifact-loading path was found in the main forecast. `nfl-research-lab.js` reads their reports for display | Reuse the installed environment, extraction lessons and evaluators; build a shared training/scoring interface |
| Council boosted-tree and neural experts | Genuine custom ML implementations | Research/historical candidate paths; the council appears in unified projection detail, but does not set that projection's mean or the main auto-pick mean | Generate legal chronological features/predictions; compare with library learners before adopting |
| `nfl-online-neural.js` | A small neural network with a training routine | The auto-pick path can use an eligible artifact, but the artifact table contains zero rows | Diagnose capture/settlement lifecycle; do not present an untrained head as current learning |
| Expert coordinator/specialists | Ridge, robust fitting, nearest neighbors and rules | Mostly research; several filters zero influence, and one numerical defect invalidates fitted coefficients | Repair math, use out-of-fold training, reduce duplicated shrinkage layers |
| `gridiron-model.js` | Primarily a capability/permission router, not a trained “master model” | Controls/explains which components may inform or size decisions | Keep authority separate from learned prediction and name the distinction accurately |
| `nfl-unified-engine.js` | Composes ensemble forecast, simulation and explanatory heads | Ensemble supplies target means; simulation supplies score shape. Council/news are attached as detail | One output object is not end-to-end learning. Validate mean and distribution contributions separately |
| Claude news extraction | LLM converts stories into typed facts | Facts enter cards and candidate neural/specialist features; direct numerical authority is zero and no predictive contribution is established | Keep source spans, identity, timestamps and contradictions; learn football impact from data |
| Claude pick/page/tweet explanations | LLM translation and summarization | Explains existing outputs; does not create calibrated probabilities | Keep optional and grounded; measure cost/usefulness separately from forecasting |
| Historical Claude replay gate | LLM reviews a preselected bet and returns approve/reduce/abstain/press | Separate retrospective research. Code labels incomplete source timestamps and denies production promotion | Do not mistake prompt memory for model training or filtered backtest returns for live proof |
| AI execution slate | Claude proposes/reviews allocation over already-gated shopping/teaser opportunities | Can affect recommended allocation in a separate endpoint; does not forecast game outcomes or transmit wagers | Require a deterministic allocation baseline and measured incremental benefit before crediting AI |

## What the usage records show

Recorded application API usage spans July 31–September 14. These records do **not** include the separate Claude desktop research conversation or its subscription usage, and token counts are not a billing reconciliation.

- 178 typed-news extraction calls; current signal table has 163 verified Claude-extracted signals and 36 quarantined ones. Rules separately generated 288 verified and 71 quarantined signals. Counts represent current rows, not extraction precision or recall.
- 557 tweet/line explanation calls, 32 page explanation calls, and 11 pick explanation calls.
- 203 historical replay-gate calls recorded on August 24. The current `nfl_ai_replay_runs` table is empty, so the corresponding performance cannot be established from that table today. The discrepancy needs provenance investigation, not an invented result.
- 28 execution-slate proposal calls and 28 review calls, recorded September 7. Calling an LLM twice is not independent verification; the review sees its own initial allocation.
- The newer news-event extractor and press-role inference have only one recorded call each. The event table holds 10 news-item and 20 press-conference events.
- Team-analysis prose accounts for 536 calls, approximately 1.49 million input and 350,335 output tokens. It is not evidence of a trained game predictor. Fantasy/draft calls were also recorded but are outside this review's scope.

There is real AI activity. There is no demonstrated link here from the volume of that activity to an improved betting forecast. No fine-tuning API path was found in the inspected server/research code. The replay's “learning memory” supplies past summary statistics in a prompt; it does not update Claude's model weights.

## The gates: distinguish three failures

**Learning filters:** requiring each component to win a significance test before it may contribute, excluding challengers indefinitely, dropping games because optional features are missing, and preventing early-season borrowing. These can suppress useful interactions and limit learning. Replace them with appropriate priors, missingness handling, chronological regularization and out-of-fold combination.

**Engineering defects:** the specialist weight-array bug, incompatible calibration identities, stale/missing current-season features, corrupt QBR season rows, and an incomplete frozen-input path. These need repairs. Shrinkage or a lower p-value threshold cannot fix them.

**Betting/data controls:** refusing future information, rejecting corrupt artifacts, requiring a real available quote, preventing unvalidated probabilities from sizing stakes, and capping exposure. Retain these. Negative results are a valid reason to withhold money even while research continues.

The existing gates are not the entire cause of poor results. Historical raw/council models also performed poorly while making real predictions. That supports two conclusions simultaneously: the old predictors have not earned deployment, and the development system needs a better way to train and evaluate replacements. Removing the market fallback would produce more model opinions, not evidence of better opinions.

## Additional AI-specific weaknesses

1. **Fact extraction is not impact estimation.** The news expert uses fixed multipliers such as burden difference ×0.75 (and a fallback ×0.5). Claude identifying “QB out” does not mean the system learned the replacement's effect or what the market already priced.
2. **Extraction confidence is not win probability.** Keep text confidence, source reliability, player availability probability and forecast uncertainty as separate quantities.
3. **News timing needs both clocks.** `playerNewsSignal` filters `published_at` but not the time the app first received/extracted the claim. Historical reconstruction must not label a later extraction as a captured-before-decision fact. The typed-event path has `first_seen_time`; carry this through the shared feature contract.
4. **Outcome-blind prompts do not prove historical blindness.** A modern pretrained LLM may know identified historical games. The replay packet includes game identity; hiding the score alone is insufficient. Treat such experiments as retrospective and test contribution prospectively.
5. **Self-review is not an independent forecast.** Allocation simulation evaluates assumptions supplied to it; a persuasive second explanation cannot validate the assumptions or the probabilities.
6. **Labels overstate integration.** “Unified engine,” “expert council,” “learning memory,” and “research complete” refer to different mechanisms. Surface the actual artifact ID, training-through date, current input age and contribution to the served number.

## Recommended division of work

**ML predicts:** train on historical football and price data, produce distributions and compare with the market. Use lower-level play/player learning to improve game features, with proper chronological boundaries.

**Claude structures and explains:** extract timestamped, cited facts; identify contradictions; explain recorded outputs. Any numerical or allocation contribution competes against a simple deterministic baseline in a separate prospective test.

**One decision policy controls bets:** consume the calibrated forecast and exact offered price, apply consistent risk/execution rules, and record the decision or abstention. A prompt's confidence should not bypass this policy.

The first acceptance test should be concrete: for a single game, show the immutable inputs, the fitted model that used them, its prediction, the difference from the market, the exact reason for betting or abstaining, and the later grading. Then demonstrate the same path across historical folds and future shadow games. That tests whether the whole model works rather than whether its pieces run.

Follow the ordered implementation slices in `gridiron-betting-continuation.md`. No broad new AI research sweep or additional model installation is needed to begin.
