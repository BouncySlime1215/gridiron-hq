# Four big builds, 2026-09-12 — what was built, what it measured, and what to ship

Branch `model-2026-09-12-bigbuilds`, based on `build-2026-09-12-v2-integration`.
Four commits: `1958aeb`, `c23880b`, `dd8d806`, and this stage.

**The one-line verdict: ship the instruments, ship none of the models.** Three of
the four builds produced measurement or governance machinery that is tested and
worth keeping. Zero of them produced a forecasting change that clears its own bar,
and one of them (stage 2) had its headline finding overturned by the governance
built in stage 4.

---

## The constraint that shapes every number below

Every model number in this report comes from a **synthetic fixture**. None of it is
about football.

The only populated database in this project is `server/data.sqlite`, which this
session was instructed never to open — a live process is capturing real games into
it — and every run was required to point `GRIDIRON_DB_PATH` at a fresh `/tmp` path.
There is no other game-level history in the tree: `docs/evidence/historical/` holds
prose and `test/fixtures/nfelo-*.csv` are six-row unit fixtures.

So the honest reading of all four builds is: **they establish things about code, and
nothing about the NFL.** Each stage records the one command that would answer the
real question, to be run by a human against a quiesced copy.

Stage 4 hit a second, separate wall on top of this one, described under build 4:
even with the database open, the depth measurement it was asked for is not
answerable from stored history, because the data was never written down.

---

## Build 1 — Measure the ensemble's effective rank (`1958aeb`)

### What was built

Both prior audits concluded that `nfl-ensemble.js` carries ~31 components of which
only ~2–3 hold independent information. That is a claim about the rank of a matrix,
so build 1 built the instrument to measure it rather than arguing about it.

- `componentPredictionStream()` — the cutoff-safe walk-forward replay loop, extracted
  out of `fitEnsemble` so the diagnostic and the production fit cannot drift apart.
- `nfl-ensemble-rank.js` — correlation matrix, Jacobi eigendecomposition, three
  effective-rank metrics, per-component loadings, redundancy via the
  variance-inflation identity, a greedy independent basis, and the market-shrinkage
  regression the audits quote. Two spaces: raw margins and departures from the
  market.

Nothing changed a weight, a blend, a gate or a forecast.

### Measured before/after

| | Before | After |
| --- | --- | --- |
| `fitEnsemble` output on a fixed fixture | baseline | **byte-identical** |
| Existing ensemble/replay/integrity suites | 140/140 | 140/140 |
| New tests | — | 16, mostly known-answer |

The extraction is the only thing that touched production code, and the
byte-identical check is the before/after that matters for it.

On the synthetic fixture (3 latent factors, 27 margin-producing components, 952
complete games): participation ratio 3.68 raw-margin / **1.93** market-residual;
entropy rank 4.98 / 3.18; top eigenvalue share 42.5% / 70.9%. Raising the fixture
to 8 latent factors moves raw-margin participation 3.68 → 6.08, so the pipeline
tracks true dimensionality end to end.

### Did it help?

**Not applicable — it is an instrument, not a model.** It is correct, it recovers
known answers, and it has not yet been pointed at the data that would make it say
anything.

**The real ensemble's effective rank was not measured.** The fixture's latent factor
count is chosen by this repository, so "rank ≈ 3" there validates the pipeline and
says nothing about football.

### The incidental finding that does not depend on the fixture

`market_shrinkage.market_residual` came back as exactly `blend = 0 + 1·market`,
R² = 1 — because **zero components cleared the residual gate**. When that happens
the production research forecast *is* the market, by design rather than by
shrinkage. Stage 4 hit the same fact from a completely different direction (see
below), which is the strongest form of corroboration available here.

---

## Build 2 — Bake the incumbent blend off against real combination methods (`c23880b`)

### What was built

A component reduction, ten forecast-combination methods, a walk-forward harness that
refits at production's actual weekly cadence, and Diebold-Mariano gating on every
comparison. Nothing wired into `ensembleLine`.

The load-bearing test is that `fitIncumbentMarketResidual` reproduces `fitEnsemble`
exactly — 27 components, every slope, RMSE, gain, paired t, gate decision and weight,
including production's 3-decimal rounding. A bake-off that mis-states the incumbent
flatters whatever it proposes.

### Measured before/after, as stage 2 reported it

Near-oracle-market fixture, 51 weekly cutoffs, 408 held-out games:

| Method | RMSE | cover-Brier | DM* vs incumbent | Stage 2's verdict |
| --- | --- | --- | --- | --- |
| **incumbent** (gated market-residual blend) | **9.8105** | 0.2514 | — | baseline |
| market only | 9.8096 | 0.25134 | −1.00 | indistinguishable |
| constrained LS | 9.8300 | 0.25261 | — | indistinguishable |
| inverse-MSE | 10.2777 | 0.26553 | 3.04 | significantly worse |
| equal weights | 10.4279 | — | 3.51 | significantly worse |
| equal weights (all) | 11.1031 | — | 4.79 | significantly worse |

Weak-market control run (identical league, only the market quote made noisy; the
PRNG draw count is unchanged so scores and features are bit-identical between the
pair): **seven of ten candidates beat the incumbent at p < 0.05**, and the winner
beat plain equal weighting at p = 0.016.

### Did it help?

**No — measured, and the incumbent won.** Stage 2 reported that honestly and
recommended against replacing the blend.

### But stage 4 overturned most of its statistics

See the re-grading section. On the same sample, the same sigma and the same single
look, the governed rules overturn **11 of stage 2's 20 comparisons** — including all
seven of the weak-market control's "significantly better" results. Stage 2's
*recommendation* (don't replace the blend) survives and is if anything strengthened.
Its *control run*, the thing that was supposed to prove the combiner works, does not.

---

## Build 3 — Model both scoreboards jointly (`dd8d806`)

### What was built

A score-driven (GAS) dynamic joint score model following Koopman & Lit's structure,
built in JS so it can be refit inside stage 2's weekly-cadence harness. The Poisson
layer counts scoring **events**, each carrying a value from a fitted distribution
over {1,2,3,6,7,8}, because points are not Poisson — a team scores ~22.5 with sd
~10.2, overdispersed ~4.5×, and a Poisson on points would claim sd 4.7 and be
catastrophically overconfident about every margin it priced.

### Measured before/after

| | Champion | Joint GAS | Verdict |
| --- | --- | --- | --- |
| CRPS, football-shaped scores | **7.4703** | 7.4961 | challenger loses |
| CRPS, Gaussian scores | **5.5598** | 6.1387 | challenger loses |
| Market-anchored variant, 5 metrics | — | better on 4 of 5 | 2 at raw p < 0.05 |
| The same after Holm correction | — | — | **both killed** (smallest p 0.0434 must clear 0.01) |
| Joint log score, dependence on vs off | — | DM* −5.995 | **p < 0.0001** |

### Did it help?

**No as a margin forecaster — measured, and reported as a failure by the stage
itself.** Five correlated tests on 408 games producing two marginal hits is what
chance produces.

**Yes on the one thing it was built to establish.** Same marginals, shared
scoring-event shock on versus off, 408 held-out games: the dependent model wins on
joint log score by DM* −5.995. Same-game correlation is real and modelling it pays
for teasers and parlays. Against the champion that comparison cannot be run at all —
it returns "too few paired observations" because nothing else in this tree emits a
joint score distribution. That is a structural gap, not a technicality.

A caveat the stage raised itself and which should not be forgotten: the football
fixture shares a family with the model, and a generator built to have the property a
model exploits will reward that model.

### And stage 4 did not overturn it

**0 of stage 3's 8 comparisons are overturned by the governed rules.** Stage 3
already Holm-corrected across five metrics; stage 2 corrected across none. The
difference in how the two stages fare under governance is exactly the difference in
how carefully each one graded itself.

---

## Build 4 — Execution realism and governed comparison (this stage)

### Piece 1 — Depth/fill-aware execution simulator

`server/services/execution-fill.js`. `captureOrderBooks()` has stored
`bid_size`/`ask_size` since the books were first pulled, and nothing downstream has
ever read them *as sizes*. The two places that touch them reduce the book to a
scalar:

```
live-edge.js:215   depth    = Math.min(bid_size, ask_size)
live-edge.js:151   maxUnits = Math.min(3, depth / 500)
```

and then price every dollar of the position at the **mid** with a constant
`costFraction`. That is infinitely elastic supply at the best quote, and it is wrong
in the direction that always flatters a backtest: the bigger the claimed edge, the
bigger the stake it justifies, and the bigger the stake the less of it the touch can
absorb.

The module walks a ladder, returns what filled at what average, and caps a
combination at its thinnest leg. A mis-ordered ladder **throws** rather than filling
from the wrong end — Polymarket's CLOB sorts away from the touch, reading index zero
is an already-committed bug class here, and doing it silently would report an
average fill *better* than the touch, which is the one error a reader never
questions. 20 tests, every arithmetic assertion computed by hand.

#### The structural finding, which matters more than the module

`captureOrderBooks()` **fetches the whole ladder and persists only the touch**,
because `polymarket_quotes` has columns for exactly four numbers. Levels two and
beyond have been discarded every thirty minutes since 2026-08-29.

So a book-walk over stored history is impossible, and no backfill can fix it — the
data was never written. Addressed rather than worked around:

- **Migration 044** (`044_polymarket_order_book_levels.js`, **file only, not
  applied**) adds `polymarket_order_book_levels`, keyed `(captured_at, condition_id,
  side, level)` with an explicit rank so `ORDER BY level` is unambiguous where
  `ORDER BY rowid` is not.
- Capture now writes the ladder best-first.
- `storedBook()` prefers a real ladder and otherwise returns a one-level book flagged
  `truncated`, on which every fill past level one returns `bound: 'best_case'` and a
  non-null `shares_beyond_known_book` — the remainder is reported as **unknown, not
  zero**.
- `fillStudy()` is the measurement, ready to run the moment real ladders exist.

### Piece 2 — Kalshi adverse-selection haircut

`server/services/kalshi-adverse-selection.js`. `exchangeVsBook()` computes
`gap = q.yes_price - bookProb` and reports anything past `minGap` as a divergence
worth a look. That treats a five-cent quote as an unbiased probability estimate,
when the published finding is that sub-$0.10 Kalshi contracts return about −60% of
stake. Feeding that price into a gap calculation manufactures "edges" of exactly the
size and sign the bias guarantees, on the cheapest contracts, which are also the ones
a scanner sorted by percentage gap surfaces first.

Built as a **calibration map**, not a per-side haircut, because a naive haircut is
incoherent: 60% off a 0.05 YES implies P(yes) = 0.02, while leaving the 0.95 NO side
alone implies P(yes) = 0.05 — same market, two truths. The map is antisymmetric
about a coin flip by construction (`C(1−p) = 1 − C(p)`), so YES and NO cannot
disagree, and its scale is *solved* from the published anchor rather than
hard-coded.

Wired into `exchangeVsBook`, which now ranks by the **adjusted** gap and reports
`disagreements_surviving_haircut`.

### Piece 3 — Governed paired-comparison harness

`server/modeling/governed-comparison.js`. `ModelRegistry.compare()` was:

```js
compare(ids) { return ids.map(id => this.store.get(id)).filter(Boolean); }
```

A fetch loop. Nothing in the registry decided whether a challenger beat an
incumbent, so every stage of every build has graded its own homework with whatever
test it chose *after* seeing its own numbers.

`pairedBootstrapDiff` and `alwaysValidPValue` already existed here and are unchanged.
What is new is eight gates around them:

| Gate | Refuses |
| --- | --- |
| 1 Preregistration | a comparison with no single declared primary metric |
| 2 Multiplicity | a win on a secondary metric that Holm removes |
| 3 Contradiction | a primary win alongside a significant secondary loss |
| 4 Effect floor | a significant difference too small to be worth deploying |
| 5 Look count | a repeat look at a p-value that is valid at one endpoint only |
| 6 Independent evidence | 408 rows that are really 4 weeks of evidence |
| 7 Indistinguishability | a relabelled incumbent — refused *before* any p-value is read |
| 8 Prior scale | a verdict that depends on where in the mSPRT tau grid it landed |

`compare()` now returns statistics; `challenge()` **derives**
`gates.baseline_improvement` from the verdict instead of trusting whatever the
result arrived with; and `assertPromotable` refuses to promote — or roll back — over
a comparison that disagrees with a hand-set gate. 28 tests, each gate given a case
that trips it and a case that does not.

---

## The governed re-grading of builds 2 and 3

Run at `looks: 2` (each stage has already tested these exact sequences once) with
sigma estimated on the first held-out season, which is then **discarded**; the
verdict uses the later seasons only. Reproduce with
`node scripts/governed-reevaluation.mjs`; full output in
`docs/evidence/2026-09-12/governed-reevaluation.json`.

### Overturns attributable to the rules alone

Same sample, same sigma, same single look as each stage had. Anything that differs
here is the **rules**, not the reduced sample.

| | Comparisons | Overturned |
| --- | --- | --- |
| Stage 2 | 20 | **11** |
| Stage 3 | 8 | **0** |
| **Total** | **28** | **11** |

Direction of every overturn:

- **7×** "better" → "indistinguishable" — all seven of stage 2's weak-market winners
- **4×** "worse" → "indistinguishable" — `equal_weight`, `inverse_mse`,
  `ols_granger_ramanathan`, `shrunk_to_equal` on the near-oracle fixture
- **0×** in the other direction. Nothing a stage called indistinguishable became
  significant under governance.

Under the full procedure (hold-out sigma, second look, all eight gates), **nothing
promotes**.

### What "overturned" does and does not mean

It does **not** mean stage 2's claims were false. It means they do not survive a
stricter, preregistered procedure, and that is a weaker statement. The asymmetry —
11 claims removed, 0 added — is the shape you expect when the original analysis was
under-corrected rather than wrong, and it is also the shape you would expect if the
governed test were simply too conservative. Both readings are live and this report
does not claim to distinguish them.

### Gate 7 caught the thing it was built for, unprompted

On the near-oracle fixture, gate 7 fires on `market_only` and
`market_anchored_combination` versus the incumbent: per-observation losses at the
correlation ceiling with a relative effect at the rounding floor. The incumbent is
not *approximately* the market there — it is the market, and no p-value computed
against it means anything.

Independent corroboration from a different direction: on the calibration season the
incumbent's per-game losses are **identical** to `market_only`'s on *both* fixtures
— zero variance in the paired difference, so no sigma could be estimated at all.
The gate never opened and the blend was exactly the market. Build 1 found the same
fact through an eigendecomposition; build 4 found it through a variance that was
zero.

### Two findings about the procedure itself

Kept because burying them would be the exact sin this whole build exists to remove.

**The sibling-fixture sigma is not a valid construction.** Each stage ran a pair of
fixtures, so borrowing each fixture's sigma from its twin appears to satisfy
"declared in advance." It does not: the twin differs only in market noise, and that
was enough to make the borrowed sigma up to **132× too large** on one fixture (merely
conservative) and too **small** on the other — where it **manufactured four
promotions** the hold-out sigma calls inconclusive. A mis-specified sigma breaks the
martingale guarantee as surely as a plug-in one, and in a direction nobody can
predict in advance.

**Tying tau to the declared minimum effect is worse, not better.** It was tried on
the theory that `alwaysValidPValue`'s tau = sigma fallback is absurdly diffuse
(sigma ≈ 100 on a squared-error loss against effects of 2–14). It is diffuse, but
mSPRT power is a **band** around tau and the two errors are not symmetric: a
far-too-wide prior costs an additive `0.5·log(n·tau²/sigma²)` penalty, while a
far-too-narrow one collapses the likelihood ratio and detects nothing — including
large effects. With tau = minEffect, stage 3's unambiguous Gaussian-fixture
rejections went to "inconclusive". Gate 8 exists so this choice is never anyone's
to make: the grid is fixed in code, and a verdict that moves across it is refused.

**Robustness check that came out clean:** hold-out sigma and plug-in sigma agree on
**every** verdict (0 of 28 disagreements). The headline conclusions are driven by the
models, not by the nuisance parameter.

---

## What the execution pieces measured, and what they could not

### They could not measure fills on real order books

Two independent blockers, and the second survives the first:

1. The only book store is `server/data.sqlite`, off-limits to this session.
2. Even with it open, the ladder is one level deep. `polymarket_quotes` has columns
   for `best_bid`, `best_ask`, `bid_size`, `ask_size` and nothing else.

Section 1 of `scripts/execution-fill-study.mjs` prints **"no measurement available"**
rather than substituting something for it. There is no before/after here and none is
claimed.

### What can be stated without a measurement

Sections 2 and 3 of that script are **closed-form arithmetic**, not simulations:
given a touch price, a depth and a stake, the fill and the surviving edge are
determined. The tables say what the answer *would* be at each depth; which depths
Polymarket actually quotes is precisely the part that needs the real books.

A 0.50 contract, 0.49/0.50 quote, 3-point claimed edge, priced naively at the mid as
`live-edge.js` does. Cells are the fraction of the claimed edge a fill would pay:

| L1 depth | $50 | $100 | $250 | $500 | $1000 | $2500 |
| --- | --- | --- | --- | --- | --- | --- |
| 15 | 0.129 | 0.064 | 0.026 | **0.013** | 0.006 | 0.003 |
| 50 | 0.429 | 0.214 | 0.086 | 0.043 | 0.021 | 0.009 |
| 100 | 0.857 | 0.429 | 0.171 | 0.086 | 0.043 | 0.017 |
| 500 | 0.857 | 0.857 | 0.857 | 0.429 | 0.214 | 0.086 |
| 5000 | 0.857 | 0.857 | 0.857 | 0.857 | 0.857 | 0.857 |

Two things follow, neither of which needs a measurement to be true:

- **14.3% of the edge is gone before depth costs anything.** That is the half-spread,
  and no amount of depth recovers it. Pricing at the mid, as the code does, is
  strictly more optimistic than pricing at the touch. Spread cost and depth cost are
  separable and this separates them.
- **At 15 contracts — the size the cited research finds most combinatorial arbitrage
  episodes capped at — a $500 stake fills 1.5% of itself and keeps 1.3% of its
  claimed edge.** The screen figure is overstated by roughly **78×**.

And for a package: **the leg count does not appear in the answer.** A structure of
any width is capped by its single thinnest leg, so adding legs adds risk and fee
without adding size. A four-leg arbitrage quoting $4,000 of edge against one 15-lot
leg is a $60 trade.

### The Kalshi haircut, against the fee that is already priced

All-in cost as a percentage of stake, 100 contracts, default exponent:

| Price | Fee/contract | Adverse $/contract | All-in cost | vs lowvig 3.09% |
| --- | --- | --- | --- | --- |
| 0.02 | 0.0014 | 0.0148 | **80.8%** | 26× worse |
| 0.05 | 0.0034 | 0.0295 | **65.7%** | 21× worse |
| 0.10 | 0.0063 | 0.0392 | **45.5%** | 15× worse |
| 0.20 | 0.0112 | 0.0294 | 20.3% | 7× worse |
| 0.30 | 0.0147 | 0.0114 | 8.7% | 3× worse |
| 0.50 | 0.0175 | 0 | 3.5% | ≈ par |

**The two costs have opposite shapes.** The fee peaks at even money where the haircut
is zero; the haircut peaks at the extremes where the fee rounds to almost nothing. A
venue comparison that prices only the fee — which is what `venueCostComparison()`
does today — therefore rates a five-cent contract as the cheapest thing on the board
when it is the dearest by an order of magnitude.

**How much of this is a measurement:** one published number. The shape exponent is a
choice no data in this repository constrains, and `haircutSensitivity()` reports it
rather than hiding it — at a 20-cent contract the same anchor supports a haircut
anywhere from **6% to 34%**. Use it as a prior a cheap leg must overcome, not as a
measurement of this project's own fills.

### A real bug found on the way

`kalshiFee()` over-charges by a cent on **0.38% of (contracts, price) pairs**,
including the single most common case there is: 100 contracts at even money charged
$1.76 for a $1.75 fee. `0.07 * 100 * 0.5 * 0.5` evaluates to `1.7500000000000002`
and `Math.ceil` rounds a fee already exactly on the cent up to the next one. Fixed in
both copies with a regression test.

---

## Ship / don't ship

### Ship

- **`governed-comparison.js` and the registry wiring.** This is the highest-value
  thing in the four builds. It is the only change that makes a future model claim
  harder to make than it was yesterday, and it has already overturned 11 of 28
  claims from this same night's work. `assertPromotable` refusing to promote over a
  disagreeing comparison is a small, well-tested behaviour change that closes a real
  hole: `baseline_improvement` was a boolean anyone writing a result could assert.
- **`execution-fill.js`.** Pure functions, no DB, no network, 20 hand-computed tests.
  Nothing currently depends on it, so the risk of shipping is near zero and the cost
  of not shipping is that the next cross-venue dollar figure is aspirational again.
- **Migration 044 plus the capture change.** The single highest-leverage item for
  *future* measurement in this report. Every half hour it is not applied is another
  half hour of ladders discarded, and none of it is recoverable later. Apply the
  migration, restart capture, wait a week, then run `fillStudy()` — that sequence is
  the only path to the number this stage was asked for.
- **The `kalshiFee` rounding fix.** Small, unambiguous, tested.
- **Builds 1 and 2's instruments** (`nfl-ensemble-rank.js`,
  `forecast-combination.js`), on the same reasoning: they change nothing and they
  make the real question answerable.

### Do not ship

- **The joint GAS model as a margin forecaster.** Build 3 said so itself and the
  governed test agrees. Its joint-distribution result is real and interesting for
  teasers and parlays, but that is a different product and it has no incumbent to be
  compared against yet.
- **Any replacement for the incumbent blend.** Build 2 recommended against it; stage
  4 removed the evidence that its control run worked at all.

### Ship with the caveat attached

- **The Kalshi haircut.** Wire it in — it is already wired into `exchangeVsBook` —
  but never let a number it produces be quoted without its exponent. One published
  anchor and one unconstrained shape parameter is a prior, not a measurement, and the
  6%-to-34% spread at 20 cents is how much that matters.

---

## What I would tell someone deciding

**The instruments are worth more than anything they measured tonight.** Four builds
produced zero shippable model changes and four pieces of durable machinery. That is
not a disappointing night; it is what an honest night looks like when the incumbent
is nearly the market and the challenger space has been picked over. The thing to
resist is the temptation to read "nothing beat the incumbent" as "the work found
nothing."

**The single most important line in this report is that nothing was measured on real
data.** Every table above describes a generator this repository wrote. If one item
gets acted on, make it the one command each stage records — run against a quiesced
copy of `server/data.sqlite`, by a human, with `GRIDIRON_DB_PATH` pointed at the
copy.

**The second most important is that the ladder is still being thrown away.** That is
the only finding here with a clock on it.

**Trust build 3's reporting more than build 2's.** Not because its model was better —
it lost — but because it corrected for multiplicity before reporting and stage 4
could not find anything to overturn. Stage 2 corrected across none of its ten
candidates and lost 11 of 20 comparisons. When two of your own reports disagree
about how confident to be, the one that was harder on itself is the one to believe.

**Be suspicious of this report too.** Gate 8 exists because I got tau wrong on the
first attempt, in a way that silently destroyed the power of the very test I was
using to grade two other builds. The sibling-sigma construction exists in the output
because I tried it, it looked principled, and it manufactured four false promotions.
Both mistakes were caught by running the alternative and comparing, not by reasoning
carefully in advance. That is the only method in this report I would defend without
qualification.

---

## Reproduce

```bash
# Every run needs a fresh scratch database. Never point these at server/data.sqlite.
export SCHEDULER_DISABLED=1
export NODE_OPTIONS='--import ./test/offline-guard.mjs'

GRIDIRON_DB_PATH=/tmp/gov-$$.sqlite node scripts/governed-reevaluation.mjs
GRIDIRON_DB_PATH=/tmp/fill-$$.sqlite node scripts/execution-fill-study.mjs

npm test    # 1857 tests, 1817 pass, 39 skipped, 1 pre-existing failure
```

The one pre-existing failure is `resolveQuoteBasis` in
`test/nfl-execution-pipeline.test.js`. It fails identically on the base branch
`build-2026-09-12-v2-integration` — verified by stashing this stage's changes and
re-running — and nothing in these four builds touches it.

### The commands that would answer the real questions

```bash
cp server/data.sqlite /tmp/read-only.sqlite      # a human, against a quiesced DB

# Build 1: the real effective rank
node scripts/ensemble-rank-report.mjs --before-season 2025 --label real-2025
# Build 2: which combination method actually wins on NFL history
node scripts/forecast-combination-report.mjs --test-seasons 2023,2024,2025
# Build 3: the joint model against real scores
node scripts/joint-score-report.mjs --test-seasons 2022,2023,2024
# Build 4: real fills -- ONLY after migration 044 is applied and capture has
#          been running long enough to have stored real ladders
node scripts/execution-fill-study.mjs
```

Test seasons must be at or after 2022, the ensemble's calibration boundary, or the
component forecasts themselves are not cutoff-safe.
