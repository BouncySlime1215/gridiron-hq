# Stage 1 results — "fix how the model weighs evidence"

Companion to `BUILD_ORDER.md`. Every number here is on a **week-by-week
walk-forward replay** (`server/services/weekly-backtest.js`): at week W the
model may use prior seasons plus weeks 1..W-1 of the current season, and is
graded on week W alone. Season-total numbers are reported alongside, but the
weekly ones are the real gates — that is how the model runs in production.

**Why weekly.** The gates were originally specified on season totals: ~382
player-seasons, filtered to `games >= 4`. That measurement is underpowered
(a paired bootstrap over it cannot separate a 1% effect from noise — which is
exactly why 1.1 came back inconclusive), survivorship-filtered (truth is
conditioned on an outcome the prediction is not), and it grades a draft-day
question rather than the weekly start/sit decision the product makes. Weekly
replay gives **4,340 graded player-weeks for 2025 alone**, no survivorship
filter, and matches the shape Stage 6.3 requires.

**Protocol.** Fit on 2023 + 2024, validate on 2025 — which is the frozen
baseline holdout and was never used to choose a parameter. Adoption decisions
use a paired bootstrap over player-weeks (`backtest-significance.js`), so a
nominal win inside the noise band is treated as "we don't know," not as a win.

---

## 1.1 Fit the shrinkage constants — **gate FAILED, constants kept**

Implemented `k* = σ²_within / σ²_between` as a proper one-way random-effects
variance decomposition (Searle unbalanced-ANOVA method of moments) over 26
metric×position pairs — `server/services/shrinkage-fit.js`, versioned in
`shrinkage_fits` / `shrinkage_k`.

The fitted constants are directionally sensible and confirm what the model's
own comments suspected: touchdown rate needs *far* more shrinkage than the
hardcoded values (rec TD rate k ≈ 290–505 vs. an effective 70), and INT rate
k ≈ 3827 — essentially all cross-QB variation in interception rate is noise,
not skill. Shares stabilise faster than assumed (target/carry share k ≈ 0.5–0.7
vs. hardcoded 6).

But on held-out data the fitted vector is **not distinguishable from the
hardcoded one**:

| | MAE | Spearman | CRPS |
|---|---|---|---|
| hardcoded K | 42.68 | 0.7786 | 30.364 |
| fitted k* | 42.61 | 0.7795 | 30.351 |

Paired bootstrap, 2000 resamples: CRPS delta −0.011, 90% CI [−0.82, 0.80];
MAE delta −0.078, CI [−1.23, 1.10]. Both straddle zero.

**Outcome:** kept the constants, per the Build Order's own rule. Recorded as
fit #2, not activated. The finding is that the hardcoded constants are
genuinely competitive — previously unknown either way.

> Note: the first run of this comparison showed a ~2% CRPS *loss* for the
> fitted vector. That was an artifact of grading the distribution on only the
> first 150 players (a quirk inherited from `/api/model/accuracy`). On the full
> 382 the gap vanishes. This is why the significance tooling exists.

## 1.2 Add the missing variance sources — **gate PASSED**

The season path already drew a per-season level and beta-binomial games. The
**weekly** sampler drew neither: every simulated week used the point-estimate
role and efficiency exactly, so the only spread was within-week sampling noise.
Measured weekly, the PIT histogram was overweight in *both* tail bins (674 and
543 against 434 expected) — textbook under-dispersion.

Added parameter uncertainty to `sampleWeeks` (`WEEKLY_LEVEL`), fitted on
2023+2024, validated on 2025:

| 2025 holdout (4,340 player-weeks) | before | after | gate |
|---|---|---|---|
| **80% coverage** | 0.724 | **0.795** | [0.78, 0.82] ✅ |
| PIT calibration error | 0.161 | **0.110** | flatter ✅ |
| CRPS | 3.248 | 3.242 | not degraded ✅ |

CRPS is unchanged, which is the important control: the interval got wider
where it was genuinely too narrow, rather than buying coverage by hedging
everything. Adopted `sigma = 0.45`. `downMult` stayed 1.0 — unlike season
totals, weekly outcomes showed no benefit from a fattened downside once the
overall spread was right.

## 1.3 Beat the blend — **weekly gate PASSED**

### Reproduction and authoritative metric

Both disputed measurements were reproduced with the currently active fitted
shrinkage vector before changing the model:

| 2025 replay | model | comparator | result |
|---|---:|---:|---|
| Season total, survivor-filtered (n=382) | MAE **42.12**, Spearman **.7831** | 60/40 MAE 42.70, Spearman .7800 | model wins |
| Weekly walk-forward (n=4,340) | MAE 4.586, Spearman .6568 | season average 4.509; 60/40 MAE 4.488, Spearman .6674 | model loses |

This is not a numerical contradiction. The season-total test is a draft-time
forecast over players who survived a season; its historical component is last
season's total. The weekly test is the actual start/sit decision, has eleven
times as many observations, includes the early-season/low-volume cases causing
the error, and compares against same-season evidence. **Weekly is therefore the
authoritative Stage 1.3 gate.** Season totals remain a separately reported
product metric, not a veto over weekly evidence.

### Role-prior experiments (failures retained, not promoted)

The flat-prior diagnosis was tested rather than assumed. Every candidate used
only role information known before the game being forecast:

| candidate | discovery | 2025 validation | decision |
|---|---|---|---|
| Prior-season role tiers | — | MAE 4.602 vs 4.586 | reject |
| Empirical-Bayes share mixture | worse in both 2023 and 2024 | not opened | reject |
| Prior-week offensive-snap tier | improved 2023/24 | MAE 4.594, rank .6588 | reject |
| Lagged current-season opportunity tier | MAE 4.742 vs 4.740 | not opened | reject |

The important result is negative: replacing one flat mean with a discretized
role mean improves ordering in places but does not improve weekly absolute
error. Those branches were removed from production rather than tuned against
2025.

### The actual evidence-weighting fix

The earlier recency sweep applied one decay rate to everything. That conflated
two processes: a player's role can change quickly, while efficiency requires a
large sample. A new discovery-only grid decayed **opportunity and team volume**
independently while preserving the validated efficiency history.

Fit on 2023+2024, the selected role memory was
`seasonDecay=0.05, weekHalfLife=5`. On 2025 it produced:

| 2025 weekly | MAE | Spearman | CRPS | 80% coverage |
|---|---:|---:|---:|---:|
| prior structural head | 4.586 | .6568 | 3.196 | .817 |
| role-memory structural head | **4.501** | **.6664** | **3.152** | .816 |

That is a large, clean improvement, but the fixed 60/40 update still scored
4.442. The structural forecast was therefore retained as one head rather than
declared sufficient by itself.

### Cutoff-safe ensemble

Five genuinely different pregame summaries were stacked: structural
volume×efficiency, season-to-date mean, last-three mean, last game, and
season median. Convex weights were fitted on 2023. Global versus
position-specific architecture was selected on 2024; position-specific won.
No negative or leveraged weights are permitted.

Frozen weights (`structural / STD / last3 / last1 / median`):

| position | weights |
|---|---|
| QB | .40 / .45 / 0 / .10 / .05 |
| RB | .50 / .20 / .10 / .15 / .05 |
| WR | .60 / 0 / 0 / .10 / .30 |
| TE | .80 / .20 / 0 / 0 / 0 |

Final 2025 weekly gate:

| model | MAE | Spearman | CRPS | 80% coverage |
|---|---:|---:|---:|---:|
| **position-aware ensemble** | **4.420** | **.6739** | **3.145** | **.815** |
| fixed structural 60/40 | 4.442 | .6707 | — | — |
| season-to-date | 4.509 | .6558 | — | — |

Paired bootstrap versus the fixed blend: MAE delta **−0.0215**, 90% CI
**[−0.0403, −0.0036]**. Versus season-to-date: **−0.0885**, CI
**[−0.1206, −0.0560]**. Rank improved, CRPS improved, and coverage stayed in
the preregistered [.78, .82] interval. **Stage 1.3 is green; Stage 2 is
unlocked.**

This is validation, not the Stage 6 blind audit. The 2025 outcomes had already
been inspected during diagnosis. The final weights themselves were fit on 2023
and architecture-selected on 2024, but no claim of a never-seen audit is made.

### Foundation hardening after promotion

- `player-week-engine.js` now has bounded, cutoff/version-aware caches. On the
  local production database a repeated full-week build fell from ~134 ms to
  **0.09 ms**, and a repeated 4,000-draw player distribution from ~12 ms to
  **0.02 ms**. Cache invalidation is coupled to model/data refresh.
- Weekly explanations are deterministic typed evidence, not generated prose.
  They expose the exact cutoff, head values, weights, structural estimate,
  ensemble shift, and any snap-confirmed role change.
- Every Claude call now receives a global evidence-only system contract and
  temperature 0. The player BUY/SELL/HOLD layer may select a verdict and valid
  evidence IDs only; the server renders the explanation from stored facts and
  discards invented IDs or prose.
- Forward learning is additive. Pregame snapshots are frozen before outcomes,
  then settled and used by a versioned champion/challenger trainer. Promotion
  requires lower newest-window MAE, non-degraded Spearman, and 80% coverage in
  [.78, .82]. No learner can rewrite the structural, uncertainty, role-memory,
  or deterministic evidence layers.

---

## Known limitations

1. **Only three test seasons.** `player_week_usage` holds 2022–2025. Worse,
   it joins through our `players` table, which is the current ~1,000-player
   roster universe — so syncing older seasons would capture only players still
   rostered today, i.e. heavy survivorship bias. Widening this properly (a
   historical player universe) is the highest-value unblocker for every gate
   here and is required for Stage 6 regardless.
2. **Bias quantities drift with history depth.** Log-log slope 0.99 → 1.05 →
   1.25 and mean log ppg ratio −0.055 → −0.103 → −0.294 across the 2023/2024/2025
   holdouts, all monotone in history depth. Only the residual spread (~0.89) is
   a genuine constant. This is why no post-hoc bias correction was fitted —
   it would be calibrated to a regime that no longer applies.
3. **`/api/model/accuracy` grades distributions on the first 150 players only.**
   Fine for a live page, misleading for a gate decision. The scripts here use
   the full set.

## Reproducing

```bash
node scripts/freeze-baseline.mjs 2025      # season-total baseline + dataset hash
node scripts/fit-shrinkage.mjs             # 1.1
node scripts/fit-weekly-coverage.mjs       # 1.2
node scripts/fit-weekly.mjs                # 1.3
node scripts/fit-role-recency.mjs          # separate role/efficiency memory
node scripts/fit-weekly-ensemble.mjs       # final weekly gate
```

`docs/baselines/2025-baseline-pre-stage1.json` preserves the pre-Stage-1
numbers for comparison.
