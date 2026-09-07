# Consulting the player-level engines into the NFL betting model

**Status: measured, failed, blocked. The champion is untouched.**
**Date: 2026-09-07.**

This documents one bounded experiment: does anything the fantasy-side player
engines know — preseason projections, offseason opportunity churn, QB1 context —
reduce the NFL market model's held-out error once aggregated to the team level?

The answer is no, on both markets. The numbers are below so the next person to
have this idea can read them instead of rebuilding it.

---

## 1. Why it was built the way it was

`docs/OFFSEASON_MODEL.md` §6 already anticipated this request and set the terms.
This work implements those terms rather than reinterpreting them:

| §6 rule | How it is enforced here |
|---|---|
| Team-level aggregates only; player multipliers never reach a market model | `nfl-team-strength.js` exposes six team columns and no per-player API |
| Register a feature contract in `model-governance.js`, start `blocked` | Two contracts (`NFL/spread`, `NFL/total`), key `team_strength_aggregate` |
| Nothing market-derived comes along | `implied_team_points` / `implied_points_delta` excluded; a test asserts it |
| Expected value of the promotion is zero | Confirmed. See §4 |

The last row matters most. This was not built expecting it to work. The project
has no demonstrated edge against closing lines (`PATH_TO_PROFIT`,
`gridiron-nfl-betting-model`), and an offseason feature is the most public
information that exists — every book has the same depth chart. It was built so
the idea gets tried *inside* the gate, once, with the result written down.

---

## 2. The features

`server/services/nfl-team-strength.js`, `teamStrength(season)` → `Map<team, row>`,
seasons 2021–2026, 32 teams each.

| Column | Source | Meaning |
|---|---|---|
| `proj_off_points` | `preseason-model.js` `preseasonProjections(T)` | Sum of season projections for the starting QB1/RB2/WR3/TE1 |
| `vacated_opportunity_share` | `offseason-model.js` `teamOffseasonSummary(T)` | Share of T−1 targets+carries+attempts that left the building |
| `returning_points_share` | `offseason-model.js` `seasonAggregate(T−1)` | Share of T−1 PPR points still on the roster, split across teams by opportunity for traded players |
| `qb1_change` | `teamOffseasonSummary(T)` | New Week 1 starter vs T−1 |
| `qb1_qbr_delta` | `off_team_season.qb_qbr_delta` | T−1 QBR of the incoming starter minus T−1 QBR of the outgoing one |
| `qb1_proj_ppg_delta` | `preseasonProjections(T)` vs `(T−1)` | QB1's projected PPG year over year |

They enter the GBM as **home-minus-away differentials**, matching the existing
feature style.

### No look-ahead

Every column is computable before Week 1 of season T. Team assignment comes from
`rosterAtSeasonStart(T)` (Week 1 depth chart 2021–2025, dated roster snapshot for
2026 — a test asserts no evaluated season fell back to season-T usage). The
preseason fit is trained on seasons strictly before T. Churn and returning
production are measured against T−1. The QBR delta is a backward-looking
difference between two forward-looking identities.

Leakage risk is nonetheless declared **high** in the contract, honestly:
`rosterAtSeasonStart` has a season-T usage fallback for players with no depth row
at all. `teamStrengthCoverage()` reports the source per season so it stays
visible.

### Coverage, including the gap

| Season | roster source | `proj_off_points` | `vacated_opp_share` | `returning_pts_share` | `qb1_change` | `qb1_qbr_delta` | `qb1_proj_ppg_delta` |
|---|---|---|---|---|---|---|---|
| 2021 | depth | 0 | 32 | 32 | 32 | 0 | 0 |
| 2022 | depth | 0 | 32 | 32 | 32 | 26 | 0 |
| 2023 | depth | 32 | 32 | 32 | 32 | 21 | 0 |
| 2024 | depth | 32 | 32 | 32 | 32 | 19 | 28 |
| 2025 | depth | 32 | 32 | 32 | 32 | 21 | 30 |
| 2026 | roster_snapshot | 32 | 32 | 32 | 32 | 27 | 28 |

`preseason-model.js` fits only on graded seasons from 2022 onward, so 2021–2022
have no projection-backed column. That is a real limit, asserted in a test rather
than smoothed over. Missing values shrink to the league prior — which, being the
same for both teams, differences to exactly zero.

### One join bug found on the way

`off_team_season` files the Rams under `LA` while `game_lines`, the depth charts
and `teamOffseasonSummary` all use `LAR`. Unmapped, this produced a phantom 33rd
team and stranded the Rams' QB1 QBR delta on a code no game row ever matches —
appearing as a harmless null rather than an error. Fixed with
`canonicalTeamCode` on both sides; regression-tested.

---

## 3. How it was evaluated

`teamStrengthWalkForward({ market })` in the same file.

- **Champion**: the existing `nfl-gbm.js` residual model, 36 features.
- **Challenger**: the identical model class, identical hyperparameters,
  identical seed, identical training games — plus the six columns. The *only*
  difference is the features, so the comparison isolates them rather than tuning.
- **Target**: the residual, not the outcome. Spread = actual margin minus
  market-implied margin. Total = actual combined points minus the closing total.
  A model predicting the outcome can look excellent by copying the line.
- **Walk-forward**: each test season is predicted by a fit trained only on
  earlier ones.
- **Significance**: `pairedBootstrapDiff` on the same games in the same order,
  **block-resampled by week** — games in a week share weather, byes and market
  conditions, and per-game resampling would report an interval narrower than the
  truth (the failure mode `backtest-significance.js` documents).

**The bar, stated before the numbers were seen**: a significant reduction in
held-out MAE on **≥ 2 of 3** walk-forward seasons. One season is a coin flip
dressed up as evidence.

The `extraFeatures` hook in `buildGbmDataset` is injected, not imported, so
`nfl-gbm.js` holds no reference to the challenger. With it unset the champion's
panel is byte-identical to what it was — asserted directly in the tests.

---

## 4. Results

Lower MAE is better. `delta` is challenger minus champion, so **negative =
challenger better**. `market_mae` is the error of simply predicting zero
residual — the closing line itself.

### Spread — 2211 games, 285 per test season

| Season | market MAE | champion | challenger | delta | 90% CI | significant? |
|---|---|---|---|---|---|---|
| 2023 | 9.98 | 10.12 | 10.14 | +0.0218 | [−0.0586, +0.0990] | no |
| 2024 | 9.70 | 9.80 | 9.84 | +0.0341 | [−0.0805, +0.1408] | no |
| 2025 | 9.67 | 9.61 | 9.62 | +0.0036 | [−0.0999, +0.0959] | no |
| **pooled** | — | **9.84** | **9.86** | **+0.0198** | **[−0.0379, +0.0746]** | **no** |

**0 of 3 seasons.** Fails the bar.

### Total — 2211 games, 285 per test season

| Season | market MAE | champion | challenger | delta | 90% CI | significant? |
|---|---|---|---|---|---|---|
| 2023 | 10.17 | 10.28 | 10.26 | −0.0140 | [−0.0885, +0.0667] | no |
| 2024 | 9.77 | 9.92 | 9.83 | −0.0890 | [−0.1533, −0.0281] | **yes** |
| 2025 | 10.42 | 10.41 | 10.47 | +0.0567 | [−0.0213, +0.1343] | no |
| **pooled** | — | **10.20** | **10.19** | **−0.0154** | **[−0.0590, +0.0267]** | **no** |

**1 of 3 seasons.** Fails the bar.

2024 is the one honest-looking result in the table, and it is exactly what the
≥2-season rule exists to absorb: the effect reverses sign in 2025, and pooling
all 855 test games puts the interval across zero. Promoting on 2024 alone would
be picking the season that agreed.

### The result behind the result

Note the `market_mae` column. In five of six season-market cells the **champion
itself loses to predicting zero** — the closing line is more accurate than the
model trying to correct it. The team-strength block is not failing to improve a
winning model; it is failing to improve a model that does not beat the market in
the first place. This reproduces `gridiron-nfl-betting-model`'s standing finding
rather than contradicting it.

---

## 5. What was recorded, and what was not

`recordTeamStrengthGate({ market })` files an immutable gate audit per market via
`recordGateAudit`. Four gates, all **failed**:

| Gate | Result |
|---|---|
| `walk_forward_accuracy` (≥2 of 3 seasons) | fail — 0/3 spread, 1/3 total |
| `pooled_improvement` (pooled CI excludes zero) | fail — both straddle zero |
| `beats_market_baseline` | fail — challenger loses to the closing line |
| `forward_clv` | fail — no frozen forward sample exists, and none was manufactured retrospectively |

Verdict for both markets: `blocked`.

Filing a *negative* result through the gate is the point. `recordGateAudit`
computes the verdict itself and `promoteEligibleAudit` throws on anything that is
not `promotion_eligible`, so this cannot become a promotion by accident — and
"we measured this and it did not clear the bar" becomes a durable hashed record
instead of an idea re-proposed every offseason.

**Not changed:**

- `model_registry` — spread and total champions remain `market-consensus-v1`.
  Verified after the run.
- The champion GBM panel, feature set, and every published GBM number.
- Any fantasy, draft, trade, or lineup file.

---

## 6. If someone picks this up again

The productive direction is *not* better team aggregates. The ceiling here is set
by the closing line, and the closing line already prices the depth chart. Three
things would have to change before this is worth rerunning:

1. **A market the books price lazily.** Season win totals or team season totals
   are set in May off the same public roster news, but they are re-priced far
   less often than a weekly spread.
2. **Information the book does not have.** Everything in §2 is public. The
   offseason model's edge is in *combining* public facts for fantasy purposes,
   which is a different job from finding something the market missed.
3. **A forward sample.** Even a passing backtest could not clear `forward_clv`,
   which no retrospective analysis can satisfy by construction.

Absent all three, the expected value remains zero, and §6 of
`OFFSEASON_MODEL.md` already said so.

---

## 7. Files

| File | Role |
|---|---|
| `server/services/nfl-team-strength.js` | new — aggregates, GBM hook, walk-forward, gate recorder |
| `test/nfl-team-strength.test.js` | new — 12 tests |
| `server/services/model-governance.js` | +2 feature contracts |
| `server/services/nfl-gbm.js` | `extraFeatures` hook + `total` on meta; champion path unchanged |
