# Gridiron HQ — latest betting-model plan

**September 16, 2026, late night — read this pointer first.**
**"CONFIDENCE META-MODEL" (search for that heading) is the NEWEST result: a
preregistered null.** The system's own conviction does not predict whether
it is right (r = −0.010 over 647 games), three candidate bugs were ruled
out, and a supervised meta-model built on nine point-in-time features to
learn when to trust the pick FAILED out of sample (AUC 0.489, CI [0.419,
0.559]; no quartile clears z=1.96). Standing conclusion: **we have a
measurable edge signal but no working sense of when to trust it.** That
section also records that the `low_disagreement` filter reaches only z=1.24
on held-out 2024 — direction consistent, not independently confirmed, so it
must not be described as replicated.
**"SEVEN ATTACK-VECTOR TESTS" (search for that heading) has the preceding
results — read it before "RECONCILED PLAN" just below it.** Seven
exploratory tests run against the opener-CLV composite, Holm-corrected
across all 17 comparisons they produced: 7 survive. Headline: the edge is
real on small/mid spreads and dead on big ones (>7 pts), stronger when the
underlying components agree with each other than when they disagree, and
—the one that broke a stated prediction—roughly DOUBLE in new-coach-season
home games, the opposite of what was predicted going in. A selective-
betting probability curve (fit on |lean|) failed its own calibration check;
flat/Kelly staking loses money at real vig, as expected. Two of these are
now preregistered filters for Phase 3.
**"RECONCILED PLAN" is the authoritative work queue** — not FINAL ORDER's
own numbering, which it supersedes. FINAL ORDER's items are kept as a
reference catalog underneath it; every item was reclassified against two
objectives (the old margin-accuracy target and the new opener-CLV target)
and reassigned into six phases. Start at Phase 0. Gap analysis is DONE.

**Currently done: FINAL ORDER #1 and #2.**
- **#1** joint residual fit (RUNBOOK §10.1/§3.3). Built, tested, measured;
  fit version bumped to v13. Null result — the joint fit does not beat the
  market either. A valid, recorded completion.
- **#2** drive-sim clock/endgame bugs (RUNBOOK §10.2). Kneel-rule sign,
  kneel clock consumption, and `simulateRemainder`'s missing
  halftime/timeouts/overtime all fixed; item (a) was already fixed and is
  now pinned by a regression test. **The re-measured backtest is the
  headline: 52.14% ATS over 491 walk-forward games, not the 42.86%
  "measured dead" this plan has cited everywhere — and that 42.86% turns out
  to have no recorded sample size anywhere in the repo. Still not
  profitable and still no detectable edge. Full treatment in Section B.**
- **The two items that needed a decision are DONE.** Nick approved both
  later the same day: kneelDecision's first branch now reads the game
  clock (resolves the TODO open since 2026-09-12), and HFA is now a
  per-play efficiency edge instead of points added to the score, calibrated
  by `scripts/calibrate-home-field-rate.mjs`. See the commit
  "Drive-sim: HFA as a per-play edge, exclude international games, add
  backtest profileMode."

**Also done September 16, at Nick's direction, after #2:** international /
neutral-site games are excluded from the simulator's evaluation paths and no
longer receive a home-field edge on the live path (the ensemble always got
this right; the simulator never did); home field became a per-play
efficiency edge instead of points added to the scoreboard, with its constant
calibrated by `scripts/calibrate-home-field-rate.mjs`; and the kneel rule
now reads the game clock. **Then: "Why does the simulator's ATS rate fall
across seasons?" (section below) — the answer is that it does not. The
pattern is noise, it reordered when those small changes landed, and
resolving a trend that size needs ~323 graded games per season against an
NFL season's ~285. Read that section before drawing any conclusion from a
season-level ATS number.**

**FINAL ORDER #3 is DONE** (point-in-time guard; see its own section
below). Guard + 12 tests shipped in `server/modeling/contracts.js`, plus
`scripts/point-in-time-admission-report.mjs`. It is built, tested and
deliberately **not enforced**: strict admission would refuse four of five
input tables for the current season (10,080 rows at a Week 5 cutoff).

**PRIORITY, SET BY NICK September 16: get the model HISTORICALLY solid
first; current-season serving comes after.** The #3 enforcement decision is
explicitly deferred under that rule (see the note in its section below).
Work the guardrail items that decide whether our own historical numbers can
be believed — #4's multiple-comparison correction, the DSR/PBO input defect,
the unreproducible 42.86% — before touching what the live path serves.

**FINAL ORDER #4 is DONE** (Holm on the gate, Giacomini-White conditional
test, corrected-alpha columns; see its own section below). Measured on real
history it changed nothing — the best raw p across 32 components is 0.38
against a 0.05 bar, so there were no passes to correct. Fit version bumped
to **v14**.

**September 16, evening — the opener-CLV measurement is DONE and it is the
most important result in this document.** Section "RESULTS — the opener-CLV
measurement" below. Short form: **a small, real, one-signal edge at the
OPENING line exists** (five prior-week efficiency components, +0.2-0.27
points of closing-line value, positive every season 2022-2025, survives Holm,
not explained by the +0.19-point home drift that "always back home" earns for
free). **It is worth ~51% ATS — below the vig as a flat strategy.** The
drive sim and the Python football model do NOT have it. Every prior "nothing
beats the market" result in this plan was measured against the CLOSE; this
is the first measured against the OPEN. The next measurement (selection +
line shopping + timing) is preregistered at the end of that section.
1. ~~The opener-CLV measurement~~ DONE (above).
2. **The model registry** — one CSV row per model, component, expert, policy
   module, table, scheduler job and harness, in `docs/betting-model/registry/`
   (`SCHEMA.md` is the contract; `skeleton-*.csv` are exact mechanical
   enumerations: 35 components, 19 experts, 20 sim modules, 5 families, 129
   tables, 55 jobs). Three Sonnet agents are filling the judgment columns;
   every agent row is spot-verified against code before merge.

**Then FINAL ORDER #5** (wire the fields `nfeloFeatures()` already returns —
`elo_diff`, `qbelo_diff`, betting splits; RUNBOOK §10.5).

Both test suites are green as of this pointer: **Node 2,223 total / 2,184
pass / 0 fail / 39 skipped** (`npm test`), **Python 127/127**
(`cd research/betting/nfl && ../../.venv/bin/python3 -m unittest discover -p "test_*.py"`).
Everything through #1 is committed and pushed to
`cursor/betting-model-audit-fixes-1c85` on GitHub — `git log --oneline -5`
for the exact commits, each one's message states what it did and what suite
counts it left green. Read RUNBOOK.md §0a (7 operating rules) before
touching anything, then RUNBOOK's own top pointer for the same "what's
done, what's next" summary in the how-to document.

## THE PLAN — read this first (September 15, 2026, end of day)

**For the step-by-step version with exact commands per layer — "start here,
do this, then this" — see [`RUNBOOK.md`](RUNBOOK.md).** This section is the
what and why; the runbook is the how.

Everything below this section is history and evidence; this section is the
order of operations. It covers organize, data, model sharpness, ML / neural /
AI / quant, research + GitHub, and ends with what "run today's updates" means.
Detailed inventory, correction of my own earlier wrong claims, and the target
architecture live in **MODEL INVENTORY AND ORGANIZATION** further down —
referenced, not repeated.

**How improvement is measured — fixed, not negotiable per experiment.**
Two harnesses, one significance tool, three baselines:
- `research/betting/nfl/unified_margin_audit.py` — weekly refit, out-of-fold,
  every game scored or explicitly abstained (Python signals).
- `server/services/nfl-replay.js` + `fitEnsemble` — the incumbent JS
  walk-forward and joint fit (JS signals and the ensemble as a whole).
- `scripts/unified-margin-audit-significance.mjs --a X --b Y` — the one
  week-clustered block bootstrap (`pairedBootstrapDiff`), because games in a
  week are not independent draws.
- Baselines on identical games: the market (`-market_spread`), the
  candidate's own base model, zero-information. **Nothing is "better" unless
  it beats the market AND its own base, out-of-fold, with the interval
  excluding zero.** Today's numbers, 2021-2026, 1,440 games: market MAE
  **9.779**; football-only blend 10.271 (+0.49, sig.); market-correction head
  **9.913** (−0.36 vs its football base, sig.; +0.13 vs market, sig.) — 73% of
  the gap closed, not all of it. Nominal-80% intervals cover 80.0-80.3%.

### A. Data — is it all good? Verified today, and what to verify next

Verified (measured, not assumed):
- One point-in-time chronology (`dataset.py`; `RESULT_PUBLICATION_LAG` 3d).
  Market: closing spread 100%, open+close 98.2%, 2.46M line snapshots.
  Injuries: 75.2% of 2021-2026 games with admissible evidence. Snaps:
  `defense_pct` 100% populated and now actually read.
- Leakage is pinned by mutation tests, not prose: walk-forward (later week
  cannot change earlier prediction), correction head (combination-week
  outcome cannot change the base-only football model), feature wiring
  (opted-out rows byte-identical), availability (post-kickoff revisions
  refused).
- **New today — test isolation.** The real market-correction export shares
  1,278 of 3,044 keys with the synthetic ensemble fixture; every fixture-based
  ensemble test was silently reading real research values for one column.
  Fixed: `GRIDIRON_MARKET_CORRECTION_LOOKUP` override, defaulted to nowhere in
  `test/offline-guard.mjs`; tests point at scratch files. 126/126 on the
  affected files. This is the same discipline as `GRIDIRON_DB_PATH`.

Known gaps, each with its disposition:
1. **Monday-night lag.** 42 of 42 prior-week MNF games (and ~3% of Sunday)
   are excluded from the next Wednesday fit by the 3-day proxy. Decision
   needed: keep conservative, or split the *score* label (known in hours)
   from *derived* features (days). Measured, documented, not changed.
2. **2025-2026 injuries lack `modified_at`** (nflverse dropped the column
   upstream; our writer is correct). `nfl_feature_revisions` is the forward
   fix and holds 20 rows — verify it accumulates weekly; recovers nothing
   backward.
3. **Defensive player quality is 0%** and cannot be derived from our PBP
   (ESPN feed, no player identity). Free path: `nfl_pfr_adv` weekly
   defensive stats already ingested (7.6k rows/season, 2024+). Optional:
   import nflfastR PBP with player ids for on/off value. No PFF; its season
   granularity would leak anyway.
4. **Lookup refresh.** The correction export is a one-time file (237 weeks);
   it needs a re-export job after `weekly_training`'s Wednesday slot.

### B. Models — are they sharp? What is measured, dead, gated

- The **served spread forecast has been the market line verbatim at every
  cutoff ever shipped** — 0 of 848 fit artifacts ever passed the residual
  gate (`n ≥ 250`, `rmse_gain ≥ 0.03`, DM `p ≤ 0.05`). The gate is mild; the
  finding is that nothing has out-of-fold residual skill on these windows.
  **CORRECTED/EXTENDED 2026-09-16 (FINAL ORDER #1, RUNBOOK §10.1/§3.3):**
  this was the one-at-a-time per-component gate (31 separate single-covariate
  fits). A genuine JOINT fit (`jointResidualFit`, regressing the market
  residual on every eligible component's departure simultaneously, which can
  in principle see correlation the one-at-a-time method cannot) was built
  and measured against the same real history and ALSO does not clear the
  gate — `rmse_gain: -0.008` (worse than the market), `dm_p: 0.9415`
  (n=749 out-of-fold). This strengthens the finding rather than leaving it
  open: it is not an artifact of the weaker one-at-a-time method.
- **Measured dead** (from `gridiron-model.js`'s own evidence): drive-sim
  42.86% ATS, trend totals 43.81%, GBM-on-residual worse than zero.
  **RE-MEASURED 2026-09-16 (FINAL ORDER #2, RUNBOOK §10.2) — the drive-sim
  number does not reproduce.** After the kneel-sign/kneel-clock/halftime/OT
  fixes, `backtest({trials:300, maxGames:100})` walk-forward over 2021-2025
  (491 graded games, profiles strictly from prior seasons) gives **52.14%
  ATS pooled (256-235)** against a 52.38% break-even, and simulator MAE
  10.68 vs market 9.80. Read carefully, three ways:
  (1) **Still not profitable and still no detectable edge** — one-sided
  P(ATS >= 256 | true rate = break-even) = 0.56, i.e. exactly what a
  break-even coin would produce. Nothing here argues for betting it.
  (2) **But "42.86% measured dead" is not a number this repository can
  currently defend.** No sample size, season set, or configuration for it is
  recorded anywhere — not in `gridiron-model.js`'s comment that cites it,
  not in the plan, not in `docs/evidence/`. 42.86% is exactly 3/7, so a very
  small sample is plausible. A verdict that has driven real architectural
  decisions ("six components measured dead", the do-not-combine rule) rests
  on an unreproducible figure. That is a provenance defect worth its own
  fix, independent of what the true rate is.
  (3) **Attribution honesty:** several drive-sim defects (away-WP sign,
  timeout decrement, the +7 HFA lump) were fixed by passes BEFORE today, so
  the gap between 42.86% and 52.14% cannot be attributed to today's three
  fixes alone — and, per (2), may not be a real gap at all.
  Per-season, showing the pooled number is carried by 2021: 2021 60.0%,
  2022 53.6%, 2023 51.6%, 2024 46.5%, 2025 49.0%. Raw run:
  `docs/evidence/2026-09-16/drive-sim-backtest-post-final-order-2.json`.
  **(4) SUPERSEDED IN PART, same day.** Those per-season figures were taken
  before international games were excluded and before home field became a
  per-play edge; both changes moved them by ±5-7 points in both directions
  (2023 .516→.568, 2024 .465→.515, 2025 .490→.420). Do not read the
  season-by-season sequence as a trend — see "Why does the simulator's ATS
  rate fall across seasons?" below, which concludes it is noise and that the
  question is below the resolution of NFL-sized samples. The pooled
  post-change figure is 254-237 = .5173, still under break-even.
  Specialists: "none of the twelve clears breakeven."
- **Measured alive but gated:** the correction head — 16.2% weight in the
  joint margin fit (additive, not redundant with `market_regression` /
  `market_anchor`), 0 residual weight. `challengerOnly`; proven byte-identical
  live output with or without its data.
- **Sharpness rule, kept:** promotion requires clearing the residual gate on
  a genuinely new window *and* a canary/shadow-serve period (ADD #19) before
  the `gridiron-model.js` AUTHORITY ladder moves it. No engineering pass
  changes stake.

### C. Organize — the quant stack, in the order the moves are safe

The target (one owner per layer) is in the inventory section. The order:
- **C1** Rename `unified_model.py` → `football_blend.py` (two unrelated
  things are named "unified"). Cheap; do first.
- **C2** Signal registry contract on `nfl-engine-registry.js` +
  `model-signal-quality.js`: every component/expert/specialist/lab head
  registers `{id, target, cutoff, out-of-fold predictions, evidence_id}`.
- **C3 = Phase 1.5:** measure ensemble effective rank on real data. One
  command now (venv + slim-extract recipe exist). **Gates C4.**
- **C4** One combiner (`forecast-combination.js`, the DM-gated one) replaces
  the six — only if C3 shows independent signal to combine; otherwise prune.
- **C5** One evaluation harness: Python signals export into the registry;
  `nfl-replay.js` grades everything. `unified_margin_audit.py` becomes an
  exporter, `weekly-walkforward.js` and `stage3` folds retire to reports.
- **C6** One promotion ladder: the residual gate, the cover-calibration
  forward gate, and the staking width gate become named rungs on
  `gridiron-model.js` AUTHORITY with evidence ids.
- **C7** Registry consolidation (FIX #32 / #36 — 37 content-addressing
  copies; audit layer onto `ModelRegistry`).
- No production module is merged or deleted without a written same-engine
  argument (`walk-forward.js` sets the standard) and a real-data measurement.

### D. ML, neural, AI, quant — what each is here, honestly

- **ML (tabular).** Ridge + LightGBM blend, the 3-feature correction head,
  `tree_lab` (LightGBM/XGBoost/CatBoost cover, quantile, movement).
  Next: `tree_lab`'s cover head as an L1 signal; injuries + PFR defensive
  features fed to the **correction head**, not the football model — that is
  where the remaining 0.13 lives.
- **Neural.** `nfl-online-neural.js` (`deep_residual` council expert)
  exists and is audited. NGBoost / MDN distribution heads (catalog #4/#5)
  only after C3 shows room; normalizing flows last. No new neural net before
  a shallow head has a measured, gated win.
- **AI (Claude).** `nfl-ai-replay.js` is a risk *gate* on a packet with
  outcomes withheld; page-explain and the new learned-shadow explain tool are
  explain-only. **Zero numeric authority** — unchanged, and correct.
- **Quant.** The pipeline is signal → combine → gate → evaluate → execute.
  Already present: DM+HLN, week-clustered bootstrap, `effective_n_trials` /
  DSR / PBO, consolidated CLV, execution replay, T-60 frozen packets.
  Missing: C3 (rank), the canary window (ADD #19), MAPIE cross-check
  (#26 — `pip install mapie` into the venv that now exists).

### E. Research + GitHub — what to pull, where it plugs in

From `GITHUB_BUILD_CATALOG.md`, nothing new invented. In pull order:
1. `fivethirtyeight/nfl-elo-game` → independent L1 baseline signal (hours).
2. `greerreNFL/nfelosrs` `BayesianRankings.py` → recursive weekly rating
   update for `nfl-team-strength.js` (its most-repeated gap).
3. `ryurko/nflWAR` method → empirical replacement level for injury
   weighting (replaces the hand-typed position table).
4. `scikit-learn-contrib/MAPIE` → conformal cross-check in the research venv.
5. `georgedouzas/sports-betting` complementary-events constraint → same-game
   guard in L2.
6. NGBoost / MDN → distribution heads, gated on C3.
Explicitly not: PFF scraping (paid; season-level leaks), lag-llama, EnbPI
(subsumed), anything requiring tracking data we do not have.

**Checked and deferred — Kalshi / Polymarket as a signal, September 15, 2026.**
Nick asked why not pull in prediction-market data (Kalshi, Polymarket) to
influence picks. Scoped the actual APIs before committing plan space:

- **Access is clean and free.** Kalshi (CFTC-regulated exchange) publishes
  `/historical/markets`, `/historical/markets/{ticker}/candlesticks`,
  `/historical/trades` — settled markets are retained, not deleted, split
  into a rolling 3-month "live" window and an older "historical" bucket.
  Polymarket's Gamma (market discovery) and CLOB `/prices-history` read
  endpoints are unauthenticated and free. Reading either is public
  market-price data, not a wagering action — no gambling-law exposure for a
  read-only research pipeline (the active state litigation against Kalshi,
  e.g. the Massachusetts injunction, is about letting users trade in-state,
  not about third parties reading published prices).
- **The blocker is depth, not access.** Kalshi's individual NFL game
  contracts effectively launched around September 2025 (same-game parlays
  Sept 29, 2025); Polymarket's CFTC-regulated US arm — the legally clean
  path for a US-based pipeline — stood up in **late 2025** too. As of today,
  neither platform has more than **one completed NFL season** of real,
  liquid game-market history.
- **One season can't clear our own recipe's minimums.** `UNIFIED_RECIPE`
  needs 24 combination weeks + 12 calibration weeks = 36 weeks of history
  before a single test week can fit out-of-sample (`chronological_blocks`).
  An 18-week season has zero weeks left over for genuine out-of-sample
  testing — any "audit" run on this today would be in-sample curve-fitting,
  the exact failure mode the whole audit discipline exists to prevent.
- **Even with enough history, this is the same signal category we already
  measured, not a new one.** It's another market's consensus price — the
  correction head already showed that seeing the *sportsbook's* own market
  and movement only closes 73% of the gap to that same market. A second,
  much-less-liquid market is more likely a laggier echo of the sportsbook
  line than an independent edge; that's an empirical question for whenever
  there's enough data to ask it, not a given.
- **The one genuinely distinct use, independent of liquidity:** a real-time
  price jump on Kalshi/Polymarket is an independently-timestamped signal
  that "the market just learned something" — useful for reconstructing real
  injury-news arrival times, which we already can't get from
  `nfl_injuries.modified_at` (NULL for every 2025-26 row). That's a
  supporting signal for the injury work already queued (RUNBOOK §2.1, §4.1),
  not a new prediction input.

**Checked and rejected — `nfl_verified_events` as an injury-timing fix,
September 16, 2026.** Investigated as the possible fix for RECIPE_V2's
43%-coverage ceiling. Verified directly against the live DB (both by an
agent and independently re-checked): `official_injury_report` events are a
byte-for-byte copy of `nfl_injuries` (`available_at == occurred_at ==
nfl_injuries.modified_at` on every row sampled), sourced uniformly from
`'nflverse_injuries'`, batch-written in a single 2026-09-01/02 job — the
same single-batch-timestamp problem already flagged for
`nfl_feature_revisions`. Zero rows for 2025 or 2026, the exact seasons
`nfl_injuries.modified_at` is null and coverage is needed most. 2022-2024
rows are silently double-counted under two `archive_version` tags per
event (confirmed: 2022 has 10,898 raw rows, only 5,449 distinct
season/week/team/player records) — a real trap for a future query that
doesn't dedupe by `archive_version`. No code changed; this is a clean
negative result, not a partial win. **New lead, not yet investigated:** the
same table's `weekly_roster_status_change` event type has genuine 2025 rows
(real ACT/INA/RES/DEV transitions) — a different signal than injury-report
severity, worth a dedicated look later, not assumed to share this table's
problems.

**Decision: deferred, not rejected.** Revisit once ~2 full seasons of
Kalshi/Polymarket NFL history exist (around the start of the 2027 season) —
enough to clear the recipe's own 36-week minimum. If it's worth building
then, the ingestion is cheap (both APIs are free, public, unauthenticated
for reads); there's no reason to build it before there's data to validate
it against. If built at all, it goes through the identical governance as
`market_correction.py` — never inside the frozen 14-feature football
contract, its own separately-audited candidate, gated on beating both the
market and its own base out-of-fold, week-clustered, before it can touch a
live pick.

Sources: [Kalshi historical data docs](https://docs.kalshi.com/getting_started/historical_data),
[Polymarket API guide (Gamma/CLOB/Data)](https://dev.to/will_c38674673aba82fa4cbe/polymarket-api-guide-2026-clob-gamma-websockets-rate-limits-and-the-ip-gate-51mp),
[Kalshi NFL parlay launch, Sept 2025](https://www.covers.com/industry/kalshi-launches-same-game-parlays-for-sports-contracts-sept-30-2025),
[Polymarket US NFL volume growth, late 2025 launch](https://cryptobriefing.com/polymarket-nfl-college-football-volume-surge/),
[Third Circuit CFTC jurisdiction ruling, April 2026](https://www.hklaw.com/en/insights/publications/2026/04/federal-appeals-court-cftc-jurisdiction-over-sports-event-contracts).

### F. Step by step — the sequence, each with its "done when"

1. **Commit today's work** (Nick). 50+ files uncommitted. *Done when:* one
   commit on `cursor/betting-model-audit-fixes-1c85`.
2. **First real shadow observation.** The scheduler job now runs (venv
   built, fallback verified 8/8). *Done when:* a `nfl_decision_events` row
   with `experiment_id = nfl-unified-margin-shadow-v1` exists for a real
   upcoming game and the explain tool returns `available: true` for it.
3. **Lookup refresh job** after the weekly slot. *Done when:* the export's
   `through` week advances without a manual run.
4. **C3 / Phase 1.5 — rank on real data.** *Done when:* participation
   ratio, entropy rank and PCs-for-90/95/99% are reported in both
   `raw_margin` and `market_residual`, and C4's go/no-go is recorded.
5. **Phase 3 A/B — injuries + PFR defense through the correction head,**
   via the ensemble-component path. *Done when:* both intervals (vs market,
   vs base) are reported on identical games against 9.913.
6. **`tree_lab` cover head as an L1 signal** through the joint fit.
7. **Elo baseline + nfelosrs weekly update** as L1 signals.
8. **C1, C2** (rename; registry contract).
9. **C4-C7** consolidation, only after step 4.
10. **R3 fix (P1)**, 24-pt width gate justification, 2024 wk1-4 pilot.
11. **Promotion** of any component that clears the residual gate on a new
    window and a canary period → AUTHORITY rung. Not before.

### G. "Run today's updates" — what has run, and what it showed

Today's updates **have been run**, twice, against real history:
- Python harness, 2021-2026: correction head **9.913** vs market 9.779 vs
  football base 10.275. Beats its base decisively; does not beat the market.
- JS joint fit, 2015-2026 extract, 3,044 games: the same head earns **16.2%**
  margin weight beside the two existing market components; **0** residual
  weight, like every component ever fit.

That is the honest result: a measurable, significant narrowing of the gap
to the market (0.49 → 0.13 points/game), correctly gated, changing no pick.
The next run that can show *more* improvement is step 5, and it is a
one-command A/B now that the wiring and the venv exist.

Verification state at time of writing: Python **119/119** (116 + 3 new audit
provenance/accounting tests, see "Audit system validity" below); the five
test files touched by the isolation fix 126/126; full Node suite
(deployed-server configuration, no env override) — **confirmation pending in
the line below.**

> Full Node suite: **2,156 tests — 2,117 pass, 0 fail, 39 skipped** — run with
> no `GRIDIRON_RESEARCH_PYTHON` override (the venv fallback a deployed server
> uses) and the lookup-isolation preload active. Confirmed 2026-09-15.

---

## Active continuation checkpoint — September 15, 2026

**User direction:** continue the hard model/data/training/serving integration, reuse the
advanced research, investigate historical injuries, and finish the major wiring before
running the large historical walk-forward audit. Keep this checkpoint current for Claude.

**Working checkout:** `/Users/nick_matta/Documents/GitHub/gridiron-hq`, branch
`cursor/betting-model-audit-fixes-1c85`, recovered base `ace62c8`. Changes listed below
are in the working tree unless a newer commit is explicitly recorded. Do not reset or
replace them. Source session: Claude `c174766b-2011-40dd-b469-744caef3a0e5`.

### Completed and verified before the latest extension

- Preserved Claude's unfinished WP12 split manifests and WP13 totals contract.
- Built `score_artifact.py`, Node `python-artifact.js`, `trainedMarginFamilyForecast`
  and `scripts/score-nfl-artifact.mjs`: exact pinned artifact/feature/runtime scoring.
- Corrected probability output precision and model identity for changed training values
  and dependency versions. Existing saved artifacts remain unchanged.
- Saved artifact parity: all 16 completed 2026 Week 1 games matched direct Python exactly.
- Validation at this stage: 72 focused Node tests passed; full Node suite 2,093 passed,
  39 skipped, zero failures; Python suite 63 passed after the feature re-date check.
  Typecheck and JavaScript syntax checks passed. These do not certify newer edits below.

### In progress now — MUST finish and test, not mark done

1. `research/betting/nfl/weekly_training.py`: Wednesday noon New York fit-slot policy,
   immutable source snapshots, actual delayed-fit cutoff, previous eligible artifact
   fallback, and upcoming-game requests. Presently ridge only. Needs dedicated schedule,
   failure/restart, freshness and mutation tests.
2. `dataset.football_feature_row`: extracted the historical feature builder for reuse by
   upcoming-game capture. Existing Python suite passed after extraction; add consumer
   parity/future-data tests. Scoring now accepts observed pregame research snapshots with
   retained raw feature inputs. Do not call these exact T-60 forecasts.
3. `learned-shadow-runner.js`: registered `nfl_learned_shadow` in the existing scheduler;
   saves requests/results before linking unqualified candidate decisions to the EXISTING
   decision tape. Needs actual integration tests, including failed tape links/restarts,
   missing Python/model, no-price abstentions, and no changes to production authority.
4. `injury_admission.py`: historical versus actual-receipt admission and missingness;
   requires tests and real pilot report. It is not yet connected to trained features.
5. New inner-fit guard in `model_artifact.py`: exclude labels unavailable at the first
   validation cutoff and retain inner row IDs. Retest before any research run.

### Injury evidence found (do not repeat the blind backfill)

The original live DB already has 2024: 6,213, 2025: 5,783, 2026: 182 injury rows.
All 2025 rows have NULL modified_at. nflverse documentation still says its injury feed
stopped after 2024, but direct HEAD requests on September 15 returned 200 for both 2025
and 2026 CSV files. Inspect actual files; do not treat the stale documentation or local
row counts as proof of usable historical timestamps.

A 2024 Weeks 1–4 pilot was downloaded and retained under this Codex task's
`work/injury-pilot/`: 1,089 rows, final season-file SHA256
`498bce8e13cb64b2ab9bb0ad6cb81d0a63c2ddb24016c9fc90c2de2126fae449`.
This file was received September 15, 2026; its HTTP Last-Modified is February 13, 2025.
It is a final archive, not proof of which exact version existed at every historical
cutoff. Most row updates are after the Wednesday fit time. Team aliases must be normalized
before reporting coverage. Keep unknown/missing injury evidence distinct from healthy.

### Environment and continuation commands

The matching, already installed Python is
`/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/research/.venv/bin/python`
(sklearn 1.7.2, numpy 2.5.3, joblib 1.6.0, LightGBM 4.7.0). Bare python3 points elsewhere.
Set GRIDIRON_RESEARCH_PYTHON explicitly for Node integration tests. Never run tests
against either real server/data.sqlite. All prior checks used disposable DBs.

Current task evidence/scratch:
`/Users/nick_matta/Documents/Codex/2026-09-15/claude-was-doing-some-work-find/`.
Original unfinished files were backed up in `work/recovered-edits/`.

**Next:** finish/test scheduled trained-candidate capture, add the already specified
shallow LightGBM artifact/serving path and justified earlier-only calibration/combination
work, finish injury admission/coverage evidence, then run the same weekly pipeline in
historical walk-forward. Do not substitute another annual lab run or a huge model search.
No live stakes, promotion, or profitability claim is authorized by an engineering pass.

### RESUMED and fixed — September 15, 2026 (later same day)

The STOP section below this one records the halt point; this section records what
happened after Nick said to resume. **Both verified bugs from STOP are now fixed, plus
two more the fix surfaced. Full suite is green: 2,094 passed, 0 failed, 39 skipped**
(`GRIDIRON_RESEARCH_PYTHON=/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/research/.venv/bin/python3 npm test`).
Nothing has been committed — this is still all working-tree state.

1. **`unified_model.chronological_blocks` minimum-row failure — fixture bug, not a
   production bug.** The 100-row calibration / 100-row combination / 200-row base
   minimums are legitimate guards sized for real weekly volume (~16 games/week). The
   reused stage3 fixture (`_synthetic_multiseason_rows`) generates exactly **one** game
   per synthetic "week," which caps the fixed 12-week calibration block at 12 rows no
   matter how many seasons are added — structurally unable to clear a 100-row minimum.
   Fix: added `_synthetic_shadow_rows()` directly in `test_weekly_training.py` — real
   multi-game weeks (10 games/week), real 7-day calendar spacing so the 3-day
   `RESULT_PUBLICATION_LAG` never collides with a block boundary. Also fixed
   `test_only_completed_earlier_fits_within_staleness_limit_are_selected`'s fixture,
   which was missing the `algorithm: 'unified_margin'` field `choose_artifact` now
   filters on (added this session) — it was silently returning `None` for every fit.
   `test_weekly_training.py`: 5/5 green.
2. **`GRIDIRON_RESEARCH_PYTHON` pinned** to
   `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/research/.venv/bin/python3`
   (sklearn 1.7.2, numpy 2.5.3, joblib 1.6.0, LightGBM 4.7.0) for every command below.
   The bare `python3` on PATH is Homebrew 3.14 with no LightGBM — same trap as before.
3. **Two more bugs found once real integration ran under the correct interpreter:**
   - `test/learned-shadow-runner.test.js`'s end-to-end test failed with `insufficient
     base rows: 0 < 200`. Root cause: `test/helpers/seed-ensemble-fixture.js` (a
     shared fixture used by 4 test files + 4 scripts) wrote the **same** `gameday`
     string (`${season}-09-01`) for all 17 weeks of a season — fine for its original
     consumers, which only key off `(season, week)`, but it collapses every game in a
     season onto one instant for anything that filters by real elapsed time (the
     `RESULT_PUBLICATION_LAG` cutoff), making whole seasons wholly eligible or wholly
     excluded together instead of week by week. Fixed by computing a real, 7-day-spaced
     `weekGameday` per week (not drawn from the PRNG, so this does not change any
     documented determinism guarantee). Also bumped `learned-shadow-runner.test.js`'s
     own fixture call to 4 seasons and 18 teams (9 games/week — the original 16-team/8
     games/week fixture caps the fixed 12-week calibration block at 96, permanently
     under the 100 minimum regardless of season count) — kept the original 16 teams,
     including KC/BAL/SF/SEA, so their historical form features are unaffected.
     **Now genuinely passes the real weekly-training-to-shadow-decision-tape path
     end to end** (not mocked) — this is the first time that has happened.
   - `test/python-artifact.test.js` failed with `no such column: spec_hash` — it
     dynamically imports `spread-family-adapters.js`, which opens/migrates the
     database on import, and this file (unlike `spread-family-adapters.test.js`) never
     set `GRIDIRON_DB_PATH` first. It fell through to the real default
     (`server/data.sqlite`), which is on an older, unmigrated schema. **No real data
     was touched** (mtime unchanged, migration errored before any commit) but this was
     a genuine test-isolation gap that could have written to production data with a
     newer/different schema drift. Fixed by giving it the same scratch-DB guard
     `spread-family-adapters.test.js` already has.

**Files touched this pass (all uncommitted):**
`research/betting/nfl/test_weekly_training.py`, `test/helpers/seed-ensemble-fixture.js`,
`test/learned-shadow-runner.test.js`, `test/python-artifact.test.js`.

**Next (unchanged from before, still valid):** finish items 2-5 from "In progress now"
above (`dataset.football_feature_row` consumer/future-data tests, `learned-shadow-
runner.js` failure-mode integration tests, wire `injury_admission.py` into trained
features, retest the inner-fit guard), then run the historical walk-forward audit
through this now-working weekly path. See "Where we go from here" below for the fuller
roadmap past that point.

---

### STOP — September 15, 2026: work halted here on explicit instruction (historical — see RESUMED above)

Nick told this session to stop building and hand off. **No process is running** (checked:
only the unrelated long-lived dev server/vite/tunnel processes were alive). The working
tree is exactly as the previous session left it; **nothing here has been committed.**
Everything below was verified by actually running it just now — it is not carried over
from an earlier claim, and it supersedes anything above that conflicts with it.

**Verified broken, not just "in progress":**

- `weekly_training.fit_week` requests `algorithm='unified_margin'`, which
  `model_artifact.fit_and_save` dispatches to `unified_model.fit_unified` via the new
  `ALGORITHM_FITTERS['unified_margin']` entry (added this session). Under the framework
  Python (no LightGBM) it fails immediately: `RuntimeError: unified recipe requires the
  already specified LightGBM dependency`. Re-running under the venv that actually has
  LightGBM (`/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard/research/.venv/bin/python3`,
  LightGBM 4.7.0) clears that error but exposes a second, real bug: `unified_model.
  chronological_blocks` requires >=100 rows in its "combination" block, and `test_weekly_
  training.py`'s synthetic fixtures only produce 21 rows — the test fixtures were never
  updated for this new minimum-row guard. Result: `test_weekly_training.py` fails 3 of 5
  tests (`test_interrupted_fit_reuses_frozen_training_values_on_retry`, `test_only_
  completed_earlier_fits_within_staleness_limit_are_selected`, `test_same_slot_reuses_
  snapshot_and_fit_despite_later_source_changes`). Whether the 100-row minimum itself is
  right for real weekly volume, or the fixtures are simply wrong, has not been decided.
- Everything else new is fine as far as its own tests go: `learned-shadow-runner.test.js`,
  `python-artifact.test.js` and `total-probabilities.test.js` pass 20/22 (2 intentionally
  skipped pending `GRIDIRON_RESEARCH_PYTHON`). `injury_admission.py` and `score_artifact.py`
  were not re-verified in this pass — treat as unverified, not as passing, until rerun.
- The "In progress now" list above (items 1-5) is accurate on scope but was written before
  this verification. Item 1 in particular is not close to done: the default training path
  it describes does not currently run end-to-end.

---

### RESULT — the walk-forward audit ran, September 15, 2026

**The market beats the unified model, decisively, and it is not noise.**

Run: `docs/betting-model/research/experiment-results/unified_margin_audit/20260915T193513Z-89562259`.
523 weeks refit, 50 weeks abstained (too little history for the recipe's blocks),
6,661 games scored on common support with the market.

| Forecast | MAE | RMSE | bias |
|---|---:|---:|---:|
| Market (`-market_spread`) | **10.247** | 13.186 | −0.050 |
| Unified margin (weekly refit) | 10.678 | 13.726 | +0.339 |
| Zero-information | 11.306 | — | — |

Week-clustered block bootstrap (`pairedBootstrapDiff`, groups=`fit_week`, 4,000
iterations): mean difference **+0.432** points/game against the model, 90% CI
**[0.365, 0.500]**, excludes zero, `significant: true`, and the model was better in
**0 of 4,000** resamples. This is not a sample-size problem.

Two things worth reading carefully:

- **Weekly refitting and the learned blend bought essentially nothing.** Stage 3's
  annual-fold ridge was MAE 10.675; this weekly-refit learned combination of ridge
  and LightGBM is 10.678. Refitting 523 times instead of 24, and learning blend
  weights, moved the third decimal. The gap to the market (0.43) is ~40% of the
  entire gap between the market and knowing nothing at all (1.06).
- **The uncertainty estimate is genuinely good.** The nominal 80% interval covered
  **80.3%** of outcomes. The model does not know the margin, but it honestly knows
  how much it does not know — mean width 35.8 points, which is the real message:
  an NFL margin is that uncertain, and the market prices it better than we do.

This is a valid completion under the predeclared decision rule, not a prompt to
search for a configuration that wins. It is also margin prediction only — no
verified decision-time executable quote was used, so it is not a betting result.

### Injury / player-value data audit — September 15, 2026

Measured, not assumed. Everything below is from the live research database,
read-only.

**Injury evidence coverage: 1,083 of 7,292 games (14.9%).** The 6,209-game gap
is three different problems, and only one is ours:

| Gap | Games | Recoverable? |
|---|---:|---|
| Pre-2021 — `nfl_injuries` has no rows at all that far back | 5,852 | Not from this database. Needs a historical injury archive. |
| 2025-2026 — rows exist (5,965) but `modified_at` is NULL | 301 | **Not our bug**: `nfl-advanced.js` writes `r.date_modified` faithfully; nflverse dropped the column upstream. Forward fix only. |
| 2021-2024 — no admissible row for that specific game | 56 | Already at 94.7-95.4% coverage in these seasons. |

The 2025/2026 hole is the one that bites: **that is the era we actually serve.**
`nfl_feature_revisions` is the right forward mechanism (it records `observed_at`,
our own receipt clock, which supports the `observed` admission regime) but holds
only **20** `injury_report` rows today, so it recovers nothing retroactively. It
accumulates from here.

**Player weighting — what exists and what does not:**

- **Offence: real, rich, usable.** `nfl_player_week_features` carries 52,544
  player-weeks, 2016-2026, with genuine EPA (`pass_epa_per_att`, `cpoe`,
  `rush_epa_per_carry`, usage shares). Keyed on `player_id`, which joins
  cleanly to `nfl_injuries.gsis_id` — no fragile name match needed. This is
  enough to build empirical value-above-replacement (the nflWAR method, which
  is the GitHub catalog's own item #1) instead of hand-typed constants.
- **Defence: playing time only.** That same table holds just **136** rows
  across all defensive positions, and they are incidental (a defender who
  touched the ball). There is no per-player defensive production anywhere:
  `player_gamelog` and `player_season_stats` are fantasy points. So a star edge
  rusher and a replacement-level one at the same snap share are currently
  indistinguishable to the model. Team-level defensive EPA does exist
  (`nfl_team_week_features`, 5,395 rows) — player-level does not.
- **PFF: zero rows.** `nfl_external_player_grades`, `draft_grades` and
  `nfl_clv_grades` are all empty. The normalisation path is written; there is
  no licensed data behind it. PFF is the one source that would close the
  defensive gap, because it grades every player on the field rather than only
  those who touch the ball.

**Two defects fixed while measuring this:**

1. `availabilityDeficit` selected `offense_pct` alone, so every defender —
   about half of each roster — matched nothing and fell through to a flat 0.15
   default, valued by position only. `defense_pct` is fully populated (25,271
   of 25,271 rows in 2021 and every season since) and is now read.
2. It admitted week-W injury rows regardless of when they were last written.
   `nfl_injuries` is current-state with no version history, so a row revised
   after kickoff cannot stand in for the pre-game report. It now takes an
   optional `cutoffAt` that admits only rows untouched since before it; live
   callers are unchanged, and the cutoff is part of the cache key.

`availabilityDeficit` had **no direct test** before this — every reference
either mocked it away or checked only the null case. It now has eight.

### The separate labs, and the reason the audit lost — September 15, 2026

**The ML model has never been allowed to see the market.**
`stage3_team_strength.py` states it outright at line 58: "`market_spread` /
`market_total` NEVER appear as a candidate INPUT feature." The 14-feature
vector is rest, division, recent form and play-by-play differentials. Nothing
else.

So the walk-forward audit compared a *pure football model* against *the
market* and found the market better by 0.432 points. That is the expected
result, not a surprising one: the market prices injuries, weather, sharp money
and public information, and the candidate was forbidden all of it. The result
is honest and worth keeping, but it does not say "our ML is weak" — it says a
football-only forecast does not beat a market forecast, which the corpus's own
literature (Lopez-Matthews-Baumer) already predicted.

What the plan actually asks for and what does not exist: Stage 3 specifies a
betting head that "learn[s] the correction to the decision-time market" with
"chronological football-model predictions as features." **There is no such
head.** That is the single largest structural gap, and it is larger than the
injury gap — because market coverage is near-total where injury coverage is
not (see below).

**Every lab in the tree, and whether it reaches a decision:**

| Lab | Size | Predicts | Wired into the unified decision? |
|---|---:|---|---|
| `stage3_team_strength.py` | 27KB | football margin, annual folds | **Yes** — it is the base family |
| `unified_model.py` | 9KB | learned ridge+LightGBM blend | **Yes** — it is the group |
| `expert_selector_lab.py` | 51KB | simplex ridge, family clustering | **Partly** — only `simplex_ridge` / `cluster_families` are imported |
| `tree_lab.py` | 63KB | opening-to-closing movement, **cover/over classification**, quantile regression of the market residual (LightGBM/XGBoost/CatBoost) | **No** |
| `book_lag_lab.py` | 56KB | which book moves first; `lead_lag_matrix.json` | **No** — and it reads a frozen evidence dataset, not `data.sqlite` |
| `market_lab.py` | 20KB | opening-to-closing movement (superseded by `tree_lab`, kept for comparison) | **No** |
| `drift.py` / `model_discipline.py` / `leakage.py` | 75KB | drift scans, observation-to-parameter checks, leakage checks | Support, called by the labs that use them |

So ~139KB of modelling — and the only three targets that are actually *about
betting* (cover, market residual, line movement) — sit outside the decision
path entirely.

**Coverage for the 2021-2026 window, which is the window that matters:**

| Evidence | Coverage 2021-2026 |
|---|---|
| Closing spread | **100%** (285/285 every season) |
| Opening spread | 95-100%; both open+close on 1,666 of 1,696 games (**98.2%**) |
| Archived quotes | 135,930 odds-archive rows, 2,459,617 line snapshots |
| Injury evidence | **75.2%** (1,083 of 1,440 completed games) |
| Per-player defensive quality | **0%** — see below |

Restricting to 2021-2026 moves injury coverage from 14.9% to 75.2%, which is
what makes the injury experiment viable at all.

**PFF and defensive value are genuinely blocked, not merely unbuilt.**
`nfl_external_player_grades`, `draft_grades` and `nfl_clv_grades` are all
empty. Per-player defensive production does not exist anywhere:
`nfl_player_week_features` holds 136 defensive rows out of 52,544, and they are
incidental. `nfl_play_by_play` carries **no player identity at all** — only
`offense`/`defense` team codes — so on/off-field defensive value cannot be
derived from it either. A defender can therefore be weighted by how much he
plays (`defense_pct`, now actually read) but never by how well. Closing that
needs a grading source (PFF) or participation data; it is not a coding task.

### BUILD PLAN — September 15, 2026, scoped to 2021-2026

Ordered by expected value against measured coverage, not by novelty. Each
phase is a registered experiment: predeclare, then run, then keep the verdict
whichever way it falls. The baseline every phase is measured against is the
one already on record — **unified margin MAE 10.678 vs market 10.247**,
6,661 games, run `20260915T193513Z-89562259`.

#### Phase 0 — DONE, September 15, 2026 (later same day)

Implemented and verified. `stage3.FEATURE_NAMES` stays the frozen 14;
`stage3.EXTENDED_FEATURE_NAMES` adds `home_availability_deficit`,
`away_availability_deficit`, `availability_evidence`. `feature_names` now
threads through `row_features` → `feature_matrix` → `fit_ridge_artifact` →
`fit_unified` → `fit_and_save` → `save_artifact`, and is part of the artifact
identity (`compute_config_hash` already read `meta['feature_names']`; the
only real bug was `fit_and_save` hardcoding `stage3.FEATURE_NAMES` into
`save_artifact` regardless of what the fitter actually used — fixed
alongside the wiring, since it would have mislabeled any future extended
fit's own metadata).

Nine new tests (`test_feature_wiring.py`) prove both halves: rows carrying
availability fields produce a **byte-identical** `config_content_hash`/`run_id`
under the default set (three separate proofs — `row_features`, the ridge
training hash, and the full `fit_and_save` artifact identity), and the
**same** rows produce a **different** hash under
`feature_names=stage3.EXTENDED_FEATURE_NAMES`, at every layer including
`fit_unified`. Full suite: 102/102. Also re-verified directly against real
data: `fit_unified()` on the exact training window from the original 10.678
run reproduces its exact learned weights (`[0.4536, 0.5464]`) and declares
`feature_names` as the frozen 14 — the baseline is provably untouched.

Old text below, retained for what it specified rather than re-litigated:

<details><summary>original Phase 0 spec</summary>

#### Phase 0 — close the wiring gap that makes any of this measurable (prerequisite)

Injury/availability features currently reach the dataset row but **not the
model**: `stage3.row_features()` emits exactly the predeclared 14 and
`feature_matrix()` selects by `FEATURE_NAMES`, so anything else is silently
dropped. Until this is fixed, every experiment below would measure nothing and
report success.

- Keep `FEATURE_NAMES` as the frozen 14 so the existing baseline stays
  reproducible; add a named, opt-in extended set alongside it.
- Thread the chosen feature list through `feature_matrix` →
  `fit_ridge_artifact` → `fit_unified` → `model_artifact.fit_and_save`, and
  put it in the artifact identity so a model fitted on a different feature set
  cannot silently reuse another's ID.
- **Done when** a fit with the extended set produces a different artifact ID,
  and a fit with the default set reproduces the current baseline exactly.

</details>

#### Phase 1 — BUILT, September 15, 2026 (audit result pending below)

Implemented as `research/betting/nfl/market_correction.py` (`fit_market_correction` /
`MarketCorrectionModel`), following Stage 3's own instruction exactly: a
football model fit on strictly earlier weeks feeds a correction head that
learns `market_residual = actual_margin - (-market_spread)`, using three
features — `football_prediction`, `market_spread`, `market_movement`
(closing minus opening).

**`dataset.py` gained `open_spread`/`open_total`/`market_movement`** (all
gated behind `include_labels`, matching where `market_spread` already lived
— not a new ungated path in). Verified on real 2024 data: e.g. ATL/PIT
week 1, spread moved -3.0 → -4.0, `market_movement` correctly reports +1.0
(toward the home team).

**Out-of-fold discipline, proven not asserted.** Reuses
`unified_model.chronological_blocks` unmodified: football model fits on
`base`, scores `combination` out-of-fold to train the correction head, then
refits on `base+combination` for `calibration` — mirroring `fit_unified`'s
own final-refit step exactly. Two mutation tests confirm it: changing a
combination week's outcome cannot change the base-only football model's
prediction on that same row, and changing a calibration outcome cannot
change the final football refit's predictions on an earlier row. 8/8 tests
in `test_market_correction.py`.

**Wired into the SAME audit script, not a sixth one.** `unified_margin_audit.py`'s
`run_walk_forward` now also fits and scores the correction head on the
identical weekly training set the unified model just used — one refit loop,
two independently-abstaining candidates (the correction head needs
market-evidenced rows the unified model doesn't, so a week can fit one and
abstain the other, both recorded honestly). Added `correction_metric_block`,
`correction_paired_difference` (against both `market` and `football_alone`
— Stage 3's own rule that beating football-alone alone proves nothing about
betting), and `correction_group_table`. 6 new tests in
`test_unified_margin_audit.py`, including one proving the correction fit
never changes the unified model's own numbers. Full Python suite: 116/116.
Full Node suite (unrelated but re-verified after the dataset.py schema
change): 2,108/0.

**Deliberately NOT done:** not wired into `weekly_training.py` or the
learned-shadow production path. Stage 3's own baselines-first discipline —
this stays a measured research candidate until it beats both the market and
the football-alone baseline on the same games, per the real run below.

### RESULT — Phase 1 ran, September 15, 2026: closes most of the gap, doesn't fully close it

Run `20260915T203201Z-f4384238`, 2021-2026, same 111 weeks / 1,440 games as
the unified-model audit. `scripts/unified-margin-audit-significance.mjs`
generalized to accept `--a`/`--b` field names rather than write a second
significance script for this comparison. (Superseded by
`20260915T223534Z-08903ca1` below — same numbers, fixed provenance; cite
the newer run_id going forward.)

| Forecast | MAE | vs market (90% CI, week-clustered) |
|---|---:|---|
| Market | 9.779 | — |
| Unified model (football-only) | 10.271 | +0.493 worse, significant |
| **Market-correction head** | **9.913** | **+0.134 worse, significant** [0.064, 0.209] |
| Football-alone (the correction's own base model) | 10.275 | +0.496 worse, significant |

**The hypothesis behind Phase 1 is confirmed: the market carries real
information the football model doesn't.** Correction vs football-alone:
**−0.362 points/game, 90% CI [−0.502, −0.222], significant** — letting the
model see `market_spread` and `market_movement` measurably improved it, and
by a wide, non-marginal margin. This is exactly why the original 0.493-point
gap existed: a model forbidden the market was never going to close it.

**But per Stage 3's own predeclared rule, this does not clear the bar for
promotion.** Correction vs market is still significant IN THE MARKET'S
FAVOR — 0.134 points/game, CI excludes zero. Three plain, narrow features
(a stacked football prediction, the spread, the movement) recovered most of
the gap (0.493 → 0.134, a 73% reduction) but not all of it. That is not a
failure of the experiment — a naive regression onto the market number
closing 73% of the gap to the market itself, without ever seeing an injury
report or a play-by-play differential adjustment for the correction step,
is a real, informative result. It says the next-highest-value work is
richer correction-head features (the injury/availability wiring from
Phase 3, run through THIS head, not just the football model), not a bigger
model on the same three inputs.

**Status per protocol: remains an unwired research candidate.** Neither
baseline beaten cleanly; `weekly_training.py` is untouched. Nothing here
changes betting authority.

### Audit system validity — September 15, 2026

Nick asked for a validity pass on the audit itself before trusting its
numbers. Checked every guarantee in `unified_margin_audit.py`'s own
docstring against the code, not just the prose; found three real gaps in
the harness's own bookkeeping (not in the science) and fixed them:

1. **Code fingerprint was taken at the wrong time.** `code_identity()` hashed
   the model files *after* scoring finished, so an edit made mid-run (an
   8-minute window) would be silently recorded as the run's provenance
   instead of flagged. Also omitted `market_correction.py` itself, despite
   the report carrying its numbers. Fixed: hashed once at process start
   (right after import, before the first game is scored) into
   `preregistered.json['code_identity']` and `report.json['code_identity']`;
   `market_correction.py` added to the hashed set (now 7 files). A second
   hash taken at the end diffs against the start hash into
   `report.json['code_files_modified_during_run']` — non-empty means
   don't trust that run's numbers, re-run first.
2. **The correction head wasn't preregistered.** `protocol()` (written to
   disk before a single game is scored) declared only the unified model's
   recipe; the correction head's recipe, and the fact that its market
   features are the stored *closing* line while the football model's own
   features and fit slot use the publication-lag horizon, were undeclared.
   Fixed: `protocol()` now includes `secondary_candidate` (the correction
   head's full recipe and decision rule) and `horizons` (spelling out which
   three things run on which clock: model weights at the Wednesday slot,
   row features at kickoff, market baseline/correction features at close).
3. **"Every game accounted for" was asserted in prose, not enforced.** Added
   `check_accounting()`: raises unless
   `games_scored + games_in_abstained_weeks == rows in the evaluation window`,
   and unless no game was scored twice. Called at the end of `run()`;
   `report.json['rows_in_evaluation_window']` now carries the number the
   invariant was checked against.

3 new tests (`ProvenanceAndAccountingTests` in `test_unified_margin_audit.py`)
cover all three, plus the existing no-look-ahead mutation test and the
existing accounting test were re-verified unchanged. Full Python suite:
**119/119.**

**Re-ran the real 2021-2026 audit end to end with the fix** — new run
`20260915T223534Z-08903ca1` (supersedes `20260915T203201Z-f4384238`, same
data, same protocol content plus the newly-declared fields, different
`protocol_hash` because the preregistered spec text itself changed).
Numbers are **byte-identical** to the pre-fix run: unified 10.271 vs market
9.779 (+0.493, CI [0.357, 0.626]); correction 9.913 (+0.134 vs market, CI
[0.064, 0.209], sig.; −0.362 vs football-alone, CI [−0.502, −0.222], sig.).
`report.json` shows `rows_in_evaluation_window: 1440` (matches
`games_scored`, `games_in_abstained_weeks: 0`) and
`code_files_modified_during_run: []`. The fixes changed the harness's
bookkeeping, not the result — which is exactly what should happen when a
provenance/accounting gap is closed on a run that was already correct.

**What was already solid, verified rather than re-derived:**
- No-look-ahead: `week_cutoff` uses production's own `weekly_origin`;
  `eligible_football_rows` uses production's own lag rule; a structural
  `AssertionError` fires if any test-week game ever entered its own training
  set (never triggered on the real run).
- Preregistration-before-results: `preregistered.json` is written with
  `results_exist_yet: false` before `build_football_dataset` runs, and
  rewritten with `results_exist_yet: true` only after `report.json` exists.
  `LATEST.json` — the pointer the explain-pick tool reads — is written last,
  only on a clean exit; an exception anywhere above never reaches that line,
  so a failed or interrupted run cannot change what upcoming-game
  explanations cite.
- Significance: one path only, `pairedBootstrapDiff(..., {groups: fit_week})`
  via `scripts/unified-margin-audit-significance.mjs`; the audit module
  itself deliberately computes no interval, so there is no second,
  divergent bootstrap to drift out of sync.
- Empty-dataset / all-abstained / zero-weeks all raise loudly instead of
  writing a "nothing to report" file that could be mistaken for a genuine
  null result.

**Known, already-documented limits that remain true and are not bugs:**
`market_spread` is a stored closing line, not a verified T-60 executable
quote (no result here is a betting/profitability finding); this is
development data, inspected repeatedly, so a prospective frozen window is
still required before any forward claim; interval coverage (80.0%) is
measured inside the audit window and is not a guarantee on future dependent
games; the correction-vs-football_alone comparison is not horizon-matched
(the correction head sees the close, football-alone doesn't) — now stated
explicitly in `report.json['limitations']` rather than left implicit.

**Bottom line: the audit is valid.** The three gaps were about the audit
*proving what it claims*, not about the numbers being wrong — and the
re-run confirms that by reproducing them exactly. Nothing here changes the
verdict: unified model loses to market, correction head recovers 73% of the
gap but not all of it, and the correction head still has no betting
authority.

<details><summary>original Phase 1 spec</summary>

#### Phase 1 — the market-correction head (the actual reason the audit lost)

98.2% of 2021-2026 games have both opening and closing spreads; 2.46M line
snapshots exist. The model is currently forbidden all of it.

- New target: the **market residual** (`actual_margin - (-market_spread)`),
  not raw margin. This is Stage 3's own instruction: "learn the correction to
  the decision-time market," with chronological football-model predictions as
  an input feature.
- Features: the football model's own out-of-fold prediction (fitted strictly
  earlier), the quote itself, opening-to-closing movement, and the existing 14.
- The football prediction must come from a model that never saw the game being
  scored — stacked chronologically, or it is leakage dressed as improvement.
- **Baselines that must be beaten to claim anything:** the market alone
  (residual = 0) and the football model alone. Beating only the football model
  proves nothing about betting.
- **Done when** the same weekly walk-forward reports market-residual MAE for
  the correction head against those two baselines on identical games, with the
  week-clustered interval from `pairedBootstrapDiff`.

</details>

#### Phase 1.5 — measure the ensemble's effective rank on REAL data, before adding any family

This phase exists because the original ordering was wrong. Phase 2 adds a
family to the blend; whether that can help at all depends on how many
independent directions the blend already has, and **that has never been
measured on real football.**

`server/services/nfl-ensemble-rank.js` is built, validated against
known-answer fixtures (3-factor and 8-factor synthetic leagues), and has never
been run against real history — the session that wrote it was barred from
opening the live database, and its own evidence file says so: "the effective
rank of the production ensemble on real NFL history was not measured, and no
number in this document should be read as that measurement."

Two independent audits claim ~31 components carry ~2-3 independent signals,
and the section-8.6 family ablation found **2 of 31** conclusively
contributing. If that is true in the `market_residual` space — the only space
that can carry an edge, since the market already prices the obvious — then the
blend is saturated and the correct move is **pruning, not adding**, and
Phase 2 would buy nothing.

- Run it against a read-only copy, never the live file:
  `GRIDIRON_DB_PATH=<copy> node scripts/ensemble-rank-report.mjs --before-season 2025`
- Report participation ratio, entropy rank and PCs-for-90/95/99% in BOTH
  `raw_margin` and `market_residual`. A low raw-margin rank is expected and is
  not a finding; the residual-space number is the one that decides.
- **Done when** there is a measured effective rank on real games, and a
  decision recorded: add families (Phase 2) or prune first.

#### Phase 2 — fold in `tree_lab`'s cover target (gated on Phase 1.5)

`tree_lab.py` (63KB) already implements cover/over classification and
quantile regression of the market residual across LightGBM/XGBoost/CatBoost,
with a genuine market-only baseline in every comparison. It is price-gated to
2022+, which fits this window.

- Do not re-implement it. Expose its cover probability as a family the
  unified combination can weight, exactly as ridge and LightGBM are today.
- A cover probability is the quantity the gates actually consume, so this is
  the first phase whose output could reach a decision rather than a report.
- **Done when** the cover head is a registered family inside `unified_model`'s
  learned blend, with its own calibrator identity, and the blend's weights are
  fitted on earlier-only data like every other component.

#### Phase 3 — injuries and defensive value, at 75% coverage

Injury evidence covers 1,083 of 1,440 completed 2021-2026 games.

- Weighted availability deficit is already exported per game at its own cutoff
  (`scripts/export-availability-features.mjs`) and read by `dataset.py`.
- Run it as an A/B against the Phase 1/2 model on identical games. A feature
  present on 75% of rows must be shown to help, not assumed to.

**Solving the defensive-quality gap without paying for PFF.** PFF is not
needed, and its API would not work for this anyway: its grades are
**per season**, so using a 2023 grade to weight a week-3 2023 injury reads the
future — the exact leakage class the September review's R1-R3 findings were
about. The free replacement is already ingested and unused:

`nfl_pfr_adv` (kind `def`) holds **7,626 rows for 2024 and 7,544 for 2025**,
per player **per week**, from the nflverse PFR advanced release we already
pull: `def_pressures`, `def_times_hurried`, `def_sacks`,
`def_passer_rating_allowed`, `def_completion_pct`, `def_yards_allowed_per_tgt`,
`def_targets`, `def_missed_tackles`, `def_tackles_combined`. That is coverage
quality, pass rush and tackling — most of what a PFF defensive grade is built
from — and because it is weekly it can be used point-in-time from strictly
earlier weeks.

- Build defensive value-above-replacement from those fields, prior weeks only,
  mirroring the offensive EPA method (`nfl_player_week_features`, 52,544
  player-weeks, 2016-2026, keyed on `player_id` which joins to
  `nfl_injuries.gsis_id`).
- Join caveat: `nfl_pfr_adv` keys on `player_name`, so it needs a full-name
  match to the injury table with an explicit unmatched count, never a silent
  drop.
- Coverage caveat: the PFR weekly release **begins in 2024**, so 2021-2023
  defenders carry no quality signal and must stay missing rather than
  defaulting to a positional constant.
- **Do not scrape PFF.** It is a paid product; the season granularity makes it
  unusable for historical weighting regardless, and the free weekly data above
  is better suited to the question.

#### Phase 4 — the review findings this plan did NOT originally cover

Added after checking the plan against the September 15 review rather than
against itself. These are open, and two are P1.

- **R3 is still unresolved.** `t60-runner.js` still calls
  `autoPickDecisionBoardForPacket(packet, ...)` on the frozen-decision retry,
  and the review reproduced that this recomputes from mutable game context,
  team features, total market and calibration state while recording
  `dataIdentityStatus: 'frozen_packet'`. The fix the review asked for —
  persist the computed forecast and complete input/artifact identity BEFORE
  linking, and recover the stored result rather than recomputing — has not
  been implemented. Nothing downstream that claims a prospectively available
  forecast is trustworthy until it is.
- **The gates have never been empirically justified.** The review was explicit
  that "a gate rejecting everything is not sufficient evidence that its design
  is right": `staking.js` rejects an 80% margin interval wider than 24 points
  while observed widths run 32-34, so the rule rejects essentially everything.
  Our own audit now measures that interval at **35.8 points mean width with
  80.3% coverage** — i.e. the interval is honest and the threshold is simply
  unreachable. Audit each gate's purpose, inputs, information regime and
  attainable passing example. Do not loosen production stake authority to make
  picks appear.
- **The bounded 2024 weeks 1-4 news/injury pilot** (master plan item 6) is
  still not done.
- **The "independent simulation" family is still ensemble-anchored** — it is
  handed ensemble `targetMargin`/`targetTotal`, so it cannot serve as an
  independent mean forecast in any comparison.

#### Phase 5 — the two model groups, which is the real "pull the solo models in" question

"Pull the solo models into the big group" assumes one big group. **There are
two, and they never meet** (verified: zero references between them).

| Group | Members | Where it goes |
|---|---|---|
| JavaScript | `nfl-ensemble.js` — 31 components, 22 in the production blend — through `forecast-combination.js` | Production picks |
| Python | `unified_model.py` — 2 families (ridge, LightGBM) | Shadow decision tape only |

The Python group is what the weekly audit measured. The JS group is what
actually prices production. They share no features, no calibrator, no
combination step, and no identity. A "unified decision made as one unit"
cannot be claimed while both exist unjoined.

This needs an explicit decision, not a drift: either converge them behind one
combination step, or document why they stay separate with the specificity
`server/modeling/walk-forward.js` used when it declined to merge with
`weekly-walkforward.js`. Until that decision is recorded, `book_lag_lab`
(56KB), `market_lab` (20KB) and the unused 49KB of `expert_selector_lab` have
no defined destination either — which is why they have stayed solo.

### Audit timing → explain-pick wiring — September 15, 2026

Built the connective tissue Nick asked for: the audit's timing made explicit,
and its findings reachable from the existing "explain this pick" UI feature
for upcoming games.

**Timing, decided explicitly.** The full walk-forward audit does not run
weekly and must not — it refits ~111-523 times and is a measurement pass, not
a serving path; running it on a cadence tied to live decisions would let the
model implicitly peek at whichever window looks best, which is exactly the
anytime-monitoring problem the master plan's Stage 5/6 process exists to
prevent. So: **the audit runs at deliberate checkpoints** (after a real
model/feature change, or on a predeclared review schedule), and on
completion it atomically writes one pointer —
`docs/betting-model/research/experiment-results/unified_margin_audit/LATEST.json`
— containing the run id, the measured overall/paired-comparison numbers, and
every diagnostic group's stats. Nothing reads or regenerates this
continuously; it changes exactly once, when an audit finishes, and stays
fixed until the next one does.

**What "applies it to current picks" means, concretely — and what it does
NOT mean.** The audit does not, and must not, automatically change a gate,
threshold, or which model is live: the learned-shadow model has zero betting
authority regardless of what any audit finds (unchanged — see
`learned-shadow-runner.js`'s own tape note, "Unqualified trained margin
candidate; zero stake"). What "applies" means here is narrower and honest:
a new module, `server/services/nfl-learned-shadow-explain.js`, looks up the
frozen shadow forecast for one specific game (components, learned weights,
80% interval, calibration status — all of which were already being computed
by `UnifiedMarginModel.describe()` and saved to the decision tape, just never
read back out anywhere) and pairs it with the latest completed audit's
measured MAE for whichever of four schedule/venue/rest diagnostic groups
that game falls into (divisional, indoor, rest advantage, season phase —
deliberately NOT the five market-based groups, since this model never sees
the market at all, and faking that context from a live quote it was never
given would misrepresent what it actually knows).

**Wired into the existing explain-pick assistant**, not a new one:
`learned_shadow_research_context` is now a sixth read-only tool in
`page-explain-tools.js`'s existing tool-use loop (`nfl-page-explain.js`),
which already enforces "explain, never decide/place/resize/override" as a
system-prompt-level rule applying automatically to every tool including this
one. 6 tests (`test/nfl-learned-shadow-explain.test.js`) plus the pre-existing
14 explain-assistant tests, all passing, including the one that asserts the
declared tool set contains nothing shaped like a write.

**Verified for real, with one deliberate stop.** Re-ran the audit scoped to
2021-2026 (Nick's stated window): 111 weeks, 1,440 games, same finding as the
full-history run — market MAE 9.779 vs unified 10.271, week-clustered 90% CI
[0.357, 0.626], significant. `LATEST.json` now points at a real run with real
diagnostic-group stats (e.g. divisional_game n=497, indoor_roof n=450).

**What is NOT done, on purpose:** no real shadow observation exists yet for
any actual upcoming 2026 game — the shadow runner has only ever executed
against synthetic test fixtures and a scratch export DB, never the live
database. Running it for real would write rows into the live
`nfl_decision_events`/`nfl_decision_runs` tables, which is a production write
and needs Nick's go-ahead first, even though the row would be correctly
labeled zero-stake/research-only. Once that first real run happens (a
one-line command), the explain tool has something live to show; until then
it will honestly answer `available: false` for every current game.

### Research corpus reconciliation — September 15, 2026

Checked against `FIX_AND_ADD_ARCHITECTURE.md`, the September 12 synthesis of
all 56 F/GF/N/GN research notes (42 ranked FIX items, 22 ranked ADD items).
That document predates this session and predates the unified-model work
entirely, so its own "wire it all in" status was unknown going in.

**On PFF: no recalculation needed.** Confirmed by direct search — nothing in
the codebase currently computes a number that assumes PFF is present.
`nfl-roster-strength.js` already treats PFF as fully optional (`WHERE
provider='pff'`, joined against `nfl_external_player_grades`, comment reads
"always true today, since no PFF connector is configured") and is
`challengerOnly` — it has never been in the production blend. The 10.678
walk-forward baseline used none of this. There is nothing to rewire because
nothing was ever wired to PFF in the first place; today's decision (free
`nfl_pfr_adv` weekly defensive stats instead) is additive, not a correction.

**Verified against live code this pass** (8 of the highest-ranked items;
the other ~56 are catalogued but not individually re-verified — see below):

| # | Item | Status |
|---|---|---|
| FIX #28 | Consolidate 4 disagreeing CLV calculators into one | **Done.** `clv-core.js` exports the shared signed-points/fair-probability functions; 6 callers (`nfl-execution-clv.js`, `beat-the-close.js`, `forward-ledger.js`, `nfl-sharp.js`, `shadow-ledger.js`, `sharp-lag.js`) now use it. `nfl-prop-clv.js` stays separate, correctly — it stores a probability-delta, a genuinely different unit. |
| FIX #42 | `book-feeds.js` receipt-clock bug (every live capture mislabeled `legacy_request_time_only`) | **Done.** `receivedAt: at, receiptClockSource: 'response_completion'` is now passed correctly. |
| FIX #15/#18 | Split-conformal replacing the `disagreement/30` inflation hack | **Done** — confirmed earlier this session (`test/conformal-calibration.test.js`), and it is what WP13 built on. |
| FIX #25 | Wire the already-computed `wind_epa_delta` into `weather_total` instead of a flat `-2.4` | **Done.** Computed in `nfl-features.js`, read in `nfl-ensemble.js`. |
| ADD #2 | Transparency fields (`raw_value`, `age_source`, `curve_source`) on `dynastyAgeAdjustment()` | **Done.** All present in `dynasty-age-curve.js`. |
| FIX #14 | Closed-form ridge fix for team-strength opponent-blindness (flagged "single cheapest, highest-confidence item in the entire betting-model bucket") | **Open — and the September 15 check above looked in the wrong file.** CORRECTED September 16 after reading F15 in full and verifying by grep: the function FIX #14 targets, `blendedTeamRating()`, lives in `server/services/nfl-preseason-blend.js` (line 256), not `nfl-team-strength.js` — the latter only *calls* it (it is the GBM-feature aggregator, gated `blocked` behind `model-governance.js`, never significant on its own `recordTeamStrengthGate`). The correct diagnosis is not "no ridge logic": `nfl-preseason-blend.js` already implements the textbook single-unit normal-normal shrinkage (verified algebraically in F15, with a dated 2026-09-10 bug-fix history), but shrinks each team only toward *its own prior season* — it is missing the **cross-sectional half** (pooling toward a jointly-estimated grand mean across all 32 teams in the current season), which is precisely the mechanism that produces the James-Stein gain. NFL-specific evidence for that gain: Ragain/Peysakhovich/Ugander 2018, real 2016 NFL data, 256 games — empirical-Bayes pooling cut out-of-sample MSE **16.8%** vs MLE, and the gain was largest exactly where the who-played-whom graph is sparse (division-heavy schedule, few cross-conference games — ours). F08/F15 were already cited as sources for this in three older sections of this plan (data-sources table, advanced backlog, R07) — this is the first time they have been read and the target scoped. Fix is gated behind the pipeline's own existing `teamStrengthWalkForward` promotion test; not urgent for live serving (the pipeline is already blocked), but it is the foundation the correction head's football input stands on. |
| FIX #26 | Stand up MAPIE as an independent Python conformal cross-check | **Open.** Not installed in `research/.venv`. |
| FIX #36 | Wire `audit-registry.js`/blind-audit onto the existing tested `ModelRegistry` (migration 005) instead of a second, worse copy | **Open.** No reference found. |
| ADD #1 | One-time nflverse historical player-season import (prerequisite for the aging-curve and replacement-level items) | **Open.** `player_season_stats` holds 931 distinct players — still scoped to rostered players, not the full multi-decade population the item calls for. |

**Not individually reconciled this pass:** the remaining ~56 FIX/ADD items,
covering simulation (drive-sim sign flips, HFA, kneel/OT), audit-method
(trial registry DDL, entity-resolution blocking, Šidák correction ordering),
and new-capability infrastructure (GAS dynamic Poisson scoring, depth/fill-
aware execution, canary-serve gating). The source document itself estimates
the full FIX+ADD list at weeks of engineering, sequenced fantasy → simulation
→ betting-model → audit-method. A full line-by-line reconciliation against
current code is worth doing as its own pass — the 4-of-8 hit rate just
measured says real progress has landed since September 12, but not
comprehensively, and the only way to know which of the other 56 remain open
is to check each one the way the 8 above were just checked, not to assume.

**Where this intersects the build plan above:** FIX #14 (team-strength
opponent-adjustment) directly strengthens the football-prediction input to
Phase 1's market-correction head and should be sequenced into Phase 0/1, not
treated as separate. FIX #36 (registry wiring) and FIX #26 (MAPIE) both
support Phase 1.5's rank measurement — an independent Python cross-check on
whatever conformal/registry numbers that measurement produces is exactly what
#26 was for.

**One more F15 finding, recorded here so it is not lost (September 16):**
the same research note grep-confirmed **at least six independently
hand-rolled shrink-toward-prior formulas** with unfitted, hardcoded `k`
constants outside `shrinkage-fit.js`'s fitted-k infrastructure —
`nfl-context-heads.js:39`, `nfl-opponent.js:31`, `nfl-expert-council.js:117`
(k=30), `nfl-rookies.js:364` (k=80), `nfl-props-replay.js:127` (k=4),
`draft-assist.js:995` — none routing through `stats-util.js`'s canonical
`shrink`/`shrinkRate`. This is the same disease as the 5 CLV calculators and
37 content-addressing hashers, in a fourth place. The older problem register
below already records it in one line ("Multiple controllers currently apply
overlapping shrinkage or authority rules"); this is the file-and-line
version. It also found `nfl-roster-strength.js`'s eight blend constants
(`0.5/0.23/0.17/0.10`, `0.84^i`/`0.82^i`, `0.88/0.12`, `0.78/0.22`) are all
chosen by feel, none fit — lower priority than it sounds, because
`roster_strength` was already retired from the live blend this session
(R²=0.994 redundant with `availability`), so those constants currently
influence no pick. Added as a sweep item to the data-integrity checklist
further down.

### Combining the model groups — September 15, 2026: wired, measured, not promoted

Answered the "why don't we combine all these models" question with code, not
argument. Checked first whether it would even be additive: `nfl-ensemble.js`
already has two Market-family components (`market_anchor`,
`market_regression` — a 1-feature regression on the closing line alone). The
file's own header explains WHY they were historically double-counted before
a joint ridge fit replaced per-component isolated weighting (~1.2-1.4 RMSE
points worse than the market across two real audits) — exactly the
"scattered, unjoined" failure mode this session set out to fix.

**What was built:**
- `research/betting/nfl/export_market_correction_lookup.py` — reuses
  `unified_margin_audit.run_walk_forward`'s existing out-of-fold discipline
  (no second implementation) to precompute the correction head's prediction
  for every 2015-2026 game, matching `nfl-ensemble.js`'s own `MIN_SEASON`.
  Real run: **237 weeks, 3,044 games, 0 abstained.**
- `server/services/nfl-market-correction-lookup.js` — loads that export into
  a plain lookup Map. Missing/corrupt file abstains everywhere rather than
  throwing.
- A new `market_correction_research` entry in `nfl-ensemble.js`'s `MODELS`,
  `challengerOnly: true`, family `'Market'`, reading the precomputed value
  (never calling Python live — `componentPredictionStream`'s replay loop has
  no `await` in it, so a live subprocess call there would turn one joint fit
  into thousands of process spawns).

**Safety verified structurally, not asserted.** `blendEligible = m =>
includeChallengers || !m.challenger_only` gates every point the live blend
is assembled. Proved directly: a live `ensembleLine()` call for the same
game produces a **byte-identical result** whether the lookup holds real data
or is empty — even seeded with a deliberately absurd value (99) to make any
leak obvious. 6/6 new tests pass
(`test/nfl-market-correction-lookup.test.js`,
`test/nfl-ensemble-market-correction-component.test.js`).

**RESULT — run through the real joint fit on a 2015-2026 extract (174
margin-evaluated weeks, 3,044 games):**

| Component | margin_weight | residual_gate_passed |
|---|---:|---|
| market_regression (existing, 1-feature) | 0.3141 | false |
| **market_correction_research (new)** | **0.1623** | false |
| market_anchor (existing) | 0.0855 | false |

**The new component earned real, non-trivial weight (16.2%) in the joint
margin fit alongside the two existing market components — the joint ridge
did NOT zero it out as redundant.** That answers the actual question: this
is additive information, not a repackaged copy of what `market_regression`
already contributes. Consistent with the standalone Python audit's finding
that correction beats football-alone significantly.

**It also did not pass the stricter `residual_gate` — but neither did either
existing market component on this same replay window.** All three show
`residual_gate_passed: false` here, so this is not a defect specific to the
new component; it says the promotion bar for reaching live-blend residual
weight is strict on this window generally, which is itself worth noting but
is a pre-existing property of the gate, not introduced by Phase 1.

**Status: wired, measured, honestly gated — NOT promoted.**
`challengerOnly: true` remains. No live pick is affected; `blendEligible`
excludes it from every real `ensembleLine()` call by construction, verified
above. Promotion is a separate, explicit decision for later, gated on the
residual criteria the other two market components also haven't cleared here.

### Effective rank result — the §5 gate, September 15, 2026

RUNBOOK §3.4 ("NOT YET EXECUTED") run for real: `scripts/ensemble-rank-report.mjs
--before-season 2025`, 1,039 complete games across 29 measured components
(the 3 market-family components, including `market_correction_research`
above, tracked separately).

| Space | participation ratio | entropy rank | PCs for 90/95/99% |
|---|---:|---:|---|
| raw_margin | 3.127 | 6.4 | 10 / 13 / 19 |
| **market_residual** | **2.564** | **4.729** | **6 / 10 / 18** |

*(Numbers here are the RE-RUN after fixing a real bug found while validating step 6, below: the JS-side read-only extract was inserting `nfl_snaps` positionally, and that table's column order doesn't match between the live DB and the migrated schema — defensive snap PERCENTAGE and defensive snap COUNT were swapped, so every defender's snap share was read as ~100x too large. The conclusion is unchanged (rank moved 2.518→2.564, still in the "≈2-3" prune band) but the exact figures moved slightly and the `availability`/`market_correction_research` weights below reflect the fix.)*

**Independent confirmation of the same finding as the audit, from a
completely different diagnostic.** The rank tool also regresses the joint
blend against the market in residual space: `blend = 0 + 1×market, R²=1,
mean |departure| = 0`. Not "close to the market" — the blend IS the market,
exactly, to machine precision, on this window. Same conclusion the Python
audit reached (0/848 fits ever passed the residual gate), reached here by a
completely different piece of code measuring a completely different thing.

**This resolves RUNBOOK §5's predeclared gate.** `market_residual` effective
rank **2.518** falls in the "≈2-3" band the plan committed to *before*
running this — the rule that fires is **prune, don't combine**, not "build
`forecast-combination.js` as a new combiner." Building a combiner now would
have been solving a problem the data says doesn't exist: with true effective
rank around 2.5, a 29-component ensemble is mostly the same handful of
signals wearing different names, and a fancier combiner has nothing extra to
combine.

**12 of 29 components carry redundancy R² > 0.95** against the rest of the
catalog (from `spaces.market_residual.redundancy` in
`server/data/nfl-ensemble-rank.json`) — retirement candidates, not signals:

| Component | R² vs. rest | Closest partner |
|---|---:|---|
| point_diff | 0.999 | turnover_regressed (r=0.997) |
| availability | 0.999 | field_position (r=0.999) |
| pythagorean | 0.998 | point_diff (r=0.982) |
| field_position | 0.998 | availability (r=0.999) |
| turnover_regressed | 0.997 | point_diff (r=0.997) |
| massey | 0.996 | point_diff (r=0.996) |
| rest_travel | 0.994 | availability (r=0.997) |
| roster_strength | 0.994 | availability (r=0.996) |
| epa_net | 0.990 | pass_eff_matchup (r=0.908) |
| rush_eff_matchup | 0.977 | field_position (r=0.913) |
| pass_eff_matchup | 0.975 | epa_net (r=0.908) |
| opp_adjusted | 0.958 | melo (r=0.655) |

The genuinely distinct signals — the ones actually carrying the ensemble's
real rank — are the bottom of the list: `market_regression` (R²=0.35,
closest partner `availability` at r=−0.50), `market_anchor` (R²=0.43),
`recent_form` (R²=0.33), and mid-pack survivors like `melo`, `success_rate`,
`dynamic_state`, `drive_eff` (all R²≈0.84-0.87). This is the concrete
"unorganized, duplicate models" list asked for earlier — not a guess, a
measured redundancy matrix.

**Status: measured and gated, retirement NOT yet executed.** Actually
demoting the 12 to reports-only is a real change to live ensemble
composition and needs Nick's go-ahead given everything else still
uncommitted this session — RUNBOOK §5 records the "done when" (fixture
parity within 1e-6 before deleting any old path, then a §3.5 replay showing
no regression). The combiner-build branch of the old plan is struck, not
executed — rank didn't clear the bar for it.

### Data already in the house that no forecast reads — September 15, 2026

Nick asked whether to build more models beyond the 32. The rank result
above says no: effective rank ~2.5 means more models on the same inputs are
more copies. What is missing is *information*, so this pass inventoried
every `nfl_*` table in the live research database (read-only) and checked,
by grep, which ones reach anything that produces a forecast number
(`nfl-ensemble.js`, the specialist/council files, or the Python
`dataset.py` → `stage3` → `market_correction.py` path).

**Twelve tables of real, timestamped data reach none of them.** Each is
consumed somewhere (display routes, audit/registry code, player-value
packets) but never enters a prediction. Coverage measured, not assumed:

| Table | Seasons | Coverage | Point-in-time clock | What it is | Where it belongs |
|---|---|---|---|---|---|
| `nfl_qbr_weekly` | 2016-2026 | ~530 team-weeks/season (full) | `fetched_at` | ESPN QBR per QB per week | Football model or correction head: **starting-QB quality** |
| `nfl_depth` | 2021-2026 | ~570 team-weeks/season (full) | `captured` on every row | Depth chart: who starts, by slot | With QBR: **who is the QB this week** — the one injury effect a flat 4.5 weight cannot express |
| `nfl_nfelo_lines` | 2020-2026 | tickets%/money% only **2024+** (~600 games) | `home_spread_pct_timestamp` | Public betting splits (tickets vs money) | Correction head: the classic sharp-vs-public divergence signal |
| `nfl_external_ratings` | 2022-2026 | `teamrankings_predictive` 2,368 rows (full weekly); `espn_fpi` 2026 only | `fetched_at` | External power ratings | Independent L1 baseline (what RUNBOOK §4.3 wanted from Elo — already ingested) |
| `nfl_game_weather_forecast_history` | 2022-2026 | ~190 games/season (~70%), mean lead 2.2 days | `fetched_at`, `lead_days` | Pregame weather **forecasts**, not observed weather | Totals; honest replacement for `game_lines.temp/wind` (observed at kickoff) |
| `nfl_officials` | 2015-2026 | full | crew announced pregame | Referee crew per game | Totals/pace (documented crew effects) |
| `nfl_ffopportunity_weekly` | 2022-2026 | 22,867 player-weeks | `source_release` | Expected fantasy points per player | Offense-side player value for availability weighting (what PFR now does for defense; RUNBOOK §4.5) |
| `nfl_ngs` | 2021-2026 | 11,991 | — | Next Gen Stats per player | Player value packets (already used for display) |
| `nfl_play_charting` | 2022-2025 | 185k plays | — | Motion, play-action, RPO, box counts per play | Team-week tendency roll-ups; aggregation work first |
| `nfl_play_formations` | 2022-2023 | 96k plays | — | Personnel/formation per play | Same; thin seasons |
| `nfl_odds_archive` | 2022-2026 | 136k | `book_updated_at` | Multi-book lines | Correction head: cross-book dispersion as a market-uncertainty feature |
| `nfl_pregame_snapshot_history` | 2026 | 4,298 | `captured_at`, `data_cutoff` | Full pregame snapshots | Forward-only; the receipt-clock source for everything above going forward |

**The two with the best ratio of new information to work, in order:**

1. **Starting QB × QBR (`nfl_depth` + `nfl_qbr_weekly`), 2021+ at full
   coverage.** The availability deficit charges a QB absence at 4.5 × snap
   share whoever the replacement is; the frozen 14 carry team EPA, which
   embeds last month's QB, not this week's. A "starting QB's prior-weeks QBR
   minus the team's season QBR" feature is the one injury effect that
   actually moves a spread by multiple points, it is point-in-time by
   construction (`captured`, `fetched_at`), and it is the natural RECIPE_V3
   for the correction head after v2's result below is read.
2. **Betting splits (`nfl_nfelo_lines`), 2024+ only.** Real, timestamped,
   and exactly the kind of market-side signal the correction head exists
   for — but ~600 games is thin, and 2021-2023 would be NaN. Additive, not
   a v3 on its own.

Then `teamrankings_predictive` as an independent L1 baseline (replaces the
plan to port Elo — it is already here, 2022+), and weather forecasts for the
totals head. Everything else on the list is real but lower ratio.

### RESULT — injuries + PFR defense through the correction head, September 15-16, 2026: no improvement, honestly measured

RUNBOOK §4.1 (step 6), executed. Built RECIPE_V2 (adds `home_availability_deficit`,
`away_availability_deficit` to the correction head, on top of RECIPE_V1's
three), wired `--availability`/`--correction-recipe` into
`unified_margin_audit.py`, and had a subagent do §2.3 (per-player PFR
defensive production replacing the flat positional weight for defenders in
`nfl-availability.js` — a productive charted defender now costs more than a
replacement-level one at the same snap share; verified its diff, re-ran its
tests myself rather than trusting the report).

**Found and fixed a real bug before trusting any of this.** The first real
run produced corrections of +2,000 to +3,000 points on several 2021 games —
obviously broken. Traced it to two compounding causes, both fixed:
1. The read-only JS extract (RUNBOOK §1.3) inserted `nfl_snaps` positionally.
   The live table's column order and the migrated schema's don't match —
   defensive snap *percentage* and defensive snap *count* were swapped, so
   `defense_pct` held raw counts (up to 100) instead of a 0-1 share. Fixed by
   inserting every extract table by column NAME, and RUNBOOK §1.3 now says so
   and verifies it (`MAX(defense_pct)` must read 1.0, not 100).
2. **New rule added to `market_correction.py`**: a correction-head feature
   with too few non-missing values in a given week's combination block (early
   2021 weeks train mostly on 2020, before any injury row exists — as few as
   ~14 real values among ~350 rows) is dropped from THAT week's fit rather
   than handed to the imputer/scaler, which was silently turning a
   near-constant, near-zero-variance column into an exploding coefficient.
   `RECIPE_V2['minimum_feature_support'] = 100`; dropped features are
   recorded per week (`correction_features_dropped_insufficient_support`),
   never silent. 2 new tests in `test_market_correction.py` (one for the
   drop-and-degrade-to-v1 path, one confirming v1's three features are never
   affected). Python suite: 123/123. Node suite (agent's PFR wiring +
   my significance-script change): 2,158/2,119/0/39.

**RESULT on the real, corrected data — 2021-2026, 111 weeks, 1,440 games:**

| Correction head | MAE | vs market (9.779) |
|---|---:|---|
| RECIPE_V1 (football + market spread + movement) | 9.9132 | +0.134, significant |
| **RECIPE_V2 (+ home/away availability deficit)** | **9.9428** | +0.164, significant |
| V2 vs V1, same games, week-clustered 90% CI | **+0.030 [-0.006, 0.071]** | **not significant** |

**Injuries and PFR defensive production, wired through the correction head
exactly as designed, made no measurable difference — slightly worse on the
point estimate, and the interval crosses zero.** This is a valid, honestly
measured result under the same predeclared rule as everything else in this
plan, not a failure to report around.

**Why, most likely — the coverage ceiling, not the wiring.** Only **43%** of
games (1,083 of 2,499 in the training window) have admissible availability
evidence at all, and only **92 of 111 test weeks** had enough non-missing
values to use the new features (19 early weeks fell back to V1's three —
2021 weeks train on 2020, before any injury row exists at all). A feature
missing on 57% of its potential rows, and absent from every training set in
the first third of the window, does not get a fair chance to show a real
effect even if one exists. This is the same coverage number flagged earlier
this session (75.2% *within* 2021-2026 for games that have SOME evidence;
43% here is lower because this window also includes 2020 training-only rows
with none at all) — it was always the predictable limit, now it's measured
against the actual outcome instead of assumed.

**What this changes:** nothing live — RECIPE_V2 stays research-only,
gated exactly like V1, correctly not promoted. What it argues for: the
"starting QB × QBR" feature identified above (full 2021+ coverage, not 43%)
is a better next candidate than iterating further on injury coverage that
is capped by the source data, not by this wiring.

### RESULT — starting-QB-quality through the correction head (RECIPE_V3), September 16, 2026: also no improvement, and the full stack is measurably worse than doing nothing

RECIPE_V3 built (agent-built, verified: `server/services/nfl-qb-quality.js`,
`scripts/export-qb-quality-features.mjs`, threaded through
`market_correction.py`/`unified_margin_audit.py` exactly like V2). Export
against real 2018-2026 data: **56.5% coverage** (1,413 of 2,499 games) —
real signal, well above injury's 43%, confirming the coverage argument
above. (One bug caught before trusting this: my own scratch extract never
included `nfl_depth`/`nfl_qbr_weekly`, so the first export came back at 0%
coverage — fixed by adding those two tables to the extract, same
named-column-insert discipline as the earlier `nfl_snaps` fix.)

**Real 2021-2026 result, 111 weeks, 1,440 games:**

| Correction head | MAE | vs its immediate predecessor |
|---|---:|---|
| V1 (football + market spread + movement) | 9.9132 | — |
| V2 (+ availability deficit) | 9.9428 | +0.030 vs V1, CI [-0.006, 0.071], **not significant** |
| **V3 (+ starting QB QBR)** | **9.9583** | +0.016 vs V2, CI [-0.011, 0.043], **not significant** |
| **V3 vs V1 directly (same games)** | | **+0.046, CI [0.0005, 0.0968], significant** |

**CORRECTION, September 16, 2026 (later the same day):** the "significant"
verdict below did not apply the multiple-comparisons correction this
project's own tooling (`trial-statistics.js`) exists for. Three comparisons
were run on these recipes this session (V2 vs V1, V3 vs V2, V3 vs V1);
Bonferroni for 3 tests needs the equivalent of a ~98.3% CI, not 90%. V3 vs
V1's 90% CI barely excludes zero (0.0005 to 0.097) and does not survive
widening to that level. **Corrected conclusion: V1, V2, and V3 are not
statistically distinguishable from each other once corrected for the
number of comparisons already made.** The feature-creep *explanation*
(the exploding `away_availability_deficit` coefficient) is still real and
still the right read on why V3 didn't help — that finding doesn't depend on
this significance test — but the claim "V3 is significantly worse than V1"
specifically should be treated as unconfirmed, not established. See "The
multiple-testing guardrail" section below for the fix going forward.

**Neither addition individually proved harmful, but the full stack is.**
Each step (V1→V2, V2→V3) is, on its own, statistically indistinguishable
from noise — that's the same "no evidence of improvement" honest-null
result as before. But comparing the endpoints directly, V3 is significantly
worse than the plain three-feature V1 (barely — the interval's lower bound
is 0.0005, a hair above zero, but it's real). **This is the signature of
correction-head feature creep, not of either feature being individually
bad**: the combination block's sample size hasn't grown as its column count
has, so a 5-feature ridge on the same weekly data has more room to fit
noise than a 3-feature one did, even with the `minimum_feature_support`
guard (which protects against too-few-values-per-column, not against
too-many-columns-per-row-count generally).

**What this argues for, concretely:** stop stacking more columns onto ONE
correction-head ridge. The three data sources identified in "Data already
in the house" above (`nfl_nfelo_games`/`nfl_nfelo_qb`, `nfl_external_ratings`,
and the `nfl_verified_events` injury-timing investigation) are being wired
as **separate, independently-audited JS ensemble challenger components**
instead — each measured on its own against the market and its own base, the
way `market_correction_research` was, not folded into this same ridge as a
sixth, seventh, eighth feature. Status: build in progress, September 16,
2026 — see the next entry for results once measured.

**Status per protocol: RECIPE_V3 remains an unwired research candidate,
same as V1 and V2.** No betting authority, nothing live changes.

**Rule that applies to all of it:** same as `market_correction.py` — a new
source is a new *feature on the correction head* or a new *challenger-only
component*, never a new entry in the frozen 14 without a fresh
`feature_names` contract, measured by RUNBOOK §3.1/§3.2 against the market
and its own base, week-clustered, before it touches anything live. Coverage
numbers above are the denominators those measurements will report.

## DATA INTEGRITY MASTER PLAN — September 16, 2026

**Why this section exists.** Nick's own words: "Most of this project should
be data integrity — your agents need to find the weaknesses and attack
them," and, usage-constrained for this session, asked for a durable plan
rather than more live execution. This section is that plan: where things
stand (verified), what a football game actually has and doesn't have in
this database, the honest ML-technique assessment, the overfitting
guardrails already built vs. still needed, and a prioritized, resumable
roadmap. Everything below is either already measured this session or
explicitly marked as not yet done — nothing here is aspirational dressed up
as fact.

### Where things stand right now — verified, both suites green

Node: **2,173 tests / 2,134 pass / 0 fail / 39 skipped.** Python: **127/127.**
Catalog **35** components, **21** challengers, **14 live** (the live count
is unchanged through all of today's pruning and additions — every
component added today is a challenger, and every one retired today became
a challenger; only the composition of "measured but not live" changed).

| What | Result |
|---|---|
| Correction head V1 (football+market+movement) | MAE 9.913 vs market 9.779 (+0.134, significant loss) |
| V2 (+availability/PFR defense) | 9.943, +0.030 vs V1 — **not significant** |
| V3 (+starting QB QBR) | 9.958, +0.016 vs V2 — **not significant**; but **+0.046 vs V1 directly — significant** (feature-creep, diagnosed at the coefficient level: `away_availability_deficit` got a bigger standardized weight, 2.62, than the market line itself, off 310 combination rows) |
| Effective rank (32-model catalog, market-residual space) | 2.518 → 2.564 after fixing a corrupted extract; 12 of 29 measured components >95% redundant |
| Pruning | 8 of the 12 redundant components retired from live blend (4 already were); live-blend sanity re-verified on real data post-prune (weights renormalize to ~1, no NaN, sane forecast on a real game) |
| `nfl_verified_events` (injury timing) | Investigated, **rejected** — verified independently to be a duplicate of `nfl_injuries` with the same broken 2025-26 timestamps, plus a silent 2x duplication bug via `archive_version` |
| `nfelo_rating` / `nfelo_qb_adjustment` | Built, wired as live-DB reads (`nfelo.js`'s existing `nfeloFeatures()`, already synced into this app's own schema — no external DB dependency), verified real values on real 2025 data (1.81 / -0.021) |
| `teamrankings_predictive` | Built, wired via a precomputed lookup, verified real values on real 2025 data |
| All three new signals | Registered as **challengers only** — computed and graded, structurally excluded from every live pick until they clear RUNBOOK §6's promotion gate. None promoted. None have been measured against the market yet — that's the very next step, not done. |

### NEXT MAJOR TASK — the full research + GitHub gap analysis — **DONE September 16, 2026.** Results: "DATA SOURCES, ENDPOINTS AND LINEAGE", "GAP ANALYSIS", and "FINAL ORDER" sections below the roadmap. The text under this heading is kept as the record of what was asked.

Nick's instruction, verbatim in intent: we have not yet actually looked at
the GitHub repos. When usage returns, before the mining spree in the
roadmap below starts, do one deliberate pass that reads the research corpus
in full and compares it against the current model as it actually stands —
a gap analysis that decides whether this plan needs total restructuring or
only the incremental updates it has been getting. Tonight's plan is the
contract; execution follows it; the gap analysis is what confirms the
contract is the right one before weeks of work go into it.

**What has and hasn't been read so far — honest count:**
- Read in full this session: `FIX_AND_ADD_ARCHITECTURE.md` (the 59 KB
  master synthesis of all 56 notes) and `F15-team-strength-shrinkage.md`.
  Both produced concrete corrections to this plan (FIX #14's file location,
  the shrinkage variant, the GAS model, the DSR input-standardization
  caveat) — evidence that the rest of the corpus will too.
- Referenced but NOT yet read in full: `GITHUB_BUILD_CATALOG.md` (47 KB —
  every repo, split fix/new, with a "build from this now" shortlist and an
  avoid list), the 10 `GF` code catalogs, the 10 `GN` code catalogs, the 18
  `N` new-capability notes, the other 17 `F` notes, and the actual source
  papers (Glickman/Stern, Koopman & Lit ×2, Szczecinski-Tihon Kalman,
  Lopez/Matthews/Baumer, the Diebold-Mariano trio, the conformal set, the
  RL-trading surveys). Section E near the top of this plan lists six GitHub
  repos "in pull order" — that list was compiled from the catalog's summary
  lines, not from reading the catalog or the repos.

**What the gap analysis must do, specifically:**
1. Read `GITHUB_BUILD_CATALOG.md` end to end; for every repo on its
   "build from this now" shortlist, check whether the equivalent capability
   already exists in this codebase (this session found three cases —
   `nfelo.js`, the feature-vector tables, the player-week engine — where
   something was already built and simply not connected; the catalog's
   shortlist will almost certainly contain more of those), and whether the
   catalog's "avoid" list contradicts anything currently on the roadmap.
2. Read the 17 unread `F` notes the same way `F15` was read: each one
   names live files and line numbers; verify each claim by grep against
   the current tree (the tree has moved since September 12 — this session
   alone found one file-location error and four "already done" items in the
   8 it checked), and record done / open / wrong-file for every item, the
   way the reconciliation table above does for 8 of ~64.
3. Read the `N`/`GN` notes against the "not worth doing at this data
   volume" verdict in `FIX_AND_ADD_ARCHITECTURE.md` §(a) — that verdict
   matches this session's own V3 evidence exactly, but the notes may name
   specific small pilots (the doc mentions a Chronos/TimesFM zero-shot
   cold-start job as "the cheapest candidate in the whole N01 chunk") that
   are cheap enough to test without violating it.
4. Read the sports-betting-model-architecture material — the
   `FIX_AND_ADD_ARCHITECTURE.md` §(f) diagram, `F18-audit-architecture-
   consolidation.md`, `F02-forecast-combination.md`, and the source papers
   on rating systems and forecast comparison — and lay it next to the
   current model as documented in "MODEL INVENTORY AND ORGANIZATION" and
   "Where things stand right now" above. The question is structural: is the
   current shape (frozen-14 football model → ridge correction head → JS
   ensemble joint fit → market_residual gate → market verbatim) the shape
   the research says a betting model should have, or is it five disagreeing
   copies of one idea with a good audit on top? Answer it with file names.
5. Deliverable: a dated section in this plan titled "Gap analysis —
   research vs. current model" with (a) every research item marked done /
   open / wrong / superseded, (b) an explicit verdict on whether the roadmap
   below stands, gets re-ordered, or gets replaced, and (c) any corrections
   to earlier sections of this plan, made in place with the same
   "CORRECTED <date>" convention used throughout. Nothing in the data
   inventory, the audit-validity findings, or the RESULT sections gets
   removed by this pass — those are measured facts; the gap analysis
   revises what to do about them, not whether they happened.

This is a reading-and-verification pass over ~70 documents plus a live
tree, with a synthesis at the end — a reasonable candidate for a
multi-agent workflow (parallel readers, one per note family, each
verifying by grep, then one synthesis) once usage allows, with the
synthesis and the in-place plan corrections done by the main session,
not delegated.

### What a football game HAS in this database right now

Point-in-time safe (decision_at / cutoff-respecting): closing + opening
market spread and total (100% / 98.2%, 2021-2026), team-level EPA/efficiency
(`nfl_team_week_features`, 2016+), player-level offensive EPA/usage
(`nfl_player_week_features`, 52,544 rows, 2016-2026), player-level defensive
production (`nfl_pfr_adv`, 2024+ only, now wired), snap shares (`nfl_snaps`,
2021+), injury report severity (`nfl_injuries`, 75% coverage 2021-2024, 43%
extended, unreliable 2025-26 timestamps), starting-QB identity + QBR history
(`nfl_depth`+`nfl_qbr_weekly`, 56.5% coverage, now wired), an independent
Elo rating + QB adjustment (`nfelo_games`/`nfelo_qb`, 100% populated
2020-2026, now wired), an independent power rating
(`teamrankings_predictive`, full 2022+, now wired), rest days and division
familiarity, observed kickoff weather (`game_lines.temp/wind`), referee
crew identity (`nfl_officials`, full 2015-2026, **not yet turned into a
feature**), 10-11 sportsbooks' worth of line history and cross-book
dispersion (`nfl_odds_archive`/`nfl_line_snapshots`/`nfl_quote_tape`, full
tick-by-tick, **captured for bet-execution/CLV purposes only — 0% reaches
forecasting**), and pregame weather forecasts (not observed — a genuinely
different, untried signal, `nfl_game_weather_forecast_history`, ~70%
coverage 2022+).

### What a football game does NOT have — the real gaps, not assumed

- **No cross-book market structure in any forecast.** Every number the
  correction head or audit has ever seen is one closing spread and one
  opening spread from `game_lines`. The 10-11-book dispersion, and the full
  line-movement trajectory (not just two points), have never been computed
  as a feature. This is the single largest untapped, already-owned dataset
  identified this session.
- **No totals-specific signal of any kind.** Every experiment this entire
  session — correction head, availability, QB quality, nfelo, teamrankings
  — is margin-only. The over/under side of this system has had zero
  dedicated attention. Weather forecasts and referee tendencies (below)
  would both land here.
- **No player-level defensive production before 2024.** `nfl_pfr_adv` starts
  2024; 2021-2023 defenders are still valued by flat positional weight only.
  Not fixable without a paid source (PFF) or accepting the era split.
  Documented, not solved.
- **No genuine point-in-time injury severity for 2025-2026.** `nfl_injuries.
  modified_at` is null for the entire current era; `nfl_verified_events` was
  checked and confirmed NOT a fix (see above). This is an upstream nflverse
  gap, not something more engineering here can close.
- **No referee-crew tendency feature**, despite having the raw data
  (`nfl_officials` names every crew, every game, full history). This needs
  feature engineering (crew-level historical ATS/total rates from our own
  `game_lines`), not new data — an internal derivation task, cheap.
- **No rookie-specific evaluation signal.** `nfl_rookie_evidence` exists but
  is thin; combine/draft-pick data (`nflreadr::load_combine()`/
  `load_draft_picks()`, confirmed free, not yet ingested) would directly
  feed it. A rookie starter is currently valued identically to a
  10-year veteran at the same position.
- **Correction to an earlier claim in this section:** `nfl_ffopportunity_weekly`
  is NOT fully unused as stated above — `player-week-engine.js` reads it via
  `priorFfOpportunity` for player props/fantasy. It is unused by the
  margin/injury pipeline specifically, not system-wide.
- **The player-props engine's per-player value estimate never reaches
  availability weighting — the biggest real cross-wiring opportunity found
  this session, and it needs zero new data.** `player-week-engine.js`
  already runs a structural volume×efficiency simulator per player-week,
  updated by a frozen Bayesian ensemble on real outcomes, with role-
  changepoint detection and news signals — a genuinely sophisticated,
  already-built per-player value model. `nfl-availability.js`'s injury
  weighting, meanwhile, still uses a flat snap-share × position-weight
  formula (the same one PFR data upgraded for defenders this session).
  Rather than building the roadmap's planned "empirical replacement level"
  model from scratch (nflWAR method, RUNBOOK.md §4.5), reuse this existing
  engine's own player-value output as the weight instead. Two fully-built
  systems that don't talk to each other; connecting them is integration
  work, not a new model or new ingestion. **Concrete step-by-step plan
  written: RUNBOOK.md §4.1b.**
- **No roster-investment/cap-allocation signal.** `nflreadr::load_contracts()`
  (confirmed free, not yet ingested) — a proxy for roster quality/depth
  independent of on-field stats seen elsewhere.
- **No play-calling-tendency team-week rollup**, despite owning the raw
  data. `nfl_play_charting` (FTN data via nflverse, 2022-2025, motion/PA/RPO/
  box counts per PLAY) has never been aggregated to a team-week feature —
  this is an aggregation task on data already in the house, not a new source.
- **No player tracking/positional data at all.** The NFL's own Big Data Bowl
  releases real tracking data (free, via Kaggle) but only for specific
  weeks/seasons per competition year (2023-2024 in the current release) —
  real signal, genuinely low coverage, a longer-term research item, not a
  quick win.
- **No permanent visibility into what any fitted model actually learned.**
  Fixed once, by hand, this session (the correction-head coefficient dump
  that found the feature-creep bug) — not yet made a standard part of any
  saved report. Real, cheap fix, not yet built.

### Is the ML technique the problem? Honest answer: no, evidence says the constraint is data volume per fit, not algorithm sophistication

Measured, not asserted: LightGBM (materially more expressive than ridge)
barely beat plain ridge on identical features — 10.678 vs 10.675. That is a
direct test of "does a fancier fitting algorithm help," run on real data,
answered no. The correction head's own exploding coefficient
(`away_availability_deficit` at 2.62 standardized weight, larger than the
market line itself, fit on 310 rows) is the same story from a different
angle: more expressive models and more parameters both fail for the same
reason — not enough weekly data per parameter to estimate it reliably. A
neural network would very likely do the same or worse on this data volume;
that is not a hunch, it is the same bias-variance arithmetic that produced
the numbers above.

**The one ML technique gap that IS well-targeted, not tried — CORRECTED
September 16 after reading F15 in full.** The earlier version of this
paragraph recommended "hierarchical/Bayesian shrinkage" generically. The
research is more specific, and the generic version is the wrong one: Brown
2008 (real MLB data, six methods head-to-head) found the naive single-unit
normal-normal empirical-Bayes update — the class `nfl-preseason-blend.js`
already implements, and what "add a Bayesian prior" would naively mean —
was among the **worst**-performing shrinkage methods tested, barely beating
a crude group mean (error ratio 0.902 vs naive 1.0), while James-Stein
(0.525) and method-of-moments EB (0.593) roughly halved the error. What
works is **multi-unit, cross-sectional shrinkage toward a jointly-estimated
grand mean** — Stein's theorem needs N≥4 units pooled together, and the
gain comes from the pooling, not from the prior. NFL-specific: Ragain et
al. 2018, real 2016 NFL data, 16.8% out-of-sample MSE reduction, largest
where the schedule graph is sparse — ours. Two places this applies:
- **Team strength (`nfl-preseason-blend.js`'s `blendedTeamRating`)** — the
  correct single-unit math is already there; add the cross-sectional
  pooling across all 32 teams in the current season. This is FIX #14's real
  target (see the corrected reconciliation row above) and the foundation the
  correction head's football input stands on.
- **The correction head's own coefficients** — the diagnosed failure
  (`away_availability_deficit` at 2.62 standardized weight off 310 rows) is
  a small-sample instability that method-of-moments EB / James-Stein-style
  shrinkage of the coefficient vector addresses directly; plain ridge with
  `alpha=1.0` (the weakest grid value, chosen by inner-CV on 310 rows)
  failed to. Same technique, second target. Not yet built in either place.
Also from F15: `shrinkage-fit.js` already implements the correct
method-of-moments fitted-k machinery for the fantasy side — reuse it, do not
add a seventh hand-rolled formula (see the six already found, in the
reconciliation section above).

**Also not tried, lower priority given the above:** a distribution/quantile
head (NGBoost/MDN, `GN06-mixture-density-neural-code.md`) for the interval
estimate instead of split-conformal; and for the totals side, the
score-driven (GAS) dynamic bivariate Poisson/Skellam joint-scoring model —
see the paradigm section below, where it is scoped properly, and the older
"Advanced research backlog" table further down, whose "Discrete joint score
model" row is the same idea under a different name.

### The multiple-testing guardrail the mining spree needs BEFORE it starts, not after — September 16, 2026

Nick's own question ("does this make beating MAE easier") surfaced a real
gap: this session's roadmap now queues dozens of new candidate signals
(travel, surface, coaching, PFR pass/rec, ~2,670 vector-table features,
reverse line movement, key-number distance, and more). **Testing more
candidates increases the rate of false positives, not just the odds of a
real find** — if 20 things are tested independently at the usual p<0.05
bar, roughly 1 will look "significant" from chance alone. Every signal
this session has been tested correctly ONE AT A TIME against that bar; the
gap is that nothing yet corrects for the GROWING NUMBER of tests taken as
a whole.

**CORRECTED September 16 after cross-checking against the plan's own older
sections.** The first draft of this paragraph said the fix was to wire up
`server/services/trial-statistics.js` (`effectiveTrialCount`,
`deflatedSharpeRatio`, `probabilityOfBacktestOverfitting`) as the guardrail.
That contradicts a decision this plan already made and I had not yet read:
the "A newly confirmed audit issue" section far below documents that the
pipeline currently feeding that module (`scripts/run-purged-evaluation.mjs`)
mixes ROI, probability errors and point errors into one sequence without
standardizing them to comparable units, and never establishes the
dependence among competing forecasts on the same games — so its
`effective_n_trials` and the DSR built on it are **not trustworthy as they
stand**, and the plan's standing decision is: "do not use the discounted
trial count or reconstructed returns to justify promotion... use a
conservative declared-family correction until a better justified
dependence-aware procedure is ready." That decision holds. So:

- **The guardrail for the mining spree, now:** a plain declared-family
  correction (Bonferroni/Šidák over the number of comparisons actually run
  on a given candidate family), applied by hand, exactly as was done once
  today to walk back the V3-vs-V1 "significant" claim. Keep a written count
  of comparisons per family as they are run — the count is the input, and it
  cannot be reconstructed afterwards.
- **DSR/PBO input standardization** is its own separate, still-open
  prerequisite — aligned per-game/per-week losses in one unit, plus a real
  dependence estimate across candidates on the same games — before that
  module can be trusted for anything beyond a diagnostic. Not a wiring task;
  a fix to what it is fed.
- **The end state the research (F06/GF10, FIX_AND_ADD #30-#31) specifies,
  which this plan's WP11 already points at:** one append-only,
  content-addressed trial registry (`research_studies` /
  `research_trials` / `research_trial_corrections`), a DB-enforced
  `scored_at >= declared_at` rule via BEFORE UPDATE/DELETE triggers (so a
  rerun can never overwrite an unfavorable earlier result), and
  `dsr_method`/`multiplicity_method` as explicit enum columns so two
  disagreeing formulas cannot silently coexist. The five ad hoc
  `preregistered.json`/`report.json` labs (including the unified-margin
  audit built this session) are the inputs that registry would unify.

**This should be applied as candidates from the roadmap above start getting
tested — not retrofitted after several have already been declared
winners.**

**Two more real audit gaps, found by checking the audit's own methodology
rather than just its results:**

- **The correction head's own prediction interval has never been checked
  for calibration.** `report.json['interval_coverage']` is computed from
  `UnifiedMarginModel.describe()`'s interval (the football-only model),
  measured at 80.0-80.3% against its nominal 80% — genuinely checked. The
  correction head has its own `describe()`-generated `interval_80`
  (`market_correction.py`), and nothing in `unified_margin_audit.py`
  currently measures whether THAT interval is honest. We have verified MAE
  for V1/V2/V3's point predictions and never once checked their stated
  uncertainty. Fix: add a correction-head-specific coverage check to
  `run()`, the same shape as the existing one, before trusting any
  future correction-head recipe's calibration claim.
- **No diagnostic group exists for any of the new hypotheses.**
  `DIAGNOSTIC_GROUPS` (season phase, divisional, dome, rest advantage,
  market-level) predates this session's new signals. A real travel effect,
  averaged over every game including the 90%+ that involve no meaningful
  travel, can wash out to nothing in the aggregate MAE even if it's genuinely
  working on the games it should matter for. Before testing travel/coaching-
  change/surface signals, add matching diagnostic groups (e.g.
  `cross_country_travel`, `new_head_coach_first_season`,
  `surface_change_from_prior_home_game`) so a real, narrow effect has a
  chance to show up instead of being diluted into the headline number.

**Distinct from the above, restated because it matters more than any single
technique: even a real, correctly-significant MAE improvement is not
profit.** Every audit result this session carries, and will keep carrying,
the same limitation: `market_spread` is a stored closing line, not a
verified decision-time executable quote (`authority: research_only`
everywhere, deliberately). Beating MAE with statistical rigor is a
necessary condition for eventually mattering; it is not sufficient. Closing
that gap needs a real executable-quote capture at decision time, a vig-
adjusted profitability calculation (not just MAE), and survival of the edge
once a book can react to it — none of which is what the current roadmap
builds, and none of which should be implied by a good MAE number alone.

### Overfitting guardrails — what's already enforced, and what's still needed

**Already built and proven this session, not just claimed:**
- Out-of-fold stacking discipline (the correction head's football prediction
  never sees the game it corrects; proven by mutation tests, not asserted).
- Week-clustered block bootstrap for every significance claim, one
  implementation only (`pairedBootstrapDiff`), never a second one to drift.
- Preregistration before results exist, code-identity hashed at process
  start, an enforced accounting invariant (`check_accounting`) — all added
  this session after finding the audit itself had gaps.
- `minimum_feature_support` — a feature with too few non-missing values in a
  week's combination block is dropped from that week's fit and recorded,
  never silently imputed into an exploding coefficient. Built this session
  after it caused a real +2,000-point blowup.
- Effective-rank monitoring (participation ratio, entropy rank) as a
  standing check against ensemble bloat, not a one-time measurement.
- The challenger/live gate itself: nothing new touches a real pick without
  clearing RUNBOOK §6, structurally enforced (`blendEligible`), proven by
  byte-identical-output tests, not by convention.

**Still needed, concretely:**
1. **A feature-to-sample-size ratio gate**, generalizing
   `minimum_feature_support`: today it guards one column at a time; it does
   not stop a recipe with many columns individually well-supported but
   collectively too many for the row count (the actual V3 failure mode).
   Concretely: refuse to add a correction-head feature if
   `combination_rows / feature_count` falls below some floor (a reasoned
   starting point: 30-50 rows per parameter, a common rule of thumb for
   linear models — pin an exact number before implementing, don't guess one
   into the code silently).
2. **The hierarchical-shrinkage prior above** — this is itself an overfitting
   guardrail, not just an accuracy experiment.
3. **A standing pre-promotion checklist**, written down once rather than
   re-derived per signal: out-of-fold proof, week-clustered CI excluding
   zero vs both the market and the signal's own base, byte-identical
   live-exclusion test, minimum sample size met. Every signal this session
   already does this ad hoc; formalize it as a template new signals copy.

### The recurring data-integrity audit — turning this session's bug list into a standing agent checklist

Every real bug found this session had a specific, recognizable shape. Turn
each into a checklist item a dispatched agent runs periodically against the
live database (read-only) and the extraction pipeline, rather than relying
on a human noticing again by accident:

1. **Schema drift / column-order mismatch.** The exact bug that corrupted
   `nfl_snaps` this session (live table's column order ≠ migrated schema's
   order, positional INSERT silently swapped two columns). Checklist: for
   every table an extract or ETL touches, insert by column NAME, never `*`,
   and diff `PRAGMA table_info` between source and destination before
   trusting a fresh extract.
2. **Single-batch-timestamp detection.** Caught twice this session
   (`nfl_feature_revisions`' 20 rows sharing one timestamp; `nfl_verified_events`'
   `created_at` showing a two-day bulk write). Checklist: for any table whose
   value depends on a "when did we learn this" claim, check
   `COUNT(DISTINCT <timestamp column>)` against row count — a ratio near
   zero means the timestamp is a write-time artifact, not a receipt clock.
3. **Silent duplication via a version/archive tag.** Caught in
   `nfl_verified_events` (`archive_version` doubling every 2022-2024 row).
   Checklist: for every table with more than one row per natural key
   (season/week/team/player), check for a tag column and confirm dedup
   before counting or joining.
4. **Coverage-over-time regression.** Checklist: re-measure every signal's
   coverage percentage on a schedule; a source that used to update and
   stopped (like `nfl_injuries.modified_at` after nflverse dropped it) looks
   identical to a healthy source until someone checks the trend, not just
   the current snapshot.
5. **Unused-table sweep.** This session's single biggest source of new
   ideas was literally listing every `nfl_*` table and checking who reads
   it. Re-run that sweep periodically — new tables get ingested for one
   purpose (display, audit, execution) and then sit unused by forecasting
   for months, exactly as `nfelo.js`, `nfl_pfr_adv`, and `nfl_depth` all did
   before this session.
6. **Duplicate-formula sweep (added September 16 from F15).** The same
   computation re-implemented in several places with disagreeing math is
   this codebase's most-repeated structural defect — 5 CLV calculators
   (fixed), 37 content-addressing hashers (open, FIX #32), and now **6+
   hand-rolled shrink-toward-prior formulas** with hardcoded unfitted `k`
   (`nfl-context-heads.js:39`, `nfl-opponent.js:31`, `nfl-expert-council.js:117`
   k=30, `nfl-rookies.js:364` k=80, `nfl-props-replay.js:127` k=4,
   `draft-assist.js:995`), none routed through `stats-util.js`'s canonical
   `shrink`/`shrinkRate` or `shrinkage-fit.js`'s fitted k. Checklist: for
   any named statistical operation (shrink, hash, CLV, devig, key match),
   grep for every independent definition, count them, and route all of them
   through the one tested implementation before adding another. The
   companion JSON-blob check (item in the "same pattern" section below)
   covers data; this one covers code.

### LEAK FOUND while classifying inputs for the opener-CLV test (September 16, 2026): `weather_total` reads post-game weather

`nfl-ensemble.js`'s `weather_total` component adjusts its total using
`c.temp`/`c.wind`/`c.roof`, which `buildContext` reads from
`game_lines.temp/wind/roof` (nfl-ensemble.js:67). Those columns are written
by `gamescript.js` from nflverse `games.csv` (gamescript.js:23, :91) — and
nflverse's `temp`/`wind` are the **observed conditions at kickoff, populated
after the game**. So a pre-game total forecast is being adjusted with the
weather that actually happened. That is a look-ahead leak in a LIVE
component, not a timing subtlety, and it flatters every historical
evaluation `weather_total` took part in.

The repository already owns the correct input:
`nfl_game_weather_forecast_history` (pre-game forecasts with their own
capture times), which the roadmap's FINAL ORDER #16(b) planned to use for a
weather×pass-rate interaction. The fix is to feed `weather_total` the latest
forecast captured before the game's cutoff and refuse (not default) when
none exists, then re-measure the totals path. **Recorded here, not fixed in
this pass** — it is a totals component and does not touch the spread
measurement in flight; it belongs at the front of the totals work in FINAL
ORDER #16. Registry `known_failures` for `component:weather_total` carries
this. Recurring-checklist class: content clock mistaken for a receipt clock
(the same defect migration 052 fixed for `nfl_line_snapshots`).

### PREREGISTERED — the opener-CLV measurement (September 16, 2026, written BEFORE results were seen)

Nick's reframe, after four FINAL ORDER items each ended in "nothing beats the
closing line": *we have been grading against the wrong exam.* Nobody bets
into a closing line. The professional test of a bet is whether the line
moved TOWARD you after you took it (closing-line value, CLV), and CLV is
continuous, so it resolves in hundreds of games where win/loss needs
thousands. This section declares the analysis before the numbers exist, per
RUNBOOK §0a rule 4.

**Question.** Do any of our existing forecasters, fed only what a bettor
sees at bet time, capture positive CLV against the opening spread on
2022-2025 — pooled, week-clustered, multiplicity-corrected?

**Configuration (honest by construction; each line closes a leak):**
- Ensemble: `ensembleLine(season, week, …)` fits at that game's own cutoff.
- `blendMode: 'raw'`, never `market_residual` — the residual blend returns
  the CLOSING market verbatim whenever the joint gate fails, which it does.
- `marketOverride: {home_spread: open_spread, total: open_total}` — every
  component that reads the market (market_anchor, market_regression) sees
  the OPENER. Verified on the smoke test: `market_anchor` predicted 3.0 for a
  game that opened −3 and closed −4.
- Drive sim: prior-season profiles, `spread: open_spread`.
- Neutral-site games excluded.

**Forecasters in the family, and the inventory that produced it** (Nick:
"make sure we are using all of our models"):

| forecaster | source | honest vs opener? |
|---|---|---|
| ensemble_raw_blend | nfl-ensemble.js | yes |
| ~35 individual components | `ensembleLine().models` | yes, except `market_correction_research` (below) |
| drive_sim | nfl-drive-sim.js | yes |
| python_football (Stage 3) | unified_margin_audit predictions.json, OOF | yes — stage3 states market_spread NEVER enters |
| python_unified (football blend) | same file | yes — unified_model.py has no market reference |
| lineup_roster | recomputed from teamRosterStrength + gamePlayerAvailability + gameInjuryCarryover | yes — the family's market term cancels algebraically |
| ~~python_correction~~ / ~~component:market_correction_research~~ | market_correction.py | **NO — contaminated by construction.** Its features are `['football_prediction','market_spread','market_movement']`: it is handed the close and the opener-to-close move. Graded and shown struck through; excluded from the corrected family. |

**Not gradable on 2021-2025, and why** (so nobody re-discovers this):
expert council — `nfl_expert_forward_predictions` has 3,633 rows, all season
2026; a forward-capture system with no historical record (its `game_replay`
and `player_builder` experts are the drive sim and lineup model, graded
directly). Online neural — a market-residual learner trained only on those
same forward captures; cold-start for any historical game. Unified engine —
ensembleLine(market_residual) + sim at the CLOSING spread; a combiner of
things graded here, fed the answer key.

**Data-integrity finding, recorded before it could flatter anything:** all
openers come from nflverse `initial_lines.csv`, but **2021's are not
trustworthy** — mean |open−close| 3.0-5.6 points in weeks 7-18 with maxima
of 12-15 points, against 1.1-1.8 in every other season. A 15-point
opener-to-close move is not a market move. **2021 is reported per-season and
NEVER pooled.** Checklist item 2 (stale/batch clocks) caught it.

**Metric and inference, declared:** primary = mean CLV points (clv-core's
`signedClvPoints`, backed-side perspective), pooled 2022-2025, SE clustered
by (season, week), two-sided p. Secondary = CLV direction rate, ATS vs the
opener (break-even .5238), and all three binned by |lean| ∈ [0,1) [1,2) [2,3)
[3,5) [5,∞) for the selective-bet question. **Family for Holm = every
non-contaminated forecaster graded**, ~40 tests. **Nothing is cited from this
measurement unless it is positive on mean CLV AND survives Holm.** A null is
a valid completion.

**AMENDMENT, same evening, before full results (dated so it cannot be
mistaken for the original declaration):** opener-CLV has a timing subtlety
the declaration above did not spell out. The opener is posted ~Sunday
night/Monday; the close incorporates everything learned through kickoff. A
forecaster whose inputs are IN-WEEK (Friday's injury report, verified news,
the weather forecast) will show opener-CLV simply by knowing what the opener
could not — and that is NOT a tradable edge at the opening number, because
by the time that information is public the line has already moved. Only a
forecaster whose inputs were knowable AT THE OPENER (prior-week ratings, EPA
through week N-1, a pre-week Elo) can claim its opener-CLV as edge.
Therefore every forecaster will be classified by input timing
(prior_week / in_week / mixed) before results are read, and **only
prior_week forecasters may be cited as edge**; in_week ones are reported as
"line-move prediction", a different and less valuable thing. This
classification is being done from code now, ahead of the numbers.

**Scripts:** `scripts/opener-clv-measurement.mjs` (pass 1: ensemble, components,
sim — hours), `scripts/opener-clv-pass2.mjs` (Python + lineup — minutes),
`scripts/opener-clv-summarize.mjs`. Rows and summary land in
`docs/evidence/2026-09-16/opener-clv/`. Results will be appended BELOW this
line, dated, never edited into the declaration above.

### RESULTS — the opener-CLV measurement (September 16, 2026, appended below the declaration; nothing above was edited)

**Answer to the preregistered question: yes — a small, real, one-signal edge
at the opener exists in the prior-week efficiency models. It is not
explained by home drift or favourite drift, it is positive in every season
2022-2025, and it survives Holm. It is also worth roughly a third of a point,
which is not enough to beat the vig as a flat strategy.** Full tables:
`docs/evidence/2026-09-16/opener-clv/summary.md` (2022-2025) and
`summary-2022-2023-2024.md` (conservative). Raw rows: 2,740 games.

**The conservative headline (2022-2024 only, home drift netted out, Holm
across the 28-forecaster edge-eligible family):**

| forecaster | n | adj CLV pts | z (wk-clustered) | p Holm | CLV when backing AWAY |
|---|---|---|---|---|---|
| component:second_half_eff | 817 | +0.270 | 3.71 | .0056 | +0.14 |
| component:opp_adjusted | 817 | +0.223 | 3.58 | .0081 | +0.12 |
| component:dynamic_state | 817 | +0.189 | 3.32 | .0234 | +0.07 |
| component:epa_net | 817 | +0.195 | 3.17 | .0375 | +0.07 |
| component:series_sustain | 817 | +0.203 | 3.11 | .0432 | +0.08 |

Five survive. Nothing else does on 2022-2024 alone — **not the drive sim
(+0.11, z 1.5) and not the Python football model (+0.11, z 1.75).**

**Why the first read was wrong, and what killed the artifacts.** The raw
table had 24 of 28 forecasters positive — the signature of a common factor.
Two were tested through the same grader as zero-information baselines:
- *Favourite drift*: backing the opener favourite earns 0.00 CLV pooled. Dead
  (and it flips sign by season: −0.14 in 2022-24, positive in 2025).
- *Home drift*: **the line moves +0.185 toward the home team between open and
  close** (+0.126 on 2022-24). "Always back home at the opener" earns that
  with zero skill, at 51.3% ATS. Many components add home-field, so they
  inherit it. This is real market microstructure and is now a permanent
  baseline row in the summary.
The survivors are NOT the drift: they back home and away ~50/50, and every
one earns positive CLV when backing the AWAY side against the drift (last
column). `clv_home_adjusted` — excess over always-backing-that-side — is what
the Holm p is computed on.

**It is one finding, not five.** The five agree on which side to back 70% of
the time pairwise (effective rank ≈ 2.5 across the whole ensemble, measured
Sept 15). Read it as: *the opening line is slow to fully price last week's
team efficiency; the close catches up.* Five representations of one signal.

**What it is worth.** ~0.2-0.3 points of closing-line value. With a margin
SD of ~13.5, a point of line is worth ~3 percentage points of cover
probability, so this is ~+0.7-1.0 points of cover rate: ~51%, against a
52.38% break-even at −110. The observed ATS-vs-opener of 0.49-0.52 matches
that arithmetic exactly. **As a bet-every-game strategy it loses to the
vig.** Where it could become money is a different, unmeasured claim (below).

**2025 is real but inflated, and stays out of the headline.** Pooling 2025
lifts the survivors to +0.33-0.39 and adds six more (11 total), and
python_football enters. All five seasons come from the same nflverse file
and the same two fetch batches, so this is not a live-capture artifact — but
2025's openers move 1.84 points on average against 1.1-1.3 in other
seasons, with week-level means of 4.1 (wk 2), 5.5 (wk 8) and 3.3 (wk 15):
the same stale/look-ahead-line pattern that disqualified 2021, in patches.
A stale opener is genuinely beatable by an informed model — but not
tradeable at that size, because a look-ahead line is not a bettable line.
Conservative headline stands.

**Tiers, for anyone reading the full table.** `third_party_bulk` (nfelo:
+0.40 adj, z 4.3) is the strongest single row and is NOT cited as edge: its
1,725 rows share one fetch timestamp, so its pre-game ratings cannot be
proven pre-game by our clock. `in_week` (availability: +0.28) is line-move
prediction, not edge at the open. `contaminated` (the correction head: +1.1)
is the answer key. `opener` (market_regression) is ~0, as it must be — the
sanity anchor the whole table hangs on.

**What this changes in the plan.** (1) The promotion gate's objective is
wrong for a betting operation — "beat the CLOSE on margin MAE" has said no
30 times; "positive CLV at the OPEN" says yes, small, for one family. The
gate should be rebuilt around CLV. (2) The drive sim has no opener edge; its
remaining claim is the joint distribution (totals, live), not the spread.
(3) FINAL ORDER #10-#15's data mining should be graded on adjusted opener
CLV, not closing MAE, or it will keep "failing" tests that were never the
right test.

**NEXT MEASUREMENT — declared now, before it is run.** Turn ~0.25 points into
money requires three things this measurement did not test, each with its own
preregistered family: (a) *selection* — the `by_abs_lean` bins already in
summary.json suggest CLV rises with |lean| (second_half_eff ≥5: +0.68;
python_football ≥5: +0.90) but those bins were read after the fact and n is
90-250, so they are a hypothesis, not a result; (b) *shopping* — a half-point
better number across the 10 archived books is worth ~1.5 points of cover
rate, more than the entire edge; (c) *timing* — the edge is at the OPENER,
which means Sunday night/Monday, before the drift. The test: one composite
prior-week efficiency signal (not five), selected at a preregistered |lean|
threshold, priced at the best archived book at open, graded on adjusted CLV
and ATS, 2022-2024, Holm across the (few) thresholds tried. If that clears
break-even it is the first bettable edge this project has measured. If it
does not, we know the edge is real but sub-vig, and stop.

### FINAL ORDER #4 — multiplicity and conditional predictive ability (September 16, 2026)

Three pieces, all shipped and tested.

**(a) Holm across the residual gate's declared family.** The per-component
gate asked ~30 components, separately, "is your p below 0.05?" — which
produces one or two passes by luck alone even when nothing has skill. Holm's
step-down correction is now applied across the components actually tested at
each cutoff, and reported ALONGSIDE the raw verdict
(`residual_dm_p_holm`, `residual_diagnostic_passed_holm`, and a
`residual_multiplicity` block carrying family size and raw-vs-corrected pass
counts) rather than replacing it, so an auditor sees both.

Routed through `stats-util.js`'s existing `holm` deliberately. **This
codebase already carried THREE independent Holm implementations** —
`stats-util.js`, `modeling/governed-comparison.js`,
`player-head-validation.js` — all three checked and mathematically
equivalent, but a fourth would have been exactly the duplicate-formula defect
the recurring checklist exists to stop.

**Scope note that matters:** since FINAL ORDER #1 the SERVED line comes from
one joint fit, which is a single test needing no correction across
components. This correction governs the per-component DIAGNOSTICS, which are
what a reader would otherwise mistake for thirty independent promotion
signals.

**(b) Giacomini-White conditional predictive ability**, in
`forecast-comparison.js` beside `dieboldMariano`. DM asks "was A better on
average"; GW asks "given what was knowable at the time, could you tell WHEN A
would be better". The latter is the right question when models are refit at
every walk-forward cutoff, which ours are — and Diebold's own 2012
retrospective says DM was built to compare FORECASTS, not to adjudicate
between MODELS, which is what the residual gate has been using it for. With
the conditioning vector set to a constant alone it reduces to DM, which its
test pins. Honest limit recorded in the code: the chi-squared reference is
asymptotic with no small-sample correction, so on ~18-week samples a marginal
p is no evidence rather than weak evidence.

**(c) The correction is now auditable.** `runAudit()` had always tightened its
bar for how many audits were sealed before it — a Šidák step — and then
**discarded both inputs**. A sealed row recorded `significant` but not the
alpha it cleared nor the prior-test count behind it, so a reader could not
tell whether a result cleared 0.05 or 0.002, nor reproduce the decision
without replaying the registry. Migration 054 adds
`corrected_alpha_at_seal` and `prior_tests_at_seal`, and the seal writes
them. Its test pins the behaviour that was previously invisible: **the bar
genuinely tightens as the registry fills**, so a late audit is harder to pass
than an early one.

**Caught by the versioning, worth recording.** The fit result gained fields,
and `fitEnsemble` reloads persisted artifacts verbatim — so a stale v13
artifact returned `undefined` for every corrected number rather than erroring.
That is precisely the silent staleness `ENSEMBLE_FIT_VERSION` exists to catch,
and it caught it. Bumped to **v14**.

**MEASURED on real history, same day** (`/tmp/gridiron-extract/real.sqlite`,
`includeChallengers: true`; raw output in
`docs/evidence/2026-09-16/residual-gate-holm-correction.txt`):

```
family_size: 32     pass_count_raw: 0     pass_count_holm: 0
best five raw p-values, all corrected to 1.0:
  pythagorean 0.3827   opp_adjusted 0.4189   dynamic_state 0.4365
  melo 0.4438          market_regression 0.5435
```

**The correction changes nothing here, and that is worth stating plainly
rather than dressing up.** Not one component was close: the best raw p across
32 components is 0.38, where the uncorrected bar is 0.05. There was no
multiplicity problem to fix at this cutoff because there were no passes to
correct. The guardrail is still right to have — it costs nothing when there
is nothing to catch, and it is exactly what would have been missing on the
day something finally did clear 0.05 — but it did not change a single verdict
today, and nobody should cite it as though it had.

**Other methods, deliberately not chased (Nick, September 16: "I wonder if
there are other methods and ways to do this but we can explore all that
later").** Recorded so this is a real note rather than a vague intention:
- **Benjamini-Hochberg FDR** instead of Holm's family-wise error. Less
  conservative and arguably the better fit for a screening stage where the
  cost of one false lead is low — Holm asks "is ANY of these a false
  positive", BH asks "what fraction of my promotions are false". For picking
  candidates to investigate, BH is usually the right question.
- **Romano-Wolf stepdown**, which bootstraps the joint distribution of the
  test statistics rather than assuming independence. Our components are
  heavily correlated (that is the whole finding behind effective rank 2.56),
  and both Holm and BH are conservative under that correlation — Romano-Wolf
  would recover real power we are currently giving away.
- **The DSR/PBO machinery already in this plan** (deflated Sharpe, probability
  of backtest overfitting), which prices multiplicity in the
  strategy-selection sense rather than the per-test sense. Note the plan's own
  caveat: `run-purged-evaluation.mjs` currently feeds it non-standardised
  mixed units, so that must be fixed before its numbers mean anything.
- **Model confidence sets** (Hansen-Lunde-Nason), which return the SET of
  models indistinguishable from the best rather than a pass/fail per model —
  a better shape for this problem than a gate, and already cited in the
  research corpus as done.

### FINAL ORDER #3 — the point-in-time guard, and what it refuses (September 16, 2026)

Built per RUNBOOK §10.3. **The recipe's path was wrong** (`server/services/contracts.js`);
the guard actually lives in `server/modeling/contracts.js`, and §10.3 has
been corrected in place.

**What the five raw tables actually carry**, mapped against the real
database rather than assumed:

| table | clock column | regime |
|---|---|---|
| `nfl_injuries` | `modified_at` | `unmodified_since` |
| `nfl_depth` | `captured` | `observed` (our own receipt clock) |
| `nfl_team_week_features` | — none — | none |
| `nfl_snaps` | — none — | none |
| `nfl_pfr_adv` | — none — | none |

The regimes mirror `research/betting/nfl/injury_admission.py` exactly so the
JS and Python sides cannot drift.

**Finding 1 — the injury clock died in 2025.** `nfl_injuries.modified_at` is
populated for 100% of 2021-2022 rows, 97.4% of 2023, 95.8% of 2024, and
**0% of 2025 (5,783 rows) and 2026 (182 rows)**. nflverse stopped publishing
it. This confirms the earlier note in this plan and puts a number on it.

**Finding 2 — what strict admission would refuse.** Asking only for rows a
Week 5 prediction legitimately wants (that season, weeks 1-4), at a Week 5
kickoff cutoff:

| season | refused |
|---|---|
| 2021 | 0 |
| 2022 | 0 |
| 2023 | 0 |
| 2024 | 0 |
| **2025** | **10,080** — `nfl_injuries` 1,024/1,024, `nfl_snaps` 5,971/5,971, `nfl_pfr_adv` 2,953/2,953, `nfl_team_week_features` 132/132, all 100%. `nfl_depth` alone survives (11,004 admitted, 0 refused). |

Reproduce with `scripts/point-in-time-admission-report.mjs`; raw output in
`docs/evidence/2026-09-16/point-in-time-admission-report.json`.

**The honest reading: for the CURRENT season, only depth charts carry
evidence this codebase can defend as point-in-time.** Everything else is
being read as "whatever the table says today." The historical seasons look
clean only because three clockless tables are grandfathered before
2025-01-01 — which is why nobody noticed. That grandfathering is a policy
choice; the dead injury clock is not.

**A live leak found while doing this, separate from the above.**
`nfl-rookies.js` `depthRankFor()` selects `pos_rank` with
`week <= ?` and no reference to `captured` at all — so it can read a depth
chart captured during or after the week being predicted, and with 2025's
duplicate snapshots it picks an arbitrary one of them. This is exactly the
class of defect #3 exists to close, and it is not covered by the guard until
a caller is changed to use it. **Not fixed in this pass** (it is in
`nfl-rookies.js`, a fantasy-side consumer, not the NFL betting path #3
scopes) — recorded here so it is not lost.

**`nfl_depth` duplication, 2025 only.** 57,323 rows against 49,318 distinct
`(season, week, team, gsis_id)` keys — 8,005 duplicates, where 2023 and 2024
had exactly zero. The duplicates are distinct `captured` snapshots (193
distinct capture times in 2025 vs ~63 before), so this is probably a
deliberate move to retaining every snapshot rather than one per week — which
is GOOD for point-in-time work and bad for any consumer that aggregates
without deduping. Recurring-checklist item 3 caught this.

**NOT ENFORCED ANYWHERE YET, and that is deliberate.** Turning strict
admission on for the live path would refuse four of five input tables for
the current season, i.e. stop the model serving 2025 predictions from
anything but depth charts. That is a decision about what the product may
claim, not one a guard should make silently. The guard, its tests (12) and
the report script are shipped; the enforcement decision is Nick's, and the
number above is what it should be made against.

> **DEFERRED BY NICK, September 16, 2026 — do not treat this as an open
> question to re-litigate every session.** His call, verbatim in substance:
> *not sure what to do — let's note this and come back; I'm concerned about
> the model right now so that's the main priority; get the model
> historically solid, then we can worry about the present.*
>
> So the ordering is settled: **historical trustworthiness first, current-season
> serving second.** Concretely, that means the guardrail items that decide
> whether our own historical numbers can be believed (FINAL ORDER #4's
> multiple-comparison correction, the DSR/PBO input defect, the
> unreproducible 42.86%) come BEFORE any change to what the live path is
> allowed to serve.
>
> **What must be true before this decision is reopened:** (a) the historical
> measurement chain is trustworthy end to end, and (b) someone has decided
> what the product is allowed to claim when its inputs have no clock —
> serve with a visible caveat, or abstain. Neither is a research question;
> (b) is a product one. Until then the guard stays built, tested and
> unenforced, which is a stable, honest state: nothing silently claims
> point-in-time discipline it does not have, and nothing silently breaks.

### Why does the simulator's ATS rate fall across seasons? — investigated September 16, 2026

Nick's question after the FINAL ORDER #2 re-measurement, which showed
60.0% / 53.6% / 51.6% / 46.5% / 49.0% for 2021-2025. **Answer: the decline
is not a real effect. It is noise, and the question is below the resolution
of the available data.** Five things were checked; the last two are the
ones that settle it.

**1. Data coverage — ruled out.** `game_lines` has 285 home rows per season
2021-2025 with zero null spreads and zero null scores;
`nfl_team_week_features` has 561 rows, 33 teams, 18 weeks and a ~4,960-byte
blob in every one of those seasons. Nothing thins out in the recent years.

**2. A scoring-environment shift the simulator does not model — tested,
not supported.** The hypothesis was the 2024/2025 kickoff changes moving
drive starts (the engine hardcodes the 25-yard line in five places). If
true, the sim should increasingly UNDER-predict scoring in exactly those
seasons. Measured sim-minus-actual mean total by season: -2.05, +2.00,
-2.64, +3.13, -1.51. It swings both directions with no trend. Rejected.
(The hardcoded 25 is still worth fixing on its own merits; it just does not
explain this.)

**3. The market getting sharper — weak.** Market MAE by season is 10.67,
8.78, 9.98, 9.70, 9.67: roughly flat, with no step change. The market did
not suddenly get much better.

**4. Year-over-year team persistence falling — the best mechanism, and it
still fails.** How well last season's team margin predicts this season's,
which is exactly what the backtest's prior-season profiles rely on:
r = 0.564 / 0.331 / 0.458 / 0.311 / 0.346 for predicting 2021-2025. Across
those five seasons that correlates **+0.83 with the ATS rate**, which looks
compelling — and the mechanism is real football (teams reorder between
seasons more than they used to; note that within-season spread of team
strength has NOT narrowed, so this is churn, not parity). But:
- The persistence decline is **itself not significant** (Fisher z, pooling
  2019-21 targets vs 2022-25: z=1.33, p=0.185). With 32 teams a season,
  r=0.56 and r=0.31 are not distinguishable.
- Its predicted fix does not work. `backtest({profileMode:'within_season'})`
  was added to test it — current-season form through the weeks strictly
  before each game, equally cutoff-safe. If stale prior-season profiles were
  the cause, this should help most in the low-persistence seasons. It was
  WORSE in 2021, 2023 and 2024, better in 2022 and 2025. Pooled it is a wash
  (.5196 vs .5173). Rejected as the explanation, though see the 2025 note
  below.
- n=5 seasons for that +0.83 correlation, found after looking at the data.

**5. The pattern does not survive contact with small model changes — this
is the decisive evidence.** Excluding international games and moving home
field from post-hoc points to per-play rates are both small and principled.
They reshuffled the per-season ATS rates by ±5-7 points *in both
directions*:

| season | before those changes | after | change |
|---|---|---|---|
| 2021 | .600 | .580 | -.020 |
| 2022 | .536 | .505 | -.031 |
| 2023 | .516 | .568 | **+.052** |
| 2024 | .465 | .515 | **+.050** |
| 2025 | .490 | .420 | **-.070** |

The monotone decline Nick spotted (60/54/52/47/49) became 58/51/57/52/42 —
not monotone at all. A real season-level effect does not reorder itself
because ~5 neutral-site games were dropped and a 1.6-point knob changed
shape. Formally: chi-square homogeneity across the five seasons gives
p=0.374 on the old numbers and p=0.170 on the new — at no point is there
evidence the seasons differ from one constant rate.

**And the question cannot be answered with NFL data at this sample size.**
To distinguish two seasons that truly differ by 11 points of ATS rate, at
80% power and the 5% level, needs ~323 graded games *per season*. A full NFL
season has ~285 games, and this backtest samples 100. An 8-point difference
needs ~611 per season. **Season-over-season ATS trends in this range are
below the resolution of the data, permanently — no amount of care in the
backtest fixes that.** The correct instrument for "is the simulator getting
worse" is a pooled multi-season test with a declared family correction, not
a season-by-season read.

**What to do with this.** Stop reading season-level ATS wiggles as signal;
they are the same trap as the unreproducible 42.86%. The one genuinely
interesting residue is that `within_season` profiles produced 54.0% ATS and
9.89 MAE in 2025 against the market's 9.47 — the closest the simulator has
come to the market on margin. On n=1 season that is a single good draw, not
a finding, but it is the only cell in this whole exercise worth a
preregistered follow-up. Raw arms:
`docs/evidence/2026-09-16/drive-sim-profile-mode-arms.jsonl`.

### Does a different modeling PARADIGM change anything — checked against what's already been tried, September 16, 2026

Nick's question: is there a fundamentally different way to attack the
spread question, not just more features on the same regression? Checked
against the actual inventory (`MODEL INVENTORY AND ORGANIZATION` below)
before answering — the honest picture is more informative than a fresh
brainstorm would have been.

**Five genuinely different paradigms have already been tried in this
codebase, with real measurement, and all lost:**
- **Mechanistic play-by-play simulation** (`nfl-drive-sim.js` — plays the
  game thousands of times rather than regressing on aggregates): **42.86%
  ATS vs. 52.38% breakeven.** **RE-MEASURED 2026-09-16 after FINAL ORDER #2:
  52.14% ATS over 491 walk-forward games (2021-2025) — still below
  break-even and with no detectable edge (p=0.56), but the 42.86% figure has
  no recorded sample size and does not reproduce. See the full treatment in
  Section B above; do not cite 42.86% again without re-deriving it.**
- **Trend-following on totals**: **43.81% ATS.**
- **Gradient boosting on the market residual**: **worse than zero.**
- **12 independently-built specialist models**, spanning different
  methodologies: **"none clears breakeven."**
- The main regression/ensemble path itself: 0 of 848 fit artifacts ever
  passed the residual gate. **CORRECTED 2026-09-16 (FINAL ORDER #1):** the
  joint version of this fit was built and also does not pass — see the
  correction in Section B above.

**This is stronger evidence than any single failure — five structurally
different approaches, tried independently, all fail the same way. That
points at the constraint being informational, not paradigmatic.** A sixth
different way of processing the same information is unlikely to succeed
where five already failed on it. This tempers "try a different fundamental
approach" as a strategy on its own, separate from feeding it genuinely new
information.

**What has NOT been tried this way — the honest exception:** `tree_lab.py`'s
cover/quantile-probability approach predicts P(cover) or a quantile
directly — classification/probability, not point-margin regression. It sits
in "research only," untested with this project's own audit rigor, already
queued and never executed (RUNBOOK §4.2). This is the one genuinely
different framing on the list that hasn't been measured — not a new idea,
an old one nobody finished.

**Two more real, narrow, untested angles within what already exists:**
- The drive-sim's own docstring is explicit that its value claim is NOT
  margin/ATS accuracy — it's the joint margin+total distribution, correctly
  correlated scores, and real key-number reproduction. That is a
  **totals-specific** claim, and totals has had zero dedicated attention
  all session. Nobody has isolated and tested that specific claim with the
  same rigor as everything else.
- **Bottom-up player aggregation**: build team margin from the player-props
  engine's already-built Bayesian per-player projections (see the
  cross-wiring finding above, RUNBOOK §4.1b) rather than either team-history
  regression or mechanistic simulation. Different from both, untested.
- **Score-driven (GAS) dynamic bivariate Poisson/Skellam joint-scoring
  model — added September 16 from the research corpus.** Koopman & Lit
  (2019, `source-papers/papers/koopman_lit_2019_gas.pdf`, read in full by
  the F08/F17 researchers): a score-driven dynamic model of both teams'
  scores beat a static model AND a full parameter-driven state-space model
  head-to-head, at roughly 1/360th the compute. `FIX_AND_ADD_ARCHITECTURE.md`
  calls it "the strongest single number in this whole research batch" (ADD
  #15). What it offers that nothing else on this list does: a joint
  distribution over both scores — so margin AND total come from one
  coherent model, correctly correlated, with real discrete key-number mass —
  the exact thing the drive-sim's docstring claims as its value, without
  simulating plays. It is soccer-goal Poisson ported to NFL scoring
  dynamics, so the admission test is the same as the older "Discrete joint
  score model" row in the Advanced research backlog table below: validate
  NFL score support and key margins (Stern 1991, F17) first, then a
  walk-forward CRPS/log-loss gate against the current champion before it
  touches anything. Untested here; the paper's own evidence is the reason to
  test it.

**Bottom line to carry forward:** the realistic path is still what the rest
of this plan already emphasizes — new information, tested rigorously —
not a new way of processing the same information. Two exceptions worth
actually executing: finishing `tree_lab`'s cover head (RUNBOOK §4.2),
because it's the one paradigm shift on the list that was never finished,
not one that was tried and failed; and the GAS joint-scoring model above,
because it is the one with published head-to-head evidence behind it and
it is the only candidate that gives the totals side a model at all.

### The "enrich every paradigm, then let diversity decide" plan — September 16, 2026

Nick's proposal: backfill ALL the different modeling paradigms with the new
data found this session, let each produce its answer using its own native
technique, then use a meta-learner to combine them — "a bunch of misfits
made to work together." Checked against what's already built and measured
before writing this up: most of the machinery already exists; the genuinely
new part is real, staged work, not a single build.

**Why this is the right next move, not a repeat of what already failed:**
the 32-35 component ensemble already IS "diverse models combined via ML" —
measured effective rank ~2.5 (see "Effective rank result" above). Combining
only helps when the inputs are genuinely diverse, and today they mostly
aren't. Every enrichment this session went into ONE paradigm (the
correction head, V1→V2→V3). Nobody has yet enriched the *other* paradigms
(the simulator, the specialists, `tree_lab`'s quantile head) with the same
new data and re-asked the diversity question. That is a real, unexecuted
experiment, not a rerun of one that already lost.

**The four stages, in order, using machinery that mostly already exists:**

1. **Enrich each paradigm separately, in its own native form** — this is
   real, separate integration work per paradigm, not one build that fans
   out for free:
   - `nfl-drive-sim.js` takes measurable team RATES, not fitted
     coefficients (per its own docstring) — enrichment means deriving new
     rate parameters from the new data (e.g. pressure-conditioned EPA,
     pace, red-zone rates from the 183-key/vector-table findings above),
     not adding a regression column.
   - `tree_lab.py`'s cover/quantile head (roadmap item 6b) — finish this
     first with the CURRENT frozen contract, then re-attempt with the
     richer feature set once the base version is measured.
   - The correction head already has V1/V2/V3 done, plus RECIPE_V4+ from
     items 1-5 on the roadmap above.
   - The specialist layer (`nfl-specialists.js` + orthogonal/matchup/passing
     variants, 12+20+4 models) — currently all measured "none clears
     breakeven" on the old data; worth one retest pass with the new data
     before writing this family off permanently, since it was never
     retested after this session's discoveries.
2. **Re-run the existing rank/redundancy measurement**
   (`scripts/ensemble-rank-report.mjs`, already built, already run twice
   this session) on the enriched catalog. This is the honest diversity
   check — not a guess, a number, the same one already computed at 2.518
   and 2.564 for the pre-enrichment catalog.
3. **Apply RUNBOOK §5's existing decision rule to the new number** — it
   already says what to do in both directions: rank ≈2-3 still, prune
   further; rank materially higher, build the combiner. Don't skip straight
   to combining because the effort was significant — let the same
   measurement decide, the way it decided the first time.
4. **If combining is justified, use `forecast-combination.js`** — already
   built, already documented as the most rigorous of six combination
   attempts (DM-gated, week-clustered), sitting unused because rank never
   justified it before now. This is the "ML/AI to figure out how to
   combine them" piece — it exists, it just hasn't had a reason to run yet.

**Guardrail this needs before starting, not after:** the multiple-testing
correction flagged above. Stage 1 alone could mean dozens of new
paradigm/data-source combinations tested. Apply `effectiveTrialCount`/a
Bonferroni-style correction to whatever comes out of this, the same
correction that just walked back the V3-vs-V1 finding earlier today —
don't let this become the same mistake at a larger scale.

**Honest expectation, stated plainly so this isn't oversold:** five
structurally different paradigms already failed on the OLD data (see "Does
a different modeling PARADIGM change anything" above). This plan tests
whether richer data changes that verdict — it does not guarantee it will.
The value of doing it properly, staged, and measured is that either outcome
is a real answer: either the ensemble becomes genuinely more diverse and
combining finally earns its place, or it doesn't and that's one more
honestly-measured "no" narrowing where the real edge could possibly be —
which, per this whole session's own discipline, is exactly as valuable a
result as a "yes."

### THE feature-store discovery — September 16, 2026: 301 variables computed, 3 reach the model

Nick's own recollection ("we have 300 some variables") sent this check, and
it's real, not misremembered — bigger than any other finding this session.
`nfl_feature_dictionary` (3,795 rows) catalogs **301 distinct underlying
metrics** (93 player-level, 208 team-level — confirmed:
`COUNT(DISTINCT source_family||'|'||source_metric)`), each computed across
up to **13 rolling-window transforms** (`latest, mean_3, mean_6, mean_12,
ewma_6, slope_6, sd_6, min_6, max_6, delta_1, coverage_12, missing,
z_latest`) by `server/services/nfl-weekly-feature-store.js`, stored into
`nfl_team_week_features`/player features. 301 × up to 13 ≈ the 3,795 catalog
rows.

**Verified exactly how much of it the actual football model uses: 3 metrics,
1 transform each.** `stage3.FEATURE_NAMES` (the frozen 14) is 11 simple
fields (rest days, division game, rolling win/margin "form" stats computed
separately from raw game history, NOT from this store) plus exactly three
`pbp_diff_{k}` fields for `k in ['off_epa_per_play', 'def_epa_per_play',
'off_success_rate']` (`stage3_team_strength.py:123`) — and
`dataset.features_before()` (`dataset.py:221`) pulls only the single
**"latest"** value for each, never `mean_3`/`mean_6`/`ewma_6`/`slope_6`/`sd_6`
or any other transform. Of ~3,795 computed values, the model reads 3.
**298 metrics, and every trend/momentum/volatility transform of the 3 it
does use, are computed and stored and reach nothing.**

**Why this isn't "just add them all" — the correction-head V3 result
already proved what happens.** 5-7 features on ~310 weekly training rows
already produced an exploding, noise-fitting coefficient. The frozen 14
itself is that size specifically to avoid this on the football model's own
larger-but-still-weekly-limited training set. Feeding all ~3,795 columns
into anything refit weekly would be catastrophic overfitting, not progress
— this is a SELECTION problem, not a "wire it all in" problem: which of the
298 unused metrics (and which transforms — `slope_6`/`ewma_6` in particular
encode trend/momentum information `latest` structurally cannot) carry real,
testable signal, added one or a few at a time, each measured against the
market and the model's own base out-of-fold, exactly like every other
signal this session — never all at once.

**This moves to the top of the roadmap below, ahead of the cross-book
market-data item — same opportunity size, already computed and sitting in
the database with zero ingestion work required, just selection and
testing.**

### THE actual biggest finding — a finished, ready-to-use feature contract exists and is connected to nothing, September 16, 2026

Found while sweeping tables not yet individually checked. This supersedes
the "mine the raw 183-key JSON" framing below — there is a faster, cleaner
path that was apparently built for exactly this purpose and never
connected.

**`nfl_team_feature_vectors` and `nfl_player_feature_vectors` are not raw
data — they are a finished, versioned, point-in-time-safe feature contract,
already fully assembled, per team-week and per player-week.** Verified
directly:
- Team side: **~2,670-2,680 features per team-week** (98.8-99.1% coverage
  of the full metric×transform space — essentially the complete 208-metric
  ×13-transform warehouse, already flattened into one vector), 2022-2026.
  Every row carries an explicit `cutoff` field matching the real game
  kickoff timestamp (e.g. `2022-10-09T20:25:00.000Z` for a real ARI game)
  and an `evidence_hash` for reproducibility — i.e. point-in-time safety
  and provenance are already solved, per row, not something a consumer
  would need to build.
- Player side: **~700-800 features per player-week** (89-92% coverage),
  same seasons, same discipline.
- Built by the same store as the 183-key JSON (`nfl-weekly-feature-store-v1`),
  registered internally under the ids `frozen_team_state`/`frozen_player_state`
  (`nfl-model-growth.js`) — the naming states outright this was built to BE
  a frozen, model-ready contract.
- **Confirmed zero references anywhere in the audited research pipeline**
  (`grep -rl` across `research/betting/nfl/*.py` returns nothing). The only
  two files that touch either table are `nfl-model-growth.js` (counts rows
  to check the pipeline hasn't gone stale) and `nfl-blind-audit.js` (watches
  them for mutations as part of its input-table list). **Neither reads the
  actual vector content. Nobody has ever consumed what's inside either
  table.**

**Why this changes the plan:** the frozen 14 pulls its 3 team-level metrics
from the raw, un-versioned `nfl_team_week_features.features` column
directly, with no explicit cutoff field on that row and no evidence hash —
a messier path than the one that already exists and was seemingly built to
replace it. Rather than hand-picking individual metrics out of the 183-key
raw JSON one at a time (the plan below), the faster and more correct route
is very likely: **wire `stage3_team_strength.py` (or a new, explicitly-
versioned successor contract) to read from `nfl_team_feature_vectors`
directly**, then run PRINCIPLED dimensionality reduction / feature
selection on the ~2,670-wide vector (PCA, or a sparsity-inducing
regularizer, or a small hand-audited subset chosen by measured
correlation with the target) — never all 2,670 raw columns into a
weekly-refit ridge, which the V3 result already proved fails catastrophically
at 5-7 columns on a few hundred rows, let alone thousands. This is now
**the new #1 roadmap item**, ahead of the raw-JSON-mining framing, which
becomes its fallback if the vector tables turn out to have a coverage or
quality problem on closer inspection (not yet checked: whether the ~1%
missing cells per row are randomly distributed or systematically clustered
on specific metrics/transforms).

**Same pattern, found once more while checking:** `nfl_ngs` (real Next Gen
Stats tracking data — `avg_time_to_throw`, `completion_percentage_above_expectation`,
`aggressiveness`, genuinely different metrics than anything in the EPA
warehouse) is used by several files (`nfl-player-value.js`, `nfl-advanced.js`,
`nfl-weekly-feature-store.js` among them) — but, same correction as
`nfl_ffopportunity_weekly` earlier, that means props/player-value and
feature-store bookkeeping, not the margin/correction pipeline specifically.
Likely already flows INTO the `nfl_player_feature_vectors` contract above
given `nfl-weekly-feature-store.js` is in both tables' builder list — worth
confirming when that table is wired, not a separate ingestion task.

### Creative sweep — travel/altitude, coaching, field surface, and the FULL depth of the team-EPA warehouse, September 16, 2026

Nick asked for a genuinely creative pass over what a football game has that
we've left out, not just the tables already found. Checked every idea
against the real database before writing it down — verified facts and
clearly-labeled derived-feature ideas, not speculation.

**The team-EPA warehouse is deeper than first measured — 183 keys per
team-week, not the ~150 estimated when this was first found, confirmed by
direct count.** Sampled in full, it contains things the frozen 14 has never
seen at all, several of them well-documented, high-value signals in
football analytics specifically:
- **Pressure-conditioned EPA**: `off_pressure_epa` vs `off_clean_pocket_epa`
  (and the delta) — literally "how good is this offense when the QB is and
  isn't under pressure," a materially different and more specific signal
  than aggregate EPA.
- **Situational splits**: `leading_pass_rate`/`trailing_pass_rate` (game-
  script dependent tendency), `first_half_epa`/`second_half_epa` (and their
  delta — a team that fades), `epa_q4_close` (clutch performance
  specifically), EPA by field zone (`epa_own_territory`/`epa_midfield`/
  `epa_opp_territory`).
- **`off_garbage_time_share`** — already computed. Garbage-time filtering
  (down-weighting or excluding plays after a game is decided) is a
  standard, well-documented cleaning step in football analytics because
  those plays inflate/deflate rate stats in a way that isn't predictive of
  a close, competitive game — and the flag needed to do it is sitting
  unused in the same JSON blob every other frozen-14 field is pulled from.
- **Pace/tempo**: `plays_per_drive`, `seconds_per_drive`, `no_huddle_rate`,
  `shotgun_rate` — none of it reaches the model, despite pace mattering for
  both margin variance and totals specifically.
- **Full situational efficiency**: third-down rate AND distance-to-go,
  red-zone/goal-to-go TD rate, drive-outcome rates (TD/FG/punt/turnover per
  drive), havoc rate, TFL rate — a complete situational profile per team
  per week, computed, stored, unused.

Of 183 keys, 3 reach the model (`off_epa_per_play`→`pbp_diff_off_epa_per_play`,
same for `def_epa_per_play`, `off_success_rate`), each as `latest` only.
This is the same finding as before, just measured to its real depth — this
is now item 1 on the roadmap below, upgraded from "298 of 301 team+player
metrics" to "180 of 183 keys in the team table alone, before even counting
the separate player-level and PFR gaps already found."

**Verified real, currently unused: true travel, altitude, and timezone.**
`nfl_stadiums` (`stadium_id, name, lat, lon, altitude, roof_type,
surface_type, tz, city, state`) has real lat/lon/altitude/timezone for
every stadium. The `rest_travel` component (renamed earlier this session
specifically because "despite its name, this component has never measured
travel... at all — only rest days") can now actually be fixed: haversine
distance between the away team's home stadium and the game's stadium, and
a timezone-crossing count, are both directly computable from data already
in the house. Altitude specifically matters at exactly one stadium (Denver)
but is a real, documented effect (kicking distance, opponent stamina) —
cheap to include given the data is already there.

**Verified real, currently unused: field surface.** `game_lines.surface`
is populated for 2021-2026 (only 88 of ~2,900+ rows blank) with real values
— `grass`, `fieldturf`, `astroturf`, `sportturf`, `matrixturf` — though the
raw values need normalizing first (`grass` and `grass ` with a trailing
space are currently distinct strings; `a_turf` vs `astroturf` likely
duplicate the same real category under two spellings). A genuinely
standard, well-documented factor (turf increases injury rate and favors
speed; surface changes mid-network are rare but real), sitting fully
populated and completely unused.

**Verified real, currently unused: coaching continuity.** `nfl_team_coaches`
(`season, team, coach, games`) has full coverage, 2015-2026, 384 rows (12
seasons × 32 teams). Enables, with zero new ingestion: coaching tenure
(seasons with current team, a proxy for scheme stability), and first-season-
with-a-new-coach detection (a real, documented adjustment-period effect).
Limit: head coach only — no offensive/defensive coordinator identity in
this table, so scheme-specific continuity (the more specific, arguably more
predictive version of this idea) would need a genuinely new source, not
just a derivation from what's here.

**Creative derived features needing ZERO new data — feature-engineering
ideas, not data gaps:**
- **Distance to the nearest key number** (3, 7, 10 — NFL margins cluster at
  these values more than a continuous distribution would predict; a
  well-documented market-efficiency fact). A market-spread-derived feature,
  computable today from `game_lines.spread` alone, never built.
- **Reverse line movement** — distinct from the betting-splits divergence
  already flagged: RLM specifically means the LINE moves opposite the
  majority of ticket counts (classic sharp-money tell), which needs
  `nfl_nfelo_lines`' tickets/money split MATCHED AGAINST the actual line
  movement direction from `game_lines.open_spread`→`spread`, not just the
  tickets-vs-money gap alone.
- **Return-from-injury rust window.** `nfl_injuries` has weekly status per
  player; a player who was `Out`/`Doubtful` last week and is unlisted or
  `Questionable` this week is a genuinely different case from a player who
  has been healthy all season — sports-science literature documents a
  measurable short-term performance dip right after return. This is a
  derived signal from data already in `nfl_injuries` (status TRANSITIONS
  across consecutive weeks, not just current-week status), never
  constructed.
- **Weather × play-style interaction, not just a main effect.** If wind/cold
  ever becomes a feature, a 20mph wind matters far more to a offense with
  `off_pass_rate` 0.65 than one at 0.45 — an interaction term, not an
  additive one, and the pass-rate side of that interaction is already
  sitting in the same 183-key JSON above.
- **Playoff-clinch / lame-duck motivation.** A team that has already
  clinched its seed, or is mathematically eliminated, is documented to
  perform differently (rested starters, "sandbagging" incentives) —
  derivable purely from standings (win-loss records already in `game_lines`
  history), no new data needed, just a situational flag nobody has built.

**Genuinely NOT derivable from what we own — real gaps needing new data,
distinct from what's on the earlier list:**
- Offensive-line-specific advanced stats (pass-block/run-block win rate) —
  `nfl_pfr_adv` has no `kind='line'` or equivalent; this would need a new
  source, unlike the pass/rec PFR gap which is free data we already have.
- Coordinator-level (not head-coach) continuity, as noted above.
- Any genuine market EXECUTABILITY signal (a verified T-60 quote) —
  already flagged repeatedly this session as the boundary between
  "prediction accuracy" and "betting profitability," restated here because
  it's the one gap no amount of creative feature engineering closes.

### The same pattern, found twice more in five more minutes of looking

The feature-store discovery above is not a one-off — it's a repeatable
pattern (a JSON-blob column gets a small hand-picked slice destructured out
once, and nobody revisits it as more gets added upstream), and checking for
it elsewhere immediately found two more real cases:

- **`nfl_pfr_adv` kind='pass'/'rec' — 0% used, confirmed by grep (zero
  references anywhere in server/ or research/).** We built the `kind='def'`
  defensive-weighting path this session; the passing-pressure (`times_pressured_pct`,
  `times_hurried`, `times_hit`, `passing_bad_throw_pct`) and receiving-quality
  (`receiving_broken_tackles`, `receiving_drop_pct`, `receiving_rat`)
  categories are the same free, already-ingested table, same JSON shape,
  completely untouched. Even the `def` kind we DID wire only uses 4 of its
  14 stat keys — `def_passer_rating_allowed` (a well-known coverage-quality
  metric), `def_ints`, `def_completion_pct`, `def_adot`, `def_times_blitzed`
  are unused in the same blob we already parse.
- **`nfl_player_week_features.features` — ~68 keys per player-week; our own
  code reads 6** (`pass_epa_per_att`, `cpoe`, `carry_share`, `target_share`,
  `opportunity_share`, `wopr`, confirmed via `nfl-player-value.js`), a more
  extreme ratio than the 301-metric team store above. Unused, every player,
  every week, since 2016: explosive-play rates (`explosive_rush_rate`,
  `explosive_rec_rate`, `explosive_play_rate`), red-zone/goal-line usage
  share, third-down/two-minute situational usage, and `wpa_total` (win
  probability added) — none of it reaches injury/availability weighting or
  anything else.
- **`nfeloFeatures()` itself** (wired this session for `nfelo_rating`/
  `nfelo_qb_adjustment`) returns more than was used: plain `elo_diff`/
  `qbelo_diff` (a third independent rating, no 538 QB adjustment folded in)
  and — no new wiring needed at all, already in the same return object —
  `tickets_pct_home`/`money_pct_home`/`tickets_pct_total_over`/
  `money_pct_total_over`, the exact sharp-vs-public betting-splits signal
  flagged earlier as a separate future item. It was already being read.

**New standing checklist item (added to the recurring data-integrity audit
above): for every JSON-blob column this codebase reads, diff the full key
set against what's actually destructured out, the same way the 301-metric
feature store and these two were just found.** Given three real hits found
this fast, there are very likely more.

### Prioritized roadmap for when execution resumes

1. **Wire `nfl_team_feature_vectors`/`nfl_player_feature_vectors` — the
   already-built, versioned, cutoff-safe, ~2,670/~750-feature contract that
   currently feeds nothing.** First: check whether the ~1-11% missing cells
   per row are randomly scattered or clustered on specific metrics (a
   systematic gap would need handling before trusting the vector wholesale).
   Then: principled dimensionality reduction on top (PCA, sparsity-inducing
   regularization, or a small hand-audited subset by measured target
   correlation) — never all ~2,670 raw columns into a weekly-refit model,
   which the V3 result already proved fails at 5-7 columns on a few hundred
   rows. This supersedes item-by-item metric mining below as the primary
   path; fall back to hand-picking individual metrics from the raw 183-key
   JSON only if the vector tables turn out to have a real quality problem.
2. **Mine the raw 183-key team-week JSON / 298-unused-metric feature store
   directly** (fallback to item 1, or useful in parallel for metrics the
   vector tables don't cover) — start with the trend/volatility transforms
   (`slope_6`, `ewma_6`, `sd_6`) of metrics ALREADY partially used
   (`off_epa_per_play`, `def_epa_per_play`, `off_success_rate`), since those
   are the cheapest to justify (same underlying metric, richer transform).
   One or a few at a time, each measured out-of-fold against the market and
   the model's own base, week-clustered, before being added to any frozen
   contract — never a bulk import.
3. **Zero-new-code win: wire up what `nfeloFeatures()` already returns.**
   `elo_diff`/`qbelo_diff` (a third independent rating) and
   `tickets_pct_home`/`money_pct_home`/`*_total_over` (betting splits) need
   no new export, no new data — the function is already imported and called
   at all 3 ctx-assembly sites in `nfl-ensemble.js`; this is purely adding
   `challengerOnly` MODELS entries that read fields already on `c.nfelo`.
   Do this before anything else on this list — it's the cheapest possible
   next step.
4. **Mine `nfl_player_week_features`'s ~62 unused keys** (of ~68 total) —
   explosive-play rates, red-zone/goal-line share, third-down/two-minute
   usage, `wpa_total` — for the injury/availability-weighting work
   (mirrors what PFR defensive data already did for defenders; this is the
   same fix for offense) and for player-value generally.
5. **Wire `nfl_pfr_adv` kind='pass'/'rec'** (0% used) alongside the
   remaining unused `def` keys (`def_passer_rating_allowed` especially) —
   same table, same free data, already-proven ingestion path.
6. Measure the 3 newly-wired challengers (`nfelo_rating`,
   `nfelo_qb_adjustment`, `teamrankings_predictive`) against the market via
   the JS joint fit and rank report — they are wired and verified but NOT
   yet graded for promotion.
6b. **Finish `tree_lab.py`'s cover/quantile head (RUNBOOK §4.2) — the one
   genuinely different modeling paradigm on the whole inventory that was
   never finished, as opposed to the five that were tried and measured
   dead (drive-sim, trend totals, GBM-on-residual, 12 specialists, the main
   regression path itself).** Predicts P(cover) directly rather than a
   point margin. Export its out-of-fold probability the same way
   `export_market_correction_lookup.py` does, wire it as a `cover_research`
   challenger, measure with the same rigor as everything else. Worth
   prioritizing near the top of this list specifically because it's the one
   item where "we haven't tried this" is literally true, not "we tried it
   and it lost."
7. Build the cross-book dispersion feature from `nfl_odds_archive` (10-11
   books, 2022-2026).
8. **Cross-sectional James-Stein / method-of-moments EB shrinkage — two
   targets, one technique (CORRECTED September 16; was "hierarchical
   Bayesian prior," which F15/Brown 2008 show is the wrong variant).**
   (a) FIX #14's real target: add pooling across all 32 current-season teams
   to `nfl-preseason-blend.js`'s `blendedTeamRating()` (the single-unit half
   is already there and correct), gated behind its existing
   `teamStrengthWalkForward`; NFL evidence 16.8% MSE reduction (Ragain et
   al. 2018). (b) The correction head's coefficient vector, so the V3
   feature-creep failure cannot recur as items 1-5 add columns. Reuse
   `shrinkage-fit.js`'s fitted-k machinery — do not add a seventh
   hand-rolled formula. Build (b) before mining items 1-5 too aggressively;
   promote to the top if more than a couple of mined signals are being
   tested at once.
9. Build the referee-tendency feature from `nfl_officials` + our own
   `game_lines` history — internal derivation, no new data needed.
10. **Batch of zero-new-data derived features, all cheap, all verified real:**
    fix `rest_travel` to compute genuine haversine distance + timezone
    crossings from `nfl_stadiums` (it has never measured travel despite its
    name); normalize and wire `game_lines.surface` (turf/grass, needs string
    cleanup first — `grass`/`grass `, `a_turf`/`astroturf` are likely
    duplicates); coaching tenure + new-coach-season flag from
    `nfl_team_coaches` (2015-2026, full coverage); distance-to-nearest-
    key-number (3/7/10) from the market spread alone; reverse line movement
    (line direction vs. `nfl_nfelo_lines` ticket/money split, distinct from
    the plain divergence in item 6); playoff-clinch/lame-duck flag from
    standings already in `game_lines` history; return-from-injury rust
    window from `nfl_injuries` status transitions across consecutive weeks.
    Each measured individually against the market before being kept, same
    discipline as everything else — this is a batch of candidates to try,
    not a batch to assume works.
11. Start on totals — the over/under side has had zero attention all
    session. Two entries, in order: (a) the GAS dynamic bivariate
    Poisson/Skellam joint-scoring model (paradigm section above; the only
    candidate that gives totals a real model, with published head-to-head
    evidence — admission test: NFL score support/key margins first, then a
    walk-forward CRPS/log-loss gate); (b) pregame weather forecasts
    (`nfl_game_weather_forecast_history`) as a totals feature, with the
    weather×pass-rate interaction term from item 10's sweep — an
    interaction, not a plain additive weather feature.
12. Make the correction-head coefficient dump a permanent part of the saved
    audit report, not a one-off manual script.
13. Ingest `nflreadr::load_combine()`/`load_draft_picks()`/`load_contracts()`
    (confirmed free) for the rookie-evaluation and roster-investment gaps.
14. Aggregate `nfl_play_charting` (already owned, unused) to a team-week
    tendency feature.
15. Run the recurring data-integrity checklist (including the new
    JSON-blob-key-diff item above) as its own dispatched pass, independent
    of any specific feature build.
16. **After items 1-9 and 6b have each been individually measured: run "the
    enrich every paradigm, then let diversity decide" plan** (its own
    section above) — enrich the drive-sim, specialists, and `tree_lab` with
    the new data in each one's native form, re-run the rank measurement,
    and let RUNBOOK §5's existing decision rule (already exercised once)
    decide prune vs. combine on the new number. This is deliberately last:
    it needs the individual enrichments done first to have anything real to
    re-measure diversity on.

### THREE THINGS FOUND WHILE ANSWERING "ARE WE USING EVERYTHING" (September 16, 2026, late night)

Nick asked three things at once: find the live betting model if one exists,
check whether we already capture next week's lines early (he suspected we
might), and audit the registry for anything sitting unused. All three
turned up something real, checked against code and the live database, not
assumed.

**1. There IS a live betting model, already wired in, already validated.**
`server/services/live-edge.js`, served from `server/routes/betting-hub.js`
and `nfl-betting.js`. Its own header states the fact plainly: of 22
forecasting components audited in this project, this is the ONE that
passed — Brier 0.1708 against a 0.25 base rate, skill score 0.317,
calibration error 0.047, graded on 2,196 real in-game states. It reads
free live state from ESPN and prices it against Polymarket, a real
exchange with a median cost of 2.53% — meaningfully cheaper than a
sportsbook's standard vig. **This matters directly for the profit
roadmap's "lower the bar" lever (chapter X, section 2 of the opener-CLV
report): if Polymarket's effective cost is roughly half of −110's, an
edge that is currently sub-vig at a sportsbook may not be sub-vig there.**
Not yet tested against the opener-CLV finding — a real next step, not a
conclusion.

**2. We already capture lines well before kickoff — much further out than
"next week."** Checked directly against `nfl_line_snapshots` in the live
database (real `captured_at` vs. real `commence_time`, not assumed):
`book-feeds.js` already polls "this week and next" by design, and the
distribution of how early a line first appears runs from same-day out
past 200 days, with real, non-trivial clusters at every distance in
between — one batch of Week 18 games was first captured in early August
for a January kickoff, roughly five months ahead. **This is a stronger
version of the exact mechanism tonight's finding already proved real**:
if the market is slow to fully price a team's last SIX DAYS of form (the
opener-CLV result), it should be far slower to have priced a team's
current form into a number posted before the season even started.
**Preregistered here, before it's run:** repeat the opener-CLV test, but
instead of grading against each week's own opener, grade the SAME
double-adjusted method against the earliest available snapshot for each
game, binned by how many days early that snapshot was captured. Prediction
being tested, stated in advance: the edge should be flat-to-larger as the
snapshot gets more stale, not smaller — if it shrinks or reverses instead,
that is real evidence against the mechanism, not a result to explain away.

**3. The combined idea Nick proposed — using LIVE in-game information to
front-run a mispriced FUTURE matchup — is not yet built, and is a genuine
new avenue, not a restatement of #2.** #2 says a stale price exists to be
exploited; it says nothing about WHAT should move it. A live-tracked event
during one game (an injury, a blowout that reveals a real weakness, a QB
change) is a named, dated, explainable reason a specific future matchup's
already-posted price might be wrong — closer to reading a real signal than
the general "form lags the price" story, and it can be checked the moment
it happens rather than waiting for a week to pass. **Scoped as new work,
not yet built:** connect `live-edge.js`'s live state stream to the
already-captured future-week lines in `nfl_line_snapshots`, flag when a
live event plausibly touches a team with an already-posted future game,
and log every flag to the `bet_attempts` ledger (Phase 1) whether or not
it's acted on — this is exactly the kind of thing that needs the honest
multiplicity record from the start, or it will look like magic the first
time it works and nobody will be able to tell if it's real.

**Registry accuracy correction, found by spot-checking three "unused"
rows before repeating them as fact:** `market_correction_lookup` and
`teamrankings_lookup` are both live, imported and called directly in
`nfl-ensemble.js` (`marketCorrectionMargin`, `teamrankingsRatingDiff`) —
the registry's `research_only` tag on both is wrong. `preseason_blend`
(`blendedTeamRating()`) is also live, called from `nfl-team-strength.js`
and `nfl-audit-overview.js` — also mistagged. One check held up:
`nfl_live_ledger` really is dead — built, schema exists, genuinely never
called from anywhere outside its own file. **New item: a registry
accuracy pass is needed before its status column is trusted for anything
beyond a starting point** — folded into Phase 1 below, since it's the
same "verify before repeating" discipline everything else tonight used.

**These four are now merged directly into the phase list below as items
7, 10, 13 and 14** — not cross-referenced from here, actually written into
the phases, so reading the phase list top to bottom is reading the whole
plan.

### SEVEN ATTACK-VECTOR TESTS — September 16, 2026, late night (results; `scripts/seven-attack-tests.py`, raw output in `docs/evidence/2026-09-16/opener-clv/seven-attack-tests-results.json`)

Nick: run #11, #7, #8, #2, #3, #6, #5 from the eleven attack vectors, and
use the model registry to find the right existing tool for each rather
than building fresh. All seven ran against data already on disk from
tonight's opener-CLV work (every one of the ~35 components' own per-game
margin was already saved) plus three small read-only joins against the
live database — no new ensemble fit. Two existing, already-built tools
were reused rather than duplicated: `nfl-officials.js`'s `refereeTotals()`
(same exact join and Šidák-corrected multiplicity discipline, ported to a
direct read since that function needs the extract rebuilt to reach it) and
`staking.js`'s `kellyFraction()`/`stakeFor()` math, including the
`DEFAULT_KELLY_FRACTION=0.25` already used in production.

**A real bug caught before results were trusted:** the consensus-line join
(#11) initially matched the literal string `'home'` against `nfl_odds_archive.side`
instead of the home team's own code, silently returning zero matches. Fixed
and rerun before anything below was written down.

**Multiplicity, applied the same way as everything else tonight:** these
seven tests produced 17 individual comparisons across segments, the stress
test, disagreement, and the two line-shopping variants. Holm across all 17
— **seven survive.**

| cell | mean adj. CLV | z | Holm p |
|---|---|---|---|
| Home team in a new-coach season | +0.431 | 4.37 | 0.0002 |
| Excluding week 1 (structural, see below) | +0.215 | 3.77 | 0.0026 |
| Games in the LOW half of internal component disagreement | +0.290 | 3.76 | 0.0026 |
| Single-book (nflverse) close | +0.197 | 3.46 | 0.0075 |
| Normal rest (not coming off a bye) | +0.198 | 3.27 | 0.0139 |
| Median-of-books consensus close | +0.189 | 3.17 | 0.0186 |
| Non-divisional games | +0.199 | 3.05 | 0.0250 |

**#7 stress test — the hypothesis was stated wrong, and that's the finding.**
Declared in advance: the edge should be flat-to-weaker exactly where recent
form is least informative — new-coach seasons were named as one such case.
**The opposite happened: new-coach-season home games show roughly DOUBLE
the edge of the overall pool (+0.431 vs the ~+0.20 baseline), and it's the
single strongest result of the night.** The falsification is being reported
plainly, not explained away. A plausible alternative mechanism, offered
honestly as unconfirmed: a market re-pricing a team around a new coaching
staff is working from a weaker prior than usual, while a signal built from
DIRECTLY MEASURED recent play has no such prior to be wrong about — the
market may be slower here, not faster. Worth its own preregistered test,
not assumed from one slice. Week 1 itself could not be tested at all —
not a null result, a STRUCTURAL one: several of the four survivor
components need in-season games played to compute anything, so the
composite has literally no opinion in week 1 of any season. Bye-week games
(n=56) showed no significant effect either direction — likely underpowered
at that sample size, not yet a real finding.

**#3 disagreement — the most actionable result of the batch.** When the
~35 components' own predictions AGREE with each other (below-median spread
across them), the edge is strong and clean. When they disagree, it
vanishes (mean +0.08, not significant). Read plainly: **internal
committee agreement is a better selectivity signal than the size of the
composite's own disagreement with the market** — which is the opposite
axis from what #2 tested, and #2 failed (next).

**#2 cover-probability calibration — failed, and this matters.** Fit a
simple out-of-sample logistic curve predicting cover probability from
|lean| on an early split, checked its calibration on a later, disjoint
split. The realized cover rate was NOT monotonic in the predicted
probability, and the top confidence bin (lean ≥ 5) realized 41.3% covers
against a PREDICTED 56.6% — badly miscalibrated, in the wrong direction.
**This directly complicates the "bet only the loudest disagreements"
idea floated earlier tonight** — bigger disagreement with the market does
NOT reliably mean more confidence, at least not via this simple a curve.
Contrast with #3: internal agreement among components is a real
selectivity signal; the raw SIZE of disagreement with the market is not,
or at least isn't yet, captured by anything this simple.

**#8 Kelly/flat staking — loses money, exactly as the sub-vig math
predicted, now in dollar terms.** Starting bankroll $100, standard −110
pricing, on the same out-of-fold score split as #2 (whose flawed
calibration curve this inherits, so treat the exact numbers as
illustrative, not final): fractional Kelly (0.25×, the production
multiplier) ended at **$75.97**; flat 1%-of-bankroll every game ended at
**$79.47**. Both strategies lose money. Not a new finding — a concrete
illustration of the ~51%-vs-52.4% gap already reported, made real.

**#11 line shopping — a small, genuine surprise.** The consensus (median
of 10-11 books) close performed marginally WEAKER than the single nflverse
close (z 3.17 vs 3.46), not stronger. Both are solidly significant and the
difference between them is well within noise — but the a-priori
expectation ("a cleaner number should show a cleaner edge") did not
clearly pan out. Does not contradict the earlier finding that price/spread
SHOPPING (getting the best number across books, not averaging them) is
worth pursuing — that is still untested and is a different question from
this one.

**#5 referee tendency — a clean, honest null.** 851 referee-games across 17
crews with ≥25 games each, corrected for testing all 17 at once
(Šidák α=0.003, z required 2.97). Zero crews clear it; the best (Clay
Martin, 60% over) sits at z=1.41. No detectable individual-referee totals
bias in this sample. This is `refereeTotals()`'s own existing test,
unmodified — reused, not rebuilt, per Nick's ask to check the registry for
the right tool first. A spread-side (CLV) version of the same join was not
built tonight; the totals-only version is what already existed.

**#6 segments — the clearest actionable filter of the night, and it isn't
subtle.** Big spreads (>7 points): the edge is flatly zero (z=0.07,
essentially noise). Small and mid spreads: where the whole measured edge
actually lives. Read plainly: **this signal has something to say about
close, competitively-priced games and nothing to say about games the
market has already decided are lopsided** — which makes real football
sense, since a shift in perceived team strength moves a close number more
than it moves a blowout number. Season timing (early/mid/late) showed no
meaningful difference either way.

**What changes in the plan.** Two real, immediately actionable filters for
the composite/selective-betting work already queued in Phase 3 (items
8-9): restrict to spreads under roughly 7 points, and prefer games where
the underlying components agree with each other. Both are now
preregistered inputs to that phase's threshold search, not new ideas
invented after seeing favorable numbers. The new-coach finding is
preregistered as its own follow-up, explicitly because tonight's version
of it was exploratory. The failed calibration (#2) is a reason for caution
on the |lean|-based selective-betting hypothesis specifically — it is not
dead, but it needs a better probability model than a one-variable logistic
before anyone sizes a bet off it.

### CONFIDENCE META-MODEL — September 16, 2026, late night (a preregistered NULL; `scripts/confidence-meta-model.py`, raw output in `docs/evidence/2026-09-16/opener-clv/confidence-meta-model.json`)

**The question.** Earlier tonight we established that the ensemble's own
conviction — how far its composite margin sits from the opening line —
carries no information about whether the pick is right. Correlation between
edge size and ATS correctness was **r = −0.010** across 647 games, and still
−0.021 after stripping out early-season (weeks 1–3) and week-18 games. The
most-confident decile won 48.4%; the least-confident decile won 65.6%. The
direction is backwards and the magnitude is noise.

Before treating that as a finding, three candidate bugs were checked and all
three were ruled out:
- **One broken component inflating the edge?** No. In 63 of the 64
  most-confident games all four survivor signals agree on direction. The big
  edges are genuine agreement, not one wild number dragging an average.
- **Concentration in degenerate extreme-spread games?** No. Mean |opening
  spread| in the top-confidence group is 3.41 vs 3.65 for the pool.
- **Concentration in the noisiest weeks?** *Partly, and this part is real.*
  Weeks 1–3 are **36%** of the most-confident bucket vs **17%** of the pool;
  week 18 is **12%** vs **6%**. The model swings hardest exactly where its
  own inputs are thinnest. But removing those games does not rescue the
  result (r = −0.021, n = 502), so the skew is a genuine side finding, not
  the cause.

**What was built.** Nick's call: "yes build that" — a supervised meta-model
that predicts *whether a pick will be right*, from features richer than edge
size alone. Nine point-in-time-safe features: week, |opening spread|,
|lean|, dispersion across all components, dispersion across the four
survivors, direction-agreement fraction (all and survivors), whether the
drive sim agrees, and component availability count.

**Contamination guard.** Component `market_correction_research` is excluded
by id from every feature. Per `opener-clv-pass2.mjs`'s header it is the
Python `correction` model, whose feature list is `['football_prediction',
'market_spread', 'market_movement']` — it is handed the closing spread and
the opener-to-close move. Letting it into a dispersion or direction feature
would leak the exact quantity the primary target measures.

**Preregistered before any result was seen** (header of the script):
- Fit on 2022+2023 (525 games), test on 2024 (263 games), strictly
  chronological, no walk-forward re-fit, no hyperparameter search on test.
- The 4-bucket zero-skill CLV baseline is computed on **fit seasons only**
  and applied to test — a bettor in 2024 could only know 2022–23 drift.
- PRIMARY passes if held-out top-quartile double-adjusted CLV > 0 with
  week-clustered |z| > 1.96, Holm-surviving, and beating the bottom quartile.
- SECONDARY passes if out-of-sample AUC > 0.55 with a bootstrap 95% CI
  excluding 0.50.
- Explicit commitment: **if PRIMARY fails, report the null and do not
  feature-hunt to rescue it.**

**Result — it failed, and not narrowly.**

| Held-out 2024, quartiles by learned confidence | mean adj CLV | z | ATS |
|---|---|---|---|
| Q1 (model least confident) | +0.002 | +0.01 | 36.9% |
| Q2 | +0.060 | +0.26 | 61.9% |
| Q3 | +0.147 | +0.63 | 45.8% |
| Q4 (model most confident) | +0.125 | +0.45 | 49.3% |

Out-of-sample **AUC = 0.489**, bootstrap 95% CI [0.419, 0.559] — the learned
model is, if anything, a hair *worse* than a coin flip at separating correct
picks from incorrect ones. No quartile clears |z| > 1.96; none survives Holm
across the 3-test family. The ATS column is non-monotonic noise (Q2's 61.9%
sits between Q1's 36.9% and Q3's 45.8%; do not read it as signal).

**PRIMARY: FAIL. SECONDARY: FAIL. CALIBRATION: "PASS" on a technicality that
should be recorded as a criterion-design error on my part.** I preregistered
"positive reliability slope" without a magnitude floor. The realized slope is
**+0.005**, where 1.0 is perfect calibration — functionally flat. It cleared
the letter of the bar and nothing else. The honest reading is three failures,
not two; the criterion was too weak to mean anything and is noted here rather
than quietly counted as a win.

**A caveat that cuts the other way, stated so it is not buried.** The
`low_disagreement` reference signal — the one confidence-ish signal that
survived Holm earlier tonight at z=3.76 on the pooled 2022–24 set — reaches
only **z=1.24 (p=0.215)** on held-out 2024 alone. Its *direction is
consistent* (top quartile +0.248 pts adjusted CLV), and n=263 against ~817
is exactly the power loss you would predict, so this is **not** a refutation.
But it is also **not independent confirmation**, and it should stop anyone
(me included) from describing that filter as replicated. It has been
validated once, in-sample, on the pooled set. That is all.

**What this changes.** Nothing gets promoted. The plan's Phase 3 filters stay
exactly as preregistered — small/mid spreads and component agreement — and do
**not** gain a learned confidence tier on top of them. The standing conclusion
is now explicit and should not be re-litigated without new data: **this system
has a measurable edge signal but no working sense of when to trust itself.**
Selective betting by model conviction is a dead end at the current sample size
and feature set; any future attempt needs genuinely new information (live
market movement, injury-news timing, cross-book disagreement), not a
recombination of what the components already say.


### RECONCILED PLAN — September 16, 2026, night (supersedes FINAL ORDER's own internal ordering below it; FINAL ORDER's items and numbers are kept as a reference catalog, not deleted)

Nick, after the opener-CLV result: *"figure out a new plan and what the best
order to go in would be."* This section is that plan. It does three things:
says honestly which of the 25 remaining FINAL ORDER items (#5-#27; #1-#4 are
done) still matter now that the objective has partly shifted from "beat the
closing line on margin" to "capture value at the opener," folds the new
profit roadmap (from the opener-CLV report, chapter X) in at the right
points rather than bolting it on the end, and gives ONE ordered list.

**The one-sentence reason the old order needs revising, not scrapping.**
FINAL ORDER's data-mining block (#10-#19) is gated on "does this raise
effective rank / help the joint margin fit" — the OLD objective, the one
that lost 30+ times. Nothing about that objective is wrong to keep
measuring; margin accuracy still matters for the sim's distribution work
and for totals. But re-running #10-#19 against that gate alone, before the
CLV objective has its own permanent harness to gate against too, risks
re-discovering the same "does not help margin" null result for data that
might genuinely help TIMING instead — a different question nobody has
asked of most of this backlog yet.

**Reclassified, honestly, against two objectives (margin-MAE, the old one;
opener-CLV, the new one):**

| FINAL ORDER item | Still relevant to margin-MAE? | Relevant to opener-CLV? | Verdict |
|---|---|---|---|
| #7 small fixes (noVig, DEFAULT_CLOSING_BOOKS) | yes | yes — devig correctness feeds real bet pricing either way | **keep, near the front** |
| #17 coefficient dump | yes | yes — same "see what the model does" purpose | **keep, cheap** |
| #20 pymc/numpyro/mapie toolchain | yes | yes — conformal intervals apply to either target | **keep, cheap, unblocks later work** |
| #21 data-integrity checklist | yes | yes — a bad table hurts every objective | **keep, now mechanized, make it recurring not phase-gated** |
| #24 devig completeness | n/a | **yes, directly** — turns a signal into a real fair price | **promote — now on the critical path to placing a real bet** |
| #25 bet_attempts ledger + trial registry | yes | **yes, directly** — required for honest multiplicity on which selective-betting thresholds get tried | **promote — build this before the selective-betting test, not after #4-era** |
| #26 reliability-diagram auditor | yes | **yes** — checks whether the CLV signal's implied probabilities are calibrated, not just directionally right | **promote — build alongside the new harness** |
| #6, #18, #22, #23 (James-Stein pooling, TSFM pilot, paradigm enrichment, gated ideas) | yes | untested, unlikely (all target margin specifically) | **defer — re-visit only if CLV mining (below) turns up nothing better to do with the time** |
| #8 tree_lab cover head | yes | plausible — P(cover) directly is closer to a betting decision than margin is | **keep, but low urgency** |
| #9 measure the 3 wired challengers | yes | should be re-measured on CLV too once the harness exists | **fold into the new harness's first real run** |
| #10-#16, #19 (data mining: vector tables, player-week keys, raw JSON, cross-book dispersion, referee tendency, derived features, totals, nflreadr/charting) | yes | **unknown — never asked** | **defer until the CLV harness (Phase 2 below) exists, then re-gate on IT, not just margin rank** |
| #27 entity-resolution confidence | no | no (its consumer, Polymarket matching, is unrelated to this) | **stays last** |

**THE NEW ORDER. Six phases. Do not skip a phase's guardrail items to get to
its main event — that is exactly the discipline that made today's result
trustworthy instead of another false alarm.**

**Phase 0 — Finish the cheap defect/guardrail items already in flight (old FINAL ORDER, unchanged).**
Small, fast, needed regardless of which objective wins.
1. #7 small fixes: `nfl-total-calibration.js` naive `noVig` → `shinNoVig`;
   `nfl-execution-clv.js` `DEFAULT_CLOSING_BOOKS` real default, not `null`
   (checked 2026-09-16 night: both still open). *Done when:* both suites green.
2. #17 coefficient dump into every saved report.
3. #20 install `pymc`/`numpyro`/`mapie` in `research/.venv`.

**Phase 1 — Build the two pieces of infrastructure the profit roadmap needs
that don't exist yet, before touching the roadmap itself.**
4. **#25, pulled forward: `bet_attempts` ledger + trial registry.** Every
   candidate a selective-betting threshold test considers, not just what
   gets bet, needs a row — otherwise Phase 3's threshold search is exactly
   the un-corrected multiplicity problem #4 just fixed for the residual
   gate, recreated one level up.
5. **#26, pulled forward: reliability-diagram auditor.** Apply it to
   whatever probability the eventual bet-sizing step (Phase 5) will use —
   built once, reused by both the old correction-head interval and the new
   CLV-derived pick probabilities.
6. **NEW: promote `scripts/opener-clv-*.mjs` from a one-off analysis to a
   permanent, parameterized harness**, the same tier as `nfl-replay.js`/
   `ensemble-rank-report.mjs` for margin. Needs: an `npm run` entry, a fixed
   `--pool` default, and — this is the part that actually matters — the
   ability to grade ANY candidate signal (not just the five from today)
   without hand-editing the script. This is what turns "we found one edge"
   into "we can cheaply check whether anything else has one too," and it
   is the bridge that lets #9-#19 below get re-asked under the objective
   that actually paid off today.
7. **NEW: registry accuracy pass.** Three spot-checked rows in
   `MODEL-REGISTRY.csv` were wrong before this was written down —
   `market_correction_lookup` and `teamrankings_lookup` are both live and
   directly imported in `nfl-ensemble.js`, and `preseason_blend`
   (`blendedTeamRating()`) is live via `nfl-team-strength.js` and
   `nfl-audit-overview.js`; all three were tagged `research_only`. One
   check held up — `nfl_live_ledger` genuinely is dead code. Re-verify
   every `research_only`/`shadow`/`stub`/`unenforced` row (the ~25 flagged
   in the September 16 registry work) against an actual import/call site
   before this document's own "what's unused" claims are trusted again.

**Phase 2 — #24 devig completeness, promoted.** Any real bet needs a fair
price, and `nfl-devig.js` still only has 2-outcome Shin. Do this before
Phase 3's shopping step needs to compare prices across books honestly.

**Phase 3 — Cheap, historical-data-only tests of the profit roadmap's first
three levers (report chapter X, steps 1-3), in the order they were listed
there, now sequenced against the infra above:**
8. Fitted (ridge, preregistered) composite of the four survivors, tested
   against the equal-weight average from today on the same CLV harness.
9. Selective-betting threshold test: does CLV rise with |lean|, as the
   unconfirmed bins suggested? Preregister the thresholds tried before
   looking, log every one tried to the new `bet_attempts` ledger, correct
   with Holm across them.
10. Retroactive price/spread shopping: replay the composite's historical
   picks against the full 10-book archive already owned
   (`nfl_odds_archive`) and measure what shopping would have been worth,
   before building any live capture infrastructure. This is a pure
   measurement pass on data already on disk — cheapest possible validation
   of whether Phase 4 is worth building at all.
11. **NEW: the future-snapshot CLV re-test.** `nfl_line_snapshots` already
    holds lines captured from same-day out past 200 days before kickoff
    (`book-feeds.js` polls "this week and next" by design; one batch of
    Week 18 games was first captured in early August for a January
    kickoff). Repeat the double-adjusted opener-CLV test, but grade
    against the EARLIEST available snapshot per game instead of that
    week's own opener, binned by days-early. **Prediction, stated before
    running it:** the edge should be flat-to-larger as the snapshot gets
    more stale, not smaller — if a price six days old already shows this
    effect, a price posted before the season started should show it more,
    not less. A result that shrinks or reverses with staleness is real
    evidence against the mechanism, not something to explain away. No new
    infrastructure — a different join against data already on disk.
    *Gate:* if steps 8-11 together do not move the double-adjusted,
    Holm-corrected CLV meaningfully above where today's result left it, stop
    here and say so plainly — do not proceed to build live infrastructure
    for an edge that measurement says isn't there.

**Phase 4 — The expensive, slow levers (report chapter X, steps 4-5, plus
two items found alongside the live betting model), only if Phase 3's gate
passes.**
12. Real-time opener-capture infrastructure — new engineering, not yet
    scoped in detail; scope it once Phase 3 says it's worth building.
13. Forward paper-trade. This is the one step time cannot be saved on — it
    runs at the pace of the NFL schedule. Start it as early as Phase 3's
    gate allows, in parallel with anything below, because waiting for
    every other phase to finish first only delays the one truly honest
    out-of-sample test this project has never had.
14. **NEW: connect `live-edge.js`'s live event stream to the already-
    captured future-week lines.** A live-tracked event in one game (an
    injury, a blowout revealing a real weakness, a QB change) is a named,
    dated reason a specific FUTURE matchup's already-posted price might be
    stale — checkable the moment it happens, not after a week passes. Not
    yet built. Every flag it raises gets logged to the `bet_attempts`
    ledger (Phase 1, item 4) whether or not it's acted on, or the first
    time it works will look like magic instead of measurement.
15. **NEW: test the opener-CLV edge against Polymarket/exchange pricing,
    not only sportsbook spreads.** `live-edge.js`'s own validated
    numbers put Polymarket's median cost at 2.53% against a sportsbook's
    standard ~4.5% vig (−110). The entire reason the opener-CLV edge
    doesn't clear break-even today is that it's a hair under the bar; a
    materially lower bar is the single most direct way to close that gap,
    and it was sitting in code already built for an unrelated purpose.

**Phase 5 — Sizing and the ongoing discipline (report chapter X, steps 6-7).**
Only after Phase 4 shows the edge survives contact with a live market.
16. Fractional Kelly, sized off the same calibration auditor built in
    Phase 1 (item 5).

**Phase 6 — Revisit the deferred data-mining backlog, re-gated on the new
harness, not abandoned.** FINAL ORDER #9-#16, #19: re-measure the three
already-wired challengers and then the mining items on OPENER-CLV using
Phase 1's harness, not only on margin rank. Hunch worth recording before
testing it: cross-book dispersion (#13) and referee tendency (#14) are
about market microstructure and situational bias, not team strength — they
plausibly have more to say about timing than about final-score accuracy,
which is exactly the question nothing has asked them yet. #6, #8, #18,
#22, #23 (margin-paradigm work) stay parked behind this phase; revisit only
if Phase 6 comes up empty and margin accuracy becomes the more promising
lane again. #27 stays last, unrelated to any of this.

**What this deliberately does NOT change:** #3's enforcement decision stays
Nick's and stays deferred (see its own section above) — nothing in this
reconciliation reopens it. The historical-solidity priority Nick set
earlier today stands: Phase 0-2 above ARE that priority, finished first,
before Phase 3 touches anything that could become a real bet.

### FINAL ORDER — September 16, 2026 (supersedes the numbering above; original item numbers kept as references, nothing above is removed)

Produced by the gap analysis below. Rule for the order: **first, fix the
things that make our own measurements untrustworthy; second, the
guardrails; third, the zero-code and cheap wins; fourth, data mining; last,
new paradigms.** Items 17-24 are NEW from the research verification; the
rest are the roadmap items above in their final sequence. **Step-by-step
execution recipes for #1-#7 (files, verified line numbers, tests to add,
done-when) are in RUNBOOK.md §10; the operating rules any executing model
must follow are RUNBOOK.md §0a.**

| # | Do this | Was | Why here |
|---|---|---|---|
| 1 | **DONE 2026-09-16.** ~~Fix the production residual path's one-at-a-time fit.~~ `market_residual` computed `residual_slope`/`residual_weight` as 31 separate single-covariate OLS fits, never a joint fit (F02-1, verified) — the joint ridge existed for margin weights but the served residual path never got it. Built `jointResidualFit` (RUNBOOK §10.1), served by `ensembleLine` in place of the old path, old path kept as diagnostic only, fit version bumped to v13. Measured: still does not clear the gate (`rmse_gain: -0.008`, `dm_p: 0.9415`, n=749 OOF) — a stronger, not weaker, null result. Both suites green. | NEW (17) | Everything the residual gate has ever said (0/848) was said about a mis-fit path — now said about the correctly-fit one too |
| 2 | **DONE 2026-09-16.** ~~Fix the drive-sim's three VERIFIED-LIVE bugs~~ — (a) was already fixed and is now pinned by a regression test; (b) kneel sign + kneel clock and (c) simulateRemainder halftime/timeouts/overtime are fixed, with `simulateOvertime` extracted and shared rather than copied. 9 new tests in `test/nfl-drive-sim-clock-rules.test.js`, verified to fail against the un-fixed code. Backtest re-run recorded in Section B. **Two items deliberately left for Nick's decision, both flagged in code:** kneelDecision's first branch still reads a HALF clock where it wants a game clock (would stop first-half kneel-downs the sim currently performs), and HFA is still added to the score post hoc rather than entering per-play rates. *(original row, preserved:)* ~~**Fix the drive-sim's three VERIFIED-LIVE bugs** (CORRECTED same day — the first draft of this row named FIX_AND_ADD #9-#11; the verifier found #9 away-WP sign and #11 timeout decrement are already FIXED in code, and the +7 HFA coin flip is gone, replaced by +1 per drive at `nfl-drive-sim.js:544` — still additive-on-score, structural critique stands, key-number-spike claim superseded). Live now, verified 2026-09-16: **F01-2** urgency divides a half-scoped clock by 3600 (`nfl-sim-policy.js:229,:441`); **F01-3** `kneelable = 40 + timeouts*40` uses the OPPONENT's timeouts with the wrong sign and consumes the whole clock (`nfl-sim-policy.js:317-319`, `nfl-drive-sim.js:277-279`); **F01-6** `simulateRemainder` has no halftime/OT transition and hardcodes `timeouts:3/oppTimeouts:3` (`nfl-drive-sim.js:819-870`).~~ | NEW (18) | Hours each; the "measured dead 42.86% ATS" verdict was measured with these live — not clean until fixed and re-run |
| 3 | **DONE 2026-09-16.** ~~Extend the point-in-time leakage guard (`contracts.js assertTimestampedObservation`) past the fantasy pipeline onto `nfl_team_week_features`/`nfl_play*`/etc.~~ Built in `server/modeling/contracts.js` (the file this row named, `server/services/contracts.js`, does not exist — corrected in RUNBOOK §10.3). Mapped all five raw tables' actual clocks; measured 10,080 rows refused at a 2025 Week-5 cutoff. **Not enforced anywhere — that decision is Nick's and is explicitly deferred (see the note in its own section below); do not re-raise it without new information.**
| 4 | **DONE 2026-09-16.** ~~Multiple-testing guardrail, as corrected above: declared-family Bonferroni/Šidák now; plus Holm on the per-component DM gate (F02-5) and Giacomini-White conditional test as the cheap extension F02 names; DSR input standardization as its own prerequisite; F07-3 persist corrected_alpha_at_seal/prior_tests_at_seal.~~ Holm shipped on the residual gate (family 32, 0 raw passes, 0 corrected — a null result, changed no verdict); `giacominiWhite()` added beside `dieboldMariano`, reduces to it at h=[1]; migration 054 persists `corrected_alpha_at_seal`/`prior_tests_at_seal` on every sealed audit. DSR input standardization NOT done — still an open prerequisite, carried to the reconciled plan below. | guardrail section + NEW (20) | Must precede the mining spree |
| 5 | Zero-new-code win: wire what `nfeloFeatures()` already returns (`elo_diff`, `qbelo_diff`, tickets/money splits). **Decision recorded (cat-08, Section E item 1):** nfelo's plain `elo_diff` IS the independent-Elo sanity floor the 538 `nfl-elo-game` port was for; that port is superseded unless `elo_diff` proves unusable when measured in #9. | 3 | Cheapest real addition; retires a separate build |
| 6 | FIX #14, correctly targeted: cross-sectional James-Stein / method-of-moments EB pooling on `nfl-preseason-blend.js blendedTeamRating()` (F08-1 confirms it is not opponent-adjusted), gated behind `teamStrengthWalkForward`. Same technique on the correction-head coefficients. | 8 | The football input every downstream head stands on; the guardrail against V3-style creep |
| 7 | Small cheap fixes surfaced by verification: `nfl-total-calibration.js:37` uses a naive local noVig instead of `shinNoVig` (F03-3); `nfl-execution-clv.js DEFAULT_CLOSING_BOOKS = null` (F04-3); `homeFieldPoints=1.6` hardcoded in the drive-sim while nfelo's `hfa_mod` is already synced (cat-07); stale `nfl-ensemble.js:2501` comment says "nine challenger-only" (now 21). | NEW (21) | Each is minutes-to-hours and each is a known-wrong number in a live path |
| 8 | Finish `tree_lab`'s cover/quantile head. | 6b | The one paradigm never finished |
| 9 | Measure the 3 wired challengers (nfelo_rating, nfelo_qb_adjustment, teamrankings_predictive). | 6 | Wired, unverified |
| 10 | Wire `nfl_team_feature_vectors`/`nfl_player_feature_vectors` with PCA/sparsity on top. | 1 | Largest already-built unused asset |
| 11 | `nfl_player_week_features` unused keys; `nfl_pfr_adv` pass/rec + remaining def keys. | 4, 5 | Same free-data shape |
| 12 | Raw 183-key team JSON mining (fallback to 10). | 2 | — |
| 13 | Cross-book dispersion from `nfl_odds_archive` (10-11 books). | 7 | — |
| 14 | Referee tendency from `nfl_officials` + `game_lines`. | 9 | — |
| 15 | The zero-new-data derived-feature batch (travel via `nfl_stadiums`, surface, coaching tenure, key-number distance, RLM, clinch flag, return-from-injury rust). | 10 | — |
| 16 | Totals: **(a)** GAS dynamic bivariate Poisson/Skellam — with the footBayes (Stan MCMC) full state-space model recorded as the heavier COMPARISON, not the first build (GF04 contradiction, resolved: GAS first on Koopman-Lit's own head-to-head evidence); **(b)** weather forecasts × pass-rate interaction. | 11 | Totals has had no model |
| 17 | Correction-head coefficient dump into every saved report. | 12 | Permanent "double click" |
| 18 | Chronos-2/TimesFM zero-shot cold-start pilot on the team-strength blend (N01-2/GN01-1) — the one N-item the research itself calls hours-scale and cheap; sequence strictly after #6. | NEW (22) | Cheap, gated, honest exception to the "no big ML" verdict |
| 19 | `nflreadr` combine/draft/contracts; `nfl_play_charting` aggregation (check FTN ingestion stores all 29 fields first — N15-3 unverified). | 13, 14 | — |
| 20 | `pymc`/`numpyro` **and `mapie`** (FIX #26, gf08 — the independent conformal cross-check, still not installed) in `research/.venv` (F09-3) — prerequisite for hierarchical props/dispersion work, footBayes, and for cross-checking every conformal number this plan reports. | NEW (23) | Infrastructure, not a model |
| 21 | Recurring data-integrity checklist (schema drift, batch timestamps, dup tags, coverage trend, unused tables, JSON-blob keys, duplicate formulas) as its own pass, **mechanized (added September 16 per Nick's concern about a repeat of the Sept-15 unused-table surprise):** a `scripts/data-lineage-inventory.mjs` that enumerates every `nfl_*` table + every JSON-blob key + every exporter field, greps the live pick path (`nfl-ensemble.js`, `nfl-auto-picks.js`, `player-week-engine.js`) for readers, and writes a dated `no-reader` report under `docs/evidence/`; run on a schedule (weekly cron or before each FINAL ORDER item that touches a new data source) and diffed against the prior run so a newly-unused table is caught within a week, not a session. See RUNBOOK §10.9. | 15 | Standing |
| 22 | "Enrich every paradigm, then let diversity decide" — with N06's nuance recorded: classical value-iteration over the drive-sim's OWN transition model is not data-starved the way a learned policy is, so it is an admissible experiment inside this item, unlike neural RL. | 16 | Last, needs 5-15 done |
| 23 | Low-priority, gated, recorded so it is not lost: the one small drive-outcome transformer FIX_AND_ADD §(e) gives a qualified go-ahead to (N03/GN03); a jointly-fit continuous gate for the expert coordinator (N12-4) as an alternative to folding it into `forecast-combination.js`; NGBoost/MDN distribution head (N10/GN06) once a real distributional-shape weakness is shown. | NEW (24) | Real ideas with real evidence, all behind measured gates |
| 24 | **Devig completeness** (cat-09, cat-18, gf03): `nfl-devig.js` has 2-outcome Shin only. Add `powerDevig()` and N-outcome Shin, then port `penaltyblog`'s 7-method dispatcher and run our own historical closing lines through all 7 to pick one WITH evidence, not by default. Slot: with FINAL ORDER #7 (it is the same file family as the `nfl-total-calibration.js` noVig fix). | NEW (25, catalog) | Every cover/total probability the pick path emits passes through devig; a second method is the only way to know the first is right |
| 25 | **Multiplicity needs a record of everything tried** (gf05 `bet_attempts` ledger; gf10 full `research_studies`/`research_trials`/`research_trial_corrections` schema with the DB-enforced `scored_at >= declared_at` trigger). Slot: part of #4 — Holm over "what was placed" is not Holm over "what was tried." | NEW (26, catalog) | The correction is only as honest as its denominator |
| 26 | **Reliability-diagram auditor** (cat-19, ~30 lines from NFLWin's KDE pattern) applied to the correction head's own `interval_80` AND to `calibratedCoverProbability`. Slot: with #17 (coefficient dump) — same "see what the model actually does" purpose. | NEW (27, catalog) | Directly closes the "correction-head interval never checked" gap found on Sept 16 |
| 27 | **Entity-resolution confidence score** (cat-14 splink, gf07): `eventKey()`/`contractKey()` are binary exact-or-fail-closed. Add a hand-tuned Fellegi-Sunter log2(m/u) score (team exact/fuzzy/miss, date exact/off-by-one/miss) as a LOGGED layer, no behavior change until measured. Slot: track E, after #21's first run — its main consumer (Polymarket-tape matching) is deferred, so this is robustness, not signal. | NEW (28, catalog) | Silent `unresolved_team` failures become countable |

**Dependencies — do not start X until Y is done (added same day at Nick's request).**
Numbers are FINAL ORDER numbers. "Build" and "trust the result" are
separated on purpose: several items can be *built* early but their numbers
must not be *read as final* until the guardrails land.

| Item | Do not START until | Do not TRUST its numbers until | Parallel track |
|---|---|---|---|
| 1 joint residual fit | — (start now) | 4 (Holm/GW) — the gate verdict is provisional before that | A defects |
| 2 drive-sim live bugs | — (start now) | all three fixes + the HFA structural fix are in, then ONE re-run of `backtest()` — never re-run after each partial fix | A defects |
| 3 leakage guard extension | — (start now) | — (it is the thing that makes other numbers trustworthy) | A defects |
| 7 small fixes | — (start now) | — | A defects |
| 4 multiple-testing (Holm, GW, persisted alpha) | — (start now) | — | B guardrails |
| 17 coefficient dump | — | — | B guardrails |
| 21 data-integrity checklist (first run) | — | — | B guardrails |
| 5 nfeloFeatures unused fields | — (build now) | 4 | C cheap wins |
| 6 FIX #14 James-Stein pooling | 3 (guard covers `nfl_team_week_features`) | 4, and `teamStrengthWalkForward` ≥2/3 seasons | C cheap wins |
| 8 tree_lab cover head | 3, 4 | 4 | C cheap wins |
| 9 measure the 3 wired challengers | 3, 4 | 4, and the rank report re-run (§3.4) | C cheap wins |
| 10 vector tables + PCA/sparsity | 3, 4, 6, 17, 21 (first run) | rank report re-run showing effective rank actually rose | D mining |
| 11 player_week keys; PFR pass/rec + def keys | 4, 17 | rank report re-run | D mining |
| 12 raw 183-key JSON mining | only if 10 fails its quality check | rank report re-run | D mining |
| 13 cross-book dispersion | 1, 4 (it is a residual-side feature) | rank report re-run | D mining |
| 14 referee tendency | 4 | rank report re-run | D mining |
| 15 derived-feature batch | 4 | rank report re-run | D mining |
| 18 TSFM zero-shot pilot | 6 | 4 | D mining |
| 19 nflreadr ingest; charting aggregation | 4; N15-3 field-count check before aggregating | rank report re-run | D mining |
| 16a GAS joint-scoring (totals) | 3, 4 | walk-forward CRPS/log-loss gate vs champion | E paradigm/infra |
| 16b weather×pass-rate for totals | 4 | same gate as 16a | E paradigm/infra |
| 20 pymc/numpyro toolchain | — | — | E paradigm/infra |
| 16 footBayes comparison | 16a measured, 20 | CRPS/log-loss vs 16a | E paradigm/infra |
| 22 enrich every paradigm | 5-15 individually measured, rank re-run | RUNBOOK §5 rule on the NEW rank number | E paradigm/infra |
| 23 gated ideas (transformer, MoE gate, MDN head) | 22's rank result | their own gates | E paradigm/infra |
| 24 devig completeness | — (build with 7) | historical-closing-line comparison across all methods | A defects |
| 25 bet_attempts ledger + registry schema | — (build with 4) | — | B guardrails |
| 26 reliability-diagram auditor | — (build with 17) | — | B guardrails |
| 27 entity-resolution confidence score | 21 first run | measured false-positive rate on a held-out slate | E paradigm/infra |

**Hard rules that the table encodes:** nothing enters the live blend on a
per-component test alone (F02) — only after the rank report re-run shows it
raised effective rank AND §6 passes on a new window; no accuracy number
produced before 3 and 4 land is cited as final; the drive-sim is re-measured
once, after all its fixes, not incrementally; tracks A and B run first and
in parallel, C starts as soon as 3 and 4 are in, D after C's rank re-run, E
last.

### DATA SOURCES, ENDPOINTS AND LINEAGE — verified September 16, 2026

Built by six read-only mapping agents (two results taken from the earlier
run as ground truth per Nick; four from the completed run), every claim
grep- or sqlite-verified. Full per-table detail (writer, external source,
receipt clock, every reader, row counts) is in the run output at
`/private/tmp/claude-501/-Users-nick-matta-Claude/d6558473-2a7e-474b-9143-33f11accc626/tasks/wntbutrvx.output`
(656 KB; copy it into `docs/betting-model/research/experiment-results/`
before the scratch directory is cleared). What matters, condensed:

**The live pick path, exact (cited in the run):** `routes/nfl-market.js:450`
`autoPickDecisionBoard(season, week)` (also `scheduler.js:751` job
`nfl_decision_ledger`) → `nfl-auto-picks.js:83-95` (`blendMode:
'market_residual'`, `includeChallengers` undefined → champion mode) →
`computeDecisionBoard` `:97-112` (prices from `game_lines`) →
`ensembleWeek` → `ensembleLine` `nfl-ensemble.js:2075-2319`
(`includeChallengers=false` `:2077`; `fitEnsemble` `:2139` from
`nfl_ensemble_fit_artifacts` or recompute; ctx from `game_lines`,
`nfl_team_week_features` via `featureAggregates :419`, `availabilityDeficit
:1244` [`nfl_injuries`/`nfl_snaps`/`nfl_pfr_adv`], `rosterStrengthWeek :1247`
[`nfl_depth`], `marketCorrectionMargin :2199` [json lookup], `nfeloFeatures
:2200` [`nfl_nfelo_games`/`lines`/`qb`]) → `blend() :2234-2250` →
`residualMargin :2252-2256` = market verbatim when no residual weight →
`nfl-auto-picks.js buildCandidate :125-253` (`shinNoVig`,
`calibratedCoverProbability`, `promotedFindingVeto`) → `applyNflPolicy` →
`ensurePicksFor :42-51` → `INSERT INTO nfl_auto_picks`. **35 MODELS entries:
14 live** (colley, melo, dynamic_state, epa_neutral, success_rate, explosive,
drive_eff, situational, trenches, recent_form, pace_total, weather_total,
market_anchor, market_regression), **21 challenger-only.** Comment at
`nfl-ensemble.js:2502` still says "nine challenger-only" — stale, fix.

**Outbound endpoints this app pulls from (verified literals):**
- nflverse GitHub: `github.com/nflverse/nfldata/raw/master/data/games.csv`
  (`gamescript.js:23`, historical `game_lines`), per-season releases for
  play-by-play (`nfl-pbp.js`), injuries/snaps/pfr_advstats/depth_charts
  (`nfl-advanced.js`), QBR `espn_data/qbr_week_level.csv` (`nfl-qbr.js`),
  ffopportunity (`ffopportunity.js`), draft/combine (`nfl-rookie-ingest.js`),
  FTN charting `ftn_charting_{season}.csv` (`nfl-formations.js:97`).
- ESPN: `site.api.espn.com/.../scoreboard` (`gamescript.js:24`, current
  spread/total/open/moneyline into `game_lines`), summary API (PBP), FPI JSON
  (`nfl-external-ratings.js`), transactions, news, rosters.
- Market: The Odds API `api.the-odds-api.com/v4` (`odds-api.js:17`,
  metered); SportsGameOdds `api.sportsgameodds.com/v2` (`sportsgameodds.js:31`);
  direct scrapes — Oddstrader odds-v2 (`book-feeds.js:353`), Pinnacle guest
  API (`:358-359`), Kambi/BetRivers (`:364`), Bovada (`:366`), FanDuel
  (`:346`), Rotowire (`book-feeds-extra.js:206`), SportsbookReview (`:210`);
  Oddstrader archive scrape (`odds-archive.js`); Action Network + Underdog
  (props, `prop-feeds.js`); Kalshi trade API (`prediction-markets.js`,
  588k rows); Polymarket Gamma/CLOB (`polymarket.js`, 22.3M rows).
- greerreNFL GitHub CSVs (`nfelo.js:38-45`): nfeloqb `qb_elos.csv`, nfelo
  `output_data/nfelo_games.csv`, `historic_projected_spreads.csv`,
  nfelomarket_data `Data/lines.csv`, Stadiums `stadiums.csv`/`team_stadiums.csv`.
- TeamRankings predictive-ratings HTML (`nfl-external-ratings.js`);
  Open-Meteo previous-runs API (`nfl-weather-history.js`); dynastyprocess
  `db_fpecr.csv.gz` (ADP); RSS + ESPN news + TwitterAPI.io (news); YouTube
  via yt-dlp (press conferences); CollegeFootballData API (key-gated, 0 rows).

**Scheduler jobs (`scheduler.js`): ~55.** Feeding the live pick path
directly (`reaches_live_pick`): `nfl_lines` (ESPN → `game_lines`),
`nfelo_sync`, `nfl_injuries`, `nfl_offseason_depth_injury`, `nfl_coaches`,
`espn_rosters`, `nfl_t60_runner`, `nfl_decision_ledger`. Feeding forecasts
but not the served pick: `nfl_line_snapshots`, `nfl_sgo_snapshot`,
`nfl_book_feeds_fast/slow/extra`, `nfl_learned_shadow`. Captured and
consumed by nothing that forecasts: `prediction_markets` (Kalshi, 588k),
`polymarket` (22.3M), `polymarket_line_watch`, `espn_line_watch`,
`beat_the_close`, `nfl_prop_capture`/`nfl_prop_clv_free`, `press_conferences`,
`twitter_insiders`, `nfl_forecast_history` (weather), `ffopportunity`,
`nfl_external_ratings` (espn_fpi half). Inbound HTTP: **528 route handlers
in 28 files; 18 serve an NFL pick/forecast** (all in `nfl-market.js`,
`nfl-betting.js`, `betting-hub.js`); 57 trigger a sync/capture; the rest are
CRUD/audit/admin.

**Anomalies the map found (all verified):**
- `game_lines` has **two writers**: `gamescript.js` (primary) and
  `odds-archive.js:149,153` backfilling `open_spread`/`open_total` from a
  Pinnacle-derived Oddstrader median — a path that had a sign-corruption bug
  for 2022-2025 rows (migration `047_backfill_open_spread_pinnacle_2022_2025.js`).
  `market_movement` in the research pipeline is built from these columns.
- `nfl_line_snapshots` has **five writers** with different `provider`
  labels and a receipt clock (`received_at`) that migration 052 documents as
  a *constant* for archive-sourced rows.
- **No receipt clock of our own** on `nfl_team_week_features`, `nfl_snaps`,
  `nfl_pfr_adv`, `nfl_depth`, `nfl_injuries` (only nflverse's `modified_at`,
  null for 2025-26) — the five tables the frozen 14 and the availability
  signal are built from. This is why FINAL ORDER #3 is where it is.
- `nfl_external_ratings` `espn_fpi`: `fpi_diff` is computed
  (`nfl-external-ratings.js:260`) and consumed by nothing.
- `nfl_team_coaches` reaches the ensemble ctx (`nfl-roster-strength.js:362`)
  as metadata only — no `predict()` reads it numerically.
- `historical-adp-scrapes.js` writes `nfl_historical_adp_scrape` under a
  `recordSync` name that is in neither `MANUAL_SOURCES` nor `JOBS`.
- `nfl_prop_quote_snapshots` is 100% `underdog` in the live DB — the Odds
  API and Action Network prop paths currently write zero rows.

### GAP ANALYSIS — research vs. current model vs. this plan, September 16, 2026

Inputs: the lineage map above; 246 research claims across 6 note families
and the primary papers, each grep-verified against the live tree (status:
109 open, 99 done, 14 superseded, 9 wrong_file, 7 not_applicable, 8
unverified); the two documents read in full by the main session
(`FIX_AND_ADD_ARCHITECTURE.md`, `F15`). Nothing below removes a measured
result from this plan; it revises what to do about them.

**Verdict on the plan: it stands, re-ordered, with four structural
additions — not a restructure.** The shape (frozen-14 football model →
ridge correction head → JS ensemble joint fit → market_residual gate →
market verbatim) is defensible and the research's own recommended
architecture (`FIX_AND_ADD` §(f)) matches its bones: one point-in-time data
layer, one signal registry, one combiner chosen by a correlation/PCA
reduction step first, one promotion ladder, one evaluation harness. Where
the research disagrees with the plan, it is about *what owns team strength*
and *how the served residual is fit*, not about the layering.

**The structural findings (what the research says the model should have
that it does not):**

1. **No dynamic state-space owner for team strength.** Glickman-Stern 1998,
   Glickman 2001, Szczecinski-Tihon 2021 all prescribe that ratings come from
   a formal dynamic paired-comparison process with explicit week-to-week and
   season-to-season variance and derived update rules. This plan's inventory
   classifies every rating source (`nfelo.js`, `nfl-team-strength.js`,
   `nfl-external-ratings.js`) as "inputs to 1 and 3, not stacks" and has no
   L-layer owner for the rating process itself. Resolution: FINAL ORDER #6
   (James-Stein/EB pooling on `blendedTeamRating`) is the cheap, evidenced
   first step the research itself ranks first (FIX #14, "cheapest,
   highest-confidence"); the full state-space model (footBayes Stan port,
   GF04; Kalman per Szczecinski-Tihon) is the later comparison. **Record in
   the L1 row of the target-architecture table that "rating process" needs
   one owner** — done below in place.
2. **The served residual path is not the joint fit the plan describes.**
   F02-1, verified: `market_residual` builds `residualMargin` from 31
   separate single-covariate OLS slopes, one model at a time. The joint ridge
   (`jointComponentWeights`) fixes margin weights only. Every statement this
   plan makes about "0 of 848 residual gate passes" describes that
   one-at-a-time path. FINAL ORDER #1. **DONE 2026-09-16:** built
   (`jointResidualFit` in `nfl-ensemble.js`, RUNBOOK §10.1), tested (7 pure
   unit tests + 2 existing integration tests re-verified + 1 new
   model-integrity assertion, `test/nfl-ensemble-joint-residual.test.js`),
   and measured against real history (RUNBOOK §3.3) — the joint fit also
   does not clear the gate (`rmse_gain: -0.008`, `dm_p: 0.9415`). Fit
   version bumped to v13 so no stale artifact is reused.
3. **DM is being used as a model-adjudication and promotion mechanism;
   Diebold's own 2012 retrospective says DM-type tests are for comparing
   forecasts, not adjudicating between models, and Giacomini-White 2006
   prescribes testing *conditional* predictive ability of the method
   (model + estimation window). F02 already names the cheap extension
   ("swap scalar ΔL for h_t·ΔL_t, proper HAC Ω̂"). Resolution: keep DM as a
   *comparison*, add GW conditional as the promotion test, and apply Holm
   across the ~31 components (F02-5). FINAL ORDER #4.
4. **F02's do-not-do — "do not add more models to the ensemble... adding
   models without addressing collinearity makes the simplex QP more
   degenerate" — versus this plan's roadmap wiring several new challenger
   components.** Not a real conflict, but it needs stating: the plan adds
   signals as `challengerOnly` (excluded from the blend by construction) and
   measures rank before combining; F02's warning is exactly why FINAL ORDER
   keeps rank measurement and pruning ahead of any combining, and why the
   feature-vector work (#10) is PCA/sparsity first. The rule to write down:
   **a new component enters the live blend only after the rank report shows
   it raised effective rank, never by clearing a per-component test alone.**

**Contradictions between research notes and this plan, and how each is
resolved (12 recorded by the verifiers; 11 unique):**
- GF02/catalog #12 (port nfelosrs single-unit conjugate update) vs. this
  plan's Sept 16 correction (cross-sectional James-Stein) → **plan wins**;
  F15's Brown 2008 evidence is the reason; catalog item marked superseded.
- GF04 (footBayes full MCMC as PRIMARY port) vs. plan's GAS choice → **GAS
  first** on Koopman-Lit 2019's own head-to-head (1/360th compute), footBayes
  recorded as the heavier comparison in FINAL ORDER #16 and #20 (pymc).
- N06 (tabular value-iteration over the drive-sim's own transition model is
  NOT data-starved) vs. `FIX_AND_ADD` §(a)'s blanket RL verdict → **nuance
  accepted**; recorded inside FINAL ORDER #22.
- N03/GN03 (one small drive-outcome transformer, qualified go-ahead) absent
  from roadmap → **added, low priority, gated** (FINAL ORDER #23).
- N10/GN06 (distributional head is near-term) vs. plan ranking it lower →
  **plan ordering kept**, but the underlying fact is recorded as a real open
  defect: `predictiveDistribution()` (`nfl-ensemble.js:336-401`) is a
  resampled residual cohort that self-labels `research_distribution_only`,
  not a model. FINAL ORDER #23.
- N13 F3 (Kalman update triggered by validated injury shocks on
  `blendedTeamRating`) vs. plan's James-Stein on the same function →
  **compatible, sequenced**: pooling first (#6), shock-triggered dynamics
  belong to the state-space item.
- N12 (jointly-fit continuous gate for the expert coordinator) vs. plan's
  "fold coordinator into `forecast-combination.js`" → **both recorded**;
  rank says prune first; N12's gate is the alternative if the specialist
  layer is retested with new data and survives (FINAL ORDER #22/#23).
- dm-20yrs-later / giacomini-white → structural finding 3 above.
- Glickman/Stern/Szczecinski → structural finding 1 above.
- F02 do-not-do → structural finding 4 above.

**Errors found and corrected (the "issues like FIX #14" question):**
- 9 `wrong_file` flags; **2 are true wrong-file errors**: F17-4 (state-space
  fix aimed at `nfl-team-strength.js`, which `nfl-ensemble.js` never imports
  — real target is `nfl-market.js fitModel()/simulate()` and
  `nfl-preseason-blend.js`) and N13-1 (functions attributed to
  `player-availability.js` live in `contingency.js`). The other 7 are
  line-number drift from ~1,000 lines of growth since Sept 12; substance
  intact.
- **N13-1 resolved, and it does not contradict tonight's injury null:**
  `contingency.js:93-112` documents MAE 4.748 → 3.71-3.66 on 326
  Questionable player-weeks — that is a *fantasy weekly-opportunity* target
  (consumers: `player-week-engine.js`, `trade-engine.js`, `season-sim.js`,
  `role-scenario-*`), not game margin. Different target, no conflict; but it
  is a validated availability discount the game-side `availabilityDeficit`
  does not reuse — recorded under RUNBOOK §4.1b's cross-wiring item.
- 14 `superseded`: code moved past the note; no action.
- **The 8 `unverified` items: none matter to the spread model now.** All
  low relevance. Two worth a one-line note when their area is touched:
  N15-3 (FTN charting ingestion may store 12 of 29 available fields — check
  before FINAL ORDER #19 aggregates it) and N17-7 (the weather-sensitivity
  significance test at `nfl-ensemble.js:596-611` is a between-team spread vs
  noise test, not week-clustered — real but low stakes because the component
  falls back to the flat constant unless significant). The rest are
  licensing (TimesFM 3.0), line drift, fantasy transparency, and Polymarket
  table locations.

**What the research confirms the plan already got right (recorded so it is
not re-litigated):** prune-not-combine after rank ≈2.5 (F02: "correlation/
PCA reduction before any weight optimization"); no GP/MoE/deep-generative/
neural-RL at this data volume (five independent researchers, matches V3's
own evidence); Kalshi/Polymarket deferral (N14: best real-world number is
$210-560 total across an NBA month; 588k Kalshi + 22.3M Polymarket rows are
captured and consumed by nothing — leave them); split-conformal over the
`disagreement/30` hack (done, FIX #15/#18); CLV consolidation (done, FIX #28);
the challengerOnly discipline; the audit's preregistration/accounting
fixes this session.

**Avoid-list check (GITHUB_BUILD_CATALOG): clean.** The verifier confirmed
nothing on this roadmap proposes an avoid-listed repo (lag-llama, EnbPI,
soccer-physics engines, garbage-time-excluded samples, no-OT engines). It also
found six MORE "already fixed since Sept 12" cases beyond the three known
(turnover field-position flip, half-vs-game clock split via `gameSecondsLeft`,
HFA as per-drive nudge, away `posteamSpread`, deterministic kneel outcome,
Polymarket join key routed through `eventKey()`) — the drive-sim has moved
further than any note records.

**Status of the 99 "done" items:** real progress since Sept 12 — the
research's fix list is roughly 40% landed. The 109 "open" items are
backlog, not errors; the 44 marked high-relevance are folded into FINAL
ORDER above (by item id, all traceable in the run output).

### MODEL INVENTORY AND ORGANIZATION — September 15, 2026 (evening)

Built by reading every prediction-shaped module in the tree, not by trusting
names. Two corrections to this document's own earlier claims come first.

**Correction 1 — "no betting head exists" was wrong.** Earlier in this
document (Phase 1 and "The separate labs") I wrote that nothing learns the
correction to the market. I had searched the Python side and
`nfl-ensemble.js`, not the specialist layer. `nfl-specialists.js` (619
lines) predicts the market residual with a meta-model; `nfl-orthogonal-
specialists.js` orthogonalizes families against market + earlier families
with chronological shrinkage; `nfl-matchup-specialists.js` adds four
residual ridge regressions; `nfl-expert-council.js` (893 lines) audits 19
experts weekly, 15 of them scoring `market_residual`, including
`boosted_tree`, `deep_residual` (`nfl-online-neural.js`), `line_movement`,
`nfelo_line`. So Phase 1's `market_correction.py` is the **fourth**
implementation of "predict the market residual," not the first. It is
narrower (three features) and lives in a different language. It stays
useful for one reason: it is the only one wired into the path that reaches a
pick (see below). But it is a duplicate at the concept level and this
document must say so.

**Correction 2 — the gate question has a measured answer.** The residual
gate is `residual_n >= 250 && residual_rmse_gain >= 0.03 && DM p <= 0.05`,
fit on an earlier block and scored on a later ~59-week block. Those
thresholds are mild. The Sept 12 sweep recorded, and I re-derived on today's
extract, that across **848 persisted fit artifacts / 26,288 component-cutoff
rows, `residual_gate_passed` has never once been true** — all three Market
components fail on `rmse_gain` (0, 0, −0.051): none reduces the market's
residual RMSE out-of-fold at all. The gate is not the problem. Nothing has
residual skill on these windows. That matches the Python audit (correction
MAE 9.913 vs market 9.779) and `nfl-specialist-audit.js`'s own title, "Why
none of the twelve clears breakeven." The 24-point interval-width gate in
`staking.js` remains separately unjustified.

**The one decision path, confirmed by import graph.**
`nfl-auto-picks.js` → `ensembleLine(blendMode:'market_residual')` → residual
gate (0/848 pass) → **returns `marketMargin` verbatim** (`is_market_identity`
= true) → `calibratedCoverProbability` → `nfl-execution-edge` gates → pick.
Every other prediction stack below is a displayed head, a research artifact,
or an input. The served spread forecast has been the market line by
arithmetic at every cutoff that ever shipped.

**Inventory — every NFL-betting prediction stack, what it targets, and
whether it can reach a pick:**

| # | Stack | Files | Target | Reaches a pick? | Measured status |
|---|---|---|---|---|---|
| 1 | Ensemble | `nfl-ensemble.js` — 32 components (10 challenger-only) **(CORRECTED September 16: now 35 components, 21 challenger-only, 14 live — see lineage section)**, joint ridge fit | raw margin/total → `market_residual` mode | **Yes — the only path** | 0/848 residual gate passes; serves market verbatim |
| 2 | Specialist/residual layer | `nfl-specialists.js` (12 + meta-model), `nfl-orthogonal-specialists.js`, `nfl-matchup-specialists.js` (4), `nfl-passing-specialists.js` (20) | market residual | No — feeds the council only | "none of the twelve clears breakeven" |
| 3 | Expert council | `nfl-expert-council.js` — 19 experts | market residual (15), score distribution (1), other | No — a head in the UI orchestrator + the explain tool | weekly audited; consumes `ensembleLine` and the drive-sim |
| 4 | Canonical orchestrator | `nfl-unified-engine.js` + `gridiron-model.js` (authority) + `nfl-drive-sim.js` (shape) | reconciled distribution | No — the `/nfl-betting` route only | simulator ~~measured dead: 42.86% ATS~~ **re-measured 2026-09-16: 52.14% ATS / 491 games, still under the 52.38% breakeven and no detectable edge; the 42.86% has no recorded provenance (Section B)** |
| 5 | Market model | `nfl-market.js` | win/cover/total probability vs no-vig | Via `betting.model_spread` → cover calibration | `normalCdf(margin/pooledSD)` — FIX #15/#16 still open |
| 6 | Python research group | `stage3` → `unified_model.py` → `market_correction.py` → lookup → ensemble component | raw margin; residual | **Now yes, as challenger (gated)** | 16.2% margin weight, 0 residual weight |
| 7 | Labs | `tree_lab.py` (cover/quantile/movement), `market_lab.py`, `book_lag_lab.py` | various | No | research only |
| 8 | Rating inputs | `nfelo.js`, `nfl-team-strength.js`, `nfl-external-ratings.js` | ratings | Inputs to 1 and 3, not stacks | — |
| 8b | **(CORRECTED September 16, gap analysis)** Rating *process* | none today — `blendedTeamRating()` in `nfl-preseason-blend.js` is the closest thing (single-unit shrinkage, not opponent-adjusted, F08-1) | dynamic team strength | No | Research (Glickman-Stern, Glickman 2001, Szczecinski-Tihon) says this needs one formal owner; FINAL ORDER #6 first, state-space later |

**Duplications, ranked by what they cost:**

- **D1 — four residual predictors** (ensemble Market family / specialists +
  orthogonal / council experts / Python head). One reaches the pick and it
  serves the market. The other three are graded, audited, and displayed, and
  cannot influence a number. This is the core disorganization.
- **D2 — six combiners:** `jointComponentWeights` (ensemble),
  `forecast-combination.js` (1,164 lines, DM-gated, week-clustered — the most
  rigorous, and **fixture-only**: every stored result is
  `forecast-combination-fixture-*.json`), the specialist meta-model, the
  council coordinator, `unified_model.py`'s simplex blend,
  `gridiron-model.js`'s inverse-variance `consensus()`.
- **D3 — four forecast walk-forwards** that "refit chronologically and grade
  margin": `nfl-replay.js` (1,494 lines, the incumbent training loop),
  `weekly-walkforward.js` (football-first, ATS), `unified_margin_audit.py`,
  `stage3.run_expanding_folds`. (`nfl-execution-replay`, `nfl-ai-replay`,
  `nfl-props-replay`, `purged-walk-forward`, `modeling/walk-forward` are
  legitimately distinct — execution fills, Claude gate, props, purge rule,
  fantasy — and stay.)
- **D4 — eight registry/identity modules** (`nfl-engine-registry`,
  `modeling/registry`, `model-governance`, `nfl-forecast-identity`,
  `model-intelligence`, `model-signal-quality`, `nfl-model-growth`,
  `nfl-model-watch`). FIX #32/#36 already flagged the 37-file
  content-addressing sprawl and the audit layer never using `ModelRegistry`.
- **D5 — two things named "unified"** (`nfl-unified-engine.js`,
  `unified_model.py`) that are unrelated. Rename the Python one.
- **Not duplicates, keep:** the five calibration files (`cover`, `total`,
  `prop`, `sim`, `sim-shape`) calibrate five different quantities.

**Target architecture — the standard quant stack, mapped onto modules that
already exist.** The rule: one module per layer, everything else either
becomes an input to that layer or is retired into a report.

| Layer | One owner | What folds into it | What retires |
|---|---|---|---|
| L0 Point-in-time data | `dataset.py` + `nfl-bitemporal.js` + `nfl_feature_revisions` + T-60 packets | (already one chronology) | — |
| L1 Signal registry (+ one owner for the rating PROCESS — added September 16, see gap analysis structural finding 1) | `nfl-engine-registry.js` + `model-signal-quality.js`, extended so every signal has `{id, target: residual\|margin\|prob, cutoff, out-of-fold predictions, evidence_id}` | all 32 components, 19 experts, 12 specialists, `tree_lab` cover head, Python heads, nfelo/team-strength/external ratings — same contract | `modeling/registry.js` for betting; `nfl-model-growth`/`model-watch` become jobs over the registry |
| L2 Combination | `forecast-combination.js` (the rigorous one), fed by L1 | `jointComponentWeights`, specialist meta-model, council coordinator, `unified_model.py` blend, `consensus()` | — (after L1 exists; this is the largest single change and must be measured on real data first — Phase 1.5) |
| L3 Gate / promotion | `gridiron-model.js` `AUTHORITY` ladder — it is well-designed and evidence-derived; keep it as the source of truth | the residual gate, `nfl-cover-calibration`'s forward gate, and the staking width gate all become named rungs on that ladder with their evidence ids | ad hoc per-file gates |
| L4 Evaluation | `nfl-replay.js` for JS signals; Python signals **export into L1** so the same harness grades them | `unified_margin_audit.py` becomes a Python-side exporter (its walk-forward stays, its report duplicates `nfl-replay`'s) | `weekly-walkforward.js` and `stage3` folds → frozen reports |
| L5 Execution | `nfl-execution-*` + `clv-core.js` + `execution-slate-reasoning` | (FIX #28 already consolidated CLV) | — |
| Risk / portfolio | `nfl-risk-lab.js`, slate allocation | — | — |

**GitHub code to bring in, mapped to those layers** (all from the
`GITHUB_BUILD_CATALOG` already in the corpus; nothing new invented):
- **L1:** `fivethirtyeight/nfl-elo-game` — an independent, decades-validated
  baseline signal (hours; catalog #8). `greerreNFL/nfelosrs`
  `BayesianRankings.py` — the recursive weekly rating update
  `nfl-team-strength.js` lacks (#12). The already-ingested PFR weekly
  defensive stats as a defensive-value signal (the free PFF replacement).
  `ryurko/nflWAR`'s replacement-level method (#1).
- **L2:** `georgedouzas/sports-betting`'s complementary-events constraint as
  the same-game guard. `ceweiss/ForecastComb` only as the reference that
  equal/inverse-MSE are the right benchmarks (already in
  `forecast-combination.js`).
- **L3:** `purgedcv` `effective_n_trials` (already in `trial-statistics.js`);
  `MAPIE` as the independent conformal cross-check (#26 — `pip install mapie`
  into the venv that now exists).
- **L4:** `aangelopoulos/conformal-time-series` ACI correction (#27), only
  after a base interval is tracked live.
- **Distribution heads (later, gated on Phase 1.5):** NGBoost / MDN (#4/#5).

**Disposition of the eleven open items:**
1. Python interpreter — **CLOSED.** `research/.venv` now exists inside
   `gridiron-hq` (python 3.12.4, sklearn 1.7.2, numpy 2.5.3, joblib 1.6.0,
   lightgbm 4.7.0, scipy 1.18.1 — the exact versions the saved artifact
   pins). `resolveResearchPython()` finds it with **no env var set**, and
   `python-artifact` + `learned-shadow-runner` integration tests pass 8/8
   that way. The scheduler job will now run instead of throwing hourly.
2. Nothing committed — 50+ files. Nick's call; recommend one commit now.
3. Lookup refresh — add a scheduled re-export after `weekly_training`'s
   slot. Small; not done.
4. First real shadow observation — fires automatically via the scheduler
   now that (1) is closed. Nothing more to build; Nick decides when the app
   runs with the scheduler on.
5. Phase 1.5 rank on real data — still open; the venv and the slim-extract
   recipe make it a one-command run. **Do this before any L2 change.**
6. Phase 2 (cover target) — reframed: `tree_lab`'s cover head registers as
   an L1 signal, not a bolt-on to `unified_model.py`.
7. Phase 3 injuries A/B — open; run it as an ensemble-component
   comparison (the only path that reaches a pick), not Python-only.
8. Defensive/PFF — open; the PFR weekly defensive stats are the free path.
9. R3 frozen-decision retry — open, P1, untouched.
10. Gate justification — **residual gate answered** (not broken; no skill).
    24-point width gate still open.
11. Promotion process — the L3 row above is the proposal.

**What I did NOT do, on purpose.** No production module was merged, renamed
or deleted. `walk-forward.js`'s own header sets the standard: a merge needs a
written reason the two engines are the same, and the L2 consolidation in
particular must be measured on real data before it replaces the live joint
fit. Today's changes to production files are additive and challenger-gated
only.

### Where we go from here — September 15, 2026

Cross-checked today's actual code against `research/advanced-methods-and-github/
GITHUB_BUILD_CATALOG.md`'s 22-item "build from this now" list (real repos, read at the
source-file level, not by README) and the F/N/GF/GN research notes. This is the honest
gap list, not a wishlist — each line below was checked against the live code, not assumed.

**Already done (verify before re-adopting; do not re-port these):**
- Diebold-Mariano + Harvey-Leybourne-Newbold correction (`test/diebold-mariano.test.js`,
  wired into `forecast-combination.js`'s gated comparisons) — catalog item 10.
- Split-conformal, Mondrian-binned intervals (`test/conformal-calibration.test.js`,
  replaced the `disagreement/30` hack per WP13) — catalog item 11 (crepes port).
- Effective trial count (Geyer autocorrelation time), deflated Sharpe ratio, and PBO
  (`server/services/trial-statistics.js`) — catalog items 16/17 (purgedcv, quantskills).
- Shin devig (`server/services/nfl-devig.js`) alongside proportional — catalog item 18
  partially (martineastwood's 7-method dispatcher is not fully ported; only 2 of 7).

**Missing and worth doing next, ordered by dependency on today's work rather than
by the catalog's own order (engineering-path items first, since Stage 3-4 depend on
them; research/model items after):**

1. **Finish the unified-model integration** (unchanged from "In progress now" above) —
   this blocks everything below it. Includes the bounded 2024 injury pilot and wiring
   `injury_admission.py`'s output into trained features, which none of the research
   catalog substitutes for.
2. **Run the historical walk-forward audit end to end, once, before adding anything
   new.** This has never happened yet on the unified model — only Stage 3's separate
   ridge/LightGBM annual-fold study (market MAE 10.249 vs ridge 10.675 / LightGBM
   10.738) and today's 16-game Week 1 scoring-parity check exist. Per the master plan's
   own Stage 6 process, no new feature or model family should be picked before this
   report exists — it is what tells you which weakness is real.
3. **`fivethirtyeight/nfl-elo-game` baseline** (catalog item 8, MIT, hours of work) —
   there is currently no model-independent sanity check on `nfl-ensemble.js`/
   `nfl-team-strength.js`. This is cheap and directly addresses "is our ensemble even
   beating the simplest possible rating system," which nothing in the repo currently
   answers on its own.
4. **Recursive per-team-per-week state-space rating update** (`greerreNFL/nfelosrs`
   `BayesianRankings.py` — Gaussian-conjugate precision-weighted update, catalog item
   12) — `nfl-team-strength.js` has no state-space update today (grepped: no
   kalman/bayesian/conjugate/glicko anywhere in it); this is the most-repeated gap
   across the F15 research note, the master plan, and this catalog, and nothing built
   today touches it. Directly relevant to `unified_model.py`'s "base" family — a
   drifting per-week team rating is a stronger `stage3` input than what exists now.
5. **A second, distribution-shaped margin head** (`stanfordmlgroup/ngboost` NGBoost or
   `tonyduan/mixture-density-network`, catalog items 4/5) — `UnifiedMarginModel.describe`
   today builds its margin distribution from resampled calibration residuals, not a
   closed-form distribution; both are explicitly flagged research-only until compared
   against that resampling approach on the same held-out games. Do this only after
   item 2's audit shows a distributional-shape weakness, not before.
6. **`powerDevig`** (`neeljshah/shin-devig`, catalog item 9, hours) — closes the
   remaining gap in `nfl-devig.js`'s method coverage; small and independent of
   everything else on this list.
7. **Injury-network propagation** (N13/GN09) — genuinely open research territory
   per the catalog itself (no adoptable OSS repo does this; `lzumeta/injurytools` was
   checked and rejected as a propagation model). `injury_admission.py`'s admission/
   missingness work (item 1 above) is a prerequisite, not a substitute, for this.

**Nothing MAJOR is structurally missing from the architecture** — the plan's own Stage
1-6 shape, the frozen-packet/artifact-identity boundary, and today's working unified
weekly-training-to-shadow-decision path already cover data integrity, training,
serving, and evaluation as a connected pipeline. The real gap is sequencing: items 3-7
are all genuine, catalog-backed opportunities, but running the walk-forward audit
(item 2) first is what the master plan's own Stage 6 process requires before picking
among them — measured weakness selects the next investment, not novelty or
availability of a matching GitHub repo.

---

**Current consolidated edition: September 15, 2026.** This is the starting point for the betting-model work on this branch. It preserves the full detailed master specification below and adds the latest implementation/review priorities here. Historical findings in the original specification remain dated observations, not automatically open defects.

## Current execution order

1. Reconcile the latest code against the [September 15 review](../audits/CLAUDE-WORK-REVIEW-2026-09-15.md). Reproduce each finding before changing code. Fix the news timestamp comparison, immutable article/claim history, and frozen-decision recovery first.
2. Correct artifact identity to include actual training-data contents and dependency versions. Preserve probability precision through the forecast adapters. Review the injury-cutoff implementation against historical identity as well as timestamps.
3. Complete the common frozen input and trained-artifact boundary shared by replay and live forecasts. Keep research predictions separate from qualified recommendations.
4. Run the specified earlier-only weekly training and replay. Save every game's prediction, failure or abstention, plus all feature, model, quote and calibration identities.
5. Produce all-game error/calibration reports and exact-price betting evaluation wherever genuine quote evidence exists. Keep annual historical market comparisons distinct from executable T-60 evaluation.
6. Complete the bounded 2024 weeks 1–4 historical news/injury pilot with immutable versions, explicit missingness, historical rosters, and separate reconstructed/prospective evidence.
7. Audit gate purpose, reachability and empirical justification. A rejecting gate is not proof of a well-chosen threshold. Do not loosen production stake controls to create picks.
8. Use measured weaknesses to select the next feature/model experiment from the research below. Register trials before results; use earlier-only tuning and genuinely new confirmation games. An ensemble-conditioned simulator is not an independent mean forecast.

## What changed since the original plan

- Claude expanded the football dataset and ran the first ridge/LightGBM baseline study: 7,276 dataset games and 6,499 scored games. Stored average margin errors were market 10.249, ridge 10.675 and LightGBM 10.738 points. Neither model beat the market. Keep the result; it is not a profit test or a completed weekly pipeline.
- Several packet, quote, numerical and cutoff fixes landed. Do not blindly reimplement older fixed findings.
- The September 15 focused review ran 102 JavaScript and 54 Python tests, then reproduced issues the tests missed. Read its exact scope and evidence.
- **Branch base is `ffe4e72`.** After the review at `81a5ed6`, Claude committed injury-cutoff changes (`d531841`), adapters (`0ce5f97`), model artifacts (`9e707b2`), and an odds receipt-clock change (`ffe4e72`). Consequently, the review's “uncommitted draft” labels describe its inspection time. Those later commits were included in this branch, not newly audited or certified during document organization.
- Existing research is sufficient to start this engineering work. New research should answer a specific decision, not restart the literature review.

## Working documents

- [Claude implementation instructions](CLAUDE-IMPLEMENTATION-INSTRUCTIONS.md)
- [Agent playbook](AGENT-PLAYBOOK.md) and [20 work-package prompts](agent-prompts/README.md)
- [Research library](../research/README.md)
- [Audit library](../audits/README.md)
- [Historical plans](archive/README.md)

The edition above controls current sequencing. The complete original design below remains the detailed specification; reconcile dated statuses with current code before execution. This document does not claim the review findings are fixed or authorize bets, paid data purchases, or deployment.

---

# Detailed master specification — preserved September 14 edition

September 14, 2026 · Consolidated implementation plan and evidence register

**Scope:** NFL betting: data, numerical forecasting, ML, AI news use, prices, evaluation, gates and monitoring. This is the main plan to work from. Research adoption and the process for choosing future improvements are included here.

**Status:** this task has recovered research, inspected selected code/data and produced the plan. A later inspection found HEAD `21789a9` and ongoing edits to the dataset builders/labs; foundation work elsewhere has progressed. The new weekly-training execution section records that update. The earlier findings and counts remain a dated `43af933` inspection snapshot, not a fresh open-defect list. Reconcile current implementation and data before each slice; this planning pass did not run training, backfill collectors or live database changes.

**Expanded scope:** the detailed specification below contains 20 work packages and execution prompts, six milestones, 28 research guardrails, 12 code-review additions, exact edit/test maps, output standards, operational failure cases and a conditional advanced-model backlog. The core effort estimate is 41–78 engineer-days, to be revised after the pilot.

## Plain-English decision

The app has real ML experiments and useful infrastructure, but it does not yet have a coherent trained betting pipeline. In the recorded production decisions inspected, its forecast matched the market. There are also concrete data and numerical defects, disconnected training/serving paths, and overlapping gates. Historical models that did make independent predictions did not establish an edge either.

Keep the useful infrastructure, repair the foundations, train a small first candidate on trustworthy history, and connect the exact same model to reproducible shadow predictions. Build the error report alongside it so future additions address measured weaknesses. Improved prediction and profitable betting require separate evidence. Overfitting can be reduced and detected; it cannot be guaranteed absent.

## Contents

1. [Implementation stages and first delivery](#implementation-stages-and-first-delivery)
2. [Data sources, research and GitHub adoption](#data-sources-research-and-github-adoption)
3. [Overfitting controls and acceptance requirements](#overfitting-controls-and-acceptance-requirements)
4. [Weekly training, news backfill and Claude execution instructions](#weekly-training-news-backfill-and-claude-execution-instructions)
5. [Expanded work packages, dependencies and effort](#expanded-engineering-specification-dependencies-and-effort)
6. [Agent context, research guardrails, new code findings and output standards](#agent-operating-manual-research-guardrails-and-code-review-additions)
7. [Prompts and edit maps for all 20 packages](#package-prompts-and-exact-edit-map)
8. [Current system findings and problem register](#current-system-findings-and-problem-register)
9. [ML and AI evidence](#ml-and-ai-evidence)
10. [Recovered Claude research and audits](#recovered-claude-research-and-audits)

## Implementation stages and first delivery

Proceed to implementation planning and staged engineering. The recovered research is sufficient to start. Additional research should answer a specific unresolved implementation question, with a defined decision it could change.

Scope: the NFL betting model and its supporting data, training, predictions, pricing, evaluation and monitoring. Fantasy/UI work is outside scope except where a shared dependency prevents the betting pipeline from working.

### Target behavior

For every game, the system should be able to show:

1. What it knew at the decision time.
2. Which trained model and calibrator it used.
3. Its predicted margin, total and relevant probabilities.
4. How its forecast differs from the market available then.
5. Whether the offered price justifies a bet, and why it bet or abstained.
6. What happened afterward, including the final score, closing price and prediction error.

The same saved inputs and model must reproduce the same answer. Training and evaluation must exercise the same prediction path used by the app.

### Stage 1 — repair the foundation

**Purpose:** stop feeding broken or stale information into new experiments.

- Reconfirm current status of the specialist fitting defect, corrupt QBR season rows and missing 2026 team features; repair their producers and add targeted regression tests.
- Quarantine invalid records in research extracts. Do not silently rewrite original evidence or erase failed experiments.
- Make a per-source coverage/freshness table: earliest season, latest completed game, missing values, available timestamps, and whether the source can support historical reconstruction or actual prospective capture.
- Separate learning filters, data-integrity checks and betting-authority rules. Identify one owner for each; mark duplicated or incompatible rules for replacement.
- Freeze the baseline code/configuration and historical comparison results before changing model behavior.
- Audit the safeguards themselves: correct the claim that Holm assumes independent trials; treat the MCMC-derived effective-trial count and reconstructed-return diagnostics as unvalidated for promotion. Use aligned prediction/loss panels and independently checked statistical implementations.

**Done when:** valid current-season features update after settled games; invalid future/duplicate QBR rows cannot enter features; specialist coefficients are finite; each input's freshness and provenance is visible. Existing live capture continues undisturbed.

### Stage 2 — create the shared training data

**Purpose:** give the learners appropriate history without introducing future information.

- Build one versioned feature contract shared by offline training and serving. Include game identity, cutoff, source versions, values, missingness, information age and label availability.
- Produce a broad **football dataset**, starting with the existing 1999+ scores/schedule history and available team/player features. Missing old opening prices must not exclude these games from football learning.
- Produce a separate **betting dataset** using actual quotes available at the declared decision time. Start with the existing T−60 contract. Retain earlier-price records for a separately evaluated early-betting model.
- Never substitute a later closing quote for T−60. Missing price history limits the betting evaluation, not the football dataset.
- Backfill missing historical football sources in bounded, resumable seasons. Start with aggregates needed by the first learner; expand raw play data for named features, rather than downloading everything speculatively.
- Rebuild existing ratings/formula predictions chronologically before using them as learned features.
- Prioritize nflverse historical PBP/team/player/snap/roster data, genuine decision-time multi-book quotes, timestamped official availability reports, and correctly versioned weather forecasts. Check the publisher's actual release schedule: some participation data arrives only after the season, and nflverse's injury feed has documented gaps.
- Freeze both source publication/availability and local receipt times. Preserve revised snapshots. Derived EPA/ratings need model-vintage review as well as game-date filtering. Weather lead labels alone do not establish the forecast was available at T−60.

**Done when:** dataset manifests show unique games and coverage by era; optional missing features do not erase usable games; changing future rows cannot alter an earlier feature vector; every betting example has an eligible quote or an explicit exclusion reason.

### Stage 3 — train a small, serious first model

**Purpose:** determine whether learning from the repaired data adds predictive value.

- Reuse `research/.venv`, existing lab code and evaluation infrastructure.
- Compare a regularized linear model and one shallow LightGBM candidate with the market baseline. Avoid a large AutoML search in the first pass.
- Train football estimates from lagged efficiency, opponent strength, pace, QB/player quality, availability, schedule and legitimate weather inputs.
- For the betting head, learn the correction to the decision-time market. Include chronological football-model predictions as features; their training must precede each example too.
- Tune only within earlier inner folds. Save every outer-fold prediction, including bad results. Record all feature/configuration attempts.
- Fit probability calibration on earlier out-of-fold predictions, handle pushes explicitly, and evaluate spreads and totals separately.
- Allow the market/zero-correction baseline to win. Do not require each individual feature to prove profitable before the learner may consider it.
- Apply the recovered shrinkage/team-strength research to the first model's priors and offseason carryover. Reuse forecast-combination and conformal work with their assumptions tested; retain a separate probability calibrator because a conformal interval is not a cover probability.
- Predeclare a small configuration set and primary metrics. Changes after seeing results create a new registered experiment, rather than retroactively changing the test. Report season and feature-era performance, along with sample size after time weighting.
- Build the error report with this first experiment. Save predictions for every eligible game, including abstentions, alongside matched baseline predictions, actual outcomes, source freshness/missingness and model identity. Report signed and absolute margin/total errors, probability quality and uncertainty; keep price-qualified betting metrics separate. Predeclare a small set of diagnostic groups using information known at the cutoff, such as expected QB changes, season phase, forecast weather and market horizon. Show unique-game counts and week/block uncertainty; flag sparse groups as inconclusive.

**Done when:** one reproducible report compares identical eligible games across candidates, with prediction error, probability quality, calibration and coverage, plus an error report that can distinguish candidate weaknesses from market-wide difficulty. Any simulated betting returns use actual eligible prices. A negative result is a valid completion, not a reason to keep searching until a positive result appears.

### Stage 4 — connect the complete prediction path

**Purpose:** make the app consume an actual trained model rather than just display research reports.

- Save immutable model artifacts with feature schema, preprocessing, training cutoff, code/data hashes and calibration identity.
- Initially score with the same Python pipeline used offline. Add a Node adapter; postpone a second-language implementation until needed and require numerical parity if introduced.
- Freeze actual feature values and model references in the decision packet, alongside the quote. Remove mutable-table rereads from the learned prediction path.
- Wire the candidate through the T−60 runner, prediction board, decision ledger, settlement and closing-line grader.
- Handle missing artifacts, late data, duplicate retries and restarts explicitly.
- Consolidate betting controls into one versioned policy. Preserve timestamp, numerical validity, execution and exposure checks. Replace mismatched identities and duplicate thresholds with consistent contracts.
- Preserve a decision trace: candidate forecast, served forecast or fallback, calibrator output, offered price, expected value, each gate's result and final action. This lets the error report distinguish a weak learner from a model that never reached the decision, or an advantage lost at execution. Any hypothetical outcomes from bypassing a gate are diagnostic and cannot authorize bypassing it.

**Done when:** one game passes from frozen inputs through trained forecast to recorded shadow decision/abstention and later grading; replay gives the same result after live tables change. Then demonstrate the same behavior across the eligible slate. No automatic increase in live stakes accompanies integration.

### Stage 5 — validate the system as a whole

**Purpose:** establish what the new pipeline actually adds.

- Compare the complete learned path with the market, the preserved incumbent and a simple football baseline using weekly chronological evaluation.
- Treat repeatedly inspected history as development data. Freeze the prospective protocol before using future games as evidence.
- Run shadow predictions before kickoff, recording all games and abstentions. Monitor input freshness, model version, errors, calibration, closing-line value and realized returns separately.
- Measure incremental value with full-pipeline ablations: remove a feature family, refit appropriately, and compare. An isolated component win is insufficient.
- Distinguish engineering success, predictive improvement, paper execution results and evidence supporting live betting authority.
- Require future-data mutation tests, chronological out-of-fold stacking, train-only preprocessing, and null controls on the selection procedure. Calibrate uncertainty using week/block dependence; do not treat multiple books, both sides, or plays from the same game as independent game outcomes.
- Maintain a complete trial registry and correct batch comparisons for the actual declared candidate family. Keep historically examined data labeled development, regardless of whether a sophisticated correction produces a favorable result.
- Freeze the prospective evaluation and review schedule before future games. Model changes start a new versioned evidence segment. Repeated ordinary p-value checks cannot be called anytime-valid monitoring.
- At scheduled reviews, turn the error report into a ranked improvement backlog using the Stage 6 protocol. Separate data/pipeline failures, forecast errors, probability errors and pricing/execution failures. Include no-bet games and excluded-game counts so betting gates cannot hide weak forecasts or coverage failures. Post-hoc groups are exploratory and require later confirmation.

**Done when:** there is an auditable performance ledger and a clear verdict about what improved and what remains unproven. A working pipeline can still correctly conclude that no betting edge has been demonstrated.

### Stage 6 — choose additions from measured weaknesses

The diagnostic process starts in Stage 3 and continues through shadow serving; it must not wait until this stage. The items below are candidate families, not an automatic build queue. A working system can also conclude that no addition has earned priority.

#### Required improvement process

1. **Identify and classify the weakness.** Compare the candidate and market/simple baseline on the same games. Record effect size, unique-game count, uncertainty, era stability and the discovery period. Large errors shared by both models are not automatically a missing model capability. Check data and routing before proposing more ML.
2. **Write a specific hypothesis.** State the suspected mechanism, what information was available before the bet, and the smallest change that could address it. Error patterns and feature importance are clues, not causal proof.
3. **Register the experiment before comparison.** Record the relevant recovered research/report, proposed code or GitHub reference, source coverage, configuration budget, primary metric, meaningful improvement threshold, regression checks and confirmation period. Rank candidates by evidence strength, affected coverage, potential benefit, data readiness and cost; do not rank by architecture novelty or a few large losses.
4. **Compare the complete systems fairly.** Fit baseline and modified pipelines on earlier data, including their upstream features, weights and calibrators. Use identical eligible games and prices, and refit ablations where appropriate. Show whole-population performance as well as the target group so a local gain cannot hide broader deterioration.
5. **Confirm beyond the discovery data.** Once inspected to choose a fix, those games are development data. Use later untouched chronological evaluation and then frozen prospective predictions. Count subgroup searches and failed attempts in the trial registry; predeclared review times and appropriate multiplicity controls still apply.
6. **Keep a concrete verdict.** Mark the addition retain, reject or inconclusive with the evidence and limitations. Predictive improvement does not automatically establish profitable betting or change betting authority. Retain the incumbent when the evidence is insufficient.

Each backlog entry must contain: failure category, hypothesis, affected games, baseline-relative evidence, source timing, research/code reference, smallest proposed fix, estimated effort, experiment ID, confirmation window and verdict. The first delivery must include the report and backlog format even if no weakness has enough evidence yet.

| Observed pattern to investigate | First checks or candidate improvement |
|---|---|
| Errors around expected QB changes | Availability timing, stale inputs, replacement quality and expected usage |
| Weak early-season forecasts | Offseason carryover, roster changes, shrinkage and rating update speed |
| Repeated total errors under certain conditions | Pace/possessions, forecast weather and scoring distributions |
| Reasonable average margins but poor cover probabilities | Calibration, distribution shape, key margins and pushes |
| Candidate differs from market but served forecast never does | Artifact loading, routing, fallback and gate trace |
| Useful forecasts but poor executable prices | Quote age, decision timing, book availability and execution assumptions |
| Strong training results and weak later results | Leakage, excessive search, sample size and unstable relationships |

These patterns nominate investigations; none alone proves an explanation or justifies a new data purchase/model.

#### Candidate families after the first complete path works

1. Improve QB/player quality, expected usage, availability and replacement effects.
2. Add play/drive models for efficiency, pace and matchup information; aggregate them into game-level features.
3. Evaluate a joint score distribution/simulator against the simpler calibrated probability baseline.
4. Build a separate early-price/line-movement model if quote coverage supports it.
5. Revisit graph networks, transformers or foundation models only when a specific remaining problem justifies them.

Each addition needs earlier-only upstream predictions and a full-pipeline comparison. More plays or simulated games do not count as additional independent betting outcomes.

### Research and GitHub adoption commitments

The recovered research is explicitly part of the implementation. The [detailed adoption map below](#data-sources-research-and-github-adoption) records report identifiers, existing code, assumptions and source links.

| Planned role | Research and code to use |
|---|---|
| Trustworthy historical inputs, Stages 1–2 | Point-in-time/revision research; extend nflverse ingestion; nflreadpy optional if it simplifies access |
| First learned forecasts, Stage 3 | Dynamic team/QB strength and shrinkage, regularized forecast combination; existing sklearn/LightGBM and chronological predictions |
| Probabilities and uncertainty, Stages 3–5 | Calibration, discrete NFL margins/pushes and conformal research; existing corrected code checked against MAPIE |
| Honest selection and evaluation, Stages 1/5 | Harvey–Liu/multiple-testing research, trial registry, chronological evaluation and dependence-aware comparisons; arch as a statistical reference, DSR/PBO only after assumption checks |
| Choosing improvements, Stages 3–6 | Error reports, refitted ablations, declared comparisons and later confirmation; nfelo as a rating benchmark/reference after vintage and license review |
| Conditional deeper work, Stage 6 | Full Bayesian Stan/PyMC models, copulas, injury networks, play models, graph networks and transformers only against a documented weakness and simpler baseline |

Adoption means a method has an assigned purpose and verification requirement; it does not mean all these methods are already in production. Pin adopted versions, preserve licenses/source references and record the relevant paper/report in each build-ledger entry.

### ML and Claude roles

**ML:** learn numerical relationships, forecast distributions, calibrate probabilities and estimate useful corrections to the market.

**Claude:** extract supported facts from text, preserve source evidence, identify contradictions, and explain recorded predictions. Extraction confidence is not a win probability. Any AI-driven allocation or risk-review contribution must compete against a deterministic baseline separately.

### First implementation delivery

Deliver Stages 1–2 and a narrow Stage 3 experiment first: repaired data, a common dataset with a coverage report, one properly trained candidate evaluated against the market, and the error report/improvement backlog described above. Follow immediately with the complete shadow-serving path; do not let the experiment become another disconnected research tab.

Maintain one build ledger for each slice: problem, files changed, evidence reused, tests, measured result and remaining limitation. Reconcile relevant old findings against current code as the slice begins. Preserve the recovered corpus rather than repeatedly rereading or redoing it.

The immediate next action is Stage 1's code-and-data repair slice. Further broad research is not a prerequisite.

## Data sources, research and GitHub adoption

### What to obtain or improve

| Priority | Source/work | What it adds | Admission rule |
|---|---|---|---|
| First | Extend the existing nflverse ingestion | Older PBP, team/player production, snaps, roster/depth and stable player/game identifiers | Source-specific coverage; prior information only; record release/version and missingness |
| First | Repair and retain the existing multi-book quote tape | Actual handicap, price, movement so far, book disagreement and later CLV reference | Quote and receipt time before cutoff; stale/missing quotes explicit; one canonical game identity |
| First | Official team/league availability reports and inactives, using existing collection paths where possible | Who was expected to play, when that changed, and who would replace them | Preserve report text, publication/receipt times, revisions, player IDs and conflicting claims |
| First | Validate existing Open-Meteo forecast history and capture future runs | Wind/gusts/precipitation expected at kickoff and forecast changes known before a decision | Explicit model/run/lead/availability; distinguish forecast vintage from realized weather |
| Next | Additional historical quotes at the chosen horizon | More honest price-qualified training and evaluation games | First measure gaps in the current archive; acquire a bounded sample before deciding whether a larger paid backfill is worth it |
| Next | External nfelo-style ratings as comparisons and carefully reconstructed features | Independent team/QB-strength benchmarks and implementation ideas | No closing-market leakage, retrospectively tuned parameters or actual-starter hindsight in a historical betting feature |
| Later | Formation/charting, detailed player interactions and other specialist data | More specific matchup features | Add only with a defined target, deployment-time availability and full-pipeline incremental-value test |

The highest-value immediate expansion is from an ecosystem the app already uses. nflverse documents PBP availability back to 1999 and offers files through GitHub releases. This is public data availability, not a claim that all fields, seasons or historical vintages are already clean in Gridiron. [PBP documentation](https://nflreadr.nflverse.com/reference/load_pbp.html), [official data repository](https://github.com/nflverse/nflverse-data).

Use stable IDs and canonical games across sources, normalize team aliases/time zones/units, and verify home-spread signs. Retain contradictory source records for reconciliation instead of letting the last update silently win. Report coverage by season, game week, source and decision horizon. Do not multiply sample size by counting both team rows or every bookmaker quote as a new game.

#### Three source traps the plan must handle

**A previous game is not enough to prove a field was available.** nflverse states that participation data from 2023 onward is delivered after the postseason. Its update schedule also documents the injury-source failure after 2024 and changes to depth-chart timestamps from 2025. Such sources require release-time checks or alternatives for live availability features. [Publisher's update schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html).

**Historical weather products are not interchangeable.** Open-Meteo's Historical Forecast API stitches the first hours of successive runs into a time series. The Single Runs API exposes a particular initialization, with different coverage dates. Existing `nfl-weather-history.js` preserves previous-day lead values and a lead-0 fallback, but does not establish precise run publication/receipt time. A day-of label must not automatically pass a T−60 eligibility check. Earlier-lead data may be usable if its availability is established; unknown vintages remain reconstructed/diagnostic. [Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api), [Single Runs API](https://open-meteo.com/en/docs/single-runs-api).

**Derived metrics can contain a second kind of hindsight.** Historical EPA, win probabilities and published QB ratings can come from models trained or revised later. Pin the upstream model/data vintage; for strict historical experiments use a defensible earlier-trained model or an explicitly labeled reconstruction/sensitivity comparison. Never use future-informed WP or closing-spread fields as early-price features.

The Odds API documents historical snapshots, making it a candidate for filling measured gaps in the archive. Before buying or consuming credits, specify the games, dates, books, markets and horizon required; inspect pricing/timestamp semantics and estimate the resulting unique usable games. More snapshots of the same games improve price reconstruction, not the independent outcome count. [Historical odds documentation](https://the-odds-api.com/historical-odds-data/).

### Put the recovered statistics into the build

“PhD-level research” is a description of the research ambition, not a guarantee of correctness. The reports, their verification reviews and executable reference comparisons should drive implementation decisions together.

| Recovered research | Existing implementation/state | Concrete adoption |
|---|---|---|
| F05: point-in-time/bitemporal data | Quote/packet contracts exist; complete feature freezing and revision coverage do not | Stage 2: shared as-of feature construction with publication and receipt clocks; Stage 4: freeze values and artifact references |
| F02: forecast combination | `forecast-combination.js` is implemented but explicitly research-only | Stage 3: combine chronological out-of-fold predictions with a market baseline; fit regularization on earlier inner folds |
| F08/F15: dynamic team strength and shrinkage | Team-strength and joint-score modules exist, but are not proof of a complete Bayesian game model | Stage 3: league/team/QB priors, early-season borrowing, offseason mean reversion and recency handling; estimate their strength inside earlier folds. Full Stan/PyMC models are later comparisons |
| F11/GF08: conformal uncertainty | Split-conformal code and a MAPIE cross-check already exist; earlier checks used fixtures | Stages 3/5: reuse corrected finite-sample math and verify real chronological coverage. Time dependence/shift limits the usual guarantees. Keep probability calibration separate |
| F06/GF10: Harvey–Liu, multiple testing, trial registry | Registry, DSR and PBO code exist, with material assumptions needing review | Stage 1: validate audit math. Stage 5: record every candidate and compare aligned week-level losses; correct the declared family of tests |
| F07: sequential inference | Several monitoring/significance paths exist; no blanket anytime-valid claim is justified | Stage 5: prespecified review times initially; only use continuous significance-based stopping after a suitable confidence-sequence/e-process implementation is independently checked |
| F17: NFL margin distributions | Discrete-margin code and joint-score experiments exist; not all cleared real-data comparisons | Stages 3–5: preserve mass at key margins and pushes; evaluate log score, calibration and probability at the actual offered handicap |
| F10/GF06: copulas/dependence | Research and candidate dependence machinery exist | Preserve same-game/exposure dependence; do not multiply leg probabilities as if independent. Advanced copulas wait until marginals are calibrated and enough joint data supports fitting |
| F13/N13: news impact and injury networks | Typed news extraction exists; much impact mapping is rule-based or research-only | Stage 6: model expected availability and replacement/usage effects, then test whether the market already incorporates them |
| N01–N12/GN catalogs: deep models, ensembles, AutoML | Several experiments exist; scale-up synthesis did not finish | Keep as a later candidate backlog. Each needs a task, data size and baseline; do not add all architectures to the first search |

This means the research is **partly used already**, but its adoption is uneven. The next task is to connect the useful implemented pieces and apply the missing principles, not port every paper into a new module.

### What to reuse from GitHub

- **nflverse/nflverse-data:** extend the existing ingestion rather than introducing a competing database. Check each dataset's dictionary and terms.
- **nflreadpy:** official ecosystem Python access wrapper, useful if it simplifies extraction; optional because direct release ingestion already exists. Its Polars-based outputs require an explicit conversion boundary if the training pipeline uses pandas. [Documentation](https://nflreadpy.nflverse.com/).
- **MAPIE:** independent reference for uncertainty calculations. The repository already contains a cross-check; refresh it against the supported version and real held-out residuals before adding a new production dependency. [Repository](https://github.com/scikit-learn-contrib/MAPIE).
- **arch:** reference implementation for SPA, stepwise model comparisons and model confidence sets using common loss panels. Adapt time-block construction to NFL game/week dependence. These methods help assess selection effects; they do not rescue previously exposed holdouts. [Multiple-comparison documentation](https://bashtage.github.io/arch/multiple-comparison/multiple-comparison_examples.html).
- **nfelo:** inspect as a team-rating/market-comparison architecture reference. Recheck repository and data licenses before code reuse; preserve our own chronological fitting rather than importing retrospective predictions as if live. [Repository](https://github.com/greerreNFL/nfelo).
- **Existing sklearn/LightGBM/XGBoost/CatBoost:** use established implementations instead of creating more custom numerical solvers. Start with the small declared comparison in the main plan.

Pin versions/commits and preserve source/license references. Before adoption, test feature and prediction parity on representative fixtures. No repository's claimed betting record establishes performance on our information, prices or future games.

## Overfitting controls and acceptance requirements

Overfitting cannot be guaranteed absent. The objective is to reduce it, expose it, and prevent apparent backtest gains from being mistaken for deployable evidence.

### Required controls

1. **Freeze the experiment before scoring:** target, horizon, source rules, feature groups, candidate settings, primary metrics and selection rule. Record failed and abandoned experiments too.
2. **Limit the initial search:** ridge and one shallow boosted-tree family, with a small declared tuning grid. Further models/feature searches become new tracked experiments, not invisible retries.
3. **Nest every learned choice:** feature selection, imputation, scaling, upstream player models, early stopping, ensemble weights, prior strengths and calibrators all fit within earlier data. The outer test week is never a stopping or tuning set. [Nested-validation rationale](https://scikit-learn.org/stable/auto_examples/model_selection/plot_nested_cross_validation_iris.html).
4. **Use honest out-of-fold stacking:** every training feature representing another model's prediction must have been generated without fitting that model on the example's result.
5. **Respect dependence:** keep an entire game in one split; retain its players, plays, both sides and all books together. Compare candidates on common eligible games and use prespecified week/block resampling for uncertainty. Check sensitivity to plausible block lengths.
6. **Test time integrity directly:** add later news, scores, revised stats or quotes to a fixture; an earlier prediction must remain identical. A feature-importance leakage scan is supplementary, not proof of safety.
7. **Test the selection process under no signal:** on synthetic/noise or appropriately permuted residual panels, the complete search/selection procedure must not routinely claim an edge. Use many replicates and intervals; one lucky or unlucky null run proves little. Do not tune to those diagnostic outcomes indefinitely either.
8. **Use simple baselines and full-pipeline ablations:** market, zero residual, simple ratings; retrain after removing a feature family. Do not attribute the improvement of a combined model to every input independently.
9. **Report stability and sample size:** per season/era/horizon performance, training-versus-test gap, sensitivity to settings, and effective sample size after recency weighting. Twenty-five years with aggressive decay may behave like a much smaller sample.
10. **Correct selection claims:** use valid base tests on aligned losses and an appropriate family correction, retaining the raw trial count. Unknown prior searches remain a limitation; a correction cannot make reused history untouched.
11. **Keep uncertainty methods distinct:** conformal coverage is not a guarantee of point accuracy or profitable betting; a good Brier score is not evidence of executable returns; CLV and game results from the same bets are correlated evidence.
12. **Freeze future shadow evidence:** record predictions before games, evaluate at declared review times, and segment model versions. Changing the model or peeking repeatedly creates additional selection; ordinary p-values do not support arbitrary stopping.
13. **Treat error-driven additions as another search:** build the error report with the first model, including abstentions and matched baseline errors. Predeclare a small diagnostic group set; record post-hoc groups and every attempted fix. A weakness discovered in inspected games needs confirmation on later untouched games. Require full-pipeline refits and both target-group and overall results. Follow the improvement protocol in Stage 6 of the implementation stages above; noisy subgroup losses and feature importance alone do not establish a cause.

### A newly confirmed audit issue

`server/services/trial-statistics.js` describes Holm as assuming independent trials. This is incorrect: Holm's family-wise control does not require independence when the underlying p-values are valid. [R statistical documentation](https://stat.ethz.ch/R-manual/R-devel/library/stats/html/p.adjust.html).

The code also derives an effective number of trials using an MCMC autocorrelation estimator. `scripts/run-purged-evaluation.mjs` feeds it a chronological sequence mixing ROI, probability errors and point errors after mostly sign/centering changes. Those values are not genuinely standardized to comparable units, and this does not establish the dependence among competing forecasts on the same games. It then supplies that effective count to DSR.

**Plan decision:** retain those historical outputs as diagnostics, but do not use the discounted trial count or reconstructed returns to justify promotion. First obtain aligned per-game/per-week predictions, losses and actual-price returns. Validate statistical calculations against reference implementations, and use a conservative declared-family correction until a better justified dependence-aware procedure is ready. DSR/PBO remain supporting diagnostics with assumptions and incomplete-trial-history limits stated.

### Acceptance criteria

- Every new source has a reason to exist, timing contract, identity mapping, coverage report and incremental-value test.
- Every adopted research method names its paper/report, implementation, assumptions and verification.
- Every forecast has a reproducible upstream training and feature chain.
- Every performance claim states its candidate search, data exposure, baseline, eligible sample and uncertainty.
- Engineering completion and improved prediction are reported separately from profitable execution.
- The first model ships with an error report and improvement backlog. Each proposed addition names its observed weakness, baseline comparison, hypothesis, research/code reference, smallest fix and later confirmation period; reject/inconclusive outcomes are retained.

These are concrete additions to Stages 1–5. Broad new research, expensive feeds, copulas, or deeper networks are not prerequisites for starting the repaired learning pipeline.

## Weekly training, news backfill and Claude execution instructions

This section turns the architecture into ordered work. Execute the steps in order, reconciling completed work first. Do not start another broad research sweep. The source files named below are repository-relative locations to inspect or extend; proposed modules and commands do not exist merely because they are specified here.

### Fresh inspection: what changed and what remains

A later September 14 inspection found repository HEAD `21789a9`, with uncommitted edits in the shared dataset builder, both labs, their tests and governance documents. Recent commits address season defaults, baseline preservation, quarantine, freshness reporting and gate ownership. Another commit is titled “Wire the overfitting/deflated-Sharpe correction into a real promotion gate”; inspect the resulting authority path and assumptions rather than assuming the earlier audit describes its current state. Preserve work in progress. No implementation or live-database verification was performed by this planning pass.

| Current inspected behavior | Action required |
|---|---|
| `research/betting/nfl/dataset.py` now shares chronology and quote-pair extraction; `tree_lab.py` and `market_lab.py` call it | Extend this common builder and its consumer-parity tests; do not recreate two independent extractors. The edited code is not certified by this read-only inspection. |
| `build_football_dataset` is present with 1999+ defaults and optional PBP | Verify its actual output and consumers. It uses `gameday` as a decision instant and also exports market fields: distinguish date-only records from actual kickoff timestamps, and exclude unqualified market columns from training features. |
| The shared chronology uses a three-day publication proxy and a seven-day settled-label lag | Preserve them as explicitly modeled historical assumptions until source-specific clocks are available. They do not prove real publication times. Separate label availability from corrected-feature availability; compare conservative versions without selecting whichever produces the best profit. |
| The existing betting builder still pairs Pinnacle opening and closing quotes, defaulting to 2022–2025 | Add a separate exact T−60 builder. A missing close must not remove an otherwise valid outcome-training example; it only prevents CLV/movement evaluation. |
| Main tree-lab branches fit on earlier seasons and score a whole later season; inner folds keep weeks together | Preserve as historical comparators. Add weekly refitting that matches the intended deployment cadence. It must incorporate newly settled eligible games without tuning on the scored week. |
| The tree lab measures movement MAE, conditional non-push classification log loss/Brier, quantiles and paper returns | These are useful, different targets. Add explicit push probabilities and price-based EV to the serving evaluator; movement error is not game-outcome accuracy. |
| `nfl-news-events.js` extracts typed claims with exact evidence spans and a content cache, but takes recent relative-day windows and stamps extraction time as `first_seen_time` | Add absolute date-range backfill and separate source receipt from extraction time. Never backdate extraction to an old article date. |
| `nfl-advanced.js::syncInjuries` writes current player-week rows and attempts revision capture | Reuse it, verify actual revision coverage and as-of reads. Importing a final weekly CSV today cannot recover every earlier daily report version. |
| News and press extraction can consult current player/team identity; press discovery uses recent channel feeds | Resolve players against historical rosters/transactions. Add archive discovery for old documents; a recent feed is not a season archive. |
| `nfl-news-event-impact.js` selects the fastest next quote pair and predicts absolute implied-probability movement | Retain as a limited historical diagnostic. It is not a directional game predictor. Review contract matching when handicaps change, event grouping, time windows and price-only controls before reuse. |

### Step 1 — reconcile the repository and create one execution ledger

Read this master plan, relevant `AGENTS.md` instructions, `docs/CLAUDE-NEXT-STEPS.md`, the current work log, and the recovered research index. Inspect current git status and commits before editing. Do not reset, overwrite or duplicate someone else's in-progress work. Recheck each relevant earlier defect against the current source and a read-only database snapshot.

Create one ledger row per work package: existing implementation, remaining task, files, research references, tests, output artifact, state and limitation. Use states such as planned, implemented, verified, connected, observed and qualified; a passing test is not evidence of betting profit. Carry forward the specialist, QBR, freshness, gate, calibration and audit-math findings without falsely calling fixed items open.

**Return:** a short reconciled status and the next uncompleted slice. Continue with that slice; do not stop after restating the plan.

### Step 2 — define training examples and clocks

Extend `research/betting/nfl/dataset.py`, the existing feature contract, and their tests. Keep three related datasets:

- **Football:** one game/cutoff example with legal prior football information; labels are home margin and total points. Use broad history without requiring archived opening or closing prices.
- **Player availability/usage:** one player/game/cutoff example. Labels distinguish game-day active status from actual participation and usage. An active player taking zero snaps is not automatically injured. Actual snaps or starters can be labels after the game, never inputs for that same earlier prediction.
- **Betting:** game, cutoff, exact market/period/handicap/side/book and offered odds. Use T−60 first. Signed home spread residual is actual home margin plus home handicap; total residual is actual total minus offered total. Preserve win/push/loss outcomes. Attach closing prices later as optional labels.

Every row needs canonical game/player IDs, season type, UTC kickoff and timestamp precision, cutoff, source IDs/versions, feature values and missingness, provenance mode, training/label availability, and immutable dataset identity. Keep labels, future quotes and retrospective metadata outside a strictly allowlisted feature matrix. Multiple books, players, snapshots and plays do not create independent game outcomes.

For each source distinguish: event/practice time, source publication/update time, independently evidenced availability bound, actual local receipt time, extraction completion time, and later revision time. Date-only evidence is an interval, not midnight masquerading as precise publication. If the conservative upper bound does not precede the cutoff, exclude it from that strict example.

**Pass:** future rows cannot change an earlier vector; no final-score/closing-price column can enter the feature matrix; date-only schedule rows cannot qualify as precise T−60 packets; missing odds/news do not delete football examples.

### Step 3 — inventory history and run a bounded backfill pilot

Produce coverage by source, team, season, week and cutoff using the existing freshness audit. Start from stored `news_items`, `press_conferences`, `press_availability`, `nfl_news_events`, `nfl_news_signals`, `nfl_injuries`, feature revisions, roster history and quote tape. Count usable documents and game coverage rather than just rows.

Use **2024 regular-season Weeks 1–4, all teams**, as the initial engineering pilot. This choice tests archive retrieval and chronology; it is development data, not a performance holdout. Exercise Thursday, Sunday and Monday/other kickoff times. Include uneventful games, rather than selecting only famous injuries or losing bets. Then expand sequentially across 2022–2024 where sources support it; assess 2025 separately because injury coverage differs. Broad football backfill can extend further independently.

Source order:

1. Existing locally preserved source versions and live capture logs.
2. nflverse structured injury, roster, player and snap data, after field/timing checks. `date_modified` documents an update, not a complete history of changes. The publisher documents an injury-feed gap after 2024. [Injury dictionary](https://nflreadr.nflverse.com/articles/dictionary_injuries.html), [availability schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html).
3. Official team article archives/sitemaps, dated injury reports, transactions, inactives and media transcripts. A verified example is the [Eagles September 2024 archive](https://www.philadelphiaeagles.com/sitemap/html/articles/2024/9), which lists pregame reports separately from recaps. Generalize adapters only after testing each site.
4. Existing reputable reporter/news sources for missing details, with duplicate and provenance checks. Use accessible historical snapshots where available; inspect their actual capture time and content version. Search snippets alone cannot establish an eligible claim.
5. Written official transcripts before video transcription. Test dated video archives if transcripts are missing, retain transcript offsets and source identity, and review player-name/status extraction errors. Current channel feeds alone cannot backfill old seasons.

The pilot must report retrieval success, usable timestamp/version coverage, revision loss, duplicate rate, identity failures, extraction quality, dollars/tokens per accepted document, and projected season cost. Use a manifest of absolute date ranges and resume cursors. Cache downloads by source/content version and extraction by content, prompt, model, parser and historical identity-map version. Do not repeatedly send unchanged articles to an LLM.

**Pass:** a reviewable pilot archive and coverage report, with explicit unavailable records. No guarantee of complete 1999+ news history; sparse text history must not block the first football model.

### Step 4 — preserve source documents and extract supported events

Extend the existing news-event and bitemporal schemas rather than adding an unrelated news database. Store an immutable source document/version, its full timing metadata, content hash, retrieval status and source URL. Keep claim records tied to that exact version. Preserve contradictions and superseding events instead of overwriting Wednesday with Friday.

Parse structured injury tables with deterministic code. Use Claude only for text that needs interpretation: named player/team, practice participation, injury designation/body part as stated, expected role change, return/transaction, quote speaker and exact supporting span. Supply historical identity candidates and the document text. Require `unknown` for unsupported claims. Do not ask Claude what happened in the historical game, to infer a diagnosis/recovery duration, or to assign a point spread from prose. Extraction confidence is neither probability of playing nor probability of winning.

Keep these provenance classes separate:

- **Captured:** the source version was received and its features were ready before the actual decision. Preserve the then-used extractor/artifact. Reprocessing an old captured text with a new extractor creates a retrospective experiment, not the originally served result.
- **Archived reconstruction:** there is evidence this exact source version existed by the historical cutoff, but our new pipeline processed it later. Suitable for explicitly labeled retrospective model development; not evidence of actual historical capture, execution or low latency.
- **Uncertain reconstruction:** only a current page, final weekly row or ambiguous date/version survives. Use only for clearly labeled sensitivity/auxiliary work where timing permits; exclude from strict decision-time performance claims.
- **Post-cutoff:** available only later. Keep as later labels/context, never earlier features.

A modern LLM can know historical outcomes. Restrict historical use to span-supported extraction, keep irrelevant recap/sidebar content out of the prompt, and validate on prospective text as well. Masking dates alone does not prove absence of model memory.

**Pass:** annotated tests cover multiple players, pronouns, negation, vague quotes, historical trades, duplicated syndication, late corrections, revised pages and postgame content. A source being official does not eliminate typos or extraction mistakes.

### Step 5 — build each week's information timeline

Create one shared as-of reducer over source events, used by both Python extraction and the frozen serving packet. Reuse current `playerNewsSignal`, `teamNewsSignals` and event/revision contracts only after fixing their timing and historical identity limitations. Avoid separate historical and live business logic that silently diverges.

For each upcoming game, reconstruct changes leading up to its actual kickoff. Use a bounded recent-news window plus carried-forward unresolved states such as injured reserve; stale snippets expire, but unresolved long-term statuses need explicit resolution rather than a blind 14-day reset.

Initial snapshots are **T−72 hours, T−24 hours and T−60 minutes**. T−60 is the primary betting experiment; earlier snapshots support diagnostics and later separately declared experiments. They are alternative views of one game, not three independent tests. Do not force a Friday/Sunday template onto short weeks, international games or Monday fixtures. Retraining schedule and snapshot schedule are distinct.

Illustrative synthetic timeline:

| Source update | What a later eligible snapshot can contain |
|---|---|
| Wednesday: player did not practice | DNP, stated injury, time since update; playing status still unresolved |
| Thursday: coach says player will be evaluated | Supported uncertainty; no invented “70% active” |
| Friday: official questionable designation | Latest designation and practice trajectory; prior claims retained |
| Game day: player listed inactive before T−60 | Inactive status at T−60, if the report met that mode's timing rules |
| After kickoff: recap says replacement excelled | Outcome/usage label only; never an earlier input |

Real official pages show why versions matter: the [Eagles Week 1 report](https://www.philadelphiaeagles.com/news/packers-vs-eagles-injury-report-week-1-2024) includes several days' reporting, while [Packers game-day inactives](https://www.packers.com/news/inactives-packers-eagles-week-1-2024) provide later availability. A final page containing Wednesday text cannot establish that its Friday information was available Wednesday.

Emit compact numerical/categorical features: practice trajectory, stated designation, known active/inactive state, learned active probability where unresolved, expected usage, role uncertainty, last update age, source conflict, replacement quality from earlier games, and coverage indicators. Missing collection is **unknown**, not healthy. No-report is meaningful only when a complete expected official report was actually observed. Syndicated copies do not increase confidence as independent reports.

**Pass:** advancing the replay clock changes only events newly eligible at that time; later updates cannot alter saved earlier packets; persistent statuses, byes and rescheduled games behave explicitly.

### Step 6 — learn how availability and news matter

Start with a regularized availability model using structured reports and lagged usage; add span-supported text features as a registered comparison. Predict active/inactive separately from expected snaps/touches conditional on availability. Treat exits during the game and coaching non-use explicitly when evaluating usage rather than teaching that every low-snap game was a predicted injury absence.

Turn those earlier-only estimates into small game-level features: expected QB contribution, expected lost usage by position group, likely replacement strength and uncertainty. A possible initial aggregation is the sum of expected unavailable usage times an earlier-estimated player-to-replacement difference, with units and assumptions stated. Fit its downstream value against outcomes; do not install fixed universal “QB out = X points” adjustments or call observational associations causal injury effects.

Every upstream player model must produce chronological out-of-fold predictions for downstream game-model training. Training a player model on the whole dataset and then joining its historical outputs would leak, even if the final game split were chronological.

Compare on identical eligible games:

1. Market baseline and football baseline.
2. Football plus structured availability.
3. The same system plus text/quote features.

Compare both standalone football improvement and incremental value after conditioning on the contemporaneous market. News can be useful football information already fully reflected in the price. Start with the first two systems; do not let scarce text delay a working model.

**Pass:** predictions trace to source events and earlier upstream fits; text's added benefit is measured separately; weak or absent benefit yields an explicit inconclusive/reject verdict.

### Step 7 — implement weekly training and historical replay

Add a weekly replay entry point under `research/betting/nfl/`, reusing existing lab estimators, dataset code and probability contracts. Preserve current whole-season lab outputs as comparisons. Expose explicit season/week bounds, fit time, cutoff policy, provenance mode, dataset ID, seed and candidate configuration; commands must be implemented and exercised before documenting them as runnable.

Initial deployment policy: fit the candidate **Wednesday at 12:00 America/New_York**, using only labels and source versions available then. Store the timezone-aware UTC instant for each fit. Keep model parameters fixed through the following Tuesday; refresh legal news/quotes at each game cutoff. A game before a scheduled fit uses the previous eligible artifact. If collection or fitting fails, preserve the last eligible model and record freshness rather than fabricating a successful update. This is a declared starting schedule, not an optimized claim.

Replay this same policy historically. For each fit origin:

1. Build an immutable eligible training manifest. Exclude unsettled labels. Use prior-season and already available current-season games; do not impose an entire-season lockout on weekly learning.
2. Generate earlier-only upstream football/player predictions and preprocessing within inner chronological folds.
3. Fit the small preregistered ridge/LightGBM comparison. Select settings only on inner folds. Estimate calibration and ensemble weights from earlier held-out predictions, never fitted values.
4. Save the chosen model, preprocessing, feature schema, training cutoff, calibrator and hashes.
5. At each game's cutoff, reduce the eligible event timeline, join its quote, score once and freeze predictions for every eligible game including abstentions.
6. Append outcomes when available; append closing quotes separately. Refresh the next fit using the declared policy. Do not alter earlier predictions after settlement.

Weekly refitting of a fixed recipe is allowed; changing the feature set, search budget or selection rule starts a new experimental version. The full adaptive recipe is what the evaluation measures. Old repeatedly inspected years remain development data.

### Step 8 — measure the right things in separate reports

| Layer | Required report |
|---|---|
| Sources/extraction | Eligible coverage, timing/version failures, freshness, duplicate rate, historical identity errors, sampled claim precision/recall, conflicts and unknowns |
| Player availability/usage | Active-status Brier/log loss and calibration; usage error with clearly defined labels, subgroup sizes and unresolved cases |
| Football predictions | Paired MAE/RMSE versus simple baseline; signed bias; distribution scores where available; season/era and diagnostic-group results |
| Betting probabilities | Log loss/Brier on a stated outcome space; calibration; key-margin/push behavior at the actual offered handicap |
| Prices/execution | Offered odds and quote age, EV, attainable-paper-bet accounting, stake-weighted ROI, uncertainty and drawdown; CLV as a separate aligned-price metric |
| News contribution | Full-pipeline comparisons with/without structured injury and text features, both before and after adding the market |

If a binary classifier excludes pushes, its estimate is conditional on a non-push. Preserve it as such. To price a bet, use unconditional probabilities: `EV per unit risked = P(win) × profit_if_win − P(loss)`, with pushes returning stake. Estimate push mass from earlier data or a validated discrete distribution; do not use a generic probability disagreement threshold as a substitute for positive EV after vig.

Report unique games, weeks, bets, prices, exclusions and coverage for every comparison. Compare paired losses on the same games with week/block uncertainty and sensitivity to cross-week dependence. Label small groups inconclusive. Do not turn game snapshots, books or multiple players into inflated sample counts. Keep probability edge distinct from realized closing-line movement.

### Step 9 — treat news-to-market movement as its own later experiment

Review `nfl-news-event-impact.js`, its runner and tests. The inspected target is absolute next-quote probability movement; neither direction nor a fixed horizon is established by that target. Group all claims for the same game/week together in evaluation so duplicate stories cannot land in both train and test.

If quote coverage supports the experiment, predeclare reaction horizons and tolerances, maximum stale-before quote age, and the reference book/contract. Join each event to the intended game, rather than any future fixture involving that team. Use only information available at the event cutoff. Require actual local receipt/extraction clocks for latency claims; retrospective publication-based results are a different experiment.

Compare price-only/no-move, structured event, and combined models. Measure line movement and price movement separately: implied probabilities at different handicaps are not probabilities of the same event. Use matched-handicap prices or explicitly model the handicap change. Keep no-reaction/stale/missing cases in the coverage report rather than selecting only fast-moving quotes. Record overlapping news events and do not interpret correlation as the causal effect of one article.

### Step 10 — verify integrity, connect serving and choose improvements

Run targeted checks on the new pipeline: future-data mutation, extraction/revision clocks, historical player identity, exact market/price matching, duplicate events, game-grouped splits, upstream out-of-fold fits, missing sources, push settlement, interrupted/resumed backfill, and training/serving numerical parity. Reuse relevant repository tests; do not run live collectors or mutate live databases merely to import a module for a check.

Use the master plan's error report to decide the next experiment. A weak subgroup nominates a hypothesis; it does not justify a model automatically. Test the smallest fix, refit both full systems, retain failed attempts, and confirm on later uninspected games. Do not silently change gates to force a positive result.

Connect the trained Python artifact to the frozen T−60 runner, decision trace, settlement and error report. Produce a complete shadow game/slate demonstration using identical saved inputs. Keep learning, engineering integrity and betting authority distinct. No automatic stake increase accompanies a successful implementation.

### First work package Claude should deliver

Deliver Steps 1–5 as a narrow, verified slice: reconciled current status; shared dataset/time contracts; pilot source manifest; versioned claim extraction; and replayable player/game timelines. Develop the basic football model independently where news is missing. Then deliver the weekly baseline and structured-injury comparison from Steps 6–8, followed by shadow integration. Text impact and market-reaction models earn later priority through evidence.

For each slice return changed files, commands actually run, test results, dataset/source coverage, example frozen records, measurements where available, and remaining limitations. Save the runnable command/configuration manifest in the repository alongside the evidence. Finish the authorized slice before proposing more research. If source history is unavailable, name the gap, retain unknown values and continue the parts that do not depend on it.

## Expanded engineering specification, dependencies and effort

This expansion defines the implementation work behind the six stages and ten execution steps. It adds depth to the betting pipeline, measurement and football modeling; it does not authorize every experimental architecture to enter the first model. The master plan remains the source of truth. Work-package IDs below are implementation units, not separate agents or automatic task launches.

### Size of the project and estimating assumptions

This is a data-engineering, applied-statistics and model-serving project inside an existing application. Training a tree is a small part of it. Reconstructing legitimate historical inputs, joining player and quote identities, reproducing weekly learning, validating measurements and connecting the result to actual decisions account for much of the work.

The following are **rough planning estimates in engineer-days**, not measured task durations, a fixed quote, or an estimate of unattended AI runtime. One engineer-day means a focused working day including review and relevant verification. Existing fixes may shorten work after reconciliation; missing source history may lengthen it or make particular experiments impossible.

| Workstream | Estimated effort | Main uncertainty |
|---|---:|---|
| Current-state reconciliation, defects and statistical contracts | 5–9 days | Which fixes already work in the active checkout and populated database |
| Historical data, identity, clocks and extraction contracts | 8–15 days | Actual source completeness and historical version quality |
| News/injury pilot, extraction, timelines and availability features | 8–16 days | Recoverable reports, historical identity and text extraction accuracy |
| Weekly training, calibration and fair comparisons | 8–15 days | Existing lab reuse, sample sizes and upstream chronology |
| Serving, frozen decisions, settlement and operational verification | 7–14 days | Existing runner integration and migration/restart behavior |
| Error analysis, adversarial checks and final integration review | 5–9 days | Defects discovered by full-pipeline exercises |
| **Core implementation estimate** | **41–78 days** | Re-estimate after the first end-to-end pilot |

For one experienced engineer this is roughly **8–16 working weeks** for the core scope, subject to these assumptions. A useful initial baseline and frozen shadow path is a smaller milestone, provisionally **15–30 engineer-days** within that total. The estimates overlap in dependencies but must not be added twice. AI assistance may accelerate implementation; it does not eliminate data validation, review or waiting for future games. No staffing or external spending is committed by this estimate.

A broader follow-on with validated player/drive/distribution models could require another **20–50 engineer-days**, conditional on what the error report shows. Graph networks, transformers and foundation models are not included in that range without a specific experiment design. Do not interpret this as a commitment to build them.

**Evidence time is separate:** historical development tests can run once data and code are ready. Prospective performance accumulates only as eligible games occur. Engineering completion cannot establish a durable betting edge; the time needed depends on effect size, uncertainty and bet frequency and may exceed a season. Estimate data-fetch, LLM and compute costs from the pilot, not from invented prices or an assumed complete archive.

### Milestones and the critical path

| Milestone | Required result | Dependencies |
|---|---|---|
| M0: trustworthy status | One reconciled defect/implementation ledger and frozen baseline | WP01–WP02 |
| M1: replayable examples | A historical week can be rebuilt with source lineage and honest cutoffs | WP03–WP07 |
| M2: first learned comparison | Baseline plus one restrained tree family, chronological predictions and error report | M1, WP11–WP14 |
| M3: complete shadow path | Frozen input → actual trained artifact → decision trace → later settlement | M2, WP15–WP17 |
| M4: news earns or fails its place | Structured availability and text contributions measured separately | WP08–WP10, M2 |
| M5: maintainable weekly operation | Repeatable updates, restart recovery, versioned evaluation and prioritized improvements | M3–M4, WP18–WP20 |

M1–M3 must be able to proceed with explicit missing-news features. News ingestion and extraction can progress independently after the source contracts are settled. New deep models must not delay getting one verifiable prediction through the complete path.

Within each milestone start with one complete example, then a representative fixture set, then the bounded real pilot, then larger history. Do not spend the entire budget building warehouse tables before testing their consumption by a learner and a serving packet.

### WP01 — reconcile current work and preserve the baseline

**Inspect:** git status/log, the repository work log, `docs/CLAUDE-NEXT-STEPS.md`, baseline evidence and the current gate-ownership/freshness reports. Treat comments and commit messages as pointers to inspect, not proof that an issue is fixed.

**Implement:** a machine-readable work ledger with work-package ID, source commit, dirty-file hashes where applicable, task state, evidence paths, dependencies and open limitations. Preserve incumbent predictions, exact configs, data identities and results. Record a distinction between the current working checkout and the version actually running in the app.

**Verify:** recreate at least one saved baseline calculation from its evidence. Where old runs lack reconstructable inputs, retain the limitation rather than manufacturing a new baseline with today's data.

**Exit:** every relevant original finding is classified confirmed-open, already-fixed-with-evidence, partially-fixed, superseded or unverified. A reviewer can identify the next unfinished package without rereading the entire audit corpus.

### WP02 — repair numerical defects and define gate responsibilities

Recheck specialist row/weight dimensions, QBR season identity, current feature updates, calibrator identities and the statistical promotion path. Add regression tests for actual failure mechanisms, including realistic row/feature shapes and data versions; a finite array alone is not enough if predictions or gradients remain wrong.

Define one owner and one recorded reason for each check:

| Check class | Permitted effect |
|---|---|
| Source/schema/time invalid | Exclude the invalid input or example; disclose coverage loss and the fallback behavior |
| Optional source missing | Mark missingness/age and apply a trained or declared fallback |
| Candidate output invalid | Suppress that candidate's invalid output and record the failure |
| Evidence insufficient for money | Continue legitimate shadow predictions; withhold betting authority |
| Price/execution/exposure invalid | Abstain from that action; retain the underlying prediction for measurement |

Audit effective-trial adjustments and DSR/PBO inputs against appropriate references. A newer promotion integration does not fix an invalid statistical assumption automatically. Preserve legitimate data/execution controls when replacing per-component significance filters. Do not make the model appear better by excluding its bad predictions after seeing outcomes.

**Exit:** each stage records input count, rejected count/reason, output identity and fallback. A test demonstrates that insufficient betting evidence does not erase otherwise valid candidate forecasts from the research ledger.

### WP03 — canonical game, player and source identities

Create shared mapping contracts for canonical games, season type, relocated/renamed teams, neutral venues, rescheduled kickoffs, players, roster intervals, books and provider event IDs. Retain both the source identity and normalized identity. Resolve players using the roster/transaction interval valid at the event, not their current employer.

Handle exact-match confidence, ambiguous names, missing IDs and corrections explicitly. A player-week key alone is insufficient for every roster event, postseason case or source revision. Link injury/quote evidence to the specific target game. A future fixture for the same team must not accidentally become the event-study target.

**Exit:** fixtures cover a trade, duplicate player surname, changed team abbreviation, neutral venue, reschedule, bye and postseason week. Unresolved identities remain quarantined with raw evidence intact.

### WP04 — immutable source and dataset contracts

Use existing tables where their contracts are sound. The following are **logical records**, not instructions to create a second database with duplicate tables:

| Record | Minimum contents |
|---|---|
| Source document version | Source/URL, retrieval ID, content hash, raw or reproducibly retained content, publication/version bounds, receipt time, parser version and provenance class |
| Structured event | Source version, canonical entity, event type, supported value, evidence span/offset, historical roster version, event/publication/receipt/extraction clocks, supersedes/conflict references |
| Feature snapshot | Game/cutoff, schema ID, feature names/order/values, missingness/age, source-event references, extractor/transform identities, provenance mode |
| Training manifest | Eligible row IDs, label availability, split identities, source/schema/code hashes, random seeds, exclusion summary and configuration |
| Model artifact | Algorithm/settings, preprocessing, feature contract, fitted state, train-through instant, upstream model IDs, calibrator/combiner IDs and content hash |
| Prediction/decision | Snapshot/artifact IDs, numerical outputs, market quote and exact contract, policy/version, gate trace, timestamp, action/abstention and idempotency key |
| Outcome record | Game result, settlement rule/version, actual contract return, closing reference where available, append-only corrections and grading time |

Separate facts about historical public availability from facts about what this app actually received and processed. A later reconstruction is a valid research record with a different claim; never relabel it as actual prior capture.

**Exit:** changing a mutable upstream table after a snapshot is frozen cannot change its replayed output. A material source correction generates a new version and a new experiment identity rather than overwriting prior evidence.

### WP05 — source availability and coverage qualification

For each source write an admission specification: useful target, earliest/latest reliable period, publication semantics, units, identity fields, revisions, missingness, legal deployment availability, terms/source reference and expected refresh behavior. Use the publisher schedule as a starting point and actual records as evidence.

Maintain a coverage matrix by era and horizon. Expose the difference between “available in today's download,” “publicly available then,” and “captured by us then.” Old football seasons need not contain every modern field. Version each feature family’s availability rather than pretending the 1999 and 2024 rows have identical information.

**Exit:** the dataset report states games retained before/after each join and reveals concentration by team, season, source and horizon. Adding an optional field cannot silently turn the dataset into complete cases only.

### WP06 — common football feature pipeline

Extend the current shared dataset builder. Start with lagged scoring/efficiency, pace, opponent strength, rest/travel, venue and prior player usage. Define orientation once: home-minus-away for relative quantities, clear units for efficiency/pace and explicit season/era handling. Audit roof/weather fields for what was expected before kickoff rather than realized afterward.

For learned strength features implement offseason carryover, league/team/QB pooling and uncertainty about limited samples. Fit pooling and recency choices within inner earlier folds. Include a simple benchmark that uses longer historical information and a stated recent window; evaluate old-data usefulness rather than assuming all 25 years help equally.

Do not join closing-market summaries, actual future starters, full-season statistics or later-fitted ratings into an earlier feature row. Derived EPA/WP values need upstream model-vintage review. Preserve missingness and the number/age of prior observations.

**Exit:** a feature dictionary explains every first-model input, its time rule, training dependencies and valid range. Future-game mutation and home/away sign tests exercise the entire builder.

### WP07 — price-qualified examples and execution assumptions

Separate broad football training from exact-horizon betting extraction. Preserve the existing open/close experiments, but construct T−60 rows from an actual eligible offered quote. Missing close affects CLV coverage, not outcome-label eligibility. Retain exact period, market, side, handicap, odds, book, provider timestamps and local receipt.

Define book selection before evaluation: which books are considered accessible, how stale quotes are handled, how contemporaneous opposite sides are paired, and how ties are resolved. Best-price comparisons must use prices observable at that instant, not the best later snapshot. If historical data cannot demonstrate a fill, report an attainable-price assumption and a conservative sensitivity scenario, not an actual trade.

**Exit:** a saved quote reproduces payout and settlement on positive/negative American odds, integer pushes and both sides. Price movement and handicap movement remain separately labeled. Correlated books do not multiply the sample count.

### WP08 — news archive pilot and source adapters

Follow the weekly pilot protocol in the preceding section. Implement bounded date/team/source jobs with resume cursors, content caching, duplicate clustering and an explicit output manifest. Prioritize existing storage and structured reports, then official archived text, then available transcripts. Do not make a full-season LLM sweep the first action.

Build a reviewed extraction set of approximately 100–200 source passages from the pilot, spanning relevant claim types, ambiguous cases, multiple teams and uneventful reports. Separate examples used to revise the extractor from examples used to evaluate it. Measure errors by class and by player identity; do not hide a dangerous entity mistake behind high overall accuracy. These sample sizes are an engineering starting point, not a statistical guarantee.

**Exit:** source fetch/extraction can resume without duplicate claims or repeat billing for unchanged inputs, and its coverage/cost estimate supports a bounded expansion decision.

### WP09 — claim extraction, revisions and historical state

Extend typed extraction and evidence-span validation. Keep stated fact, source verification, extraction confidence and downstream playing probability separate. Correctly handle “not ruled out,” “did not practice,” estimated walkthrough participation, personal absence, rest, suspension and roster transactions. Neither an inactive designation nor zero snaps automatically establishes a medical cause.

Require deterministic historical identity resolution and exact supporting spans. Preserve source contradictions as features/uncertainty until resolved by later eligible evidence. Do not treat a repeated headline as independent corroboration. Support late-arriving reports without altering previously frozen decisions.

**Exit:** an annotated timeline demonstrates before/after states for at least a normal report progression, a same-day reversal, a long-term status and an ambiguous coach quote. The system can display exactly why a given cutoff has a given state.

### WP10 — availability, expected usage and replacement features

Build a player-game target dictionary before fitting. Distinguish active status, dressed but unused, expected offensive/defensive/special-teams participation, and realized postgame usage. Specify handling for unobserved labels, limited prior history and injuries occurring during the target game.

Fit a small regularized availability model; use pooled position/team priors when player-level samples are sparse. Estimate conditional usage and replacement strength using earlier observations. Propagate uncertainty to game features instead of replacing an unresolved player with a hard-coded point penalty.

Aggregate a manageable feature set: QB expectation, expected missing usage by position group, replacement quality, continuity/rotation uncertainty and missing-source indicators. More complex interaction networks can be proposed later when a documented error pattern survives simpler modeling.

**Exit:** downstream training consumes earlier out-of-fold upstream predictions. Structured-injury and text additions have separate ablations on the same games, including the market-conditioned comparison.

### WP11 — experiment configuration and capacity budget

Use one versioned experiment configuration. At minimum it specifies training target, decision horizon, provenance mode, allowed sources/features, fit schedule, data interval, inner/outer folds, candidates, seeds, primary metric, calibration method, betting policy, review schedule and output location.

A concrete starting search budget is three declared ridge regularization settings and three shallow LightGBM settings per primary target; choose exact values before inspecting comparative outcomes. This is a bounded engineering choice, not an optimal set proved by the research. Track separate targets, horizons, feature additions and calibrator variants in the experiment family. Record every attempted fit, including exceptions and rejected candidates.

Report games, weeks, class balance, time-weighted sample size and tree/feature complexity. Observation-to-parameter ratios and nominal week counts are diagnostics with limitations, not a universal theorem determining validity. Prefer regularization and measurable learning curves to arbitrary feature-by-feature profitability gates.

**Exit:** another run with the same manifest reproduces the fold membership, chosen candidate and predictions to declared numeric tolerances. Failed fits remain in the output.

### WP12 — nested weekly training and honest stacking

Implement the declared weekly fitting policy, using labels available at the fit instant. All learned transforms belong inside the fitting boundary: imputation, normalization, feature selection, strength ratings, availability models, ensemble weights, early stopping and calibration.

Use chronological inner folds for configuration decisions and outer weekly origins for assessment. Prevent the same game and its player/book/cutoff rows from straddling fitting and scoring partitions. Maintain explicit training row IDs for every upstream artifact; inspecting only the final model's cutoff is insufficient.

Compute learning curves over a small prespecified set of training spans to diagnose whether the first learner is data-limited, overfit or insensitive to extra history. These are tracked comparisons, not an unlimited search for a profitable start year. Report computation time and sample coverage.

**Exit:** an automated lineage check can trace one game prediction through every upstream fit and prove its result label did not enter any of them.

### WP13 — probability, push and uncertainty contracts

Return expected margin/total together with probabilities appropriate to the exact quoted contract. Define win, push and loss probabilities that sum to one and remain in bounds. Distinguish probability conditional on a non-push from unconditional probability used for EV. Preserve key-margin behavior in the simplest candidate distribution before trying advanced joint models.

Fit calibration on earlier held-out predictions. Score calibration, log loss/Brier, interval coverage/width and distribution coherence separately. Use the recovered conformal code and MAPIE comparisons to check mathematics, while measuring chronological coverage under time dependence and shift. A nominal interval is not a promise of game-by-game coverage or calibrated betting probabilities.

**Exit:** a known handicap change produces a coherent new probability from the stored distribution or an explicit unsupported-contract result. The app cannot reuse a probability for a different line simply because the team and game match.

### WP14 — evaluation engine and error report

Write prediction rows before aggregation. Every report must be reproducible from those rows and a versioned metric definition. Compare market, incumbent, simple football and candidate on identical eligible game sets; separately report the candidate's full coverage so common-set filtering cannot conceal failures.

Use paired loss differences, uncertainty that respects game/week dependence, season/era summaries and the prespecified diagnostic groups. Show bias as well as average error. Avoid discovery through hundreds of small slices without recording the search. Distinguish performance degradation from a source/route failure.

**Exit:** the report can answer: what changed, on which games, versus which baseline, by how much, with what uncertainty, using which prices, and whether the evidence was retrospective or captured prospectively. It can also return “inconclusive.”

### WP15 — artifact scoring and frozen prediction packets

Package the actual fitted Python preprocessing/model/calibration pipeline. Use a narrow, versioned scoring interface to Node. Validate schema, feature order, artifact hash, model age, finite outputs and probability coherence. Initially use one implementation for training and scoring; a second-language port needs numerical parity evidence.

Freeze all inputs and upstream model IDs, not just quotes. Include the valid candidate forecast even if betting is withheld. Record fallback identity and cause. A research report reader is not a model-serving interface.

**Exit:** after mutable tables change and the service restarts, the same frozen packet/model produces the same prediction within stated tolerance. Corrupt/incompatible artifacts fail explicitly with a recorded fallback or abstention.

### WP16 — decision policy and exposure accounting

Build one versioned policy that converts valid probabilities and offered odds into expected value and a recorded action. Preserve stake-return conventions, pushes, minimum usable price quality, freshness and exposure rules. Continue shadow-only operation until evidence supports a separately reviewed change in betting authority.

Treat correlated positions as related exposure: two books offering the same side are not independent opportunities, and opposing bets at different lines do not cancel automatically. Record any allocation logic and compare it against a deterministic baseline. Advanced copulas are not required to prevent obvious duplicate exposure.

**Exit:** both accepted and abstained decisions carry an explanation that can be regenerated from saved numbers and the policy version. A persuasive LLM explanation cannot change the numerical decision silently.

### WP17 — settlement, CLV and record corrections

Separate final-score settlement from closing-reference grading. Define how postponed/cancelled games, voids, pushes and result corrections are handled. Store corrections as new records with links to the original; never rewrite a historical prediction or apparent bet after the outcome.

For CLV specify a reference-book set, cutoff convention, missing-price treatment and whether the metric compares handicap points or prices at the same contract. Report it separately from realized returns; both arise from the same wagers and are not independent replications of an edge.

**Exit:** an independent fixture grader reproduces wins/losses/pushes, profit, total risked and ROI. Aggregate metrics reconcile to the row ledger, including abstentions, voids and missing closes.

### WP18 — operational reliability and resource accounting

Add idempotent jobs and an observable lifecycle: discovered, fetched, parsed, validated, snapshotted, scored and settled. Track attempts, last successful completion, source failures and pending work. Separate data arrival from model fitting so a new injury report can update features without retraining the entire model.

Design migration tests against both clean and representative populated database copies, especially where append-only guards exist. Exercise a restart during extraction, during artifact publication and near a cutoff. Late jobs must not backdate their output. Use atomic artifact publication and preserve the last eligible model when a new fit fails.

Measure local runtime, peak memory, data size, accepted documents and actual LLM usage. Record per-source failure/cost concentration. The plan does not create schedulers or initiate paid requests by itself; implementation must use the existing execution and authorization context.

**Exit:** failures produce visible records and recoverable queues rather than silently skipped weeks or fabricated successful jobs. A cutoff missed during an outage remains identified as missed.

### WP19 — adversarial review of the complete pipeline

Test the system, not only the helpers. Required challenges include:

- Append future games, revised stats, later news and closing quotes; prior features/predictions must remain unchanged.
- Move an article's receipt/extraction beyond cutoff; captured-mode eligibility must change correctly.
- Duplicate and syndicate a story; confidence and independent-sample count must not inflate.
- Change player/team mappings later; frozen historical identity must stay stable.
- Remove a source family; use the explicit missing-data path and measure coverage/forecast effects.
- Repeat game snapshots across books/horizons; split grouping and uncertainty accounting must remain correct.
- Supply wrong units, sign conventions, market period or handicap; quarantine or contract checks must catch them.
- Run the declared selection procedure on repeated suitable no-signal controls; investigate false discoveries without tuning indefinitely to the controls.
- Compare a naive time-leaking positive-control fixture with the valid path so integrity tests demonstrate they can detect a known leak.

No finite suite proves all leakage or overfitting absent. Document which failure classes were exercised and which historical sources remain unverifiable.

**Exit:** one integrated evidence package contains source/feature manifests, split lineage, predictions, reference metric checks, failure-injection results and remaining limitations.

### WP20 — prospective observation and improvement decisions

Freeze the adaptive recipe, decision horizon and evaluation review schedule before collecting new evidence. Record every eligible game and abstention. Allow scheduled refits under the same recipe; version any change to model families, feature sets, selection rules or authority policy.

Use the error report to prioritize specific hypotheses. Each proposed addition includes the observed weakness, sample size, mechanism, source readiness, simplest fix, research reference, complexity budget, confirmation period and accept/reject/inconclusive rule. Correct multiple comparisons and treat inspected future data as development if it becomes the basis for a redesign.

**Exit:** the system can operate, measure itself and choose a justified next experiment without another unbounded research sweep. Qualification remains a separate evidence decision; no fixed number of games automatically proves profitability.

### Advanced research backlog with explicit admission tests

These are research-backed options to evaluate after the basic path works, not mandatory extra modules.

| Candidate | Trigger worth investigating | First implementation and comparison | Main failure to guard against |
|---|---|---|---|
| Hierarchical Bayesian team/QB ratings | Early-season or replacement-QB weakness relative to baseline | Dynamic pooled ratings with offseason mean reversion; compare simpler shrinkage and current rating features | Priors/hyperparameters tuned on scored seasons; posterior certainty overstated |
| Player/lineup interaction model | Errors persist around multi-player absences or continuity after individual effects | Small position-group interactions before a graph model; chronological player estimates | Sparse combinations and retrospectively known starting lineups |
| Play/drive model | Repeated pace/possession or matchup errors | Estimate drive counts and scoring components from earlier plays; aggregate to game features | Treating plays as independent betting outcomes or using target-game plays |
| Discrete joint score model | Margins/totals reasonable but tails, pushes or joint behavior wrong | Validate integer support and marginal calibration, then compare joint likelihood and actual-contract probabilities | Synthetic validation mistaken for real edge; extra degrees of freedom without data |
| Copula/dependence model | A specific joint-probability/exposure task has miscalibrated dependence | Fit only after marginals work; compare a simple dependence baseline on later data | Multiplying unsupported marginal probabilities or unstable tail dependence |
| Mixture of experts | Stable evidence that different regimes need different mappings | Small regularized gate using only pregame inputs and honest expert predictions | Selecting the best expert after the game or multiplying searches |
| News/market event model | Timely text adds information beyond price history | Separate directional/fixed-horizon movement experiment and outcome-value comparison | Publication-to-receipt hindsight, mixed handicaps, overlapping stories |
| Transformer/graph/foundation model | Simpler models leave a defined sequence/interaction problem and adequate data exists | Fixed-budget benchmark against tabular/aggregated features, with model-vintage audit | Pretraining contamination, opaque historical knowledge, expensive overfitting |

For each adopted method cite the recovered paper/report and verification notes, pin the implementation/reference version, test mathematical contracts and measure its incremental benefit. A method being sophisticated is neither a promotion criterion nor a reason to discard useful simple baselines.

### Common acceptance checklist for every delivery

A work package is reviewable only when its return includes: problem and observed evidence; changes and current code identity; applicable research/source references; actual commands and relevant test results; example input/output; coverage and excluded cases; measured results where available; and limitations/next dependency. Avoid claiming connected or observed based solely on a synthetic test.

The minimum complete delivery is one full path with ordinary cases and failure cases: source capture/reconstruction → as-of features → earlier-only training → immutable artifact → frozen forecast → price/decision trace → settlement → error report. The advanced backlog begins only when this path can reveal whether an addition helped.

## Agent operating manual, research guardrails and code-review additions

This is the execution contract for agents implementing the work packages. Use it with the package specification and prompt below. It is not evidence that implementation has occurred. Agent prompts are prepared for the user to assign; this planning task has not launched implementation agents or changed the application.

### Context every agent must receive

- The objective is an NFL betting pipeline that learns from legitimate information, produces reproducible forecasts and measures incremental value against the market. Fantasy product work is outside scope; shared-module changes require checking affected callers.
- Real ML already exists. Do not start from “there is no ML,” rebuild every expert, or infer model quality from a working UI. The unresolved issue is trustworthy data, numerical correctness, training/serving integration and honest measurement.
- Use the active checkout, inspect its dirty changes, and reconcile prior work. The latest source inspection here was HEAD `21789a9` with dataset/lab/governance edits in progress. Earlier database counts belong to their recorded inspection; they are not automatically current.
- Reuse the installed `research/.venv` and the existing data, temporal, probability, decision and execution contracts. Do not choose a new database/framework simply because a research report mentions one.
- Work from immutable extracts or disposable database copies for experiments. Importing database-owning app modules can initialize state; inspect the import chain and use explicit test databases. Preserve append-only evidence and original failed runs.
- Read only the relevant research bundle plus its verification notes at first. Read a primary paper's relevant assumptions before implementing its mathematics. A report's recommended code change is an engineering suggestion, not a theorem.
- Separate development results, reconstructed historical evidence, actual prospective capture and confirmed execution. A manually recorded acceptance is not an independently confirmed sportsbook fill; the current execution lifecycle explicitly distinguishes that.
- A valid model may legitimately predict little beyond the market. Do not force nonzero model influence, relax an invalid-input check or select a convenient subset to make the result look successful.
- Keep learning and valid shadow scoring available when betting evidence is insufficient. Source integrity, forecast validity, evidence qualification and exposure checks have distinct purposes.
- Every new comparison belongs in the trial registry, including abandoned settings and post-hoc slices. “The test season is later” does not make repeatedly inspected history untouched.
- Output numbers only when computed. Use null plus a reason for unknowns, not invented probabilities, reconstructed timestamps presented as observations, or estimated test results.

### Reading priority and how to handle contradictory research

Start with the current package, the relevant code/tests, and one or two indexed reports. Use the [research index](../archive/recovery-indexes/START-HERE-research-and-audits.md) to find the broader corpus and the [complete inventory](../archive/recovery-indexes/INDEX.md) for supporting documents. The recovered research is substantial, but this plan does not claim every page has been independently reread or every recommendation validated.

The September 14 verification reviews are particularly useful:

- [Point-in-time architecture corrections](../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-point-in-time-ml-architecture.json): mutable tables, training/serving skew and why a single event timestamp is inadequate.
- [Walk-forward corrections](../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-walk-forward-validation.json): do not misquote sufficient conditions for cross-validation as universal prohibitions; deployment realism and non-stationarity justify our chronology. Synthetic finance comparisons do not establish the best NFL protocol.
- [Calibration/authority corrections](../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-bet-authority-calibration.json): do not import unstable ROI claims, assume a prior automatically eliminates no-edge bets, or equate calibration with safe Kelly sizing.
- [JS/Python corrections](../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-js-vs-python-implementation.json): claims that no alternative bindings exist, that ONNX must use float32, or that a toy tree is a production learner were overstated. Our Python-first choice is based on existing infrastructure and parity, not those claims.
- [QB/availability corrections](../research/september-14-sweeps/wf_65f8c9e5-bf5/verify-qb-injury-availability-value.json): benchmark formulas, data cutoffs and repository terms must be checked before reuse.

Some old reports prescribe native JS, prohibit new Python dependencies, require a particular old significance gate, or say “read-only tonight.” Those are dated implementation/session choices. They do not override the current user-authorized scope, Python-first architecture or the need to repair a defective gate. Keep the underlying lesson—chronology, explicit authority and verification—without reinstating obsolete mechanics.

In particular: Holm does not require independent base p-values, but it does require valid base tests. Do not repeat the old grouping of Holm with independence-dependent corrections. Likewise, a weighted conformal or block method is not automatically guaranteed under arbitrary NFL drift; state its actual assumptions and measured behavior.

### Research-backed mistakes to avoid

The references below point to recovered reports and, where available, verification corrections. They explain the design constraints. Any numerical guarantee must be checked against its primary source and the implemented assumptions before being advertised.

| ID | Do not do this | Required alternative and verification | Research reading |
|---|---|---|---|
| R01 | Join old games to today's final feature values and call the result historical | Retain publication, receipt, extraction and revision clocks; mutate future rows to test invariance | [F05 point-in-time](../research/advanced-methods-and-github/F05-bitemporal-pit.md) and architecture verification |
| R02 | Invent first receipt from provider publication or request start | Preserve actual response receipt; label reconstructions and timing uncertainty | F05; current quote/event contracts |
| R03 | Recreate Wednesday injury status from a final Friday report | Preserve exact source versions; unknown earlier versions stay unknown | F05; QB/availability verification |
| R04 | Fit preprocessing, team ratings, availability or calibration on the whole dataset before splitting | Fit the entire dependency chain inside earlier folds, retaining row-level lineage | Walk-forward and architecture verification |
| R05 | Stack in-sample predictions from component models | Use earlier out-of-fold component predictions and regularized combination | [F02 forecast combination](../research/advanced-methods-and-github/F02-forecast-combination.md) |
| R06 | Add many correlated experts because more models sound stronger | Compare a small candidate family; measure collinearity and incremental value; fit any reduction only on training data | F02 |
| R07 | Treat a 1999–2025 dataset as 25 years of equally informative modern football | Report era/feature coverage and time-weighted sample size; test recency choices inside the training protocol | [F08 dynamic ratings](../research/advanced-methods-and-github/F08-bayesian-state-space-ratings.md), [F15 shrinkage](../research/advanced-methods-and-github/F15-team-strength-shrinkage.md) |
| R08 | Turn millions of plays or repeated book quotes into millions of independent betting outcomes | Group by game/week and preserve the relevant dependence in uncertainty estimates | Walk-forward verification; F06 |
| R09 | Choose a favorable metric, subgroup, seed, horizon or start year after seeing results without counting the search | Preregister the comparison; retain all attempts and changes | [F06 multiplicity](../research/advanced-methods-and-github/F06-trial-registry-multiplicity.md), [GF10 registry](../research/advanced-methods-and-github/GF10-trial-registry-preregistration-code.md) |
| R10 | Use PBO/DSR as an objective to optimize or claim they restore a used holdout | Treat them as assumption-dependent diagnostics; confirm redesigned models on later uninspected data | F06; walk-forward verification |
| R11 | Discount model trials using incomparable ROI/MAE/Brier sequences without justification | Use aligned loss panels and a declared comparison family; validate dependence treatment | F06; statistical audit issue in this plan |
| R12 | Repeatedly check ordinary significance and stop when it looks good | Use prespecified review times or independently verified sequential methods with their assumptions satisfied | [F07 sequential inference](../research/advanced-methods-and-github/F07-sequential-inference-fix.md) |
| R13 | Assume a wide predictive interval means the expected edge is too uncertain, or vice versa | Distinguish outcome variability, model uncertainty and calibration uncertainty in the contract | F11; calibration/authority verification |
| R14 | Treat conformal coverage as proof of accuracy, cover probability or profit | Measure interval coverage/width separately from proper probability scores and executable returns | [F11 conformal](../research/advanced-methods-and-github/F11-conformal-calibration.md), [GF08 code](../research/advanced-methods-and-github/GF08-conformal-prediction-code.md) |
| R15 | Reuse one residual distribution/calibrator across different model identities and price horizons | Bind calibration to the actual prediction and contract; use earlier calibration data | F11; calibration/authority verification |
| R16 | Price an integer spread from a non-push binary probability without push mass | Return unconditional win/push/loss probabilities and use exact-price EV | [F17 NFL margins](../research/advanced-methods-and-github/F17-margin-distribution-lit.md); probability contracts |
| R17 | Copy a soccer goal model or fixed historical NFL standard deviation as the full score model | Validate NFL score support, key margins, tails and era behavior; compare simpler distributions | F17; [F01 simulator mechanics](../research/advanced-methods-and-github/F01-drive-sim-mechanics.md) |
| R18 | Calibrate around broken simulator mechanics and declare the physics fixed | First validate possessions, field direction, clocks, turnovers and period/OT behavior | F01, F17 |
| R19 | Treat related bet legs/positions as independent | Model or conservatively constrain dependence; fit copulas only after useful calibrated marginals exist | [F10 copulas](../research/advanced-methods-and-github/F10-copula-correlation.md), [GF06 dependence code](../research/advanced-methods-and-github/GF06-copula-dependence-code.md) |
| R20 | Convert a coach quote into an arbitrary injury probability or point adjustment | Extract supported facts; learn availability and impact from earlier labeled examples | [N13 injury interactions](../research/advanced-methods-and-github/N13-injury-network-propagation.md); QB/availability verification |
| R21 | Call market movement after a story its causal effect | Separate prediction from causal identification; handle overlapping events, price history, receipt delays and controls | [F13 news impact](../research/advanced-methods-and-github/F13-causal-news-impact.md) |
| R22 | Feed a modern LLM a historical game and accept its remembered outcome as blind prediction | Use span-supported extraction and prospective validation; maintain reconstruction labels | Architecture/calibration reviews; current AI audit |
| R23 | Treat publication, extraction, truth, activity probability and win probability as one confidence number | Keep each quantity separately named and measured | F05, N13, F13 |
| R24 | Transfer rankings, thresholds or claimed profits from baseball, NBA or finance directly to NFL | Use them as hypotheses/reference math; test on appropriate NFL information and outcomes | F15; walk-forward and calibration verification |
| R25 | Assume a known advanced method or GitHub repository is correct, licensed for reuse, or production ready | Read relevant code/terms, pin a version, use independent fixtures and an actual full-pipeline comparison | [GF09 nflverse](../research/advanced-methods-and-github/GF09-nflverse-ecosystem-code.md), GitHub catalog and verification reviews |
| R26 | Present better CLV and better returns from the same bets as two independent proofs | Report both, recognize dependence, use exact contracts and a stated close benchmark | F13; calibration/authority verification |
| R27 | Increase stakes or remove safeguards because the model now produces non-market numbers | Require valid outputs, matching calibration, explicit evidence and separately authorized betting policy | Calibration/authority verification |
| R28 | Call an uncomputable robustness test a pass | Return not-estimable/inconclusive with the missing sample requirement | F06/F07; new error-analysis finding below |

### Additional gaps found in the current source

This was a targeted review, not a new claim of complete line-by-line coverage. Findings refer to `21789a9` plus the reported working changes. Recheck before implementation. “Reproduced” below means isolated synthetic behavior, not demonstrated financial loss. The [probe results](../audits/plan-code-checks/PLAN-CODE-CHECKS.json) preserve the output.

| ID / priority | Evidence | Required work and completion check |
|---|---|---|
| C01 / P1 | `server/betting/nfl/contracts/forecast-packet.js:89–163`: isolated probes accepted an invalid receipt timestamp, null/empty feature values, a nonfinite feature, odds of zero, `market='totals'` with spread-style fields, and a cutoff after kickoff | WP02/WP04/WP13: validate field types, enum combinations, timestamp ordering, finite values, allowed missingness and schema compatibility. Each reproduced malformed case needs a regression test. |
| C02 / P1 | Same module, `packetHash` at line 193: `[NaN]` and `[null]` yielded identical hashes through JSON serialization; nonfinite features also passed validation | Validate before hashing/sealing or make nonfinite values unrepresentable. Preserve legitimate explicit null/missing values. Test semantic distinctions rather than replacing every null with zero. |
| C03 / P1 | `nfl-t60-packet.js::resolvePacketMarketQuote` independently chooses latest home/away rows. An isolated fixture returned home −3 and away +2.5 as one available result without mismatch disclosure; downstream `quoteFor` uses the home timestamp for either side | WP07/WP15: preserve per-side identity/time and exact contracts. Two different lines can be individual offers, but cannot be treated as opposing prices for one de-vigged contract. Add asynchronous-update and moved-line fixtures. |
| C04 / P2 | The same resolver chooses a preferred book before checking it has a home quote. A fixture with only an away quote there and a complete second book returned unavailable | Select among eligible complete candidates under a declared policy or state why a single-sided quote is used. Test fallback without fabricating a missing price. |
| C05 / P1 | `t60-runner.js:141–235`: selection reads only `state='scheduled'`; a board/tape failure leaves the row `frozen`. The inspected `runT60Pass` has no separate frozen-packet retry phase | WP15/WP18: recover from frozen evidence without refetching its inputs. Distinguish an on-time result from a late reconstruction; record actual completion/action times. Retry idempotently if a tape write succeeded before linking the observation failed. No claim is made here about the cause of each historical stranded row. |
| C06 / P1 for historical cutoff use | `nfl-t60-packet.js:674` constructs all historical kickoffs with fixed `-04:00`; its comment acknowledges the standard-time error | WP03/WP07: use a canonical UTC kickoff or an explicit America/New_York conversion with date/DST tests. Existing coarse diagnostic output is not a safe T−60 training builder. |
| C07 / P1 | `server/news/store.js:33–47` updates headline/body/publication metadata on a duplicate row while retaining its original `ingested_at` | WP08/WP09: preserve immutable document versions before updating the current view. Today's revised body plus an old ingestion clock is not proof that body was known earlier. Test a Friday edit of a Wednesday article. |
| C08 / P2, coverage-contract risk | `nfl-t60-packet.js` injury/news queries admit unresolved teams; the news coverage query also lacks a verification-state filter. These paths primarily report counts, not frozen claim values | WP03/WP09/WP15: separate discovered, identity-resolved, verified, timely and actually consumed counts. Do not count unknown-team/unverified evidence as usable game features. Preserve raw records for later resolution. |
| C09 / P2 | `nfl-replay.js:648` already implements error slicing, Holm adjustment and effect checks. At line 721, fewer than three seasons returns `robust: true` with a caveat | WP14/WP20: reuse useful code, replace not-estimable-as-pass with an explicit state, retain full-precision test values for decisions and review base-test assumptions. Passing a later heuristic does not establish valid inference. |
| C10 / design gap | `nfl-slice-diagnostic.js` analyzes historical expert rows, derives probabilities from a normal-CDF approximation and joins current `game_lines`; `nfl-replay.js::analyzeErrors` takes bets | WP14: adapt reporting to saved all-game candidate probabilities, abstentions and frozen context. Existing diagnostics are useful foundations but not the complete new model error ledger. |
| C11 / design gap | `nfl-family-contribution.js` already has matched-game comparisons and paired weekly bootstrap; it is oriented to the current ensemble and spread path | WP12/WP14: reuse metric contracts, but verify full refits and upstream lineage for the new Python candidate; separately wire totals. Do not label a family with no numerical consumer a scientific zero-effect result. |
| C12 / design gap | The declared forecast contract and current packet-board path are spread oriented; totals appear in research but are not automatically supported by this contract | WP13/WP15–WP17: version market-discriminated spread/total schemas, scoring and settlement. Complete one spread slice first, then a full total slice; do not pass totals through by renaming one field. |

**Verification performed:** the existing pure forecast-packet test file passed all 14 tests. The additional isolated probes still accepted the seven malformed cases above. This is concrete evidence that passing the existing suite does not cover these cases. No application modules owning a database were imported for the probes, and no application source, live database or bet settings were changed. The quote selector was evaluated in an isolated JavaScript context with synthetic values.

### What a good deliverable looks like

Every package returns one concise human report plus structured artifacts. Its evidence must let the next agent reproduce the result without relying on the previous agent's explanation.

| Deliverable | Required content | Unacceptable substitute |
|---|---|---|
| Status/change report | Actual source identity, package ID, existing work reconciled, changed files, completed state, remaining dependency | “Implemented everything” without evidence |
| Source/coverage manifest | Source versions, timing/provenance, unique games, exclusions by reason, fetch/extraction cost where applicable | Total row count or “data cleaned” |
| Example lineage | One game and each upstream source/feature/artifact reference, including clocks and missingness | Only a hash, aggregate counts or a screenshot |
| Training/selection record | All candidates/settings, exact splits, fitting row IDs, seeds, upstream OOF artifacts and failures | Only the winner's score |
| Prediction ledger | All eligible games, actual saved outputs/probabilities, quoted contract, artifact/policy identity, abstentions | Selected winning bets or regenerated predictions |
| Evaluation | Paired baseline comparison, metric definition, sample/coverage, uncertainty, search exposure and verdict | ROI alone, unsupported significance or “beats Vegas” |
| Verification | Actual command, runtime, exit status, test counts, representative failures addressed | A test plan described as tests run |
| Handoff | Artifacts, accepted contracts, next dependency, remaining uncertainty and rollback/recovery behavior | A long narrative with no executable next step |

An example **synthetic verification result**, not a real model result: a Wednesday DNP report, Friday questionable update and pregame inactive notice produce different eligible feature snapshots. Adding the later inactive notice leaves Wednesday's saved feature hash and prediction unchanged. Running a revised article through the source store creates a new version instead of making Friday text appear received Wednesday. Running the same completed extraction again emits no duplicate events.

An example **synthetic pricing check**: `P(win)=0.53`, `P(push)=0.02`, `P(loss)=0.45`, odds `−110` gives expected profit per unit risked of `0.53×(100/110)−0.45 ≈ 0.03182`. Probabilities sum to one; a push returns stake. This is an arithmetic fixture, not an estimated edge or permission to bet.

An example **acceptable performance verdict**: “Candidate comparison completed, coverage and parity verified. Its improvement interval includes zero, so predictive benefit is inconclusive. Shadow scoring is connected; betting qualification is unchanged.” A negative or inconclusive finding can complete the engineering task successfully.

For artifact paths use a package/run directory under the repository's existing evidence layout, with manifest, commands, test results, coverage, predictions and comparison as applicable. Store large source/data/model artifacts in the established data/artifact location with a manifest reference; do not commit the live database or raw secrets. Generated filenames and CLI names proposed in this plan must be labeled proposed until implemented and exercised.

### Coordination and file ownership

One lead owns shared contracts, schema/migrations, the master ledger and cross-package integration. A package agent owns its assigned source/test changes and returns a patch or commit plus evidence. A reviewer checks the result against an independent expected behavior, not just the implementation's own outputs.

Do not concurrently edit `dataset.py`, forecast-packet contracts, the migration list or shared governance files without explicit ownership. Agents discovering a cross-package issue should report its reproduction and dependency to the owner. Do not reset another worker's changes. A large number of research or implementation agents is not a quality metric.

The critical handoff chain is: stable identities/clocks → feature/schema contract → weekly training/probability outputs → frozen serving/settlement → evaluation. News retrieval can progress once the document/timing contract exists; richer text features must not block the basic model. Review one complete spread path before copying the design to totals.

### Review prompt to use after each package

> Review this package against its assigned WP specification, R guardrails and relevant C findings. Inspect the actual diff, tests and saved artifacts. Independently recompute at least one numerical or temporal result where applicable. Check that the output corresponds to the same data, model, horizon and code used by the consumer. Search for a counterexample the new tests do not cover. Classify findings by consequence and separate confirmed reproductions from hypotheses. Do not declare a whole system qualified from helper tests, require unrelated scope, or silently fix the author's code while reviewing. Return accept, changes required, or inconclusive; name the exact evidence and remaining integration dependency.

### Lead-agent kickoff prompt

> Implement the Gridiron betting rebuild from GRIDIRON-MASTER-PLAN.md. First reconcile the active checkout, existing implementation and dirty changes. Use the agent operating manual and WP01–WP20; begin with the first unfinished dependency, not another broad research sweep. Resolve the new C01–C12 findings in their owning packages. Assign bounded package prompts only when delegation is authorized and file ownership is clear. Require the specified evidence from each package, review it, and integrate one complete frozen spread prediction through settlement before broadening to totals or advanced models. Preserve existing research and failed experiments. Keep model learning, data integrity and betting authority distinct. Continue useful work when a source gap blocks another package; record unknowns honestly. Return the updated ledger, actual artifacts/tests, measured results and limitations. A working pipeline with no demonstrated edge is an acceptable outcome; do not manufacture a positive verdict.

## Package prompts and exact edit map

Use the shared operating manual with each prompt. Existing paths below were checked during planning, but must be rechecked against the active checkout. Paths are relative to the repository root declared in each prompt. Proposed modules are suggestions, not claims that files or commands already exist. The lead owns shared contracts/migrations and must resolve overlapping edit ownership before assigning concurrent work.

### WP01 prompt — Reconcile implementation and preserve baseline

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** None; starts the implementation.

**Existing code/docs to inspect and edit within scope:** `docs/CLAUDE-NEXT-STEPS.md`, `docs/reference/model-governance-manual.md`.

**Existing verification to extend:** Choose focused tests after inspecting the active callers; do not claim a nonexistent test command was run.

**Proposed additions, only if the existing code cannot own the contract cleanly:** Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.

**Task:** Reconcile the current checkout, dirty-file ownership, deployed version and prior evidence. Classify earlier findings using actual source/tests rather than comments. Create the single work ledger and preserve the incumbent configuration, predictions and metric definitions. Do not overwrite a current plan or rerun paid/live jobs just to inventory them.

**Required return:** A current status ledger; a frozen baseline manifest or an explicit explanation of missing reconstruction evidence; a dependency/ownership map identifying the next unfinished package.

**Acceptance/counterexamples:** Recompute one available baseline example from its saved inputs. Distinguish historical inspection counts from refreshed observations. A written claim that a bug is fixed is not verification.

**Research guardrails:** R01,R09,R25. **Code findings:** C01–C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP02 prompt — Repair defects and gate responsibilities

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP01.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-orthogonal-specialists.js`, `server/services/nfl-qbr.js`, `server/services/trial-statistics.js`, `scripts/run-purged-evaluation.mjs`, `server/services/model-governance.js`, `server/betting/nfl/contracts/forecast-packet.js`.

**Existing verification to extend:** `test/nfl-qbr.test.js`, `test/trial-statistics.test.js`, `test/forecast-packet-contract.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** test/nfl-specialist-weight-shape.test.js

**Task:** Reproduce relevant numerical/data/gate defects on isolated fixtures before fixing them. Check specialist dimensions, QBR season identity and the current DSR promotion integration. Resolve validator behavior C01/C02 with the contract owner. Separate invalid data/output from insufficient betting evidence so valid shadow predictions remain measurable. Do not repair a statistical assumption merely by lowering its threshold.

**Required return:** A defect-by-defect before/after report and targeted regression tests; one gate responsibility table with caller, condition, effect and recorded reason.

**Acceptance/counterexamples:** Exercise tall and small design matrices, corrupt or duplicate season rows, malformed packet fields and a valid forecast withheld only from staking. Reference-check statistical calculations before using them for promotion.

**Research guardrails:** R04,R11,R27,R28. **Code findings:** C01,C02.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP03 prompt — Historical identities and exact clocks

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP01 and ownership agreement for dataset/packet contracts.

**Existing code/docs to inspect and edit within scope:** `server/services/team-codes.js`, `server/services/nfl-contract-key.js`, `server/services/nfl-t60-packet.js`, `research/betting/nfl/dataset.py`.

**Existing verification to extend:** `test/team-codes.test.js`, `test/nfl-t60-packet.test.js`, `research/betting/nfl/test_dataset.py`

**Proposed additions, only if the existing code cannot own the contract cleanly:** test/nfl-historical-clock-identity.test.js

**Task:** Define canonical game/player/provider mappings and timestamp precision. Replace the fixed historical -04:00 assumption for cutoff construction with reliable UTC or named-timezone conversion. Resolve player identity from historical roster intervals and retain ambiguous cases. Preserve schedule revisions and distinguish date-only records from precise kickoff instants.

**Required return:** An identity/time dictionary; mapping and exclusion manifest; fixtures for a trade, alias, ambiguous name, neutral venue, reschedule, bye, postseason and winter/summer offset.

**Acceptance/counterexamples:** Check one winter and one summer kickoff independently. A date-only game must not silently qualify as an exact T−60 packet. Later roster changes must not rewrite a frozen historical mapping.

**Research guardrails:** R01,R02,R03. **Code findings:** C06,C08.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP04 prompt — Immutable records and validated contracts

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP02–WP03.

**Existing code/docs to inspect and edit within scope:** `server/betting/nfl/contracts/forecast-packet.js`, `server/services/nfl-bitemporal.js`, `server/services/nfl-decision-tape.js`, `server/db/migrate.js`.

**Existing verification to extend:** `test/forecast-packet-contract.test.js`, `test/nfl-injuries-bitemporal.test.js`, `test/migration-027-populated-upgrade.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A new migration allocated after inspecting the current migration sequence; never rewrite an applied migration

**Task:** Implement the source/event/feature/artifact/decision contracts from WP04. Reuse existing stores and append-only conventions. Validate semantic types, market discriminants, timestamp order, finite numbers and missingness before hashing. Define compatible schema evolution and retain exact values rather than counts. Separate the general forecast schema from the older T−60 source-summary packet with an explicit adapter.

**Required return:** A versioned schema/adapter and migration where needed; real example records; lineage links; old/new compatibility behavior and invalid-record reasons.

**Acceptance/counterexamples:** C01 malformed cases must fail or follow a documented legitimate missing-value path. C02 nonfinite values cannot collapse into null unnoticed. Replaying frozen evidence after source mutations is invariant. Test a populated database copy as well as clean setup.

**Research guardrails:** R01,R02,R13,R15,R16. **Code findings:** C01,C02,C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP05 prompt — Coverage and source admission

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP04.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-feature-coverage.js`, `server/services/nfl-evidence-dataset.js`, `research/betting/nfl/dataset.py`.

**Existing verification to extend:** `test/evidence-dataset.test.js`, `research/betting/nfl/test_dataset.py`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A source-admission manifest in the existing evidence/artifact layout

**Task:** Extend the current source/freshness reports into source-specific admission rules and coverage by game, era, team and horizon. Distinguish discovered, resolved, verified, timely, snapshotted and consumed records. Record every join denominator and exclusion reason. Consult nflverse release schedules and pin source versions; a present-day file is not proof of past availability.

**Required return:** A coverage matrix, source admission contracts and before/after-join game counts with sampled source records. Mark unverifiable timing and missing data explicitly.

**Acceptance/counterexamples:** Removing one optional source does not delete valid football examples. A source with many unrelated/unverified rows cannot pass game-specific readiness. Every excluded example has a reproducible reason.

**Research guardrails:** R01,R03,R07,R08,R25. **Code findings:** C08.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP06 prompt — Shared football features and strength priors

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP05.

**Existing code/docs to inspect and edit within scope:** `research/betting/nfl/dataset.py`, `research/market_lab.py`, `research/tree_lab.py`, `server/services/nfl-features.js`, `server/services/nfl-team-strength.js`, `server/services/nfl-preseason-blend.js`.

**Existing verification to extend:** `research/betting/nfl/test_dataset.py`, `research/test_market_lab.py`, `research/test_tree_lab.py`, `test/nfl-team-strength.test.js`, `test/preseason-blend-cutoff.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.

**Task:** Extend the common builder already being edited; do not fork its chronology. Define the small first feature set, units, missingness and prior-observation ages. Use broad price-independent football history, earlier opponent/QB information and learned shrinkage where justified. Keep labels and unqualified market fields outside the allowlisted model matrix. Preserve old extractor results as explicit comparisons when semantics change.

**Required return:** A feature dictionary, shared extract, consumer-parity report, source lineage and era coverage. Each learned feature names its own training cutoff.

**Acceptance/counterexamples:** Future scores, revised EPA or target-game players cannot change an earlier vector. Home/away signs, away-team rest, Week 1 fallback and optional PBP are covered. Calibrate priors within earlier folds, not globally.

**Research guardrails:** R04,R05,R07,R24. **Code findings:** C06 and earlier dataset chronology findings.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP07 prompt — Exact-horizon quote and betting datasets

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP05; coordinate shared dataset ownership with WP06.

**Existing code/docs to inspect and edit within scope:** `research/betting/nfl/dataset.py`, `server/services/nfl-quote-tape.js`, `server/services/nfl-contract-key.js`, `server/services/nfl-evidence-dataset.js`, `server/services/nfl-t60-packet.js`.

**Existing verification to extend:** `research/betting/nfl/test_dataset.py`, `test/evidence-dataset.test.js`, `test/nfl-t60-packet.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A T−60 extraction entry point under research/betting/nfl, sharing the current dataset module

**Task:** Add exact T−60 examples separately from opening-line experiments. Resolve C03/C04 with a declared eligible-book policy, per-side identities/clocks and correct opposing-contract pairing. Missing closing prices must not discard valid outcome examples. Preserve spread and total label definitions, provenance mode and actual odds. Do not infer a fill from an archived offer.

**Required return:** A betting dataset manifest and quote-selection trace showing retained, missing, stale, mismatched and fallback cases; labels are separate from feature columns.

**Acceptance/counterexamples:** Test a moved handicap, asynchronous opposite-side update, missing preferred-book home side, alternate period and unavailable close. Two individual offers at different lines must not be de-vigged as the same contract.

**Research guardrails:** R02,R08,R16,R26. **Code findings:** C03,C04,C06,C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP08 prompt — Historical news source pilot

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP05; document schema owner assigned.

**Existing code/docs to inspect and edit within scope:** `server/news/ingest.js`, `server/news/store.js`, `server/news/normalize.js`, `server/services/press-conference.js`.

**Existing verification to extend:** `test/news-ingest.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A bounded archive backfill runner with absolute date/team/source filters and resume state

**Task:** Run the specified 2024 Weeks 1–4 engineering pilot only after defining source/version contracts. Use existing stored material, structured reports and official dated archives before expensive transcription. Add content-addressed source versions before updating the current news view. Preserve raw supported content and timing precision. Build an independently reviewed extraction sample and measure coverage/cost before extending seasons.

**Required return:** Source manifests, retrieval/resume log, source-version examples, a reviewed passage set and measured usable coverage/cost. No performance claim from this pilot.

**Acceptance/counterexamples:** A changed Friday body cannot inherit Wednesday ingestion as its own receipt. Repeating the same fetch does not duplicate versions. Missing archives are explicit and do not block the football baseline.

**Research guardrails:** R01,R02,R03,R22,R25. **Code findings:** C07.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP09 prompt — Typed events and historical injury timelines

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP03–WP04 and initial WP08 material.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-news-events.js`, `server/services/nfl-news-signal.js`, `server/services/nfl-advanced.js`, `server/services/nfl-bitemporal.js`, `server/services/nfl-t60-packet.js`.

**Existing verification to extend:** `test/nfl-news-events.test.js`, `test/nfl-injuries-bitemporal.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** An absolute-date-range event extraction/replay interface using existing stores

**Task:** Extend supported-span extraction, historical roster resolution, source-version references and separate receipt/extraction clocks. Build the shared as-of state reducer. Retain practice trajectories, contradictions, superseding events and unresolved persistent statuses. Unknown teams and unverified claims remain preserved but are not admitted as usable game features. Keep structured parsing separate from LLM interpretation.

**Required return:** Player/game timelines at T−72h, T−24h and T−60; event schema/examples; extraction quality by claim type; coverage and unresolved-state reports.

**Acceptance/counterexamples:** Test negation, ambiguous pronouns, multi-player stories, an inactive reversal, traded players, byes and long-term IR. Later events cannot alter an earlier snapshot; repeated syndicated text is not independent evidence.

**Research guardrails:** R01,R03,R20,R22,R23. **Code findings:** C07,C08.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP10 prompt — Availability and replacement learning

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP06, WP09 and WP11 protocol; may proceed after baseline launch.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-availability.js`, `server/services/player-availability.js`, `research/betting/nfl/dataset.py`.

**Existing verification to extend:** `test/player-availability.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** research/betting/nfl/availability.py; research/betting/nfl/test_availability.py

**Task:** Define active-status and conditional-usage targets, including healthy non-use and in-game exits. Implement a small regularized availability baseline and earlier-estimated replacement features. Use historical rosters, structured reports and lagged usage. Treat LLM extraction confidence as separate from playing probability. Add text only as a separately registered experiment after structured availability works.

**Required return:** Target dictionary, player model artifacts and chronological OOF outputs, calibration/usage reports and compact game-level availability features.

**Acceptance/counterexamples:** Audit upstream train row IDs for every output used by the game learner. Actual target-game snaps/starters cannot enter features. Compare structured and text additions on identical games with and without contemporaneous market information.

**Research guardrails:** R04,R05,R20,R23,R24. **Code findings:** Earlier news/availability integration findings.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP11 prompt — Registered experiments and bounded model selection

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP01, WP04–WP05; before comparative model fitting.

**Existing code/docs to inspect and edit within scope:** `server/services/research-trials.js`, `server/modeling/registry.js`, `research/requirements.txt`, `research/tree_lab.py`, `research/market_lab.py`.

**Existing verification to extend:** `test/research-trials.test.js`, `test/model-registry-persistence.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A versioned NFL experiment specification under research/betting/nfl

**Task:** Define a machine-readable experiment specification covering data/source mode, target/horizon, folds, candidates, seeds, metrics, calibration, policy and review schedule. Reuse the existing trial registry; inspect whether generic model-registry APIs actually apply to NFL before integrating. Freeze a small ridge/LightGBM configuration family and record all attempted settings, failures and later changes. Snapshot installed dependency versions.

**Required return:** Experiment specification, trial records, candidate budget, runtime/dependency manifest and artifact-naming rules. No hidden best-seed or best-era selection.

**Acceptance/counterexamples:** Changing data, schema, source mode or feature family produces a distinguishable experiment identity. Failed fits and unsuccessful variants remain discoverable. A registration after scoring is labeled retrospective.

**Research guardrails:** R06,R09,R10,R11,R25. **Code findings:** Statistical promotion integration requires current reconciliation.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP12 prompt — Weekly nested training and OOF lineage

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP06–WP07, WP11; availability optional until WP10 ready.

**Existing code/docs to inspect and edit within scope:** `research/betting/nfl/dataset.py`, `research/tree_lab.py`, `research/market_lab.py`, `server/services/purged-walk-forward.js`, `server/services/forecast-combination.js`.

**Existing verification to extend:** `research/betting/nfl/test_dataset.py`, `research/test_tree_lab.py`, `test/purged-walk-forward.test.js`, `test/forecast-combination.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** research/betting/nfl/walk_forward.py; research/betting/nfl/test_walk_forward.py

**Task:** Implement weekly refits matching the master schedule while preserving old seasonal comparisons. Every preprocessing step, upstream learner, early-stopping choice, combiner and calibrator must use earlier data. Keep entire games and related snapshots together. Produce chronological OOF features for downstream fitting, and save train/test row IDs. Do not replace old holdout predictions with fitted values after final refitting.

**Required return:** Runnable weekly experiment entry point, immutable split manifests, all-candidate predictions, selected artifacts and a complete upstream lineage example.

**Acceptance/counterexamples:** A held-out outcome mutation does not change its model or feature inputs. Same-game leakage through player/book/horizon rows is refused. Newly available current-season labels can enter the next scheduled fit under the declared policy.

**Research guardrails:** R04,R05,R07,R08,R09. **Code findings:** C11 reuse requires actual refit verification.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP13 prompt — Probability, calibration and pushes

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP04, WP07, WP11–WP12.

**Existing code/docs to inspect and edit within scope:** `server/betting/nfl/contracts/spread-probabilities.js`, `server/betting/nfl/contracts/forecast-packet.js`, `server/services/nfl-cover-calibration.js`, `server/services/nfl-total-calibration.js`, `server/services/conformal.js`.

**Existing verification to extend:** `test/spread-probabilities.test.js`, `test/nfl-total-calibration.test.js`, `test/forecast-packet-contract.test.js`, `test/conformal-finite-sample.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A Python probability/calibration module with parity fixtures for the declared serving contract

**Task:** Bind probabilities/calibration to model identity and exact market/horizon. Specify spread versus total schemas explicitly. Convert conditional non-push probabilities to unconditional win/push/loss probabilities using earlier-estimated push mass. Keep conformal intervals distinct from betting probabilities. Reuse existing corrected math and independent references; do not port a second implementation without parity evidence.

**Required return:** Market-discriminated probability contract, earlier calibration manifest, proper-score and coverage reports, key-margin/push fixtures and explicit unsupported cases.

**Acceptance/counterexamples:** Probabilities are finite, sum to one and yield correct price-based EV. Changing the line requires rescoring that contract. C01 malformed market combinations fail; valid totals require their own complete path, not a renamed spread.

**Research guardrails:** R13,R14,R15,R16,R17. **Code findings:** C01,C02,C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP14 prompt — Measurement and actionable error analysis

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP11–WP13; reuse historical reports as references only.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-replay.js`, `server/services/nfl-slice-diagnostic.js`, `server/services/nfl-family-contribution.js`, `server/services/stats-util.js`.

**Existing verification to extend:** `test/nfl-replay-error-analysis.test.js`, `test/nfl-family-contribution.test.js`, `test/family-contribution-scoring.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A report adapter for the new Python row-level prediction ledger

**Task:** Reuse existing diagnostics and paired-score contracts, but connect actual all-game outputs, abstentions and frozen context from the new learner. Fix not-estimable-as-robust in C09. Separate loss, probability and return comparisons; evaluate base-test/dependence assumptions before applying multiplicity. Preserve full precision for decisions and round only displays. Measure full-pipeline refitted ablations, not just disabled outputs.

**Required return:** A reproducible error report and ranked hypothesis backlog; row-level inputs; matched baselines; sample/coverage and uncertainty; explicit inconclusive states.

**Acceptance/counterexamples:** A one-season slice cannot pass a multi-season check. No-bet games are retained for forecast evaluation. A family with no numerical consumer is labeled disconnected. Hypotheses discovered in the report require later confirmation.

**Research guardrails:** R08,R09,R11,R24,R28. **Code findings:** C09,C10,C11.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP15 prompt — Trained-artifact serving and frozen recovery

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP04, WP07, WP12–WP13.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-auto-picks.js`, `server/services/nfl-t60-packet.js`, `server/betting/nfl/contracts/forecast-packet.js`, `server/betting/nfl/strategy/t60-runner.js`, `server/services/nfl-decision-tape.js`.

**Existing verification to extend:** `test/t60-runner.test.js`, `test/forecast-packet-contract.test.js`, `test/nfl-decision-identity-pipeline.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A narrow versioned Python artifact-scoring adapter with integration tests

**Task:** Connect the actual fitted pipeline to the app through a narrow scoring interface. Freeze all consumed features, quotes, transforms and model identities; no mutable-table rereads in the learned path. Implement recovery of frozen observations using their stored evidence and idempotent tape linkage. Preserve actual late completion times and classify replay versus on-time decisions correctly.

**Required return:** One complete spread-game demonstration and then a slate; artifact/snapshot/decision linkage; numerical parity; explicit fallback and recovery traces. Extend to totals only with WP13 contracts ready.

**Acceptance/counterexamples:** A restart or source mutation cannot change frozen outputs. Invalid artifacts fail explicitly. A tape write/link interruption neither duplicates the decision nor strands it forever. The same quote is not falsely assigned another side’s timestamp.

**Research guardrails:** R01,R02,R15,R16,R27. **Code findings:** C01–C05,C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP16 prompt — Betting policy and related exposure

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP02, WP07, WP13, WP15.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-execution-edge.js`, `server/services/nfl-execution-exposure.js`, `server/services/nfl-execution-staking-policy.js`, `server/services/model-governance.js`, `server/services/nfl-auto-picks.js`.

**Existing verification to extend:** `test/nfl-execution-edge.test.js`, `test/nfl-execution-exposure.test.js`, `test/nfl-execution-decision.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.

**Task:** Make one versioned authority/execution policy consume saved valid probabilities and actual offered odds. Keep shadow prediction available while qualifications are unresolved. Trace every gate result and reason. Preserve related-position accounting across books/markets. Review any AI allocation separately against a deterministic baseline. Do not increase live stakes as a side effect of integration.

**Required return:** Policy contract, deterministic EV/action fixtures and examples of valid forecasts that abstain for distinct reasons; exposure and duplicate-opportunity behavior.

**Acceptance/counterexamples:** Push EV, invalid price, stale quote, duplicate same-side opportunity, opposite positions at different lines and no-edge cases behave explicitly. An LLM explanation cannot silently change numerical authority.

**Research guardrails:** R16,R19,R23,R27. **Code findings:** C03 and market-specific policy integration.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP17 prompt — Independent settlement and CLV grading

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP07, WP13, WP15–WP16.

**Existing code/docs to inspect and edit within scope:** `server/services/nfl-execution-lifecycle.js`, `server/services/nfl-execution-clv.js`, `server/services/nfl-execution.js`, `server/services/nfl-decision-tape.js`.

**Existing verification to extend:** `test/nfl-execution-lifecycle.test.js`, `test/nfl-execution-clv.test.js`, `test/nfl-execution-clv-abstained.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** Prefer extending the existing owners. Add focused fixtures/artifacts as required, not a duplicate subsystem.

**Task:** Grade the exact recorded contract and price with versioned settlement rules. Keep actual confirmed fills, user-reported acceptance and paper opportunities distinct. Append corrections without rewriting original predictions. Define the close benchmark and report missing closes separately. Handle spreads and totals through their declared contracts, not shared ambiguous field names.

**Required return:** Independent settlement fixture calculations, a reconciled row-to-summary ledger, closing-reference specification and cancellation/push/correction examples.

**Acceptance/counterexamples:** Win/loss/push/void and positive/negative American odds reconcile to risked stake and profit. Missing close does not erase a settled outcome. CLV at different lines is not mislabeled same-contract price improvement.

**Research guardrails:** R16,R19,R26,R27. **Code findings:** C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP18 prompt — Reliable jobs, migrations and resource limits

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP04, WP08–WP09 as available, WP15–WP17.

**Existing code/docs to inspect and edit within scope:** `server/betting/nfl/strategy/t60-runner.js`, `server/db/migrate.js`, `server/services/nfl-news-events.js`, `server/news/store.js`, `server/platform/paths.js`.

**Existing verification to extend:** `test/t60-runner.test.js`, `test/nfl-prospective-collection.test.js`, `test/migration-027-populated-upgrade.test.js`, `test/news-ingest.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** Targeted job-recovery, artifact-publication and populated-schema tests

**Task:** Implement observable job states, bounded retries, resume cursors and atomic artifact publication. Separate source arrival from scheduled fitting. Recover frozen decisions without new inputs and retain the previous eligible model if a fit fails. Exercise migration behavior on populated copies and append-only guards. Track accepted-document costs, time, memory and failure concentration from actual runs.

**Required return:** Lifecycle/retry specification, restart evidence, populated/clean migration results, resource report and a recovery/rollback runbook.

**Acceptance/counterexamples:** Interrupt fetch, extraction, artifact publish and tape linking. Resume without duplicate writes or repeat billing for cached unchanged work. Missing a cutoff remains visible; no job backdates receipt or completion.

**Research guardrails:** R01,R02,R25. **Code findings:** C05,C07.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP19 prompt — Challenge the complete system independently

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** M3 complete path; can review individual packages earlier.

**Existing code/docs to inspect and edit within scope:** `test/offline-guard.mjs`, `test/forecast-packet-contract.test.js`, `test/nfl-replay-error-analysis.test.js`, `test/nfl-family-contribution.test.js`.

**Existing verification to extend:** Choose focused tests after inspecting the active callers; do not claim a nonexistent test command was run.

**Proposed additions, only if the existing code cannot own the contract cleanly:** An integrated frozen-prediction/chronology challenge suite and self-contained synthetic fixtures

**Task:** Review the complete implemented path against the master threat cases and all C findings. Write tests that cross module boundaries, not mirrors of implementation formulas. Use independent arithmetic/temporal expectations, known-leak positive controls and repeated appropriate no-signal controls. Inspect import-time effects before testing, keep databases disposable and prevent provider calls. Report failures to their owning packages rather than rewriting unrelated production code.

**Required return:** A reproducible adversarial verification report, coverage of each failure class, actual commands and clear unresolved findings. Preserve raw negative outcomes.

**Acceptance/counterexamples:** Exercise future mutation, source revisions, historical identities, duplicate stories, player/book split leakage, moved contracts, malformed packets, restarts and metric reconciliation. Passing 14 existing packet tests is insufficient if the seven known malformed cases still pass validation.

**Research guardrails:** R01–R28. **Code findings:** C01–C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

### WP20 prompt — Prospective ledger and evidence-driven expansion

Work in `/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard` after confirming the active checkout and file ownership. Read the master plan's agent operating manual, your WP specification, relevant R guardrails and C findings. Inspect existing code and tests before editing; preserve dirty changes and historical evidence. Use the installed research environment and established contracts. Separate source/model correctness, retrospective evidence, prospective observation and betting authority. Never invent missing clocks, probabilities, source records or passing results. Return implemented work with actual tests and artifacts, or an explicit blocked dependency while completing independent work. Do not launch a new broad research sweep or increase live stakes.

**Dependencies:** WP14–WP19; protocol must be frozen before using future results.

**Existing code/docs to inspect and edit within scope:** `server/services/research-trials.js`, `server/services/model-governance.js`, `server/services/nfl-replay.js`, `docs/CLAUDE-NEXT-STEPS.md`.

**Existing verification to extend:** `test/research-trials.test.js`, `test/nfl-replay-error-analysis.test.js`

**Proposed additions, only if the existing code cannot own the contract cleanly:** A versioned prospective protocol and hypothesis-backlog artifact in the existing evidence layout

**Task:** Freeze the adaptive fitting recipe, prospective observation horizon and review schedule. Preserve every eligible prediction and abstention, including version changes and missed observations. Use the error report to propose the smallest fix for a measured weakness. Require later confirmation for discovered hypotheses and retain rejected/inconclusive additions. Distinguish engineering completion from predictive value and betting qualification.

**Required return:** Prospective protocol, versioned evidence ledger, ranked improvement backlog and one example accept/reject/inconclusive decision with its evidence requirements.

**Acceptance/counterexamples:** Changing a feature/search/policy starts a new evidence segment. A failed or uncomputable robustness check never becomes a pass. Advanced methods need a specific error, suitable data and a simpler baseline before implementation.

**Research guardrails:** R09,R10,R12,R24,R27,R28. **Code findings:** C09–C12.

**Completion report:** name package state, actual code identity, changed files, commands/tests run, output paths, measured result or unknown, unresolved dependencies and the next handoff. Explain any departure from the proposed edit map. Do not mark the full model qualified merely because this package passes.

## Current system findings and problem register

**Historical inspection snapshot:** the findings below were checked at `43af933` or reported in recovered inventories. Consult the later execution-section reconciliation at `21789a9` before treating any as still open. Database counts have not been refreshed in this planning pass.

### Verified findings

| Finding | Evidence and consequence |
|---|---|
| Production forecast copies the market | 65/65 rows in `nfl_decision_events` have `is_market_identity=1`, `matching_calibration_missing`, and `calibration_not_proven`. This describes recorded decisions, not every historical experimental prediction. |
| Component gate never passed | 1,390 `nfl_ensemble_fit_artifacts` contain 43,090 component rows; zero have `residual_gate_passed=true`. `nfl-ensemble.js:1887` requires n≥250, RMSE gain≥0.03 and a computable DM p≤0.05, then zeroes failing components. |
| A real numerical defect silences specialists | `nfl-orthogonal-specialists.js:71` allocates observation weights by feature count. An isolated 40-row reproduction produced all-NaN coefficients. Changing the allocation to row count produced finite coefficients. The change was tested in isolation only; the repository remains unchanged. |
| Historical training counts were overstated | There are **7,276** completed home-game rows with scores and spreads in 1999–2025, not the inventory's stated 7,445. Two team rows must not count as two games. |
| Detailed history is much shorter | `nfl_play_by_play` has 254,191 rows spanning 2021–2026. `nfl_team_week_features` spans 2016–2025, with **zero 2026 rows**. Current predictions risk stale football inputs even though quote capture continues. |
| QBR feed contains corrupt season data | 520 rows labeled 2026 match 2025 rows on player/week/team and four statistical fields; 508 rows are labeled future weeks 2–18. Repair ingestion and quarantine affected source versions, including erroneous Week 1 copies; merely dropping future weeks is insufficient. |
| Frozen decisions are only partly wired | T−60 observations: one decided with a linked run, 13 frozen without a run, one scheduled. These counts do not establish why each remains frozen. `autoPickDecisionBoardForPacket` freezes the quote but reads game context and team features from live tables. |
| General revision store is empty | `nfl_feature_revisions` has zero rows. `nfl_pregame_snapshot_history` has 3,914 rows, but that is not a substitute for complete revision history of every feature. |
| Live neural model has no trained artifact | `nfl_online_neural_artifacts` has zero rows. Historical council neural experiments are a separate path. |
| Python tree libraries are already available | `research/.venv/bin/python` is Python 3.12.4; LightGBM, XGBoost, CatBoost, sklearn, pandas, scipy and TPOT are discoverable. Torch is absent. No installation is needed to start the tabular rebuild. Existing recorded runs also establish that these learners have executed before. |
| Tree tests were small, but not all 219 games | `server/data/tree-lab/latest.json` contains 1,795 market rows, not unique games. Its first movement folds use 219/215 games; later branches/folds reach 733. The 449 exclusions are reported as invalid/unpaired timestamp rows, not verified unique games. The extract explicitly restricts archive seasons to 2022–2025. |

The old tree results are negative evidence for the tested configurations. A small sample and limited features justify a better experiment; they do not establish that more data will make the model profitable.

### Remaining problem register

These items come from the recovered inventories, selected code checks, and existing evidence documents. Entries not independently reproduced in this review remain reported findings to validate during their implementation slice.

#### Learning and model construction

1. Challenger-only flags exclude nine components without a normal promotion path. Convert their legitimate underlying information into candidate features; do not grant them betting authority automatically.
2. The production council is disconnected from the primary forecast. Some roles are support functions with no forecast; “19 experts” does not mean 19 independent predictive models.
3. The coordinator applies another significance gate before combination. Its reported split-half check uses even/odd rows, not chronological folds.
4. `MIN_SEASON=2015`, pre-2022 component calibration, and Week-5 feature/audit defaults exclude useful old data, recent recalibration, and early-season games respectively.
5. Many formulas use fixed scales; several market-derived components reuse the same information. Raw blending can pull a strong market forecast toward weaker estimates.
6. Existing specialists reportedly stack in-sample predictions, and some same-day news filters lack timestamp precision. Reusing their output blindly can introduce leakage.
7. Listwise feature deletion, current-season-only warmups, and unexplained residual clipping discard data. Replace missingness with explicit flags and priors where appropriate; preserve genuine data-integrity exclusions.
8. Neural epoch resets and whole-week settlement dependencies can strand training examples. Preserve historical evidence across epochs while separating incompatible feature/model versions.
9. Signal-reliability updates are disabled in production and their artifact store was empty in the inventory. Multiple controllers currently apply overlapping shrinkage or authority rules.
10. Forecast combination, joint-score, and specialist code is not equivalent to an approved learned pipeline. The joint-score report explicitly uses synthetic data and does not clear its stated gate. Validate any distribution on real chronological football data before reuse for prices.

#### Data and time integrity

11. Scores/closing lines extend to 1999; raw plays, charting, player detail, and verified quotes do not. Backfill data by source and season, rather than just changing a year constant.
12. Older opening lines have mixed identities and provenance: contest lines, lookahead lines, and unresolved medians are not interchangeable with real opening quotes.
13. Some archive quotes are timestamped after kickoff; historical near-kickoff snapshots are sparse. Apply the actual decision cutoff, not merely “before kickoff,” when evaluating T−60.
14. Historical final weather is not a forecast. Use archived forecast vintages where available. Missing weather forecasts remain missing.
15. Injury rows are overwritten; absent publication/receipt times cannot be replaced with an assumed Friday timestamp and called verified history.
16. Imported ratings, retrospectively generated QB values, full-season coach game counts, Hi/Lo ratings, actual starters, and late-revised feature aggregates can encode the future. Audit each field, not just the enclosing table's timestamp.
17. Derived vectors/cards with thousands of features and a cutoff label need lineage checks. A hash proves identity, not historical availability.
18. Current-season team feature refresh and QBR season validation need fixing before claiming that the system adapts to current football.

#### Serving, evaluation, and betting

19. Quote-only freezing is insufficient for reproducibility. Freeze feature values, model artifact identity, preprocessing and calibrator, alongside the quote.
20. Calibration identity differs between historical raw/closing and live market-residual modes. Preserve identity checks and generate matching calibration; do not bypass the check.
21. Several policy/staking thresholds conflict: 200 versus 250 observations, fixed edge/disagreement limits, and a 24-point prediction-width ceiling versus observed 32–33-point widths. Outcome unpredictability is not the same as uncertainty about expected advantage.
22. Recorded staking remains disabled. Enabling units or deleting gates cannot create predictive value.
23. 2021–2025 has been repeatedly inspected. It is development data, including when tested by a chronological “blind audit.” A new model cannot acquire prospective evidence retroactively.
24. Trial history is incomplete. Record every new feature set, tuning choice and failed candidate, not just survivors. Multiplicity corrections cannot reconstruct forgotten experiments or erase prior selection.
25. Point accuracy alone cannot establish betting profitability. Need probabilities at the exact handicap, push treatment, attainable prices, fees where relevant, realistic fills, correlated exposure, and independent settlement/CLV grading.
26. More plays improve estimates of football processes; they do not create millions of independent game outcomes. Cluster validation by game/week across every model level.

## ML and AI evidence

The following usage map and counts are from the earlier September 14 inspection. They remain evidence of that state, not a new measurement after subsequent commits.

### Usage map

| Component | Is it ML/AI? | Does it drive the main betting forecast? | What to do |
|---|---|---|---|
| `nfl-ensemble.js` | Statistical learning: fitted component scales and blend weights, with many hand-built formulas | Yes, but the production residual mode zeroes all model contributions in every stored fit checked | Reuse honest football inputs; replace the component significance filter with regularized learning/combination |
| Python `tree_lab`, `market_lab` | Genuine ML: LightGBM, XGBoost, CatBoost, ridge and other estimators | No deployed Python artifact-loading path was found in the main forecast. `nfl-research-lab.js` reads their reports for display | Reuse the installed environment, extraction lessons and evaluators; build a shared training/scoring interface |
| Council boosted-tree and neural experts | Genuine custom ML implementations | Research/historical candidate paths; the council appears in unified projection detail, but does not set that projection's mean or the main auto-pick mean | Generate legal chronological features/predictions; compare with library learners before adopting |
| `nfl-online-neural.js` | A small neural network with a training routine | The auto-pick path can use an eligible artifact, but the artifact table contains zero rows | Diagnose capture/settlement lifecycle; do not present an untrained head as current learning |
| Expert coordinator/specialists | Ridge, robust fitting, nearest neighbors and rules | Mostly research; several filters zero influence, and one numerical defect invalidates fitted coefficients | Repair math, use out-of-fold training, reduce duplicated shrinkage layers |
| `gridiron-model.js` | Primarily a capability/permission router, not a trained “master model” | Controls/explains which components may inform or size decisions | Keep authority separate from learned prediction and name the distinction accurately |
| `nfl-unified-engine.js` | Composes ensemble forecast, simulation and explanatory heads | Ensemble supplies target means; simulation supplies score shape. Council/news are attached as detail | One output object is not end-to-end learning. Validate mean and distribution contributions separately |
| Claude news extraction | LLM converts stories into typed facts | Facts enter cards and candidate neural/specialist features; direct numerical authority is zero and no predictive contribution is established | Keep source spans, identity, timestamps and contradictions; learn football impact from data |
| Claude pick/page/tweet explanations | LLM translation and summarization | Explains existing outputs; does not create calibrated probabilities | Keep optional and grounded; measure cost/usefulness separately from forecasting |
| Historical Claude replay gate | LLM reviews a preselected bet and returns approve/reduce/abstain/press | Separate retrospective research. Code labels incomplete source timestamps and denies production promotion | Do not mistake prompt memory for model training or filtered backtest returns for live proof |
| AI execution slate | Claude proposes/reviews allocation over already-gated shopping/teaser opportunities | Can affect recommended allocation in a separate endpoint; does not forecast game outcomes or transmit wagers | Require a deterministic allocation baseline and measured incremental benefit before crediting AI |

### What the usage records show

Recorded application API usage spans July 31–September 14. These records do **not** include the separate Claude desktop research conversation or its subscription usage, and token counts are not a billing reconciliation.

- 178 typed-news extraction calls; current signal table has 163 verified Claude-extracted signals and 36 quarantined ones. Rules separately generated 288 verified and 71 quarantined signals. Counts represent current rows, not extraction precision or recall.
- 557 tweet/line explanation calls, 32 page explanation calls, and 11 pick explanation calls.
- 203 historical replay-gate calls recorded on August 24. The current `nfl_ai_replay_runs` table is empty, so the corresponding performance cannot be established from that table today. The discrepancy needs provenance investigation, not an invented result.
- 28 execution-slate proposal calls and 28 review calls, recorded September 7. Calling an LLM twice is not independent verification; the review sees its own initial allocation.
- The newer news-event extractor and press-role inference have only one recorded call each. The event table holds 10 news-item and 20 press-conference events.
- Team-analysis prose accounts for 536 calls, approximately 1.49 million input and 350,335 output tokens. It is not evidence of a trained game predictor. Fantasy/draft calls were also recorded but are outside this review's scope.

There is real AI activity. There is no demonstrated link here from the volume of that activity to an improved betting forecast. No fine-tuning API path was found in the inspected server/research code. The replay's “learning memory” supplies past summary statistics in a prompt; it does not update Claude's model weights.

### AI-specific weaknesses

1. **Fact extraction is not impact estimation.** The news expert uses fixed multipliers such as burden difference ×0.75 (and a fallback ×0.5). Claude identifying “QB out” does not mean the system learned the replacement's effect or what the market already priced.
2. **Extraction confidence is not win probability.** Keep text confidence, source reliability, player availability probability and forecast uncertainty as separate quantities.
3. **News timing needs both clocks.** `playerNewsSignal` filters `published_at` but not the time the app first received/extracted the claim. Historical reconstruction must not label a later extraction as a captured-before-decision fact. The typed-event path has `first_seen_time`; carry this through the shared feature contract.
4. **Outcome-blind prompts do not prove historical blindness.** A modern pretrained LLM may know identified historical games. The replay packet includes game identity; hiding the score alone is insufficient. Treat such experiments as retrospective and test contribution prospectively.
5. **Self-review is not an independent forecast.** Allocation simulation evaluates assumptions supplied to it; a persuasive second explanation cannot validate the assumptions or the probabilities.
6. **Labels overstate integration.** “Unified engine,” “expert council,” “learning memory,” and “research complete” refer to different mechanisms. Surface the actual artifact ID, training-through date, current input age and contribution to the served number.

## Recovered Claude research and audits

The recovered collection is substantial. Much was in Claude's temporary session folders rather than the repository's docs directory; the preserved originals and source manifest remain available.

- **Research2:** 56 main topic reports, two architecture/code catalogs and 12 scoring-note documents, totaling 70 Markdown files. Topics include point-in-time data, forecast combination, Bayesian ratings, shrinkage, conformal calibration, multiple testing, sequential inference, NFL margins, copulas, injury/news effects and deeper ML architectures.
- **September 14 methods sweep:** 14 reports and 13 verification reviews. The open-source survey has no completed verification result.
- **System audit:** 59 Markdown documents, including the large full-system synthesis and detailed code-group reviews.
- **Audit-system review:** 41 Markdown documents covering historical evaluation, timing, evidence and deployment consistency.
- **Plans and references:** the Giant Plan, What Next, master-plan versions and 81 source/reference files. Some are PDF/text duplicates; this is not 81 unique papers.

The final learned-model redesign produced four inventories, but the design, critique and revised specification failed at the usage limit. A completion notification did not mean the final design was delivered. The broader scale sweep had no finished reports in its journal. The original audit also has a completeness critique documenting coverage gaps; do not describe it as verified line-by-line coverage of everything.

Read relevant reports together with verification corrections when implementing their slice. Historical reports contain superseded findings; the problem register distinguishes reproduced checks from items still requiring confirmation. The current plan incorporates selected research methods with explicit jobs and validation requirements, rather than assuming advanced terminology proves correctness.

Original evidence entry points:

- [Research and audit index](../archive/recovery-indexes/START-HERE-research-and-audits.md)
- [Complete preserved inventory](../archive/recovery-indexes/INDEX.md)
- [Full system audit](../audits/recovered-line-by-line/SYSTEM_AUDIT_2026_09_11.md)
- [Audit completeness critique](../audits/recovered-line-by-line/COMPLETENESS-CRITIC.md)
- [Audit-system review](../audits/recovered-audit-system/AUDIT_SYSTEM_REVIEW.md)
- [Recovered research architecture](../research/advanced-methods-and-github/FIX_AND_ADD_ARCHITECTURE.md)
- [Recovered GitHub catalog](../research/advanced-methods-and-github/GITHUB_BUILD_CATALOG.md)
- [Claude's Giant Plan](archive/claude-september-12/GRIDIRON_GIANT_PLAN.md)
- [Claude's What Next](archive/claude-september-12/WHAT_NEXT.md)

The implementation, data/research choices, improvement-selection process and acceptance requirements are consolidated in this master document. The linked originals preserve supporting evidence and historical context.
