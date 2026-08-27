# Work log

One consolidated record of what was done, what it measured, and what is still
open. Replaces the per-agent handoff documents (`CLAUDE_FEEDBACK.md`,
`CODEX_REVIEW.md`, `docs/HANDOFF*.md`) that accumulated one file per
conversation and drifted out of sync with the code.

Plans and specs are **not** here and are not superseded by this file:
`docs/BUILD_ORDER.md`, `docs/MODEL_ROADMAP.md`, `CODEX_SUGGESTIONS.md`, and
the `docs/PHASE_*.md` / `docs/UI_REVAMP.md` briefs describe intended work.
`docs/STAGE_1_RESULTS.md` and `docs/STAGE_2_RESULTS.md` are evidence records
that gates cite directly.

---

## 2026-08-27 — model evaluation: gates, metric coverage, candidate search

### 1. The `<60 MAE` passing-yards gate was not a real bar

`BUILD_ORDER.md` §2.2 and `MODEL_ROADMAP.md` §14 both set "props passing-yards
MAE < 60" as the target. That number came from the *previous* model's 70.14
MAE — it measured "better than the thing we replaced," not "has predictive
skill." Measured against baselines that actually represent no-skill:

| Predictor | MAE |
|---|---:|
| Always guess the league mean (222.6 yds) | 61.13 |
| Each QB's own season-to-date average | 60.46 |
| Current model | 59.30 |

Clearing `<60` was compatible with beating a constant guess by ~3%.

**Replaced with a significance-tested gate.** `passingYardsGateTest()` in
`server/services/nfl-props.js` runs the paired bootstrap already used for the
Stage 1 CRPS question (`backtest-significance.js`) against each QB's own
walk-forward season-to-date average. A candidate passes only if it beats the
baseline **and** the 90% CI on the difference excludes zero — a lower raw MAE
on a lucky sample is not enough.

Current model, 2022–2025, n=1530 aligned player-weeks:

- model 59.77 MAE vs baseline 63.33 MAE
- 90% CI on the difference **[-4.67, -2.49]**, excludes zero
- model better in 2000/2000 bootstrap resamples
- **verdict: real edge, ~5.9% over the baseline**

So the model does have genuine skill — but that is now demonstrated rather
than implied by clearing an arbitrary threshold.

**Open:** rush yards, receiving yards and receptions still have raw MAE only.
They need the same baseline-relative treatment.

### 2. Graded metrics: 5 → 25

`propAccuracy()` graded 4 point metrics + 1 probability. The simulator already
produced the underlying draws for far more; they were computed and discarded.
Now graded (`POINT_METRIC_KEYS` / `PROBABILITY_METRIC_KEYS`):

- **18 point metrics** — yards and receptions as before, plus pass attempts,
  carries, targets, TDs by type, interceptions, total touches/yards/TDs, and
  four efficiency rates (yards per attempt / carry / target / reception).
- **7 probability metrics** — anytime TD as before, plus per-type TD
  probability (passing, rushing, receiving separately), interception
  probability, any-type TD, and 2+ TD.

Both broad and pregame-market-eligible populations, as before, so abstention
cannot masquerade as accuracy. `touchdown_probability` and `point_metrics`
keys are unchanged for backward compatibility.

*Bug found and fixed while building this:* the market-eligible slice for
`receiving_tds` / `total_touches` / `total_yards` / `total_tds` returned
`n: 0` — the market-side aggregation was never wired for those four.

### 3. Candidate search: 564 candidate/target combinations, zero survivors

Two searches, both through the existing discovery → redundancy pruning →
paired sign-flip test → Holm correction pipeline. 2025 stayed sealed
throughout; nothing earned opening it.

**a. Player-history heads** — `nfl-prop-head-validation.js` generalizes the
24-head fantasy-points registry (`player-head-registry.js`) to prop stats,
reusing the primitives from `player-head-validation.js` rather than a second
copy that could drift. `active_champion` is the structural estimate, i.e. what
actually ships today, not an easier baseline.

| Metric | Structural MAE | Best candidate | Survivors |
|---|---:|---:|---|
| Passing yards | 67.02 | 66.09 | none — rank quality worse |
| Rushing yards | 16.97 | 16.95 | none — p=0.42 |
| Receiving yards | 17.64 | 17.58 | none — p=0.18 |
| Receptions | 1.374 | 1.373 | none — p=0.44 |

**b. Context heads** — `nfl-context-heads.js`, 141 candidates per metric:
opponent defense-vs-position × 10 weights × 8 shrinkage constants, plus
home/away, rest, and weather variants. 141 × 4 metrics = **564 combinations**.

Opponent DvP reuses `matchups.js`'s leave-one-out + shrinkage design but is
rebuilt **cutoff-safe** (prior seasons only). `matchups.js:dvpFor` aggregates
the whole current season with no per-week cutoff — correct for live use, a
look-ahead leak in a backtest. `matchups.js` was left untouched because the
live Matchups/My Team pages depend on it.

| Metric | Structural MAE | Pruned as redundant | Best survivor | p | Holm |
|---|---:|---:|---|---:|---|
| Passing yards | 70.56 | 131/141 | weather | 0.20 | fail |
| Rushing yards | 16.50 | 138/141 | rest | 0.22 | fail |
| Receiving yards | 17.43 | 138/141 | weather | **0.041** | fail (bar 0.025) |
| Receptions | 1.361 | 138/141 | home/away | 0.14 | fail |

Three findings worth keeping:

1. **Redundancy pruning removed 131–138 of 141 per metric.** Varying weight
   and shrinkage inside one signal family produces near-identical predictions;
   those were never independent tests. This is why a large grid stays honest —
   most of it collapses before any significance budget is spent, and Holm
   corrects across whatever survives, so more candidates means a *stricter*
   bar, not a looser one.
2. **Opponent DvP actively degrades point prediction at higher weights** —
   passing-yards MAE 70.56 → 90.81 at full weight, consistently across all
   four stats. A real negative result: matchup strength is useful for the
   app's fantasy *decision* surfaces (start/sit, trade value) but does not
   improve individual-player point forecasts here. Prediction accuracy and
   decision usefulness are different questions.
3. **Weather on receiving yards reached p=0.041** — significant at an
   uncorrected bar, rejected only under Holm given the batch size. Worth
   retesting as more seasons accumulate rather than treating as closed.

**Net:** no simple recency/blend head and no context signal (opponent,
weather, rest, home/away) beats the structural estimate at a statistically
real level on this data. The structural model is at the ceiling of what this
class of adjustment offers. A genuine next gain needs a different kind of
signal — participation/snap-share, injury designations, personnel packages —
which is what `MODEL_ROADMAP.md` Phase D already anticipated.

### 4. Weekly-distribution gate reconfirmed

Refit `WEEKLY_LEVEL` (`projections.js`) on 2023+2024, validated on 2025, after
the identity-coverage repair, to check the earlier CRPS wobble:

| | coverage (gate .78–.82) | calibration error | CRPS |
|---|---:|---:|---:|
| shipped | 0.725 | 0.157 | 3.170 |
| refit | **0.791** | **0.095** | 3.169 |

`sigma: 0.45, downMult: 1` remains best. No code change needed; the earlier
0.002 CRPS concern was on the fit-season sweep, not the validation run that
decides adoption.

### 5. `STAGE_2_RESULTS.md` was stale

It still reported the pre-fix numbers as current. Corrected, with the original
figures kept as the "before" column: coverage 83.24% → **97.34%** (an nflverse
importer defect discarding ~10–12k player-weeks/season, not cold-start
uncertainty), broad passing-yards MAE 67.72 → **59.28** (the QB participation
fix — attempts had been split across every QB on a roster, suppressing clear
starters 10–40%), broad TD Brier 0.1588 → 0.1531, market-eligible TD Brier
0.2014 → 0.1955.

---

## Verification

`npm run check` green after every change above: **199/199 tests**, typecheck,
production build, isolated-database startup smoke.

## Open

1. **Market-eligible TD calibration** — 0.1955 Brier vs 0.1531 broad. The
   eligible population has a materially higher base rate and still borrows the
   broad calibration head instead of having one fit to itself. The one item
   from Stage 2's original red list that is still genuinely unresolved.
2. **Baseline-relative gates for rush yards, receiving yards, receptions** —
   passing yards has one; the other three do not.
3. **Gate documentation** — `BUILD_ORDER.md` §2.2 and `MODEL_ROADMAP.md` §14
   still cite the flat `<60` target. They should reference the
   baseline-relative methodology instead.
4. **New signal families** — per §3, the next real accuracy gain requires
   participation/snap-share, injury designations, or personnel data, not more
   reweighting of existing history.
5. **Draft Room / Trade Lab Phase 4+** — draft queue, waiver prescription,
   trade counteroffers, mobile navigation, saved views, model registry. Listed
   as open in the superseded handoff docs and still untouched.
6. **Spreads** — 0/21 component models clear the materiality gate. Settled
   finding (the market has no exploitable edge here), not an open task.
