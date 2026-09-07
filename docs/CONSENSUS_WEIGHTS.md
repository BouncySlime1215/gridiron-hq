# Season-long consensus weights: fitted inverse-variance vs. the hand-set 2:1

**Result: DECLINED.** Fitted inverse-variance weights did not beat the hand-set
multiplier in any held-out season (0 of 3, bar was ≥2 of 3). `computeConsensus()`
in `server/routes/aggregates.js` is **unchanged**.

Harness: `server/services/consensus-weights.js`. Tests:
`test/consensus-weights.test.js`. Run: `consensusWeightsWalkForward()`.

## The question

`computeConsensus()` blends three preseason sources into one draft order by
averaging their ordinal ranks with a hand-set multiplier:

| source | live weight | where it comes from |
|---|---|---|
| ESPN ADP (`espn_player_market`) | **2** | ESPN's own board, per league |
| FFC ADP (`player_metrics`, `ffc_adp`) | 1 | FantasyFootballCalculator public API |
| Sleeper `search_rank` (`player_metrics`) | 1 | Sleeper public API |

Nothing fitted that 2. `gridiron-model.js`'s header states the correct rule for
combining several estimators of one quantity — inverse-variance weighting,
`w ∝ 1/σ²` — and `fantasy-coordinator.js` already does the fitted-weight version
for the **weekly** projection. The season-long side never got it. This is that
attempt.

## Finding 1: two of the three sources cannot be fitted at all

Measured, not assumed (`sourceHistoryCoverage()`):

| source | live weight | historical seasons | fittable |
|---|---|---|---|
| ESPN ADP | **2** | **0** | no — `espn_player_market` holds one current-season row per `espn_id` (400 rows, season 2026), overwritten on every sync. ESPN publishes no preseason-ADP archive. |
| Sleeper rank | 1 | **0** | no — `player_metrics` holds one live `search_rank` per player (1,632 rows), overwritten on every sync. Sleeper's API serves no historical board. |
| FFC ADP | 1 | **5** (2021–2025) | yes — FFC's public API takes a `year` parameter and really does serve past seasons. |

So the multiplier under test attaches to the one source whose error is
*unmeasurable*. A three-source inverse-variance fit is not constructible from
anything this app has or can get. Fitting on the single source with history and
calling the output "fitted consensus weights" would be a mis-fit dressed as a
validation.

FFC's history was ingested as part of this work (`syncFfcAdpHistory()`, table
`nfl_historical_ffc_adp`, kept separate from `nfl_historical_adp` for the same
reason `historical-adp-scrapes.js` keeps its tape separate). Every draft window
closes before its season's Week 1, so no board is graded on partly-known
outcomes:

| season | players | ADP window |
|---|---|---|
| 2021 | 211 | 2021-08-31 → 09-01 |
| 2022 | 157 | 2022-09-03 → 09-04 |
| 2023 | 202 | 2023-08-30 → 09-01 |
| 2024 | 205 | 2024-08-31 → 09-01 |
| 2025 | 249 | 2025-08-25 → 09-01 |

## What was testable instead, and the substitution

The 2021–2025 audit panel already carries a second preseason board with full
history: FantasyPros ECR (`nfl_historical_adp`, `dynastyprocess_fpecr`) — the
same rank `docs/DRAFT_AUDIT_2021_2025.md` and `preseason-model.js` grade against.
FPECR + FFC ADP is exactly the two-boards-with-a-multiplier structure
`computeConsensus()` faces, with five seasons of realized outcomes behind both.

**FPECR stands in for ESPN as the weight-2 source.** That is a substitution and
it is why nothing here ships. A result about FPECR-vs-FFC is evidence about the
*method*, not proof about ESPN. What it can settle: if inverse-variance weights
cannot beat a hand-set multiplier even where both sources' errors *are*
measurable, there is no basis for replacing one whose sources' errors are not.

**Method** (reused from `preseason-model.js`, not reinvented): each source's
positional rank → predicted season points via `fitMarketCurve` (local-linear
rank→points, bandwidth 9, fitted on training seasons only), graded against
`seasonTotals` (the play-by-play PPR totals the audit validated at r=0.9987 vs
ESPN's own season totals). Error = |predicted − actual| per player, the same MAE
the preseason walk-forward reports. `pairedBootstrapDiff`, 2,000 iterations,
clustered by NFL team within the held-out season (matching
`draft-abstention-audit.js`). Panel = the intersection of both boards
(142–204 players/season; 0–4 FFC names unmatched, reported not guessed).

Matching `fantasy-coordinator.js`'s discipline: walk-forward split (weights and
curve fitted only on seasons < T), shrinkage toward the incumbent
(λ = n/(n+120)), per-source caps (no source below 20% or above 80% of the
blend), and per-position cells under 40 training rows held at the hand-set
weights rather than fitted on nothing.

## Finding 2: the fitted weights are a wash

Fixed-curve arm — the decision (see Finding 3):

| T | n | hand-set MAE | fitted MAE | Δ | 90% CI | p | significant |
|---|---|---|---|---|---|---|---|
| 2023 | 174 | 66.913 | 66.984 | +0.071 | [−0.012, +0.150] | 0.917 | no |
| 2024 | 178 | 75.536 | 75.532 | −0.004 | [−0.142, +0.143] | 0.493 | no |
| 2025 | 204 | 90.219 | 90.268 | +0.049 | [−0.107, +0.218] | 0.715 | no |

**0 of 3.** Every difference is under 0.08 fantasy points on a 67–90 point MAE —
under 0.1%. Spearman vs. realized points is likewise flat (2023 0.4913 → 0.4920,
2024 0.4781 → 0.4735, 2025 0.4888 → 0.4869).

The fitted weights themselves are sane and do what inverse-variance weighting
should — they just have nothing to find. The two sources' measured per-position
RMSE are near-identical, e.g. fitted through 2024: WR 67.25 vs 67.57, RB 72.44 vs
72.96, QB 89.81 vs 89.93, TE 57.29 vs 58.10. Equal error ⇒ `1/σ²` says roughly
50/50, so the fit points *away* from 2:1 toward parity (expert share 0.55–0.62
after shrinkage vs the incumbent 0.667) — and even that barely moves the board:
**mean rank shift 0.63 / 1.24 / 1.67 slots** (max 5 / 8 / 9) across 2023/24/25.

## Finding 3: the weighting cannot matter, and a naive harness will say it does

The root cause is upstream of any weighting scheme. The two boards agree almost
completely:

| season | n | Spearman(expert, FFC) | median rank gap | mean gap | max gap |
|---|---|---|---|---|---|
| 2021 | 179 | 0.9524 | 8 | 11.7 | 47 |
| 2022 | 142 | 0.9654 | 5 | 7.6 | 53 |
| 2023 | 174 | 0.9816 | 5 | 6.8 | 55 |
| 2024 | 178 | 0.9562 | 10 | 11.8 | 61 |
| 2025 | 204 | 0.9513 | 10 | 13.3 | 84 |

At ρ ≈ 0.95–0.98, *no* mixture of the two produces a materially different board.
Swinging the weights from 2:1 all the way to 1:2 moves the average player 2.8–5.1
slots. There is no room for a weighting scheme to earn anything, fitted or
hand-set. This is also why inverse-variance weighting is on shaky ground here in
principle: it assumes independent estimators, and two preseason boards reading
the same news are anything but.

**The methodological trap.** The first version of this harness refit the
rank→points grading curve on each candidate's own training ordering — defensible,
since a candidate is a whole system. Under that grading, alternatives to 2:1
looked *significantly better*:

| candidate vs. 2:1 | 2023 | 2024 | 2025 |
|---|---|---|---|
| equal 1:1 | −0.349 **sig** | −0.130 ns | −0.693 **sig** |
| FFC-heavy 1:2 | −0.687 **sig** | −0.062 ns | −0.712 **sig** |
| expert-only 1:0 | −0.611 **sig** | −0.495 ns | −0.013 ns |

Read naively, equal weighting clears the ≥2-of-3 bar. But so does 1:2, and 1:0
nearly does — **mutually contradictory directions cannot all be improvements**. A
weighting is not made better by moving toward *and* away from a source at once.

Holding the grading curve fixed (grade every candidate through the incumbent's
curve, so only the board order differs) collapses all of it:

| candidate vs. 2:1, fixed curve | 2023 | 2024 | 2025 |
|---|---|---|---|
| equal 1:1 | +0.114 ns | −0.153 ns | +0.087 ns |
| FFC-heavy 1:2 | +0.177 ns | −0.043 ns | +0.042 ns |
| expert-only 1:0 | −0.499 **sig** | −0.280 ns | +0.094 ns |
| Sleeper-slot-only 0:1 | +0.200 ns | +0.080 ns | +0.116 ns |

The apparent significance was the **curve refit** moving the MAE, not the board
order. `consensusWeightsWalkForward()` therefore reports both arms — `own_curve`
is kept only so the artifact stays visible rather than being quietly dropped —
and the decision is read off `fixed_curve`.

## Decision

Keep the hand-set weights. `computeConsensus()` is untouched.

The honest statement of what the 2x is: an **unvalidated** knob that this work
could not validate and could not refute, on a blend where the choice of weight
demonstrably does not move the board more than a couple of draft slots. Being
more principled and being better are different claims, and only the second one
justifies changing a live board.

What would change the answer — in order of how much it would actually buy:

1. **A source that genuinely disagrees.** The binding constraint is ρ ≈ 0.96
   between boards, not the weighting rule. Two more expert boards weighted
   perfectly would still land within a few slots of today's order. A source with
   real orthogonal information (a projection system, not another consensus
   scrape) is worth far more than any reweighting of these.
2. **Snapshotting ESPN ADP and Sleeper rank per season, now.** Both are
   overwritten in place on every sync, so today's board is unrecoverable
   tomorrow. Archiving them (the pattern `historical-adp.js` and
   `nfl-external-ratings.js` already use) makes the real three-source question
   answerable in ~3 seasons. It cannot be backfilled — the only way to have that
   data later is to start keeping it now.
3. Re-running this harness once ≥3 seasons of real ESPN/Sleeper snapshots exist,
   with FPECR dropped and the actual live sources in its place.
