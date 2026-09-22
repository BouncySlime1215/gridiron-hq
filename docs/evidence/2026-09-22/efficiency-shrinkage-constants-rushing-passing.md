# Efficiency constants, part 2: rushing and passing — and a narrowing of part 1

`efficiency-shrinkage-constants.md` graded the three receiving-side metrics and
ended with one claim that survived its own caveat: **a receiver's own touchdown
rate carries no detectable information about his future touchdown rate.**

This extends the identical design to the four metrics the same two constants
also drive. Two things come out of it. The face-value under-shrinkage is now
**seven metrics for seven**, which is a much harder pattern to dismiss. And the
touchdown finding **does not generalise**, which is worth saying loudly before
someone repeats it as "touchdown rate is noise".

---

## 1. Do not generalise the touchdown result

| metric | player's own history vs his position alone | 95% CI | |
|---|---|---|---|
| `rec_td_rate` | +1.40% | [−0.000006, +0.000036] | **no detectable gain** |
| `rush_td_rate` | +3.54% | [+0.000002, +0.000040] | real, but marginal |
| `pass_td_rate` | +10.05% | [+0.000014, +0.000063] | **real** |

A quarterback's own touchdown rate is one of the most individual numbers in this
whole exercise. A running back's carries a real if marginal signal. **Only the
receiving one is empty.**

That makes sense on its own terms — a quarterback's touchdown rate is a property
of him and his offence over hundreds of attempts, while a receiver's is a
property of how often his offence happens to be near the goal line when he is
the read. It does not make the receiving result weaker; it makes it specific.

**So: the recommendation to regress all the way to the positional prior applies
to `rec_td_rate` and to nothing else.** `projections.js:99` calls the `td_rate`
family "the most regression-prone number in fantasy" — true of the family's
*shrinkage level*, not true of every member's information content.

## 2. The sweep, four more metrics

Same design as part 1: seasons 2018-2025, cutoffs weeks 5-14, scored on weeks
w+1..18, `k = 0` and `k = ∞` in every grid, gate on **forward** usage only
(≥20 forward carries, ≥40 for the rushing TD rate, ≥60 forward attempts for
quarterbacks — the repo's own script's gates), paired bootstrap clustered by
player. Positive means the candidate beats the shipped literal.

**`ypc` — shipped k = 34.** 5,548 rows, 243 players.

| k | MSE | vs shipped | 95% CI |
|---|---|---|---|
| 0 | 2.363777 | −1.268317 | [−1.630594, −0.966156] |
| **34** | **1.090785** | — | **shipped** |
| 136 | 0.955046 | +0.134604 | [+0.089492, +0.184298] |
| **300** | **0.944175** | **+0.145248** | **[+0.089074, +0.207035]** |
| ∞ | 0.970193 | +0.119658 | [+0.050846, +0.196012] |

**`ypa` — shipped k = 34.** 2,819 rows, 116 players.

| k | MSE | vs shipped | 95% CI |
|---|---|---|---|
| 0 | 2.172693 | −1.189912 | [−1.849302, −0.680488] |
| **34** | **0.969341** | — | **shipped** |
| **300** | **0.855914** | **+0.116316** | **[+0.006907, +0.207459]** |
| ∞ | 0.990297 | −0.016160 | [−0.189708, +0.125909] |

**`rush_td_rate` — shipped k = 70.** 3,824 rows, 191 players.

| k | MSE | vs shipped | 95% CI |
|---|---|---|---|
| **70** | **0.000584** | — | **shipped** |
| **280** | **0.000548** | **+0.000036** | **[+0.000013, +0.000057]** |
| ∞ | 0.000569 | +0.000016 | [−0.000026, +0.000053] |

**`pass_td_rate` — shipped k = 70.** 2,819 rows, 116 players.

| k | MSE | vs shipped | 95% CI |
|---|---|---|---|
| **70** | **0.000352** | — | **shipped** |
| **280** | **0.000320** | **+0.000032** | **[+0.000017, +0.000048]** |
| ∞ | 0.000357 | −0.000003 | [−0.000044, +0.000031] |

## 3. Seven for seven

| metric | family | shipped | optimum | ratio | shipped vs position alone |
|---|---|---|---|---|---|
| `ypt` | `yards_per` | 34 | 136 | 4.0× | **prior-only beats shipped** |
| `ypc` | `yards_per` | 34 | 300 | 8.8× | **prior-only beats shipped** |
| `ypa` | `yards_per` | 34 | 300 | 8.8× | indistinguishable |
| `catch_rate` | `catch_rate` | 26 | 104 | 4.0× | indistinguishable |
| `rec_td_rate` | `td_rate` | 70 | 280 | 4.0× | **prior-only beats shipped** |
| `rush_td_rate` | `td_rate` | 70 | 280 | 4.0× | indistinguishable |
| `pass_td_rate` | `td_rate` | 70 | 280 | 4.0× | indistinguishable |

Every optimum is at least 4× the literal, every one of those intervals excludes
zero, and in no metric does the shipped constant beat the positional average.
`yards_per` is the worst-placed of the three: it governs three metrics with
optima at 136, 300 and 300, so a single constant of 34 is not merely low, it is
being asked to serve three metrics that do not want the same value.

## 4. The caveat from part 1 is unchanged and still decisive

`projections.js:495` is `a.targets += w * (u.targets ?? 0)`. **The denominator
handed to `shrink()` is decay-weighted, not raw.** A smaller `n` at the same `k`
means more shrinkage, so the shipped code already shrinks harder than this
replication does at the same nominal `k`, in exactly the direction that would
close these gaps.

Seven-for-seven consistency makes the pattern harder to dismiss as noise, but it
does **not** resolve the denominator question — if anything it is what a uniform
scaling factor between raw and effective `n` would look like. A constant ratio
of about 4 between raw and decay-weighted opportunity would explain the whole
table at a stroke.

**That is the test to run next, and it is cheap:** on a populated database,
compare `a.targets` as `buildProjections` computes it against the raw target
count for the same players and cutoffs. One number settles whether there is
anything here at all. It cannot be run in this container —
`server/data.sqlite` is schema-only, zero rows in every table.

Until then: **no constant should be edited on the strength of either document.**

## 5. Reproduction

`effk2.py`, scratchpad, pure Python 3, ~14 s, reads
`stats_player_week_2018..2025.csv`. Part 1 is `effk.py`. Neither grades the code
path; both grade the constants, for the reason in §4.

## The five questions

- **Well built?** It extends part 1 without re-litigating it, and it narrows
  part 1's own headline rather than leaving the stronger version standing.
- **Stats or made up?** Stats. 5,548 / 2,819 / 3,824 / 2,819 scored rows across
  eight seasons and ten cutoffs each, paired bootstrap clustered by player, both
  no-model bookends inside every grid.
- **How do we know?** The player-vs-position comparison is a `k = ∞` test, so it
  is immune to the denominator problem that blocks everything else here — which
  is precisely why it is the only thing either document claims.
- **Pointed anywhere else on the platform?** `projections.js:94-125`, owned
  elsewhere. Evidence for a decision, not the decision.
- **How does it unify?** It turns a three-metric hint into a seven-metric
  pattern, and reduces the open question to a single measurement that one
  populated database would answer.
