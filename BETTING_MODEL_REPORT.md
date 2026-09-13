# Betting model build, 2026-09-12 — integration report

Branch `model-2026-09-12-integration`, based on `build-2026-09-12-v2-integration`.
Eight branches merged: m1–m7 and bigbuilds.

**The one-line verdict: nothing in this build improved a forecast. Several things
improved the instruments that judge forecasts, and one of those instruments spent
the night overturning the rest of the build's claims.**

That is the honest outcome and it is the expected one. No edge has ever been found
against the close in this project, and a night of work that does not find one is
not a failed night — it is the same finding, arrived at with better tools. What
would be a failed night is reporting otherwise.

---

## The constraint that governs every number in this document

**Not one measurement in this build touched real NFL history.** The only populated
database is `server/data.sqlite`, which this session was forbidden to open — a live
process is capturing real games into it right now — and every run was required to
point `GRIDIRON_DB_PATH` at a fresh scratch file. There is no other game-level
history in the tree: the nfelo CSV fixtures are six rows, and a freshly migrated
database holds zero games.

So every before/after below is a statement about a generator this repository wrote,
or about arithmetic. Two branches nonetheless reported numbers attributed to real
football. That is addressed directly in **Claims I could not reproduce**.

---

## Merge

| | |
| --- | --- |
| Branches merged | 8, all `--no-ff` |
| Conflicts | 2 files, 4 hunks |
| Migrations added | 1 (`044_polymarket_order_book_levels.js`) — next free after the base's 043, **no renumbering needed, file only, not applied** |
| Full suite | **1897 tests, 1857 pass, 1 fail, 39 skipped** |
| Baseline on the base branch | 1703 tests, 1663 pass, 1 fail, 39 skipped |
| `npm run lint` | clean, 646 files |
| `npm run typecheck` | clean |

The single failure is `resolveQuoteBasis` in `test/nfl-execution-pipeline.test.js`.
It is the known pre-existing one: I ran the full suite on the base branch **before
merging anything** and it failed there identically. It is still the only failure.

### The conflict that needed judgment

`server/services/prediction-markets.js`, three hunks. m3 replaces the book side of
`exchangeVsBook()` (spread-through-a-normal-curve → Shin de-vig of the quoted
two-sided moneyline); bigbuilds re-prices the exchange side through a long-shot
calibration map. They touch the same three regions and are **complementary, not
alternatives**, so I composed them rather than choosing: the book probability is
now the Shin de-vig with the labelled spread fallback, the exchange quote is
adjusted before the gap is taken, rows carry both sets of fields
(`book_method`/`book_hold`/`shin_z` and `adjusted_gap`/`survives_adverse_selection`),
and the list ranks by the adjusted gap. Both explanatory notes are kept because they
describe different halves of the same row. 21/21 tests across both branches pass on
the composed version.

The other conflict was a trivial union of the `__testables` export (m1's `massey`
and `MASSEY_RIDGE_LAMBDA` next to m2's weather internals).

`nfl-ensemble.js` auto-merged between m5 (Diebold-Mariano inside `fitEnsemble`) and
bigbuilds (which extracted the replay loop into `componentPredictionStream`). Git
got it right, but "no conflict" is not "correct", so I read the merged `fitEnsemble`
end to end: the DM statistic, the legacy paired t and the new gate all sit correctly
inside the refactored scoring pass. bigbuilds also carries m5's
`forecast-comparison.js` byte-identically, so that file merged without incident.

---

## What I verified myself, and what happened

The brief's instruction was that reproducing the headline claims matters more than
the merge. Here is every claim I re-ran, with my numbers next to theirs.

### Reproduced exactly

| Claim | Theirs | Mine |
| --- | --- | --- |
| **m3** — spread→prob conversion error vs Shin de-vig, 6 real 2024 W1 games | mean 0.0283, max 0.0562 on BUF −6.5 | mean **0.0283**, max **0.0562** on ARI@BUF −6.5 |
| **bigbuilds** — governed re-grading | 11 of 28 overturned; 7 better→indist, 4 worse→indist; stage 3 0 of 8; 4 sibling-sigma false promotions | **identical**, and the committed evidence JSON re-generates byte-for-byte apart from its timestamp |
| **bigbuilds** — joint GAS, football fixture | incumbent CRPS 7.4703, joint 7.4961 | **7.4703 / 7.4961** |
| **bigbuilds** — dependence test | joint log score DM* −5.995 | **−5.995** |
| **bigbuilds** — joint GAS, Gaussian fixture | 5.5598 vs 6.1387 | **5.5598 / 6.1387** |
| **bigbuilds** — combination bake-off | incumbent 9.8105, market 9.8096, constrained LS 9.8300, inverse-MSE 10.2777, equal 10.4279, equal-all 11.1031 | **all six identical** |
| **m5** — DM* reduces to the paired t at h=1 with no clustering | asserted identity | `\|diff\|` = **8.9e-16** |
| **m7** — the two conformal implementations | should agree | agree on **21/21** (n × level) cells |

m3's is the cleanest verification in the build: I wrote an independent script against
the raw CSV, called `shinDevig` directly, and landed on the same two numbers to four
decimals. The conversion error it documents (0.0283) is **larger than `minGap`'s
0.02 default**, which means the old path could manufacture a "disagreement" out of
nothing but its own arithmetic.

### Reproduced in direction, not in magnitude

**m5 — the paired t over-rejects.** m5 claimed 58.5% rejection under a week-clustered
true null where DM holds 4.5%. I built my own null (60 weeks × 14 games, a shared
per-week shock in the loss differential, 2000 trials) and measured **47.3% vs 5.5%**
at a nominal 5%. The difference is my shock variance, not a disagreement: the defect
is enormous and real, and the replacement holds nominal size. **This is the most
clearly-established result in the whole build.** The gate that decides which
components earn production weight was rejecting the null roughly ten times too
often.

**m4 — conditional interval calibration.** Claimed worst-bin coverage error
8.0pp → 4.1pp and RMS bin error 4.6pp → 2.9pp. I re-measured on the repo's own
fixture across four seeds, computing both intervals on the *same* held-out rows:

| seed | worst-bin err | RMS bin err | mean width | Brier |
| --- | --- | --- | --- | --- |
| 20260910 | 9.8 → **4.2**pp | 5.1 → **2.3**pp | 31.83 → 32.93 | 0.2237 → 0.2254 |
| 7 | 5.6 → **6.1**pp | 3.5 → **4.5**pp | 32.17 → 32.23 | 0.2347 → 0.2357 |
| 424242 | 6.1 → **3.2**pp | 3.9 → **2.8**pp | 34.29 → 34.85 | 0.2343 → 0.2335 |
| 99991 | 7.3 → **6.3**pp | 4.6 → **3.8**pp | 33.08 → 33.16 | 0.2299 → 0.2305 |

Conditional calibration improves on **3 of 4** seeds, and the coverage is not bought
by narrowing (width goes up, as m4 said). The mechanism is real. But it is 3 of 4,
not 4 of 4, and the magnitude m4 reported sits at the strong end of what I see.

**bigbuilds — effective rank.** Claimed participation ratio 3.68 raw-margin / 1.93
market-residual on 952 complete games. I get **3.662 / 1.923** — but on **1088**
games. Re-running on the bigbuilds branch *alone* also gives 1088, so the committed
evidence file is stale relative to the branch that ships it: it was generated at
stage 1 and later stages widened the replay window by a season. The conclusion is
untouched (~1.9 independent dimensions in the space that matters), but the evidence
JSON no longer matches its own code.

### Claims I could not reproduce

**m4's Brier improvement does not reproduce, and it reverses.** m4 reported
0.2208 → 0.2185, an improvement. On my four seeds the Brier gets **worse in 3 of 4**
(0.2237→0.2254, 0.2347→0.2357, 0.2299→0.2305; better only on 424242). The win
probability now reads the conformal bin's empirical CDF rather than a normal curve,
which is more coherent — but on the data I can reach it does not score better.

**Two branches report numbers from real NFL history that I cannot verify and, under
the safety rules, could not obtain.**

- m4: *"Held-out evaluation on real 2022-2025 games through the production harness
  (nfl-market.nestedEvaluationRows, 469 held-out games)"*, and `test/conformal-calibration.test.js`
  states in a comment that the football claims *"are measured against real history."*
- m5: *"Measured on real data -- 660 NFL games, 2023-2025, opening line vs closing line."*

`nestedEvaluationRows()` reads `game_lines` through `historicalGames()`. A fresh
scratch database holds zero rows, and the repo's own `requires-real-history.js`
exists precisely because real history is unavailable on a clean checkout. So the only
source for "469 real held-out games" or "660 real NFL games" in this tree is
`server/data.sqlite`. **Either those numbers came from the database the build was
forbidden to open, or the word "real" is wrong and they came from a fixture.** I did
not resolve which, because resolving it requires opening that database. Both branches
go to review on this alone, independent of whether their code is good — and both
*are* good code.

**m2's exit test cannot be run, exactly as m2 said.** I seeded ten fixture seasons
and called `weatherComponentDiagnostic({evalFrom: 2022})` myself. It returned
`no weather-affected games in the evaluation window`. m2 reported this wall honestly
and I hit the identical one.

**m6's 160,000-game pre/post physics comparison is not re-runnable here**, because
the pre-fix engine (the +7 coin flip) is not on this base branch — it was removed in
an earlier build tonight. m6's ten shape tests all pass, including the load-bearing
regression: a one-sided +7 spike fails the signed check and is simultaneously
invisible to the `|margin|` view. That much I confirmed directly.

### One thing I measured that nobody asked for

With the DM gate merged, I ran `fitEnsemble` on the fixture and printed the
superseded paired t next to the statistic that replaced it, for all 27 components:

- **Zero components pass the new gate. Zero would have passed the old one either.**
  The instrument changed; the outcome on reachable data did not.
- Median `|paired t / DM*|` = **1.12×** (range 0.89–1.19). Real inflation, smaller
  here than the 1.29× m5 reported elsewhere.
- Every component fails on the **effect-size** leg (`residual_rmse_gain >= 0.03`),
  not the significance leg.

This independently corroborates bigbuilds' incidental finding from a second
direction: `market_shrinkage.market_residual` comes back as `blend = 0 + 1·market`,
R² = 1, because nothing is weighted. **On the data reachable here, the production
research forecast simply *is* the market.** Three separate instruments in this build
say so.

---

## Two defects I found and fixed during integration

**1. Nobody bumped `ENSEMBLE_FIT_VERSION`, and three merged branches changed what
the same input data produces.**

`nfl-forecast-identity.js` documents its own rule: a methodology change means no
earlier artifact may be reused. m5 replaced the gate's instrument (that decides which
components earn weight), m2 changed what `weather_total` emits, m4 changed what
`predictiveDistribution` returns. Each branch was defensible alone — no single one
obviously trips the rule. Together they plainly do. Left at v10, `fitEnsemble` would
load an artifact persisted before tonight and return it verbatim: **old weights,
chosen by the superseded gate, in front of components that no longer emit the same
numbers**, with nothing reporting the mismatch. Bumped to v11.

That bump exposed a second, quieter bug. `test/nfl-ensemble-authority.test.js`
carries the version string twice: once in an assertion, and once as the literal it
rewrites to forge a stale artifact key. Only the assertion is obvious. Had I updated
only that one, the `.replace()` would have silently no-opped, the `UPDATE` would have
overwritten the live key instead of a forged one, and **the test would have stopped
testing artifact rejection while still passing green.**

**2. The `--fixture` report scripts would seed a synthetic league into the real
database.**

All four check that `GRIDIRON_DB_PATH` is *set*. None check that it points somewhere
disposable, though every one of them documents "ONLY valid against an empty scratch
database". So `GRIDIRON_DB_PATH=server/data.sqlite node scripts/ensemble-rank-report.mjs
--fixture` would have run migrations against real history and then written a
fabricated 1360-game league into `game_lines` — after which no synthetic row is
distinguishable from a real one. The guard now lives in `seedEnsembleFixture` itself,
so callers that do not exist yet inherit it.

The verification script I wrote had the same bug in a sharper form: its `db` import
was static, so the module — and the file — was created *before* its own guard could
run. I proved it by pointing it outside `/tmp`: it printed the refusal and created
the database anyway. Imports are dynamic now.

---

## Verdict per branch

| Branch | Did it improve a forecast? | Verified? | Ship? |
| --- | --- | --- | --- |
| **m1** team-strength ridge | No — ships at λ=0, bit-identical | Self-reported negative, consistent | **Review** |
| **m2** weather wiring | Unmeasurable | Wall reproduced | **Review** |
| **m3** Kalshi de-vig | N/A — corrects a wrong quantity | **Exact** | **Ship** |
| **m4** conformal calibration | Calibration yes (3/4 seeds); Brier no | Partial; headline unverifiable | **Review** |
| **m5** Diebold-Mariano gate | No — changes the judge | **Exact identity + 47% vs 5.5% size** | **Ship** |
| **m6** simulator shape | Mixed, honestly reported | Regression tests confirmed | **Ship** |
| **m7** MAPIE cross-check | No — restores a guarantee | **Exact, 21/21** | **Ship** |
| **bigbuilds** | No, on all four | **Every reproducible claim exact** | **Ship instruments** |

### What I would actually ship

**Ship:** m5's DM gate, m7's `(n+1)` correction, m3's de-vig, bigbuilds'
`governed-comparison.js`, `execution-fill.js`, migration 044, and the `kalshiFee`
rounding fix. Every one of these makes a future claim harder to make than it was
yesterday, and not one of them changes a forecast.

**Apply migration 044 and restart capture first, before anything else here.** It is
the only item with a clock on it: `captureOrderBooks()` fetches the full ladder and
persists only the touch, so every thirty minutes it is not applied is another thirty
minutes of order-book depth destroyed, unrecoverably. No backfill can undo that.

**Do not ship as model changes:** the joint GAS margin forecaster, any replacement
for the incumbent blend, or m1's ridge at λ>0.

**Hold for review:** m2 (an unmeasured change that *does* move live totals — it is
the only forecast-altering change in the build with no measurement behind it) and
m4 (mechanism good, headline unverifiable, Brier claim reversed).

---

## Two things worth more than anything measured tonight

**The build graded itself and mostly failed.** bigbuilds' governance harness
overturned 11 of 28 of the same night's comparisons, including all seven of the
"significantly better" results from the control run that was supposed to prove its
combiner worked. A build that ships the tool that discredits its own headline is
worth more than one that ships a headline.

**Two branches claim real-data measurements that this environment cannot produce.**
That is the finding a human has to resolve, and it is worth more attention than any
number above — because if those numbers are real, a rule was broken, and if they are
not, then the one place in this build where "we measured it on real football" appears
is the one place it is not true. Everything else here is honest about its fixture.

---

## Reproduce

```bash
export SCHEDULER_DISABLED=1
export NODE_OPTIONS='--import ./test/offline-guard.mjs'

GRIDIRON_DB_PATH=/tmp/gov-$$.sqlite   node scripts/governed-reevaluation.mjs
GRIDIRON_DB_PATH=/tmp/joint-$$.sqlite node scripts/joint-score-report.mjs --fixture \
  --scoring football --test-seasons 2022,2023,2024
GRIDIRON_DB_PATH=/tmp/fc-$$.sqlite    node scripts/forecast-combination-report.mjs --fixture \
  --test-seasons 2022,2023,2024
GRIDIRON_DB_PATH=/tmp/rank-$$.sqlite  node scripts/ensemble-rank-report.mjs --fixture
GRIDIRON_DB_PATH=/tmp/m4-$$.sqlite    node scripts/verify-m4-coverage.mjs   # FIXTURE_SEED to replicate
npm test
```

The commands that would answer the real questions are in `MODEL_BUILD_REPORT.md`.
They need a human, a quiesced copy of `server/data.sqlite`, and `GRIDIRON_DB_PATH`
pointed at the copy. **Until someone runs them, this build has established a great
deal about this code and nothing whatsoever about the NFL.**
