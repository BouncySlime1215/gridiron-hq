# GN03 — Transformer-on-sports-sequence code, applied to Gridiron's real play-by-play schema

Agent: GN03-transformer-pbp-code | bucket: new | phase: GitHubNew | 2026-09-12

## 0. Gridiron's actual play-by-play schema (read directly, not assumed)

`server/db/schema/nfl-a-to-m.js:306-333` — table `nfl_play_by_play` (populated by
`server/services/nfl-espn-pbp.js`; this is the live/ESPN-sourced ~251,591-row table, distinct
from the nflverse season-CSV pipeline in `nfl-pbp.js` which folds raw plays into team-week/
player-week JSON blobs and never persists the raw rows):

```
event_id, play_id, season, week, sequence, period, clock_seconds,
offense, defense, down, distance, yards_to_endzone, play_type,
yards_gained, is_turnover, is_scoring, is_penalty,
home_score, away_score, shotgun, no_huddle,
pass_depth, pass_direction, text, fetched_at
PRIMARY KEY (event_id, play_id)
```

Ordered within a game by `sequence`. **There is no `drive_id` column.** Adjacent tables:
`nfl_play_formations` (offense_formation, offense_personnel, defense_personnel,
defenders_in_box, pass_rushers) and `nfl_play_charting` (motion, play_action, screen, rpo,
trick, out_of_pocket, throw_away, contested), both keyed on (game_id, play_id) — a richer,
already-categorical-only (no x/y tracking) feature surface most BDB repos don't have to work
with because they're built on NGS tracking data instead.

Critically, `server/services/nfl-live-ledger.js:37-61` (`possessionStates()`) already contains
the drive-boundary heuristic Gridiron uses live: a new possession starts on any row where
`offense` differs from the previous row's `offense`. `predictPossession()`
(`nfl-live-ledger.js:68`) then calls `simulateRemainder()` in the buggy
`server/services/nfl-drive-sim.js` (the 6 physics bugs from tonight's audit) 300 times with a
deterministic seed to produce a Monte Carlo distribution over the current drive's outcome, and
`liveLedgerCalibration()` (`nfl-live-ledger.js:174`) already has a settled-outcomes table
(`nfl_live_possession_settlements`) to score any drive-outcome predictor's calibration. This is
the exact plumbing a next-drive-outcome model needs — it does not need to be invented.

## 1. Repos cloned and read (not just README-skimmed)

### SumerSports/SportsTrackingTransformer
- License: none (no LICENSE file in the tree; `license` via `gh api` is `null`). All-rights-reserved by default.
- Stars: 49. Last commit: 2025-11-06 (`git log -1`).
- What it actually does (read `src/models.py` in full): `SportsTransformer` treats the 22
  players on a single tracking frame (at the moment of handoff, BDB-2024 tackle-prediction
  task) as an **unordered set** — `nn.TransformerEncoder` over a `[B, 22, feature_len]` tensor
  with `batch_first=True`, no positional encoding at all (permutation-equivariance is the
  point), then `AdaptiveAvgPool1d` over the player dimension, then an MLP decoder to a
  2D tackle-location regression target. It is a **spatial self-attention-over-a-set**
  architecture, not a temporal sequence-over-plays architecture. The repo's own baseline,
  `TheZooArchitecture`, is a literal re-implementation of the 2020 Big Data Bowl 1st-place
  solution (pairwise offense×defense interaction vectors through 1×1 Conv2d "CNN" layers —
  README's claimed result: Transformer beats Zoo by 20.2% ADE (5.78 → 4.61 yd) on their own
  held-out test set, with the gap widening to 75.9% at the tackle frame itself. This is a
  same-repo, same-data, single-institution comparison — not verified independently here.
- Adopt: **borrow-idea, not port.** Gridiron has no player tracking data, so this exact
  architecture cannot be called — there is no [B, 22, feature] tensor to feed it. What *is*
  transplantable is the specific technique: self-attention over an **unordered set** of
  categorical items with **no positional encoding**, used precisely because the item order
  (which of 22 players is "first") is arbitrary and any positional encoding would be a spurious
  prior. Gridiron's `nfl_play_formations` / `nfl_play_charting` per-play flags (motion,
  play_action, screen, rpo, trick, defenders_in_box, pass_rushers, offense_personnel) are
  exactly this kind of unordered flag-set — currently they'd be hand-concatenated into one flat
  feature vector. Candidate C2 below borrows this set-attention idea for that flag-set,
  nested *inside* one token of the temporal drive-sequence model (C1), rather than porting the
  player-set model itself.

### ebrown-32/Deep-Learning-NFL-QB-Stat-Predictor
- License: none (no LICENSE file). All-rights-reserved by default.
- Stars: 0 (a University of Nebraska-Lincoln Math 435 class project). Last commit: 2025-01-17.
- What it actually does (read `nn.py`, `data_preparation.py`, `documentation.md` in full): a
  genuine **temporal** transformer over a **sequence of plays** — `nn.Linear(18, 64)` per-play
  feature embedding, `nn.TransformerEncoder` (3 layers, 4 heads, d_model=64), a **learned**
  (not sinusoidal) positional-encoding parameter `[1, 2000, 64]`, an attention-pooling layer
  (softmax over per-timestep learned weights, not just mean-pool), separate learned QB and
  team identity embeddings concatenated in after pooling, and two output heads (main: 5
  continuous QB stats; auxiliary: 3 rate stats) trained jointly with an MSE-based focal loss.
  Its 18 input features per play (yards gained, pass TD, air yards, YAC, sack, score
  differential, quarter, down, yards-to-go, field position, defenders in box, pass rushers,
  temperature, wind, shotgun, no-huddle) are close to a 1:1 match with the union of Gridiron's
  `nfl_play_by_play` + `nfl_play_formations` columns.
- Verified gap: **no evaluation numbers exist anywhere in the repo** — no test-set MAE/RMSE, no
  comparison to a Vegas prop line or a naive baseline, in the README, `documentation.md`, or the
  three `training/*.png` loss-curve images (checked: loss curves only, no metric tables). This
  is architecture-only evidence, not performance evidence.
- Adopt: **borrow-idea (architecture pattern), not port (code/weights).** The full pattern —
  per-play linear embedding → transformer encoder → learned attention pooling → identity
  embeddings concatenated post-pool → multi-task heads with an auxiliary task — is the direct
  template for Gridiron's next-drive-outcome model (C1), because it's the same problem shape
  (variable-length sequence of categorical/continuous play vectors → a small number of
  game-level or drive-level targets) on a near-identical feature vocabulary. Do not import the
  actual `nn.py`/`best_model.pth` — untrained-on-Gridiron-data, unverified performance, and a
  license-less class project with 0 external validation.

### mpchang/uncovering-missed-tackle-opportunities (BDB 2024, "Uncovering Tackle Opportunities and Missed Opportunities")
- License: none (no LICENSE file). All-rights-reserved by default.
- Stars: 14. Last commit: 2024-03-03.
- What it actually does (read `code/tacklesequence.py` and every cell of
  `code/train_model.ipynb`, not just the README): despite naming a class `TackleSequence` that
  wraps a PyTorch tensor, **the trained model is `XGBClassifier`** (`code/train_model.ipynb`
  cell 1: `import xgboost as xgb`; cell 7: `params_opt = {"objective": "binary:logistic", ...}`)
  — a gradient-boosted-tree tackle-probability-in-the-next-1-second classifier over 9
  hand-built geometric features (ball-carrier speed, relative x/y speed, Euclidean distance,
  angle of attack, Voronoi area, team/blocker "influence" fields, is-run). **There is no
  transformer, LSTM, or GRU anywhere in this repo's actual code** — the PyTorch `Dataset`
  wrapper is just a data-loading convenience around tensors that feed an XGBoost `.numpy()`
  call, not a neural sequence model. The repo does a real, useful thing (SHAP-based
  interpretation of the tackle-probability classifier: `shap.TreeExplainer` + summary/dependence
  plots per feature), just not the thing its class name or its "Sequence" framing implies.
- Adopt: **avoid for the transformer angle** (there is nothing to port). **Borrow-idea for the
  interpretability harness**: XGBoost surrogate + SHAP as a cheap, auditable way to explain a
  larger neural model's predictions post-hoc — see candidate C4.

### juancamilocampos/nfl-big-data-bowl-2020
- License: none (no LICENSE file). All-rights-reserved by default.
- Stars: 12. Last commit: 2022-09-13 (repo last touched; the winning solution it reproduces is
  from 2019/2020).
- What it actually does (read `1st_place_zoo_solution_v2.ipynb` cells 0-14 and the README): a
  faithful reproduction of the actual 2020 BDB 1st-place ("The Zoo") solution — single-frame
  (at handoff) offense×defense pairwise-interaction features run through 1×1-kernel
  `Conv2d`/`Conv1d` blocks (functionally dense layers applied per-interaction, explicitly
  commented as "not doing any convolution between neighboring players" in the SumerSports
  re-implementation) to predict a categorical distribution over yards gained on a single run
  play. No temporal sequence modeling, no transformer, no attention — pure feed-forward over a
  fixed pairwise-interaction tensor. The repo also has a GNN variant
  (`nfl_graph_neural_networks_v1.ipynb`) representing the rusher-vs-defense as a graph.
- Adopt: **reference-only.** This is the historical baseline the SumerSports transformer paper
  measures itself against (`TheZooArchitecture` in `SportsTrackingTransformer/src/models.py`
  is a direct citation of this repo's notebook). Useful only as the "what a pre-transformer
  winning solution looked like" reference point; not itself adoptable for Gridiron (single-play,
  tracking-data-dependent, no drive/sequence structure).

## 2. Concrete model spec: "Drive-Outcome Transformer" (DOT) on Gridiron's own schema

**Task.** Given the plays of the *current, in-progress* possession (as already segmented by
`possessionStates()` in `nfl-live-ledger.js`), predict: (a) the terminal outcome of this drive
— 7-way categorical {touchdown, field_goal, punt, turnover, turnover_on_downs, safety,
end_of_half}; (b) expected points added by the drive's end (continuous regression, an
EPA-flavored target computed from `home_score`/`away_score` deltas rather than hand-tuned); (c)
auxiliary next-play type (run/pass/punt/FG-attempt/kneel/spike — a free multi-task signal, per
the ebrown-32 pattern, that also has direct value for the props module).

**Per-play token (~20-24 dims, built entirely from existing columns).**
Categorical, embedded then summed/concatenated: `down` (0-4, 0="no down" for kickoffs),
`play_type`, `pass_depth`, `pass_direction`. Continuous, each z-scored per-season: `distance`,
`yards_to_endzone`, `yards_gained`, `clock_seconds` (converted to seconds-left-in-half, not raw
quarter clock — a fix the drive-sim itself gets wrong per tonight's finding, so this pipeline
must compute it independently and correctly), `score_differential` = (offense==home ?
home_score-away_score : away_score-home_score). Binary flags: `is_turnover`, `is_scoring`,
`is_penalty`, `shotgun`, `no_huddle`. Optional (join to `nfl_play_formations`/
`nfl_play_charting` when present, else a learned "missing" embedding): `offense_formation`,
`offense_personnel`, `defenders_in_box`, `pass_rushers`, `motion`, `play_action`, `rpo`,
`screen`.

**Sequence + positions.** Plays ordered by `sequence`, restricted to one `possession_index`
block (from `possessionStates()`); a **learned** positional embedding indexed by play-number-
within-drive (max length ~20, per the ebrown-32 pattern — sinusoidal is unnecessary at this
short a length and a learned embedding can absorb "1st play of drive is different from 15th"
directly).

**Architecture.** `nn.TransformerEncoder`, 2-3 layers, 4 heads, d_model=64-96, dropout 0.2-0.3
— sized for the ~15-20k-drive dataset this table actually yields (251,591 raw plays /
~12-14 plays per drive), not the far larger tracking-frame datasets the cloned repos train on.
Attention-pooling head (softmax-weighted sum over play positions, per ebrown-32) rather than
mean/max pooling, so the model can learn "the 3rd-and-long incompletion mattered more than the
two kneel-downs before it." Three heads off the pooled vector: softmax(7) for drive outcome,
linear(1) for points, softmax(6) for next-play-type (auxiliary, weighted down in the loss).

**Training/eval discipline.** Season-holdout (train on seasons N-3..N-1, test on season N —
walk-forward, never a random shuffle-split, given the known non-stationarity in this exact
codebase's team-strength blending). Report accuracy/log-loss against the **market-implied**
drive-outcome baseline where available and against the current `simulateRemainder()` Monte
Carlo distribution specifically, using the existing `nfl_live_possession_settlements` table as
the shared scoring set — this makes the comparison apples-to-apples with a signal Nick's system
already scores.

**Attachment point (exact files).** New file `server/services/nfl-drive-transformer.js`
(training happens offline in Python/PyTorch, exported to ONNX, loaded with `onnxruntime-node`
for inference — no live training in the Node service). Its `predictDriveOutcome(eventId,
sequence)` is called from `nfl-live-ledger.js:predictPossession()` (currently line ~68-99)
**alongside**, not in place of, the existing `simulateRemainder()` call, writing to a new
column/JSON key in `nfl_live_possession_predictions.prediction_json` so `liveLedgerCalibration()`
(`nfl-live-ledger.js:174`) can score both against the same settled outcomes before either one is
trusted to drive a real decision. This mirrors Nick's own governance-gate principle for the
betting engine.

## 3. Papers checked (abstract-level only — flagged honestly, not overclaimed)

- EventGPT (arXiv 2512.17266, Hong/Lee/Jo/So/Bauer/Ko, Hudl Performance Insights 2025/2026):
  GPT-style autoregressive decoder-only transformer over discrete match-event tokens
  (action type, spatial coords, timing, player ID) for football/soccer, trained on 5 seasons
  of Premier League event data (sample size not disclosed in the abstract), claims to beat
  "existing sequence-based baselines" on next-event accuracy/spatial precision but **states no
  numbers in the abstract itself** — I did not fetch/read the full PDF body, only the abstract
  via WebFetch, so this is cited as directional evidence for "decoder-only autoregressive
  transformers over discrete sports-event tokens work," not as a validated benchmark.
- "Large-Scale In-Game Outcome Forecasting... Axial Transformer" (arXiv 2511.18730, Horton &
  Lucey, Nov 2025): axial-transformer over live soccer match events + player/team context,
  jointly forecasting 13 action totals at multiple time-steps; abstract claims ~75,000
  low-latency live predictions per game but again **no disclosed benchmark numbers** in the
  abstract. Abstract-only read; not read_in_full.

Both papers corroborate the architectural direction (transformer over discrete in-game event
sequences, not over raw tracking coordinates) without providing verifiable out-of-sample numbers
I can cite as evidence strength "strong." Evidence strength for the overall approach is
therefore graded **moderate** (architectural precedent from multiple independent groups,
including one, SumerSports, with an actually-measured same-repo benchmark) rather than
"strong" (no independently-reproduced NFL-drive-specific result exists in anything I could
read in full tonight).

## 4. What NOT to do

- Do not port ebrown-32's actual weights/code — untrained on Gridiron data, zero disclosed
  evaluation metrics, license-less class project.
- Do not treat mpchang's repo as a transformer reference for anything — verified by reading the
  notebook that the real model is XGBoost, not a sequence model at all.
- Do not attempt to reuse SumerSports' `SportsTransformer` class directly — it requires a
  `[B, 22, feature]` player-tracking tensor Gridiron does not have and cannot cheaply obtain.
- Do not let the drive-outcome transformer touch `nfl-drive-sim.js` or write to any table the
  live game-capture process is using this week — score it in parallel via the existing
  `nfl_live_possession_settlements`/`liveLedgerCalibration()` path first.
