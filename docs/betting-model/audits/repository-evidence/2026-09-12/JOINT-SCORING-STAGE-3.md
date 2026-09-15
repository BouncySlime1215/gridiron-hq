# Stage 3 — Score-driven joint scoring model (Giant Plan 10.3 item 15)

**Verdict: the model works, the machinery is validated, and it DOES NOT CLEAR THE
STATED GATE. Do not ship it as a margin forecaster.**

**The one result worth keeping: it is decisively the best joint score
distribution available here, because it is the only joint score distribution
available here.**

Everything below is measured on a SYNTHETIC fixture. Nothing below is a
measurement of football. See "What this is not" at the end.

---

## What was built

`server/services/nfl-joint-score.js` — a score-driven (GAS) dynamic joint model
of both teams' scores, following Koopman & Lit (2015, JRSS-A 178(1)) in
structure and departing from it in one place that matters for the NFL.

**Implemented in JavaScript, not fitted offline in Python.** The brief allowed
either. JS was chosen for three reasons, in order of weight:

1. **The harness has to be shared to be fair.** The incumbent is replayed
   through stage 2's `walkForwardCombination` at production's weekly cadence. A
   Python fit exported as JSON could not be re-estimated inside that loop, so
   the challenger would have been handed one frozen parameter set while the
   incumbent refit every week — and any result would then be about the cadence
   mismatch rather than the models.
2. **The fit is cheap enough.** That is Koopman & Lit's own headline: the
   score-driven filter updates the latent strengths by a closed-form function of
   the observation, so one likelihood evaluation is a single forward pass with
   no integration, no particle cloud, no matrix inversion. Three season-boundary
   fits take about 210 seconds in Node.
3. **No new dependency.** The special functions needed (log-gamma, scaled
   modified Bessel, Panjer recursion, Nelder-Mead) are about 120 lines together.

### The modelling decision the literature gets wrong for the NFL

Soccer goals are worth one each, so goals are nearly Poisson. **NFL points are
not.** A team scores about 22.5 points a game with a standard deviation near
10.2 — variance roughly 104 against a mean of 22.5, overdispersed by a factor of
about 4.5. A Poisson fitted to POINTS would claim a standard deviation of 4.7
and be catastrophically overconfident about every margin and total it priced.

So the Poisson layer counts **scoring events**, and each event carries a value
from a fitted distribution over {1, 2, 3, 6, 7, 8}. The observed score is the
compound Poisson sum, with mean `lambda·E[V]` and variance `lambda·E[V²]`.

The value 1 is impossible in real football and is in the support deliberately:
it keeps the likelihood finite on any non-negative integer, and its fitted
probability is then a **self-diagnostic** of whether a data source is on the
football lattice at all. It earned its place immediately — see below.

Dependence enters as a shared scoring-event count (Karlis & Ntzoufras'
trivariate reduction), giving `Cov = lambda_c·E[V]²`. Note this differs
structurally from the textbook bivariate Poisson: there the shared shock cancels
exactly out of the margin, here it does not, because shared EVENTS still draw
independent VALUES. The same parameter that fattens the total therefore also
widens the margin. That turns out to matter — see the dependence test.

---

## The data problem, measured rather than asserted

The only populated database is off-limits to this session, and the repository
contains no other game-level score history (`test/fixtures/nfelo-games.csv` has
six rows and no scores). So both runs are on the synthetic fixture, exactly as
in stages 1 and 2.

But a score model cannot be evaluated on stage 1 and 2's fixture without saying
what that fixture's scoreboard actually is. Measured:

| | gaussian fixture | football fixture | real NFL |
|---|---|---|---|
| team score sd | 7.83 | 10.44 | ~10.2 |
| home/away score correlation | **−0.33** | **+0.097** | mildly positive |
| margin sd | 12.80 | 13.71 | ~13.5 |
| P(&#124;margin&#124; = 3) | **5.96%** | 8.38% | **15.08%** |
| P(&#124;margin&#124; = 7) | 4.93% | 7.57% | 9.03% |
| impossible scores (= 1) | **5** | 0 | 0 |

(Real NFL figures from `margin-distribution.js`, measured on 6,991 games
1999–2024.)

The default fixture draws a margin and a total from normals and splits them
between the two teams. That is fine for a margin model and was right for stages
1 and 2. For a SCORE model it is actively adversarial: the splitting arithmetic
makes the two scoreboards **negatively** correlated, there is no key-number
lattice, and five team-scores are values football cannot produce.

So `seedEnsembleFixture` gained a `scoring: 'football'` mode that scores through
a drive simulation instead. **It is a controlled pair**: the drive simulation
runs on its own PRNG stream and the Gaussian draws are still taken and
discarded, so features, weather and the market's noise term are bit-identical
between modes and only the scoreboard differs. `gaussian` mode is byte-identical
to the fixture before the option existed, which is asserted directly against
`git show HEAD:` — stages 1 and 2 are untouched, and their 54 tests still pass.

**The football fixture's remaining mismatch is stated because it cuts against
this model:** it concentrates on margin 3 about half as hard as real football
does (8.38% against 15.08%). Real teams play the scoreboard late; this generator
does not. That under-rewards a lattice-aware model, so the fixture is
conservative for the challenger, not generous.

---

## The model diagnosed the fixtures before anyone told it to

The fitted severity distribution, from scores alone:

| | P(V=1) | P(V=3) | P(V=7) |
|---|---|---|---|
| football fixture | **0.0002** | 0.435 | 0.535 |
| gaussian fixture | **0.154** | 0.696 | 0.001 |

On the football fixture it recovers the field-goal/touchdown split without being
told the rules. On the Gaussian fixture it puts 15% of scoring events on a value
football cannot produce and ~0 on touchdowns — it reports, numerically, that the
data is not football.

The shared shock does the same: `lambda_c` fits to 0.78–0.86 on the football
fixture and to 0.0002–0.0013 on the Gaussian one, where the true correlation is
negative and the model's floor is zero. **A model that returned a positive
dependence on independent data would be an artefact generator**, which is why
there is a test asserting it does not.

---

## Walk-forward results — 408 held-out games, 51 weekly cutoffs, 2022–2024

Both sides forecast the same games. The incumbent keeps its production WEEKLY
refit and keeps the market. The incumbent's predictive distribution is built by
recentring the empirical distribution of (actual − market) onto its point
forecast — which hands it the true error spread and the true integer lattice, so
the challenger gets no free win from being lattice-aware.

### Football-scoring fixture

| method | RMSE | MAE | CRPS | LogScore | cover-Brier |
|---|---|---|---|---|---|
| market (closing line) | 13.3108 | 10.4767 | 7.4904 | 4.1404 | 0.25069 |
| **incumbent (champion blend)** | **13.2701** | **10.4662** | **7.4703** | **4.1359** | **0.25021** |
| joint GAS, standalone | 13.3480 | 10.4108 | 7.4961 | 3.9936 | 0.24421 |
| joint GAS, no shared shock | 13.3480 | 10.4107 | 7.4912 | 4.0057 | 0.24414 |
| joint GAS + market anchor | 13.2033 | 10.3130 | 7.4147 | 4.0623 | 0.24540 |

### Gaussian-scoring fixture (the adversarial run)

| method | RMSE | MAE | CRPS | LogScore | cover-Brier |
|---|---|---|---|---|---|
| market | 9.8096 | 7.8125 | 5.5591 | 3.8809 | 0.25134 |
| **incumbent** | **9.8105** | **7.8142** | **5.5598** | **3.8809** | **0.25140** |
| joint GAS, standalone | 10.8653 | 8.6980 | 6.1387 | 3.8047 | 0.27570 |
| joint GAS + market anchor | 9.8033 | 7.8320 | 5.5433 | 3.7777 | 0.25117 |

---

## Does it clear the gate? No.

The research's stated gate is that it must clear the walk-forward / CRPS bar
against the champion before it ships.

**Standalone, on CRPS, it loses on both fixtures.** 7.4961 against the
champion's 7.4703 on the football fixture (DM\* +0.23, p = 0.82 —
indistinguishable, but losing); 6.1387 against 5.5598 on the Gaussian fixture
(DM\* +4.77, p < 0.0001 — losing significantly). It is beaten on RMSE on both.
That is the expected result and it is reported as the answer: **a market-blind
model is not a better margin forecaster than a market-anchored one.**

**Market-anchored, it is better on four of five metrics and clears none of them
after correction.** The shipping-gate p-values, all five:

| loss | DM\* | p | raw reading |
|---|---|---|---|
| squared error | −0.804 | 0.425 | indistinguishable |
| absolute error | −2.073 | 0.043 | anchored better |
| CRPS | −1.160 | 0.251 | indistinguishable |
| log score | −1.382 | 0.173 | indistinguishable |
| cover-Brier | −2.023 | 0.048 | anchored better |

Two of five land under 0.05. **Holm correction across the five kills both**: the
smallest p (0.0434) has to clear 0.05/5 = 0.01 and does not, so the procedure
stops at the first step and nothing survives. Five correlated tests on 408 games
producing two marginal hits is what chance produces. **This is not evidence of
an improvement and is not reported as one.**

The anchor weight itself is the more interesting number: fitted at 0.42–0.46 on
the football fixture and 0.11 on the Gaussian one. On data whose scoreboard has
football's shape, roughly 44% of this model's departure from the market is
worth keeping. That is a real signal — it is simply not large enough, on 408
games, to prove itself against a champion that is already nearly the market.

**Recommendation: do not ship this as a margin forecaster on this evidence.**

---

## The result that IS decisive: same-game dependence

Same marginals, shared scoring-event shock switched on versus off. Nothing else
differs, so this isolates the dependence exactly.

| loss | DM\* | p | verdict |
|---|---|---|---|
| **joint log score** | **−5.995** | **< 0.0001** | **dependent model better** |
| margin log score | −2.214 | 0.031 | dependent better |
| margin CRPS | +1.880 | 0.066 | independent slightly better |
| squared / absolute / cover-Brier | ~0 | > 0.89 | indistinguishable |

Two things follow, and the second is a cost, not a win.

1. **Modelling same-game dependence pays enormously for the JOINT
   distribution** — DM\* −6 is not a marginal result, it is the strongest
   finding in this stage. This is exactly motivation (a) from the brief:
   same-game correlation for teasers and parlays falls out of the model instead
   of being assumed away.
2. **The dependence slightly HURTS the margin.** Predicted in the module header
   before it was measured: unlike the textbook bivariate Poisson, shared events
   here draw independent values, so `lambda_c` widens the margin as well as the
   total. On the margin CRPS that costs about 0.005, at p = 0.066. Anyone using
   this for margins alone should set `lambda_c = 0`; anyone using it for a joint
   question must not.

**Against the champion, the joint log score cannot be computed at all** — the
comparison returns "too few paired observations" because the incumbent produces
no joint distribution. That is not a technicality, it is the structural gap: the
ensemble emits a margin, `margin-distribution.js` emits P(margin | spread), and
nothing in the tree emits P(home score, away score). This module is the only
thing that does.

**Calibration caveat, stated because it cuts against the model:** the model's
average implied same-game correlation is +0.178 while the football fixture
realises +0.097. It **overstates** the dependence by roughly 1.8x. Anyone pricing
a correlated parlay off this would over-correlate the legs. The likely cause is
the two-step severity estimator (pooling every team's scores absorbs
between-team variance into the severity distribution), and fixing it needs a
joint MLE over severity and dynamics together.

---

## What was NOT claimed, and two bugs the process caught

**Two "significant" results in the first run were nothing of the kind**, and the
guards now in `compareOn` exist because of them:

- With `lambda_c` fitted to 0.0013 on the Gaussian fixture, switching the shock
  off changed every loss in the ninth decimal — consistently signed, so
  clustered DM returned p = 0.0009 on a mean loss difference that rounds to
  zero. Now reported as "difference below numerical tolerance".
- The incumbent departed from the market in **exactly one of 51 weekly
  clusters**, making clustered DM a one-observation t-test in disguise; the tell
  was |DM\*| = 1.000 on all five losses at once. Now reported as "difference
  confined to 1 of 51 clusters". (That single-cluster figure independently
  reproduces stage 1's finding that the residual gate almost never opens.)

**One real bug in the model**, caught by a known-answer test rather than by any
backtest: `jointSummary` computed moments on the un-normalised truncated grid,
so an exactly independent pair reported a covariance of **+0.076 instead of 0**.
That number would have been published as this model's same-game correlation. All
derived laws are now renormalised over the grid, and the pre-normalisation mass
is kept as the truncation diagnostic. The grid truncation that remains is
measured, not assumed: at realistic NFL scoring rates it costs 0.26% of the
covariance, at an inflated 57-point rate 2.46%.

**Tests: 30, all passing.** The load-bearing ones are the identities — with unit
severity the compound machinery must reproduce the textbook bivariate Poisson
(max abs error 7.7e-15) and the Skellam (2.2e-16), and the GAS score must reduce
exactly to (observed − expected). The gradient is additionally checked by central
difference in the compound case, because a wrong gradient produces a model that
still fits and forecasts, just silently worse — the exact bug a passing backtest
does not catch.

---

## What this is not

**It is not a measurement of football.** Both runs are synthetic. The football
fixture is football-SHAPED — it shares a family with the model (both put points
on the {3, 7} lattice), so the model's respectable showing there is a control
proving the machinery works, **not** evidence it would beat anything on real
games. A generator built to have the property a model exploits will reward that
model.

The honest summary is: the code is validated, the fixture behaviour is
understood, and the question "is this a good NFL model" is untouched.

**The one command that answers the real question**, against the populated
database, on a copy, with the guards this session had to respect:

```
GRIDIRON_DB_PATH=/tmp/gridiron-readonly-copy.sqlite \
SCHEDULER_DISABLED=1 NODE_OPTIONS='--import ./test/offline-guard.mjs' \
node scripts/joint-score-report.mjs --test-seasons 2022,2023,2024
```

(no `--fixture`, so it reads whatever that database holds). Read
`scoring_descriptives` in the output first: if `score_correlation` is positive
and `abs_margin_mass_pct` shows ~15% at 3, the model is being asked a question it
was built for, and the numbers under it mean something.

## Files

- `server/services/nfl-joint-score.js` — the model
- `server/services/joint-score-backtest.js` — the walk-forward bake-off
- `scripts/joint-score-report.mjs` — the runner
- `test/nfl-joint-score.test.js` — 30 tests
- `test/helpers/seed-ensemble-fixture.js` — gained `scoring: 'football'`
- `docs/evidence/2026-09-12/joint-score-report-{football,gaussian}.json` — full
  reports including every held-out forecast, so this can be re-scored without a
  refit

Nothing is wired into `ensembleLine`, `marginPmf`, the teaser scanner or any
route, and a test asserts it stays that way.
