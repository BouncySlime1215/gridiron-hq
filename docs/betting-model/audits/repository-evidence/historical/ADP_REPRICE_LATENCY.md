# ADP/ECR reprice latency — does the fantasy market lag beat-writer news?

Candidate #3 of `docs/BETTING_CAPABILITY_AUDIT.md`, run 2026-09-07.

**Verdict: DECLINED.** The prerequisite was feasible and shipped — the full ECR
scrape history is now retained, 24,273 rows against the 2,914 the old collapse
left. The hypothesis it was built to test failed cleanly. Residual ECR velocity
in the final scrapes carries **no incremental signal** about realized VORP+ over
the terminal ECR slot alone: **0 of 3 held-out seasons significant and improving**,
against a bar of ≥2 of 3, and the result is unchanged across four ridge penalties
and two feature parameterizations. Nothing model-side ships. The movement archive
does, because it is now real data the repo did not previously have.

## Scope boundary

This is **temporal**: one source's own reprice velocity over time. It is disjoint
from `docs/ADP_DISAGREEMENT.md`, which is **cross-sectional** — ESPN vs Sleeper vs
FFC at a single instant. That is line shopping; this is latency. No code, data
shape, or hypothesis is shared between them.

## What shipped (the prerequisite)

`server/services/historical-adp.js` kept exactly one row per (season, player) via
`latestByKey` — deliberately, and correctly for its readers (the boom/bust join and
`DRAFT_AUDIT_2021_2025.md` both want "what the market thought right before the
season"). But a price observed once has no velocity, so the movement was
unmeasurable.

`server/services/historical-adp-scrapes.js` (new) writes a second table,
`nfl_historical_adp_scrape`, keyed `(season, source, player_key, scrape_date)`. It
does **not** widen the existing table's primary key: every current reader of
`nfl_historical_adp` assumes one row per player-season, and silently turning that
into ten would change what `historicalAdpFor()` means for the boom/bust model, the
draft audit, and the draft board — none of which asked for a time series. Ingestion
is shared, not duplicated: `eachPreseasonRow` is now exported from
`historical-adp.js` and reused, so both tables are parsed by exactly one piece of
code and can never disagree about what a `'ro'` row is. A test asserts that
agreement directly.

Retention after re-fetching and re-parsing the source CSV:

| Season | Rows | Distinct scrape dates | Players | First → last scrape | Scrapes/player |
|---|---|---|---|---|---|
| 2021 | 5,743 | 11 | 597 | 2021-07-02 → 2021-09-03 | 9.62 |
| 2022 | 5,211 | 10 | 596 | 2022-07-01 → 2022-09-02 | 8.74 |
| 2023 | 5,686 | 11 | 579 | 2023-07-07 → 2023-09-01 | 9.82 |
| 2024 | 4,657 |  9 | 619 | 2024-07-05 → 2024-08-30 | 7.52 |
| 2025 | 2,976 |  6 | 523 | 2025-07-04 → 2025-08-08 | 5.69 |

**Correcting the audit's optimism about "1.5M+ rows".** That figure is the whole
`db_fpecr.csv.gz` — every `ecr_type`, every format, all years. The preseason
redraft-overall slice this test needs is 24,275 rows scanned, 24,273 stored. The
cadence is genuinely weekly, exactly as documented, but that means ~10 observations
per player-season, not hundreds. This is the real ceiling on the test and it was
not visible before the ingestion was done.

**Second real limitation.** The 2025 series ends **2025-08-08**, four weeks before
kickoff — the upstream release simply stops there. So 2025's "terminal" scrape is
not a draft-day price, and the one held-out season closest to the present is the
weakest test of a draft-day effect. 2023 and 2024 do run to within a week of
kickoff.

## Outcome metric

Matched to `docs/DRAFT_AUDIT_2021_2025.md` exactly: season PPR points recomputed
from `nfl_player_week_features` (weeks 1–18, `scoring.js` PPR weights), VORP against
the QB11/RB27/WR27/TE8 finisher, VORP+ floored at 0. **Validation: the recomputed
replacement points reproduce the audit's published table for 19 of 20
season-position cells exactly, the twentieth off by one point (2023 RB, 182 vs
183).** The ECR→gsis join runs through `off_rosters` / `nfl_ffopportunity_weekly` /
`nfl_roster_snapshots` full names with the audit's own seven aliases, avoiding the
corrupted `players.gsis_id` path the audit documents. Top-150 unmatched per season:
5 / 2 / 0 / 0 / 3. Ranked players with no stat line are scored 0, per audit
convention.

## (a) Descriptive — the market barely moves, and what movement there is is nearly memoryless

ECR is a rank, so all movement is computed in log space (a 3→13 move and a 100→110
move are both "+10 ranks" and are obviously not the same event). Sign convention:
positive velocity = ECR number rising = the market souring on the player.

**Terminal moves are tiny.** Median absolute week-over-week ECR change in the final
interval, top 150: **0.83 / 0.85 / 0.85 / 2.18 / 1.56 ranks** for 2021–2025. Half
the rosterable pool moves less than a rank in the last week before the number is
frozen. There is very little repricing to be late about.

**Movement is weakly autocorrelated.** `corr(early-trend slope, terminal velocity)`
= 0.167 / 0.209 / 0.126 / 0.060 / 0.421. `corr(previous-interval velocity, terminal
velocity)` = 0.25 / 0.183 / 0.336 / 0.115 / 0.325. Real and consistently positive —
ECR does drift in a direction rather than oscillate — but far too weak to make late
movement predictable from earlier movement.

**Velocity barely correlates with the outcome at all.** `corr(residual velocity,
VORP+)`, top 150, by season: **+0.090 / +0.003 / −0.083 / −0.150 / +0.016** — small
and *sign-inconsistent across seasons*. For contrast, `corr(log terminal ECR,
VORP+)` in the same populations is **−0.423 / −0.625 / −0.500 / −0.471 / −0.548**.
The slot carries essentially all of the information; the movement into the slot
carries none that survives to a second season.

## (b) Predictive — 0 of 3

Ridge on the 2021–2025 panel. Baseline = `[log(terminal ECR), position dummies]`.
Test model adds residual terminal velocity, residual two-interval velocity, and
absolute residual velocity — where "residual" means the terminal move minus what
the season-long trend (fitted on all scrapes *except* the final two, so it never
sees the move it is being compared against) already predicted. Walk-forward: train
on seasons < T, test on T. `pairedBootstrapDiff` on per-player squared error, 4,000
iterations; pooled test clustered by season.

Primary population, pre-specified: top 150 by terminal ECR each season — the
rosterable pool the draft audit itself scores, and the restriction `boom-bust.js`
had to make before rank movement meant anything at all.

| Test season | n train | n test | RMSE base | RMSE + velocity | Δ mean sq. err | 90% CI | Significant |
|---|---|---|---|---|---|---|---|
| 2023 | 300 | 150 | 33.31 | 32.54 | −50.33 | [−195.6, 98.5] | no |
| 2024 | 450 | 150 | 37.79 | 37.98 | +13.92 | [−18.6, 51.1] | no |
| 2025 | 600 | 150 | 41.85 | 41.86 | +0.47 | [−39.9, 47.1] | no |

Pooled, clustered by season: Δ = −11.81, CI90 [−33.5, 9.7], not significant.
**Seasons significant and improving: 0 / 3.** The bar was ≥2 / 3.

Secondary, full ECR panel (~457 players/season): 2023 Δ = −0.25 (ns), 2024 Δ =
**+7.60, CI90 [+2.4, +13.7], significant — in the wrong direction** (velocity makes
the model *worse*), 2025 Δ = +0.46 (ns). Pooled Δ = +2.64, CI90 [−0.1, 5.3], ns.
**0 / 3 improving; 1 / 3 significantly harmful.**

**Robustness — reported in full, none selected.** Ridge penalty λ ∈ {0.1, 1, 10,
100} on the primary population: 0 / 3 improving at every value, pooled Δ ∈ [−13.7,
−6.0], never significant. Single-velocity-feature parameterization (dropping the
two-interval and absolute terms in case three noisy features were the problem):
pooled Δ = +4.32, **0 / 3 improving, 1 / 3 significantly worse**. The null is not
an artifact of regularization or feature count.

**Model-free direction check.** VORP+ by residual-velocity quintile, top 150,
pooled 2021–2025: 31.6 / 26.0 / 20.5 / 18.7 / 29.5, hit rate above replacement
0.473 / 0.393 / 0.427 / 0.327 / 0.440. Non-monotone, and the two extreme quintiles
also hold the best mean terminal ECR (71.5 and 62.7 vs ~85 in the middle) — so what
little spread exists is the slot showing through, not the movement.

## Why this is a real null, not a weak test

The obvious escape hatches were checked and closed:

- The outcome is not mis-measured — replacement points reproduce the published
  audit table 19/20 exactly.
- The join is not thin — top-150 coverage is 145–150 of 150 per season.
- The population is not diluted — the primary test is the top 150, the restriction
  that rescued `boom-bust.js` from its own null.
- The model is not over- or under-regularized — four penalties, same answer.
- The feature is not overfit noise from three collinear terms — one term, same
  answer.

What is genuinely limited is the **data granularity**, and it is limited in a way
that is informative rather than merely inconvenient: FantasyPros publishes ECR
weekly, and the median top-150 player's number moves **under one rank per week**.
There is no "we knew at 14:02 and the number moved at 14:40" structure to find here,
because there is no 14:40. The betting analogue works on an intraday quote tape
where the price moves many times a day in response to a datable event. Preseason
ECR is a slow-moving weekly consensus with no comparable event clock. A version of
this test with a real chance of finding something would need a *daily* ECR series
joined to *timestamped* beat-writer reports — neither of which this repo has, and
the second of which the betting side has already documented at 0% coverage.

This mirrors `corr(model edge, ATS outcome) = −0.005` on the betting side: the
transfer was structurally sound and the answer is still no.

## Reproducing

- Prerequisite: `syncHistoricalAdpScrapes()` from
  `server/services/historical-adp-scrapes.js` (re-fetches the ~105 MB source, ~2 min).
- Analysis: `scratchpad/reprice/panel.mjs` then `scratchpad/reprice/analyze.mjs`.
- Tests: `test/historical-adp-scrapes.test.js`.
