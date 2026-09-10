# Weekly-grain player context into TD props — measured, declined

**Verdict: declined. 0 of 3 held-out seasons on anytime TD, 0 of 3 on 2+ TD.
Nothing was promoted, nothing shipped changed.**

This is the **redo** of `docs/PROPS_PLAYER_ENGINES.md`, not a second reading of
it. That attempt was declined 0/3 and 0/3 and diagnosed its own failure as a
methodology limit rather than a verdict on the idea:

> A feature that is constant across all 17 of a player's weeks cannot separate
> the two 0.22s the idea was meant to separate.

That is true by construction — a season-level constant has zero within-player
variance, so it can move a player's whole season but can never explain why his
week 9 differs from his week 3, which is the only thing a per-game prop price
asks. The test never had a fair chance. This run gives it one.

## What is actually different

Every feature here varies week to week within a player-season, and that claim is
measured rather than asserted. `weeklyVarianceReport(2024)` over 434 player-
seasons with ≥4 weeks, share of player-seasons in which the feature takes more
than one value:

| feature | varies in |
| --- | --- |
| `wk_rz_opp_recent` (trailing-3 red-zone opportunities) | 91.9% |
| `wk_rz_opp_trend` (trailing-3 minus season-to-date) | 88.0% |
| `wk_gl_opp_trend` (goal-line / goal-to-go / end-zone) | 78.6% |
| `wk_opp_share_trend` | 93.1% |
| `wk_td_rate_trend` | 70.3% |
| `wk_early_weight`, `wk_opp_rz_td_rel` | 100% |
| `wk_new_role_vacated` (churn × early-week decay) | 69.8% |

The season-level features scored 0% on this measure by definition. The
missing-indicators are flat within a player-season, which is correct — whether a
player is on the offseason panel does not change in October.

Three blocks, in `server/services/nfl-props-player-features-weekly.js`:

| block | what it is | why |
| --- | --- | --- |
| `trend` | trailing-3-game red-zone / goal-line / opportunity-share / TD rate **minus** his season-to-date rate, from `nfl-pbp.js` weekly rows | the literal thing the first attempt's closing paragraph asked for: "red-zone role that moves when a starter goes out in week 6, not one frozen in August" |
| `newrole` | `offseason-model.js` churn (vacated share, depth-rank delta, team change) **interacted** with a fixed decay over weeks 2–5 | the theory the season-level test could not express: a real August role change is most mispriced before the market has games to see it in. The churn number is season-level; the feature is not, because the weight on it moves every week |
| `matchup` | opponent red-zone TDs allowed per red-zone opportunity faced, prior seasons + prior weeks, shrunk to league | carried **warily** — see below |

### The documented failure this did not repeat blind

`nfl-opponent.js`'s header records that opponent adjustment made weekly *stat*
predictions monotonically **worse** — passing-yards MAE 70.56 at weight 0 rising
to 90.81 at weight 1 — through double counting: `gameScriptFor` already moves
volume with the betting line, and the line already prices the opponent. The
probability being calibrated here is built from that same game-script-adjusted
volume, so the risk transfers.

It was neither ignored nor assumed away. `matchup` is **quarantined into its own
ablation arm** and excluded from `weekly_core`, so its effect is a measured
number instead of a hidden contribution to an all-features variant. The answer
(table below): it is noise here, not a monotonic disaster — one significant
help in 2023 anytime, one non-significant hurt in 2024 — but it never helps
twice and it is the block the selector picked in the one season the challenger
lost significantly.

## How it was measured

Identical discipline to the first attempt, deliberately, so the two results are
comparable:

- **Harness**: `server/services/nfl-prop-player-weekly-heads.js`
  (`walkForwardWeeklyChallengerTd`, `ablateWeeklyChallengerTd`).
- **Rows**: `propReplayRows([2021…2025])` → 24,018 replay rows, 7,871 TD-eligible
  player-weeks across the three held-out seasons (2,594–2,648 each).
- **Baseline**: the shipped policy run by the shipped code — the same
  `TD_CALIBRATION_HEADS` library, the same `fitHead`, the same lowest-training-
  Brier selection `walkForwardTdCalibration` performs. `pos-isotonic-25` won on
  every season.
- **Challenger**: ridge logistic on `[logit(shipped head's probability),
  standardized weekly features, 1]`, slope shrunk toward 1 and feature slopes
  toward 0. **Stacked on the shipped head**, for the same reason as last time:
  an earlier Platt-instead-of-isotonic form lost on head *shape* rather than on
  features, and that comparison was correctly discarded as unfair.
- **Walk-forward**: the head for test season T is fit only on seasons < T, and
  *which* variant runs is chosen on an inner chronological split (newest
  training season held out) — never on T.
- **Leak guard**: `assertNoTargetWeekLeak` re-derives every player-week's
  trailing red-zone mean from the raw weekly rows with the target week excluded
  and requires an exact match. 5,313 rows checked in 2024, 0 leaks.
- **Significance**: `pairedBootstrapDiff` on per-row squared error, blocked by
  game, 4,000 iterations.
- **The bar, stated before any number was read**: a significant Brier
  improvement on **at least 2 of 3** held-out seasons.

## Results

`mean_diff` is challenger − shipped on Brier, so **negative favours the
challenger**. `exact` is the unrounded difference, because the bootstrap rounds
to four decimals and the gaps here live in the fifth.

### Anytime TD (base rate 0.281–0.291)

| season | n | chosen variant | shipped Brier | challenger Brier | exact diff | ci90 | sig | win |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2023 | 2629 | `platt_only` | 0.18968 | 0.18974 | +0.000057 | [0.0000, +0.0001] | no | **no** |
| 2024 | 2648 | `weekly_matchup` | 0.19243 | 0.19268 | +0.000252 | [0.0000, +0.0005] | yes (**worse**) | **no** |
| 2025 | 2594 | `weekly_core` | 0.19795 | 0.19805 | +0.000097 | [−0.0006, +0.0008] | no | **no** |
| pooled | 7871 | — | 0.19333 | 0.19347 | +0.000136 | [−0.0001, +0.0004] | no | **no** |

ECE is worse on all three: 0.01719→0.01825, 0.01922→0.02188, 0.02314→0.02467.

### 2+ TD (base rate 0.075–0.093)

| season | n | chosen variant | shipped Brier | challenger Brier | exact diff | ci90 | sig | win |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2023 | 2629 | `weekly_newrole` | 0.05541 | 0.05580 | +0.000386 | [0.0000, +0.0008] | no | **no** |
| 2024 | 2648 | `weekly_matchup` | 0.06540 | 0.06550 | +0.000099 | [−0.0001, +0.0003] | no | **no** |
| 2025 | 2594 | `platt_only` | 0.06639 | 0.06645 | +0.000068 | [0.0000, +0.0001] | yes (**worse**) | **no** |
| pooled | 7871 | — | 0.06239 | 0.06257 | +0.000184 | [0.0000, +0.0003] | yes (**worse**) | **no** |

**0/3 and 0/3.** Every point estimate in both tables is positive — the wrong
direction — and all three significant results point against the challenger,
including the pooled 2+ TD result.

### Ablation — did any block carry signal the selection threw away?

Each block against the identical no-feature control, same stacked form, same
rows. Negative favours the block.

| | 2023 | 2024 | 2025 |
| --- | --- | --- | --- |
| **anytime** `weekly_trend` | +0.0006 ns | **−0.0007 sig helps** | −0.0001 ns |
| **anytime** `weekly_newrole` | +0.0003 ns | −0.0001 ns | +0.0002 ns |
| **anytime** `weekly_matchup` | **−0.0001 sig helps** | +0.0002 ns | 0.0000 ns |
| **anytime** `weekly_core` | **+0.0009 sig HURTS** | **−0.0009 sig helps** | 0.0000 ns |
| **anytime** `weekly_all` | +0.0008 ns | **−0.0007 sig helps** | −0.0001 ns |
| **2+** `weekly_trend` | 0.0000 ns | +0.0002 ns | 0.0000 ns |
| **2+** `weekly_newrole` | **+0.0004 sig HURTS** | +0.0003 ns | 0.0000 ns |
| **2+** `weekly_matchup` | −0.0001 ns | 0.0000 ns | −0.0001 ns |
| **2+** `weekly_core` | +0.0003 ns | +0.0003 ns | +0.0002 ns |
| **2+** `weekly_all` | +0.0002 ns | +0.0005 ns | +0.0001 ns |

Seven significant cells out of 30 comparisons, split four helps / three hurts,
and **`weekly_core` is significantly helpful and significantly harmful in
adjacent seasons of the same market**. Nothing repeats in the same direction in
two consecutive seasons. That is what noise looks like at this many comparisons.

Two things are worth naming rather than glossing:

1. **Every anytime-TD "help" is in 2024**, which is also where the season-level
   attempt found its only significant cells. Two independent feature sets both
   finding their stray significance in the same season is better explained by
   2024 being an unusually forgiving test season than by either feature set
   working.
2. **The selector chased that noise.** In 2024 anytime it picked
   `weekly_matchup` on the inner split and then lost significantly on the test
   season — a clean, small demonstration of why the inner split exists and why
   the headline table, not the ablation, is the number that counts.

## Why the honest read is "no" — and what it now tells us

The first attempt's diagnosis was that the features were the wrong *grain*. That
diagnosis has now been tested and it does **not** rescue the idea. Weekly-grain
features that genuinely move week to week — verified, not assumed — do no better
than season-level constants did, and by point estimate slightly worse.

The obvious next explanation would be redundancy — that `nfl-props.js` builds
`p` from trailing weekly usage, so the trend is already inside `p` and handing
it over again adds nothing. **That explanation was checked, and it is only half
right.** Pearson correlation of each feature with `logit(p)` on the 7,871
held-out rows:

| feature | r with `logit(p)` |
| --- | --- |
| `wk_rz_opp_recent` (level) | 0.320 |
| `wk_td_rate_recent` (level) | 0.290 |
| `wk_gl_opp_recent` (level) | 0.277 |
| **`wk_rz_opp_trend`** (the hypothesis) | **0.043** |
| **`wk_opp_share_trend`** | **0.058** |
| `wk_new_role_vacated` | 0.036 |
| `wk_opp_rz_td_rel` | 0.002 |

The *levels* are redundant, as expected — `p` already knows how much red-zone
work a player has been getting. But the **trends are nearly orthogonal to `p`**
(r ≈ 0.04–0.06). They are genuinely new information that the shipped model does
not have. And they still bought nothing.

That makes this a stronger and less comfortable null than the redundancy story
would have been. It is not that the trend was already priced. It is that
**within-season direction of red-zone role appears to carry essentially no
incremental information about whether a player scores this week, beyond the
level of that role**. A player whose goal-line share rose from 2 to 5 over three
weeks scores at about the rate his current share implies, not at a premium to
it. The first attempt's closing paragraph predicted that a weekly churn signal
"would change the answer." It was a reasonable prediction, it has now been
built, and it did not.

So the season-level diagnosis does **not** extend to weekly grain — it is simply
superseded. The gap the first attempt blamed has been closed and the result did
not move, which means the grain was never the binding constraint.

## What was changed and what was not

Added (research-only, nothing wired into production):
- `server/services/nfl-props-player-features-weekly.js`
- `server/services/nfl-prop-player-weekly-heads.js`
- `test/nfl-prop-player-weekly-heads.test.js`

Changed: three additive rows in `server/services/model-governance.js`'s
`CONTRACTS` (`weekly_role_trend`, `early_season_role_change`,
`opponent_red_zone_defense`). No behaviour changed there.

**Untouched**: `nfl-props-player-features.js` and `nfl-prop-player-heads.js`
(the first attempt, left exactly as it recorded its own result),
`calibrateAnytimeTd`, the active calibration fit, `nfl-props.js`,
`nfl-opponent.js`, `nfl-team-strength.js`, and every fantasy/draft/trade/lineup
file. The evaluation persists no calibration fit; a test asserts both that
`nfl-props.js` imports neither new module and that the harness writes no fit row.

## Governance

`recordWeeklyChallengerGateAudit` filed the result through
`model-governance.js` for the `player_props` contract as model version
**`player-head-registry-v1-weekly-context`** — deliberately distinct from the
first attempt's `player-head-registry-v1-engine-context`, which is untouched, so
the redo is a second record rather than an overwrite of the first. Audit #4, all
five gates recorded failed, verdict **`blocked`**. `promoteEligibleAudit` refuses
anything that is not `promotion_eligible`. The registry is unchanged: challenger
`player-head-registry-v1` remains `research_only`, champion
`shared-event-structural-v1` remains `baseline`.

**The forward-CLV gate was again recorded as failed, not as "not applicable."**
It is a claim about real prop quotes captured before kickoff and settled
afterwards, and no backtest can supply it. Even had the accuracy gates passed,
this would have stopped short of promotion for that reason alone.

## If someone picks this up again

Do not run this a third time at a fourth grain. Two attempts have now failed in
the same place with features that differ in exactly the way the first failure
said mattered, and the correlation table shows the second attempt's features
were genuinely new information rather than a restatement of `p`. There is no
third grain left to blame.

If anything survives, it is a **different question**, not a finer version of
this one. `wk_rz_opp_trend` is nearly orthogonal to `p` and worthless for TD
probability — but orthogonal-and-worthless for one target does not mean
worthless for another. The natural place to spend that finding is the weekly
*yardage* and *reception* markets, or the fantasy weekly ensemble, where role
direction plausibly matters more than it does for a binary that is dominated by
goal-line volume. That is a separate hypothesis and deserves its own pre-stated
bar rather than being smuggled in as "the same idea, one more time."
