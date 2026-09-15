# N12 — Mixture-of-Experts / Learned Gating vs. Gridiron's Hand-Weighted Council

Researcher: N12, bucket "new". Topic: modern MoE / learned-gating architectures vs. Gridiron's
current fixed-weight council(s), and whether real routing would collapse the 20-component
problem more honestly than today's naive shrinkage.

## 0. What Gridiron actually does today (read from the live repo, read-only)

Gridiron does not have one council, it has three nested fixed-weight blends, at three different
layers, none of which is a learned gate conditioned on per-game context:

1. **`server/services/nfl-ensemble.js`** — ~20 raw component models (`MODELS`), combined by
   `blend()` (line ~1273 in the version this repo currently has the function at, confirmed by
   grep: `rawWeight` at 1160, `margin_weight`/`total_weight` assignment at 1174-1175,
   `residual_weight = Math.exp(-0.7 * residual_rmse)` at 1189). Weight = a static
   inverse-RMSE (or `exp(-0.7*rmse)`) score fit once per week over walk-forward history, then
   frozen for that week's line. This produces the measured `forecast ≈ 0.68 + 0.632·market`
   naive-shrinkage behavior and the 20-components-collapse-to-~3-independent-signals problem
   cited in tonight's findings.

2. **`server/services/nfl-expert-coordinator.js`** — 19 named "experts" (`NFL_EXPERTS` in
   `nfl-expert-council.js`) combined by a **week-balanced Huber ridge regression** (`fitRows`,
   line 174) whose columns are **families** merged by **pairwise correlation single-linkage**
   (`familiesOf`, line 135, `FAMILY_CORRELATION = 0.6`) — this is the actual mechanism that
   collapses correlated experts into one column, a second, independent instance of the same
   "20→3" collapse pattern one layer up from `nfl-ensemble.js`. On top of that ridge fit sits a
   **hand-designed discrete "regime" gate**: `regimeLabels()` (line 233) buckets every game into
   5 binary threshold splits — `phase: early/middle/late` (week≤4 / ≥15), `spread:
   large/competitive` (|margin|≥6.5), `total: high/ordinary` (≥47), `disagreement: high/normal`
   (≥4), `coverage: sparse/broad` (<0.6). Each regime with enough games gets its **own
   independently-refit** Huber-ridge model (`fitExpertCoordinator`, line 253), and at prediction
   time (`coordinateExperts`, line 422) the global forecast and every *active* regime's forecast
   are averaged with weight `regime.shrinkage / active.length` — a fixed formula, not anything
   learned jointly with the experts. This is the closest thing Gridiron has to a "gate," and it
   is exactly the pattern MoE research replaced 30 years ago (Jordan & Jacobs, 1994) and again 9
   years ago (Shazeer et al., 2017): hard, hand-picked partitions instead of a partition learned
   end-to-end with the experts it gates.

3. **`server/services/weekly-ensemble.js`** — the *fantasy* player-week blend. 5 heads
   (`WEEKLY_ENSEMBLE_HEADS`: structural/season_to_date/last3/last1/median) combined by **fixed,
   hand-tuned, per-position convex weight vectors** (`WEEKLY_ENSEMBLE_WEIGHTS`, lines 12-16 —
   e.g. `QB: [0.40, 0.45, 0.00, 0.10, 0.05]`), identical in spirit to `nfl-ensemble.js`'s
   problem but conditioned on nothing but position. `weeklyEnsembleContext()` (line 28) returns
   **`null`** whenever `priorWeeks` is empty (line 29: `if (!priorWeeks?.length) return null;`)
   — this is the literal code behind tonight's "player_week_engine.heads is null week 1"
   finding: not a bug exactly, but a silent no-op cold-start fallback with no learned or
   analog-based substitute. `player-head-registry.js`'s `candidatePlayerHeads()` has the same
   fallback one function over (line ~56: `if (!prior.length) return
   Object.fromEntries(PLAYER_HEADS.map(h => [h.id, structural]));`) — 24 candidate heads, all of
   which silently equal the single structural number at cold start.

So "Gridiron's hand-weighted 16-role council" is really three of these, stacked. None of the
three conditions its weights on a *learned*, *continuous* function of the game; two of the three
use hand-picked discrete bins or fixed constants as their only form of "context."

## 1. Primary sources read in full

### 1.1 Shazeer, Mirhoseini, Maziarz, Davis, Le, Hinton, Dean (2017), "Outrageously Large Neural
Networks: The Sparsely-Gated Mixture-of-Experts Layer," arXiv:1701.06538 (ICLR 2017)
Read in full via ar5iv HTML rendering.

- **Model**: noisy top-k gating, `G(x) = Softmax(KeepTopK(H(x), k))`,
  `H(x)_i = (x·W_g)_i + StandardNormal()·Softplus((x·W_noise)_i)`. `KeepTopK` sets all but the
  top-k logits to `-∞` before the softmax, so only k experts get nonzero gate weight per
  example; the noise term is there specifically to help load-balance the router during training.
- **The failure mode this paper exists to fix**: "the gating network tends to converge to a
  state where it always produces large weights for the same few experts" — i.e., router/expert
  collapse. They add two auxiliary losses to fight it: an *importance* loss
  `L_importance(X) = w_importance · CV(Importance(X))²` where `Importance(X) = Σ_x G(x)` (the
  batch-summed gate value per expert), and a *load* loss `L_load(X) = w_load · CV(Load(X))²`
  using a smooth estimator of the probability each expert is in the top-k for each example. Both
  are squared coefficients of variation — minimized at uniform expert usage.
- **Sample / scale**: 1B-Word Benchmark (829M words), Google's 100B-word News dataset (fit
  models with 4 to 131,072 experts, up to 137B MoE parameters, hierarchical branching 32-256),
  WMT'14 En→Fr (36M sentence pairs) and En→De (5M pairs), all with 2-3 stacked LSTM layers with
  the MoE layer between them.
- **Honest result**: real wins — 1B-Word perplexity 45.0→28.0 (MoE-143M active params vs
  LSTM-2048 baseline, same compute budget); WMT En→Fr BLEU 39.22→40.56; En→De 24.91→26.03; but
  also a real, stated failure — at the largest configuration (131,072 experts, 137B params)
  *performance degraded* despite more capacity, "possibly a result of too much sparsity," and a
  multilingual run overfit badly on a low-resource language pair from oversampling. This is not
  a monotonic "more experts, more gating, always wins" result.

### 1.2 Fedus, Zoph, Shazeer (2021/2022), "Switch Transformers: Scaling to Trillion Parameter
Models with Simple and Efficient Sparsity," arXiv:2101.03961 / JMLR 23(120)
Read in full via ar5iv HTML rendering.

- **Model**: simplifies Shazeer's top-k to **top-1** routing:
  `p_i(x) = softmax(W_r·x)_i`, output `y = p_i(x)·E_i(x)` for the single argmax expert. Load
  balancing auxiliary loss: `loss = α·N·Σ_i f_i·P_i` where `f_i` = fraction of tokens actually
  routed to expert i, `P_i` = fraction of router probability mass on expert i, `α = 1e-2` —
  minimized exactly at uniform `f_i = P_i = 1/N`.
- **Capacity factor / token dropping**: `expert_capacity = (tokens_per_batch / N_experts) ×
  capacity_factor`; tokens beyond an expert's capacity are **dropped** (passed through via
  residual, unprocessed) — with capacity factor 1.0-2.0 and the load-balancing loss tuned, they
  report <1% dropped.
- **Scale**: Colossal Clean Crawled Corpus (C4), 180B+ target tokens, T5-Base (223M) / T5-Large
  (739M) baselines, up to 256 experts, 550k steps at 2^20 tokens/batch (576B tokens total).
- **Honest result**: 7x pretraining speedup vs T5-Base at equal compute; Switch-Base (64 experts)
  reaches T5-Base quality in 1/7th the time; 91% of 101 languages get ≥4x speedup vs mT5-Base;
  but they also report **real training instability** requiring three separate fixes (selective
  float32 casting of the router only, 1/10-scaled initialization, and a much larger 0.4 dropout
  specifically inside expert layers during fine-tuning to prevent overfitting on small
  downstream tasks) — i.e., a naively-trained gate is unstable and overfits without deliberate
  engineering around it.

### 1.3 Puigcerver, Riquelme, Mustafa, Houlsby (2023), "From Sparse to Soft Mixtures of
Experts," arXiv:2308.00951
Read in full via ar5iv HTML rendering.

- **Model**: replaces *hard* token-to-expert routing with two softmaxes over a shared logits
  matrix — dispatch weights (softmax over tokens, per slot) form each expert's input as a convex
  combination of *all* input tokens; combine weights (softmax over slots, per token) form each
  output token as a convex combination of *all* slot outputs. No discrete assignment anywhere,
  so no load-balancing loss and no token dropping are needed by construction.
- **Scale**: JFT-4B pretraining, ImageNet-1k few-shot/finetune eval, ViT S/8 through H/14
  baselines, Soft MoE tested at 32-512 experts (128 standard), up to 4M training steps.
- **Honest result**: Soft MoE B/16 (128 experts, 3.7B params) matches ViT H/14 (669M params) on
  10-shot ImageNet (82.9% vs 82.7%) at **5.7x faster inference**; Soft MoE dominates the
  Pareto frontier vs both dense ViT and the two standard sparse-routing baselines (Tokens
  Choice, Experts Choice) at matched training FLOPs.
- **Explicit, load-bearing limitation**: the authors state plainly that Soft MoE is **not
  applicable to causal/autoregressive decoding**, because mixing every token into every slot
  requires seeing the whole sequence — it would leak future tokens into a causal prediction.
  This directly bears on Gridiron: anything "live"/in-game (the `live_updater` expert in
  `NFL_EXPERTS`) cannot use this style of gate.

### 1.4 Jordan & Jacobs (1993/1994), "Hierarchical Mixtures of Experts and the EM Algorithm,"
Neural Computation 6:181-214 (1993 IJCNN conference version read in full as PDF, converted
locally with `pdftotext`; content is materially identical to the journal version for the
architecture, EM derivation and simulation reported here)

- **Model**: a tree of gating networks (softmax-linear at every internal node,
  `g_i = softmax(v_i^T x)`) sitting over generalized-linear "expert" networks at the leaves. The
  gate is not fit separately and then bolted on — it is fit **jointly** with the experts by EM:
  E-step computes posterior "responsibility" of each expert for each training point given both x
  and y (not just x, unlike a hand-designed bin); M-step re-fits every gate and every expert as a
  weighted iteratively-reweighted-least-squares (IRLS) problem using those responsibilities as
  weights.
- **Sample**: simulated 4-joint robot-arm forward-dynamics regression, 12 inputs → 4 outputs,
  15,000 training points / 5,000 test points.
- **Honest result**: a 4-level, 16-expert HME converged to backprop's asymptotic relative error
  (~0.09) in **35 epochs** vs backprop's **5,500 epochs** (batch); CART and MARS ran in similar
  wall-clock time to HME but landed at *worse* relative error (0.17 and 0.16 vs HME's ~0.09-0.12)
  — a real win. But the paper also reports a real trade-off, not spun away: the **online** HME
  algorithm converges in just 2 epochs but only to relative error **0.12**, while online
  backprop needs 63 epochs to reach the better **0.08** — faster convergence, worse asymptotic
  fit. This is the load-bearing lesson for Gridiron's discrete regime gate: a *learned*, jointly
  fit soft partition beats a fixed one by two orders of magnitude in sample efficiency, but it is
  not automatically the most accurate converged model.

### 1.5 Qian, Rolling, Cheng, Yang (2015; published as "On the Forecast Combination Puzzle,"
Econometrics 7(3):39, 2019), arXiv:1505.00475
Read in full via ar5iv HTML rendering.

- **Question**: why does a plain equal-weight average of forecasts so often beat an
  estimated-"optimal" weighted combination out of sample — the "forecast combination puzzle"
  (FCP)? Directly the question Gridiron's coordinator already tries to answer with ridge +
  per-role walk-forward shrinkage (`SHRINK_RIDGE`, `MIN_GAMES=128`, etc.).
  - Distinguishes **"combining for adaptation"** (CFA: one candidate is already close to truth,
    nothing to gain by combining) from **"combining for improvement"** (CFI: candidates carry
    genuinely complementary information) — minimax risk under CFI scales as
    `O(K·log(1+T/K)/T)` for K forecasters and T observations, vs only `O(log K / T)` under CFA;
    conflating the two regimes is a "hidden source" of the puzzle.
  - Proposes **mAFTER** (multi-level Aggregated Forecast Through Exponential Re-weighting):
    treat the simple average *itself* as one candidate forecast inside an adaptive combination,
    so the method degrades gracefully to simple averaging when estimation error would otherwise
    dominate, and only exploits a weighted combination when the data genuinely supports it.
  - **Honest, real-data result** (U.S. Survey of Professional Forecasters, 1968-1990, GDP price
    deflator / real GDP growth / unemployment, normalized risk vs simple-average=1.00): plain
    linear regression combination is **much worse** than simple averaging (1.88, 1.64, 1.79
    normalized risk across the three targets) — a concrete demonstration that estimated-optimal
    weighting can actively hurt with realistic sample sizes; mAFTER matches or slightly beats
    simple averaging in every case (0.90, 1.01, 0.98) without ever being meaningfully worse.
  - Bottom line for Gridiron: an estimated weighted combination is not automatically better than
    what you already have; the number of experts K relative to usable independent observations T
    is the variable that decides whether a fancier gate helps or hurts, and the safe way to add
    ambition is to make the simple/shrunk baseline a permanent fallback candidate inside the new
    method, not something the new method merely tries to beat once at ship time.

## 2. Synthesis: does modern MoE actually fit Gridiron's problem?

Two things are true at once, and both matter for the candidates below:

- **The conceptual gap is real.** Gridiron's coordinator already has almost every *piece* of a
  real MoE — walk-forward per-role shrinkage (a crude per-expert "trust score"), correlation-based
  family merging (a crude, hard version of load-balancing), and discrete regime buckets (a crude,
  hand-designed gate). What it's missing is exactly what Jordan & Jacobs (1994) and Shazeer et al.
  (2017) each independently supply: the gate and the experts fit **jointly**, against the **same**
  loss, with the gate's shape **learned** rather than hand-picked, and (per Shazeer/Switch) an
  explicit anti-collapse penalty instead of an after-the-fact correlation threshold.
- **The scale is not real.** Every modern MoE paper above was built and validated on
  hundreds of millions to billions of training examples specifically because a learned gate
  needs enough data to learn a partition without overfitting it. Gridiron's coordinator trains
  on `MIN_GAMES = 128` games across `MIN_WEEKS = 8` weeks minimum, gaining maybe ~270 games and
  ~18 weeks of truly independent evidence per season. That is squarely inside the regime the
  forecast-combination-puzzle literature (Qian et al. 2015, and the classical Bates & Granger /
  Timmermann results it's built on) documents as *hostile* to estimated weighting: K≈19 experts,
  T in the low hundreds of games but only dozens of truly independent weeks. A full
  Shazeer/Switch-style trainable gate transplanted wholesale would be the wrong tool — it would
  learn noise. The right move is the Jordan & Jacobs *shape* (small, jointly-trained, EM/IRLS-style
  gate — the same machinery already in `fitRows`'s Huber-ridge loop) at Gridiron's *scale*, with
  the existing global fit kept as the mAFTER-style fallback, never fully replaced.

## 3. Candidates

See structured output for the 6 candidates (3 "fix", 3 "new") with file/line grounding, cost,
expected value, and exit tests. Summary table:

| id | bucket | surface | what it does |
|----|--------|---------|---------------|
| F1 | fix | `nfl-ensemble.js` (fitEnsemble/blend, ~L1160-1196) | add Shazeer-style CV² importance/load penalty to the weight objective so weight doesn't collapse onto 2-3 correlated components |
| F2 | fix | `nfl-expert-coordinator.js` (regimeLabels L233, familiesOf L135, coordinateExperts L422) | replace hand-binned discrete regime gate + correlation-threshold family merge with a small, jointly-fit (IRLS/EM, Jordan & Jacobs-style) continuous gate |
| F3 | fix | `weekly-ensemble.js` (L12-29), `player-head-registry.js` (~L56) | replace fixed per-position weight vectors and the null cold-start fallback with a k-analog soft mixture (cold start) + continuous gate (once evidence exists) |
| N1 | new | `td-regression.js`, `nfl-prop-calibration.js` | Soft-MoE-style soft mixture over multiple candidate *distributional* heads (NegBin/Poisson/empirical) for props, replacing single point estimates |
| N2 | new | `nfl-blind-audit.js` | add an effective-independent-signal-count (CV²-based) diagnostic to the audit surface — a number nothing currently reports |
| N3 | new | new file, e.g. `nfl-gate-shadow.js` | a shadow-mode harness that scores any candidate gating architecture (F2, F3, or future ones) against true forward weeks before it may touch production weight |

## 4. Do-not-do list

1. Do not replace the Huber-ridge coordinator with a large, freely-parameterized neural gate
   trained end-to-end on Gridiron's ~19-expert, low-hundreds-of-games, dozens-of-independent-weeks
   dataset. Shazeer (2017) and Switch (2021) validate their gates on hundreds of millions to
   billions of examples; Qian et al. (2015) show real SPF data where estimated weighting made
   things *worse* than simple averaging (1.64-1.88x normalized risk) at sample sizes far larger
   than Gridiron's. K≈19 experts over T≈hundreds of games is deep in overfitting territory for a
   free-form gate.
2. Do not use Soft MoE-style full-sequence token mixing (Puigcerver et al. 2023) for the
   `live_updater` expert or any in-game/sequential signal — the authors state this explicitly:
   it requires seeing the whole input set and cannot preserve causal ordering, so it would leak
   future game state into a live in-game update.
3. Do not treat a learned gate's implicit L2/entropy shrinkage as a substitute for real
   preregistration + multiplicity correction (Holm/PBO/deflated Sharpe) for the 21-model
   historical search already run — that is a separate governance gap a smarter gate does not
   close.
4. Do not "fix" the discrete-regime problem by hand-picking more bins (10 instead of 5, finer
   spread/total thresholds, etc.) — that is the same category error `regimeLabels()` already
   makes, just with more cells. The fix is a continuous, jointly-fit gate, not finer hand-binning.
5. Do not ship any new gating architecture straight to production weight. Every candidate here
   must clear the same kind of true-forward (not walk-forward-refit) bar the existing per-role
   shrinkage check already applies to individual experts (`SHRINK_MIN_GAMES`, cross-half gain
   check in `shrinkageScales`) before it is allowed to move a single dollar or a single fantasy
   start/sit call.
6. Do not apply a new gate to player-week heads without re-running the same holdout-MAE +
   confidence-interval + resampling discipline already used (and already burned once) in
   `player-week-engine.js`'s injury/age ablation — that ablation shows a change that looked
   principled (recentering age/injury factors) validated positively out of sample yet *still*
   made the shipped pipeline worse on real ablation, because it double-counted information the
   structural model already encoded. "More sophisticated" is not evidence of "better" here.
