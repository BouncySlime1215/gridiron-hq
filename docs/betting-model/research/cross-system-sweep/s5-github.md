# s5-github — the GitHub catalog, read against WHAT_NEXT.md

Read in full: `scratchpad/WHAT_NEXT.md` (244 lines), `research2/GITHUB_BUILD_CATALOG.md` (247
lines), `research2/GF03-devig-kelly-libraries.md`. Directly inspected clones under
`research2/github/`. Every code claim below is cited path:line against the READ-ONLY checkout at
`/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard`; database facts come from a
`node:sqlite` `readOnly:true` one-liner. No process started, nothing written.

Headline: the catalog is good and the plan has already absorbed most of what matters from it. The
four things worth acting on are not new models. Three are measurement/risk plumbing the plan
budgets from scratch when a tested MIT implementation exists, and one is an operational defect in
a prospective test that is already running and already the closest thing this project has to the
2026 forward record WHAT_NEXT says is the honest target.

---

## 1. Two cloned repos never made it into the catalog at all — and they are the staking guardrail

`research2/github/` contains `cvxgrp_kelly_code` and
`sergeisukhovmkt_The-Bayesian-Grossman-Zhou-Rule-Drawdown-Constrained-Kelly-Betting`. Neither
appears anywhere in GITHUB_BUILD_CATALOG.md (grep for `kelly`, `cvxgrp`, `grossman`, `drawdown`
returns only the unrelated `kellytodhunter` rows). Both were evaluated in
`GF03-devig-kelly-libraries.md:80-133` and dropped on the way into the catalog.
`DoubleML__doubleml-for-py`, `mvasigh_football-sim` and `nflverse__nflreadr` are also cloned and
uncatalogued, but those three are genuinely low-value here.

What the code in the checkout actually does:

- `server/services/staking.js:116` — `stakeFor({... multiplier = 0.25 ...})`. Static.
- `server/services/staking.js:294` — `safeStakeFor({... multiplier = 0.25 ...})`. Static.
- `server/services/nfl-execution-edge.js:623` — the repository's real staking gate,
  `stakeFor({... fraction = 0.25, bankrollUnits = 100, maxUnitsPerBet = 3 })`. Also static, and
  `bankrollUnits` is a caller-supplied parameter default, not a tracked balance.
- `grep -rni "high.water|highWater|peak_bankroll|realized_bankroll" server/` → **zero hits.**
  Nothing anywhere knows where the bankroll sits relative to its own high-water mark.
- `server/services/staking.js:231-257` — `slateRiskCheck` estimates `drawdown_probability` by an
  8,000-trial Monte Carlo, described in its own header (`:53`) as "a genuine Busseti/Ryu/Boyd-style
  drawdown-probability constraint ... estimated, by Monte Carlo rather than solved in closed form."
  There is no analytic cross-check on that number.

Two concrete, cheap additions the catalog dropped:

(a) **Grossman & Zhou (1993) linear drawdown cushion.** `f = κ·(d/b)`, `d` = log-distance from
current wealth to the drawdown barrier, `b = -ln(1-δ)`. Implemented cleanly as baseline rule #2 in
`code/simulation.py` of the sergeisukhovmkt repo, which is **MIT**. Critical caveat carried
forward from GF03:123 — that repo's *own* contribution ("Bayes GZ") is self-published, unreviewed,
and had an earlier version of its main formula retracted. Take only the 1993 peer-reviewed rule,
which the repo merely implements as a comparison baseline.

(b) **The closed-form Chernoff bound `Prob(W_min < α) ≤ α^λ`** from Busseti/Ryu/Boyd — the paper
staking.js already cites by name — as a sanity ceiling on the Monte-Carlo drawdown number. If the
MC estimate ever exceeds the analytic bound by more than simulation noise, the correlation matrix
or the copula draw is wrong, not the math. `cvxgrp/kelly_code` is **GPL-3.0**: reimplement the
formula (a published mathematical fact), never copy the `cvx.Problem` code into a proprietary
codebase.

Why this matters more than it looks: the `source='model'` branch at nfl-execution-edge.js:625-634
already zeroes any model-derived stake until proven CLV, so the only paths that will ever stake
real money are the two documented positive-expectation ones — line-shopping/execution and the Wong
teaser. A static quarter-Kelly with no drawdown state is precisely the wrong guardrail for the
paths that *will* run. This is risk control, not prediction.

WHAT_NEXT sections checked: Step 5 (items 11-15), Step 5b, Step 5c, Step 6, "decisions still
sitting with you". Staking, Kelly, bankroll and drawdown appear in none of them.

---

## 2. `eslazarev/purged-cross-validation` (MIT) supplies four of Step 2's five pieces, not one

WHAT_NEXT Step 5c names this repo for exactly one function (`effective_n_trials`, matching catalog
build-item 16) and separately proposes, at build-item 17, reimplementing DSR + PBO/CSCV +
Holm/BHY from `quantskills/skill-backtest-overfit` because that repo is **GPL-3.0** — budgeted
"days". Reading the actual clone, `research2/github/eslazarev__purged-cross-validation`, LICENSE
line 1 is `MIT License`, and `src/purgedcv/` contains:

- `_walk_forward.py:18  WalkForwardSplit`, `_purge.py:19 purge()`, `_embargo.py`, `_cpcv.py`
  → Step 2 **5a** (purged walk-forward with boundary purging), which the plan proposes to build.
- `_metrics.py:557  effective_n_trials(trial_sharpes, method="autocorr")`
  → Step 2 **5c**. Already named in 5c. Its own docstring calls the Geyer-1992 truncation "a
  **heuristic** ... an order-of-magnitude correction, not an exact figure" — worth quoting into
  the deliverable so the corrected number is not over-read.
- `_metrics.py:197 deflated_sharpe_ratio`, `:313 deflated_sharpe_ratio_full`, `:277 DSRDiagnostics`
  and `_pbo.py:272 probability_of_backtest_overfitting` (with `PBOResult`)
  → Step 2 **5d**. This is the GPL reimplementation work, available under MIT, tested, in the same
  package, using the same `n_eff` convention — which also removes the "five disagreeing
  implementations" risk the catalog itself flags at the `mnemox-ai/deflated-sharpe` row (that
  repo's Gumbel closed-form `E[max SR]` disagrees with purgedcv's variance-based one).

Two bonus functions the catalog never mentions and the plan would benefit from:

- `_metrics.py:385  min_track_record_length(observed_sharpe, target_sharpe, alpha, skew, kurtosis)`
  — inverts PSR for `n`: the exact number of settled bets needed before a given result is
  evidence. WHAT_NEXT's closing section says "with roughly five selections a week you get a
  fraction of the sample needed." This computes the fraction.
- `_metrics.py:486  minimum_backtest_length(n_trials, target_sharpe)` — the history length below
  which a top-of-21 result is inside what selection alone produces. That is Step 2 5d's question
  asked from the other direction, and it can be answered before any refit runs.

Nothing here contradicts the settled negative. It makes the negative properly bounded, which is
exactly what Step 2 says it is for.

WHAT_NEXT sections checked: Step 2 (5a-5e in full) and Step 5c. 5c names only `effective_n_trials`
from this repo; 5d proposes the GPL path.

---

## 3. The statistic behind "t = 4.47" is an ad hoc paired-t, not a Diebold-Mariano test

`server/services/nfl-ensemble.js:1126-1130`:

```
const paired = scoreActual.map((x, i) => (x - slope * scoreSignal[i]) ** 2 - x ** 2);
const pairedMean = paired.length ? mean(paired) : null;
const pairedSd = ...
const residualT = pairedSd > 0 ? pairedMean / (pairedSd / Math.sqrt(paired.length)) : null;
```

`grep -rni "diebold|harvey.leybourne|hln" server/` → **zero hits.** This is a plain paired t on
squared-error differences of a time-series forecast: it assumes iid, non-autocorrelated,
symmetric loss differentials, and NFL weekly loss differentials are none of those. The literature
standard is Diebold-Mariano with the Harvey-Leybourne-Newbold small-sample correction, and catalog
row `johntwk/Diebold-Mariano-Test` (127★, **MIT**, ~40 lines, last commit 2017 — stable, not
abandoned for a 40-line statistic) is build-item 10 in the catalog's own 22-repo list.

Be precise about what this does and does not do. It does **not** reopen the settled result. The
ensemble lost (RMSE 12.840 vs market 12.448) and the sign of that is not in question. HLN
typically *shrinks* |t|, so the honest expected effect is that "the market is significantly better"
becomes "the market is better, with a correctly-sized interval." The reason to do it is Step 2 5e:
that leaderboard promises "one honest confidence statement per row," and the function that
produces the confidence statement is currently this line. Fixing it is hours.

Credit where due: the surrounding code is careful — nfl-ensemble.js:1104-1111 documents a genuine
chronological fit/score split and explicitly declines to claim it is a full nested walk-forward.
The defect is the test statistic, not the protocol.

WHAT_NEXT sections checked: Step 2 5a-5e, Step 5c. No pairwise forecast-comparison test is named
anywhere; Step 5c's GitHub leftovers list the devig dispatcher and nflfastR only.

---

## 4. The prospective CLV test that IS the 2026 forward record froze 61 decisions and settled 6

This is the finding I would act on first, and it is not in the catalog — it is in the checkout.

`server/services/beat-the-close.js` is a complete Phase-2 prospective test: snapshot each Phase-1
signal per game, freeze a zero-stake shadow decision at the best reachable price when a signal
clears threshold, settle after kickoff by CLV against Pinnacle's last pre-kickoff line. `RULES`
(`:43-61`) carries five signals with their held-out basis, three of which passed a Holm-corrected
gate on 2024-25:

- `nfelo_pre_vs_open` — +0.68 CLV [0.36, 1.05], 63.6%, n 570, Holm p < 0.01
- `teamrankings_vs_open` — +0.55 CLV [0.23, 0.92], 57.7%, n 570, Holm p < 0.01
- `ratings_vs_open` — +0.58 CLV, 57.7%, n 570
- `ratings_vs_open_total` (+0.08 alone) and `wind_total` (+0.28 [0.11,0.45], under the +0.3 gate)
  are labelled candidates, not passed signals.

(Note against the settled facts: the standing verdict is that nfelo-vs-Pinnacle-opener favourites
is the one +CLV signal. The live RULES table still runs three. I am not claiming the other two
work — I am flagging that the running config and the standing verdict disagree, and the live CLV
is the thing that settles it.)

Live state, read from `server/data.sqlite` (readOnly):

- `nfl_signal_snapshots` — 38,055 rows, 2026-09-02T15:56 → 2026-09-13T01:00. Capture is healthy.
- `shadow_decisions WHERE regime='beat_the_close'` — **61 rows, all season 2026 week 1, 6 settled.**
  By signal: nfelo_pre_vs_open 16/2, ratings_vs_open 14/1, ratings_vs_open_total 15/1,
  teamrankings_vs_open 15/2, wind_total 1/0.
- **Zero week-2 decisions**, four days into week 2, while snapshots kept writing through tonight.
- The wider table is the same shape: `regime='unclassified'` is 128 rows, 8 settled.

`grep -rn "settleBeatTheClose|decideBeatTheClose|snapshotSignals" server/` returns hits **only
inside beat-the-close.js itself**. The only caller is a manual route,
`server/routes/nfl-market.js:156  POST /beat-the-close/run`, gated on `model:train`. Nothing
schedules it. Snapshots are arriving by some other path; the decide and settle steps are not.

There is a reader — `server/services/nfl-blind-audit.js:759-812` folds week and cumulative
beat-the-close CLV into the weekly blind audit — so this is not invisible. It is reporting on a
tape that has 55 ungraded week-1 rows and no week-2 rows at all.

Why this outranks everything else on this page: WHAT_NEXT's closing section says the honest target
for 2026 is "a complete, trustworthy forward record and a closing-line-value direction reading."
This module is that record. At 6 settled from 61 it will not be complete, and each unsettled week
is gone — Pinnacle's last pre-kickoff line for a game that already kicked off is not recoverable
later from a live feed. Cost is hours: schedule decide+settle, backfill week 1 from the archive if
`nfl_odds_archive` still holds the closes, and put the retirement rule the module documents
(`:20-22`, two consecutive weeks of below-zero live CLV retires a rule) into the weekly read.

WHAT_NEXT sections checked: all six steps plus 5b/5c and the closing sections. `beat-the-close`,
`line-move-study`, `shadow_decisions` and `nfl_signal_snapshots` appear nowhere in the document.

---

## 5. Step 5 item 14 proposes building a shadow-run window; one already exists

Item 14: "A required shadow-run window before any model promotion. There is currently no
forward-data gate at all ... Pilot on one fantasy model first, since that is cheapest."

The premise is right for *model promotion* and wrong as a statement about the repository. A
working forward-data harness exists in beat-the-close.js: frozen decisions at zero stake
(`:243-263`), a best-reachable-price rule that excludes stale book quotes (`:104-110`, via
`isFreshQuote`), CLV settlement, a documented retirement rule, and audit reporting. Borrowing it
is cheaper than building a second one, and — per the plan's own "cheapest first" instinct — it has
the advantage of already having run against live data.

This is the same class of finding as catalog question 2, just sourced in-house rather than from
GitHub: a tested implementation beats a fresh one.

---

## 6. Answers to the four questions asked, including the negatives

**Q1 — adopt=port/call repos neither used nor planned.** After removing everything WHAT_NEXT
already covers and everything the settled facts reject (gplearn and PySR are genetic
programming/symbolic regression; lag-llama, the tracking-data GNNs and the Polymarket/Kalshi
trading clients are already in the catalog's own avoid list), the betting-relevant remainder is
short: purgedcv's full surface (§2), Diebold-Mariano (§3), and the two uncatalogued Kelly repos
(§1). Beyond those, honestly ranked lower and all predictive rather than structural:
`fivethirtyeight/nfl-elo-game` (MIT) as an external floor row on Step 2's leaderboard — partly
redundant, since `server/services/nfelo.js` already ingests greerreNFL's published lines
(`nfl_nfelo_games`, 1,709 rows, 2020-2026, including `nfelo_home_line_open/close`), so the cheap
version is to add nfelo's published prediction as a benchmark row rather than to stand up a new
Elo; `sublee/glicko2`, `greerreNFL/nfelosrs`, `ngboost`, `tonyduan/mixture-density-network`,
`crepes`/`cqr`/ACI, `chronos`/`timesfm`/`uni2ts`. Each is a bid to predict better, which is the
one thing measured three times not to work here.

**Q2 — repos solving a problem the plan proposes to solve from scratch.** Two real ones, both
covered above: purgedcv for Step 2 5a/5d (§2), and the Diebold-Mariano statistic for 5e's
"confidence statement per row" (§3). A third is in-house: beat-the-close.js for Step 5 item 14
(§5).

**Q3 — the specific list. Mostly negatives, which are the useful answer.**
- *Odds-ingestion breadth (more books, better coverage):* **nothing in the catalog.**
  `georgedouzas/sports-betting` ships soccer providers, not US sportsbooks; its contribution is an
  odds-column grammar, not coverage. No repo in the catalog adds a single book.
- *Line-movement / steam detection:* **nothing in the catalog** — zero repos on the subject. And
  the in-house version is already far past what any of them would give:
  `server/services/line-move-study.js` (447 lines) fits open-to-close movement at four decision
  times (`:76`), is explicit that soft books open hours after Pinnacle so a sharp-vs-soft gap is
  not knowable at T0 (`:56-62`), holds out from 2024, applies Holm, and gates on +0.3 points of
  CLV over 300 games (`:36-37`). The public ticket/money split is already a feature there
  (`:221-222`, `public_home_tickets` and `public_money_minus_tickets`), fed from
  `nfl_nfelo_lines`. Coverage check: 1,709 games, `home_spread_tickets_pct` on 847,
  `home_spread_money_pct` on 585 (2024 onward only), `total_over_money_pct` on **0** — the column
  exists and upstream never publishes it, which nfelo.js:266 already documents. Nothing to add.
- *Limits and bet-placement mechanics:* the catalog's only offering is `Polymarket/py-clob-client`'s
  `calculate_market_price()` depth-walk, on a venue where nothing is bet. In-house this is already
  strong: `server/services/nfl-execution-replay.js` models `capped` fills against `bookLimitUnits`
  (`:266-267`), reports `availability_basis` separately from `outcome` (`:49-60`), and refuses to
  assert obtainability past `observedThrough` or kickoff. One real gap remains and it is small:
  `nfl-execution-replay.js:111  export const DEFAULT_BOOK_LIMIT_UNITS = null` — by default no limit
  is modeled, so `capped` never fires unless a caller supplies a number nobody has measured. The
  fix is not code, it is data: record the stake each book actually accepts when a bet is placed and
  build a per-book limit table. Honest and cheap, but the honest caveat is that until real bets
  are placed there is nothing to record. (Polymarket detail, for completeness: `bid_size`/`ask_size`
  *are* captured, `server/services/polymarket.js:180-186`, but reduced to top-of-book
  `depth: min(bid_size, ask_size)` at `:225` — the ladder is not walked. Out of scope, noted only
  so the catalog's "captured and discarded" claim is corrected to "captured and flattened.")
- *Prop pricing:* the plan's open decision "do you want the statistics toolchain stood up?" (it
  gates Step 3 item 10 and Step 4c) has a cheaper answer in the catalog than the plan assumes.
  `martineastwood/penaltyblog` (MIT, active) ships a hand-rolled Cython differential-evolution
  ensemble MCMC with a hierarchical prior and learned team variance, `trace_dict` as plain numpy →
  JSON. That is a `pip install` with no CmdStan, no R, no Stan runtime in Node — a genuinely
  smaller dependency than `footBayes` (GPL-2, CmdStan/R sidecar) for the same "does a hierarchical
  prior widen intervals honestly for thin-data players" question. Deciding the small version first
  is a way to answer the standing question without committing to the big one.
- *Same-game correlation:* the plan states the problem twice (Step 4b caution ii — summing
  correlated player projections gives a badly wrong variance) and proposes no solution. It is
  largely already built. `server/services/nfl-prop-correlation.js` (`SGP_MODEL_VERSION =
  'prop-sgp-copula-v1'`, `:31`) fits residual correlations across players within a game, both
  `sameTeam` and `opposed` (`:120-122`), across the five stats that actually trade, with a
  `MIN_PAIRS = 150` floor (`:45`), persisted to `prop_correlation_estimates` — **182 fitted
  archetypes in the live DB** — and `sgpAnalysis` (`:263`) samples them through a Gaussian copula
  (`cholesky`/`correlatedNormals`/`probit` from stats-util). Step 4b should be pointed at this
  table, not at a new build. If tail dependence later matters, escalate to `vinecopulib/
  pyvinecopulib` (**MIT**) and *not* to `sdv-dev/Copulas`, whose **Business Source License 1.1** is
  not an open-source license and restricts production use — the catalog lists it as `call` without
  flagging that.

**Q4 — maintenance and licence posture, stated plainly.** MIT and healthy: purgedcv (most active
of the multiplicity repos), penaltyblog (2026-09-10), pyvinecopulib, the Grossman-Zhou repo.
MIT but frozen: johntwk/Diebold-Mariano-Test, last commit 2017 — acceptable, because a 40-line
statistic with a published closed form does not rot, and it should be transcribed rather than
depended on. GPL-3.0, reference-only, never a dependency in a proprietary codebase:
`cvxgrp/kelly_code`, `quantskills/skill-backtest-overfit`, `mementum/backtrader`, `srbench`,
`feat`. Not open source at all despite the catalog's `call` verdict: `sdv-dev/Copulas` (BSL 1.1).
No licence declared, so reimplement the documented method rather than importing code:
`mattymitch499-sketch/nfl-sgp-model`, `greerreNFL/nfelo*`, `kellytodhunter/KBO-Player-Analysis`,
`kennethho193/nfl-aging-curve`. And `nflverse/nflfastR` carries no LICENSE file (catalog:
NOASSERTION) — the catalog is right that its formulas must be reimplemented, and WHAT_NEXT Step 5c's
"compare against nflfastR's own code" is a read, not a port, which is the correct framing.

---

## 7. Hypotheses I checked and killed — recorded so nobody re-runs them

- **"The prop correlation table is fit on a fantasy-roster-biased subsample."** False.
  `fitPropCorrelations` joins `players`, and `players` has 8,720 rows; every one of the 1,387
  distinct `player_week_usage` players 2021-2025 has a row. The join drops 12,164 of 43,243 usage
  rows, and the dropped positions are K/S/LB/DL/EDGE/CB — non-skill, correctly excluded. No bias.
- **"There is no bet-attempt / rejection log."** False, and the plan is already on it.
  `nfl-execution-replay.js:13-60` enumerates ten honest outcomes including `filled_as_decided`,
  `repriced`, `disappeared`, `suspended`, `capped`, `pending`, `post_kickoff_unknown`, with
  `availability_basis` reported separately. A vectorbt-style `bet_attempts` table would duplicate
  work in flight (WHAT_NEXT Step 1 items 1 and 3).
- **"No reliability diagram / calibration audit exists"** (the case for porting NFLWin's KDE
  auditor or Metaculus's `CalibrationAdjuster`). False. Brier/reliability/Platt/isotonic machinery
  spans `nfl-prop-calibration.js`, `nfl-cover-calibration.js`, `nfl-total-calibration.js`,
  `nfl-prop-player-heads.js`, `nfl-signal-reliability.js` and more. Calibration is the measured
  win; it does not need a port.
- **"The ticket/money public split is ingested and unused."** False. Consumed at
  `line-move-study.js:221-222`.
- **N-outcome Shin devig.** Real but low value. `nfl-devig.js` is 121 lines and every export takes
  `(oddsA, oddsB)` — strictly two-sided, across all twelve call sites. Generalizing it matters for
  3-way and futures markets, which is Polymarket territory, which is out of scope. Step 5c's
  seven-method dispatcher benchmark already covers the method-selection question that does matter.
