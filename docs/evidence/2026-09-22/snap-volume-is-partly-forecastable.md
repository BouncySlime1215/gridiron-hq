# Snap volume is partly forecastable: about a seventh of the ceiling, not none

**Source label, and it governs every figure below: PROXY — nflverse snap counts
and weekly stats, not the production pipeline.** Nothing here speaks to the
4.749/4.773 weekly-MAE metric, and nothing here is a claim about what the
shipped model would gain.

Data & techniques R&D measured that knowing a player's coming-week snap count is
worth a large slice of weekly target error, and that forecasting it from the
last three weeks captures **none** of that advantage. The second half is the
part worth re-testing, because "the signal exists but is unreachable" and "the
signal exists and is partly reachable" imply different work.

**It is partly reachable.** A trailing EWMA captures **14.1%** of the ceiling on
2022-2025 and **13.7%** on 2018-2021 — two halves of the data that never saw
each other, agreeing to four tenths of a percentage point. R&D's own three-week
stand-in captures 9.2% and 8.7%, which is also not zero.

---

## 1. The question, narrowed

Not "build a snap-share forecast". The prior result already says a forecast is
worth building only if snap volume carries signal a trailing target average does
not already have. So: **predict week W's targets, varying only how week W's snap
count is estimated**, and see how much of the hindsight gap a causal estimate
recovers.

A negative here would have been as useful as a positive — it would have said the
ceiling is permanently out of reach rather than merely unclaimed.

## 2. Population, and the absences that have to be in it

54,918 player-weeks over 4,355 player-seasons, 2018-2025 REG, WR/TE/RB,
crosswalked `pfr_id → gsis_id` through `players.csv` (22,665 pairs).

**7,206 of those rows — 13.1% — are weeks a player did not appear**, restored at
0 snaps and 0 targets. This is the correction R&D had to make to its own first
pass, and it is not a detail: keeping only weeks with at least one snap deletes
exactly the variance a snap forecast would have to predict, and flatters every
arm that cannot predict absence.

A player-season's universe is every week **his team played** between his first
and last appearance that season. That excludes team byes, and it does not invent
weeks before he arrived or after he left.

## 3. Design

- **Purged walk-forward.** Week W is predicted from weeks 1..W−1 of the same
  season only, W ≥ 5, minimum three prior weeks.
- **Targets are predicted as `rate × snaps`**, where `rate` is the player's own
  targets-per-snap to date shrunk toward his position's causal rate, `k = 50`
  snaps **fixed in advance and identical in every arm**, so it cannot favour one.
- **The one tuned constant is chosen out of sample.** The `shrunk` snap arm's
  `k` is selected on one half of the seasons and judged on the other, both
  directions. This thread retracted two documents for choosing on the scored
  rows; it is not doing it again.
- **`alpha = 0.4` is not tuned.** It is the repository's own constant
  (`opportunity-model.js:40`), and the recursion matches `:65-69` exactly.
- **Controls.** A hindsight **oracle** that knows the actual count, sizing the
  ceiling on identical rows; and a **shuffled** arm whose snaps are permuted
  within `(season, week, position)`, whose advantage must vanish.
- **Paired bootstrap clustered by player**, 2,000 iterations.

## 4. Results

Positive means the arm beats the baseline. `naive` uses no snap information at
all — it is the trailing mean of the player's own targets.

**Judged on 2022-2025** (k selected on 2018-2021; n = 20,692 rows, 810 players):

| arm | MAE (targets) | vs naive | 95% CI | |
|---|---|---|---|---|
| naive | 1.4898 | — | — | baseline |
| `std` season-to-date | 1.5023 | −0.0124 | [−0.0166, −0.0082] | **worse** |
| `trail3` last three weeks | 1.4516 | +0.0384 | [+0.0247, +0.0516] | beats naive |
| **`ewma` alpha 0.4** | **1.4313** | **+0.0588** | **[+0.0465, +0.0716]** | **best causal arm** |
| `oracle` knows the count | 1.0729 | +0.4172 | [+0.3841, +0.4530] | the ceiling |

**Judged on 2018-2021** (k selected on 2022-2025; n = 19,106 rows, 817 players):

| arm | MAE (targets) | vs naive | 95% CI | |
|---|---|---|---|---|
| naive | 1.6338 | — | — | baseline |
| `std` season-to-date | 1.6439 | −0.0101 | [−0.0149, −0.0054] | **worse** |
| `trail3` last three weeks | 1.5906 | +0.0433 | [+0.0282, +0.0582] | beats naive |
| **`ewma` alpha 0.4** | **1.5653** | **+0.0685** | **[+0.0551, +0.0819]** | **best causal arm** |
| `oracle` knows the count | 1.1341 | +0.4997 | [+0.4629, +0.5384] | the ceiling |

**Against R&D's own stand-in**, which is the comparison that decides the claim:

| arm | 2022-25 vs `trail3` | 2018-21 vs `trail3` |
|---|---|---|
| `ewma` | **+0.0204** [+0.0159, +0.0247] | **+0.0252** [+0.0199, +0.0306] |
| `std` | −0.0508 [−0.0636, −0.0377] | −0.0534 [−0.0680, −0.0390] |
| `oracle` | +0.3789 [+0.3500, +0.4107] | +0.4563 [+0.4249, +0.4898] |

**Share of the ceiling recovered:**

| arm | 2022-2025 | 2018-2021 |
|---|---|---|
| `trail3` | 9.2% | 8.7% |
| **`ewma`** | **14.1%** | **13.7%** |

**Controls.** The shuffled arm comes in at **−0.9941** [−1.0516, −0.9364]
against naive — far worse, as random snaps should be. No leakage. The `shrunk`
arm's `k` was selected as **0 in both directions**, which makes it identical to
`std`, and `std` loses to naive: **shrinking a snap estimate toward the
positional mean does not help at all**, and the grid said so without being
argued with.

## 5. What this does and does not say

**It says the "forecasting captures none of it" result is too strong.** Three
arms out of four beat a no-snap baseline with intervals clear of zero, in both
halves. The reachable slice is about a seventh of the ceiling, and it replicates
to within half a percentage point across two disjoint sets of seasons — which is
a stronger consistency claim than the size of the effect.

**It does not say production would gain 0.06 targets.** The baseline here is a
trailing mean of a player's own targets. The shipped model is not that: it
already carries target share and team volume, which encode a large part of what
a snap count encodes. **The right reading is that the signal exists and is
partly forecastable, not that it is unclaimed by the model.** Measuring the gain
over production needs the production pipeline and is not this document.

**It does not license a points figure.** A rough conversion from targets to PPR
would put 0.06 targets near a tenth of a point, which would make this the
largest effect in the Phase A series — and that conversion is an *illustration*,
not a measurement. This project has been burned by exactly that move before.
The measured unit is targets; quote targets.

**The absence result is the practical one.** 13.1% of the rows are weeks a
player did not play, and the gap between `oracle` and every causal arm is
dominated by them: no trailing statistic predicts a player being ruled out on a
Friday. That is why a graded injury-report term is a different and more
promising unit than a better snap smoother — the information arrives from
outside the box score, which is the only place it can come from.

## 6. Reproduction

`snaps.py`, scratchpad, pure Python 3, ~3 min. Reads `snap_counts_2018..2025`,
`stats_player_week_2018..2025` and `players.csv` from nflverse. Deterministic:
`random.Random(17)` in the bootstrap, `random.Random(20260922)` for the shuffle.
No numpy, pandas or sklearn in this container. No database is read; this needs
none.

Independent check worth recording: R&D reported naive **1.5674** and perfect
snap knowledge **1.0717**. This harness, on its own rows and its own
construction, gets naive 1.4898 / 1.6338 and oracle 1.0729 / 1.1341. **The
ceiling reproduces**; the disagreement is only about what a forecast recovers
from it.

## The five questions

- **Well built?** The controls are in it rather than bolted on: a shuffled arm
  that had to fail, an oracle on identical rows, absences restored before any
  arm was scored, and the only tuned constant chosen on seasons it was not
  judged on.
- **Stats or made up?** Stats. 39,798 scored player-weeks across the two halves
  (20,692 and 19,106), 810 and 817 players in each — not summed, since a player
  can appear in both eras. Paired bootstrap clustered by player, every interval
  stated.
- **How do we know?** Because the headline replicates on two disjoint sets of
  seasons to within 0.4 of a percentage point, and because the arm that should
  have failed did fail.
- **Pointed anywhere else on the platform?** No. No server file is touched and
  no constant is licensed. It reframes one parked unit and points at another.
- **How does it unify?** It turns "the advantage vanishes" into a measured
  fraction, and in doing so says where the remaining six-sevenths lives: in
  absence, which no trailing statistic can see and only outside information can.
