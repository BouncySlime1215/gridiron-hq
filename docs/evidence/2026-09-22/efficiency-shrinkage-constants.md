# The three ungraded efficiency constants: what a sweep says, and why it is not yet a verdict

> **CORRECTED 2026-09-22 after audit. Read
> `efficiency-shrinkage-constants-corrections.md` first.** §4 has been rewritten
> in place — it had the denominator inverted. §2's winning `k` values were
> selected and reported on the same rows, so their margins need discounting.
> §5's `ypt` gain does not replicate out of sample; its `catch_rate` gain does;
> its `rec_td_rate` null is confirmed and stronger. §3 stands as written. §6's
> "untested" list is superseded by part 2.

`projections.js:94-125` carries five shrinkage constants. One — `int_rate: 1600`
— was swept and graded. Three never were:

```
yards_per:  34    // yards per opportunity — regress hard
catch_rate: 26    // raw targets
td_rate:    70    // the most regression-prone number in fantasy
```

**Headline, stated with its own limit up front: at a raw season-to-date
denominator all three shrink far too little, and two of them lose to doing
nothing at all. But the shipped code does not feed a raw denominator, and that
single fact may account for the entire gap. This is a strong signal and an
argument for running the repo's own grader — it is not yet a licence to change a
constant.**

---

## 1. Why this could not be graded properly here

`scripts/grade-efficiency-vs-baseline.mjs` already exists in this repository and
is the right test: it grades each constant through the real `buildProjections`
with a `kOverride` that moves one constant family and nothing else. It needs a
populated database.

**This container's `server/data.sqlite` is schema-only.** `player_week_usage`,
`players`, `nfl_snaps`, `game_lines` and `weekly_ensemble_fits` all return zero
rows. So the shipped grader cannot run here at all.

What follows grades **the constants**, not the code path, from nflverse weekly
stats, using the repository's own shrinkage form:

```
shrink(observed, prior, n, k) = (n*observed + k*prior) / (n + k)   stats-util.js:17-18
n     = targets                                                    projections.js:564-569
prior = opportunity-weighted positional rate                       projections.js:417-424
```

Design: for each season 2018-2025 and each cutoff week 5-14, the model is built
on weeks 1..w and scored against weeks w+1..18 of the same season. Three
metrics, one per constant family, receiving-side only because that is what this
container has. `k = 0` and `k = ∞` are in every grid, so the two no-model
baselines come out of the same machinery. The gate is on **forward** usage (≥20
forward targets, ≥40 for the TD rate) and forward usage is never an input, so it
cannot favour an arm. Significance is a paired bootstrap **clustered by player**,
because one player appears at up to ten cutoffs per season.

## 2. The sweep

Positive means the candidate beats the shipped literal.

**`ypt` — shipped k = 34.** 11,298 scored rows, 586 players.

| k | MSE | vs shipped | 95% CI | |
|---|---|---|---|---|
| 0 | 8.806281 | −4.991558 | [−6.437067, −4.016800] | worse |
| 17 | 4.230859 | −0.476662 | [−0.554187, −0.407182] | worse |
| **34** | **3.752130** | — | — | **shipped** |
| 68 | 3.496767 | +0.254385 | [+0.197179, +0.316889] | better |
| **136** | **3.419439** | **+0.331374** | **[+0.229064, +0.438698]** | **best** |
| 300 | 3.437901 | +0.314420 | [+0.173670, +0.454222] | better |
| ∞ | 3.542773 | +0.209287 | [+0.026349, +0.390107] | better |

**`catch_rate` — shipped k = 26.** 11,298 rows, 586 players.

| k | MSE | vs shipped | 95% CI | |
|---|---|---|---|---|
| 0 | 0.018927 | −0.009597 | [−0.011190, −0.008271] | worse |
| **26** | **0.009295** | — | — | **shipped** |
| 52 | 0.008725 | +0.000572 | [+0.000444, +0.000702] | better |
| **104** | **0.008582** | **+0.000717** | **[+0.000483, +0.000953]** | **best** |
| ∞ | 0.009134 | +0.000172 | [−0.000241, +0.000585] | tie |

**`rec_td_rate` — shipped k = 70.** 4,647 rows, 346 players.

| k | MSE | vs shipped | 95% CI | |
|---|---|---|---|---|
| 0 | 0.002607 | −0.001516 | [−0.001824, −0.001255] | worse |
| **70** | **0.001091** | — | — | **shipped** |
| 140 | 0.001030 | +0.000061 | [+0.000040, +0.000083] | better |
| **280** | **0.001014** | **+0.000077** | **[+0.000042, +0.000113]** | **best** |
| ∞ | 0.001028 | +0.000062 | [+0.000009, +0.000118] | better |

Every family's optimum sits at **3-4× the shipped literal**, and every interval
excludes zero.

## 3. The uncomfortable row: the shipped arm against doing nothing

The `k = ∞` arm is the positional average — no player-specific information at
all. Against the shipped constants:

| metric | shipped vs prior-only | 95% CI | verdict |
|---|---|---|---|
| `ypt` | −0.209204 | [−0.390082, −0.025980] | **prior-only beats shipped** |
| `catch_rate` | −0.000172 | [−0.000584, +0.000244] | indistinguishable |
| `rec_td_rate` | −0.000062 | [−0.000118, −0.000008] | **prior-only beats shipped** |

At a raw denominator, two of the three shipped constants are shrinking so little
that the player's own efficiency number is *actively worse than ignoring him*.

## 4. Why that is not yet a verdict — it does not measure the shipped estimator

**Rewritten 2026-09-22 after audit. The first version of this section had the
denominator backwards and its correction pointing the wrong way. Do not quote
any earlier copy of it.** Full record:
`efficiency-shrinkage-constants-corrections.md` §5.

What the shipped code actually does, read off the file rather than assumed:

- `RECENCY = { seasonDecay: 0.35, weekHalfLife: null }` (`projections.js:162`).
- `rowWeight` (`:176-180`) returns the **season weight alone** when
  `weekHalfLife` is null, which it is.
- `seasonWeight` (`:169-173`) is `0.35^(through − s)`, so a row from the cutoff
  season has `back = 0` and enters at **exactly 1.0**.

So there is **no within-season decay**, and the in-season denominator is a raw
opportunity count, exactly as `:97-99` says. The file explains why at `:155-161`:
every within-season decay tried made things worse, and a trailing three-week
average loses to season-to-date, 4.753 against 4.509.

What the comments omit is that **prior seasons are added on top**, at 0.35,
0.1225 and 0.042875. Season decay only ever *adds* evidence; it discounts older
seasons relative to the current one and never pushes the current one below 1.0.
Therefore:

> **The shipped `n` is greater than or equal to the raw single-season count this
> sweep uses — always — with equality only for a player who has no prior season
> in the log.**

That is the opposite of what the first version of this section argued, and it
removes the "the shipped code already shrinks harder, so the gap closes" reading
entirely.

**But the real point is larger than the direction of the ratio, and it is why
none of this is a verdict.** The two estimators differ in `observed` as well as
in `n`. `:563` is `a.recYds / a.targets` and `:565` is `a.receptions / a.targets`
— both numerator and denominator are multi-season season-weighted sums. The
shipped rate is a **pooled multi-season** rate; this sweep's is a
**single-season-to-date** rate. A larger `n` is *correct* when `observed` rests
on more data; that is what `n` means, and the shipped estimator is internally
coherent on its own terms.

**So `k` does not transport between them in either direction, and neither does
any ratio correction.** Specifically, refuse this step, however tempting:
*"shipped k behaves like k/ρ, so `catch_rate` 26 at ρ = 2 acts like 13 against
an optimum of 104, so the under-shrink is twice as bad as reported."* It is
wrong. It corrects `n` while leaving `observed` uncorrected, and the two moved
together.

The honest statement, narrower than the first version's and better supported:
*this sweep grades a raw single-season shrinkage estimator. The shipped code is
a different estimator. The sweep's optima say nothing about the shipped
literals in either direction, and the one test that would is the grader already
sitting in `scripts/`.* Nobody should edit a constant on the strength of this
document — which was the first version's conclusion, and survives its own
correction.

## 5. Does the player's own season-to-date rate help at all?

**Heading corrected 2026-09-22.** This section originally claimed the result
"transfers" to the shipped code because `k = ∞` ignores `n`. Half of that is
right: the prior-only arm does ignore `n`. But the arm it is compared against
does not, and more to the point the shipped estimator's `observed` is pooled
across seasons while this one is season-to-date (§4). **This is a result about
a single-season shrinkage estimator, which is a real question, not about the
shipped one.** The figures below are also selected-and-reported on the same
rows; see the corrections document §2 for the out-of-sample re-test, which
keeps `catch_rate`, drops `ypt`, and strengthens the `rec_td_rate` null.

| metric | prior-only MSE | best-k MSE | gain | 95% CI | |
|---|---|---|---|---|---|
| `ypt` | 3.542773 | 3.419439 | +0.122902 (3.47%) | [+0.043427, +0.206695] | real |
| `catch_rate` | 0.009134 | 0.008582 | +0.000547 (5.99%) | [+0.000339, +0.000751] | real |
| `rec_td_rate` | 0.001028 | 0.001014 | +0.000014 (1.40%) | [−0.000006, +0.000036] | **none** |

**A receiver's own touchdown rate, measured over a full half-season, carries no
detectable information about his touchdown rate over the rest of it.** Even at
its best-tuned shrinkage, knowing the player beats knowing only his position by
1.40%, and the interval contains zero.

The repository already suspected this. `projections.js:99` calls `td_rate` *"the
most regression-prone number in fantasy"*. That instinct is now measured, and it
is stronger than the comment implies: the defensible setting for `rec_td_rate`
is not a larger `k` but the positional prior outright, and any product surface
implying a receiver has a personal touchdown rate is decoration.

Note the honest asymmetry — the same test says `ypt` and `catch_rate` *do* carry
real individual signal (3.47% and 5.99%), so this is a finding about touchdowns
specifically, not a general case for throwing away player history.

## 6. Reproduction

`effk.py`, scratchpad, pure Python 3, ~26 s. Reads
`stats_player_week_2018..2025.csv`. No numpy/pandas/sklearn in this container.

Limits, stated rather than discovered later. **The first of these is
superseded**: `ypc`, `ypa`, `rush_td_rate` and `pass_td_rate` were untested when
this was written and were tested in
`efficiency-shrinkage-constants-rushing-passing.md` shortly afterwards, so any
figure for those four belongs to part 2, not here. The rest stand: `observed` is
the raw season-to-date rate where the shipped code uses a rate pooled across
seasons under `seasonDecay` (§4); and the
positional prior here is rebuilt from weeks 1..w of the same season, which is
the natural reading of `positionalPriors` but was not verified against a
populated database.

## The five questions

- **Well built?** The sweep is sound; the document around it was not. §4 argued
  the denominator backwards, and §2 and §5 reported selected `k` values without
  saying they were selected. Both are corrected in place and in the corrections
  document. Putting the caveat in §4 rather than a footnote was right — it was
  just the wrong caveat. No server file is changed.
- **Stats or made up?** Stats. 11,298 scored rows for two metrics and 4,647 for
  the third, over eight seasons and ten cutoffs each, paired bootstrap clustered
  by player, both no-model bookends inside the grid.
- **How do we know?** For what survives: a season split that separates choosing
  `k` from judging it, reported in both directions (corrections §2). The earlier
  answer here — that §5 survives the denominator problem — was too strong, and
  §5 now says so itself.
- **Pointed anywhere else on the platform?** `projections.js:94-125`, owned
  elsewhere. This is evidence for a decision, not the decision.
- **How does it unify?** It names the single missing capability — a populated
  database — that blocks three separate open questions in this thread, and after
  correction it agrees with the 2026-09-20 sweep that already had one: one
  constant is serving three metrics that disagree about it.
