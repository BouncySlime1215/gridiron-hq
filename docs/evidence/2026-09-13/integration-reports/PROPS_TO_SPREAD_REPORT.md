# Props → Spread: two independent checks on the same idea family

Giant Plan Step 4 (both halves). Built and validated in
`/tmp/gridiron-insane-worktrees/props-to-spread`, branch
`insane-2026-09-13-props-to-spread`, off `model-2026-09-12-integration`.

Both stages follow the same rule: a real measured number against real data,
or an honest "no result" and a stated reason, never a claimed win without one.

---

## Stage 1 — Props-vs-total consistency (Step 4a)

**The idea:** a book prices its player props and its game totals with
different models. If a team's own captured player props imply a different
point total than the book's own posted line for that game, the book
disagrees with itself across two of its own products — a checkable
inconsistency that needs no edge over the market's judgment.

**What was built** (`server/services/props-total-consistency.js`,
`scripts/audit-props-total-consistency.mjs`, `test/props-total-consistency.test.js`):
pairing and Shin de-vigging of captured prop quotes, an anytime-TD → points
path (`teamTdPointsFromProps`, 6.94 pts/TD — the real PAT/2pt rate, not a
fit) for when that market exists, and a yards-only fallback
(`teamYardsFromProps` + `yardsToPoints`) for when it doesn't.

**What real data said, honestly:**

- **Zero anytime-TD props exist in the real capture tape.** All 100,944
  captured quotes are `player_pass_yds` / `player_rush_yds` /
  `player_reception_yds` / `player_receptions`, all from Underdog, which
  (per `prop-feeds.js`) carries no binary anytime-TD market. The clean,
  no-model-needed version of Step 4a has never run against a real quote.
- **The yards-only fallback that CAN run leans "Under" on 16/16 captured
  games this week, regardless of matchup.** A real per-game market
  inconsistency would not point the same direction on every unrelated
  game on the slate. This is the signature of a **systematic coverage bias**
  in the proxy — props only exist for the subset of players who got a
  line, which structurally undercounts a team's real offensive yardage —
  not a real market mispricing.
- **n = 2 real graded games this week**, both went Under, both "called
  correctly" by the biased-low proxy. Reported as exactly what a
  systematically-biased-low proxy produces when the real games happen to
  go Under, not as evidence the idea works. No confidence interval on n=2
  would exclude zero.

**Verdict: the mechanism runs correctly; the real data available right now
cannot validate the idea, and what data exists actively points at a
measurement bias in the fallback proxy, not a market signal.** Re-run
honestly once the anytime-TD feed exists or the yardage proxy is fixed to
capture a team's full offense, not just its propped subset.

---

## Stage 2 — Bottom-up team total from player projections (Step 4b)

**The idea:** aggregate Gridiron's own player-level fantasy projections
(usage × efficiency) into a team point total, and test whether that
bottom-up total tells the top-down spread ensemble anything it doesn't
already know — using a genuinely different data path (player-level
usage/efficiency projections vs. team-level efficiency components).

### What was built

- `server/services/bottom-up-team-total.js` — the aggregation, calibration,
  usage/efficiency ablation, and correlated Monte Carlo.
- `scripts/_prepare-validation-db.mjs` / `scripts/_bottom-up-team-total-worker.mjs`
  / `scripts/audit-bottom-up-team-total.mjs` — the walk-forward harness (see
  "How this was validated without touching the real database" below).
- One export added to `server/services/nfl-prop-correlation.js`
  (`conditioned`, no behavior change) so the correlation-matrix repair used
  by SGP pricing is reused verbatim, not re-derived.

### The mechanism

1. **Aggregation.** For a given (season, week) cutoff, `buildPlayerWeekEngine`
   gives every rostered offensive player's projected volume (attempts,
   carries, targets) and efficiency (ypa, ypc, ypt, catch rate, TD rates —
   the production numbers fantasy scoring and props already consume).
   `teamWeekEventExpectations` (already-shipped, cutoff-safe) reconciles
   those into one team's per-player event expectations. This module sums
   them: team passing yards from the team's QB(s), team rushing yards from
   every rusher, offensive TDs from every rushing + receiving TD across the
   roster — deliberately excluding receiving yards from the yardage sum,
   since a completion's yards are the same underlying yards as the passer's,
   not a second, additive quantity.
2. **Yards+TDs → points, calibrated on real box scores.** `player_week_usage`
   never sees field goals, defensive/special-teams scoring, or two-point
   tries — the same honest limitation Stage 1's yards→points fit carried.
   `fitTeamTotalCalibration` fits a two-predictor OLS (yards, TD count →
   real `game_lines.team_score`) on real 2021-2022 team-weeks, held
   strictly separate from the 2023-2025 test window.
3. **Correlation, not independent summation** (see below).
4. **Usage vs. efficiency ablation** (`teamBottomUpScenarios`): the same
   player list and the same production `eventExpectationFromVolume` math,
   run three ways — full (own usage, own efficiency), usage-nulled (own
   efficiency, touches spread evenly across teammates at the same role),
   and efficiency-nulled (own touches, position-average rate instead of the
   player's own). Nothing here is a new football model; only the inputs to
   the existing one change.

### The top-down ensemble's own total forecast is thin — extra context

Of the 31 models in `nfl-ensemble.js`'s `MODELS` array, only 5 ever produce
a non-null `total` at all (`dynamic_state`, `pace_total`, `weather_total`,
`market_anchor`, `market_regression`); the other 26 forecast margin only.
Two of those five are explicitly anchored to or regressed against the
market's own total line, leaving **3 genuinely independent total-forecasting
components** behind the ensemble's total — confirmed directly in a live
call (`ensembleLine(2023, 5, 'KC', 'DEN')`: `models_contributing_total: 3`
against `models_contributing_margin: 18`). The margin side of this ensemble
is deep; the total side is comparatively thin. That is a structural reason
a genuinely new total-focused signal has real room to be additive here,
independent of whether it turns out to be one.

### Why this is a genuinely different data path — and where it secretly isn't

`projections.js` anchors every player's attempts/carries/targets to
`teamVolume()` — a team-level, recency-weighted average of that TEAM's own
real pass/rush attempts. **The *pace* half of a bottom-up total is not
actually summed from players at all** — it's the same kind of team-level
historical rate the top-down ensemble's own team-efficiency components
already use. The genuinely player-level contribution is the
**roster-weighted efficiency blend**: this team's specific starting RB's
ypc, this specific WR1's catch rate — reacting to a roster change
immediately, rather than only after enough team-level box scores
accumulate. That's exactly what the usage-vs-efficiency ablation below was
built to isolate and measure, not assume.

### Correlation: reusing the archetypes, not reinventing them

`sampleTeamWeekEvents` (already shipped) gets teammate correlation right on
the **volume** side — attempts/carries/targets are drawn as one team-level
draw and then split, so teammates cannot collectively exceed the team's own
snap count. It does **not** correlate the **efficiency** draw:
`sampleAllocatedWeekEvents` draws each player's yards-per-touch and TD
binomial independently, so a real shared-game effect (this offense had a
big day; garbage time inflated every stat line) is invisible to it — the
exact "naive independent summation" failure mode named in the brief.

`teamBottomUpDistribution` fixes this by building a Gaussian copula over
exactly the legs that feed the final sum (one team passer's passing yards,
every rusher's rushing yards, every scorer's expected TD count), using the
**already-fitted `prop_correlation_estimates` table** (182 archetypes,
confirmed present in the real database — `propPairCorrelation`,
`samePlayerCorrelation`) and its own `conditioned()` PD-repair, the same
numerical treatment `sgpAnalysis` uses for same-game-parlay pricing. Every
trial is run twice — once through the fitted correlation matrix, once
through independent draws — so the "how wrong was naive summation"
question has a direct, measured answer rather than an assertion.

One stated approximation: no fitted archetype distinguishes rushing TDs
from receiving TDs — only the combined `anytime_td` market is ever quoted —
so that binary indicator's correlation is reused as a same-game co-movement
proxy for a continuous **TD-count** shock. This is documented in the code
at the point of use, not hidden in the number.

### How this was validated without touching the real database

Rule 4/5 forbid writing to `data.sqlite`, and `server/db/index.js` (which
`buildPlayerWeekEngine` and `ensembleLine` both depend on) opens whatever
`GRIDIRON_DB_PATH` points at **read-write** and runs schema migrations at
import time — so it can never be pointed at the real file. Rather than a
16 GB byte-for-byte copy of a live WAL database (13 GB main + 3.3 GB WAL as
measured this run), `scripts/_prepare-validation-db.mjs`:

1. Points `GRIDIRON_DB_PATH` at a brand-new file and imports
   `server/db/index.js`, which bootstraps the full current schema into it
   (safe — it's a file this script just created).
2. Opens the real database **read-only** (`node:sqlite {readOnly:true}`,
   the pattern Stage 1 already established) and logically copies every
   table under ~300K rows — 1,046,423 rows across 151 tables in 54s — into
   the new file. Excluded by design: `polymarket_*` / `prediction_market_*`
   / `mlb_*` and the largest quote/mutation-log tables (29.2M rows total
   across the DB; the 11 excluded tables alone are 28.1M of them and touch
   no code path this validation calls).

The real file is opened read-only exactly once, for `SELECT`s, and never
written. `scripts/audit-bottom-up-team-total.mjs` runs both steps in order
and is safe to re-run at any time.

### Walk-forward test design and its honest sample-size limit

`ensembleLine` re-fits the full walk-forward ensemble weight set from
scratch for every distinct (season, week) cutoff not already fit in-process
— measured directly against this validation database at **~4 minutes per
cutoff** before committing to a test design. A full 3-season × 18-week
sweep is 54 distinct cutoffs (~3.5 hours) — impractical for this pass, so
the test uses a **fixed, explicit sample: 3 weeks (early/mid/late season) ×
3 seasons (2023, 2024, 2025) = 9 cutoffs**, stated here rather than
discovered later. `buildPlayerWeekEngine` and the bottom-up aggregation
are not the bottleneck (~1s per week); only the ensemble comparison is
sample-limited, and the sample-size caveat below applies specifically to
the ensemble-vs-bottom-up RMSE comparison, not to the calibration fit
(n=1,052 real team-weeks) or the usage/efficiency ablation (every
team-observation in the test weeks).

In practice this ran faster than the estimate once `fitEnsemble`'s own
persistent fit-artifact cache and warm process state kicked in: the first
cutoff (2023 wk3, cold) took 309s; the remaining 8 took 45-95s each on that
first pass (~14 minutes total, 269 team-observations with a real final
score and a usable ensemble total — 0 skipped for missing ensemble output).
A second, fully-corrected re-run (after the bug fix below) reused
`nfl_ensemble_fit_artifacts`' persisted fits and finished in under 7 minutes
end to end, first cutoff included (23s) — the persistence layer works
across process restarts on the same validation snapshot, not just within
one.

### A bug found and fixed via this module's own consistency check

The first full run flagged itself: the "MC mean should match the
deterministic full points" consistency check `scripts/_bottom-up-team-total-worker.mjs`
prints reported a **6.6-point average gap**, not noise. Root cause:
`teamBottomUpDistribution` draws each leg as `Math.max(0, mean + sigma*Z)` —
yards and TD counts can't be negative — but that left-truncation-at-zero
clamp has a real, non-obvious property: `E[max(0, mean + sigma*Z)]` is
provably **greater than** `mean` whenever `sigma` isn't tiny relative to
`mean`, by exactly `mean*(Φ(mean/σ) - 1) + σ*φ(mean/σ)`. Applying a
starter-level, population-fit sigma to every player who touched the ball at
all — including thin-usage bench players whose own mean is small relative
to that sigma — inflated the simulated total by design, not by chance.

Two fixes, both now in `bottom-up-team-total.js`: (1) a player only gets a
stochastic leg when their own volume clears the SAME eligibility floor the
sigma was fit on (QB attempts≥20, RB carries≥8, WR/TE carries≥1) — a
thinner-usage player's mean is still counted, as a fixed baseline added
every trial, just not given a sigma from a population it doesn't belong to;
and (2) the exact closed-form excess above is now subtracted from every
leg's draw every trial, a constant per leg that corrects the location
without touching the variance or correlation structure this module exists
to measure. Verified: mean absolute gap between the Monte Carlo mean and
the deterministic total across all 288 team-weeks in the full test sample
fell from 6.601 to **0.199** (small-sample Monte Carlo noise, at 3,000
trials, against team totals with σ≈6). A regression test
(`test/bottom-up-team-total.test.js`) now guards this specifically, seeded
with a leg deliberately in the danger zone (mean close to its own sigma) so
it would have caught the original bug.

This bug affected only `teamBottomUpDistribution`'s reported mean — the
walk-forward RMSE, additive-value, and usage/efficiency results below all
come from `teamBottomUpScenarios`'s deterministic arithmetic (no clamp, no
Monte Carlo) and were correct before and after this fix. The variance
RATIO (naive-independent ÷ correlated) was also effectively unaffected: it
compares two runs that share the identical marginal bias, which cancels in
a ratio — 1.015 before the fix, 1.012 after, on the same underlying
question.

### Walk-forward accuracy vs. real final team score (n=269)

| Forecast | RMSE | MAE | bias |
|---|---|---|---|
| **Existing ensemble (top-down)** | **10.058** | 7.738 | -0.012 |
| Bottom-up FULL | 10.806 | 8.325 | +0.260 |
| Bottom-up USAGE-NULLED | 10.930 | 8.449 | +0.669 |
| Bottom-up EFFICIENCY-NULLED | 11.023 | 8.546 | +0.168 |

**The bottom-up total does not beat the existing ensemble** — RMSE 10.806
vs. 10.058, about 7.4% worse, on the same 269 real team-observations. It
is not neck-and-neck; the top-down ensemble is a meaningfully more accurate
team-total forecast on this sample.

`correlation(bottom_up_full, ensemble_total) = 0.345` — the two are related
but far from redundant. `correlation(bottom_up_full, actual) = 0.134`
against `correlation(ensemble_total, actual) = 0.405`: the bottom-up
total's own relationship to the real outcome is weak, well short of the
ensemble's.

**Additive-value check** (blend weight swept on this same test set — an
in-sample ceiling, not a forward-validated claim, stated as such in the
code and again here): the best blend weight found was **w=1 — pure
ensemble**. No mixture with the bottom-up total, at any weight from 0 to 1
in steps of 0.05, beat the ensemble alone on this sample. **This is a
clean negative on the "additive even if not independently better"
question** the brief asked to test for: on this data, at this sample size,
it is not additive either. The most likely reason, given the correlations
above: the bottom-up total's own signal-to-noise against the real outcome
(0.134) is too weak relative to its own error variance to improve a blend
with a component that already correlates with the outcome almost 3x as
strongly (0.405).

### Usage vs. efficiency: which one carries the (modest) skill?

| Ablation | RMSE moves by |
|---|---|
| USAGE-NULLED (equal split among teammates, own efficiency kept) | +0.125 |
| EFFICIENCY-NULLED (position-average rate, own touches kept) | +0.218 |

Both nulls make the total worse, as they should (removing real information
should not help) — and **nulling efficiency hurts about 1.7x more than
nulling usage does**. This directly confirms the honest caution the brief
asked to test: for a TEAM total specifically, the roster-weighted
EFFICIENCY blend carries more of this model's (modest) real skill than
knowing exactly which teammate gets how large a usage share. Both effects
are small in absolute terms (0.1-0.2 RMSE points against a ~10-11 point
baseline) — most of the bottom-up total's error is not explained by either
half of "bottom-up-ness"; it is explained by everything player-level
projections structurally cannot see (see next section).

### Correlation vs. naive summation: does it change the team total's variance?

Across the same 269 team-observations as the RMSE table: variance ratio
(naive-independent ÷ correlated) **mean = 1.011, median = 1.010** (a
broader all-teams sweep over the same 9 weeks, n=288, agrees closely:
mean=1.0115, median=1.0100, range 0.933-1.088) — a small, consistent net
UNDERSTATEMENT from naive summation, not a large one.

**This is a real, measured, and modest effect** — nowhere near the "badly
wrong" magnitude a same-game-parlay's 2-3-leg correlation multiplier can
produce (`sgpAnalysis`'s own note: a multiplier far from 1 is the SGP
mispricing signal). The likely reason is specific to summing MANY legs into
one team total rather than pricing a short parlay: with 8-21 legs per team
(median ~12) and each fitted archetype correlation typically modest in
magnitude, the relative variance contribution of the cross-terms is
diluted across the sum in a way a 2-3-leg product is not. **The mechanism
this module built — reusing the fitted archetypes via a proper copula
instead of assuming independence — is correct and now numerically verified
consistent (see the bug above); it simply found that, for THIS aggregation
specifically, the naive-vs-correlated gap is real but small, not large.**
That is itself the honest answer to "do not skip modelling this," not a
reason to have skipped it — the size of the effect was not knowable without
building and measuring it, and a ~1% variance-ratio finding is a materially
different (and more precise) claim than either "correlation is negligible
here" or "correlation matters a lot here" asserted without the number.

### Stage 2 verdict

The bottom-up team total is a real, working mechanism — correctly
correlation-aware (once its own consistency check caught and fixed the one
real bug), calibrated on genuine historical box scores (R²=0.75, n=1,052),
and it does isolate that its own modest skill is more about roster-specific
efficiency than usage allocation, exactly as theorized from `teamVolume()`
anchoring pace to a team-level rate in the first place. **On real
held-out games, it does not beat the existing top-down ensemble, and — on
this test's honest, stated sample size — does not improve a blend with it
either.** That is the more likely outcome the brief named up front, and it
is reported as such rather than reframed as a smaller win.

---

## Bottom line across both stages

Both stages found the mechanism sound and buildable, and both found the
headline idea unproven on the real data actually available right now —
Stage 1 for lack of the right market data (zero anytime-TD props captured),
Stage 2 on a real, run walk-forward test (bottom-up RMSE 10.806 vs. the
ensemble's 10.058, n=269 real games; best in-sample blend weight = pure
ensemble). Both are the more likely, still-valuable outcome the brief said
to expect, reported as such rather than reframed as a smaller win.

Concrete, reusable output beyond the two headline verdicts: Stage 1's
unanimous-direction bias diagnosis; Stage 2's usage-vs-efficiency ablation
(efficiency carries ~1.7x the skill usage does, for a team total
specifically) and its naive-vs-correlated variance-ratio measurement
(~1-1.5%, real but modest); and one concrete bug found and fixed by a
validation script's own built-in consistency check
(`teamBottomUpDistribution`'s clamp-induced mean inflation, 6.6 points
average → 0.2 after the fix) — which is what a consistency check is for.

**Files**: `server/services/props-total-consistency.js` (Stage 1),
`server/services/bottom-up-team-total.js` (Stage 2), one added export in
`server/services/nfl-prop-correlation.js` (`conditioned`, no behavior
change), `scripts/audit-props-total-consistency.mjs` /
`scripts/audit-bottom-up-team-total.mjs` (+ its `_prepare-validation-db.mjs`
/ `_bottom-up-team-total-worker.mjs` helpers), `test/props-total-consistency.test.js`
/ `test/bottom-up-team-total.test.js`.
