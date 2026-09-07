# Betting capability audit — full inventory and honest fantasy-transfer verdicts

**2026-09-07.** `server/services/` holds 114 files matching `^nfl-|^model-|^backtest|^prop-`,
plus roughly twenty more betting-side services that do not carry the prefix
(`line-shopping.js`, `sharp-lag.js`, `signal-latency.js`, `line-move-study.js`,
`odds-archive.js`, `book-feeds*.js`, `staking.js`, `shadow-ledger.js`,
`forward-ledger.js`, `football-first.js`, `nfelo.js`, `beat-the-close.js`,
`decision-basis.js`, `weekly-*.js`). Prior sessions this cycle audited three
slices of this for fantasy transfer — GBM preseason (`docs/PRESEASON_MODEL.md`),
team-strength features into spread/total (`docs/BETTING_PLAYER_ENGINES.md`), and
prop calibration. Nick's objection ("the betting model has so much more") is
correct. This is the full pass.

**Method.** Top-of-file rationale comments and exports for every file in each
cluster, cross-referenced against `docs/NFL_MODEL_STATUS.md`,
`docs/PROFITABILITY_PLAN.md`, `docs/PATH_TO_PROFIT.md`, `docs/MODEL_AUDIT_RUN_7.md`
and the live database. "Proven" means a walk-forward or CLV number exists and is
cited. Everything else is called unproven, including things that are
well-engineered.

**Standing conclusion this audit does not disturb.** Across 21–22 component
models and 15,096 closing lines, the market's margin RMSE is 12.66 and the best
model is 13.14; `corr(model edge, ATS outcome) = -0.005` over 1,424 games; a
ridge over all 18 independent components against the market residual returns
out-of-sample R² between -0.0025 and +0.0007 at every λ. Audit run 8 (2022–2025,
831 games, blind chronological) produced 113 selections at 49.1% and -5.52% ROI.
**Nothing in the betting apparatus has demonstrated prediction edge.** What it
has demonstrated is execution edge, one structural payout exploit, and a large
amount of genuinely good *measurement discipline*. That distinction decides
almost every verdict below: the transferable assets are techniques and
instruments, not models.

---

## Cluster 1 — Calibration / probability shaping

**Files.** `nfl-cover-calibration.js` (399), `nfl-total-calibration.js` (398),
`nfl-prop-calibration.js` (397), `nfl-sim-calibration.js` (144).

**What it is.** Three of the four share one technique: the **market-anchored
logistic offset**, `sigmoid(logit(market) + b0 + b1 * edge/7)`, fitted with an L2
penalty λ pulling both coefficients to zero. The design property that makes it
defensible is stated explicitly in `nfl-total-calibration.js`'s header: at
`b0 = b1 = 0` the model reproduces the market *exactly*, so it can only ever match
the anchor or lose gracefully by fitting noise — it structurally cannot
manufacture an edge that is not there. Isotonic regression and plain temperature
scaling were considered and rejected for the totals market for exactly that
reason (they have no such fixed point).

`nfl-prop-calibration.js` is a different and more elaborate design: a
**chronological candidate registry**. Twelve global candidate families
(intercept, Platt, beta, isotonic at 25/50 bins, histogram at 5/10/15/20 bins,
each at two shrinkage strengths) are fitted on completed earlier seasons,
*selected* on a later discovery season, and must repeat on a sealed validation
season before becoming active. Redundancy pruning and Holm multiplicity control
stop the large library from manufacturing confidence. Non-surviving heads stay in
shadow rather than being deleted.

**Proven?** Partly, and the honest split matters.

- The technique is **load-bearing in production**: `NFL_PRODUCTION_POLICY`
  (`nfl-policy.js`) sets `requireCalibratedAdvantage: true`, so no spread pick
  publishes until `calibratedCoverProbability()` shows an out-of-sample
  improvement over the no-vig market. The gate works — it is why the spread model
  is not staking.
- The **defect it was built to fix is measured**: the TD prop model is over-
  confident by 10–13 points through the middle of its range (predicted 54.7% →
  actual 41.9% on n=1,211; 64.8% → 52.5% on n=904), and the miscalibration is
  monotonic, which is precisely the shape a Platt/isotonic fit corrects
  (`NFL_MODEL_STATUS.md`).
- What is **not** proven is that calibration produced profit. It has never
  converted a losing market into a winning one, and the docs never claim it did.
  Its demonstrated value is as a *gate*, not as an edge.

**Fantasy transfer verdict — REAL CANDIDATE, the strongest in this audit.**
`preseason-model.js` ships a `p20`/`p80` band on every board projection, and that
band is built (lines 755–792) from **quantiles of `actual / predicted` on the
training seasons**, banded by position × draft tier. That is an in-sample
residual spread. `docs/PRESEASON_MODEL.md` documents the band's construction and
its tiering rationale but reports **no out-of-sample coverage number anywhere** —
nobody has ever checked whether the 60% nominal p20–p80 interval actually covers
60% of held-out outcomes. Fantasy season outcomes are strongly right-skewed
(a bust floors at zero, a breakout has no ceiling) and the ratio-quantile
construction is the one part of the pipeline that could plausibly be badly off
without any existing test noticing. The prop registry's machinery — fit on
earlier seasons, select on discovery, repeat on sealed validation, Holm-correct
the library — is domain-agnostic and applies to interval coverage as directly as
it applies to a probability. The market-anchored *offset* form does not transfer
(there is no per-player probability market to anchor to on a draft board), but
the registry does.

---

## Cluster 2 — Ensemble / specialist / council architecture

**Files.** `nfl-ensemble.js` (1,263), `nfl-specialists.js` (619),
`nfl-orthogonal-specialists.js` (278), `nfl-matchup-specialists.js` (248),
`nfl-passing-specialists.js` (251), `nfl-context-heads.js` (209),
`nfl-expert-council.js` (923), `nfl-expert-coordinator.js` (448),
`nfl-specialist-audit.js`, `nfl-coordination-audit.js`, `nfl-unified-engine.js`.

**What it is.** Four architecturally distinct things, often conflated:

1. **Diverse ensemble** (`nfl-ensemble.js`): ~20 deliberately different rating
   models (Massey, Colley, Pythagenport, margin-Elo, market anchor), weighted
   exponentially in held-out RMSE, with disagreement reported as confidence.
2. **Residual specialists** (`nfl-specialists.js`): every specialist predicts the
   *market residual*, so "I know nothing" = predict zero = "the market is right",
   which is the correct default. A meta-model learns **context-dependent** weights
   (believe the trenches model in short-yardage, fade the passing model in wind).
   Includes a `permutationTest` that re-runs the whole pipeline on shuffled
   outcomes — if the architecture reports signal where none can exist, its
   verdicts on real data mean nothing.
3. **Orthogonal specialists** (`nfl-orthogonal-specialists.js`): not votes. In a
   fixed declared order, each family learns only the error left by the market
   *and all earlier families*. Negative incremental value stays visible but
   contributes zero weight.
4. **Council + coordinator** (`nfl-expert-council.js`, `nfl-expert-coordinator.js`):
   one weekly auditable contract per approach. Each expert emits opinion,
   coverage, uncertainty and authority *separately* — a missing expert does not
   silently become zero. The coordinator is a week-balanced Huber ridge with
   coefficient caps (`MAX_WEIGHT = 0.35`, `MAX_TOTAL_INFLUENCE = 0.8`), an
   explicit missingness mask, and family-level shrinkage so a duplicated model
   family cannot take over the answer.

**Proven?** **No, as edge — clearly and repeatedly.** Audit run 8's specialist
table: rulebook 46.24%, player builder 51.42%, game replay 46.91%, similar games
48.71%, boosted tree 51.60%, neural residual 51.70%, specialist team 49.04%; four
specialists had *zero* historical coverage (line movement, verified-news
reaction, live updater, price shopper). Component agreement was 50.63% vs 45.45%
scattered, `z = 0.50` — noise. `NFL_MODEL_STATUS.md`'s test 4 shows no linear
combination of components beats the line at any regularisation strength. The
ensemble's own best member is the one that copies the market (12.66 RMSE, tying
the close).

**Fantasy transfer verdict — MOSTLY ALREADY DONE; ONE PIECE LEFT.** This is the
one cluster fantasy has already harvested: `fantasy-coordinator.js` explicitly
copies `nfl-expert-coordinator.js`'s machinery (walk-forward split-half shrinkage,
correlation-based family de-duplication, week-clustered Huber ridge with weight
caps) keyed by player-week instead of game, with the structural projection
playing the role the market line plays on the betting side. Contextual regimes
were subsequently ported too. So "does fantasy have anything like this" — yes, at
the weekly-projection layer. **The unported piece is the orthogonal/sequential
residual ordering**, which is a genuinely different idea from weighted voting:
force each fantasy signal family to explain only what the previous families left
over, in a declared order, so a family that is merely a re-expression of an
earlier one earns zero by construction rather than by a correlation prune. Given
that "the new signal duplicated an existing one" is the documented cause of death
for most fantasy candidates (`nfl-teammate-competition.js`'s header names it
outright; `docs/OFFSEASON_MODEL.md` adopted 0 of 39), this is a plausible
structural fix rather than another feature. It is candidate #4 below, ranked
below the others because the payoff is cleaner attribution rather than new
information.

**No transfer** for the ensemble-of-rating-systems idea itself: there is no
fantasy analogue of "twenty independent ways to rate a team", and
`weekly-ensemble.js` (5 convex heads, weights frozen on 2023, architecture
selected on 2024, evaluated once on 2025) is already the right size for the
problem.

---

## Cluster 3 — Signal reliability, risk management, abstention

**Files.** `nfl-signal-reliability.js` (174), `nfl-risk-lab.js` (526),
`model-signal-quality.js` (171), `nfl-abstention-audit.js` (195),
`confidence-tier.js` (93), `model-governance.js`, `nfl-model-watch.js` (153),
`nfl-experiments.js` (182), `nfl-slice-diagnostic.js` (148).

**What it is.** The discipline around *knowing when not to act*, and it is the
most intellectually serious part of this codebase.

- `nfl-signal-reliability.js` is **shrink-only by construction**: it can never
  increase a component's authority, only shrink one after ≥32 frozen,
  independently settled forward examples across ≥4 weeks show both directional
  harm and worse squared error than the market. It cannot search for a profitable
  slice.
- `nfl-abstention-audit.js` scores **the road not taken**. The production policy
  abstains constantly (it declined all 16 games in the current week), and every
  refusal is a labelled counterfactual sitting ungraded in `replaySeason`'s return
  value. The module is explicit that it CAN say "this abstention rule declined
  bets that would collectively have beaten break-even" and CANNOT say "relaxing
  the rule is +EV going forward" — a hypothesis for a walk-forward test, never a
  licence.
- `model-signal-quality.js` decomposes uncertainty into 13 named layers across
  four kinds (data quality, state, parameter, context, aleatoric, epistemic), so
  "we don't know" is separable into "the data is missing", "the role is unstable"
  and "football is random".
- `confidence-tier.js` implements per-decision calibrated confidence from Brill/
  Yurko/Wyner (arXiv:2406.16171, arXiv:2311.03490 — only ~30% of real fourth-down
  decisions warranted high confidence; naive PBP bootstraps achieve ~60% actual
  coverage against a 90% nominal target).
- `nfl-model-watch.js` encodes the governance rule with the cleanest empirical
  justification in the repo: **the loop can propose and cannot approve.** Across
  564+ candidate/target combinations, 9 of 11 serious candidates were rejected —
  and *two of them (age and injury) passed isolated out-of-sample validation with
  clean confidence intervals and still degraded the shipped pipeline*, caught only
  by A/B ablation. An auto-promoting loop would have shipped both.

**Proven?** The *instruments* are proven; the abstention rule they police is
proven correct in one direction only. `NFL_MODEL_STATUS.md` shows selectivity
actively backfires on a zero-signal model: top-1 picks 47.9%, top-2 47.8%, **top-3
45.1% (z = -2.42, significantly below break-even)**, all-games 51.0%. The
conviction picks are the *worst* picks. Confidence buckets show no trend (51.7%,
48.9%, 54.7%, 50.0%, 46.6%, 56.0%). So the discipline is validated as protective
(governance branch cut 798 bets to 203) and falsified as a source of edge.

**Fantasy transfer verdict — REAL CANDIDATE.** `confidence-tier.js` is imported by
exactly three files: `fantasy-coordinator.js`, `nfl-expert-coordinator.js`,
`routes/nfl-betting.js`. It reaches the weekly projection and nothing else. A grep
for `abstain|abstention` across `server/services/` returns 32 files, **every one of
them betting-side or shared-infrastructure** — `draft-assist.js`,
`draft-lookahead.js`, `trade-engine.js`, `waiver-brain.js`, `lineup-brain.js` and
`league-brain.js` have no abstention concept at all. The draft board ranks every
player with the same visual authority whether the model has three seasons of
usage history or is extrapolating a rookie from draft capital alone; the trade
engine returns a title-odds delta with no notion of "this comparison does not
deserve a confident call". The betting side already proved that measuring the
counterfactual of a refusal is cheap when the harness already grades rejected
candidates — and `docs/DRAFT_AUDIT_2021_2025.md` grades every ECR slot 2021–2025,
including the ones a board would decline to recommend. This is the closest thing
to a free instrument in the audit.

---

## Cluster 4 — Market microstructure and information latency

**Files.** `nfl-sharp.js` (302), `sharp-lag.js` (250), `signal-latency.js` (277),
`nfl-news-market-latency.js` (125), `nfl-tweet-line-correlation.js` (167),
`nfl-espn-line-watch.js` (233), `nfl-opening-lines.js` (347),
`line-move-study.js` (454), `nfl-quote-tape.js` (249), `odds-archive.js`,
`nfl-execution-edge.js` (400), `line-shopping.js`, `nfl-clv.js` (335),
`nfl-devig.js` (121), `news-lag-trader.js` (248).

**What it is.** The most valuable cluster in the betting model, and the reframe
that saved the project: **stop grading forecasts against outcomes and start
grading signals against subsequent market movement.** `signal-latency.js` states
it plainly — edge is not "we predict better", it is "we knew at 14:02 and the
number did not move until 14:40" — and that question is answerable in hours
rather than seasons. `sharp-lag.js` measures how long each soft book takes to
follow a Pinnacle move and what the stale number is worth in the interval.
`nfl-espn-line-watch.js` is a nice piece of engineering economics: ESPN's free
unlimited DraftKings line detects *that* the market moved, so the metered Odds API
is spent only on events where a multi-book snapshot buys new information.

**Proven?**

- **Execution edge — the strongest proven number in the entire betting apparatus.**
  In one 272-event snapshot across 6.4 books/market, spread lines differ by
  **0.813 points on average**, 37.5% of markets differ by ≥1 full point, and
  best-price selection is worth **2.566% per bet** — moving break-even from 52.38%
  to ~51.1% with no forecasting skill whatsoever. A second measurement on 652
  multi-book markets: books disagree on the number 20.9% of the time, mean gap
  0.225 points, best price worth +0.019 decimal (~1.5–2.5% ROI).
- **Sharp divergence — instrumented, unproven.** A first live run found 19
  recreational numbers stale against the sharp consensus across 272 games, largest
  worth ~4.2%. `sharpScorecard` exists to falsify it via CLV; no forward result
  yet.
- **Latency itself — unmeasured, by data absence.** Audit run 8 shows "Line
  movement 0% coverage, historical quote tape unavailable" and "Verified-news
  reaction 0% coverage". Multi-book snapshots only start 2026-08-05, and 498 of
  500 September Odds API credits were burned in 29 hours by the MLB capture, so
  Weeks 1–4 have no paid multi-book quotes at all.

**Fantasy transfer verdict — REAL CANDIDATE, and the check has never been run.**
The fantasy analogue is exact: ECR/ADP is a market, beat-writer reports and depth
chart changes are the news, and "how fast does the consensus reprice" is the same
question `nfl-news-market-latency.js` asks of a bookmaker. **The data problem the
betting side could not solve is already solved on the fantasy side.**
`nfl_historical_adp` is sourced from dynastyprocess `db_fpecr.csv.gz`, which the
`historical-adp.js` header documents as **1.5M+ rows of real weekly FantasyPros
scrapes July–September for every season 2021–2025**. That is a genuine intraseason
price series — the exact archive betting has been trying to build since 2026-08-05
and lacks for every prior season. The local table currently collapses it: 2,914
rows total, one row per player-season (`latestByKey` keeps only the newest scrape),
giving 597/596/579/619/523 players and 10/10/9/9/6 distinct scrape dates per
season — enough to prove the multi-scrape structure survives to the CSV, not
enough to measure a move. Re-ingesting *all* scrape dates instead of the latest one
is a change to one function, and it turns preseason ECR into a movement archive
with five years of history. Nothing anywhere in `docs/` has asked whether ECR
reprices a beat-writer report in a day or a week, or whether a player whose ECR is
still moving on draft day is systematically mispriced.

Note the boundary against work already in flight: the ADP-disagreement test
running separately is *cross-sectional* (ESPN vs Sleeper vs FFC at one instant —
line shopping). This is *temporal* (one source's own reprice velocity — latency).
They share a motivation and share no code, data shape, or hypothesis.

**No transfer** for `nfl-devig.js` (Shin's method corrects favourite-longshot bias
in two-sided bookmaker prices; ECR has no vig and no two-sided price) or for
`nfl-clv.js`'s ledger form (CLV needs a *closing* price; a draft has a clearing
price only for the player you actually took).

---

## Cluster 5 — Simulation

**Files.** `nfl-drive-sim.js` (1,280), `nfl-sim-learn.js` (486),
`nfl-sim-policy.js` (618), `nfl-sim-calibration.js` (144).

**What it is.** Genuinely the most sophisticated modelling in the repo. It does
not predict a margin; it **plays the game** — downs, distance, field position,
clock, timeouts, fourth-down decisions, two-point charts, overtime — thousands of
times, and the score distribution is what happened. Four properties its header
claims, all real: (1) a **joint** distribution over both teams' scores, so
moneyline/spread/total are read off the same simulated games and cannot
contradict each other; (2) totals **correctly correlated with margin** — a
shootout raises both scores at once, which a margin model structurally cannot say;
(3) discrete lumpy scoring that reproduces the key-number pile-ups at 3 and 7 that
a normal curve never will; (4) every input is a measurable team rate, so a wrong
answer is traceable to a wrong rate. `nfl-sim-learn.js` supplies empirical-Bayes
shrunk team rates (shrinkage fitted from the actual within- vs between-team
variance, not chosen by hand) and computes the expected-points surface by **value
iteration on the engine itself**, making EP self-consistent with the simulator
that consumes it. `nfl-sim-policy.js` adds 20 game-theoretic decision modules,
each tagged `literature` / `measured` / `derived` so borrowed results are never
passed off as findings.

**Proven?** **No.** Audit run 8: game replay 46.91% directional (100% coverage),
`MODEL_AUDIT_RUN_7.md` 48.32% at 13.048 margin error — "simulation is coherent but
not sufficiently accurate", and the standing action item is "repair the
simulation". `nfl-drive-sim.js`'s own header refuses the claim: calibration
against real NFL score distributions is a floor, not an edge.

**Fantasy transfer verdict — NO TRANSFER OF THE ENGINE; THE PRINCIPLE IS ALREADY
IN THE REPO, ON THE FANTASY SIDE, UNUSED WHERE IT MATTERS.** A play-level drive
engine has no player-season analogue — you cannot simulate 17 games of snaps to
decide a second-round pick. But `docs/RESEARCH_OPEN_SOURCE_FANTASY.md` flagged
that `draft-lookahead.js`'s Monte Carlo (200 sims × 6 candidates) probably uses
symmetric independent draws and named an outside GitHub repo as prior art. Reading
the file, **that flag understates the problem**: `draft-lookahead.js` has no
player-outcome draws *at all*. Its only stochastic element is draft order
(`pickOpponent` sampling opponents by noisy market rank); every candidate roster is
scored through `rosterValue(...)` on deterministic `projected_points`, and the `sd`
it reports (line 191) is the spread of *who else got drafted*, not of how anyone
performed. So the answer to "does betting's own sim already solve this" is: no, but
`correlation.js` and `season-sim.js` do. `correlation.js` fits archetype-level
correlations (position A × position B × same-team|opponents, tens of thousands of
observations per archetype so it generalises to pairs that have never played
together) and draws through a **Gaussian copula**; `season-sim.js` already uses
exactly that machinery to play out 10,000 fantasy seasons. The right move is to
draw candidate rosters through the existing copula, with per-player marginals taken
from the preseason model's (right-skewed, ratio-based) `p20`/`p80` band rather than
its point estimate — an in-repo wiring job against proven components, not an
import from an unlicensed outside repo. Note the dependency: this is only as good
as the band, which is candidate #1's subject.

---

## Cluster 6 — Context and situational models

**Files.** `nfl-weather.js` (144), `nfl-weather-history.js` (141),
`nfl-officials.js` (234), `nfl-coaches.js` (125), `nfl-scheme.js` (254),
`nfl-team-tendencies.js` (181), `nfl-teammate-competition.js` (211),
`nfl-opponent.js` (154), `nfl-spread-context.js`, `nfl-formations.js`,
`nfl-player-context.js`.

**What it is, and the important finding.** `docs/RESEARCH_OPEN_SOURCE_FANTASY.md`
lists weather, officials and OC/scheme history as fantasy-side gaps, with
"OC/scheme history: no free per-season feed (known gap)" and weather ranked as
low-value item 10. **The data-sourcing problem is already solved locally, for all
three**, which that research pass did not check:

| Signal | Source solved by | Live table | Rows |
|---|---|---|---|
| Kickoff-hour weather | `nfl-weather.js` — Open-Meteo free archive, 32 stadium lat/lon embedded, domes flagged so a wrong roof flag cannot fetch weather | `nfl_game_weather` | 772 |
| Forecast *as it was known* N days out | `nfl-weather-history.js` — Open-Meteo previous-runs API, leads 0/1/2/3/5, verified live (BUF 2024-11-17: lead0 12.7 / lead2 11.9 / lead5 21.4 km/h vs actual 9.2) | not yet materialised | — |
| Referee crews | `nfl-officials.js` — nflverse, every official every game back to 2015 | `nfl_officials` | 22,012 |
| Head coach per team-season | `nfl-coaches.js` — `nfldata/games.csv` `home_coach`/`away_coach` back to 1999; explicitly corrects an earlier "unavailable" finding in `WORK_LOG.md` | via nflverse | 1999+ |
| Scheme identity / change | `nfl-scheme.js` — reconstructs a coordinator change as a **discontinuity in neutral-situation play-calling** (`off_neutral_pass_rate`, `off_proe`), 2016–2025, all 32 teams — deliberately measuring the behaviour rather than the name, since a staff that changes name while keeping the system should not move a projection | `nfl_team_week_features` | 5,363 |

**Proven?** Mixed, and mostly negative — which is itself the useful information.

- **Officials: null result.** `crewOverRates` corrects significance for having
  examined every crew (~17 crews, so a Bonferroni-style corrected threshold), and
  the reported verdict is that no crew's over rate clears it. The folklore does
  not survive the correction.
- **Weather/opponent into player stats: already tested on this data, failed
  badly.** `nfl-opponent.js`'s header reports that `nfl-context-heads.js`'s 80
  defense-vs-position variants got **monotonically worse** as weight increased —
  passing-yards MAE 70.56 at weight 0 rising to 90.81 at weight 1, on every stat.
  The diagnosis is double-counting: `gameScriptFor` already shifts volume using
  the betting line, and the line already prices the opponent, so an opponent
  multiplier applies the same information twice with no shrinkage between.
- `nfl-context-heads.js` swept ~200 weight/shrinkage variants of opponent, weather,
  rest and home/away through the full discovery → redundancy prune → paired
  significance → Holm → sealed validation pipeline: **zero survivors**, consistent
  with `player-head-registry.js`'s 24 heads / zero survivors across all four prop
  stats.

**Fantasy transfer verdict — NO TRANSFER for weather; ONE LIVE CANDIDATE for
scheme.** Weather is correctly ranked near zero for season-long fantasy (a
17-game projection averages weather away) and has now failed twice on weekly
player stats in this database; re-testing it would be re-running a known negative.
Officials is a measured null on totals and has no plausible player-level channel.
**Scheme is different**, and the reason is specific: `docs/OFFSEASON_MODEL.md`
tested 39 additional variables against fantasy outcomes and adopted none, but the
offseason model's team-change features are about *the player's* move — they have
no variable for "the offense he stayed on changed its identity underneath him".
That is precisely the case `nfl-scheme.js` was built to detect and is exactly what
a blunt `seasonDecay = 0.05` cannot express (`nfl-offseason-change.js`'s header
makes the same complaint: heavy decay distrusts a returning three-year starter
exactly as much as a player who changed teams). The data is local, cutoff-safe,
and spans 2016–2025. Its weakness as a candidate is that PROE discontinuity is
plausibly already visible in the player's own prior-year usage, which is the
documented cause of death for most candidates here — so it is ranked fifth, not
first.

---

## Cluster 7 — Neural and online learning

**Files.** `nfl-online-neural.js` (403), `nfl-neural-replay.js` (212),
`nfl-risk-lab.js` (526), `model-intelligence.js` (147), `nfl-model-growth.js` (297),
`nfl-model-watch.js` (153).

**What it is.** A prequential online learner: the network sees a game only through
a feature vector frozen before kickoff, **scores an entire completed week with the
old weights, and only then updates** — that ordering is the difference between an
online learner and a backtest that teaches on its own answers. It cold-starts at
zero residual, so its first predictions equal the market. `nfl-risk-lab.js` runs
four deliberately more ambitious challengers (five-member deep ensemble, Bayesian
online regressor with predictive uncertainty, contextual mixture-of-experts over
model families, multi-task encoder with masked spread/total heads).

**Proven?** **No — and the repo says so in its own words.** Every one of these is
"permanently locked to zero staking units until their own weekly-clustered forward
gates pass": ≥128 forward games across ≥8 weeks with the lower bound of the
week-clustered MAE improvement interval clearing zero. `NFL_MODEL_STATUS.md`:
"This makes the model adaptive. It does **not** prove an edge." In audit run 8 the
neural residual specialist posted 51.70% directional on 98.07% coverage — nominally
the best rate on the board and statistically indistinguishable from a coin flip at
that sample, on a selection set that lost 5.52%.

**Fantasy transfer verdict — NO TRANSFER, and this reinforces the existing stance
rather than undercutting it.** Repo memory records neural approaches on the
fantasy side as "asked for; not earned", on the grounds that no tabular model has
beaten the market yet so a neural one is unjustified. The betting side is the
natural place to look for a counterexample, because it has far more data
(15,096 games, 52,231 player-weeks), a harder-nosed harness, and years of
investment in exactly this. It has not produced one. Every neural artefact there
is shadow-only by policy, and the one number it has posted is inside noise. Say it
plainly: **the betting model's neural work is evidence for the fantasy stance, not
against it.** The one genuinely portable idea in this cluster is not neural at
all — it is `nfl-model-watch.js`'s "propose, cannot approve" governance and the
564-candidate / 2-false-positive record behind it, which the fantasy side already
follows in practice through the sealed-holdout convention in `PRESEASON_MODEL.md`
and `OFFSEASON_MODEL.md`.

---

## Cluster 8 — Everything else worth naming

**`nfl-teasers.js` (169) — PROVEN, and the only defensible +EV bet in the repo.**
1,391 qualifying Wong legs, 1999–2025, **74.69% win rate, SE 1.17pp**; at -110
break-even is 72.37%, `z = 1.99`, EV **+6.51%**; at -130 it is **-1.29%**. Stable
across eras (leave-one-era-out keeps it in 73.94–75.68%). It predicts nothing — it
exploits the fact that a 6-point teaser costs the same whether it crosses both key
numbers (3 occurs in 15.12% of 7,276 games, 7 in 9.03%) or neither. *No fantasy
transfer*: the edge is a mispriced fixed payout against a lumpy outcome
distribution, and fantasy has no fixed-payout instrument. The transferable habit —
find the place where a counterparty prices a distribution with a flat haircut — is
real but has no concrete fantasy target that this audit could identify.

**`nfl-prop-correlation.js` (401) — the SGP thesis.** A book can price every leg
fairly and still misprice the combination, because SGP pricing is usually a blanket
correlation haircut rather than a real joint distribution; that gap survives even
when our marginals are no better. *No fantasy transfer needed*: `correlation.js`
already fits archetype correlations on fantasy points and `season-sim.js` already
consumes them. Fantasy got there first.

**`nfl-slice-diagnostic.js` (148)** — accuracy and calibration by season, week,
matchup type, market, specialist, confidence bucket and coverage bucket, with a
`MIN_SLICE_SAMPLE = 30` read floor and 2021 quarantined for corrupt captures.
Modest but genuinely transferable: the draft board has never been graded by round ×
position slice with an explicit floor below which a rate is not allowed to become a
sentence. Folded into candidate #2 rather than listed separately.

**`decision-basis.js` (348)** — reconstructs *why* a pick was made from the
numeric component contributions, by template, deterministically and free, rather
than paying an LLM per pick for a non-reproducible explanation. Directly relevant
to how the draft board explains itself; not a modelling candidate.

**`nfl-experiments.js` (182), `nfl-blind-audit.js` (1,068), `model-governance.js`,
`nfl-evidence-provenance.js` (62)** — immutable preregistered experiments with
chronological disjoint discovery/validation/holdout and a holdout that opens once;
content-addressed week-at-a-time replay that refuses to open week N+1 if code,
inputs, registry or policy changed; feature contracts with staleness and leakage
risk; a provenance walker that flags any timestamp inside a "pregame" payload that
postdates the cutoff. Best-in-repo process. Already the convention on the fantasy
side in spirit; no discrete test to propose.

**`nfl-quote-tape.js`, `book-feeds*.js`, `staking.js`, `nfl-execution.js`,
`nfl-teaser-execution.js`, `nfl-shopping-board.js`, `nfl-user-bets.js`,
`nfl-live*.js`, `nfl-pregame.js`, `nfl-auto-picks.js`, `prop-feeds.js`,
`polymarket*.js`, `parlay-api.js`, `odds-api.js`, `sportsgameodds.js`** —
execution, feed and ledger plumbing. Real engineering, no fantasy-transferable
technique. Staking's one finding is worth recording though: flat 1u beats
fractional Kelly below ~55% win rate, and at zero edge Kelly correctly stakes
zero, which is why the abstention gate matters more than any sizing rule.

**`nfl-rookies.js` / `nfl-rookie-ingest.js`, `nfl-qbr.js`, `nfl-external-ratings.js`,
`nfelo.js`, `nfl-transactions.js`, `nfl-player-state.js`, `nfl-availability.js`,
`nfl-roster-strength.js`** — data and feature substrate. Several already feed
fantasy through `player-week-engine.js`; `docs/BETTING_PLAYER_ENGINES.md` covered
the reverse direction (fantasy → betting) and found it blocked both markets.

---

## Ranked transfer candidates

Five, ordered by expected information per unit of work. Each is evaluated on the
2021–2025 real-outcomes panel behind `docs/DRAFT_AUDIT_2021_2025.md` (2,182
matched ECR player-seasons, top-150 coverage 148–150 per season, actuals
recomputed from `nfl_player_week_features` and validated at r=0.9987 vs ESPN
season totals and r=0.9999 vs nflverse ffopportunity), with
`pairedBootstrapDiff` from `server/services/backtest-significance.js` — clustered
by season where units within a season share market and injury conditions — and the
repo's standing **≥2-of-3-held-out-seasons-significant** bar.

### 1. Out-of-sample calibration of the preseason p20/p80 band
*From `nfl-prop-calibration.js`'s chronological candidate registry.*

**Hypothesis.** The `p20`/`p80` band is fitted as in-sample `actual/predicted`
ratio quantiles per position × tier and has never been coverage-tested out of
sample. Held-out coverage will deviate materially from the 60% nominal, and a
registry-selected recalibration will fix it.

**Test.** For each held-out season T ∈ {2023, 2024, 2025}: fit the band on ≤ T-1,
score interval coverage and pinball loss on T's top-150. Sweep the prop
registry's candidate families adapted to quantiles (intercept shift, Platt on the
ratio, beta, isotonic-25/50, histogram-5/10/15/20, each at shrinkage 1 and 10),
select on the discovery season only, seal validation. `pairedBootstrapDiff` on
per-player pinball loss, calibrated vs raw, clustered by season. Pass = the
difference interval excludes zero in ≥2 of 3 seasons **and** held-out coverage
lands inside 55–65%. Kill = coverage already inside 55–65% raw (band is fine,
close it) or no candidate clears Holm.

**Why first.** It is the only candidate that tests something already shipping and
visible to Nick on every board row, it needs no new data, and candidate #3 depends
on the answer.

### 2. An abstention/confidence gate for the draft board, audited against 2021–2025
*From `nfl-abstention-audit.js` + `confidence-tier.js` + `nfl-slice-diagnostic.js`.*

**Hypothesis.** Board recommendations are not uniformly reliable, and the
unreliable ones are identifiable *before* the pick from coverage-side facts —
missing prior-season usage, rookie with no history, `has_projection = 0`,
wide `p20`/`p80`, thin `rank_std` agreement. A gate that declines to make a
confident call on those slots will show a materially better realized-VORP+ record
on the slots it does keep.

**Test.** Define the gate on pre-outcome features only. Replay 2021–2025 board
recommendations; grade both the kept and the **declined** set against realized
VORP+ (the abstention audit's central move — the counterfactual is already
graded in the draft-audit panel). `pairedBootstrapDiff` on per-pick VORP+, gated
vs ungated, clustered by season, in each held-out season. Report the declined
set's own record alongside, per `nfl-abstention-audit.js`'s CAN/CANNOT rule: a
costly-looking rule is a hypothesis, never a licence to widen. Pass = ≥2 of 3
seasons significant. Kill = the declined slots perform no worse than the kept ones
— strongly plausible given that on the betting side selectivity *inverted* (top-3
picks at 45.1%, z = -2.42), which is exactly the outcome this test is designed to
be able to find.

**Why second.** Cheapest real instrument in the audit, uses a panel that already
exists, and the betting side's own null result gives it a genuine chance of
killing the idea rather than confirming it.

### 3. ADP/ECR reprice latency — does the fantasy market lag beat-writer news?
*From `signal-latency.js` / `nfl-news-market-latency.js` / `sharp-lag.js`.*

**Hypothesis.** ECR reprices news with measurable lag, and a player whose ECR is
still moving at draft time is systematically mispriced relative to his realized
finish — the fantasy version of "we knew at 14:02 and the number moved at 14:40".

**Prerequisite (small).** `historical-adp.js` currently keeps only the newest
scrape per player-season (`latestByKey`), collapsing dynastyprocess's weekly
July–September scrapes to 2,914 rows. Ingest all scrape dates instead. The source
is documented at 1.5M+ rows with real weekly scrapes for 2021–2025 — five seasons
of intraseason price series, which is more history than the betting side has ever
had (its multi-book tape starts 2026-08-05).

**Test.** Two questions, in order. (a) *Descriptive*: per player-season, the ECR
trajectory across scrapes — velocity, terminal drift, and whether late movement is
predictable from earlier movement. (b) *Predictive*: does residual ECR velocity in
the final two scrapes predict realized VORP+ over and above the terminal ECR slot?
Ridge on the 2021–2025 panel, walk-forward, `pairedBootstrapDiff` on per-player
squared error against terminal-ECR-only, clustered by season, ≥2 of 3 held-out
seasons. Kill = velocity carries no incremental signal, which would exactly
mirror `corr(model edge, ATS outcome) = -0.005` on the betting side.

**Boundary.** Explicitly disjoint from the cross-source ADP-disagreement work in
flight (ESPN vs Sleeper vs FFC at one instant). That is line shopping; this is
latency. Do not merge them.

### 4. Sequential/orthogonal residual ordering for fantasy signal families
*From `nfl-orthogonal-specialists.js`.*

**Hypothesis.** Fantasy candidates keep dying of duplication — `OFFSEASON_MODEL.md`
adopted 0 of 39, `player-head-registry.js` 0 of 24, `nfl-context-heads.js` 0 of
~200, and `nfl-teammate-competition.js`'s header names redundancy as the expected
cause of death before testing. Forcing families into a declared order where each
learns only the residual left by the market curve and all earlier families will
either surface a family with real incremental content or prove the redundancy
diagnosis correct, which is itself worth knowing.

**Test.** Order: market curve → prior usage → offseason change → scheme change →
teammate competition. Fit each stage's shrinkage on a later chronological
validation block, negative incremental value visible but contributing zero (the
module's own rule). `pairedBootstrapDiff` on per-player squared error of the
cumulative stack vs the market curve alone, per held-out season, ≥2 of 3.

**Why fourth.** The likely honest outcome is confirmation that everything after
stage 2 contributes zero. That is a real result and it would let several
candidate families be formally closed, but it is a cleanup, not new information.

### 5. Scheme discontinuity as a stayer-side offseason feature
*From `nfl-scheme.js` + `nfl-team-tendencies.js`.*

**Hypothesis.** `offseason-model.js` handles the player who moves; nothing handles
the player who stays on an offense that changed identity underneath him.
Neutral-situation PROE / early-down pass-rate discontinuity between T-1 and T
(available 2016–2025, all 32 teams, `nfl_team_week_features`, 5,363 rows) predicts
the log ratio of his opportunity share, over and above `seasonDecay = 0.05`.

**Test.** Add the team-level discontinuity as a single feature to the existing
offseason-model harness, which already has the walk-forward scaffolding for
exactly this shape (39 variables tested, none adopted). `pairedBootstrapDiff` on
per-player squared error of the log-ratio target, with vs without, clustered by
season, ≥2 of 3 held-out seasons. Kill = no incremental value over the player's
own prior-year usage, which is the documented failure mode of nearly every
candidate in this repo and a real possibility here.

**Why last.** Genuinely novel and the data is local — but it is a 40th variable
against a harness that has adopted none of the first 39, and the mechanism it
proposes is one the player's own usage series may already carry.

---

## What did not make the list, and why

- **Weather / officials into fantasy** — weather failed twice on this database
  (`nfl-context-heads.js` zero survivors; `nfl-opponent.js` reports MAE degrading
  monotonically 70.56 → 90.81), officials is a measured null after multiplicity
  correction, and neither has a season-long channel. Re-running them is re-running
  a known negative. The useful correction to
  `docs/RESEARCH_OPEN_SOURCE_FANTASY.md` is narrower: the *data sourcing* for
  weather, officials, coaches and scheme is already solved locally and should stop
  being listed as a gap, even though three of those four are dead ends anyway.
- **Neural anything** — betting's own neural work is shadow-only by policy, has
  never passed its 128-game/8-week forward gate, and posted 51.70% on a losing
  selection set. The stance holds.
- **Drive simulation** — no player-season analogue, and its own directional rate
  (46.91%) is below chance in the audit. Fantasy's `correlation.js` copula is the
  better in-repo source for what `draft-lookahead.js` actually needs.
- **Wong teasers, Shin de-vig, CLV ledgers, line shopping, sharp divergence** —
  the proven or promising parts of the betting model are all *price* mechanics.
  Fantasy has no vig, no two-sided quote, and no closing price. The one genuine
  price-mechanics analogue (cross-source rank disagreement) is already being
  tested in a separate workstream.
- **Ensemble/coordinator machinery** — already ported to
  `fantasy-coordinator.js`, contextual regimes included. Only the orthogonal
  ordering is left, and it is candidate #4.

## Standing caution

Four of the five candidates above are most likely to return "no incremental
value". That is the expected outcome given the record — 564+ candidate/target
combinations tested on the betting side with 9 of 11 serious candidates rejected,
and two that passed clean isolated validation still degrading the shipped pipeline
when wired in, caught only by A/B ablation. Every candidate here must clear the
sealed-validation and A/B-ablation path, not just the bootstrap interval. Candidate
#1 is the exception in kind rather than in odds: it tests something already
shipping, so both outcomes are informative.
