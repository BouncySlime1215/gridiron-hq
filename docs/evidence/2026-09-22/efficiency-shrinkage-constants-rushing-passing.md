# Efficiency constants, part 2: rushing and passing — and a narrowing of part 1

> **CORRECTED 2026-09-22 after audit. Read
> `efficiency-shrinkage-constants-corrections.md` first.** §1's headline is
> **withdrawn**: `rush_td_rate` and `pass_td_rate` were selected and reported on
> the same rows, and out of sample `rush_td_rate` is null in both directions
> while `pass_td_rate` replicates in one only. §4's denominator argument is
> inverted — see part 1 §4 as rewritten. This document **supersedes part 1 §6's
> line listing `ypc`, `ypa`, `rush_td_rate` and `pass_td_rate` as untested**:
> all four are tested here.

`efficiency-shrinkage-constants.md` graded the three receiving-side metrics and
ended with one claim that survived its own caveat: **a receiver's own touchdown
rate carries no detectable information about his future touchdown rate.**

This extends the identical design to the four metrics the same two constants
also drive. Two things came out of it, and **both have since been corrected**.

The face-value under-shrinkage is **seven metrics for seven** — which stands as
a property of this replication, and turns out to say nothing about the shipped
literals in either direction (§4, rewritten).

And the touchdown finding was reported here as **not generalising** — that claim
is **withdrawn**. It rested on two figures selected and reported on the same
rows; out of sample `rush_td_rate` is null in both directions and
`pass_td_rate` replicates in one only. §1 is kept below as the record of what
was published, with the retraction stated in it.

---

## 1. Do not generalise the touchdown result — WITHDRAWN

> **Withdrawn 2026-09-22.** Both non-null figures in the table below were
> selected and reported on the same rows. Out of sample, `rush_td_rate` is null
> in both directions and `pass_td_rate` replicates in one only, so the section's
> conclusion does not follow from its evidence. The honest reading is the
> reverse: **no touchdown rate of the three carries player-specific information
> that survives honest out-of-sample selection in both directions.** Kept here
> as the record of what was published. Corrections document §3.

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
zero, and in no metric does the literal beat the positional average **inside
this replication**. Read the last column that way and no other way: per §4 the
literal meets a different `observed` and a different `n` in production, so
"prior-only beats shipped" here is not "the shipped constant is worse than
ignoring the player".

The winners in the `optimum` column were also chosen by lowest MSE on the same
rows their intervals came from. Their **locations** replicate out of sample —
five of seven metrics pick the identical `k` on either half of the seasons —
but their **margins** are optimistic. Corrections document §2.

One observation survives all of that, because it needs only the ordering:
`yards_per` governs three metrics whose optima here sit at 136, 300 and 300. A
single constant is being asked to serve three metrics that do not agree about
it. **A prior thread reached the same conclusion through the real code path on
2026-09-20** — *"not '34 is wrong' — it is that one constant is doing three
jobs"* — which is the version to cite, because it ran the shipped estimator.

## 4. The caveat from part 1, rewritten: this does not measure what ships

**Rewritten 2026-09-22 after audit. The first version of this section repeated
part 1 §4's inverted denominator argument and proposed a one-number test that
cannot settle anything. Do not quote any earlier copy.** Full record: the
corrections document, §5.

There is **no within-season decay** — `RECENCY.weekHalfLife` is `null`
(`projections.js:162`) and `rowWeight` returns the season weight alone
(`:176-180`), which for the cutoff season is `0.35^0 = 1.0`. The in-season
denominator is raw. Prior seasons are then **added** at 0.35 / 0.1225 /
0.042875, so the shipped `n` is **≥** the raw single-season count used here,
never smaller.

The first version had that backwards, and the proposed fix — a single
raw-to-weighted ratio — would not have worked even with the sign corrected. The
shipped `observed` is pooled over the same seasons under the same weights
(`:563`, `:565`), so it is a different quantity from this sweep's
season-to-date rate. **The two estimators differ in `observed` as well as in
`n`, and no ratio transports between them.**

So the seven-for-seven pattern is a real property of a raw single-season
shrinkage estimator, and it says nothing about the shipped literals in either
direction. **The only test that can settle them is the grader against a
populated database, running the real `buildProjections`** — which a prior thread
already ran on 2026-09-20, finding that nothing on a nine-point grid beats any
of the three literals on 2024-2025. See the corrections document §6.

Unchanged and reinforced: **no constant should be edited on the strength of
either document.**

## 5. Reproduction

`effk2.py`, scratchpad, pure Python 3, ~14 s, reads
`stats_player_week_2018..2025.csv`. Part 1 is `effk.py`. **Neither grades the
shipped estimator**, which differs from both in `observed` as well as in `n` —
see part 1 §4 as rewritten, and the corrections document §5-§6. Part 1 §6 listed
these four metrics as untested; this document is where they were tested, and it
supersedes that line.

## The five questions

- **Well built?** Not well enough. It extended part 1 without re-litigating it,
  and inherited two defects in doing so: it reported selected `k` values as
  though they were estimated ones, and it repeated part 1's denominator argument
  without re-reading `rowWeight`. Both are corrected above and in the
  corrections document; the sections they touch are marked, not deleted.
- **Stats or made up?** Stats. 5,548 / 2,819 / 3,824 / 2,819 scored rows across
  eight seasons and ten cutoffs each, paired bootstrap clustered by player, both
  no-model bookends inside every grid.
- **How do we know?** For what survives: by a season split that separates
  choosing `k` from judging it, reported in both directions. The earlier answer
  here — that a `k = ∞` test is immune to the denominator problem — was too
  strong: the arm it is compared against still uses `n`, and the shipped
  `observed` differs regardless.
- **Pointed anywhere else on the platform?** `projections.js:94-125`, owned
  elsewhere. Evidence for a decision, not the decision.
- **How does it unify?** It turns a three-metric hint into a seven-metric
  pattern about one research estimator, and — once corrected — points at the
  populated-database grader as the only thing that can speak for the shipped
  one.
