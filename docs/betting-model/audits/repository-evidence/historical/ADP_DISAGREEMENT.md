# Cross-source ADP disagreement as a draft signal — declined

The betting engine's one proven edge is not prediction skill, it is that different
books price the same game differently (`gridiron-nfl-betting-model`: line shopping,
~2.57%/bet). This tests the fantasy analogue: ESPN ADP, Sleeper rank and FFC ADP are
three independent "books" pricing the same player, joined in `computeConsensus`
(`server/routes/aggregates.js`). Does the disagreement between them predict anything
about the player's realized season?

**Answer: the literal question cannot be tested from retained data, and the closest
testable proxy does not improve the ranker. Nothing shipped.** Evaluation script kept
in the session scratchpad; no production file was modified.

## Why the literal three-source test is not runnable

The three "books" are stored as a **live snapshot only**. Every one of them is
overwritten in place on each sync, so there is no season dimension to walk forward on:

| Source | Table | Season coverage | Rows |
|---|---|---|---|
| FFC ADP | `player_metrics` source `ffc_adp` | none — no season column | 295 |
| Sleeper rank | `player_metrics` source `sleeper_rank` | none — no season column | 1,632 |
| FantasyCalc | `player_metrics` `fc_value` / `fc_trend30` | none — no season column | 223 each |
| ESPN ADP | `espn_player_market` | **2026 only** | 400 |
| Realized points | `player_season_stats` kind `actual` | **2025 only** | 841 |

The overlap of {two or more source ranks} × {a realized outcome} is **zero
player-seasons**. This is the exact gap `historical-adp.js`'s own header calls out
("nothing in this app retains this... overwritten in place every sync"). Testing the
signed-direction hypothesis — is ESPN consistently wrong relative to FFC/Sleeper —
would require snapshotting all three per season going forward. That is the only way
this question ever becomes answerable, and it is cheap: one `(season, source,
player_key)` table, the shape `nfl_historical_adp` already uses.

## What was tested instead

`nfl_historical_adp.ecr_std_dev` — the dispersion of **independent expert rankers** on
one player, FantasyPros ECR, retained per season 2021–2025 (523–619 players/season,
full coverage on the top 200). It is a different set of raters than ESPN/Sleeper/FFC,
but it is the same structural quantity: how much do independent pricers of this player
disagree. It reaches the model as `row.rank_std`.

Method mirrors `docs/PRESEASON_MODEL.md` exactly: target season T ∈ {2023, 2024, 2025},
everything fitted on seasons strictly before T, test set = top 200 by that season's
ECR, actuals = PPR totals from `nfl_player_week_features` via
`preseason-model.js`'s validated `seasonTotals`.

Raw `ecr_std_dev` is mostly a restatement of rank (log–log slope 0.77–0.81 across the
three training windows), so the signal used is **excess** disagreement: the residual of
`log(ecr_std_dev) ~ a + b·log(market_rank)`, standardized. Slope, intercept, sigma and
the quartile cut points are all fitted on training seasons only.

## Q1 — does disagreement predict outcome VARIANCE? Yes, weakly. 2/3.

SD of (actual − curve prediction), top vs bottom disagreement quartile:

| Season | n high / low | SD high | SD low | SD ratio | permutation p |
|---|---|---|---|---|---|
| 2023 | 40 / 55 | 74.7 | 78.4 | 0.95 | 0.61 |
| 2024 | 35 / 94 | 88.8 | 65.8 | 1.35 | **0.008** |
| 2025 | 45 / 55 | 83.3 | 66.0 | 1.26 | **0.048** |
| pooled (season-demeaned) | 120 / 204 | 81.5 | 69.1 | 1.18 (var 1.39) | **0.016** |

Two of three seasons significant, but 2023 points the wrong way. Not a rookie
artifact: rookies concentrate heavily in the high bucket (35% / 17% / 33% vs 4% / 9% /
0%), yet excluding them the pooled ratio holds at 1.23, p = 0.0095 (n = 85 / 194).
Bust rate (actual < 0.5 × curve) high vs low: 2023 17.5%/20%, 2024 20%/8.5%, 2025
22%/14%.

This is a statement about **interval width**, not about who to draft. It says a
contested player's outcome is more spread out, in the direction anyone would guess. It
does not say which side.

## Q2 — does the DIRECTION of disagreement predict over/underperformance? No.

Mean (actual − curve) residual, high minus low disagreement quartile:

| Season | mean resid high | mean resid low | diff | SE | t | Spearman(z, resid) |
|---|---|---|---|---|---|---|
| 2023 | +9.4 | −7.1 | +16.5 | 15.9 | 1.04 | −0.011 |
| 2024 | −5.2 | +13.4 | −18.6 | 16.5 | −1.13 | −0.070 |
| 2025 | −13.0 | −10.0 | −3.0 | 15.3 | −0.20 | −0.004 |

The sign flips season to season, no |t| exceeds 1.2, and the rank correlation between
excess disagreement and residual is indistinguishable from zero in all three seasons.
There is no consistently-wrong side to shop. **0/3.**

## Q3 — does a disagreement term improve the ranker? No. 0/3.

Two forms, both with the coefficient fitted on training seasons only: additive
(`pred + β·z`, β fitted through the origin on training residuals) and multiplicative
(`pred × (1 + γ·z)`). `dMAE` is MAE(variant) − MAE(curve), negative is better, 90%
`pairedBootstrapDiff` CI over 4,000 resamples of the player set.

| Season | n | MAE curve | MAE add | dMAE add | CI90 | sig | MAE mul | dMAE mul | CI90 | sig |
|---|---|---|---|---|---|---|---|---|---|---|
| 2023 | 200 | 57.84 | 57.88 | +0.04 | [−0.47, 0.54] | no | 57.74 | −0.09 | [−0.96, 0.73] | no |
| 2024 | 200 | 58.20 | 58.35 | +0.16 | [−0.44, 0.76] | no | 58.20 | −0.00 | [−0.84, 0.82] | no |
| 2025 | 199 | 58.39 | 58.70 | +0.32 | [−0.45, 1.07] | no | 58.82 | +0.44 | [−0.44, 1.31] | no |

Every interval straddles zero. The additive form is worse in all three seasons; the
multiplicative form is worse in one, a rounding error in two. Spearman moves by at most
0.005 in either direction (curve 0.5703 / 0.5918 / 0.6093). Fitted β is −4.4 to −6.3
points per standard deviation of excess disagreement and does not transfer.

**Is it already captured?** Yes, twice over. `rank_std` has been feature index 2 of
`FEATURE_NAMES` since v1, labeled "expert disagreement" in `DRIVER_LABEL`, and the
learned models that consumed it were all declined (`docs/PRESEASON_MODEL.md`:
`SHIPPED_BLEND = { market: 1, structural: 0, model: 0 }`). Adding it directly to the
curve instead of through a learned model, which is what this test did, does not rescue
it.

## Decision

Declined. Nothing wired into `draft-assist.js` or `preseason-model.js`; no new module.
The bar is ≥2 of 3 held-out seasons significant for improving the ranker, and the
ranker result is 0/3 in both functional forms.

The Q1 variance result is the one live thread and is deliberately **not** shipped here:
it clears 2/3 on a different question (band width, not point ranking), 2025 is
marginal at p = 0.048, and 2023 runs backwards. If the p20/p80 band is ever revisited
on its own terms, widen it for high-`rank_std` players and re-test there — do not read
this document as having already earned that change.

## Caveats

- The proxy is FantasyPros expert dispersion, not ESPN-vs-Sleeper-vs-FFC dispersion.
  Cross-*platform* disagreement could behave differently; it is untestable today for
  the reason in the first section, not because it was found wanting.
- Three held-out seasons, ~200 players each, 35–94 per quartile bucket. Per-season
  cells are small and the 2023/2024 sign flip in Q2 is exactly what noise at this
  sample size looks like.
- Fumbles are absent from the actuals (inherited from `seasonTotals`); every variant is
  graded on identical totals, so it cannot favour one over another.
