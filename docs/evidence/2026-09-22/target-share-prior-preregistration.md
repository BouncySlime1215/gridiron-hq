# Pre-registration: the per-position target-share prior

**Written and committed before the grade was run.** Nothing in this file was
chosen after seeing a result on the graded season. It exists so the decision
rule cannot be adjusted to fit whatever comes back.

## What changed

`projections.js` shrank every pass-catcher's target share toward a single
constant, `0.06`. It now shrinks toward that position's measured mean. The
legacy constant stays reachable as `buildProjections({ sharePrior: 'legacy' })`,
which is the incumbent arm below.

The prior is fitted inside `positionalPriors()` from the same log the projection
already reads — weeks with a **known** share, including weeks the player saw no
targets, because that is the estimand it shrinks toward (`a.tgtShare /
a.tgtShareW`). A null share is unknown, not zero, and stays out of both.

## The fitted values, and where they came from

Measured on nflverse REG rows, QB/RB/WR/TE, **2021-2024 only — 2025 is the
graded season and was not read while choosing anything**:

| position | n | mean share, zero-target weeks included |
|---|---|---|
| WR | 9,787 | 0.1322 |
| TE | 4,825 | 0.0972 |
| RB | 6,112 | 0.0647 |
| QB | 2,615 | 0.0004 |

Excluding zero-target weeks would give WR 0.1516, TE 0.1093, RB 0.0928. That is
the wrong estimand and is not used.

Nothing here is tuned: the prior is a mean of the fitting window, not a value
searched over a grid. There is no selection to correct for. `K.share` is
untouched at 6.

## The grade

- **Incumbent.** `sharePrior: 'legacy'` — the same code on the same rows with
  the single 0.06 prior. Not a re-implementation of the old code, so the two
  arms differ in exactly one expression.
- **Split.** Held-out **2025**, REG, weeks **5-17**. The fitting window ends at
  2024 and every arm's engine for week *w* reads only weeks before *w*.
- **Population gate, raw usage only**, taken from
  `scripts/grade-opportunity-vs-baseline.mjs`: at least **3** prior in-season
  games and a prior mean of at least **3** targets + carries. The gate reads no
  model output, and both arms are scored on the **intersection** of the rows
  they each produced, so a row missing from either is scored in neither.
- **Primary metric.** Mean absolute error of **projected targets per game**
  against actual targets, per graded player-week.
- **Significance.** Paired bootstrap **clustered by player**
  (`backtest-significance.js#pairedBootstrapDiff`), 2,000 iterations, fixed
  seed, 90% interval on `legacy_error − fitted_error`. **Positive means the
  fitted prior wins.**

### Controls, declared now

- **Carries must not move.** The change cannot touch the carry share. If the
  two arms differ on carries MAE by more than floating-point noise, the harness
  is wrong and the primary result is void until that is explained.
- **Quarterbacks must not move.** `targets` is forced to 0 for QBs, so the
  target-share prior cannot reach them.

### Secondary, reported but never used to overturn the primary

Rows with **3-5** prior games, where six sevenths of the weight sits on the
prior and any effect should be largest. Declared in advance precisely so that
finding an effect there after a null primary cannot be presented as the result.

## The decision rule, fixed in advance

1. **Interval excludes zero in favour of the fitted prior** → it ships as the
   default. 
2. **Interval straddles zero** → no measured improvement. The fitted prior
   still ships as the default *only* because the incumbent is wrong about the
   population rather than merely mistuned — 0.06 is not the mean of any
   position here — and only if the interval's lower bound is no worse than
   **−0.05 targets per game**, i.e. the measurement can rule out a real harm.
   Otherwise the legacy constant stays the default and the fitted prior remains
   behind the option.
3. **Interval excludes zero against the fitted prior** → it does not ship. The
   default reverts to legacy, the finding is written up as a negative, and the
   option keeps the fitted arm reachable for whoever fits it together with
   `K.share`.

In cases 2 and 3 the correctness argument alone is **not** treated as
sufficient to override a measurement that says the change costs accuracy.

## Limits stated before the numbers exist

- The grading database is a **scratch rebuild**, built from the nflverse weekly
  CSVs in this container: 45,693 REG player-weeks over 2018-2025 and **1,483
  distinct players**. That is a **narrower player list** than the full league
  universe — another thread's rebuild of the same shape carried 8,294 players.
  Every figure from it carries that label. The live database was never opened.
- The scratch database fills `players` and `player_week_usage` only, which is
  what the projection path reads (`projections.js`, the two queries at
  `:285-300`). Anything that would read another table is out of scope here.
- `K.share = 6` against the fitter's ~0.4 is untouched and remains open. A
  result here is a result about the prior at the shipped weight, not about the
  pair.

## The five questions

- **Well built?** It will be judged on that after the fact. What is fixed now is
  that the arms differ in one expression, the gate reads no model output, the
  fitting window ends before the graded season, and the decision rule is written
  down before the result.
- **Stats or made up?** The priors are means of 23,339 rows. The grade is a
  paired bootstrap clustered by player on held-out 2025.
- **How do we know?** Because the incumbent is the same code with one flag, so
  nothing but the prior differs, and because the carries and quarterback
  controls must come back flat or the harness is wrong.
- **Pointed anywhere else on the platform?** It changes live projections, which
  is why it is pre-registered and gated rather than pushed on the correctness
  argument alone.
- **How does it unify?** It turns a constant nobody had checked into a measured
  one, and records the estimand — count the quiet weeks — that made the material
  already in the code unusable.
