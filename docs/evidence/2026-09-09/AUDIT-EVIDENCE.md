# Gridiron HQ NFL betting audit: evidence and code findings

## Current implementation scope: NFL spreads only

The user narrowed implementation to ordinary full-game pregame NFL spreads after the comprehensive audit. The historical multi-market findings below remain intact as evidence, not a requirement to repair or expand every product. The current governing work order is the spread-only **CLAUDE-NEXT-STEPS.md**. Folder cleanup still covers the repository; non-spread features/data are preserved.

**Relevant baseline:** run 27 spreads have 153 selections, 72 wins, 78 losses, 3 pushes, −11.854884 units, **−7.7483% ROI** and **48.0% wins excluding pushes**. Its historical selector and information horizon differ from the newly proposed T−60 protocol and the current gated live path. The 545-selection mixed-market total is not the spread sample size.

| Season | Spread selections | Wins | Losses | Pushes | Net units | ROI |
|---|---:|---:|---:|---:|---:|---:|
| 2021 | 37 | 16 | 20 | 1 | −5.282409 | −14.28% |
| 2022 | 31 | 17 | 14 | 0 | +1.366523 | +4.41% |
| 2023 | 22 | 11 | 9 | 2 | +1.220827 | +5.55% |
| 2024 | 36 | 14 | 22 | 0 | −8.894037 | −24.71% |
| 2025 | 27 | 14 | 13 | 0 | −0.265788 | −0.98% |
| All | 153 | 72 | 78 | 3 | −11.854884 | −7.75% |

The spread-only 50,000-replicate week-cluster bootstrap gives a descriptive 95% percentile ROI interval of **−23.22% to +7.51%**. It resamples all 70 audited weeks, including six with no spread selections, and divides each replicate's summed units by its summed stakes. The calculation uses Python `random.Random(9021026)`, 70 `randrange(70)` draws per replicate on ordinal-sorted weeks, and sorted endpoint indexes `floor((N−1)×0.025)` / `floor((N−1)×0.975)`. Source: the frozen audit export, SHA-256 `52f3bd6470a4ddabda4566044631b432afaf1ebb751ea2b057e956be88d9e5ff`; full-precision weekly values and method are included in the verification bundle's spread-only addendum. No new forecasts, prices or outcomes were fetched to make this calculation.

The wide interval includes zero. It does not prove a positive or definitively negative long-run spread edge, remove search bias, establish earlier availability, or address all dependence across weeks/seasons. The positive 2022/2023 slices cannot be selected after inspection as new independent validation. At constant −110, the mathematical break-even win rate among decided bets is 110/210 ≈52.38%, before other costs; actual return uses actual prices and pushes.

**Active findings:** M04–M07 and M12–M15 apply directly to the spread forecasting/evaluation path. M01 stays conditional on a later preseason trial. M02/M03/M08/M09/M10 are prop-focused and deferred; M11 is relevant only if a shared fitted dependency actually enters a spread feature. E1–E4, E6–E8, E10–E12 remain active for spread integrity and operation. E5 applies to spread suggestions/price-shopping authority; its teaser-specific work is deferred. E9 applies to spread ticket/CLV/accounting linkage without requiring new other-market workflows.

Two spread-specific implementation details require explicit treatment. The current cover-calibration sample excludes pushes (`nfl-cover-calibration.js:284`); its binary probability needs conditional semantics rather than being silently treated as unconditional win probability. Also, a new per-game T−60 policy cannot rank the full week's eventual T−60 candidates after the fact. The existing weekly top-five selector (`nfl-policy.js:99–106`; `nfl-replay.js:171–176`) needs a frozen chronological capacity rule for that new horizon. These are requirements for the chosen spread protocol, not evidence that every weekly ranking or historical result is inherently invalid.

## Assessment

Gridiron HQ has a substantial football research system, several implemented model families, useful negative experiment results, and meaningful controls that currently restrict betting authority. It does **not** yet have a demonstrated profitable NFL betting strategy. Its historical selectors lose in the inspected records; much of the additional modeling does not improve on the market; and the measured prospective execution/settlement loop is largely empty.

There are also repairable software and statistical defects. The most consequential are contract/quote mismatches, inconsistent forecasting and calibration paths, optimistic component-selection evidence, incomplete settlement validation, a reversed new preseason weighting formula, and reporting that confuses different bets or different information times. These defects are reasons to repair the system before promotion. They are not proof that fixing them will generate profit, or that each defect caused past personal losses.

The companion **CLAUDE-NEXT-STEPS.md** is the ordered implementation brief. This document preserves the supporting numerical audit and the detailed micro-level findings so the changes can be reviewed against evidence.

## Scope, versions, and evidence quality

The primary subject is the **local Claude project**, as explicitly requested: `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`, commit `969d501e5d318f8ff650d7e239d8647f8b75eb84`. The working tree was clean when checked. GitHub's `main` was pulled to `7dfd3f2392510effc6f5d51e9708d502ff80bdbf`, then the seven newer local commits were inspected. Code references below are one-based, repository-relative locations in the local snapshot. Local commits not pushed to GitHub should not be cited as publicly accessible GitHub pages.

The requested conversation was located by its exact title, **“Gridiron HQ research platform strategy.”** Its local session metadata maps to transcript `77190978-4d50-4315-861c-375dfc788580`; the extracted text contains 878 user/assistant text records, including summaries and task notifications. The relevant strategy, claimed learning improvements, offseason work, opener discussion, and audit-result interpretations were checked against source and saved data. Earlier claims in that conversation are treated as claims, not instructions or proof. An attempted multi-agent Claude audit in the conversation ended with an empty synthesis after session-limit failures; it is not an additional completed model validation.[^1]

The live SQLite database and local saved research artifacts were queried read-only. No model training, paid API request, wager, promotion, app restart, or live-data mutation was performed. Source was frozen in separate local clones. Existing targeted execution tests and independent adversarial probes used isolated databases; source-extracted microchecks exercised exact functions/expressions without importing the live application. GitHub's local checkout was updated as requested; application code was not edited.

This is a cross-system code, data, audit-result, and operational review. It is not a rerun of every historical model, a full live-season execution test, an independent recreation of every provider archive, or a line-by-line formal verification of every repository file. Numerical claims below distinguish raw-record reconciliation, saved experiment reports, source analysis, and controlled fixtures.

**Complete plan line review, September 9 Eastern / September 10 UTC:** the reviewed versions contained 667 main-plan lines, 645 evidence lines, 309 folder-companion lines and 761 file-disposition rows. Every line/row was reviewed across the independent modeling, evidence and organization passes; the main plan received all three reviews. Corrections were integrated into the same deliverables, then checked again. This is complete coverage of the written plan and appendices, not a claim that every source line in all 761 repository files received formal verification.

The review corrected a circular calibration/capture dependency, frozen-forecast repricing, historical fitting clocks, routine-refit versus experiment identity, fixed-paper versus unqualified variable sizing, settlement versus closing-price evaluation, manual-ticket bookkeeping, bounded experiment scope and strategy-specific promotion. It also corrected 13 folder-map dispositions/rationales and specified migration-import and non-Git packaging safeguards. Original saved results remain unchanged. All 12 verification-bundle checksums passed, and the spread arithmetic and 50,000-replicate interval reproduced exactly. No application code or source-folder migration was performed in this review.

**Latest status check:** at 2026-09-10 01:18:00 UTC / September 9, 9:18:00 p.m. Eastern, local source remained at the same commit and run 31 was still running at **60 of 70 weeks**, with no final result. Its detailed paired comparison below deliberately uses the saved **51-week** inspection cohort; later progress does not silently change that sample.

**Implementation follow-up:** run 31 subsequently completed 70/70 before editing began on local main. The read-only full comparison at 2026-09-10 03:17 UTC found all 70 pick arrays identical to run 27: 545 selections, including the same 153 spreads. This is the completed version of the earlier paired observation, not independent new validation. [Completed-run comparison](run31-completed-comparison.json). The original audit findings below describe the audited source; the first repairs and remaining gaps are recorded in the main plan's implementation state.

## What the audit history actually says

The current blind-audit table contains run IDs 9–31. Earlier run numbers are referenced in historical documents/conversation, but their complete rows are not present in this live table. Do not fabricate them or infer that 31 means 31 independent completed experiments. There is also a separate, older `audit_registry` whose IDs refer to different experiments.[^2]

| Blind run | Saved state | Observed scope/result | Interpretation |
|---|---|---|---|
| 9, 10 | Failed | Input/cache mutation blockers after 1 and 22 weeks | Operational failures; not independent statistical conclusions |
| 11 | Cancelled | 6 weeks | Intentionally stopped; not a completed test |
| 12, 13, 16, 18 | Registered | No opened weeks | Specifications without completed evidence |
| 14 | Complete | 2 weeks, 6 selections, +1.618 units | Tiny diagnostic; cannot establish advantage |
| 15 | Complete | 2 weeks, 5 selections, +2.618 units | Another tiny diagnostic, not durable profit |
| 17 | Complete | 56 weeks; 115 selections, 55–58–2, −7.499 units, −6.52% | Earlier completed losing selector; version/scope differ from run 27 |
| 19 | Failed | 25 weeks, then orphaned; partial 48 selections, +1.842 units | Positive prefix is not a completed result |
| 20–22 | Registered | No opened weeks | No additional completed evidence |
| 23–26 | Failed | 1–4 weeks, cache/data-snapshot blockers and supersession | Repeated starts do not increase sample size |
| 27 | Complete | 70 weeks, 545 selections, −55.414 units, −10.17% | Principal completed record; detailed below |
| 28 | Failed | 22 weeks, coaching-field mutation interruption | Prefix repeats earlier predictions; not evidence of improved forecasting |
| 29 | Registered | No opened weeks | No result |
| 30 | Failed | Never opened a week; stale snapshot | No statistical result |
| 31 | Running | 60/70 at last status check; detailed 51-week prefix is identical to run 27 | No final result at inspection; do not count duplicate predictions twice |

Run 27's first five weeks produced a favorable streak, but the full run lost. Re-running the same algorithm on the same seasons reproduces that pattern; the repeated hot start and later decline are not successive independent episodes of learning and collapse. Analysis should compare like-for-like predictions and evidence, not the visual path of a repeatedly restarted cumulative chart.

### Other saved quantitative audits

- The older policy audit has **203 bets, 94 wins, 106 losses, 3 pushes, −19.71 units and −9.7% ROI**, with a saved weekly-cluster interval of approximately **−23.3% to +3.9%**. It is a different policy artifact, not an extra 203 independent observations to add to run 27.[^3]
- The residual audit has **855 games**: market margin MAE 9.786; residual-model margin MAE 9.801; raw-model margin MAE 10.256. Totals MAE was 10.120 for the market and 10.104 for the residual model, a very small point improvement that does not establish profitable total bets.[^3]
- The older audit registry's powered five-season CLV test reports 915 observations, 51.15% for its declared statistic, **p≈0.488 and failed**. The earlier “line shopping saves win rate” record reports 0.0067 on 80 observations. Relative savings against median prices is not proof of positive absolute expectation.[^3]
- The same registry includes passed live-probability/base-rate or simulator-distribution checks. These validate their stated tests only; they do not establish beaten sportsbook prices. A simulator reproducing selected aggregate moments is not an independent test of its own betting assumptions.
- The local player-head audit has 17 nonredundant candidates tested, a discovery survivor (`robust_consensus`), **validation not opened**, and **production_eligible=false**. The `prop_head_audits` table has zero rows. Other prop research artifacts may exist, so this is a table-specific result, not a claim that no prop research was ever performed.

## Available data versus operating evidence

The following are direct database observations during this audit; current collectors and run 31 continued operating, so these are timestamped inspection counts rather than permanent inventory totals.[^2]

| Store | Rows observed | What the count establishes |
|---|---:|---|
| `nfl_quote_tape` | 1,171,894 | Large quote archive; not that all rows are independent or obtainable |
| Current quote batches | 819 / 1,012,146 quote rows | September 2–9, 2026 capture window |
| Historical quote batches | 168 / 159,748 quote rows | Sparse snapshots from October 2020–January 2026, ingested September 8 Eastern |
| `nfl_injuries` | 28,421 | Historical and current rows exist; vintage/source quality still needs qualification |
| `nfl_depth` | 177,059 | Depth data exists; not proof of midweek availability |
| `nfl_news_signals` | 311 | Extracted signal records |
| `nfl_news_events` | 30 | Typed event records; latest impact report has zero usable later-quote pairs |
| `nfl_verified_events` | 119,639 | Extensive archived evidence; event label alone does not certify decision-time observability |
| `nfl_roster_snapshots` | 27,967 | Current roster observation infrastructure exists |
| `nfl_player_roster_events` | 44 | Recorded changing roster events |
| `nfl_execution_opportunities` | 0 | No completed operating evidence in the new opportunity ledger |
| `nfl_execution_lifecycle_events` | 0 | No new lifecycle progression or settlement evidence |
| `nfl_bet_log`, `nfl_execution_log`, `nfl_teaser_executions`, `forward_picks` | 0 each | No placed/forward record in these particular tables |
| `nfl_user_bets` | 1 | One user-entry record; not a reconciled bankroll statement |
| `nfl_expert_forward_predictions` | 2,331 | Prospective specialist forecasts exist |
| `nfl_expert_forward_settlements` | 0 | Those specialist forecasts have no settled rows here |
| `nfl_candidate_findings` | 1 | One discovered, unpromoted weakness hypothesis |

The injury table contains 5,783 rows for 2025 and 29 rows for 2026 at inspection. Therefore “nflverse's old feed stopped” must not be simplified to “Gridiron has no 2025 injury information.” The correct next step is to identify each row's source and usable time. The run 27 manifest separately shows no pre-2026 rows in several newer live news/roster-event stores, illustrating why the historical audit cannot validate all the new weekly news machinery.

The sole candidate finding is the weak **big spread (7+) plus late season (week 14+)** segment. It is saved as `discovered`, with **2021–2025 all permanently discovery**, and no holdout/promotion dates. Its note mentions an observed poor subgroup, but those already inspected years cannot independently validate that subgroup. The new veto therefore has no approved finding to apply at this inspection.

The model registry deliberately leaves NFL spreads at market baseline with a research-only challenger; totals challenger blocked; player props baseline/research-only. That is appropriate restraint given the evidence. Other recommendation paths still need the same economic discipline, as the execution findings explain.

## How to interpret the player and research results

Across run 27's saved weekly player metrics, weighting each reported MAE by its sample count gives approximate active-player point error **4.76 for the model versus 4.51 for season-to-date**, and decision error including DNP **5.30 versus 4.91**. These are reconstructed from rounded weekly metrics and are not priced-prop returns. They show that the richer player model cannot simply be assumed better than a basic historical average on the tested population.

The saved market/tree/selector/role reports below are actual local artifacts, not merely roadmap claims. The market-lab starter chose no movement for spreads in all three evaluation years. Its totals policy had 104 indicative bets and +2.05% ROI, but the interval was approximately −17.56% to +22.02%, its CLV interval included zero, and its movement error was worse than the no-move comparator. These are useful negative or mixed experiments, not a mandate for a bigger search.[^4]

The book-response pilot was built before the historical backfill. Its report describes 48 source events in its limitations, while the fitted panel used 44 events. Both are one-window coverage descriptions, not 44 or 48 independent weeks. About six-minute polling cannot verify five-second survival. The new six-season raw archive requires a new qualified dataset and evaluation; it does not retrospectively change the saved pilot's evidence.

## Numerical reconciliation of the principal runs

The following section uses frozen per-pick records and independently checked outcomes. “Unit” means one unit risked per selection, not necessarily one dollar or one percent of Nick's bankroll. Personal profit/loss remains unknown without actual accepted-ticket and account reconciliation.

### Completed run 27

The export contains 70 contiguous audited weeks, ordinals 0–69: 2021 Week 5 through 2025 Week 18, covering Weeks 5–18 in each of five seasons. Its run status is `complete`.

Counts below are summed directly from the frozen per-pick arrays, not rounded weekly summary fields. A unit means one unit risked per selected bet; ROI divides total units by every bet, including returned-stake pushes. Win rate excludes pushes.

| Market | Bets | Wins | Losses | Pushes | Win rate, excluding pushes | Net units | ROI on all stakes |
|---|---:|---:|---:|---:|---:|---:|---:|
| Spread | 153 | 72 | 78 | 3 | 48.0000% | -11.854884 | -7.7483% |
| Total | 48 | 23 | 24 | 1 | 48.9362% | -2.944622 | -6.1346% |
| Moneyline | 344 | 108 | 236 | 0 | 31.3953% | -40.614766 | -11.8066% |
| All markets | 545 | 203 | 338 | 4 | 37.5231% | -55.414273 | -10.1678% |

The stored run-level summary rounds to -55.414 units and -0.1017 ROI, agreeing with the raw records. Slight differences such as -11.854 spread units or -40.616 moneyline units arise when already rounded weekly/market summaries are added. Use raw-pick sums above in the audit.

Independent outcome and payout checks produced **zero mismatches**. Each frozen pick was joined by `(season, week, home team)` with opponent validation; selected-side results were recomputed using final scores and the recorded frozen line. Wins paid the current matching historical price in `game_lines`, losses -1 and pushes 0, exactly matching every frozen pick's stored units. This verifies arithmetic and outcome reconciliation; it does not prove that the quote was obtainable at the claimed decision time.

### Opening-line comparison is mislabeled as the same picks

`spreadDecisionTimeReference` at lines 99–110 derives a new side from `projectedMargin + openSpread > 0`. `closeBackHome` is used only to report whether this new side matches the original side. It does not preserve the original selection. `totalDecisionTimeReference` at lines 115–125 similarly selects Over again from `projectedTotal > openTotal`.

The summary at lines 326–327 nevertheless calls this “Same picks” against the opening line. It is the same selected game/market cohort, with the side sometimes reselected. It does not rerun opening-time eligibility, ranking, weekly capacity or the model with only opening-time information. It is therefore neither an honest same-side price comparison nor a full opening-policy backtest.

The following was independently recomputed from frozen picks and the read-only database. All 201 spread/total selections had an opening line. Moneyline has no opening-price comparison here.

| Run 27 diagnostic | Spread W/L/P | Spread win rate | Total W/L/P | Total win rate | Combined W/L/P | Combined win rate |
|---|---:|---:|---:|---:|---:|---:|
| Recorded selected sides at their recorded lines | 72 / 78 / 3 | 48.00% | 23 / 24 / 1 | 48.94% | 95 / 102 / 4 | 48.22% |
| Stored opening diagnostic, sides reselected | 71 / 79 / 3 | 47.33% | 27 / 20 / 1 | 57.45% | 98 / 99 / 4 | 49.75% |
| Original frozen sides graded at opening lines | 58 / 92 / 3 | 38.67% | 14 / 33 / 1 | 29.79% | 72 / 125 / 4 | 36.55% |

There are 23 side flips among 153 spreads and 22 among 48 totals. Independent reselected-side grades exactly match the stored opening diagnostic. Model numbers in the export are rounded to three decimals; that precision nevertheless reproduced all aggregate grades and flip counts.

Same-side spread calculation: set `M = home_score - away_score` and `S_open = home.open_spread`. For a frozen home selection, win if `M + S_open > 0`; for a frozen away selection, win if `< 0`; equality is push. For totals compare final combined points to `open_total`, preserving the frozen Over/Under side. These calculations require no hypothetical opening payout assumption.

These are line-only diagnostics. There are no opening spread/total price columns in the inspected schema, and the helper intentionally does not calculate opening P&L. None of the opening win rates establish profitability or genuine opening-time predictive skill. Even the corrected same-side calculation inherits the original cohort's selection and original model's information; it is not a substitute for a proper early-decision replay.

Required repair: rename existing output as a reselected-side opening diagnostic; add the actual frozen-same-side regrade; reserve “opening policy replay” for a separate reconstruction that freezes the model inputs, decisions, available prices, eligibility and ranking at the opening decision time. Remove claims that either opening or closing quotes are proved obtainable solely by being stored.

### Run 31 is an unfinished duplicate prefix in this export

Run 31 is marked `running`, with `next_ordinal = 51`. The export contains 51 contiguous weeks, ordinals 0–50, through 2024 Week 13. This is a snapshot of its progress, not a claim about its later live status.

| Market | Bets | Wins | Losses | Pushes | Win rate, excluding pushes | Net units | ROI on all stakes |
|---|---:|---:|---:|---:|---:|---:|---:|
| Spread | 113 | 54 | 56 | 3 | 49.0909% | -6.293678 | -5.5696% |
| Total | 29 | 14 | 14 | 1 | 50.0000% | -1.118938 | -3.8584% |
| Moneyline | 253 | 78 | 175 | 0 | 30.8300% | -35.304254 | -13.9543% |
| All markets | 395 | 146 | 245 | 4 | 37.3402% | -42.716870 | -10.8144% |

All **51 out of 51 frozen pick arrays are exactly identical** to run 27's matching-week prefix, including selections, results, units and model values in the export. Do not present run 31 as independent corroboration, extra sample size or evidence that a newly named overhaul changed betting results. Its full final result remains unknown in this snapshot.

Run 31's stored opening diagnostic yields spread 57/53/3 and total 19/9/1. Regrading its frozen original sides at opening lines yields spread 42/68/3 and total 9/19/1. Side flips are 21 spreads and 17 totals. These are subject to the same limitations as run 27.

### Uncertainty and permitted conclusions

An independent paired week-cluster bootstrap resampled the 70 run-27 `(number of bets, sum of raw units)` pairs with replacement, drawing 70 weeks per replicate. With Python seed 9021026 and 50,000 replicates, the simple percentile 95% interval for pooled ROI was approximately **[-22.35%, +2.64%]**. Another implementation's approximately [-22.66%, +2.83%] is consistent with bootstrap simulation and implementation differences; both include zero.

This interval is descriptive and does not undo selection across prior model searches, multiple looks, development-history reuse, nonstationarity or possible dependence spanning weeks. The correct conclusions are:

- The completed replay lost 55.41 units on 545 unit-stake selections, approximately 10.17% of total stakes.
- Every market's observed return was negative in this replay.
- There is no demonstrated profitable advantage in this record.
- The clustered uncertainty remains wide; these figures do **not** establish a statistically certain negative long-run edge.
- “37.5%” is the combined non-push win rate across all three markets, heavily influenced by moneyline selections. It is not the spread win rate and cannot be benchmarked against an across-the-board 50% target because moneyline payouts differ.
- A displayed “50% against opening lines” is a rounded 49.75% for reselected spread/total sides, excluding moneylines and pushes. It is not 50% for frozen original sides and is not proof of profitable execution.
- These are historical paper replay results. They do not establish the user's actual bankroll loss without a reconciled record of real settled wagers.


## Detailed model findings

## What actually produces the numbers

1. **Live spread picks:** `nfl-auto-picks.js:81-119` calls `ensembleWeek` in `market_residual` mode, optionally substitutes an online neural prediction if eligible, then applies the cover calibrator. The new findings layer can only veto an otherwise eligible result (`133-138`). It does not learn a numeric adjustment or update expert weights.
2. **Ensemble:** `nfl-ensemble.js:317-577` contains rating, efficiency, roster, context and market components. Component errors set exponential performance weights (`995-1010`); a second residual gate and fitted residual slopes decide how to move from the market (`963-1020`, `1144-1154`). Different transforms of related statistics are not independent evidence merely because they have different names.
3. **Unified model page:** `nfl-unified-engine.js:32-53` gets means from that ensemble and tilts a play simulation to those means. Its returned council packet (`82`) is explanatory/research context; it does not make the council coordinator the production spread predictor.
4. **Research council:** `nfl-expert-coordinator.js` has regularized, robust, week-balanced residual fitting and family shrinkage. It exists and does useful research work, but attaching its output to a shared object does not route it into every prediction consumer.
5. **Player props:** `nfl-props.js:547-580` calls the shared player-week engine, draws 3,000 team simulations, and prices offered thresholds from the resulting stat samples. The structural model decomposes opportunity and efficiency (`projections.js:432-471`). Weekly fantasy PPG blending changes `ppg` (`player-week-engine.js:138-158`, `225-235`); event expectations still use structural `params` (`266-286`). Thus adaptive fantasy weights do not automatically improve prop volume/efficiency.
6. **Local-only preseason addition:** `nfl-preseason-blend.js:228-245` explicitly says the one-column GBM experiment did not improve the champion and is not wired into a production dataset. Its conceptual/model defects therefore are not an explanation of years of prior real losses.

## Findings requiring changes

### M01 — Correct the reversed preseason Bayesian weighting (local-only, high priority)

**Evidence:** `nfl-preseason-blend.js:170` sets `weightOnPrior = priorVariance / (priorVariance + gamesPlayed * PER_GAME_VARIANCE)`. The normal-normal posterior weight on the prior mean should be `PER_GAME_VARIANCE / (PER_GAME_VARIANCE + gamesPlayed * priorVariance)`. Line `172` already computes the posterior variance from the correct precisions; the mean and variance are internally inconsistent. Header `14-20` incorrectly calls the rapid fade a genuine finding.

With the code's illustrative variance values (36.5 prior, 181.5 per-game), one game yields 16.7% prior weight rather than 83.3%; four games yield 4.8% rather than 55.4%. Doubling prior uncertainty raises the code's trust in the prior from 16.7% to 28.7%, the opposite of what uncertainty should do. Tested by extracting and executing the exact source expression in `work/model-microchecks.mjs`.

**Additional defects in the same feature:** Calibration queries all stored seasons with no decision cutoff (`43-46`, `82`), so reconstructed earlier predictions can depend on later games. `prior_variance` is not a measured prior error: lines `62-69` only check that a previous season exists, then take the variance of current-season means without subtracting or fitting a prior prediction. Season means also contain finite-sample noise. A raw previous-season margin is blended with log-dampened current margins (`125`, `149`, `185-194`), although variance calibration uses raw margins. Churn queries an 18-month interval (`105-108`), not a clean current offseason, and has no decision timestamp.

**Change:** First fix algebra and remove the misleading scientific claim. Fit prior prediction error and observation noise in the same units using only earlier folds, with opponent/schedule adjustment where justified. Store a dated fit artifact. Keep as challenger until a new properly isolated comparison is complete. Do not automatically reinterpret its previous failed experiment as evidence about a correct Bayesian prior.

**Acceptance:** Test zero games; increasing sample count; increased observation noise -> more prior weight; increased prior uncertainty -> less prior weight; posterior mean equals precision-weighted formula; appending later-season data does not change an earlier prediction. Test both shifted means and heteroskedasticity. Tests should assert statistical properties, not copy the implemented formula.

### M02 — Stop mixing different bookmakers and contracts on the prop board (high priority)

**Evidence:** `nfl-props.js:645` pairs quotes by `[market, normalizeName(player), line]` without event ID, bookmaker, or period/rules. Each new row overwrites `over`/`under`, but metadata including `book` remains from the first row (`646-650`). Returned price/book at `673-674` can therefore be a quote no listed book offered. Names alone join projections (`603-604`, `655`), so collision and traded-player/event mismatches are also possible.

**Reproduction:** Source-extracted board loop with book A Over -110 followed by book B Under -120 and book B Over +130 returns `book: A, american_price: +130`. No external feed is needed to reproduce it.

**Change:** Quote identity must include canonical event/player/market/period/line/rules/book, source time and receipt time. Pair both sides within the same book and compatible timestamp; compute each book's market probability before line shopping. Best price selection is a separate operation retaining the exact original quote IDs. A cross-book consensus is explicitly a consensus, never falsely attributed to one venue.

**Acceptance:** Two books interleaved in both orders; duplicate player names in different events; one-sided quotes; different alt lines; stale paired sides; void/rule differences; no output price/book can lack a matching source row.

### M03 — Fix negative-edge anytime-TD inversion and push handling (high priority)

**Evidence:** `nfl-props.js:666` chooses `overIsBetter` from model versus market. The anytime market always labels its side `Yes` (`672`), yet `673-676` use the opposite probability and missing under price when model < implied. `abs` gap at `677` makes that disagreement look positive. Source-extracted fixture with model TD probability 25% and a +150 Yes quote (40% implied) returns Yes with 75% model probability, 60% implied probability, a +15-point gap, and a null price.

`pOver` (`533`) grades strict `>`, while the Under probability is `1-pOver`; for integer lines, that includes push mass as a win. That does not affect strictly half-point markets but fails when integer alt lines appear.

**Change:** One-sided Yes markets retain `p_yes`, signed edge and offered Yes price. Missing No quotes are not bettable No propositions. For any market expose win/loss/push probabilities and compute EV as `p_win * profit_multiple - p_loss`; rank executable offered sides by signed after-price EV rather than absolute fair-price disagreement.

**Acceptance:** Negative-edge Yes remains negative and never becomes a No probability; absent opposite prices cannot create an offer. Integer receptions lines price pushes explicitly. Zero edge, strongly negative edge, odd prices and void scenarios reconcile.

### M04 — Enforce challenger exclusion in the residual champion (high priority)

**Evidence:** `nfl-ensemble.js:1000` excludes challenger-only models from the raw weight calculation; `1130` repeats that safeguard in the raw blend. But `1014-1016` assigns residual weights to all scored models, and `1147` selects residual models only on nonnull margin, positive residual weight and slope. It omits `includeChallengers || !m.challenger_only`. A challenger passing the residual gate can therefore influence the default champion.

**Change:** Centralize eligibility and authority before all weighting/blending/distribution/calibration consumers. Apply the same predicate to margin, total, residual and family-ablation modes. Make each prediction emit exact contributing model IDs and weights.

**Acceptance:** Inject a challenger-only component with overwhelming favorable backtest metrics and a huge forecast. With challengers disabled, every champion output is unchanged; with enabled, the experiment can hear it but cannot acquire live authority. Duplicate a model and verify family-level influence does not increase merely from a duplicate name.

### M05 — Residual skill gate fits and grades its scale on the same rows

**Evidence:** `nfl-ensemble.js:963-972` estimates slope from all residual pairs and computes gain/t statistic on those same pairs. `1014-1016` uses that statistic to allocate residual authority. There is no week cluster or multiplicity correction across those component tests. Further, one shared calibration fitted before the target year (`891-894`) is used to score much earlier component rows (`924-941`): those earlier rows are not truly out-of-fold with respect to this calibration, even though the final target game itself is excluded.

**Interpretation:** A prediction for a later season may still be chronological in the coarse sense. The problem is the reported skill evidence used to select and scale components is optimistic, and violates the repository's OOF-1 promise. A fit improvement by construction is not independent residual skill.

**Change:** Generate nested chronological out-of-fold component forecasts, including feature-to-points calibration. Fit residual slopes on earlier out-of-fold blocks; score them on the next unopened block; use paired week-block loss differences and a declared family/multiple-testing rule. Production changes require their own forward evaluation. Preserve zero-residual fallback.

**Acceptance:** Noise-only components and shuffled labels fail at a calibrated false-positive frequency across the entire candidate family; perfect leaked features are rejected; changing future targets cannot change earlier calibration/weights. Model selection, scaling and uncertainty must have separate data roles.

### M06 — Calibrate the forecast path that is actually served

**Evidence:** `nfl-cover-calibration.js:281` builds samples through `replaySeason` without `modelOptions`. `nfl-replay.js:182` calls the default ensemble, whose default `blendMode` is raw (`nfl-ensemble.js:1048`). Live `nfl-auto-picks.js:82` defaults to market residual and can use a neural margin (`102-106`), then feeds its edge into that calibrator (`118-119`). A calibrator for raw-ensemble disagreement is not automatically valid for a shrunk residual or neural disagreement. The lookup keys only a calibrator version string (`cover-logit-v2`) and season rather than the full underlying forecast/horizon contract.

**Change:** Build one pure prediction API for live/replay with explicit cutoff, model artifact, features, market quote and event rules. Calibration artifacts name/hash that exact probability-producing pipeline and training rows, devig method and decision horizon. Do not reuse a calibrator after any upstream structural change unless parity is demonstrated.

**Acceptance:** Same frozen packet gives the same raw prediction, calibrated distribution, side and stake decision in live and replay. Installing a new neural/head version invalidates incompatible calibration. Existing blocked probability gates remain blocked until exact-path evidence qualifies.

### M07 — New opening-line replay comparison is a counterfactual, not opening-time evidence (local-only)

**Evidence:** `nfl-replay.js:182` computes a forecast with historical closing-line context, then `208` and `235` compare the same forecast against the opener. `spreadDecisionTimeReference` (`99-110`) and total equivalent (`115-125`) also choose a new side based on the opening edge. Forecast input `nfl-ensemble.js:1102-1105` uses closing spread/total and actual weather for settled games. `games()` explicitly supplies NULL openings in fitting (`55-60`).

**Implication:** A reported 49.7% opening-reference record versus 37.5% closing record cannot establish that betting earlier fixes the model. It is not the same decision population or necessarily the same sides. A pooled win rate across moneylines and spreads is also not an ATS rate; odds determine break-even.

**Change:** Relabel this field `closing-information forecast graded against opener` or remove it from performance headlines. A true opener/Friday/kickoff comparison needs separately frozen as-of predictions and quotes, with paired per-game or per-policy comparisons. Only a quote actually available at that timestamp may produce an executable ROI.

**Acceptance:** Modifying a closing line or kickoff weather after a Tuesday cutoff cannot change Tuesday's prediction. Report each market, selection policy, sample denominator, odds distribution and price-aware return separately.

The numerical audit independently recomputed the stored picks while holding the originally selected side fixed: spreads at opener 58-92-3 (38.67%) versus close 72-78-3 (48%); totals at opener 14-33-1 versus close 23-24-1. These still use picks selected with closing information and are not an executable opening strategy. The numerical audit also verified that 395/395 picks in the first 51 comparable weeks are identical between runs 27 and 31. The new diagnostic work changed measurement/interpretation, not these underlying forecasts or picks.

### M08 — Historical prop-profit anecdotes do not evaluate the shipped prop model

**Evidence:** `nfl-props-replay.js:109-130` implements a separate weighted-volume-times-efficiency model rather than calling the shared engine. Lines `151-152` exclude players based on their actual target-week volume, information unavailable before a bet. Lines `159-163` invent a line from trailing outcomes; all bets use assumed -115 (`29-31`). Significance treats observations independently (`199`, `216`) despite shared players/games/weeks. Proxy rounding (`44`) shifts integer-rounded values upward to a half-point. The proxy's mean is not necessarily a 50% median. Shuffling outcomes across players of very different quality is not a realistic conditional null (`175-178`, `240-273`).

**Change:** Preserve as an explicitly biased legacy diagnostic or retire it from headline evidence. Build actual as-served predictions for every player in the decision-time eligible roster, join exact historical quotes where available and report coverage/drop reasons. No actual-week volume eligibility. Distinguish active-but-zero usage, inactive void, injury-shortened game and missing outcomes according to book rules.

**Acceptance:** Same offered prop with zero actual opportunity cannot silently vanish. No real-quote input -> no sportsbook ROI claim. Compare the shipped system to trailing mean/median and no-vig market on the same contracts; resample games/weeks, with repeated-player dependence sensitivity.

### M09 — TD calibration trains on a different raw probability than live simulation

**Evidence:** `nfl-props.js:117-124` computes TD probabilities analytically at expected opportunity, e.g. `1-(1-rushRate)^meanCarries*(1-recRate)^meanTargets`. The live input at `556`, `579-580`, `660-662` is an empirical probability from random team volume and allocations. In general `E[(1-r)^N] != (1-r)^E[N]`; mixing volume changes no-score probabilities. Calibrator rows are the analytic `r.market.anytime_td` (`nfl-prop-calibration.js:228-231`).

The new `walkForwardTdCalibration` fits on earlier seasons, but chooses the best among all heads by their *training* Brier (`339-342`), unlike the explicit train/discovery/validation competition in `auditTdCalibration` (`234-272`). Its text says it grades what production would have shipped (`367-370`), which is overstated. The paired TD p-value randomizes player rows independently (`208-221`), not weeks/games. Active TD lookup has no cutoff and will apply the current fit to any historical `projectWeek` call (`374-383`). An `intercept` calibration head (`51-54`, `75-101`) lacks a logit(p) offset and is actually a constant base-rate model, despite its name.

**Change:** Use the same sampled/analytic marginal distribution definition everywhere. Nested calibration choice on prior validation blocks; frozen calibrator per prediction cutoff; week-cluster inference. Rename constant heads honestly or implement true offset intercepts. Separate raw, calibrated and market scores without conflating populations.

**Acceptance:** Live Monte Carlo and replay of the same volume/role mixture agree within declared simulation error; analytical identities are checked only where they describe that same distribution; all historical calibrator training endpoints precede decisions; larger calibrator libraries do not improve a fake in-sample headline. Compare against identity and training-only base rates using Brier/log loss and reliability.

### M10 — Prop event simulation violates football relationships and treats QB share as game participation

**Evidence:** `projections.js:631` draws catches; `633` independently draws receiving TDs from targets, permitting a receiving TD with zero catches. Source-extracted function with one target and controlled random draws produces `rec=0, recYd=0, recTd=1`. **Qualification:** real NFL statistical rules can credit a receiving TD without a reception after a lateral; `recTD<=rec` is therefore not a universal box-score invariant. This sampler has no lateral branch, prior catcher, ball-transfer event or other shared play state—its entire mechanism at `625-634` is independent binomial/gamma draws, and neither `player-week-engine.js` nor `nfl-props.js` supplies such a mechanism. The demonstrated problem is that ordinary non-lateral receptions and receiving TDs are disconnected, not that every historical zero-catch receiving TD must be impossible. Team-level player attempts and receiver yardage/TDs are sampled separately, so total receiver yards/TDs need not equal quarterback passing yards/TDs. `player-week-engine.js:535-536` draws team pass attempts and carries independently, with no shared total plays/game script realization. This is an opportunity-allocation simulation, not a fully coherent game-plus-player simulator. The lateral exception follows the [official NFL Guide for Statisticians](https://www.nflgsis.com/gsis/documentation/stadiumguides/guide_for_statisticians.pdf#page=17).

`historicalPrimaryQbShare` (`310-335`) averages top-QB attempt shares. `sampleTeamWeekEvents` (`538-551`) uses that fractional share as probability that the primary QB gets *all* attempts versus zero. This preserves a rough mean but converts midgame substitutions into artificial whole-game benchings and distorts tails and unders. Correct book-specific inactive rules matter.

**Change:** Start with a coherent hierarchy: active status / starter -> total plays -> pass versus run -> QB participation/time fraction -> player targets/carries -> catches -> yards/TDs. For ordinary non-lateral plays, receiving TDs must follow a completed reception; if lateral/other exceptional accounting is modeled, represent it explicitly with the relevant official statistical attribution. Completions/receiving yards/TDs reconcile to passer totals under the modeled scoring rules. Keep residual unassigned players/throwaways/sacks explicit. Learn or validate conditional dispersion on previous folds; do not assert coherence just because sums of targets are bounded. Tail design should handle legitimate negative rushing yardage and DNP voids.

**Acceptance:** For the ordinary no-lateral play mechanism, `recTD<=rec<=targets`; exceptional lateral accounting has a separate explicit fixture and provenance rather than being rejected as bad historical data. At team/play level, receptions/completions, receiving/passing yards and touchdown credits reconcile under the official rules represented. QB attempt totals and rush totals satisfy the chosen play accounting. Validate unconditional and active-conditioned zero masses, tails, interval coverage and probability scores by market/position/role, not only MAE.

### M11 — Replayed priors can silently use today's fitted shrinkage

**Evidence:** `projections.js:369` calls `activeKVector()` whenever no override is passed. `shrinkage-fit.js:318-324` selects today's active fit without a date/season cutoff. `buildPlayerWeekEngine` passes `kOverride` optionally (`134-145`), and ordinary `propReplayRows` does not specify one (`nfl-props.js:94`). By contrast weekly weight lookup already filters by earlier season/week (`weekly-weight-store.js:8-17`). Hardcoded recency and INT rate are also openly chosen on 2023-25/2022-25 (`projections.js:64-71`, `96-109`), so replaying those same years after tuning is development evaluation, not unopened holdout evidence.

**Change:** Every fitted shrinkage/dispersion/role prior must resolve by information cutoff and immutable model artifact. Allow explicit current-policy retrospective diagnostics but label them as such. Include fit IDs in cache and prediction keys; appending a new active fit should not mutate old audit predictions.

**Acceptance:** Promote a synthetic future shrinkage fit, then replay an earlier date; prediction unchanged. A current prediction carries the active fit IDs; cached results invalidate when their dependencies change.

### M12 — Findings lifecycle does not enforce its claimed frozen, independent validation (local-only)

**Evidence and effects:**

- `runCandidateFindingsForSeasonEnd` runs new-season discovery first (`217-222`). For a previously discovered finding, `recordDiscoveryFlag` returns `already_past_discovery` (`124-125`), yet its key still enters `flaggedKeysThisSeason`; line `233` skips its holdout. Thus whether a future year counts as validation depends on inspecting that year's result first; some confirming seasons are specifically censored.
- `proposeAdjustment` checks only overlap (`nfl-replay.js:780-786`), not that holdout is later than all discovery. Its public path can accept reversed years.
- `segmentRuleHash` hashes dimension/segment/direction labels (`753-755`), not the implementation or feature definition. Holdout/live veto use current `segmentsFor` without verifying the stored hash (`nfl-candidate-findings.js:174-186`, `264-272`). Changing predicate logic leaves the nominal hash unchanged.
- Holdout success is merely higher rounded ROI (`nfl-replay.js:731-732`; findings `184`), not uncertainty of a paired policy-value improvement. Three positive nominal seasons are not an explicit statistical evidence calculation. Vetoing a segment can raise average ROI while reducing total expected/realized profit; compare both on the full slate including abstentions.
- Both weakest and strongest segments are registered (`221`), but `proposeAdjustment` always drops the segment (`794`). Useful versus harmful findings need different declared semantics.
- Requiring three additional NFL seasons means the manually observed 2021–2025 patterns would need results from the 2026–2028 seasons under that calendar. That is a workflow choice, not a mathematical necessity. A predeclared sufficiently powered block/sequential protocol could be more practical without weakening evidence.

**Change:** Once discovered, freeze model/policy/predicate/feature snapshot/schema/dependency hash and predeclare all future validation blocks. Consume every eligible later block exactly once before exploratory analysis; discovery-only searches cannot censor it. Define kill, continue and review rules from paired net-return/proper-score intervals or a valid sequential method. Separate weak-segment veto trials from strong-segment selection trials. Do not silently reduce proof thresholds to get a green badge.

**Acceptance:** A finding that flags again still gets that later season evaluated as holdout. Reversed/overlapping years rejected. Predicate/model/feature changes create a new experiment. Failed and unavailable blocks retained. Null effect and random labels do not repeatedly promote with annual rechecks.

### M13 — Several expert names and confidence claims overstate the implemented information

`nfl-ensemble.js:492-501` calls a component opponent-adjusted EPA, but subtracts a league mean twice; it cancels algebraically and yields offense EPA minus defense EPA. There is no adjustment for opponents faced in that function. `rest_travel` (`518-529`) includes rest difference and a constant -0.4 for division games, no travel; the division term always moves toward away, not generally toward zero as its comment implies. Component agreement confidence (`1192-1203`) is a heuristic edge/disagreement ratio, not a calibrated probability that a bet succeeds.

`research/tree_lab.py:266-300` names interactions market movement×QB uncertainty, OL continuity×pressure, pace×pass-catcher availability, forecast revision×stadium, rest/travel×game time. Actual inputs are opening overround×EPA volatility, prior QB-hit rate×pressure EPA, drive pace×pass rate, 3-versus-8-game margin change×roof, and rest×approximate time slot. The code discloses proxies in comments; UI/docs should do so too. These columns do not mean actual timestamped QB state, OL continuity, receiver availability or weather forecast revision is modeled.

**Change:** Source-to-feature-to-head map with status `actual measurement`, `proxy`, `missing`, `shadow`, `active`. Rename proxies and measure whether they add anything conditionally after the market. Replace proxies only when there is timely new evidence and an a priori mechanism. Never use the count of components as evidence of model quality.

### M14 — Weather and temporal labels still need per-path qualification

The established ensemble trains/forecasts historical games with `game_lines.temp/wind` (`nfl-ensemble.js:55-60`, `697`, `1105`) and uses them in weather total (`545-556`). GBM explicitly substitutes *actual kickoff* weather when schedule weather is absent (`nfl-gbm.js:148-156`). These are valid retrospective close-environment/oracle diagnostics if labeled accordingly, not an opening-time forecast feed. The Python tree lab makes a conservative three-day publication proxy for historical result/PBP availability (`tree_lab.py:154-170`) and has explicit timestamp/paired quote checks (`193-205`); that is a useful improvement but cannot recreate original historical revisions or prove retrieved-as-of vintages. Target `label_at` is closing quote time (`307`) even for the outcome classification label; use actual result settlement/publication time for that target despite the seven-day embargo usually masking it.

**Change:** Exact event/source/observed/effective timestamps per feature, forecast run IDs for weather, explicit backfill/oracle labels. Select one source-of-truth as-of dataset for the chosen market horizon. The leakage scanner (`research/leakage.py:19-24`, `64-97`) is a useful extreme-leak heuristic, not a proof that weak future leakage is absent.

**Source qualification from the plan review:** Open-Meteo labels its ECMWF HRES history beginning March 14, 2024 as IFS Cycle 49R1 hindcasts. Historical initialization time alone is therefore insufficient evidence of contemporaneous operational availability. Preserve run type, model cycle, issue/dissemination, receipt and valid times; require actual vintage evidence for historical T−60 use. [Single Runs documentation](https://open-meteo.com/en/docs/single-runs-api).

### M15 — Existing sequential-significance labels exceed the qualified test case (follow-up source review)

**Evidence:** `backtest-significance.js:186–203` implements `alwaysValidPValue`. If supplied scale parameters are absent, it estimates observation variance and the mixing-prior scale from the same tested sequence. It then returns an unconditional note claiming repeated checking at any sample size does not inflate false positives. The comments at `174–183` acknowledge the distinction between predetermined parameters and a plug-in estimate but assert that a sealed single audit makes the latter acceptable. `audit-registry.js:210` invokes the helper with optionally supplied scale parameters. `test/always-valid-significance.test.js` verifies the known-variance Gaussian case and basic edge cases; that does not establish the same guarantee for the default plug-in calculation or dependent betting returns.

**Scope:** This is a source/assumption finding from the GitHub-adoption follow-up. It is not an independently measured false-positive rate for current Gridiron runs, and it does not establish that this statistic overrode every audit's other gates. Inspect each registered audit's actual parameters and authority before attributing a decision to it.

**Change:** Remove unconditional validity claims from unqualified/default paths. Specify the estimand, observation unit, distribution or tail bounds, dependence, variance treatment, prior choice, adaptation rule, and test null. Qualify the implementation for that construction or use an appropriate fixed-endpoint evaluation until a defensible sequential method is selected. Preserve original reports with correction notes. A new `confseq` dependency is optional; a package cannot establish the assumptions for the data.

**Acceptance:** Predetermined known-variance fixtures reproduce the applicable reference formula; missing or sequence-fitted parameters cannot emit the same unconditional certification. Validation scenarios cover the actual return bounds, asymmetric payouts and expected dependence, with the test's limitations stated. Null simulations are useful diagnostics, not a proof for arbitrary data processes. The confidence-sequence literature supplies constructions under explicit assumptions. [Howard and colleagues](https://arxiv.org/abs/1810.08240).

## Saved local research evidence, read from actual report artifacts

These are development diagnostics on repeatedly opened historical years. They are not forward profit estimates and were not rerun in this audit.

### Tree/AutoML lab

Artifact: `server/data/tree-lab/20260908T164200Z-2e46b49a/report.json` (same contents via latest); 1,795 market observations; `untouched_holdout:false`.

- Spread movement: the selected predictor is `no_move` in 2023, 2024 and 2025, with zero paper bets.
- Spread cover models selected TPOT all three years. Model log loss versus market is 0.8025 vs 0.6933 (2023), 0.7121 vs 0.6941 (2024), 0.7048 vs 0.6939 (2025). Indicative archived-price ROI is -4.82%, -5.33%, -14.11%; respective bet counts 243, 209, 105. All intervals include zero; this is still evidence that the searched models have not earned their extra complexity.
- Totals movement has one useful later-year predictive result: 2025 MAE 1.5813 vs no-move 1.6421; paired gain interval [0.0077,0.1227]. Its 31 paper bets nonetheless return -7.54% with very wide interval [-44.85%,20.83%]. The 2024 movement model is significantly worse than no movement. Do not promote the attractive isolated 2025 number after seeing all folds.
- Totals cover selects TPOT in 2023/24 and market-only in 2025. Indicative ROI +4.53%, -7.17%, undefined/zero bets; market-only fallback is appropriate.
- Market-anchored logit chooses shrinkage 0.0 for both spreads and totals in 2025: it discards its incremental learned signal and returns the market.
- Top-three-per-week ranker in 2025: spreads 56 picks, -16.76% ROI; totals 58 picks, -9.21%. NDCG 0.76/0.79 does not mean the ranked bets make money.
- Spread quantile models select market-only all three years. Totals quantile selects a GBR in 2023, market-only in 2024/25. Conditional distribution work exists, but no uniform improvement has been established.

### Expert selector

Artifact: `server/data/expert-selector-lab/20260908T212214Z-4514de3d/report.json`.

Council, tree-spreads-movement and tree-totals-movement substrates all report `any_trial_passed:false`; no configuration meets the declared primary or secondary MSE rule. Some conditional gates are significantly worse than the market. The code actually does nested temporal selection, bounded family gates and first-class market fallback; replacing it with a vague "learn which model is right" proposal would repeat work that has already been done. Better/new as-of information is needed before another broad gate search is attractive.

### Role scenarios

Artifact: `server/data/role-scenario-lab/099899267f1f752b/manifest.json` / latest.

The scenario allocation has a modest historical opportunity improvement on beneficiaries: 2024 touches MAE 2.572→2.500; 2025 MAE 2.473→2.429, mean paired difference -0.0457, with a 90% interval [-0.0742,-0.0170]. But combined yards worsen in both years (2025 21.533→21.669), and this is not a real-price prop test. This is the most plausible targeted *player opportunity* project to refine, not evidence of profitable yardage bets.

The role-changepoint detector has 2025 precision 7.16%, recall 4.96%, F1 0.0586 versus existing F1 0.0548; its improved recall comes with lower precision. The same report found legacy injury cascades allocate more beneficiary opportunity than the absent player's own in 30/110 cases (27.3%). Use explicit conservation and joint roster scenarios.

The report uses team-week bootstrap (`role-scenario-lab.js:52-54`, `133-138`), weaker than the current canonical whole-week OOF-1 instruction; apply whole-week and repeated-player sensitivity before calling significance durable. Upstream injury multipliers being "validated elsewhere" does not establish their fit dates precede each downstream historical test; require lineage.

### News and book response

News impact latest has 30 events / 24 verified but 0 usable claim/post-claim quote pairs, 24 skipped, so qualitative numeric impact is not yet learnable here. Missing output is a data alignment/coverage gap, not evidence news has no effect.

Book-lag latest reports 8/8 target cells beating baseline, but explicitly a single-week pilot across 44 events and roughly 360-second native polling. This is worth a bounded continuation; do not turn it into a verified subminute execution edge or a season-long claim. The execution audit covers its microstructure limitations.



## Detailed execution findings

## Offline evidence

Command in `work/gridiron-local`: `node --experimental-test-module-mocks --test --test-concurrency=1 test/nfl-execution-pipeline.test.js test/nfl-execution-replay.test.js test/nfl-execution-decision.test.js test/nfl-execution-lifecycle.test.js test/nfl-execution-staking-policy.test.js test/nfl-prospective-collection.test.js test/nfl-candidate-findings.test.js`.

**81 passed, 0 failed**, approximately 2.7 seconds. The full log is included in **AUDIT-VERIFICATION.zip**.

Independent probes: `execution-repro.mjs`, `execution-findings-repro.mjs`, and `model-microchecks.mjs`, with saved outputs in **AUDIT-VERIFICATION.zip**. The portable scripts were checked again against the isolated frozen source and reproduced the same defects. The bundle includes the selected frozen audit records, numerical-review values, source commit, checksums, and reproduction instructions. These are audit-only probes, not app changes; model-expression extraction is specific to the audited source. No live database or full private conversation is included.

Observed results:

- Wanted current `z-new-game`, connector chose old `a-old-game` with price -140.
- Exact requested line absent but sibling lines present: connector returned a nonempty timeline and `quote:null`.
- Decision quote should be latest -155; connector returned earliest -140.
- `price:0` accepted; a won settlement stored `realized_pnl_units:null`.
- Accepted -7.5 kept the opportunity’s `...|-3.5|...` contract key.
- `team_score:20, opp_score:null` settled as won (+0.9091 units).
- A 51% candidate at -110 passed the frozen selection policy when marked calibration eligible, despite expected net return **-2.636%**.
- A segment repeatedly flagged in six consecutive seasons received zero holdout tests and stayed `discovered`.

## Priority findings and concrete instructions

### E1 — P0: wrong-game quote joins and wrong decision quote

Code: `server/services/nfl-execution-pipeline.js:89-98`, `149-157` (same in both commits).

`resolveQuoteBasis` reads distinct provider events from the entire quote tape and chooses the first whose resolved teams match. It does not compare commence time, date, season, or a canonical event key. Repeated matchups are common; the new six-season backfill magnifies this. SQL supplies no relevant ordering. The connector also selects the **first** quote in the timeline, while replay selects the **latest at/before** decision time. Consequently the recorded decision and replay can refer to different prices even when the event is right.

If the tape has only sibling contracts, `timelineFromQuoteTape` returns `removed` samples. `timeline.length` passes but `basis.quote` is null; the caller dereferences it at line 150 and aborts the whole run. The new removal-history behavior created this unhandled case.

**Fix:** Resolve the scheduled game into one canonical event identity including actual kickoff; join provider mappings through that identity, never `.find` on team names alone. Refuse ambiguous mappings. Freeze a decision instant once, select only a valid quote known by that instant, and carry its immutable quote ID, event ID, snapshot/retrieval time, book update time and source throughout offered/observed/decision. Use the same selected price as the replay reference. Require an actual quote, not merely a nonempty timeline. Return a reasoned per-candidate failure without aborting the rest of the slate.

**Acceptance tests:** Same teams in two seasons and in regular/postseason; rescheduled kickoff; raw name aliases; old event sorts before new; exact line disappears; no exact line ever existed; only future quotes; two prices before decision; provider mappings disagree. Assert the decision quote ID, price, contract and replay reference agree exactly and no future or other-game data enters.

### E2 — P0: eligibility compares advantage to fair probability, not executable break-even

Code: `server/services/nfl-auto-picks.js:118-138` locally (GitHub analogous calibration eligibility at 126); `server/services/nfl-policy.js:81-106`.

A positive calibrated difference over a no-vig prior is enough to pass `calibrationEligible`, provided the three-point edge and disagreement guards pass. `applyNflPolicy` never checks expected net return at the quoted odds. **51% versus fair 50% is an improvement, but at -110 it loses 2.636 cents per dollar in expectation.** Price deterioration between selection and acceptance is not re-evaluated either.

**Fix:** Compute win/push/void/loss probabilities for the exact contract; require positive conservative net EV at the actual obtainable price after the chosen slippage/cost buffer. Rank by conservative economic value and uncertainty, not raw point edge alone. Keep forecast skill, calibration eligibility and bet profitability as three separately reported conditions. Do not loosen the existing unproven-calibration gate to get more selections.

**Acceptance tests:** p=.51/-110 rejected; p=.53/-110 must still clear required uncertainty/execution buffer; changed price can invalidate formerly positive bet; integer lines include push refunds; void-sensitive markets use full settlement probabilities. Replays and forward decisions must execute the same price-sensitive policy.

### E3 — P0: line/price input can corrupt exact-contract ledger and P&L

Code: `server/routes/nfl-market.js:361-374`; `server/services/nfl-execution-lifecycle.js:128-158,185-190,208-222`; `server/services/nfl-execution.js:38-40`.

The accept route validates only positive stake, converts `body.price` with `Number`, and forwards an arbitrary line. Null or empty input becomes zero. The lifecycle validates finite stake but not valid American price, required book, market-specific line, matching exact contract or timestamp order. Winning price zero produces Infinity, which `r4` turns into NULL P&L. Changed -7.5 line can remain recorded under immutable -3.5 contract identity. Missing accepted line leaves a position ungradable. The exposure gate does not prevent these input defects.

**Fix:** Enforce a shared strict boundary schema at route and ledger primitive: nonempty valid book, valid American odds, finite positive stake, line required for spread/total, consistent participant/side/period/rules, chronology. Separate “observed quoted contract changed” from acceptance: create/link the replacement exact contract and preserve the original decision lineage. Store accepted ticket identity and currency/units definition; do not silently rewrite contract identity. Invalid payout is an error state, never null-to-zero in a P&L sum.

**Acceptance tests:** Missing/null/empty/zero/string-invalid odds; fractional American input policy; missing line; price only move; line move across key number; book switch; acceptance before decision; accepted after known settlement. Confirm invalid inputs leave no partial event or exposure. Every settled row’s economics reconcile to accepted ticket values.

### E4 — P1: actual desk omits advertised corridor/suspect gates; size policy remains disconnected

Code: `client/src/pages/betting/NflExecutionDesk.tsx:39-53`; `server/routes/nfl-market.js:367-372`; `server/services/nfl-execution-decision.js:46-83`; `server/services/nfl-execution-staking-policy.js:104-131`.

The actual UI sends only stake, price, line and decision book. It never sends `fairProbability`, `modelLine`, or `marketLine`, so both checks in `attemptAcceptance` are skipped (`corridor:null`, `suspect:null`). The server could obtain authoritative values from the frozen decision but does not. The acceptance path also does not call `compareStakingPolicies`, the downsize controller, or a trusted market scorecard. Repository searches found no live route/service consumer of the new comparison or `currentClvDownsizeMultiplier`; modules are not automatically controls simply because they exist and pass unit tests.

**Fix:** Separate an honest user ticket import from a system-approved recommendation. Never refuse to record a real ticket merely to keep compliance statistics attractive: record it as user-entered/outside-policy when necessary. For approved recommendations, load checks server-side from frozen trusted data and record evaluated/pass/fail/missing plus version. Missing gate inputs fail closed for recommendation authority. Persist acknowledged breaches and actor. Apply one policy adapter to live sizing, replay sizing and display; it must read trusted scorecards and current exposures rather than caller-provided “calibrated” flags.

**Acceptance tests:** Submit the UI’s exact request shape with an extreme model-market gap; prove missing body fields cannot bypass required checks. A market with calibration failure sizes zero; CLV downsize zero sizes zero; a user-reported ticket remains recordable but explicitly outside-policy. Compare rendered amount, accepted recommendation cap and replay amount.

**Spread-only implementation qualification:** those zero-stake requirements govern recommendations, not explicitly labeled fixed-unit diagnostic paper observations. The existing fixed-paper mode can collect evidence before money qualification. The CLV-downsize module documents synthetic-path validation; keep it and Kelly shadow-only until the later spread evidence and policy review specified in the main plan. A module being disconnected does not itself justify activating it.

### E5 — P1: execution “edge” can bypass proof despite relying on an estimated probability

Code: `server/services/execution-slate-reasoning.js:96-114,152-175,227-248`; `server/services/nfl-execution-edge.js:60-109,214-237`; `server/routes/execution-slate.js:26-56,112-114`.

Shopping is valuable, but the automated recommendation labels `shopped_line` and `teaser` as source `execution`, which bypasses the model positive-CLV gate. Shopped-line win probability is hardcoded `0.5 + lineEdge`; lineEdge is estimated from unconditional historical absolute margins split symmetrically, not an observed win probability for this game/number/price. Integer pushes are represented as half a win, which is a ranking approximation rather than exact EV at arbitrary odds. Teaser probability likewise relies on a historical estimated leg rate and cross-game assumptions. The system calls these “PROVEN edge” opportunities without the same forward calibration standard.

**Fix:** Retain shopping as a cost-saving feature. Treat profitable shopping selection and teaser probabilities as separate empirical strategies requiring validation. Same-line best price comparison can be exact relative savings; an absolute profitable wager needs an independent fair probability or validated conditional margin distribution. Estimate signed discrete margin/push probabilities conditional on market line, total, era and relevant context; compare to market-implied alternative-line ladders where available. Report ranking/savings separately from absolute EV. Remove the source-label shortcut around authority gates; only proven riskless arbitrage with verified rules/obtainability has fundamentally different evidentiary requirements.

**Acceptance tests:** A quote better than median yet still negative EV never becomes a recommended bet. Discrete push refunds reconcile at -110 and +150. Favored and underdog lines with the same absolute margin do not assume identical probabilities unless tested. Historical seasons later than decision cutoff cannot enter line-value estimation. Model versus execution source labels alone cannot grant stake authority.

### E6 — P1: Phase 2 does not persist all policy decisions, and existing persistence is mutable

Code: `server/services/nfl-execution-pipeline.js:119-123`; `server/services/nfl-auto-picks.js:184-208` locally; `server/routes/nfl-market.js:418-420`.

The pipeline’s header says `autoPickDecisionBoard` already records every candidate and abstention. It actually only computes/returns a board. `persistPickDecisions` is separate and is called by the older `sync-and-pick` route, not the execution-run route. With no selected candidates, the new pipeline writes no decision evidence. Even when the older route persists, it upserts over the same season/week/policy/matchup/side identity, replacing earlier price, features, reasons and timestamp; the conflict key omits policy version. That is not an immutable chronological decision tape.

**Fix:** Create an append-only decision-run/event layer with run ID, precise cutoff, model/policy/data hashes, quote ID and all candidate/abstention reasons. Repeated identical runs may be content-addressed/idempotent, but changed inputs require a new immutable run. Connect the execution opportunity by decision ID. Keep a mutable latest-view only as a projection. Add structured terminal pass/expired/cancelled outcomes to the lifecycle so denominator and reason for non-execution are measurable.

**Acceptance tests:** Zero-selection run writes all abstentions. A quote or policy version change creates another event while first remains byte-identical. Same input retry does not duplicate. Every selected opportunity traces to one frozen selection; every offered/declined/expired result remains accountable. This also avoids indefinitely reusing stale open opportunities when the model reverses its view.

### E7 — P1: preview claims obtainability before the future has been observed

Code: `server/services/nfl-execution-pipeline.js:152-165`; `server/services/nfl-execution-replay.js:129-230`.

The new finite 1,800-second staleness policy is a real improvement over Infinity. However a live pipeline takes a frozen timeline ending now and immediately evaluates +5/+30/+120/+600 seconds, reusing the latest quote within the trust window. It labels these `filled_as_decided` although those future instants have not happened. The single-sample caveat is candid but incorrectly says every bucket always fills (the new staleness checks can contradict it). A finite trust window is an assumption about acceptable freshness, not confirmation that a price survived a delay. Replays with six-minute median capture gaps also cannot directly measure five-second survival.

**Fix:** At decision, show assessment pending. Schedule or request actual later capture and append evaluation after each horizon; preserve right-censoring when a horizon is not observed. For historical replay, return `unknown/censored` beyond captured coverage or distinguish modeled carry-forward from directly observed availability. Report freshness and inference policy separately from fill outcome. Calibrate latency assumptions to actual use and report uncertainty for intervals between observations.

**Acceptance tests:** Timeline ends at decision, requested +600 seconds -> pending/censored, not confirmed fill. Later unchanged direct quote -> observed survival; later missing contract with successful same-market book response -> disappearance; provider outage -> unknown; post-kickoff samples cannot establish a pregame fill. Time-shifted replay must be deterministic.

### E8 — P1: settlement can fabricate a result from incomplete score, with no correction path

Code: `server/services/nfl-execution-pipeline.js:197-204`; `server/services/nfl-execution-lifecycle.js:208-223`; migration `023_execution_lifecycle_ledger.js` terminal state and append-only triggers.

Only `team_score` is checked. Missing `opp_score` is subtracted as zero in JavaScript. The isolated 20/NULL fixture settled a -3.5 favorite as won. The code additionally treats score presence as finality rather than explicit confirmed game status; feed semantics may presently populate scores only at completion, but the settlement boundary does not enforce that contract. Settlement is terminal with no compensating correction event. That makes provider corrections, mis-keyed tickets, abandoned games or later book rule decisions operationally hard to reconcile.

**Fix:** Require both scores finite plus authoritative final/completed state and exact event/opponent identity. Keep postponed/cancelled/abandoned handling explicit. Add append-only settlement adjustments/reversals keyed to reason, source and actor, preserving the original grade and recomputing realized economics from net ledger events. Never silently mutate or delete past results.

**Acceptance tests:** Either score missing; both zero before game; live score present; opponent mismatch; postponed date; official correction; book void. No nonfinal record settles. Corrections reconcile exactly without duplicate wins or phantom open exposure.

### E9 — P1: accepted positions, CLV and staking learning are separate systems

Code: `server/services/nfl-execution-lifecycle.js:208-223`; `server/services/nfl-clv.js:63-88,216-250`; `server/routes/nfl-betting.js:900-912`; no lifecycle-table consumers in `nfl-clv`, `nfl-prop-clv`, `nfl-profitability`, `nfl-execution-staking-policy`, or `nfl-execution-clv-downsize`.

The new lifecycle computes realized P&L, but closing-value grading still operates on `nfl_bet_log`, requiring another recordBet action and using `nfl_line_snapshots`. There is no automatic accepted-event -> exact-contract close mapping. The new quote-tape history therefore does not automatically improve the accepted-bet learning loop. Multiple ledgers also have different semantics: user bets are deletable; lifecycle is append-only; auto-picks have zero stake; CLV log represents placed bets.

**Fix:** Make one accepted ticket/economic ledger authoritative and give all scorecards adapters over it. Preserve paper decisions separately but with common contract/quote/model IDs. Match accepted contract against independent exact-line closing fair prices; if exact-line close is absent, disclose a priced-line transformation and uncertainty rather than blending unlike contracts. Record observation coverage/denominator and missing-close reasons. Add data/provider/API costs for net profit reporting. Reconcile user-recorded accepted tickets against actual sportsbook exports before declaring realized live ROI.

**Acceptance tests:** One recorded accepted ticket appears once in exposure, settlement, CLV and strategy scorecard; retry idempotent. Closing data arrives late -> grade once. Missing close does not remove a losing bet from ROI. Multiple books/same game do not inflate independent evidence count. Strategy/source/book aggregations sum exactly to total dollars and units.

### E10 — P1: new prospective collection is manual only and can misreport failures as healthy

Code: `server/services/nfl-prospective-collection.js:45-64`; `server/services/nfl-quote-tape.js:110-115`; `server/services/nfl-news-events.js:123-142,166-171,175-197`; `server/services/scheduler.js:996-1008`.

The button is a real new capability, and respects the existing intentional scheduler brake. It calls the quote capture once, then news extraction; it does not ingest fresh news first or capture later response horizons/close. It cannot autonomously form a complete before/after market response series. News event first_seen is assigned at extraction, not actual first receipt of the article, so delayed manual processing erases system-observation timing. The status logic adds errors only when an exception is thrown. Both underlying operations can return `{error:...}` without throwing; those runs get status `ok` when `errors.length===0`. Both dependencies skipped also counts as ok and advances a sync heartbeat.

**Fix:** Do not silently remove the operator’s scheduler brake. Build a bounded collection session/workflow with explicit operating schedule, wake/restart checkpoint, coverage target and cost ceiling, then have the owner deliberately choose manual sessions or an always-on host. Capture first_received_at when ingesting source, extraction_completed_at separately, exact claim novelty and provenance, concurrent/adjacent contemporaneous quotes, planned +30s/+2m/+10m/close observations as budgets permit. Process returned errors/skips/empty successes into truthful statuses and last-successful-data timestamps. Track marginal spend per usable claim/quote pair.

**Acceptance tests:** Returned error object -> error/partial, never ok. Both skipped -> blocked/skipped with no successful-data watermark. One half fails -> partial. Restart mid-session resumes without paid duplicate; machine sleeps -> gap visible. A claim ingested before extraction retains both clocks. Paired horizon coverage and costs count only rows actually collected.

### E11 — P1 local-only: candidate-findings loop chooses holdout after looking at its results

Code: local `server/services/nfl-candidate-findings.js:217-237`; `recordDiscoveryFlag:124-125`.

Every year the orchestrator first searches for weak/strong segments. It builds `flaggedKeysThisSeason` even when a previously discovered finding returns `already_past_discovery`, then excludes these findings from holdout. Thus the same bad segment flagged again is not validated in that year; years offered as holdout depend on whether the answer appeared in the search. The six-season mocked replay demonstrates a permanently repeated weakness receives zero holdout tests. This is both a progression bug and an outcome-dependent holdout selection error.

**Fix:** At start of cycle, freeze the list of already-discovered/validating findings and eligible chronological future seasons. Test every predeclared applicable finding on this season exactly once regardless of whether rediscovery analysis flags it. Run discovery for genuinely new candidates separately. Freeze target, action, segment definition, model/selector version, discovery set and future evaluation schedule. Log no-data/inconclusive separately from failed; do not permit outcome-based skipped years. Because five full independent seasons to discover+confirm is a very long operational cycle, use predeclared weekly/game clusters for prospective monitoring while keeping truly untouched seasons for final promotion; do not manufacture independence by relabeling previously inspected data.

**Acceptance tests:** Repeated same segment six years -> two discovery years plus holdout tests on all later predesignated years. A good/bad/inconclusive year cannot be excluded by rediscovery flags. Entire pipeline ordering reproducible. No chronological holdout precedes discovery. Failed and sparse seasons remain recorded.

### E12 — P1 local-only: promoted finding need not change cached live decisions

Code: local `server/services/nfl-auto-picks.js:75-91,133-138`; `server/services/nfl-candidate-findings.js:284-293`.

Promotion is now wired into the computation, which is genuine progress over an unused registry. However the decision board cache key fingerprints only game-line count, max fetched_at and sum(spread), plus options and policy identity. Promotion updates findings without clearing this cache or changing its key. A board already evaluated before promotion may remain eligible until line data changes. The same general omission applies to calibration/model/roster/injury state changes absent a separate upstream invalidation.

**Fix:** Key decisions by immutable dependency snapshot/version hashes, including active findings and calibration, or invalidate explicitly on each authoritative mutation. Before acceptance, revalidate the currently applicable kill/veto controls server-side while preserving the original frozen recommendation.

**Acceptance tests:** Populate cache, promote matching finding with unchanged game_lines, query board -> abstention immediately. Rejection/demotion and calibration promotion/rollback also reflect immediately. Frozen historical decisions remain unchanged; new run receives new hash.

## Smaller but concrete UI/ledger issues

- `NflExecutionDesk.tsx:101-103` shows decision line/price in Positions & Results even after accepted values changed; prefer accepted ticket values and show decision as comparison.
- `NflExecutionDesk.tsx:112-113` reads settlement rules from DECISION, but `openOpportunity` writes them on OFFERED (`nfl-execution-lifecycle.js:100-119`). The intended overtime-rule disclaimer never renders through this path.
- `refreshAll` at UI line 139 does not refetch the funnel, so acceptance counters lag until another action.
- Pending endpoint selects only `decision`, not `refreshed` (`nfl-market.js:329`), so future use of recordRefresh can hide still-unaccepted opportunities.
- No decline/pass/expired lifecycle states despite pending endpoint comment promising a human “accept/pass”; old decisions can remain open indefinitely and suppress new matching opportunities (`pipeline:138-140`).
- Lifecycle funnel `by_stage` counts current status, not cumulative reach. Present it as current state distribution or compute cumulative funnel explicitly; “survival” currently conflates human choice and unavailable quote.
- `isCalibrated` checks whatever keys were supplied with `every(Boolean)` rather than a required typed set. It is not currently a live route, so treat this as a integration precondition, not evidence of existing exploitation. Require all named scorecard gates, model/policy/data version, effective time and authority.


## What the latest work genuinely fixed

Do not tell Claude to rebuild these or claim they are absent:

- Exact-contract lifecycle exists, uses append-only events and a uniqueness guard for one-time states, records accepted as user claims rather than sportsbook-confirmed fills, computes payout from accepted stake/price, and caps aggregate game/player exposure.
- Exposure identity now comes from persisted opportunity instead of caller-supplied game/player (recent correction).
- Replay staleness now has a finite default, unavailable limits are disclosed, overrides propagate through ladder/frozen entry points, and sibling quote evidence can represent an exact contract disappearing.
- Spread pipeline, run/pending/positions/settlement/funnel endpoints and a real user-recorded acceptance UI exist.
- Manual joint quote/news collection exists, bounded extraction and cost/restart limitations are disclosed.
- Fixed-versus-shrunk-Kelly comparison and CLV downsize modules exist as pure research components; integration remains missing.
- Local promoted findings now have a live veto callsite; current cache and validation-order defects must be fixed around it.


## Full model-consumer and organization map

This static map supplements the reproduced defects. It identifies what can change a live numerical forecast, what changes eligibility, what is displayed as context, and what remains research-only. It does not assert that every eligible trained artifact is active today. All locations refer to the primary frozen local source.

**The organizing fact:** Gridiron HQ is a shared data platform with several forecast, simulation, calibration, research and decision systems. It is not one optimizer that reads every piece of information and jointly improves every output. A common engine version labels related artifacts; it does not connect a disconnected numeric output to the final forecast, nor make fantasy, spread and prop losses interchangeable.

`nfl-model-growth.js:218-280` is an orchestrator: after a finalized week and required data freshness, it refits the ensemble, freezes weekly state, calibrates the simulation, fits specialists, trains online neural/risk candidates, settles/retrains fantasy weights and captures expert predictions. At season end it runs the findings and offseason cycles. It records an engine artifact. `nfl-engine-registry.js:43-83` inventories team/weekly/neural/reliability/risk artifacts. This is useful operational coordination, but its `player_props inherits player_usage_fantasy` label (`74`) does not prove fantasy PPG updates enter prop event parameters.

| # | System and code owner | What is fit/updated; output | Actual consumer and authority | Missing connection or required separation |
|---|---|---|---|---|
| 1 | Original rating/market model — `nfl-market.js:100,113,224,263` | Team ratings and predictive scores/probabilities; nested historical evaluation at `378`. | `server/routes/nfl-market.js:3` serves its board. `nfl-props.js:726-740` calls **this** `boardFor` for `topTotals`, then `calibratedTotalProbability`; `ensureTotalPicks` uses that result. | This is distinct from the multi-component ensemble. The `topTotals` comment says it uses the same ratings as spread picks, but current auto spread picks use the residual ensemble below. Totals do not automatically inherit improvements to that spread path. Keep model identity visible in every market view. |
| 2 | Main game ensemble — `nfl-ensemble.js:317-577,865-1040,1047-1189` | Per-component feature-to-point calibrations; held-out error weights; residual slopes/skill gate. Outputs raw or market-residual margin, total, empirical distribution and model trace. | `nfl-auto-picks.js:81-119` defaults to `market_residual` and uses the cover calibrator. `nfl-unified-engine.js:32-53` uses ensemble margin/total as the target means. `nfl-replay.js:182` defaults to **raw** unless caller overrides. Growth refits at `nfl-model-growth.js:224`. | Live, replay and calibration currently do not share the exact same default mode (M06). Challenger exclusion is inconsistent in residual mode (M04). Raw total weighting remains a separate rule from market-residual spread weighting. Do not claim a single ensemble change is already validated on every path. |
| 3 | Signal reliability controller — `nfl-signal-reliability.js:31,118-152` | Uses frozen examples to shrink harmful signal influence; emits multiplier by signal plus dated artifact. | Growth builds it at `nfl-model-growth.js:212`. `nfl-ensemble.js:1052-1053` loads it only when `includeChallengers=true`; applies multipliers to **margin weights** (`1120-1124`). | It does not globally teach every model to trust qualitative/quantitative inputs. Default champion receives neutral multipliers. Multiplying raw margin weights also does not automatically change residual weights or total weights. Explicitly declare the forecast modes affected before calling this a general learning fix. |
| 4 | Online neural residual head — `nfl-online-neural.js:118,175-186,195,226,265-326` | Frozen ensemble/news feature vector -> bounded home-margin residual. Scores pre-update weeks, trains on settled weeks with past replay buffer, persists network versions. | Growth trains at `nfl-model-growth.js:258`; forward capture paths persist predictions. Live auto spread path at `nfl-auto-picks.js:102-106` substitutes neural projected margin when `includeChallengers` or `production_eligible` is true. | Eligibility is derived from accumulated epoch performance (`265-290`), and live consumer directly uses the flag though the returned authority text is `eligible_for_production_review`. Require explicit promotion state and exact-version/horizon calibration before live use; epoch-level changing-network evidence is not automatically evidence for a frozen latest model. Latest-network lookup (`161-180`) also needs historical cutoff parity when replaying. |
| 5 | Expert council + contextual coordinator — `nfl-expert-council.js:19,592-625,632-695`; `nfl-expert-coordinator.js:253-295,422-445` | Specialist forecasts of the market residual; fits Huber/ridge, coefficient caps, per-role shrinkage and correlated families plus contextual regimes. Outputs residual, uncertainty, contribution trace, `historical_candidate_only`. | Weekly audits and forward capture consume it; rows enter expert ledgers. `nfl-unified-engine.js:82` attaches `expertCouncilGame`; that getter reads frozen council rows (`nfl-expert-council.js:835-859`). | It is **not** the numeric predictor selected by `nfl-auto-picks` or the source of unified simulation target means. Attaching a council packet is display/evidence integration. Latest expert-selector tests did not justify changing this. If it later earns authority, route it through one explicit forecaster selection contract rather than silently averaging it with overlapping inputs. |
| 6 | Advanced risk research learners — `nfl-risk-lab.js:231,308,324-349,429-478` | Neural ensemble, Bayesian online, contextual mixture and related candidates over frozen vectors; separately scored and updated after settlement. | Growth trains at `nfl-model-growth.js:259`; research routes can trigger/report these. Status explicitly carries `restricted_research`, zero staking and `direct_betting_authority:false` (`426,478`). | These are challengers, not the operational bet-sizing engine simply because the filename says risk. Do not wire their uncertainty into bankroll allocation without a separately tested probability/exposure contract. Their data and model identity may be shared while economic authority remains separate. |
| 7 | Play/drive simulation + simulation calibration — `nfl-drive-sim.js:605-660,670-759`; `nfl-sim-calibration.js:67` | Play/environment context from prior football data, plus calibrated simulator adjustments. Produces joint scores, key numbers, margin/total shape. Exponential tilting reconciles outcomes to supplied target means. | Growth persists next-week calibration at `nfl-model-growth.js:244`. `nfl-unified-engine.js:42-53` runs it with ensemble mean targets. Simulation/UI/replay routes expose it. | It supplies a **distribution shape**, not independent evidence justifying the target means. Matching average score/dispersion does not validate conditional tail probabilities or profits. This team game simulation is not the same as the player opportunity simulation used for props; their joint player/team consistency is not established. |
| 8 | Structural player state + shrinkage — `projections.js:365-471,625-634`; `player-week-engine.js:134-145,266-306,516-564`; `shrinkage-fit.js:318-324` | Fits/uses position priors, shrinkage, recency, team volume and player opportunity/efficiency. Outputs event parameters; shared team volume/allocations produce player samples. | `nfl-props.js:547-580` derives current prop distributions from this; player/fantasy consumers also use the shared engine. | This is the prop numeric foundation. Current-player state lacks direct numeric application of age/injury/news adjustments in the reviewed engine (`player-week-engine.js:171-223` deliberately exposes metadata). Fitted shrinkage lookup is global rather than historical-as-of (M11). Make role/availability updates enter event state explicitly if validated; changing metadata or PPG alone does not alter prop probabilities. |
| 9 | Weekly fantasy-weight learning — `weekly-learning.js:46,133,151-193`; `weekly-weight-store.js:8-30`; `weekly-ensemble.js` | Learns positional blend of structural PPG, season mean and recent/robust fantasy outcome heads. Fits older 80% of stored rows, compares newest 20%; saves promoted weights on its MAE/rank/coverage gate. | Growth invokes `retrainWeeklyWeights` (`nfl-model-growth.js:261`); shared engine loads weights and updates **PPG** (`player-week-engine.js:138-158,225-235`). Historical weight retrieval is date-filtered. | PPG blending does not update `projection.params`, targets, carries or efficiency used by prop simulation (`266-286`). It is incorrect to infer "weekly fantasy learned, therefore every prop improved." Promotion here is automatic on local metrics (`weekly-learning.js:179-192`), despite broad orchestration wording "without auto-promotion." Also the 80/20 cut is by row and can split a week; align with whole-week policy. |
| 10 | Candidate player/prop head families — `player-head-registry.js:22-100`; `nfl-prop-head-validation.js`; `nfl-prop-player-heads.js:267,347`; `nfl-prop-player-weekly-heads.js:265,345`; `nfl-context-heads.js` | Numerous rolling/median/trend/role/structural variants; contextual TD calibration challengers using season and weekly feature blocks; separate validation and audit functions. | Shared player engine attaches candidate PPG outputs (`player-week-engine.js:230-235`). `nfl-model-watch.js:36-38,49` runs baseline/prop-head audits and records reports. Betting routes expose player-head catalog/audits. | Candidate output attached to a projection is not chosen by `sampleTeamWeekEvents`. The season/weekly TD challenger files have research entry points but no static production import in `nfl-props.js`. Model watch explicitly records findings with no downstream shipping authority (`nfl-model-watch.js:23-28`). Maintain a promotion map per target, not one generic green head badge. |
| 11 | Probability calibrators — `nfl-cover-calibration.js:278-392`; `nfl-total-calibration.js:297-389`; `nfl-prop-calibration.js:234-301,325-383` | Market-anchored cover/total calibration plus TD-head competition. Outputs calibrated probabilities and eligibility evidence. | Live spreads call cover calibration (`nfl-auto-picks.js:118`); totals call total calibration (`nfl-props.js:737`); prop board calls active TD calibrator (`580,661-662`). | They calibrate different targets/processes. Cover currently fits raw replay but receives residual/neural edges; TD currently fits mean-opportunity raw probabilities but consumes sampled-mixture probabilities. Key each artifact to exact raw predictor, event rules, feature/decision cutoff and source quote contract. A calibrator does not create signal absent from its input. |
| 12 | Role scenarios + conserved teammate allocation — `role-scenario-engine.js:120,216,308,364`; `role-scenario-lab.js:94-179` | Alternative roster/injury/role states, probability-weighted opportunity redistribution and changepoint research. Returns baseline/scenario volumes/distributions and experiment result. | `scripts/build-role-scenario-lab.mjs:9` executes/freeze research; `nfl-research-lab.js:6,146` reads saved experiment. No production prop-board import of this scenario module found. | Promising small **opportunity** improvement is not live prop pricing. Current regular prop sampling cannot be assumed to use the new injury-beneficiary scenarios. Integrate only after volume distribution/quote-level tests, with upstream fit vintage lineage and joint active/DNP rules. Yardage experiment worsened. |
| 13 | Preseason/offseason team strength and local Bayesian blend — `nfl-team-strength.js:48-55,301`; `nfl-preseason-blend.js:139-224,228-247` | Aggregates existing player preseason/offseason forecasts into team challenger features; newest module blends previous-season margin with early-season margin and uncertainty. | `buildGbmDataset({extraFeatures})`/`teamStrengthWalkForward` are injection hooks for challenger tests; the local Bayesian one-column feature is explicitly not wired to a production dataset (`243`). Existing player `preseason-model.js` has fantasy/draft/lineup consumers; this is a different use. | Fix reversed Bayesian weighting and vintage/variance estimation before another experiment. Do not tell the user this already improved live team strength, and do not confuse annual fantasy preseason projections with the new team-level blend. A GBM injection hook is available infrastructure, not active consumption. |
| 14 | Error-analysis findings -> abstention learning — `nfl-replay.js:561-645,700-797`; `nfl-candidate-findings.js:211-293` | Finds historical losing/winning segments; records discovery/holdout states; a manually promoted finding matches a frozen-segment concept and vetoes bets. | Season-end growth calls it (`nfl-model-growth.js:248-256`). Live spread `nfl-auto-picks.js:133-138` calls `promotedFindingVeto`; no finding means no-op. | It changes **eligibility**, not team forecast, expert coefficient, prop projection or qualitative/quantitative weights. Current frozen-rule hash/holdout-censoring defects need fixing. Validation should test the exact chosen policy on all eligible future blocks. Historical replay intentionally must not import a future promotion. |
| 15 | Offline Python labs / event-impact research — `research/{market_lab,tree_lab,expert_selector_lab,book_lag_lab}.py`; `nfl-news-event-impact.js`; `nfl-research-lab.js:90-109,146-241` | Market movement, cover probabilities, quantiles, ranking, conditional expert selection, book response and sourced-news impact experiments. Save declarations, datasets, artifacts and reports. | Research lab page reads saved schemas/reports. Tree expert OOF outputs feed **offline** expert-selector inputs; book-response/event experiments supply research evidence. None is imported as the default live forecaster by the reviewed prop/spread prediction paths. | No successful file generation or saved trained model means live integration or profitability. Latest spread movement selects no-move; expert selectors all fail declared bar; role result is narrow; news impact has 0 usable event/quote pairs; book response is one-week pilot. Promote only a qualified exact target/path, not an entire lab suite. |

### Existing information already affects several numerical paths

The follow-up consumer check confirms that the issue is uneven or unqualified use of existing information, not a complete absence of news, injury, or statistical inputs. `nfl-availability.js:62–95` reads injury status and earlier snap shares; `nfl-ensemble.js:320–333` constructs an injury-availability component whose ultimate influence depends on its fitted coefficient and residual weight. Ordinary net/neutral EPA is present at `nfl-ensemble.js:398–405`; additional pass/rush/pressure variants are challenger-only at `411–433`.

Prior player usage and efficiency already enter structural event parameters (`projections.js:385–420,432–471`). Depth/recent-player filtering affects the participant pool (`player-week-engine.js:367–427`), and market game-script multipliers enter prop simulations (`nfl-props.js:547–556`). Verified-news features can enter the online neural residual (`nfl-online-neural.js:145–156,175–186`) selected by the main board under its existing eligibility condition (`nfl-auto-picks.js:102–106`). A static call path establishes potential numerical use; exact prediction traces are needed to establish nonzero contribution for a particular game.

The gaps are consumer-specific. Shared player-news context explicitly has zero numerical authority (`nfl-news-signal.js:184–187`), while generic age/injury prop multipliers are deliberately not applied following earlier performance degradation (`player-week-engine.js:173–221`). The new role-scenario module is a separate research path. Those protections should be preserved until a replacement passes its declared comparison. The plan now specifies controlled existing-input traces and fair feature-family comparisons before acquiring duplicate data or promoting a new connection.

### Product-entry and ledger wiring

Route paths below are relative to their mounted router; route mounts are in the inspected application.

| Product path | Entry → forecast/policy | Persistence and refresh/accept | Close/settle/feedback | Organizational gap |
|---|---|---|---|---|
| Main NFL spread picks | `nfl-market.js` routes `/picks/candidates`, `/sync-and-pick`; `autoPickDecisionBoard` → ensemble with market-residual mode, optional qualified neural, cover calibration, `NFL_PRODUCTION_POLICY` and promoted finding veto | `/sync-and-pick` calls `persistPickDecisions` + `ensurePicksFor`; scheduler `refreshNflDecisionLedger` also persists and separately captures pregame/council (`scheduler.js:696-711`) | Auto-picks grade against game_lines; model-growth is a separate final-week ingest/refit; no shared accepted ticket linkage | Latest decision board, locked zero-unit auto-picks, expert predictions and human bets are different records without one lineage |
| New exact-contract spread execution | `nfl-market.js:318` `/execution/run` → `nfl-execution-pipeline` → existing main board | Opens lifecycle; `/execution/:id/accept`; persisted opportunity/event state machine; refresh helper exists but UI workflow is incomplete | `/execution/settle` → lifecycle result/P&L; existing `nfl-clv` does not consume it | Most complete contract lifecycle, but not the common parent of other ledgers; no automatic closing or learning adapter |
| Main-page user spreads | `nfl-market.js:293` `/bets` → `addUserBet` | Writes `nfl_user_bets`, caller supplies model/price/line; delete route removes row | `gradeBet` derives outcome on read; no close grading; not a frozen model decision | It is legitimate user bookkeeping, not model evidence, but sits alongside auto-pick output |
| General line-shop bet log | `nfl-betting.js:898` `/bets` → `nfl-clv.recordBet` | Writes `nfl_bet_log`; independently typed event, book, side and odds | `/bets/grade` → `gradeClosingLineValue`, reading `nfl_line_snapshots` | Separate acceptance-like action needed to obtain CLV; new lifecycle acceptance does not create this link |
| Routing/logging helper | `betting-hub.js:526` `/execution/log` → `routeBet` → `logExecution` | Writes `nfl_execution_log`, a post-routing record | Aggregate savings/routing evidence; not the new accepted/settled state machine | Similar “execution” naming hides that it records different semantics |
| NFL prop model board | `nfl-betting.js:152` `/props` → `nfl-props.propBoard` → shared `player-week-engine`, game script, prop eligibility/calibration | Market fetch optionally persists raw `nfl_prop_quote_snapshots` (`nfl-props.js:36-45,618-630`) | Separate prop capture path maps prices/model to `nfl_prop_clv`; freezes shadow policy, finalizes closes, settles player stats, produces market scorecards | Displayed board quotes, derived shadow decisions and actual user acceptance are not one workflow; absence of accepted NFL prop tickets must not be filled by MLB ticket tables |
| Prop forward observation | Scheduler `refreshPropCapture` / `refreshFreePropClv` (`scheduler.js:600-630`), routes `/props/quotes/capture-free`, `/reconcile`, `/settle` | `capturePropMarket` / `captureFreePropMarket` → `nfl_prop_clv`; shadow decisions derived deterministically from captured rows | `finalizeClosingSnapshots`, `settlePropQuotes`, `propEdgeEvidence`, `propMarketScorecards` | This IS integrated collection/settlement code; do not claim all prop feedback is absent. But it is quote/shadow evidence, not a unified accepted-ticket/cash ledger |
| AI execution-slate recommendations | `execution-slate.js:32-56,59-115` → shoppingBoard + teaserExecutionBoard → estimated probabilities → gateOpportunities → Claude propose/simulate/review | Response contains allocations/reasons; no persistence call in route | No direct accept/CLV/settlement/feedback connector for the allocation itself | Recommendations are a response artifact; no durable slate decision ID to link later user action or measure allocation decisions |
| Teaser tickets | `betting-hub.js:395-424` `/teasers/execution-board`, `/teasers/executions` → simultaneous per-book quotes, verified payouts, Wong history, `TEASER_POLICY` | `recordTeaserExecution` rechecks CURRENT board, writes `nfl_teaser_executions` + legs, `mode=paper|placed` (`nfl-teaser-execution.js:186-222`) | User supplies final scores to `settleTeaserExecution`; stored ticket/leg outcomes; forward leg-rate aggregate (`235-309`) | Separate multi-leg settlement and paper/placed semantics; no common exposure/cash ledger. Historical user ticket entry also cannot depend on remaining on today's board |
| Football-first forward experiment | `nfl-betting.js:1790-1814` `/forward`, `/forward/record`, `/forward/settle` → `recordThisWeek` → footballFirstLean/pickConfidence | `forward_picks`; `recordThisWeek` has its own edge threshold and outputs abstentions separately (`forward-ledger.js:268+`) | `settleForwardPicks` called manually, scheduler and model-growth | This is another strategy, not the main ensemble forward log; label and link as strategy-specific forecast evidence |
| Expert-council forward experiment | Scheduler `refreshNflDecisionLedger` captures `captureForwardExpertWeek` beside main board | `nfl_expert_forward_predictions`; expert/coordinator snapshots | Own expert settlement and coordinator/refit path | Should remain a separate forecast family unless a tested serving adapter promotes its output into main model |

### Ledger roles and migration constraints

Create a checked ledger catalog with table/service owner, semantic role, allowed writer, primary identity, source/version linkage, mutability, and inclusion in cash/exposure/research totals.

- **Raw evidence:** quote tape/batches, line snapshots, odds archive, prop quote snapshots, raw news and source revisions. Keep immutable ingestion records; derived current views may be mutable.
- **Forecast evidence:** expert forward rows and model-specific predictions. These are not wagers; settling forecast labels must not create cash P&L.
- **Policy decisions:** `nfl_pick_decisions`, prop shadow decision selection, `shadow_decisions`, forward strategy picks, durable future execution-slate decisions. Preserve each selection/abstention and its decision cutoff.
- **Human reported positions and economics:** new lifecycle accepted events, `nfl_user_bets`, `nfl_bet_log`, teaser placed tickets. Designate one normalized cash/exposure projection over their classified records, with deduplication IDs. Do not add numbers from these tables together without knowing whether they represent the same ticket.
- **Paper positions:** auto-picks with zero stake, forward picks, teaser paper tickets, prospective hypothetical fills. Keep separate from cash totals.
- **Routing analytics:** `nfl_execution_log`; belongs to quote-shopping attribution, not authoritative settlement.
- **MLB-only records:** `props_auto_picks` and `saved_prop_tickets` are owned by `server/routes/props.js` and `props-tickets.js`, whose headers explicitly describe the external Diamond Signal MLB project. The generic names are a genuine boundary hazard. Do not count these as NFL prop capabilities/evidence.

Existing mutability needs explicit classification: main pick decisions use UPSERT over prior evidence; user bets can be deleted; teaser settlements UPDATE ticket and leg rows; CLV rows UPDATE derived grades; lifecycle events are append-only. The correct unification is an append-only economic/decision history with mutable read projections, not “make every table immutable” or “delete the old tables.” Migration must preserve provenance and flag records whose original decision-time lineage cannot be recovered.

### Confirmed organization defects beyond file placement

The temporal revision primitives `nfl-bitemporal.recordRevision` and `valueAsKnown` have no normal server/scripts consumer outside their definitions. `compareStakingPolicies` and `currentClvDownsizeMultiplier` likewise have no live consumer found. These are existing libraries to qualify and integrate, not missing files to recreate. Research-only modules such as the new preseason blend and role scenarios should remain isolated until they earn a specific consumer; unused-by-serving does not mean disposable.

The research UI hardcodes package A/H as next and D as planned in `nfl-research-lab.js:66–75`, while the current execution-plan text describes later progress. The active queue overgeneralizes a limited leakage check, declares further execution work unnecessary until a candidate exists, and repeats outdated scheduling assumptions. The actual current `.env` has no `SCHEDULER_DISABLED` entry, whereas the document says it is still set to 1. An inherited runtime variable remains possible. This establishes documentation/configuration disagreement, not the effective runtime flag by itself.

`client/src/navigation.ts` already supplies the sidebar and command palette; that duplication was successfully addressed and should be preserved. The remaining organizational work is ownership of numerical outputs, contract and ledger lineage, status generated from actual evidence, and one work queue. The user explicitly requested removal of competing planning documents: the folder-disposition appendix replaces those queues while retaining audit results and scientific protocols.

## Verification boundaries and source inventory

The adversarial cases establish that the inspected code permits the described behavior. They do not establish how often real data triggered it. The numerical reconciliation establishes saved-score/payout consistency, not available historical execution. Saved research metrics are attributed to their actual artifacts and were not independently retrained. The proposed changes should preserve these distinctions when re-evaluating results.

Source-extracted microchecks reproduced the preseason weight, cross-book prop attribution, Yes-only touchdown inversion, and a touchdown sampled independently of completed-pass/lateral event accounting. A lateral recipient can legitimately receive touchdown credit without a reception; the reported sampler defect is its absent event relationship, not a universal ban on that statistical combination. The existing targeted execution/prospective/findings suite passed 81 tests, while independent probes exposed the listed defects. This is why acceptance criteria must test economic and temporal invariants in addition to happy-path software behavior.

[^1]: Private Claude record, **Gridiron HQ research platform strategy**, session `local_73bb1a91-ec5c-44f0-a766-932e4aeec436`, transcript `77190978-4d50-4315-861c-375dfc788580`, September 8–9, 2026. Local session title and transcript inspected; not a public URL.

[^2]: Local project `server/data.sqlite`, read-only inspection September 9, 2026 Eastern. Tables include `nfl_blind_audit_runs`, `nfl_blind_audit_weeks`, `game_lines`, `nfl_quote_batches`, `nfl_quote_tape`, model/forward/execution/findings stores listed above. Numerical runs use saved per-pick records and validated `(season, week, home, opponent)` joins.

[^3]: Same database: `nfl_policy_audits` row 1, `nfl_residual_audits` row 1, `audit_registry` rows 1–15, `player_head_audits` record `5e68f1497df906c6c21fb3f2d837f1d0603623fdc433c788514103673a267484`. These are distinct historical experiments with their own versions and populations.

[^4]: Private local report artifacts: `server/data/market-lab/20260908T152845Z-334b4b45/report.json`; `server/data/tree-lab/20260908T164200Z-2e46b49a/report.json`; `server/data/expert-selector-lab/20260908T212214Z-4514de3d/report.json`; `server/data/book-lag-lab/20260908T204218Z-516e0048/report.json`; `server/data/role-scenario-lab/099899267f1f752b/manifest.json`; `server/data/news-event-impact/6b0ff0f28bf577ba/manifest.json`; `server/data/evidence-datasets/05ed3ece6d9b4590/manifest.json`. Reports read with their protocol and limitation fields, not treated as prospective proof.

[^5]: Source findings refer to local commit `969d501e5d318f8ff650d7e239d8647f8b75eb84`. GitHub comparison is [BouncySlime1215/gridiron-hq at the fetched main commit](https://github.com/BouncySlime1215/gridiron-hq/tree/7dfd3f2392510effc6f5d51e9708d502ff80bdbf). The local-only findings are not represented by that older GitHub view.

External primary-source research and acquisition recommendations, including bookmaker rule changes, feed availability, probability calibration, and research validation, are cited directly in **CLAUDE-NEXT-STEPS.md**.
