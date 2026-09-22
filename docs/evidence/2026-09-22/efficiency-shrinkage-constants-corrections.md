# Efficiency constants, corrections: what parts 1 and 2 got wrong

Four findings from the audit gate on `efficiency-shrinkage-constants.md`
(part 1) and `efficiency-shrinkage-constants-rushing-passing.md` (part 2), plus
two things found while answering them. Both documents have been corrected in
place; nothing was deleted, and every superseded section is marked as such.
**Read this before quoting either of them.**

Short version of what changes:

| claim | was | now |
|---|---|---|
| part 1 §2, the winning `k` values | "best", intervals quoted at the winner | selected and reported on the same rows — **discount the margin** |
| part 1 §5, `ypt` +3.47% | real | **does not replicate out of sample** |
| part 1 §5, `catch_rate` +5.99% | real | **holds, both directions** |
| part 1 §5, `rec_td_rate` null | no detectable gain | **null confirmed and stronger** |
| part 2 §1, `rush_td_rate` +3.54% | "real, but marginal" | **withdrawn — null both directions** |
| part 2 §1, `pass_td_rate` +10.05% | "real" | **one direction only** |
| part 1 §3, shipped vs prior-only | "prior-only beats shipped" | **free of selection bias, but it is about the research estimator, not the shipped one** — §5 |
| part 1 §4, the denominator | decay-weighted, so smaller than raw | **inverted — the shipped `n` is ≥ raw, and the two estimators differ in `observed` too** — §5 |
| the face-value under-shrinkage | "seven for seven" | **measures a different estimator from the shipped one; it transports in neither direction** — §5, §6 |

---

## 1. The §2 / §3 discrepancy: reproduced and fully explained

Part 1 reports the same comparison twice, in opposite orientations, and the two
are not exact negations:

| | point | 95% CI |
|---|---|---|
| §2, `ypt`, `k = ∞` row (+ means ∞ beats shipped) | +0.209287 | [+0.026349, +0.390107] |
| §3, `ypt` row (+ would mean shipped beats ∞) | −0.209204 | [−0.390082, −0.025980] |
| §3 negated | +0.209204 | [+0.025980, +0.390082] |

The point estimates differ by 8.3e−5 and the lower bound by 3.7e−4. The benign
reading is that the published figure is a bootstrap order statistic rather than
a sample mean. The serious reading is that the two tables came from different
runs or different row filters, which would make every cross-reference between
them unsafe. **It is the benign one, and that is established by reproduction,
not by argument.**

`effk_disc.py` builds the receiving dataset once and computes both orientations
from the same `errs` arrays in the same process:

```
=== ypt: shipped k=34 vs k=inf, both orientations, one dataset ===
  rows 11298  players 586  resample series exactly negated: True
  sec-2 orientation  median +0.209287  CI [+0.026349, +0.390107]
  sec-3 orientation  median -0.209204  CI [-0.390082, -0.025980]
  sec-3 negated      median +0.209204  CI [+0.025980, +0.390082]
  bootstrap SAMPLE MEAN (not published anywhere): +0.209569
  adjacent order-statistic gaps that explain the offsets:
    median   f[1000]-f[999]   = 8.290e-05
    upper    f[1950]-f[1949] = 2.560e-05
    lower    f[50]-f[49] = 3.689e-04
```

Both published triples come back **digit for digit** from one dataset, so the
rows are identical — 11,298 rows, 586 players, in both. The mechanism is two
things at once:

1. `boot()` returns `d[int(.5 * iters)]` — the bootstrap **median**, an order
   statistic, not the sample mean of the paired difference. The sample mean is
   +0.209569, which is published nowhere.
2. Under the swapped orientation the resample series is exactly negated
   (verified element by element: `True` above), so sorting it reads the
   **mirrored index**. `d_swapped[1000] = −d_orig[999]`, not `−d_orig[1000]`.
   Each published pair therefore differs by exactly one adjacent
   order-statistic gap: 8.290e−5 at the median, 3.689e−4 at the lower bound,
   2.560e−5 at the upper — which are the three observed offsets.

The same pattern holds on the other two metrics, at their own scales
(`catch_rate` median gap 6.6e−9, `rec_td_rate` 1.1e−8).

**Nothing is wrong with either table and neither needs a correction of its
numbers.** What was wrong is that a reader could not tell. Two things follow
for anything that quotes these files, and for the next study of this shape:

- Report the bootstrap **sample mean** as the point estimate, and state the
  CI's orientation once. Then a sign flip is antisymmetric by construction and
  a reader can negate a row safely.
- At `iters = 2000` the bounds carry an order-statistic granularity of a few
  times 1e−4 on `ypt`. That is small against the interval width (0.36) but it
  is not zero, and it is the floor on how precisely any of these bounds can be
  quoted.

## 2. Selection bias, disclosed

Part 1 §2 and §5 and part 2 §1 chose "best k" by minimising MSE on the same
rows the confidence interval came from. **That flatters the chosen arm**, and
the documents did not say so.

The direction is not uniform, and it matters which way each figure moves:

- **Part 1 §3 is immune to *this* bias.** Both arms — the shipped literal and
  `k = ∞` — are fixed before any data is seen, so nothing there was chosen. That
  does not make it a statement about production: per §5 it compares the literal
  inside a **research** estimator whose `observed` and `n` both differ from the
  shipped one. Read "prior-only beats the literal **in this replication**", never
  "the shipped constant is worse than ignoring the player".
- **Every "does knowing the player help" figure is inflated**, because those
  compare the prior-only arm against the *best* k.
- **The `rec_td_rate` null gets stronger.** An optimistically-chosen arm still
  could not beat ignoring the player, so an honestly-chosen one cannot either.

The repository already holds itself to this standard —
`scripts/promote-early-week-weights.mjs:47-48` pre-registers its gate before
grading — and these documents should have been held to it too.

### The re-test

`effk3.py`. Seasons split in half, 2018-2021 and 2022-2025. `k` is chosen on
one half by lowest MSE; the prior-only-versus-chosen-k comparison is then
evaluated **only on the other half**, where that `k` was never allowed to look.
Both directions are reported, because reporting one is one more selection.

| metric | select 2018-21 → judge 2022-25 | select 2022-25 → judge 2018-21 | verdict |
|---|---|---|---|
| `ypt` | k=136, +0.150885 [+0.041352, +0.268924] | k=136, +0.092016 [−0.009636, +0.199342] | **split — does not replicate** |
| `catch_rate` | k=104, +0.000440 [+0.000180, +0.000716] | k=104, +0.000653 [+0.000381, +0.000980] | **holds both ways** |
| `rec_td_rate` | k=280, +0.000014 [−0.000009, +0.000040] | k=280, +0.000015 [−0.000017, +0.000049] | **null both ways** |
| `ypc` | k=300, +0.027835 [−0.002600, +0.060387] | k=300, +0.023705 [−0.001119, +0.051745] | **null both ways** |
| `ypa` | k=300, +0.160649 [+0.062571, +0.278769] | k=136, +0.075787 [−0.071587, +0.228301] | **split** |
| `rush_td_rate` | k=280, +0.000023 [−0.000003, +0.000051] | k=280, +0.000018 [−0.000006, +0.000043] | **null both ways** |
| `pass_td_rate` | k=280, +0.000018 [−0.000012, +0.000049] | k=600, +0.000047 [+0.000021, +0.000078] | **split** |

**One metric of seven survives in both directions: `catch_rate`.** Three are
null in both. Three replicate in one direction only, which is what a
selected-and-reported effect looks like when the selection is taken away.

One thing that does replicate even where the gain does not: **the location of
the optimum.** Five of seven metrics pick the identical `k` on either half
(136, 104, 280, 300, 280); only `ypa` (300 → 136) and `pass_td_rate`
(280 → 600) move. So part 1 §2's pattern — every optimum well above the shipped
literal — is not an artefact of choosing on the test set. What is an artefact
is the **size of the margin** quoted at the winner.

## 3. What part 2 has to withdraw

Part 2 §1 published this, under the heading *"Do not generalise the touchdown
result"*:

> | `rush_td_rate` | +3.54% | [+0.000002, +0.000040] | real, but marginal |
> | `pass_td_rate` | +10.05% | [+0.000014, +0.000063] | **real** |

Both figures were selected and reported on the same data. Out of sample,
**`rush_td_rate` is null in both directions** and **`pass_td_rate` replicates
in one direction only**. So part 2's own headline is withdrawn: the claim that
the touchdown finding "does not generalise" rested on those two numbers, and
they do not support it.

**The honest statement is the reverse of part 2's.** Of the three touchdown
rates, none carries player-specific information that survives honest
out-of-sample selection in both directions. The `rec_td_rate` null from part 1
is the general case, not the exception — which is closer to what
`projections.js:99` said in the first place.

What part 2 said about *why* a quarterback's touchdown rate ought to be more
individual than a receiver's is a plausible mechanism and was never a
measurement. It should not be repeated as one.

## 4. Provenance: part 1 §6 is superseded

Part 1 §6 lists `ypc`, `ypa`, `rush_td_rate` and `pass_td_rate` as **untested**.
Part 2 tested all four. Both sentences shipped, and they contradict each other.

Corrected: **part 2 supersedes part 1 §6's "untested" line.** Any
`pass_td_rate` or `rush_td_rate` figure attributed to part 1 is misattributed;
those numbers are part 2's, and §3 above withdraws them.

Pointer lines have been added to the top of both documents.

## 5. Part 1 §4 had the denominator inverted

Part 1 §4 argued that `shrink()` is fed a **decay-weighted** opportunity count,
therefore an `n` smaller than raw, therefore the shipped code already shrinks
harder than the replication does at the same nominal `k`, therefore the
correction runs in the direction that closes the gap. **The arithmetic in that
chain is fine and its input is inverted.** Read off the file:

- `RECENCY = { seasonDecay: 0.35, weekHalfLife: null }` — `projections.js:162`.
- `rowWeight` returns `seasonW` alone when `weekHalfLife` is null, which it is —
  `:176-180`.
- `seasonWeight` is `Math.pow(r.seasonDecay, through − s)` — `:169-173` — so a
  cutoff-season row has `back = 0` and weight `0.35^0 = 1.0`.

**There is no within-season decay. Every current-season row enters `a.targets`
at weight 1.0, and the in-season denominator is raw, exactly as `:97-99` says.**
The file states the reason at `:155-161`: every within-season decay tried made
things worse, and a trailing three-week average loses to season-to-date, 4.753
against 4.509.

What the `:97-99` comments omit is that **prior seasons are added on top**, at
0.35, 0.1225 and 0.042875. Season decay only ever *adds* evidence. So the
shipped `n` is **≥ the raw single-season count** parts 1 and 2 use, always, with
equality only for a player who has no prior season in the log.

**The consequence is bigger than the sign.** The two estimators differ in
`observed` as well as in `n`: `:563` is `a.recYds / a.targets` and `:565` is
`a.receptions / a.targets`, both multi-season season-weighted sums. The shipped
rate is a **pooled multi-season** rate; the replication's is a
**single-season-to-date** rate. A larger `n` is *correct* when `observed` rests
on more data — that is what `n` means — and the shipped estimator is coherent on
its own terms.

**So neither `k` nor any ratio correction transports between them, in either
direction.** One framing to refuse if it is ever offered, including by this
thread: *"shipped `k` behaves like `k/ρ`, so `catch_rate` 26 at ρ = 2 acts like
13 against an optimum of 104, so the under-shrink is twice as bad as reported."*
That corrects `n` and leaves `observed` uncorrected, and the two moved together.

Part 1 §4 has been rewritten in place. **Its instinct was right and is now
better supported than when it was written** — the replication turns out to sit
*further* from the shipped estimator than believed, not nearer — and its
refusal to license a constant change stands unchanged.

Worth recording for its own sake: **two independent readers got this denominator
wrong in opposite directions within ten minutes, off the same one-word comment.**
That is the whole argument for §9.

## 6. Prior work: the 2026-09-20 sweep is now the only test there is

**This question had already been measured through the real code path, and
neither part 1 nor part 2 cited it.** That is the larger miss here.

The 2026-09-20 sweep (`scripts/grade-efficiency-vs-baseline.mjs`,
`docs/evidence/2026-09-20/MODEL-AUDIT-2026-09-20.md`, ledger D30-D33) ran the
**real `buildProjections`** with a `kOverride` moving one family at a time, on a
populated database, 2024-2025, 2,811 receiving rows / 259 players:

> Nothing on a nine-point grid beats any of the three literals on 2024-2025 …
> Every value below each literal loses.

Its conclusion was *"not '34 is wrong' — it is that one constant is doing three
jobs."*

That is the opposite face-value result from parts 1 and 2, and **the two do not
need reconciling, because they do not measure the same thing.** Per §5, the
replication uses a single-season `observed` and a raw single-season `n`; the
shipped estimator uses a pooled multi-season `observed` and a season-weighted
`n` that is never smaller. Parts 1 and 2 grade a raw single-season shrinkage
estimator that does not ship.

**Precedence is not close, and it is no longer a matter of degree.** Before §5,
a populated-database grader was the *best* test. Now it is the **only** one: the
estimators differ in `observed`, so no bench replication in this container can
stand in for it at any level of care. Where the 2026-09-20 result and parts 1-2
disagree, the 2026-09-20 result governs outright.

The 2026-09-20 sweep also found, on 2023 — a season its grid never saw —
`k = 68` beating the shipped 34 for yards per target, 90% CI
[+0.0036, +0.0482]. Chosen on one set, confirmed on another, through the real
estimator: that is this repository's own promotion shape, and it is a
better-evidenced reason to look at `yards_per` than anything in parts 1 or 2.

## 7. A units claim in memory, and what is actually wrong with it

`gridiron-k-yards-per-too-small` (2026-09-22) derives `k` from an ICC on
individual targets and carries — ypt k ≈ 65.5-74.0, ypc k ≈ 103.0-128.9 — and
states:

> One opportunity is one observation, so `k` comes out in raw opportunities and
> is directly comparable to the constant.

**The first half is right and the second does not follow.** The unit family is
correct: the shipped `n` is counted in opportunities, and per §5 the
current-season part of it is raw. What does not follow is "directly comparable".
The shipped `n` also carries prior seasons at 0.35 / 0.1225 / 0.042875, and the
`observed` it shrinks is pooled across exactly those seasons under exactly those
weights — while the ICC was decomposed per player-season (and, checked, per
player across seasons, which moved it little). **A `k` derived for a
single-season rate is not comparable to a literal that meets a multi-season
pooled rate, whatever the units agree on.**

This is not a claim that the finding is wrong. It is a claim that it is
**unproven in the estimator that ships**, and it needs the same test §6 names.
Its own write-up already says the right thing — *"Argument, not result … If the
split constants do not beat 4.749, this is a negative and should be recorded as
one"* — and that is the standard it should be held to.

Note that this thread's raw-unit optima (136 for ypt, 300 for ypc) and that
thread's raw-unit ICC values (65-74, 103-129) are two independent measurements
that agree the raw-unit number is well above 34, while the one measurement taken
through the shipped estimator says 34 is fine. **That is consistent, not
contradictory: they are estimates for two different estimators.** It is not
evidence that the constants are wrong.

## 8. What has to happen before any constant moves

Reframed after §5. The earlier criterion — measure the weighted-to-raw
denominator ratio and its spread — was written when the gap was believed to be
a scaling of `n`. It is not; the estimators differ in `observed` too, and no
scalar or distribution over `n` closes that.

**The gate is the grader against a populated database, running the real
`buildProjections`**, as the 2026-09-20 sweep did. Nothing else substitutes.

Two descriptive measurements are still worth having, as context rather than as
a licence:

1. **The prior-season contribution to `n`, and its spread** — what fraction of
   `a.targets` at a given cutoff comes from seasons before the cutoff season,
   by position, reported as a distribution (median, IQR, 10th/90th), not a
   central value. It varies by player because it depends on how many prior
   seasons a player has and how heavily he was used in them, so a rookie and a
   sixth-year starter meet the same literal with very different `n`. That is
   worth knowing whether or not any constant moves.
2. **Whether that spread is wide enough that one constant cannot serve the whole
   population** — a different finding from "the constant is too small", and one
   that would point at a per-player effective-`n` treatment rather than a new
   literal.

Until the grader has run, **no constant moves on the strength of parts 1, 2,
this document, or `gridiron-k-yards-per-too-small`.**

## 9. Hand-off: the `projections.js:97-99` comments

Not made here. `projections.js` belongs to the **Fantasy plan** thread under the
one-editor-per-file rule, and this thread holds no server file. Recorded so its
owner can apply it without re-deriving it.

The comments are **incomplete, not false**:

```
  yards_per: 34,     // yards per opportunity — regress hard (raw opportunities)
  catch_rate: 26,    // raw targets
  td_rate: 70,       // the most regression-prone number in fantasy (raw opportunities)
```

"Raw" is correct for the cutoff season, where `rowWeight` is 1.0. What is
missing is that prior seasons are added at 0.35 / 0.1225 / 0.042875, and that
the `observed` being shrunk is pooled over those same seasons. Something like
*"raw opportunities this season, plus prior seasons at seasonDecay; `observed`
is pooled over the same weights"* would say it.

**The case for bothering is §5:** two independent readers inferred opposite
denominators from that one word within ten minutes of each other, and one of
them published a document on the strength of it.

Worth the same pass: `pickK` at `:203` takes `rawN` and `hardcodedN` as separate
parameters, and **all fifteen call sites pass the identical value**
(`:350, :351, :522, :550, :557, :562, :564, :567, :570, :572, :575, :577, :580,
:644, :668`). The header at `:191-195` already notes both branches are "in raw
opportunities (or recency-weighted games, for the volume metrics), whatever
`rawN` counts" — so the split parameter is vestigial and the name invites the
same misreading.

Comment and naming only. No behaviour change, and the behaviour question goes
through §8 separately.

## 10. Reproduction

`effk3.py` (out-of-sample selection, ~90 s) and `effk_disc.py` (the §1
diagnostic, ~60 s), scratchpad, pure Python 3, reading
`stats_player_week_2018..2025.csv`. No numpy, pandas or sklearn in this
container. Both are deterministic — `random.Random(17)`, 2,000 iterations, in
the bootstrap — and `effk3.py` reproduced its table digit for digit on a second
run. `effk_disc.py` reproduces both of part 1's published triples from one
dataset, which is the §1 result.

The code readings in §5 and §9 are first-hand from
`server/services/projections.js` at `0f336ef6`: `:162`, `:169-173`, `:176-180`,
`:495-505`, `:562-580`, and the fifteen `pickK` call sites listed in §9.

Suite: `npm run check`, exit 0, **2,950 tests / 2,909 passed / 0 failed /
41 skipped**, with the guard captured inside a single command either side of the
run — `git status --porcelain` empty before and after, `git write-tree` stable,
`node_modules` mtime unchanged. Re-run on the tree this document lands on; the
block is in the push report.

## The five questions

- **Well built?** The corrections are, more than the originals were. §1 is
  settled by reproducing both published triples from one dataset rather than by
  reasoning about which mechanism is likelier; §2 is the standard the repository
  already applies to itself.
- **Stats or made up?** Stats, and the point of the document is that two
  published tables were less statistical than they read. Seven metrics, both
  split directions, paired bootstrap clustered by player throughout.
- **How do we know?** Selection is separated from evaluation by a season split;
  the discrepancy is reproduced in one process with the resample series verified
  exactly negated; the prior-thread result is cited with its population and its
  script.
- **Pointed anywhere else on the platform?** No. Nothing here licenses a change
  to `projections.js`, and §8 names what would.
- **How does it unify?** It puts three measurements of one question into the
  same frame — two in raw units, one in the code's units — and identifies the
  conversion between them as the open item, rather than leaving three threads
  with three answers.
