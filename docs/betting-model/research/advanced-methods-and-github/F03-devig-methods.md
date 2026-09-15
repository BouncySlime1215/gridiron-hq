# F03 — Devig methods for NFL spread/total/prop prices

Bucket: fix (assigned). ~50% grounded in tonight's findings (exact defects,
grep-verified), ~50% genuinely new capability.

## 1. What Gridiron actually has today (read in full)

`server/services/nfl-devig.js` (110 lines) is **not** the "one ad hoc
approach" tonight's FOUND list describes anymore, at least not in this one
file. It already implements two methods with a real comparison:

- `proportionalDevig` — the naive/legacy multiplicative split, `a/(a+b)`.
- `shinDevig` — Shin (1992/1993) via bisection on the insider-fraction `z`,
  with a documented closed form, an exact-symmetric fast path, an `S<=1`
  fallback, and a degenerate-bracket fallback. `noVig` (the module's default
  export) = `shinNoVig`.

`test/nfl-devig.test.js` (82 lines, read in full) checks both methods agree
on symmetric lines, diverge in the literature-predicted direction on a
skewed favorite (-900/+600), and that Shin's output is always a valid
distribution.

This is used correctly in most of the codebase — `nfl-clv.js`,
`nfl-props.js`, `nfl-market.js`, `nfl-auto-picks.js`, `nfl-prop-clv.js`,
`nfl-execution-attribution.js`, `nfl-sharp.js`, `betting-hub.js`, and
`nfl-cover-calibration.js` all import `shinNoVig`/`proportionalNoVig` from
`nfl-devig.js` (grep-verified: `grep -rln "nfl-devig" server/`).

**But it is not fully wired.** Two files reimplement the pre-fix naive
proportional devig locally instead of importing from `nfl-devig.js`:

- `server/services/nfl-total-calibration.js:37` — `const noVig = (a, b) => { const pa = implied(a), pb = implied(b); return pa+pb>0 ? pa/(pa+pb) : null; }`. This feeds `marketProbOver` at line 252, which is the training label anchor for `calibratedCoverProbability`'s totals counterpart — the exact governance gate the module's own docstring says exists because the totals model "shipped with no such gate at all." That gate is now live, but calibrated against the *wrong* market baseline relative to its sibling `nfl-cover-calibration.js`, which correctly imports `shinNoVig`.
- `server/services/nfl-neural-replay.js:24-27` — same naive `implied`/`noVig` pair, feeding `home_market_probability` in the prequential audit for the online neural head (this one is explicitly "an opened research candidate and never changes production authority" per its own header, so lower stakes, but still a live inconsistency in an audit tool that exists specifically to judge a model against the market).

So the actual state of "devig method comparison" tonight is: **a real,
tested Shin-vs-multiplicative comparison exists and is the default in most
of the codebase, but two governance/audit surfaces still silently run the
pre-fix method**, and **no comparison against the literature's actual
best-performing method (power) exists anywhere.**

## 2. The literature

### Shin (1992, 1993) — Economic Journal (not fetched full text; paywalled JSTOR, no open-access mirror found; corroborated via two independent, well-cited open-source implementations that both cite and correctly reproduce it)
- "Prices of State Contingent Claims with Insider Traders, and the
  Favourite-Longshot Bias" (1992) and "Measuring the Incidence of Insider
  Trading in a Market for State-Contingent Claims" (1993).
- Model: a fraction `z` of market money is informed and always backs the
  winner; the bookmaker prices defensively, loading extra margin onto
  longshots. Solving for `z` and reconstructing probabilities corrects the
  favorite-longshot bias that a proportional split ignores.
- **Independently confirmed, load-bearing fact for this codebase**: on a
  **two-outcome market, Shin's method is mathematically identical to the
  additive method** (subtract `(S-1)/n` from each raw implied probability).
  Confirmed by two unrelated sources:
  - `mberk/shin` README (105-star, MIT, actively maintained Python/Rust
    package — read in full): *"Note that with two outcomes, Shin's method
    is equivalent to the Additive Method."*
  - `neeljshah/shin-devig` README (read in full, worked numeric example):
    same claim, plus a cited unit test
    (`test_two_outcome_shin_equals_additive`) stress-tested to ~1e-15 over
    random two-way markets.
  - This matters directly for Gridiron: **every NFL market this codebase
    prices — spread, total, moneyline, anytime-TD — is two-outcome.** So
    "compare Shin vs. additive" is not a live question here; Gridiron's
    existing Shin implementation already occupies that slot. The literature
    gap that actually matters for this codebase is Shin (== additive here)
    vs. power, not Shin vs. additive.

### Clarke, Kovalchik & Ingram, "Adjusting Bookmaker's Odds to Allow for Overround," *American Journal of Sports Science* 5(6), 2017, pp. 45-49. DOI 10.11648/j.ajss.20170506.12 (read in full = **false** — abstract and structure confirmed across Semantic Scholar, ResearchGate, and two independent package vignettes/READMEs that cite it, but the paper itself sits behind ResearchGate/1Library/Swinburne-Figshare walls that all returned HTTP 403 to automated fetch; I did not get the full body, sample sizes, or the actual log-likelihood numbers, and I'm not claiming to have read them)
- **What is solidly established** (repeated verbatim across independent
  summaries, not just one source): the paper compares an additive model, a
  normalization (= multiplicative) model, Shin's method, and a new **power**
  method (raise each raw implied probability to a fitted exponent `k`,
  solved so the outputs sum to 1). It applies all four "to three large
  bookmaker datasets, each in a different sport" (sports not confirmed —
  I could not verify which three from any source I could actually reach)
  and finds: **"the power method universally outperforms the multiplicative
  method and outperforms or is comparable to the Shin method."** The paper's
  own stated advantage of `power` over `additive`/`shin`/`multiplicative`:
  it is the only one of the four that can never push a reconstructed
  probability outside (0,1) even when applied in reverse (checking what
  vigged price a fair probability implies).
- **Honest limitation**: I could not confirm NFL specifically was one of
  the three sports, nor get the actual effect-size numbers. The "universally
  outperforms multiplicative" claim is well-corroborated; the exact margin
  is not verified by me. Treat the power-method recommendation below as
  "worth empirically testing on Gridiron's own NFL data," not "proven for
  NFL by this paper."

### R package `implied` (opisthokonta/implied, 9 GitHub stars, actively updated 2026-05; source file `R/implied_probabilities.R`, 571 lines, read in full) and its CRAN vignette (read in full)
- Independent, well-cited reference implementation covering 8 methods:
  basic (multiplicative), shin, bb (balanced-books, Fingleton & Waldron
  1999), wpo, or (Cheung 2015), power, additive, jsd. Its own doc says the
  basic/multiplicative method "tend[s] to be the least accurate of the
  methods in this package" — a third independent voice agreeing
  multiplicative is the weak baseline, consistent with Clarke et al.
- Uses the *exact same* Jullien & Salanié (1994) closed-form algorithm for
  Shin that Gridiron's `nfl-devig.js` header cites and implements —
  confirms Gridiron picked the standard, not an idiosyncratic, approach.

## 3. Open-source devig code actually inspected (read in full)

| repo | stars | license | last push | what it is | adopt as |
|---|---|---|---|---|---|
| `mberk/shin` | 105 | MIT | 2026-08-04 | Python (Rust core) implementation of Shin's method only, with `full_output` diagnostics (`z`, iterations, convergence delta) | reference/cross-check — Gridiron's own bisection already matches its behavior on the 2-outcome case; not worth porting, but its `z`/convergence diagnostics are a nice pattern Gridiron's `shinDevig` could expose (it already returns `z`, doesn't expose iteration count) |
| `neeljshah/shin-devig` | 1 | MIT | 2026-07-15 | Pure-Python, zero-dependency implementation of all four Clarke et al. methods (multiplicative/additive/power/shin) via bisection, with a worked 3-way example and an explicit two-outcome shin==additive test | **best adoption path for the power method** — small, readable, MIT, directly portable logic (bisect for exponent `k` such that `sum(p_i**k)==1`) into `nfl-devig.js`'s existing bisection style |
| `opisthokonta/implied` | 9 | none declared (GitHub shows no SPDX license file) | 2026-05-23 | R package, 8 methods, used as the literature cross-reference above | reference-only — license is unclear (avoid porting code verbatim; the *documentation* is freely citable, the R source itself has no explicit open license to build on) |

## 4. Gridiron-specific fix plan for `nfl-devig.js`

1. Add a third method, `powerDevig(oddsA, oddsB)`, solving by bisection for
   exponent `k` such that `piA**(1/k) + piB**(1/k) == 1` (or the equivalent
   forward form — match whichever parameterization the ported reference
   uses so signs/direction are verified against `neeljshah/shin-devig`'s
   test vectors before trusting Gridiron's own bisection bracket). Expose
   `powerNoVig` alongside `shinNoVig`/`proportionalNoVig`, matching the
   existing export pattern exactly.
2. Fix `nfl-total-calibration.js` and `nfl-neural-replay.js` to import
   `shinNoVig` from `nfl-devig.js` instead of their local naive `noVig`.
   For `nfl-total-calibration.js` this changes the training labels for
   `calibratedCoverProbability`'s totals counterpart, so its walk-forward
   fit (`fitLogisticOffset`/`selectLambda`) must be re-run and its stored
   calibration version bumped (it already has a `VERSION` constant,
   `'total-logit-v1'` → `'total-logit-v2-shin'`) rather than silently
   reinterpreting old rows under a new baseline.
3. Do **not** add a separate `additiveDevig` for two-outcome use — per
   §2, it is provably identical to `shinDevig` here and would be dead code
   that only invites future drift (a fourth "which noVig did this row use"
   question).
4. Build the actual empirical test tonight's FOUND list says doesn't exist
   anywhere in the pipeline: replay Gridiron's own historical closing
   lines + actual game outcomes (spread cover, total over/under) through
   multiplicative vs. Shin vs. power and score log-loss/Brier/calibration
   curve, to answer "which recovers true probability best for NFL
   specifically" with Gridiron's own data rather than trusting an
   unconfirmed-for-NFL literature result. `nfl-replay.js` already has the
   walk-forward scoring infrastructure (`replaySeason`, referenced by
   `nfl-cover-calibration.js`) to attach this to.

## 5. Do not do

- Do not flip the default `noVig` export to power (or any new method)
  without re-running `nfl-cover-calibration.js` and
  `nfl-total-calibration.js`'s walk-forward fits — both are logistic
  offsets anchored to "reproduce the market exactly at b0=b1=0"; changing
  what "the market" means underneath them without refitting silently
  changes what they gate.
- Do not implement a separate `additiveDevig` method for any Gridiron
  market — every Gridiron NFL market is two-outcome, where additive ==
  Shin exactly (independently confirmed, §2). It would be redundant code
  that only creates a fourth thing to keep in sync.
- Do not treat "power universally outperforms multiplicative" as proven
  for NFL specifically — I could not confirm NFL was one of the paper's
  three sport datasets. Gate any default-method change behind Gridiron's
  own backtest (§4), not the paper's authority alone.
- Do not touch `fantasy-football-dashboard`'s live database or running
  server tonight — it is capturing Week 1 games through Sunday. Everything
  above is a read/grep-verified plan, not a change made tonight.
- Do not spend a paid API call sourcing more odds data for the backtest —
  the 12.4M-row Polymarket tape and existing `nfl_line_snapshots` already
  in the DB are unused for exactly this kind of validation.
