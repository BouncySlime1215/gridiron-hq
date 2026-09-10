# Player engines into TD props — measured, declined

**Verdict: declined. 0 of 3 held-out seasons on anytime TD, 0 of 3 on 2+ TD.
Nothing was promoted, nothing shipped changed.**

## What this tried, and why it was worth trying

`docs/BETTING_PLAYER_ENGINES.md` records the failed attempt to push the fantasy
player engines into *game-level* spread and total lines through
`nfl-team-strength.js` (0/3 and 1/3 seasons significant). That file is untouched
here and that angle was not re-attempted.

The remaining untried cross-wire is **player props**, which is a far more
natural fit: a prop is literally a single player's stat line, and
`nfl-props.js` builds every one of them from raw play-by-play
(`nfl-pbp.js` → `player-week-engine.js`) with no knowledge of a player beyond
his recent snaps. Three engines built for the fantasy side carry exactly the
context it lacks, and none had ever been offered to it:

| block | source | what it is supposed to add |
| --- | --- | --- |
| `career` | `player-career.js` | multi-season TD rate and how *consistent* that rate has been — is a 0.22 a settled role or a hot month |
| `preseason` | `preseason-model.js` | the projected role/points band for season T (ppg, positional rank, expected games) |
| `churn` | `offseason-model.js` | vacated opportunity share, depth-chart movement, team change — the player who *just inherited* a red-zone role, which a year-over-year pbp model reads as a stranger |

Scope was deliberately narrow: the two TD markets (`anytime_td` and `multi_td`),
because that is where `nfl-prop-calibration.js` already exists and already shows
real skill. Yardage markets were not touched.

## How it was measured

- **Harness**: `server/services/nfl-prop-player-heads.js`
  (`walkForwardChallengerTd`, `ablateChallengerTd`), features from
  `server/services/nfl-props-player-features.js`.
- **Rows**: `propReplayRows([2021…2025])`, TD-eligible player-weeks. 13,216 rows;
  2,594–2,648 per held-out season.
- **Baseline**: the shipped policy, run with the shipped code — the same
  `TD_CALIBRATION_HEADS` library and the same `fitHead`, selected by lowest
  training Brier, exactly as `walkForwardTdCalibration` does. `fitHead` was
  exported for this (additively; no behaviour in that file changed) so the
  baseline is the real model and not a lookalike reimplementation.
- **Challenger**: ridge logistic on `[logit(shipped head's probability),
  standardized engine features, 1]`, slope shrunk toward 1 and feature slopes
  toward 0. **Stacking on the shipped head matters**: an earlier form that
  replaced the head with a Platt fit on the raw probability lost significantly
  on 2 of 3 seasons purely because Platt is a worse shape than the isotonic head
  the library picks. That comparison tests head shape, not the engines, so it
  was discarded as unfair before the numbers below were read.
- **Walk-forward**: the head for test season T is fit only on seasons < T, and
  *which* challenger variant runs is chosen on an inner chronological split
  (newest training season held out) — never on T.
- **Significance**: `pairedBootstrapDiff` on per-row squared error, blocked by
  game, 4,000 iterations. Player-weeks from one game share script and weather,
  so unblocked resampling would make every interval too narrow.
- **The bar, stated before any number was read**: a significant Brier
  improvement on **at least 2 of 3** held-out seasons.

## Results

`mean_diff` is challenger − shipped on Brier, so **negative favours the
challenger**; `sig` means the 90% block-bootstrap interval excludes zero.

### Anytime TD (base rate ~0.28)

| season | n | shipped head | shipped Brier | challenger | challenger Brier | mean_diff | ci90 | sig | win |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2023 | 2629 | pos-isotonic-25 | 0.18968 | platt_career | 0.18956 | −0.0001 | [−0.0009, +0.0007] | no | **no** |
| 2024 | 2648 | pos-isotonic-25 | 0.19243 | platt_career | 0.19179 | −0.0006 | [−0.0013, 0.0000] | no | **no** |
| 2025 | 2594 | pos-isotonic-25 | 0.19795 | platt_all | 0.19774 | −0.0002 | [−0.0012, +0.0008] | no | **no** |
| pooled | 7871 | — | 0.19333 | — | 0.19300 | −0.0003 | [−0.0008, +0.0001] | no | **no** |

ECE: 2023 0.0182 vs 0.0172 shipped (worse), 2024 0.0176 vs 0.0192 (better),
2025 0.0230 vs 0.0231 (a tie). Log loss moves in the fourth decimal.

### 2+ TD (base rate ~0.085)

| season | n | shipped Brier | challenger | challenger Brier | mean_diff | ci90 | sig | win |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2023 | 2629 | 0.05541 | platt_only | 0.05538 | 0.0000 | [−0.0002, +0.0001] | no | **no** |
| 2024 | 2648 | 0.06540 | platt_career | 0.06578 | +0.0004 | [0.0000, +0.0007] | yes (**worse**) | **no** |
| 2025 | 2594 | 0.06639 | platt_preseason | 0.06614 | −0.0003 | [−0.0007, +0.0002] | no | **no** |
| pooled | 7871 | 0.06239 | — | 0.06242 | 0.0000 | [−0.0002, +0.0002] | no | **no** |

**0/3 and 0/3. The bar is not cleared on either market.** The single significant
result in the whole table points the wrong way.

### Ablation — did any block carry signal the selection threw away?

Each block against the identical no-feature control, same stacked form, same rows:

| season | career | preseason | churn | all |
| --- | --- | --- | --- | --- |
| anytime 2023 | −0.0002 ns | 0.0000 ns | +0.0002 ns | +0.0003 ns |
| anytime 2024 | **−0.0007 sig** | **−0.0006 sig** | 0.0000 ns | −0.0009 ns |
| anytime 2025 | −0.0003 ns | −0.0002 ns | +0.0001 ns | −0.0003 ns |
| 2+ 2023 | −0.0002 ns | 0.0000 ns | +0.0004 ns | +0.0002 ns |
| 2+ 2024 | +0.0003 ns | **−0.0007 sig** | +0.0004 ns | −0.0002 ns |
| 2+ 2025 | +0.0002 ns | −0.0003 ns | −0.0001 ns | −0.0002 ns |

Three significant cells out of 24 comparisons, all in 2024, none repeating in an
adjacent season — that is what noise looks like at this many comparisons, not a
signal the selection step missed. The **churn block is the clearest failure**:
it was the a-priori best story (the player who just inherited the red-zone role)
and it never once helped, in either market, in any season.

`preseason` shows a mean_diff of exactly 0.0000 in 2023 because
`preseasonProjections` needs 2022 as a training season, so no 2021–2022 training
row has a preseason feature; the block is entirely missing in that fit and
correctly collapses to the control instead of inventing a value.

## Why the honest read is "no"

The gap is real but it is *tiny*. The pooled anytime-TD improvement is 0.0003 of
Brier on 7,871 rows and its interval covers zero. The shipped head already
routes through position-scoped isotonic regression, which is a flexible enough
map from raw probability to calibrated probability that a season-level context
feature has very little left to explain — and season-level is all these engines
can honestly give. A feature that is constant across all 17 of a player's weeks
cannot separate the two 0.22s the idea was meant to separate; whatever it knows
about him is largely already priced into the trailing usage the raw model sees.

That is a limitation of the data, not a fixable bug, and it is the same story
the team-strength attempt told: these engines are season-shaped, and both prices
being asked about are week-shaped.

## What was changed and what was not

Added (research-only, nothing wired into production):
- `server/services/nfl-props-player-features.js`
- `server/services/nfl-prop-player-heads.js`
- `test/nfl-prop-player-heads.test.js`

Changed: one word in `server/services/nfl-prop-calibration.js` — `fitHead` is now
exported, so the baseline is fit by the shipped code. No behaviour there changed.

**Untouched**: `calibrateAnytimeTd`, the active calibration fit, `nfl-props.js`,
`nfl-team-strength.js`, and every fantasy/draft/trade/lineup file. The
evaluation persists no calibration fit; a test asserts both that `nfl-props.js`
does not import either new module and that the harness writes no fit row.

## Governance

`recordChallengerGateAudit` filed the result through `model-governance.js` for
the `player_props` contract as model version
`player-head-registry-v1-engine-context`. Every gate is recorded as failed and
the audit's verdict is **`blocked`**; `promoteEligibleAudit` refuses anything
that is not `promotion_eligible`, so this is provenance and cannot promote
anything. The registry is unchanged: challenger `player-head-registry-v1`
remains `research_only`, champion `shared-event-structural-v1` remains
`baseline`.

**The forward-CLV gate was recorded as failed, not as "not applicable."** It is a
claim about real prop quotes captured before kickoff and settled afterwards, and
no backtest can supply it. Even if the accuracy and calibration gates had passed,
this work would have stopped short of full promotion for that reason alone — the
live prop quote table has 0 settled TD bets so far this season. That is stated
here so nobody later reads a passing backtest as a promotion.

## If someone picks this up again

The one thing that would change the answer is a **weekly** version of the churn
signal — red-zone role that moves when a starter goes out in week 6, not one
frozen in August. That is a different feature from anything these three engines
produce today and would need its own pre-kickoff snapshot to stay contract-legal.
Refitting the same season-level features with a bigger ridge, more variants, or
more test seasons will not rescue a 0.0003 Brier gap; it will only give the
search more chances to find a 2024.
