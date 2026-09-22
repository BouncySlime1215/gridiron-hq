# Snap volume is partly forecastable: about an eighth to a seventh of the perfect-snaps benchmark, not none

**Source label, and it governs every figure below: PROXY — nflverse snap counts
and weekly stats, not the production pipeline.** Nothing here speaks to the
4.749/4.773 weekly-MAE metric, and nothing here is a claim about what the
shipped model would gain. **It also cannot transfer to Plan 02's gate**, which
is scored on the production pipeline against a different baseline; this label
belongs in the sentence wherever the result is quoted, not in a footnote.

Data & techniques R&D measured that knowing a player's coming-week snap count is
worth a large slice of weekly target error, and that forecasting it from the
last three weeks captures **none** of that advantage. The second half is the
part worth re-testing, because "the signal exists but is unreachable" and "the
signal exists and is partly reachable" imply different work.

**It is partly reachable.** A trailing EWMA recovers **14.1%** of the
perfect-snaps benchmark on 2022-2025 and **13.7%** on 2018-2021 — two halves of
the data that never saw each other. Measured against R&D's own benchmark gap
instead of this harness's, the identical absolute gains read **11.9%** and
**13.8%** (§4.1: the two harnesses disagree about the baseline, not about the
gain). R&D's three-week stand-in recovers 9.2% / 8.7% here and 7.8% / 8.7%
there, which is also not zero. **The contradiction of "captures none" is real in
direction; its size is not comparable across the two harnesses.**

---

## 1. The question, narrowed

Not "build a snap-share forecast". The prior result already says a forecast is
worth building only if snap volume carries signal a trailing target average does
not already have. So: **predict week W's targets, varying only how week W's snap
count is estimated**, and see how much of the hindsight gap a causal estimate
recovers.

A negative here would have been as useful as a positive — it would have said the
benchmark is permanently out of reach rather than merely unclaimed.

## 2. Population, and the absences that have to be in it

54,918 player-weeks over 4,355 player-seasons, 2018-2025 REG, WR/TE/RB,
crosswalked `pfr_id → gsis_id` through `players.csv` (22,665 pairs). Scored rows
are the subset week W ≥ 5 with at least three prior weeks in the same season:
20,692 rows / 810 players on 2022-2025, 19,106 rows / 817 players on 2018-2021.

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
- **`alpha = 0.4` is not tuned, and carries no selection cost.** It is the
  repository's own constant — `opportunity-model.js:40`, with the recursion at
  `:65-69` matched exactly — adopted as it ships. No alpha grid was run, on
  these rows or any others, so there is nothing to correct for. (The audit cited
  `:39`; the constant is on `:40`, verified first-hand.)
- **Controls.** A **perfect-snaps** arm that is handed week W's actual count,
  sizing the benchmark on identical rows (§3.1); and a **shuffled** arm whose
  snaps are permuted within `(season, week, position)`, whose advantage must
  vanish.
- **Paired bootstrap clustered by player**, 2,000 iterations.

## 3.1 The perfect-snaps benchmark: what it is, and what it is not

**It is not an oracle and it is not a ceiling**, and this document no longer
calls it either. It is one arm that differs from the causal arms in exactly one
input: week W's snap count is the true one instead of an estimate. Everything
else — the targets-per-snap rate, the shrinkage, the population — is identical.

**Its rate is causal, not in-sample.** The per-player rate is built from weeks
strictly before W (`snaps.py`: `tnum = sum(wk[w]['tg'] for w in wk if w < W)`).
The audit's concern was that if that rate were estimated on the rows it scores,
its MAE would be biased low and every recovery fraction biased down. **That
premise was tested and does not hold.** Deliberately contaminating the rate —
letting week W's own targets into it — moves MAE to **0.9724** from the shipped
**1.0729**, a gap of **+0.1006, 95% CI [+0.0950, +0.1062]**, clearly positive on
2022-2025. If the shipped arm were the in-sample one, that difference would be
zero. So no re-derivation is owed, and the published fractions stand as
published.

The direction of the remaining bias is worth stating, because it runs the other
way: the shipped arm's rate is *noisy*, so the arm **understates** what perfect
snap knowledge is worth. A less noisy rate would widen the gap and make the
recovered fraction **smaller**, not larger. The fractions below are therefore
mildly optimistic, not conservative.

**A better predictor can beat it.** Perfect snaps is not an upper bound on
prediction: an arm that knows a player will be inactive on Sunday (Plan 01's
graded injury-report term) carries information this arm does not, and can score
below it. That is the same conclusion §5 reaches from the other end, and it is
the reason the word "ceiling" was wrong.

## 4. Results

Positive means the arm beats the baseline. `naive` uses no snap information at
all — it is the trailing mean of the player's own targets, on the same scored
rows, with absences included at 0.

**Judged on 2022-2025** (k selected on 2018-2021; n = 20,692 rows, 810 players):

| arm | MAE (targets) | vs naive | 95% CI | |
|---|---|---|---|---|
| naive | 1.4898 | — | — | baseline |
| `std` season-to-date | 1.5023 | −0.0124 | [−0.0166, −0.0082] | **worse** |
| `trail3` last three weeks | 1.4516 | +0.0384 | [+0.0247, +0.0516] | beats naive |
| **`ewma` alpha 0.4** | **1.4313** | **+0.0588** | **[+0.0465, +0.0716]** | **best causal arm** |
| `perfect` knows the count | 1.0729 | +0.4172 | [+0.3841, +0.4530] | the benchmark |

**Judged on 2018-2021** (k selected on 2022-2025; n = 19,106 rows, 817 players):

| arm | MAE (targets) | vs naive | 95% CI | |
|---|---|---|---|---|
| naive | 1.6338 | — | — | baseline |
| `std` season-to-date | 1.6439 | −0.0101 | [−0.0149, −0.0054] | **worse** |
| `trail3` last three weeks | 1.5906 | +0.0433 | [+0.0282, +0.0582] | beats naive |
| **`ewma` alpha 0.4** | **1.5653** | **+0.0685** | **[+0.0551, +0.0819]** | **best causal arm** |
| `perfect` knows the count | 1.1341 | +0.4997 | [+0.4629, +0.5384] | the benchmark |

**Against R&D's own stand-in**, which is the comparison that decides the claim:

| arm | 2022-25 vs `trail3` | 2018-21 vs `trail3` |
|---|---|---|
| `ewma` | **+0.0204** [+0.0159, +0.0247] | **+0.0252** [+0.0199, +0.0306] |
| `std` | −0.0508 [−0.0636, −0.0377] | −0.0534 [−0.0680, −0.0390] |
| `perfect` | +0.3789 [+0.3500, +0.4107] | +0.4563 [+0.4249, +0.4898] |

## 4.1 Share recovered — against both denominators, because they differ

The recovered share is `gain ÷ (naive − perfect)`, and **the two harnesses do
not agree about either endpoint.** R&D reports naive **1.5674** and perfect
snaps **1.0717** on its population, a gap of **0.4957**. This harness gets
1.4898 / 1.0729 (gap 0.4172) and 1.6338 / 1.1341 (gap 0.4997). The constants
agree closely; the baselines do not, and a different baseline is a different
denominator for the same numerator.

| arm | gain | ÷ this harness's gap | ÷ R&D's gap (0.4957) |
|---|---|---|---|
| `trail3` 2022-25 | +0.0384 | 9.2% | 7.8% |
| `trail3` 2018-21 | +0.0433 | 8.7% | 8.7% |
| **`ewma` 2022-25** | **+0.0588** | **14.1%** | **11.9%** |
| **`ewma` 2018-21** | **+0.0685** | **13.7%** | **13.8%** |

**So the honest statement of size is a range — roughly an eighth to a seventh —
not a single figure.** What replicates across the two disjoint season halves is
the *ordering and the rough magnitude*, not four-digit agreement; the earlier
draft's "agreeing to four tenths of a percentage point" was an artefact of
quoting one denominator, and is withdrawn.

**Controls.** The shuffled arm comes in at **−0.9941** [−1.0516, −0.9364]
against naive — far worse, as random snaps should be. No leakage. The `shrunk`
arm's `k` was selected as **0 in both directions**, which makes it identical to
`std`, and `std` loses to naive: **shrinking a snap estimate toward the
positional mean does not help at all**, and the grid said so without being
argued with.

## 5. What this does and does not say

**It says the "forecasting captures none of it" result is too strong.** Three
arms out of four beat a no-snap baseline with intervals clear of zero, in both
halves, and on either denominator. The direction is the finding; the size is a
range.

**It does not say production would gain 0.06 targets.** The baseline here is a
trailing mean of a player's own targets. The shipped model is not that: it
already carries target share and team volume, which encode a large part of what
a snap count encodes. **The right reading is that the signal exists and is
partly forecastable, not that it is unclaimed by the model.** Measuring the gain
over production needs the production pipeline and is not this document.

**It cannot be carried into Plan 02's gate.** That gate is scored on the
production pipeline, against a production baseline, on the 4.749/4.773 metric.
Nothing measured here converts into it, and no figure from this document should
appear on either side of it.

**It does not license a points figure.** A rough conversion from targets to PPR
would put 0.06 targets near a tenth of a point, which would make this the
largest effect in the Phase A series — and that conversion is an *illustration*,
not a measurement. This project has been burned by exactly that move before.
The measured unit is targets; quote targets.

**The absence result is the practical one.** 13.1% of the rows are weeks a
player did not play, and the gap between `perfect` and every causal arm is
dominated by them: no trailing statistic predicts a player being ruled out on a
Friday. That is why a graded injury-report term is a different and more
promising unit than a better snap smoother — the information arrives from
outside the box score, which is the only place it can come from. It is also why
`perfect` is a benchmark and not a ceiling: that term can beat it.

## 6. Reproduction

`snaps.py`, scratchpad, pure Python 3, ~3 min. Reads `snap_counts_2018..2025`,
`stats_player_week_2018..2025` and `players.csv` from nflverse. Deterministic:
`random.Random(17)` in the bootstrap, `random.Random(20260922)` for the shuffle.
No numpy, pandas or sklearn in this container. No database is read; this needs
none. The contamination test in §3.1 is the same script with week W's own
targets added to the rate's numerator and denominator, changing nothing else.

Independent check worth recording: R&D reported naive **1.5674** and perfect
snap knowledge **1.0717**. This harness, on its own rows and its own
construction, gets naive 1.4898 / 1.6338 and perfect 1.0729 / 1.1341. **The
perfect-snaps constant reproduces**; the baseline does not, which is exactly why
§4.1 reports both denominators rather than picking the flattering one.

## The five questions

- **Well built?** The controls are in it rather than bolted on: a shuffled arm
  that had to fail, a perfect-snaps arm on identical rows, absences restored
  before any arm was scored, and the only tuned constant chosen on seasons it
  was not judged on. Two defects found in audit are fixed above: the benchmark
  was named a ceiling when a better predictor can beat it, and a single
  recovery figure was quoted when the denominator is contested.
- **Stats or made up?** Stats. 39,798 scored player-weeks across the two halves
  (20,692 and 19,106), 810 and 817 players in each — not summed, since a player
  can appear in both eras. Paired bootstrap clustered by player, every interval
  stated.
- **How do we know?** Because the direction replicates on two disjoint sets of
  seasons and on both denominators, because the arm that should have failed did
  fail, and because the one challenged assumption — that the benchmark's rate
  was in-sample — was measured rather than argued: +0.1006 [+0.0950, +0.1062]
  says it is not.
- **Pointed anywhere else on the platform?** No. No server file is touched and
  no constant is licensed. It reframes one parked unit and points at another.
- **How does it unify?** It turns "the advantage vanishes" into a measured
  range, and in doing so says where the remaining seven-eighths lives: in
  absence, which no trailing statistic can see and only outside information can.
