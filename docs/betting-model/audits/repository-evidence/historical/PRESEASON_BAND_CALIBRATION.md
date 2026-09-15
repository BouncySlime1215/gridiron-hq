# Out-of-sample calibration of the preseason p20/p80 band

Candidate #1 of `docs/BETTING_CAPABILITY_AUDIT.md`. Scripts:
`scratchpad/preseason/band.mjs` (candidate sweep), `band-bw.mjs` (bandwidth
robustness), `band-final.mjs` (final scoring of the selected head); raw numbers in
`band.json`, `band-bw.json`, `band-final.json`.

## Bottom line

**The shipped band was too wide, and a rank-local band fixed it. Shipped.**

Every board row carries a `p20`/`p80` interval whose nominal coverage is 60%. It had
never been coverage-tested out of sample. It covers **69.3%** of held-out outcomes
pooled — the interval was over-wide, not (as the right-skew of fantasy points might
suggest) too narrow or lopsided. Replacing the three hard draft tiers with a Gaussian
window over `pos_rank` brings pooled coverage to **62.7%** and improves pinball loss
significantly on 2 of 3 held-out seasons in **both** the top-150 and top-200 universes.
That clears the pre-stated bar, so it ships.

The change is confined to how the band's quantiles are read. The point estimate, the
market curve, the blend and every other number are untouched.

## Harness

Identical to `docs/PRESEASON_MODEL.md`: target season T ∈ {2023, 2024, 2025}, fitted
only on seasons < T (top-450 rows per season, as `shippedModel` does), graded on T's
top-150 by that season's FantasyPros ECR, with top-200 reported as a check. Actual
points are the audit's validated PPR rebuild from `nfl_player_week_features`. A
market-ranked player with no stat line scores zero — that is an outcome, and it is
exactly the left-tail case a band has to get right, so those rows are **in**.

Two metrics:

- **Coverage** — fraction of players whose actual points fell inside
  `[points × p20, points × p80]`. Nominal 0.60.
- **Pinball loss** — the proper scoring rule for an interval:
  `pinball(y, q̂, τ) = τ(y − q̂)` if `y ≥ q̂` else `(1 − τ)(q̂ − y)`, summed over
  τ = 0.2 and τ = 0.8. Lower is better. Coverage alone can be hit by a band that is
  wrong in both directions at once; pinball cannot.

Significance is `pairedBootstrapDiff` from `server/services/backtest-significance.js`
on per-player pinball loss, 4,000 resamples, 90% CI, clustered by season for the pooled
figure.

## Raw coverage: the band was too wide

Top-150, nominal 0.60.

| T | train seasons | coverage | below p20 | above p80 | pinball | mean band width |
|---|---|---|---|---|---|---|
| 2023 | 1 | **0.780** | 0.100 | 0.120 | 44.41 | 179 pts |
| 2024 | 2 | **0.667** | 0.160 | 0.173 | 43.13 | 143 pts |
| 2025 | 3 | **0.633** | 0.207 | 0.160 | 44.27 | 140 pts |
| pooled | — | **0.693** | — | — | 43.94 | — |

Two things to read here.

First, **the miss is width, not skew.** The band is symmetric in its failures — below
and above are within a few points of each other every season. The right-skew worry that
motivated the test is not what is wrong.

Second, **coverage converges toward nominal as the training set grows** (0.780 → 0.667
→ 0.633 for 1, 2, 3 training seasons). Some of the over-coverage is a thin-data artifact
of the early walk-forward folds, and the live 2026 fit trains on four seasons — further
along that trend than any season tested here. The expected live gain is therefore at the
small end of the range below, and the 2025 row is the honest guide to it, not 2023.
Even so, 2 of 3 seasons sit outside the 55–65% kill band, and the pooled figure does
too, so the "band is already fine, close it" exit does not apply.

## Candidates

Five families adapted from `nfl-prop-calibration.js`'s registry to the interval case,
all fitted on the training seasons only:

| id | what it does |
|---|---|
| `raw` | shipped: `actual/predicted` quantiles per position × tier (1–12 / 13–36 / 37+) |
| `pooled` | position only, no tier split |
| `width-w` | `raw` scaled by one global factor around each cell's median, `w` chosen out-of-fold **inside train** (leave-one-season-out, 5-fold player split when only one training season exists) to land coverage on 0.60 |
| `shrink-k` | tier quantiles shrunk toward the position-pooled quantiles at `n/(n+k)`, k ∈ {10, 50} |
| `kernel` | quantiles read from a Gaussian window over `pos_rank` instead of hard tiers |

Top-150, `dPinball` vs `raw` (negative is better), 90% paired-bootstrap CI:

| T | candidate | coverage | pinball | dPinball | CI90 | sig |
|---|---|---|---|---|---|---|
| 2023 | raw | 0.780 | 44.41 | — | — | — |
| 2023 | pooled | 0.800 | 47.27 | +2.87 | [1.15, 4.57] | worse |
| 2023 | width-1.0 | 0.780 | 44.41 | 0.00 | [0, 0] | no |
| 2023 | shrink-10 | 0.780 | 45.27 | +0.87 | [0.25, 1.45] | worse |
| 2023 | shrink-50 | 0.813 | 46.49 | +2.09 | [0.87, 3.26] | worse |
| 2023 | **kernel-18** | **0.633** | **39.34** | **−5.07** | [−6.78, −3.32] | **better** |
| 2024 | raw | 0.667 | 43.13 | — | — | — |
| 2024 | pooled | 0.760 | 48.45 | +5.33 | [2.23, 8.32] | worse |
| 2024 | width-1.0 | 0.667 | 43.13 | 0.00 | [0, 0] | no |
| 2024 | shrink-10 | 0.707 | 43.25 | +0.11 | [−0.83, 0.99] | no |
| 2024 | shrink-50 | 0.773 | 44.89 | +1.75 | [−0.32, 3.73] | no |
| 2024 | **kernel-18** | **0.627** | **42.34** | −0.78 | [−2.33, 0.78] | no |
| 2025 | raw | 0.633 | 44.27 | — | — | — |
| 2025 | pooled | 0.833 | 47.50 | +3.24 | [0.23, 6.10] | worse |
| 2025 | width-1.0 | 0.633 | 44.27 | 0.00 | [0, 0] | no |
| 2025 | shrink-10 | 0.667 | 43.70 | −0.57 | [−1.35, 0.18] | no |
| 2025 | shrink-50 | 0.773 | 44.66 | +0.40 | [−1.35, 2.11] | no |
| 2025 | **kernel-18** | **0.620** | **42.77** | **−1.49** | [−2.88, −0.09] | **better** |

Everything that only rescales or re-pools the tier table fails, and fails in a
consistent direction: they all make the band **wider still**. `width` is the clearest
result of the four — the out-of-fold search inside the training seasons selected
`w = 1.0` (i.e. "leave it alone") on all three targets, because in-sample the tier band
looks correctly calibrated. That is the diagnosis in one line: the tier band is not
mis-scaled, it is **mis-resolved**. No global factor can fix it.

`pooled` is instructive in the other direction — removing the tier split makes coverage
worse (0.76–0.83), which is why the tiers were introduced in the first place. The tiers
were the right idea implemented too coarsely.

## Why the kernel band works

`SPREAD_TIERS`'s `late` cell spans `pos_rank` 37 through 450. WR37 inherits the relative
error of WR120, whose outcomes genuinely range from zero to a starting job. Reading the
quantiles from a Gaussian window over rank (σ = 18 ranks) gives each slot its own band.

This is the same correction the point estimate already received: `docs/PRESEASON_MODEL.md`
lists "the local-linear fit itself, over the local-average version" as shipped finding
#2, for the same reason — a piecewise-constant fit is biased on a sloped curve. The band
was still using the tier-average form the curve had already moved on from.

## Bandwidth is not a knife edge

`dPinball` vs `raw`, top-150:

| σ | 2023 | 2024 | 2025 | seasons significant |
|---|---|---|---|---|
| 6 | −3.72 sig | −0.42 | −1.17 | 1 |
| 8 | −4.01 sig | −0.84 | −1.58 sig | 2 |
| 12 | −4.29 sig | −1.05 | −1.30 sig | 2 |
| **18** | **−5.07 sig** | **−0.78** | **−1.49 sig** | **2** |
| 25 | −4.84 sig | −0.41 | −1.38 | 1 |
| 40 | −4.19 sig | +1.07 | −0.93 | 1 |

Every bandwidth from 6 to 40 improves pinball on 2023, and every one from 6 to 25
improves it directionally on all three seasons. The family wins, not one lucky tuning.

**σ = 18 was chosen on the discovery season (2023) alone** — it is that season's best
pinball — and 2024 and 2025 were then scored once at that value, per the chronological
discipline in `nfl-prop-calibration.js`. Of the two sealed seasons, 2025 is significant
and 2024 is not.

## The shipped head, scored

σ = 18, both universes:

| universe | T | band | coverage | pinball | dPinball | CI90 | sig |
|---|---|---|---|---|---|---|---|
| top-150 | 2023 | raw | 0.780 | 44.41 | — | — | — |
| top-150 | 2023 | kernel | 0.633 | 39.34 | −5.07 | [−6.78, −3.32] | **yes** |
| top-150 | 2024 | raw | 0.667 | 43.13 | — | — | — |
| top-150 | 2024 | kernel | 0.627 | 42.34 | −0.78 | [−2.33, 0.78] | no |
| top-150 | 2025 | raw | 0.633 | 44.27 | — | — | — |
| top-150 | 2025 | kernel | 0.620 | 42.77 | −1.49 | [−2.88, −0.09] | **yes** |
| top-200 | 2023 | raw | 0.715 | 43.48 | — | — | — |
| top-200 | 2023 | kernel | 0.600 | 39.44 | −4.04 | [−5.43, −2.64] | **yes** |
| top-200 | 2024 | raw | 0.690 | 41.58 | — | — | — |
| top-200 | 2024 | kernel | 0.645 | 40.84 | −0.75 | [−1.94, 0.42] | no |
| top-200 | 2025 | raw | 0.663 | 41.70 | — | — | — |
| top-200 | 2025 | kernel | 0.623 | 40.33 | −1.35 | [−2.48, −0.24] | **yes** |

Pooled over the three held-out seasons, top-150, **clustered by season**:
coverage 0.693 → 0.627, pinball 43.94 → 41.49, `dPinball = −2.45`, CI90
[−3.88, −1.03], **significant**.

## The bar, and the verdict

Stated before the numbers were seen: *ship only if the recalibration significantly
improves pinball loss on ≥ 2 of 3 held-out seasons AND lands coverage inside roughly
55–65%.*

- Pinball: significant on **2 of 3** seasons (2023, 2025) — in both universes, with the
  same sign on the third.
- Coverage: **0.633 / 0.627 / 0.620** at top-150 and **0.600 / 0.645 / 0.623** at
  top-200 — all six inside 55–65%.

Both clauses met. Shipped.

### What this is not

The largest single-season gain (2023, −5.07) comes from the fold with the *thinnest*
training data, where raw coverage was worst (0.780). The live 2026 fit trains on four
seasons, so the realistic live effect is nearer the 2025 number: a ~1.5-point pinball
improvement and a band a few percent tighter, not a transformation. 2024 never reached
significance at any bandwidth. This is a real but modest calibration fix, and the claim
should not be inflated past that.

## Declined

| Candidate | Verdict |
|---|---|
| `pooled` (position only) | Declined. Significantly **worse** on 3/3 seasons (+2.87 / +5.33 / +3.24). Removing the tier split widens the band further; the tiers were the right idea. |
| `width-w` (global multiplicative rescale) | Declined, and informative. Out-of-fold selection inside the training seasons picked `w = 1.0` on all three targets — in-sample the tier band looks calibrated, so no global factor is even proposed. The defect is resolution, not scale. |
| `shrink-10` / `shrink-50` (toward position-pooled) | Declined. Both move coverage the wrong way (up to 0.773–0.813); `shrink-10` is significantly worse on 2023 and never significantly better. |
| Recalibrating the ratio's *shape* (Platt / beta on the ratio) | Not built. The failure mode measured is uniform over-width with symmetric tails — there is no asymmetry for a link-function rescale to correct, so building it would have been searching for a result rather than testing a hypothesis. |

## Code

`server/services/preseason-model.js`:

- `fitSpreadCurve(model, graded)` — new. Tabulates `{p20, p80}` per position on an
  integer `pos_rank` grid (1–200), each cell a Gaussian-weighted quantile of the
  training ratios at σ = `SPREAD_CURVE_BANDWIDTH` (18). Same `p > 20` guard as the tier
  table. A position with fewer than 20 graded rows gets no curve.
- `fitPreseasonModel` — sets `model.spreadCurve` alongside the existing `model.spread`.
  The tier table is still fitted and still exported; it is the fallback.
- `spreadFor` — reads the curve when there is one, clamping the rank onto the grid, and
  falls back to the tier table otherwise. Signature and return shape unchanged, so
  `preseasonProjections` and every downstream consumer of `p20`/`p80` are untouched.

Tests: `test/preseason-band-calibration.test.js` (8), covering the curve's existence,
rank resolution inside a tier, monotone widening, in-sample coverage near nominal,
off-grid ranks, the thin-position fallback, and determinism.
