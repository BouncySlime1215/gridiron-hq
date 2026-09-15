# Betting-model audit and profitability-remediation plan — 2026-09-15

**Status: independent audit + proposed remediation plan. Not (yet) the active plan.**
The one active work-order plan remains [`docs/CLAUDE-NEXT-STEPS.md`](../../CLAUDE-NEXT-STEPS.md).
If Nick adopts this, reconcile it into that plan rather than running two roadmaps.

Audit performed against the committed tree at git HEAD `43af933` (branch cut from
`main`). Every code claim below is cited to a file and is verifiable on this checkout.

---

## 0. Accuracy boundary — read this first

Two tiers of claim appear in this document, and they are kept separate on purpose:

- **Live-code-verified** — read directly from source at `43af933` (wiring, gate
  logic, connectivity, ML usage, defect locations). High confidence.
- **Doc-sourced** — performance/record/ROI/calibration numbers quoted from the
  dated reports and `docs/CLAUDE-NEXT-STEPS.md`. These were **not** reproduced in
  this audit environment: this is a fresh clone whose SQLite has **0 rows** in
  every betting table (`game_lines`, `nfl_ensemble_fit_artifacts`,
  `nfl_auto_picks`, `nfl_quote_tape`, `nfl_play_by_play`, `nfl_t60_observations`,
  `nfl_online_neural_examples` all count 0). The empirical numbers can only be
  reproduced against the developer's populated (~9 GB) database. Where a number is
  doc-sourced it is labelled as such.

The full integrity suite runs green-enough here to trust the mechanisms:
**2000 tests, 1937 pass, 21 fail, 3 cancelled, 39 skipped** (`npm test`, isolated
temp DB + enforced offline guard). The 21 failures are being triaged separately;
initial reads indicate data-/environment-dependent cases rather than the core
model math, but that triage is not yet complete and is tracked in Phase 0 below.

---

## 1. What the betting model actually is, in code

Production NFL spread pick path (verified):

`nfl-auto-picks.js` `computeDecisionBoard`/`buildCandidate`
→ `nfl-ensemble.js` `ensembleWeek`/`ensembleLine` (default `blendMode:'market_residual'`)
→ `nfl-online-neural.js` `onlineNeuralPrediction` (shadow)
→ `nfl-cover-calibration.js` `calibratedCoverProbability`
→ `nfl-policy.js` `applyNflPolicy`
→ `nfl-decision-tape.js` `recordDecisionRun`.

The scheduled collector is `server/betting/nfl/strategy/t60-runner.js` (registered
as `nfl_t60_runner`, live tier, 5-min cadence).

### 1.1 The ensemble is a market-anchored residual that usually equals the market

`nfl-ensemble.js` registers **31 components** (9 challenger-only). Under the
production `market_residual` blend, the served margin is

```
margin = marketMargin + Σ residual_weight·residual_slope·(component − marketMargin) / Σ residual_weight
```

A component earns `residual_weight` only if it clears a strict walk-forward gate
(`nfl-ensemble.js` ~1887): **≥250 OOF games**, **≥0.03 RMSE gain vs market**, and a
week-clustered **Diebold–Mariano p ≤ 0.05**. When no component passes,
`residualWeight === 0` and the margin is arithmetically the closing line
(`is_market_identity === true`, `nfl-ensemble.js` ~2075). The in-tree comment
records that across 848 persisted fit artifacts, **zero** have ever passed the
gate — i.e. production spread output has always been market identity
(doc-sourced count; consistent with the gate code).

Cover staking uses a separate market-anchored logit
(`sigmoid(logit(market) + b0 + b1·edge/7)`, `nfl-cover-calibration.js`); `b0=b1=0`
reproduces the market exactly, and serving is blocked unless a walk-forward
`forward_gate_passed` is true. Default model stake is `NFL_MODEL_STAKE_UNITS || 0`
= **0 units** (`nfl-auto-picks.js` ~40).

### 1.2 "Systems that aren't connected or using ML" — confirmed

The production pick path executes only: the linear ridge/residual ensemble, a
market-anchored logistic calibrator, and a small shadow neural net that does not
affect the margin unless promoted. Everything else is **not on the pick path**:

| Subsystem | Wired to production pick? | Notes |
|---|---|---|
| `nfl-expert-coordinator.js` / `nfl-expert-council.js` (19-role council, shrinkage, Shapley) | No | scheduler/diagnostic/route only |
| `nfl-drive-sim.js` (game simulation) | No | scheduler/route; feeds unified engine |
| `nfl-unified-engine.js` (Gridiron Engine) | No | `routes/nfl-betting.js` display only |
| `nfl-joint-score.js` / `joint-score-backtest.js` (joint GAS) | No | test/CLI island |
| `forecast-combination.js` (combination bake-off) | No | test/CLI island |
| `nfl-ensemble-rank.js` | No | research |
| `nfl-gbm.js` (gradient-boosted trees) | No | council/route only |
| `nfl-market.js` (standalone ratings) | No (only `beat-the-close`) | not the ensemble |
| `nfl-prop-player-heads.js` / `-weekly-heads.js` | No | registry `retired`/orphaned |
| `research/*.py` (LightGBM/XGBoost/CatBoost/TPOT, selector) | No | `nfl-research-lab.js` reads `latest.json` only; never loads a joblib/pkl model or spawns python for a pick |

**ML actually executed in production:** a 35→10→1 tanh MLP (`nfl-online-neural.js`)
that is `state:'active_shadow'`, cold-start (zero output weights = market), and
`production_eligible:false` until ≥128 examples / ≥8 weeks with a positive
week-clustered CI — data that does not exist yet. So the production margin is, in
practice, **the closing line plus a linear calibrator that also collapses to the
market**. The gradient-boosting and simulation ML exist but are shelved behind the
governance gates.

This disconnection is **by governance design** (nothing may gain authority before
forward gates pass), but it is also the literal reason there is "no ML model
making the picks": no challenger has ever cleared its gate, and several strong
challengers are not even wired to a path where they could.

### 1.3 Authority state

Registry default champion is `market-consensus-v1`/`baseline`; challengers are
`research_only` (`model-governance.js`). No default staking authority anywhere
(grepped: every `staking_authority` string is 0-units-until-gate). Plan register's
"nothing is `qualified`" is still true in code.

---

## 2. Honest state of profitability (doc-sourced, not reproduced here)

- Historical spread replays lose: Run 27/31 = 153 bets, 72-78-3, **−11.855u /
  −7.75% ROI**; Run 32 (post-fix) ≈ **−7.1% ROI**; combined multi-market Run 32
  **−8.71% ROI**.
- On 1,424 common games the model margin MAE (10.095) is **worse than the close**
  (9.762) and cover Brier (0.258) is **worse than a coin flip** (0.250).
- Every Sept 12–13 challenger (joint GAS, forecast-combination, conformal,
  props→spread bottom-up totals) **failed to beat the market/incumbent** under
  governance; verdict in `MODEL_BUILD_REPORT.md`: *"Ship the instruments, ship
  none of the models."*
- Execution: best teaser look DSR ≈ 0.35; full teaser sample 48.35%; team-trend
  totals significantly lose; **0 settled real-money executions**. Only
  line-shopping (price capture, not prediction) is "worth keeping, not proven."

**Bottom line:** infrastructure-rich, edge-poor, and the code correctly refuses to
claim otherwise.

---

## 3. The errors behind "no profit" — root-cause taxonomy

Profit is blocked by two different kinds of problem. They must not be conflated.

### 3.1 There may genuinely be no edge (an empirical result, not a bug)
Every rigorous line of evidence converges on "no edge against the close." Fixing
software will not manufacture an edge. The correct goal is a **trustworthy** test
of the edge proposition, then either find orthogonal signal or accept the market.

### 3.2 The edge test itself is not yet trustworthy (bugs that must be fixed first)
Several confirmed look-ahead/leakage and reproducibility defects mean that any
apparent edge (or its absence) cannot be fully trusted, and any future
retraining would bake in the same distortions. These are the fixable "errors,"
verified live at `43af933`:

| # | Defect | Location (verified) | Why it blocks trustworthy profit |
|---|---|---|---|
| D1 | **Historical news leak** — signal table is mutable | `nfl-news-signal.js` writes `ON CONFLICT(...) DO UPDATE` (~200) and reads back filtered on `published_at` only (~252, ~280); no bitemporal "known-at" | Re-syncing rewrites an earlier as-of answer → backtests see later info |
| D2 | **News availability timestamp** | point-in-time filter uses `published_at` (story time), not extraction/ingest time | An 8pm-extracted claim is visible to a noon cutoff |
| D3 | **"Frozen" packet not frozen** | `nfl-t60-packet.js` `PACKET_BOARD_INPUT_COVERAGE` (~560) + `autoPickDecisionBoardForPacket` read live team/weather; neural vector calls `teamNewsSignals(...,{before})` on the mutable table | A frozen-packet retry produces different forecast evidence → not reproducible |
| D4a | **Model-identity collision** | `nfl-forecast-identity.js` hashes only algorithm/config/regime; "not yet a hash of each historical dataset / learned parameter" (~4); calibrations upsert on `(model_version,trained_from,trained_through)` | Revised training data on the same seasons overwrites the prior fit under one identity → stale/unreproducible artifacts |
| D4b | **Probability rounding fails own checks** | `r4(...)` in `calibratedCoverProbability` (~410) upstream of `incremental>0` eligibility and `expectedNetReturn` domain checks (`p<0/p>1`) | Rounding can push a probability to a boundary / flip eligibility (exact repro pending Codex's local note) |
| D6 | **Receipt-clock look-ahead in CLV grading** | `odds-archive.js` `storeArchiveQuotes` writes `captured_at = book_updated_at ?? commence_time` (content clock, ~121), discarding the real receipt clock `fetchedAt` (stored to `nfl_odds_archive.fetched_at`, ~117); `nfl-expert-council.js` `shoppingFor` gates on `captured_at<=cutoff` (~334); `beat-the-close.js` `openerFor`/`pinnacleLineAt` read `book_updated_at AS at` with **no `<=before` filter** on the archived branch (~75, ~122) | A 2022–2025 game's cutoff can "see" a closing quote the system only backfilled in 2026 → CLV grading (which decides whether beat-the-close keeps authority) leaks |

(D5 numbering reserved for the two unfinished-draft bugs Codex grouped with D4:
identity collision D4a and probability rounding D4b.)

**Coordination note:** D6 (receipt clock) is being fixed in a **separate local
session** (migration `052`, edits to `odds-archive.js`, `book-feeds.js`,
`beat-the-close.js`, `nfl-expert-council.js`, etc.). That work is **not** on this
Cloud VM (tree is clean, migration head is `051`). To avoid clobbering it, this
agent will **not** edit those files unless that branch is pushed and merged first.

### 3.3 Structural gaps (Codex's "what remains")
Even with D1–D6 fixed, the pipeline is not yet a closed loop:
- The same trained pipeline is not connected identically across **historical
  replay and live forecast** (packet consumes live tables for most inputs).
- No automatic **weekly retraining** promotion loop actually promotes (by design,
  but there is also no proven challenger to promote).
- Not **every game's prediction is saved** with a reproducible, frozen input hash
  (only the T-60 game(s) get `frozen_packet`; the weekly ledger is
  `unfrozen_live_tables`).
- No **dated news/injury backfill** with a real known-at clock (D1/D2 blocks it).
- Strong model families (council, sim, GBM, tree_lab) are **not wired** to a path
  where they could earn authority.

---

## 4. What the plan documents got right/stale (live-vs-doc reconciliation)

- **Stale:** `docs/CLAUDE-NEXT-STEPS.md` §0.3 return #4 / C11 / slice 5 say "no
  forecast consumes the frozen packet / `decision_run_id` empty." **Code is
  ahead:** `t60-runner.js` (~204–220) now unconditionally runs
  `autoPickDecisionBoardForPacket` + `recordDecisionRun` and sets
  `decision_run_id` on success. What remains true is that the packet is only
  *partially* frozen (D3) and no edge is proven.
- **Stale:** plan/handoffs reference schema `035`; live migration head is `051`.
- **Stale:** several reports say the Sept 12–13 work is "worktree-only, not merged
  to main." It **is** on `main` here (e.g. `forecast-combination.js`,
  `nfl-joint-score.js`, `execution-fill.js` committed 2026-09-12; `t60-runner.js`
  2026-09-13).
- **Accurate and unchanged:** "nothing is `qualified`," stake defaults 0, no
  sportsbook connection, market-identity production output.

---

## 5. Remediation plan (ordered)

Acceptance criteria are tied to the existing governance gates
(`profitability-policy-v1.3`: 200 overall / 75 per-market settled shadow
decisions, CLV interval excluding zero, ECE ≤ 0.03, slope 0.85–1.15; NFL §18: 250
forward decisions, P(ROI>0) ≥ 75%, positive avg CLV, 32-team coverage). No phase
may claim "profitable" until those pass.

### Phase 0 — Stabilize the test/eval baseline (prereq)
- Triage the **21 failing tests** in `npm test`; classify each as
  data-dependent vs real regression; fix real regressions or mark data-dependent
  with an explicit disposition (never delete).
- Confirm the offline guard + isolated-DB harness is the canonical eval loop.
- **Done when:** suite is green or every non-green is a named, justified skip.

### Phase 1 — Make the historical eval trustworthy (fix the leaks) [highest priority]
Order chosen so that no retraining happens on leaky inputs.
1. **D6 receipt clock** (coordinate with local session; do not double-implement):
   add a real receipt column to `nfl_line_snapshots` following
   `migration 032`'s precedent (backfill from the already-recorded `fetched_at`;
   **refuse to fabricate** for legacy rows), and gate `shoppingFor`,
   `openerFor`, `pinnacleLineAt` on the receipt clock. Regression tests in the
   style of `test/nfl-expert-council-news-feed-cutoff.test.js`.
2. **D1/D2 news bitemporal**: store a real **known-at/ingested-at** clock on
   `nfl_news_signals` and filter point-in-time reads on
   `min(known_at, published_at) <= cutoff`; legacy rows treated honestly
   (unknown, not fabricated). Regression test proving an 8pm extraction is
   invisible to a noon cutoff and that re-sync cannot change an earlier as-of.
3. **D3 packet reproducibility**: extend the T-60 packet schema to freeze the
   team/weather/news features the forecast consumes (or record their known-at
   hashes), so a re-run of a frozen packet is byte-identical; keep honest
   `data_provenance` when a field genuinely cannot be frozen.
- **Done when:** a frozen-packet forecast is reproducible; historical replays no
  longer read post-cutoff information; CLV grading uses receipt time only.

### Phase 2 — Finish model versioning + save every prediction
1. **D4a**: bind a **dataset + learned-parameter fingerprint** into the fit
   artifact identity (extend `spreadForecastIdentity` / the calibration key) so
   revised training data yields a new identity instead of overwriting; keep the
   old artifact readable.
2. **D4b**: move rounding to the edge of the pipeline; keep full-precision
   probabilities through all domain/eligibility checks; add invariants and a test.
3. Persist **every game's** decision with a frozen, hashed input packet (not just
   the T-60 slate) so the forward ledger is complete and reproducible.
- **Done when:** any stored decision reproduces bit-for-bit from its inputs.

### Phase 3 — Connect one trained pipeline across replay and live
- Make historical replay and live forecast consume the **identical** feature
  builder and identity (remove the "packet reads live tables" divergence).
- Wire the **weekly retraining → shadow → promotion** loop end to end (it may keep
  promoting nothing; the point is the loop is real and auditable).
- **Done when:** the same code path, on the same frozen inputs, produces the same
  numbers historically and live, and a week settling triggers a real (possibly
  no-op) promotion evaluation.

### Phase 4 — Build the dated news/injury backfill
- With D1/D2 fixed, backfill historical news/injury with **real known-at** clocks
  (or explicit "unknown"), enabling honest news features in replay for the first
  time.

### Phase 5 — Only now, broaden the search for edge
- Use the measured weaknesses (where the market beats the model, where variance is
  understated) to choose **additional data and models**, and connect the strongest
  currently-disconnected families (council/coordinator, drive-sim, tree_lab GBMs)
  to a **gated** path where they can earn authority — not to production directly.
- Each new family enters through preregistration
  (`audit-registry.js`) + purged walk-forward + the v1.3 gates.

### Non-negotiables carried from governance
- Never auto-promote a betting model; never tune on the sealed forward ledger;
  missing data abstains; grade at stored receipt-time prices; preserve failed
  models and old records.

---

## 6. Recommendation
Adopt Codex's sequencing: **keep the existing work, repair D1–D6 and finish the
integration/versioning/backfill before launching broad new research.** There is
still no evidence of a profitable model, and there will be none worth trusting
until the evaluation loop is leak-free and reproducible.

## 7. Open items feeding this plan (in progress at time of writing)
- 21-test-failure triage (Phase 0).
- Client UI surface map and Python-lab reproducibility notes (peripheral;
  will be appended, do not change the plan's ordering).
