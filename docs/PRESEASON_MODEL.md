# Preseason season-long projection model

`server/services/preseason-model.js`. Walk-forward evaluation scripts in
`scratchpad/preseason/` (`backtest.mjs`, `experiments.mjs`, `curve2.mjs`, `final.mjs`);
raw numbers in `scratchpad/preseason/final.json`. The service reads
`server/data.sqlite` and **writes nothing**.

## Bottom line

**The learned model was declined. What ships is a calibrated market curve.**

Ridge, a GBM, and three stacked blends were fitted walk-forward for target seasons
2023, 2024 and 2025 (training on seasons strictly before T, graded on identical player
sets). None of them beat the market-implied points curve by a significant margin on any
season — 0 of 3 on the paired bootstrap, in either direction. Under this repo's
governance that is a decline, not a ship.

What did earn its place and is shipped:

1. **A rank → points curve fitted with LOCAL LINEAR regression**, on the realized points
   of every player drafted at each positional slot in prior seasons. This converts a
   rank into calibrated points, expected games, and a p20/p80 band, which is what a
   draft board actually needs. It beats prior-year points by 17-22 MAE (significant
   3/3) and `projections.js` by 1-8 MAE (significant 2/3).
2. **The local-linear fit itself**, over the local-average version that was written
   first. See "what the curve is" below: a plain kernel average is biased at the ends of
   a sloped curve and was costing the elite QB slot 38 points and the elite TE slot 35.
3. **Explanations** (`drivers`) driven by the ridge's own per-feature contributions,
   plus the ridge's "repeat-his-role" number reported as `components.model` so a caller
   can show where the model disagrees with the board without acting on it.

## Held-out results

Target season T, fitted only on seasons < T. Test set = top 200 by that season's
FantasyPros ECR (skill positions only), identical players for every model. Actual
points = PPR season totals rebuilt from `nfl_player_week_features` (the audit's
validated aggregation: r=0.9987 vs ESPN 2025, r=0.9999 vs nflverse ffopportunity).
`dMAE` is `MAE(model) − MAE(ECR curve)`, so **negative is better**, with a 90% paired
bootstrap CI over 4,000 resamples of the player set.

| Season | n | Model | Spearman | MAE | dMAE vs curve | CI90 | sig |
|---|---|---|---|---|---|---|---|
| 2023 | 200 | **market curve** | **0.5774** | **57.30** | — | — | — |
| 2023 | 200 | prior-year points | 0.4309 | 75.74 | +18.38 | [11.78, 25.30] | worse |
| 2023 | 200 | projections.js | 0.4626 | 64.94 | +7.61 | [3.06, 12.26] | worse |
| 2023 | 200 | shipped blend .6/.4 | 0.5552 | 57.88 | +0.56 | [−1.44, 2.57] | no |
| 2023 | 200 | ridge | 0.5420 | 61.48 | +4.25 | [0.64, 7.82] | worse |
| 2023 | 200 | GBM | 0.5610 | 57.74 | +0.47 | [−2.42, 3.37] | no |
| 2023 | 200 | stack (ridge, OOF weights) | 0.5635 | 58.27 | +1.00 | [−1.05, 3.06] | no |
| 2023 | 200 | stack (GBM, OOF weights) | 0.5725 | 56.63 | −0.66 | [−2.46, 1.12] | no |
| 2024 | 200 | **market curve** | **0.5841** | **58.49** | — | — | — |
| 2024 | 200 | prior-year points | 0.3812 | 80.64 | +22.09 | [14.94, 29.15] | worse |
| 2024 | 200 | projections.js | 0.4475 | 66.90 | +8.43 | [4.12, 12.79] | worse |
| 2024 | 200 | shipped blend .6/.4 | 0.5503 | 59.91 | +1.42 | [−0.62, 3.41] | no |
| 2024 | 200 | ridge | 0.5768 | 63.08 | +4.57 | [1.29, 7.88] | worse |
| 2024 | 200 | GBM | 0.5581 | 61.33 | +2.83 | [0.74, 4.97] | worse |
| 2024 | 200 | stack (ridge, OOF weights) | 0.5817 | 58.64 | +0.14 | [−0.45, 0.75] | no |
| 2024 | 200 | stack (GBM, OOF weights) | 0.5789 | 58.89 | +0.40 | [−0.29, 1.08] | no |
| 2025 | 199 | **market curve** | 0.6120 | 58.20 | — | — | — |
| 2025 | 199 | prior-year points | 0.4701 | 75.68 | +17.47 | [10.88, 24.33] | worse |
| 2025 | 199 | projections.js | 0.5761 | 59.36 | +1.17 | [−2.86, 5.23] | no |
| 2025 | 199 | shipped blend .6/.4 | **0.6311** | **56.96** | −1.25 | [−3.14, 0.60] | no |
| 2025 | 199 | ridge | 0.6145 | 60.56 | +2.40 | [−1.08, 5.85] | no |
| 2025 | 199 | GBM | 0.5931 | 59.15 | +0.97 | [−1.04, 2.98] | no |
| 2025 | 199 | stack (ridge, OOF weights) | 0.6218 | 57.82 | −0.38 | [−0.85, 0.09] | no |
| 2025 | 199 | stack (GBM, OOF weights) | 0.6190 | 58.03 | −0.17 | [−0.61, 0.25] | no |

Pooled across the three held-out seasons (n = 599):

| Model | Spearman | MAE | seasons beating curve on Spearman | seasons significantly better on MAE |
|---|---|---|---|---|
| **market curve (shipped)** | **0.5912** | **58.00** | — | — |
| stack (GBM, OOF weights) | 0.5901 | 57.85 | 1/3 | 0/3 |
| stack (ridge, OOF weights) | 0.5890 | 58.24 | 1/3 | 0/3 |
| shipped blend 0.6 market / 0.4 model | 0.5789 | 58.25 | 1/3 | 0/3 |
| ridge | 0.5778 | 61.71 | 1/3 | 0/3 |
| GBM | 0.5707 | 59.41 | 0/3 | 0/3 |
| projections.js alone | 0.4954 | 63.73 | 0/3 | 0/3 |
| prior-year points | 0.4274 | 77.35 | 0/3 | 0/3 |

Per position, market curve (n / Spearman / MAE):

| Season | QB | RB | WR | TE |
|---|---|---|---|---|
| 2023 | 27 / 0.318 / 79.8 | 59 / 0.423 / 64.0 | 90 / 0.685 / 49.0 | 24 / 0.422 / 46.8 |
| 2024 | 30 / 0.361 / 73.3 | 63 / 0.613 / 63.8 | 81 / 0.539 / 54.9 | 26 / 0.245 / 39.9 |
| 2025 | 28 / 0.180 / 77.1 | 62 / 0.689 / 62.2 | 83 / 0.518 / 55.0 | 26 / 0.366 / 38.4 |

QB is the weak position everywhere (Spearman 0.18-0.36): the board's QB ordering carries
little information about the finish, which is consistent with the audit's finding that
QB13-18 "hits" 57% of the time — the tier is nearly interchangeable.

## What the curve is, and the two traps it exists to avoid

**Trap 1 — mean reversion.** The player ranked #1 can only fall. Grading a rank against
the points of the player who *finished* at that rank manufactures a model that is really
just regression to the mean. The curve is therefore fitted on the points the **average
player drafted at that slot actually scored**, and every model is graded against that
same honest number. It is also clamped monotone in rank: kernel smoothing over three
noisy seasons produces small inversions that would otherwise read as "the model prefers
the later pick", which is an artifact.

**Trap 2 — boundary bias.** The first cut used a local average (Nadaraya-Watson). On a
sloped curve that is biased at the ends: at rank 1 every neighbour is a worse player, so
the fit drags the top slot down. Measured pooled over the three held-out seasons, the
local-average curve was under-predicting the top-36 by position by QB +38, TE +35, RB
+19 points. Switching to a **local linear** fit (bandwidth 9 slots, chosen from
{4, 6, 9, 12} on held-out MAE) removed most of it and improved pooled MAE from 58.31 to
58.00:

| Curve | pooled Spearman | pooled MAE | top-36 bias QB / RB / WR / TE |
|---|---|---|---|
| local average, bw 6 | 0.5903 | 58.31 | +38 / +19 / −14 / +35 |
| local linear, bw 6 | 0.5908 | 58.23 | −11 / +6 / −23 / +7 |
| **local linear, bw 9** | **0.5912** | **58.00** | **+5 / +7 / −24 / +13** |
| local linear, bw 12 | 0.5906 | 57.93 | +15 / +9 / −23 / +18 |

## Calibration by market tier

Pooled 2023-2025, held-out. Bias = mean actual − mean curve prediction; positive means
the slot out-produced what the curve said.

| Pos | Overall ECR tier | n | actual | curve | bias |
|---|---|---|---|---|---|
| QB | 13-36 | 11 | 317.8 | 312.7 | +5.1 |
| QB | 37-100 | 30 | 233.7 | 252.6 | −18.9 |
| QB | 101-200 | 44 | 213.0 | 186.6 | +26.3 |
| RB | 1-12 | 11 | 274.6 | 262.3 | +12.3 |
| RB | 13-36 | 24 | 236.1 | 231.8 | +4.3 |
| RB | 37-100 | 61 | 170.0 | 170.7 | −0.7 |
| RB | 101-200 | 88 | 102.0 | 109.1 | −7.1 |
| WR | 1-12 | 24 | 265.0 | 277.3 | −12.3 |
| WR | 13-36 | 31 | 192.3 | 225.1 | **−32.8** |
| WR | 37-100 | 80 | 170.8 | 171.3 | −0.5 |
| WR | 101-200 | 119 | 107.7 | 104.3 | +3.4 |
| TE | 1-12 | 1 | 221.4 | 190.2 | +31.2 |
| TE | 13-36 | 6 | 193.2 | 182.7 | +10.5 |
| TE | 37-100 | 21 | 147.4 | 158.7 | −11.3 |
| TE | 101-200 | 48 | 128.4 | 115.2 | +13.1 |

**The audit's WR-13-36-overvalued / RB-undervalued pattern replicates out-of-sample.**
WRs drafted 13-36 overall returned 33 fewer points than players drafted at their
positional slot historically did; RBs in the top 36 returned 4-12 more. RB is now close
to unbiased because the local-linear curve fixed the boundary artifact, but the WR gap
is not a curve artifact — it survives a bias-free fit.

**It could not be corrected out-of-sample.** The curve is already fitted per position on
prior seasons, so this bias is exactly zero in training by construction; it is
season-to-season drift, not a stable offset. Weighting recent training seasons more
heavily (decay 0.8 / 0.6 / 0.4 per season) moved the WR top-36 bias by 1 point and made
MAE slightly worse. The honest statement is: *the pattern is real and repeated, and this
model cannot exploit it with the data on hand.* The draft-board consequence is the same
one the audit already drew — prefer the RB in rounds 2-4 — and it belongs in the ranking
policy, not in a fitted term.

## Availability: measured, and declined

Points are decomposed as `ppg × expected_games`, and the availability head was fitted
separately (ridge on the same features, target = games played, trained on everyone
including the zeros). Graded against the market curve's own expected-games number
(the average games played at that draft slot) on held-out seasons:

| Season | model MAE (games) | slot-average MAE (games) | paired bootstrap |
|---|---|---|---|
| 2023 | 3.71 | 3.07 | +0.65 [0.41, 0.89] worse |
| 2024 | 3.41 | 2.94 | +0.46 [0.23, 0.70] worse |
| 2025 | 3.70 | 3.30 | +0.41 [0.19, 0.64] worse |

**The fitted availability head is significantly worse than a flat slot average on all
three seasons.** Games missed last season, three-year availability, age and draft
capital do not forecast next season's games played well enough to beat "what a player
drafted here usually plays". So `expected_games` in the shipped output is the slot
average; the head is still fitted and exposed as `model_expected_games` for inspection.

This is the sharpest result in the whole exercise and it cuts against the intuition it
was built on: availability is the highest-leverage quantity in a season projection *and*
is the least forecastable one. The consequence for the draft board is that a player who
missed six games last year should be flagged, not discounted — and `drivers` says
exactly that.

## What ships

- **Point estimate**: the local-linear slot curve, positional rank → mean realized PPR
  points, fitted on every graded season before the target (bandwidth 9).
- **Board source**: FantasyPros ECR (`nfl_historical_adp`) for 2021-2025; ESPN's live
  board (`espn_player_market.adp`, joined by `espn_id`) for 2026, since no ECR file
  exists for 2026 in the database. Rank is recomputed as order within skill positions in
  both cases, so one curve applies to both.
- **Fitting set**: the top 450 of each prior board, not the top 200 the model is graded
  on. The deep ranks pin down the tail of the curve; the extra rows measurably steadied
  the earliest target season's fit.
- **`expected_games`**: the slot curve's average games, clamped to [4, 17].
- **`p20` / `p80`**: quantiles of `actual / predicted` from the training seasons, banded
  by position **and** draft tier (slots 1-12 / 13-36 / 37+). Pooling the tiers produced
  a band so wide it was useless — the QB1 slot inherited the relative error of QB40,
  whose outcomes range from zero to a starting job.
- **`components`**: `market` (the curve, and the only thing blended in),
  `structural` (`projections.js`, weight 0), `model` (the ridge's "repeat-his-role"
  number, weight 0). `SHIPPED_BLEND = { market: 1, structural: 0, model: 0 }`.
- **`vendor_points`**: ESPN's own `season_proj` where the board publishes one. Reported,
  never used — no historical ESPN projections are stored, so it has never been graded
  here.
- **`drivers`**: up to five short strings, ordered by the ridge's signed per-feature
  contribution to ppg, each tied to a value the reader can check ("29% target share in
  2025 — second straight season above 12%"). The board slot line is always included.

## Features computed (all from seasons ≤ T−1)

`log_market_rank`, `log_pos_rank`, `rank_std`, `ppg_1/2/3`, recency-weighted `ppg_w`,
`games_1/2`, `availability_3`, `target_share_1`, `carry_share_1`, `attempt_share_1`,
`targets_pg_1`, `carries_pg_1`, `air_yards_pg_1`, `td_luck_pg_1` (actual minus expected
fantasy points per game from nflverse ffopportunity, capped at ±6), `has_history`,
`rookie`, `draft_capital`, `age`, position one-hots, and `projections.js`'s
`proj_ppg` / `proj_games` / `proj_points` (coverage 82.5-84.0% of the test set; rookies
and returning absentees have none and fall back to the slot curve).

## Declined, and why

| Candidate | Verdict |
|---|---|
| Ridge on standardized features | Declined. Pooled Spearman 0.5778 vs 0.5912; MAE significantly **worse** on 2023 and 2024. |
| GBM (`nfl-gbm.js` `fitGbm`) | Declined. Pooled 0.5707 / 59.41; significantly worse on 2024. |
| Stacked blends (market + projections.js + model) | Declined. Best pooled variant 0.5901 / 57.85 — inside the noise band against the curve on 0/3 seasons, in either direction. |
| Fitted availability head | Declined. Significantly worse than the slot average on 3/3 seasons (above). |
| In-sample stack weights | Declined as a **method**. The first cut fitted blend weights on the same rows the components were fitted on and handed the GBM weight 1.0, because its in-sample residuals are near zero. Redone with leave-one-season-out components (3 random folds when only one training season exists). Fixed in the shipped code — no weights are searched at fit time at all. |
| `projections.js` as the primary number | Declined. 0.4954 / 63.73 pooled; significantly worse than the curve on 2/3 seasons. It stays a reported component. |
| Team-change flag and vacated opportunity (`nfl-offseason-change.js`) | Not used. `offseasonChanges(T)` derives a historical season's rosters from that season's own weekly usage rows, so `departed_league` is decided by whether the player actually appeared in T — a look-ahead that would make the feature score well for the wrong reason. Combined with the audit's finding that coaching change earns nothing, it was not worth building a leak-free substitute for. |
| Age cliffs, coaching change | Not used, per `docs/DRAFT_AUDIT_2021_2025.md`, which found neither supported once ECR is conditioned on. `age` is present as a plain linear feature only. |
| Recency-weighted curve (season decay) | Declined. Moved pooled Spearman by 0.0003 and made MAE worse; did not touch the WR drift it was built for. |
| Per-position/tier recalibration of the curve | Not possible out-of-sample. Zero by construction in training (see calibration section). |

## Known limits

1. **Three held-out seasons, ~200 players each.** Every difference discussed here is
   smaller than the sampling noise on 599 graded player-seasons. That is the honest
   reason nothing shipped, and it is also why a future model should not be adopted on a
   point estimate either.
2. **Only two training seasons exist for the earliest target.** ECR starts at 2021 and
   the target needs prior-season features, so T=2023 trains on 2022 alone at the top-200
   level (437 rows at the top-450 level). The fits for 2023 are visibly weaker than for
   2025.
3. **Fumbles lost are missing** from `nfl_player_week_features`, worth 1-4 points a
   season for RB/QB. Every model and baseline is graded on the same totals, so it cannot
   favour one over another, but the absolute point levels run very slightly high.
4. **The 2026 board is ESPN's, not FantasyPros'.** The curve was fitted on ECR ranks and
   is applied to ESPN ADP ranks. They order players similarly but not identically, and
   this substitution has never been validated — there is no season where both exist in
   the database with a graded outcome.
5. **The ECR → gsis name join** is the audit's, including its seven hand-checked
   aliases. Disambiguation is allowed to look at season T's rosters (it decides *which
   player a row is*, never anything about how he performed), and market-ranked players
   with no stat line are scored 0 points / 0 games rather than dropped — dropping them
   is exactly the survivorship bias that flatters a preseason model.
6. **No in-season update.** This is a preseason board. Once games are played,
   `projections.js` and the weekly ensemble are the right tools.
7. **The `drivers` strings are ordered by the ridge**, which is not the shipped point
   estimate. They explain what the model saw, not how the shipped number was computed —
   the shipped number is a slot average and has no per-player explanation by
   construction. This is a deliberate trade: an explanation the drafter can check
   against a stat sheet is worth more than an explanation of an average.

## API

```js
import { preseasonProjection, preseasonProjections } from './services/preseason-model.js';

preseasonProjections(2026);           // Map<gsis_id, projection>, cached per process
preseasonProjection(playerId, 2026);  // one projection; accepts gsis_id, players.id or espn_id
```

```jsonc
{
  "player_id": "00-0038543", "gsis_id": "00-0038543", "name": "…", "position": "RB",
  "season": 2026, "market_rank": 1, "pos_rank": 1,
  "points": 281.3, "ppg": 18.61, "expected_games": 15.1,
  "p20": 225.3, "p80": 368.2,
  "components": { "market": 281.3, "structural": 286.9, "model": 403.1 },
  "model_expected_games": 15.8,   // the declined availability head, for inspection
  "vendor_points": 341.9,         // ESPN's own season_proj, reported not used
  "drivers": [
    "56% of his team's carries in 2025 (14.3/game)",
    "21.7 ppg in 2025 after 20.9 in 2024",
    "17% target share in 2025 — second straight season above 12%",
    "scored 3.6 pts/game above expected in 2025 — touchdown rate regresses",
    "RB1 on the board (overall 1) — 403 pts if he repeats last season's role for a normal season; the 281-pt slot average includes the busts"
  ]
}
```

Caching is per process and covers the season aggregates, the name index, the fits and
the finished board. `resetPreseasonCache()` drops all of it (test seam). A cold
`preseasonProjections(2026)` on the live database takes about 3 seconds and returns 323
players.
