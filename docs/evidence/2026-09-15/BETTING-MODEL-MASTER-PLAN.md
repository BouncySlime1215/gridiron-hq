# Gridiron NFL betting model — master implementation plan (2026-09-15)

**Big, detailed execution plan.** It fuses (a) the recovered Codex corpus now shipped
in-repo at `docs/betting-model/` (papers, methods, 20 work packages, guardrails R01–R28,
findings C01–C12), (b) `docs/CLAUDE-NEXT-STEPS.md`, and (c) this agent's live-code audit
at `main`. It is the "how to actually build it" companion to the shorter
`docs/evidence/2026-09-15/BETTING-MODEL-UNIFIED-PLAN.md`.

> How to use: sequencing authority is `docs/betting-model/plans/LATEST-PLAN.md`
> (M0→M5 / WP01–WP20). This file adds, per milestone, the concrete FIX/ADD items, the
> **paper/method that backs each one**, and acceptance criteria — so an engineer can pick
> up the next unfinished item with its evidence attached. Fold status into
> `CLAUDE-NEXT-STEPS.md` §0; do not run a competing roadmap.

---

## 0. Ground truth going in (live-code audit)

- Production spread output is **market identity** (98/98 recorded decisions, edge 0);
  the residual gate has **0 passes in 37,510 component rows**. The trained ML (Stage 3
  ridge/LightGBM, `tree_lab` cover classifier) is not served; families are not unified.
- **Stage 3, real data, 6,499 games:** market MAE **10.249** vs ridge **10.675** /
  LightGBM **10.738** — the market wins.
- The 32-commit ledger fixed the leaks (C01–C04, C06, C09, orthogonal-NaN, QBR,
  receipt-clock, news `created_at`). **Open:** full frozen-packet reproducibility (D3),
  news signal versioning (R1/R2), save-every-prediction + error ledger (C10/C11), totals
  contract (C12), server identity fingerprint (D4a), and the unity/ML integration itself.

## 1. The realistic bar (grounded in the papers — read this before building models)

The corpus's own literature sets honest expectations, and every in-house experiment agrees:

- **Lopez, Matthews & Baumer (2018), "How often does the best team win?"** (`source-papers/papers/lopez_matthews_baumer_2018.txt`) fit Bayesian state-space models **on point-spread data** across NFL/NHL/NBA/MLB. The closing spread is an *efficient summary of team strength*; NFL has real talent dispersion but large game-to-game variance. Implication: the market already encodes team strength well — **a better margin model is unlikely to beat the closing line on public data.**
- **Claeskens et al. (2016), "The forecast combination puzzle"** (`source-papers/pdf/claeskens2016.txt`): naive/simple combinations often beat "optimal" estimated weights because weight estimation adds variance. Implication: **prefer regularized, market-anchored combination over more components** (this is exactly why the 21-model ensemble collapses to ~3 signals shrunk 63% to market).
- **Diebold-Mariano (1995) / Giacomini-White (2006)** (`source-papers/research2/dm-1995.pdf`, `giacomini-white-2006.pdf`): the correct test for "does this forecast beat that one" is a clustered predictive-accuracy test, not in-sample fit — already used in `fitEnsemble`'s gate.

**Therefore the goal of this plan is NOT "find a margin edge by modeling harder."** It is:
1. a **correct, leak-free, unified, reproducible** pipeline (achievable now), and
2. a **trustworthy test** of whether *orthogonal* information (early availability/news) or
   *execution* (CLV/line-shopping, timing) yields an edge — the only places one is plausible.

Honest base case: **no robust spread edge.** That is an acceptable outcome; the value is a
system that can prove it either way and accrue real forward evidence.

## 2. Target architecture — consolidation first (from `FIX_AND_ADD_ARCHITECTURE.md`)

The diagnosed disease is **duplication, not missing machinery** (5 CLV implementations,
37 content-hashers, disconnected families). The target is a *subtraction*:

```
ONE trial registry (research_studies/_trials/_trial_corrections; DSR/PBO/Holm on
  effective_n_trials) gates promotion for everything below
   └── ONE identity/CLV core (one content-hash module · one computeClv() signed-points +
       fair-prob · one scored eventKey()/contractKey() · one receipt clock)
        ├── FIXED FORECASTING CORE: one team-strength model (closed-form ridge paired-
        │     comparison now → recursive Bayesian later) · one DM-gated forecast-combination
        │     (equal/inverse-MSE benchmarked, PCA/correlation REDUCTION first, not more
        │     components) · drive-sim mechanics fixed
        └── CALIBRATED UNCERTAINTY LAYER: one split-conformal module (Mondrian by spread
              bucket, NexCP recency-weighted) + MAPIE cross-check (isolated Python)
   └── shadow serving: frozen packet (features+quote+artifact IDs) → versioned policy
       (shadow default) → independent settlement/CLV → row-level error ledger → backlog
```

Rule: **no additive capability may become a second implementation of a core the fixed layer
already provides once.**

## 3. Guardrails (R01–R28) — non-negotiable review gates on every work package

Point-in-time only (R01–R03); fit all preprocessing/ratings/calibration inside chronological
folds (R04); OOF combination, never in-sample stacking (R05); limit correlated experts, measure
incremental value (R06); report era/coverage (R07); cluster uncertainty by game/week (R08);
preregister all trials incl. failures (R09); DSR/PBO diagnostics only, never objectives (R10);
align metric panels (R11); no peeking / use valid sequential methods (R12); separate outcome
width vs model vs calibration uncertainty (R13); conformal coverage ≠ profit (R14); calibration
bound to model identity + price horizon (R15); integer spreads need win/push/loss masses (R16);
validate NFL margins, don't copy soccer σ (R17); fix sim mechanics before calibrating on it
(R18); dependent legs need copula/constraints (R19); news→facts first, learn impact from data
(R20); movement ≠ causal news effect (R21); LLM "blind replay" ≠ prospective proof (R22);
separate publication/extraction/activity/win probability (R23); don't transfer sport-specific
thresholds (R24); verify OSS license/version/fixtures before adopting (R25); CLV and ROI on the
same bets are dependent, not two proofs (R26); don't raise stakes or drop safeguards for
non-market numbers alone (R27); uncomputable robustness = inconclusive, never a pass (R28).

## 4. Roadmap: M0→M5, with FIX/ADD items, backing papers, and acceptance

Legend: ✅ done · ◐ partial · ⛔ open. FIX#/ADD# refer to `FIX_AND_ADD_ARCHITECTURE.md`.

### M0 — Trustworthy status (WP01–WP02) — ◐ mostly done
- WP01 reconcile ledger + freeze baseline (✅ Stage-1 freeze exists; this file completes it).
- WP02 repair defects + gate-responsibility table. ✅ C01–C04, C06, C09, orthogonal-NaN, QBR.
  **Remaining:** publish the money-vs-measurement gate table; open "justify gate thresholds"
  (Codex caution: a gate that rejects everything proves it blocks, not that its bar is right).

### M1 — Replayable examples (WP03–WP07) — ◐ foundation
- **WP03 identities + exact clocks** (C06✅, C08⛔). Backing: bitemporal/PIT — Akidau Dataflow,
  SQL:2011 (F05). Acceptance: winter & summer kickoffs correct; date-only ≠ exact T‑60; frozen
  mappings immutable under later roster changes.
- **WP04 immutable contracts + validation-before-hashing** (C01/C02✅, C12⛔). FIX#42 (book-feeds
  receipt clock — verify shipped), F05. Acceptance: malformed packets fail or take a documented
  missing path; replay invariant after DB mutation; test on a *populated* DB copy.
- **WP05 coverage + source admission** (C08⛔). F05/F14. Acceptance: dropping an optional source
  never deletes valid football examples; every exclusion has a reproducible reason.
- **WP06 shared football features + strength priors** (◐; `build_football_dataset` exists).
  **FIX#14 closed-form ridge paired-comparison team strength** (Glickman-Stern 1998
  `glickman_stern_1998.txt`; Glickman 2001 `glickman_2001_dpcmsv.txt`) — *the single cheapest,
  highest-confidence betting-core item*. **FIX#25 wire per-team `wind_epa_delta` into
  `weather_total`** (already computed, thrown away). F08/F15. Acceptance: future scores/revised
  EPA can't change an earlier vector; priors calibrated inside earlier folds; ridge clears
  `teamStrengthWalkForward` (≥2/3 seasons) before production.
- **WP07 exact T‑60 quote/betting datasets** (C03/C04✅ policy, C06/C12). F03 devig (Shin —
  `source-papers` devig set), F16 favorite-longshot. Acceptance: moved handicap, async opposite
  side, missing close, alt period all handled; two offers at different lines never de-vigged as
  one contract.

### M2 — First learned comparison (WP11–WP14) — ⛔ the "ML becomes real" milestone
- **WP11 registered experiment spec + bounded search** (ridge + shallow LightGBM). F06 trial
  registry / multiplicity (Bailey-López de Prado DSR/PBO; Holm 1979; Harvey-Liu). ADD#31
  `research_studies/_trials/_trial_corrections` DDL; ADD#30 append-only content-addressed
  registry with `scored_at ≥ declared_at` trigger. Acceptance: changing data/features yields a
  distinct experiment identity; failed fits discoverable; post-hoc registration labeled
  retrospective.
- **WP12 weekly nested walk-forward + OOF lineage.** **FIX (forecast combination):** replace the
  `0.68+0.632·market` shrinkage with **DM-gated, equal-weight/inverse-MSE-benchmarked
  regularized combination on OOF preds** — and do a **PCA/correlation REDUCTION step first**
  (Claeskens 2016 combination puzzle `claeskens2016.txt`; Smith-Wallis 2009; Qian-Hua 2004;
  Ranjan 2010; F02). Acceptance: held-out outcome mutation can't change a fit; same-game leakage
  refused; next scheduled fit ingests newly-settled labels only.
- **WP13 probability + push-aware calibration + conformal** (C01/C12). **ADD#15/#18/#22
  split-conformal / CQR** replacing the Gaussian WP hack and `predictiveDistribution()`'s
  `disagreement/30` inflation (Angelopoulos-Bates `cqr.txt`/conformal set; Romano CQR;
  Barber NexCP `nexcp.txt` for recency; ADD#26 MAPIE cross-check). Calibration proper-scored
  (Gneiting `gneiting.txt`; Kull; Dimitriadis). F11/F17. Acceptance: probabilities finite,
  sum to one, correct price-EV; changing the line rescoring that contract; totals get their
  own path, not a renamed spread.
- **WP14 all-game error ledger + refitted ablations** (C09✅, C10/C11⛔). **Save every game's
  prediction + abstention + frozen context.** Acceptance: one-season slice can't pass a
  multi-season check; no-bet games retained; a family with no numerical consumer labeled
  disconnected; hypotheses require later confirmation.

### M3 — Complete shadow path (WP15–WP17) — ⛔ this is "unity"
- **WP15 trained-artifact serving + full frozen packet** (closes **D3/R3**, C01–C05, C12).
  Freeze `team_features`/`game_context`/`total_market` into the packet; Python→Node scoring
  adapter with parity fixtures; build the **`tree_lab` joblib → Node bridge** so Family D
  (direct-cover) stops being a stub. ADD#19 canary/shadow-serve window. Acceptance: restart or
  source mutation can't change frozen outputs; tape write/link interruption neither duplicates
  nor strands a decision.
- **WP16 versioned betting policy + exposure** (shadow default; trace every gate; C03). ADD#16
  depth/fill-aware execution simulator + ADD#17 Kalshi adverse-selection haircut (measurement,
  not a revenue plan). Kelly sizing (Beggy `beggy_kelly.pdf`; Roncalli `roncalli_rpb.pdf`) stays
  gated off. Acceptance: push EV / invalid price / stale quote / duplicate side / opposite lines
  behave explicitly; LLM explanation can't change numeric authority.
- **WP17 independent settlement + CLV** (C12). **ADD#28 delete the 4 CLV calculators → one
  `computeClv()` + one `clv_grades` table** (F04/F18) — *single highest-leverage audit item*.
  R26 (CLV & ROI dependent). Acceptance: win/loss/push/void + ± odds reconcile to stake/profit;
  missing close doesn't erase a settled outcome; CLV at different lines not mislabeled.

### M4 — News earns or fails (WP08–WP10, parallel after M1 contracts) — ⛔
- **WP08 2024 wk1–4 news archive pilot** (fixes C07/R1/R2). ADD content-addressed versions;
  immutable article/claim history. Acceptance: a changed Friday body can't inherit Wednesday
  ingestion as its receipt; repeat fetch ≠ duplicate version.
- **WP09 typed events + as-of injury timelines** (C07/C08). F13 causal news impact (Chernozhukov
  DML). Acceptance: negation/pronoun/multi-player/reversal/trade/bye/IR handled; later events
  can't alter an earlier snapshot; syndicated repeats ≠ independent evidence.
- **WP10 availability/replacement learners → OOF game features.** ADD#3 empirical
  replacement-level (nflWAR), ADD#6 depth-chart usage-propagation graph (the one genuinely open
  gap the lit search found unbuilt). Acceptance: upstream train-row IDs audited; target-game
  snaps can't enter features; structured vs text compared with/without market info.

### M5 — Maintainable weekly ops + prospective evidence (WP18–WP20) — ⛔
- **WP18 reliable jobs/migrations/recovery** (C05/C07). Acceptance: interrupt fetch/extract/
  publish/link → resume without duplicate writes or repeat billing; missed cutoff stays visible.
- **WP19 independent adversarial challenge** (R01–28, C01–12). Acceptance: passing 14 packet
  tests is insufficient if 7 malformed cases still validate.
- **WP20 frozen prospective protocol + evidence-driven expansion.** F07 sequential inference
  (Howard/Ramdas confidence sequences `source-papers` confseq set; Waudby-Smith-Ramdas). R09–R12.
  Acceptance: changing a feature/search/policy starts a **new** evidence segment; uncomputable
  robustness never a pass; advanced methods need a specific error + simpler baseline first.
  **This is where forward 2026 CLV accrues toward the promotion gates.**

## 5. FIX list → owner (from `FIX_AND_ADD_ARCHITECTURE.md` §c; scores in parens)

Betting-core (do these): away-team WP sign (#9, 15.0), remove flat +7 HFA lump (#10, 14.3),
timeout-decrement wiring (#11), OT scoping (#12), **closed-form ridge team strength (#14, 13.3)**,
split-conformal WP (#15, 14.0), NexCP-weighted resampler (#16, 13.5), conformal for
`predictiveDistribution` (#18, 12.7), real devig for exchange-vs-book (#19, 11.7),
copula for team-leg×prop (#20), nested-leg independence fix (#21), CQR width (#22–#23),
**wire `wind_epa_delta` (#25, 11.3)**, MAPIE cross-check (#26). Audit-core: **one CLV module
(#28, 15.0)**, event-study "reacted" fix (#29), **append-only trial registry + DDL (#30/#31)**,
consolidate 37 hashers (#32), route the 2nd game-key join through the tested resolver (#33),
purged `effective_n_trials` (#39), **book-feeds receipt clock (#42 — verify shipped)**.

## 6. ADD list → sequence (build only after fixes; §d)

Now-ish, cheap, gated: empirical replacement-level (#3), report aging-curve source/uncertainty
(#2). Needs toolchain: hierarchical NB props (needs `pymc`/`numpyro` — ADD#9 stand it up).
Betting-secondary, gated: **score-driven bivariate-Poisson (GAS) joint scoring (#15, 11.3)** —
Koopman-Lit 2019 (`koopman_lit_2019_gas.txt`) is the strongest single research result (beats
static & full state-space at 1/360th compute); feeds real teaser/SGP dependence. Depth/fill-aware
execution sim (#16), Kalshi haircut (#17), governed paired-comparison harness (#18), canary
window (#19). **Defer/reject (research's own verdict):** TSFM/GNN/PBP-transformer/MoE/RL/
generative aug (need 10–100× more independent games), cross-venue arbitrage and social sentiment
(thin-to-negative evidence — $210–560 total per NBA league-month; sentiment is already-priced
book bias).

## 7. Immediate front (start here, in order)

1. **WP15/D3 — full frozen packet** (reproducibility; precondition for trustworthy forward
   evidence). 2. **WP08/R1-R2 — news signal versioning** (append, not overwrite; fix timestamp
   compare). 3. **WP14/C10-C11 — save every prediction + wire error ledger.** 4. **FIX#28 — one
   CLV module** and **FIX#14 — closed-form ridge team strength** (both cheap, high-leverage).
   5. **WP12-13 — weekly walk-forward + conformal probability contract.** 6. **Unity:** connect
   `spread-family-adapters.js` → gated comparison → coordinator + `tree_lab`→Node bridge.

Each lands behind the existing gates (no staking authority), with tests in the
`test/*cutoff*.test.js` / `forecast-packet-contract` style, and every comparison registered in
the trial registry (R09).

## 8. Honest profit reality

Unifying the systems and turning on ML **will not by itself create profit** — Lopez et al. shows
the market already encodes team strength, Claeskens shows more models make it worse not better,
and Stage 3 shows the trained ML losing to the close. What this plan delivers is a correct,
reproducible, unified pipeline where families compete behind valid gates and *orthogonal
information / execution* — the only plausible edge sources — can be tested honestly and forward
evidence can accrue toward the ~250-settled-decision / positive-CLV promotion bar (currently 0).
The correct expected outcome is **trustworthy, and probably edgeless.** Anything better must be
proven forward, not asserted.

## 9. References
Corpus (now in-repo): `docs/betting-model/` — `plans/LATEST-PLAN.md`,
`plans/agent-prompts/WP01–WP20.md`, `WORK-PACKAGE-INDEX.json`,
`research/advanced-methods-and-github/FIX_AND_ADD_ARCHITECTURE.md` + `F01–F18`/`GF`/`N`/`GN`,
`research/source-papers/` (Glickman-Stern, Glickman 2001, Koopman-Lit 2012/2019, Claeskens 2016,
DM 1995, Giacomini-White 2006, CQR/ACI/NexCP, Gneiting, Lopez-Matthews-Baumer 2018, Beggy Kelly,
Roncalli), `audits/CLAUDE-WORK-REVIEW-2026-09-15.md`, `research/experiment-results/stage3_reports/`.
Companion: `docs/evidence/2026-09-15/BETTING-MODEL-UNIFIED-PLAN.md`,
`docs/evidence/2026-09-15/BETTING-MODEL-AUDIT-AND-PROFIT-PLAN.md`.
