# Gridiron betting model — unified execution plan (2026-09-15)

**What this is.** One reconciled plan that fuses three inputs into a single ordered
roadmap:
1. The recovered Codex corpus on branch `codex/organize-betting-research-2026-09-15`
   (`docs/betting-model/` — `plans/LATEST-PLAN.md`, the 20 work packages
   `plans/agent-prompts/WP01–WP20.md`, guardrails **R01–R28**, findings **C01–C12**,
   audits, and research catalogs).
2. `docs/CLAUDE-NEXT-STEPS.md` (the in-repo canonical plan + status register).
3. This agent's independent **live-code audit** at current `main` (HEAD `bd10899`),
   in `docs/evidence/2026-09-15/BETTING-MODEL-AUDIT-AND-PROFIT-PLAN.md`.

**Authority.** `LATEST-PLAN.md` controls sequencing (M0→M5 / WP01–20). This file is
the single reconciled surface that maps those work packages to **current code
status** so execution can start from the first genuinely-unfinished item. Fold it
into `CLAUDE-NEXT-STEPS.md` §0 rather than running a competing roadmap.

---

## 1. Thesis (agreed across all three sources)

The app has **real ML and real infrastructure but no coherent, trustworthy trained
betting pipeline.** The two words the owner used — **"unity" and "ML"** — are the
gap, and the code confirms both:

- **No unity:** families exist (`nfl-ensemble`, `nfl-drive-sim`, expert council,
  `tree_lab` classifiers, the new `spread-family-adapters.js`) but are **not wired
  into one train→freeze→serve→settle path**; replay uses `blendMode:'raw'` while the
  board uses `market_residual` — different graphs.
- **No ML in the decision:** production margin is the market-residual linear blend
  that collapses to the market — **98/98 recorded decisions are `is_market_identity`,
  and 0 of 37,510 component rows ever passed the residual gate.** The trained ML
  (Stage 3 ridge/LightGBM, `tree_lab` cover classifier) sits on the shelf.

**Honest success definition (three separate layers — never conflate):**
1. **Engineering:** frozen inputs → trained artifact → decision trace → settlement,
   reproducible after mutating live tables. Achievable now.
2. **Prediction:** incremental value over the market on identical eligible games,
   with honest chronology/uncertainty — **may be negative** (Stage 3 already is).
3. **Profit/betting authority:** exact prices, pushes, exposure, and a frozen
   **prospective** protocol — **not implied by 1 or 2**, and gated on ~250 settled
   forward decisions that can only accrue as the 2026 season plays out.

> "A working pipeline with no demonstrated edge is an acceptable outcome; do not
> manufacture a positive verdict." — corpus playbook. Stage 3 is fresh proof: market
> MAE **10.249** vs ridge **10.675** / LightGBM **10.738** (6,499 games) — market wins.

---

## 2. Live status snapshot (reconciled to current `main`, HEAD `bd10899`)

Legend: ✅ fixed & verified · ◐ partial/needs finish · ⛔ open · 🔒 by-design-until-gate.

### Code findings (Codex C01–C12)
| ID | Finding | Status on `main` |
|----|---------|------------------|
| C01 | Packet validation accepted malformed inputs | ✅ (`c63bc19`…; 7 cases rejected) |
| C02 | Packet hash collapsed NaN/null | ✅ (`canonicalize` throws on non-finite) |
| C03 | Mismatched home/away quote paired as one contract | ✅ (mirrored-pair policy) |
| C04 | Preferred book chosen before completeness | ✅ (with C03) |
| C05 | Frozen-packet had no retry | ◐ retry added (`relinkStalledObservations`), but forecast still recomputes from live tables (see D3) |
| C06 | Hardcoded `-04:00` kickoffs | ✅ (DST-aware `nflKickoffDate`) |
| C07 | News store kept stale `ingested_at`; signal leak | ◐ article `ingested_at` + signal `created_at<=cutoff` fixed (D1/D2); **R1/R2 residuals open** (signal overwrite w/o versioning; timestamp-format compare) |
| C08 | Unresolved teams / unverified news admitted | ⛔ (WP03/WP05/WP09) |
| C09 | `<3 seasons` reported `robust:true` | ✅ (`insufficient_data`) |
| C10 | Error ledger not tied to per-game saved predictions | ⛔ (WP14) — Stage 3 doesn't persist per-game preds |
| C11 | Family contribution not wired to new candidate/lineage | ⛔ (WP12/WP14) |
| C12 | Spread-only contract; totals not first-class | ⛔ (WP13–17) |

### Sept-15 review residuals (R1–R5) and this audit's D-items
| ID | Finding | Status |
|----|---------|--------|
| R1/R2 | News signal versioning + `playerNewsSignal` timestamp-format compare | ⛔ open |
| R3 / **D3** | "Frozen" packet still reads live team/weather/news (`PACKET_BOARD_INPUT_COVERAGE`: `team_features/game_context/total_market = not_in_schema`) | ⛔ open — **top priority** |
| R4 / **D4a** | Model-artifact/forecast identity omits training-data + param fingerprint (server side) | ⛔ open (Python artifact has provenance) |
| R5 / **D4b** | Probability rounding vs own domain checks | ◐ family-adapter has a renorm guard; core `calibratedCoverProbability` r4 path unchanged |
| — | Receipt-clock look-ahead (D6) | ✅ `shoppingFor`/`beat-the-close` gated; ◐ verify `book-feeds.js` `receivedAt` end-to-end |
| — | Orthogonal-specialists NaN weights; QBR bulk-seed | ✅ code (QBR live-DB row cleanup deferred) |

### System-level (product) conditions — 🔒 open by design until forward evidence
- Production forecast copies the market (98/98); residual gate 0/37,510 passes.
- No unified end-to-end ML served to the betting decision.
- Historical replay (`raw`) ≠ production (`market_residual`) — same graph not audited.
- **0 admissible 2026 forward observations** — the binding constraint on any profit claim.
- Gates fail-closed correctly, but their **thresholds are not independently justified**
  (Codex caution) — that's its own task (WP02/WP11/WP20).

---

## 3. The unified roadmap (M0→M5 · WP01–WP20 · batches A–F)

Each WP is tagged **[U]**nity / **[M]**L / **[D]**ata-leakage / **[G]**overnance and
annotated with current status. Guardrails **R01–R28** and findings **C01–C12** are
non-negotiable review gates per WP (see corpus `WORK-PACKAGE-INDEX.json`).

### M0 — Trustworthy status (batch A)
- **WP01 [G]** Reconcile ledger + freeze baseline. **Status: largely done** — Stage 1
  freeze exists (`docs/evidence/2026-09-15/STAGE-1-BASELINE-FREEZE.md`); this file
  completes the reconciliation. **Finish:** fold C/R/D status into `CLAUDE-NEXT-STEPS.md` §0.
- **WP02 [G/U]** Repair defects + gate-responsibility table. **Status: mostly done**
  (C01–C04, C06, C09, NaN, QBR). **Finish:** publish the gate table (money-blocking vs
  measurement-blocking), and open the "justify the thresholds" task.

### M1 — Replayable examples (batch B) — *foundation for everything*
- **WP03 [D]** Canonical identities + exact clocks (C06/C08). ◐ (C06 done; historical
  roster intervals / date-only-vs-T60 remain).
- **WP04 [D/G]** Immutable contracts + validation before hashing (C01/C02/C12). ◐
  (C01/C02 done; totals schema + full lineage remain).
- **WP05 [D]** Coverage + source admission (C08). ⛔.
- **WP06 [M/D]** Shared football features + strength priors, chronology-safe. ◐
  (`build_football_dataset` exists, 7,291 rows 1999–2026).
- **WP07 [D]** Exact T‑60 quote/betting datasets, C03/C04 book policy. ◐.

### M2 — First learned comparison (batch D) — *this is where "ML" becomes real*
- **WP11 [G]** Registered experiment spec + bounded search (ridge + shallow LGBM). ◐
  (Stage 3 ran; formalize the spec + trial registration).
- **WP12 [M]** Weekly nested walk-forward + OOF lineage (not season-holdout labs). ⛔.
- **WP13 [M]** Probability + push-aware calibration bound to model identity (C01/C12). ⛔.
- **WP14 [M/G]** All-game error ledger + refitted ablations; fix C09/C10/C11. ⛔ — **save every game's prediction** here.
- *(Stage 3 already satisfies "market may win"; M2 is about the reproducible loop, not a positive result.)*

### M3 — Complete shadow path (batch E) — *this is "unity"*
- **WP15 [U]** Trained-artifact serving + **full frozen packet** (closes **D3/R3**),
  Python→Node parity, frozen recovery. ⛔ — **highest-value integration item.**
- **WP16 [G]** Versioned betting policy + exposure; shadow default, trace every gate. ◐.
- **WP17 [U/G]** Independent settlement + CLV grading. ◐ (execution layer exists).

### M4 — News earns or fails (batch C, parallel after B)
- **WP08 [D]** 2024 wk1–4 news archive pilot (immutable versions) — fixes R1/R2/C07. ⛔.
- **WP09 [D]** Typed events + historical injury timelines (as-of reducer). ⛔.
- **WP10 [M]** Availability/replacement learners → OOF game features. ⛔.

### M5 — Maintainable weekly ops + evidence (batch F)
- **WP18 [U]** Reliable jobs/migrations/recovery (C05/C07). ◐.
- **WP19 [G]** Independent adversarial challenge of the whole path (R01–28, C01–12). ⛔.
- **WP20 [G]** Frozen **prospective** protocol + evidence-driven expansion. ⛔ — this is
  where forward 2026 evidence accrues toward the promotion gates.

**Critical path:** WP01→02→(03,04,05)→(06,07)+11 → 12→13 → 14 ‖ 15→16→17 → 18/19/20.
News (08–10) runs parallel after B and must not block the football baseline.

---

## 4. Where to start (the genuinely-open, high-value front)

Ordered so no retraining happens on non-reproducible inputs, and "unity + ML" advance together:

1. **WP15/D3 — full frozen packet (reproducibility).** Extend the T‑60 packet to freeze
   `team_features`/`game_context`/`total_market` (not just the market quote), so a frozen
   packet re-scores byte-identically after live tables change. This is the single
   biggest trust unlock and the precondition for trustworthy forward evidence. Testable
   here (mutate live tables between two scorings; assert identical).
2. **WP08/R1‑R2/C07 — news signal versioning.** Version `nfl_news_signals` (append, don't
   overwrite) and fix the `playerNewsSignal` timestamp-format compare, so an earlier
   as-of snapshot is truly immutable.
3. **WP14/C10‑C11 — save every prediction + wire the error ledger** to the Stage 3/next
   candidate's per-game outputs (with abstentions and frozen context).
4. **WP12–13 — weekly nested walk-forward + push-aware probability contract**, then
5. **Unity: connect `spread-family-adapters.js` → gated read-only comparison → coordinator**,
   and build the **`tree_lab` joblib → Node adapter** (WP15) so Family D stops being a stub.
6. **D4a/R4** — bind a dataset+param fingerprint into the server-side fit/calibration identity.

Each lands behind the existing gates (nothing gains staking authority), with regression
tests in the `test/*cutoff*.test.js` / `forecast-packet-contract` style.

---

## 5. Guardrails and acceptance (non-negotiable)

- **R01–R28** (point-in-time, no in-sample stacking, cluster uncertainty by week,
  preregister trials, DSR/PBO as diagnostics only, push/EV masses, conformal ≠ profit,
  news→facts-first, uncomputable-robustness = inconclusive, etc.) apply to every WP.
- **Promotion requires all gates** (`nflOperations` 9 gates incl. `overfitting_correction`
  DSR≥0.95 over ≥8 live trials + `market_residual_margin`, `cover_calibration`,
  `exact_policy` P(ROI>0)≥0.75, **forward_sample ≥200/250**, `clv>0`, `pregame_coverage=32`)
  plus profitability policy v1.3 (200 overall / 75 per market, ECE≤0.03, slope 0.85–1.15).
- **Never** loosen production stakes to create picks; **never** tune on the sealed forward
  ledger; missing data abstains; grade at stored receipt-time prices; preserve failures.
- Ledger states: `planned → implemented → verified → connected → observed → qualified` —
  each strictly stronger; **none equals profitability**.

## 6. The honest bottom line

Unifying the systems and turning on ML **does not by itself create profit** — Stage 3
already shows the trained ML losing to the market. What this plan delivers is a single,
leak-free, reproducible pipeline where every family competes on equal footing behind the
gates, and where genuine forward evidence can finally accrue. Until ~250 settled 2026
decisions exist with positive CLV, the correct, honest state remains: **trustworthy and
edgeless.** That is an acceptable engineering outcome, and the fastest way to learn the
truth about whether an edge exists.

---

### Corpus references
Master plan: `docs/betting-model/plans/LATEST-PLAN.md`. Work packages:
`docs/betting-model/plans/agent-prompts/WP01–WP20.md` + `WORK-PACKAGE-INDEX.json`.
Guardrails/findings: `docs/betting-model/plans/archive/MASTER-PLAN-2026-09-14.md` (R01–R28,
C01–C12). Latest review: `docs/betting-model/audits/CLAUDE-WORK-REVIEW-2026-09-15.md`.
Stage 3 result: `docs/betting-model/research/experiment-results/stage3_reports/`.
(The corpus lives on branch `codex/organize-betting-research-2026-09-15`; this plan does
not copy it into `main`.)
